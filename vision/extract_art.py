"""Extract card art from the game's local asset bundles into data/art/.

One-time (and after each game patch). Reads only the installed game files.
Output: data/art/<kind>/<name>.png (kind = items | skills | misc) + data/art/index.json
"""
import json
import os
import re
import sys

import UnityPy
import UnityPy.config

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_APP = os.path.expanduser(
    "~/Library/Application Support/Steam/steamapps/common/The Bazaar/TheBazaar.app"
)
SIZE = 320


def unity_version(app):
    try:
        import plistlib

        with open(os.path.join(app, "Contents/Info.plist"), "rb") as f:
            s = plistlib.load(f).get("CFBundleGetInfoString", "")
        m = re.search(r"version (\S+)", s)
        if m:
            return m.group(1)
    except Exception:
        pass
    return "6000.3.27f2"


def main_texture(mat):
    best = None
    for name, env in mat.m_SavedProperties.m_TexEnvs:
        try:
            if not env.m_Texture or env.m_Texture.m_PathID == 0:
                continue
            tex = env.m_Texture.read()
        except Exception:
            continue
        n = tex.m_Name
        if re.search(r"mask|flowmap|noise|_N$|normal", n, re.I):
            continue
        score = (2 if name in ("_MainTex", "_BaseMap", "_Diffuse") else 0) + (
            1 if n.endswith("_D") else 0
        )
        score = (score, tex.m_Width * tex.m_Height)
        if best is None or score > best[0]:
            best = (score, tex)
    return best[1] if best else None


def save(img, path):
    img = img.convert("RGB")
    img.thumbnail((SIZE, SIZE))
    img.save(path, "PNG")


def extract_monsters(aa, out, index):
    """Monster portraits: ENC_Monster_<Name>_Char drawn over ENC_Monster_<Name>_BG, as the game shows them."""
    from PIL import Image

    for b in sorted(os.listdir(aa)):
        if not b.startswith("combat_assets_all"):
            continue
        env = UnityPy.load(os.path.join(aa, b))
        tex = {}
        for obj in env.objects:
            if obj.type.name == "Texture2D":
                try:
                    t = obj.read()
                    m = re.match(r"ENC_Monster_(.+)_(Char|BG)$", t.m_Name)
                    if m:
                        tex[(m.group(1), m.group(2))] = t
                except Exception as e:
                    print("skip", b, e, file=sys.stderr)
        for (name, kind), t in tex.items():
            if kind != "Char":
                continue
            try:
                img = t.image.convert("RGBA")
                bg = tex.get((name, "BG"))
                base = bg.image.convert("RGBA").resize(img.size) if bg else Image.new("RGBA", img.size, (0, 0, 0, 255))
                save(Image.alpha_composite(base, img), os.path.join(out, "monsters", name + ".png"))
                index["monsters"][name] = {"bundle": b}
            except Exception as e:
                print("skip", name, e, file=sys.stderr)
        print(b, len(index["monsters"]), flush=True)


def extract_encounters(aa, out, index):
    """Merchant and event portraits (the tiles on the path-choice screen): ENC_<Kind>_<Name>[_Char|_BG]."""
    from PIL import Image

    tex = {}
    for b in sorted(os.listdir(aa)):
        if not re.match(r"(quest|merchant|encounter|event)[a-z_]*_assets_all", b):
            continue
        env = UnityPy.load(os.path.join(aa, b))
        for obj in env.objects:
            if obj.type.name != "Texture2D":
                continue
            try:
                t = obj.read()
                m = re.match(r"(?i)ENC_(Event|Merchant|Mechant)_(.+?)(?:_(Char|BG))?$", t.m_Name)
                if m and t.m_Width >= 128:
                    kind = "Event" if m.group(1).lower() == "event" else "Merchant"
                    tex[(kind + "_" + m.group(2), (m.group(3) or "Full").title())] = t
            except Exception as e:
                print("skip", b, e, file=sys.stderr)
    for name in sorted({k[0] for k in tex}):
        try:
            char, bg, full = tex.get((name, "Char")), tex.get((name, "Bg")), tex.get((name, "Full"))
            if char is not None:
                img = char.image.convert("RGBA")
                base = bg.image.convert("RGBA").resize(img.size) if bg is not None else Image.new("RGBA", img.size, (0, 0, 0, 255))
                img = Image.alpha_composite(base, img)
            else:
                img = (full or bg).image
            save(img, os.path.join(out, "encounters", name + ".png"))
            index["encounters"][name] = {}
        except Exception as e:
            print("skip", name, e, file=sys.stderr)
    print("encounters", len(index["encounters"]), flush=True)


def main():
    app = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_APP
    aa = os.path.join(app, "Contents/Resources/Data/StreamingAssets/aa/StandaloneOSX")
    UnityPy.config.FALLBACK_UNITY_VERSION = unity_version(app)
    out = os.path.join(ROOT, "data", "art")
    for k in ("items", "skills", "misc", "monsters", "encounters"):
        os.makedirs(os.path.join(out, k), exist_ok=True)
    index = {"items": {}, "skills": {}, "misc": {}, "monsters": {}, "encounters": {}}

    bundles = sorted(os.listdir(aa))
    for b in bundles:
        if not re.match(r"card_.*_assets_all", b):
            continue
        env = UnityPy.load(os.path.join(aa, b))
        seen = set()
        for path, obj in env.container.items():
            m = re.search(r"/Cards/([^/]+)/([^/]+)\.mat$", path)
            if not m or obj.type.name != "Material":
                continue
            folder, matname = m.group(1), m.group(2)
            if re.search(r"premium|foil|gold", matname, re.I) and folder in seen:
                continue
            try:
                tex = main_texture(obj.read())
                if tex is None:
                    continue
                save(tex.image, os.path.join(out, "items", folder + ".png"))
                seen.add(folder)
                index["items"][folder] = {"bundle": b, "mat": matname, "tex": tex.m_Name}
            except Exception as e:  # keep going, report at the end
                print("skip", path, e, file=sys.stderr)
        print(b, len(seen), flush=True)

    # Skills and encounter art are referenced by texture file name in the card data.
    for b in bundles:
        if not re.match(r"(skills|rewards|merchant|quest|encounter|event|monster)[a-z_]*_assets_all", b):
            continue
        kind = "skills" if b.startswith("skills") else "misc"
        env = UnityPy.load(os.path.join(aa, b))
        n = 0
        for obj in env.objects:
            if obj.type.name != "Texture2D":
                continue
            try:
                tex = obj.read()
                name = tex.m_Name
                if tex.m_Width < 128 or re.search(r"mask|flowmap|noise|atlas|_N$", name, re.I):
                    continue
                if kind == "misc" and tex.m_Width > 2048:
                    continue
                save(tex.image, os.path.join(out, kind, name + ".png"))
                index[kind][name] = {"bundle": b}
                n += 1
            except Exception as e:
                print("skip", b, e, file=sys.stderr)
        print(b, n, flush=True)

    extract_monsters(aa, out, index)
    extract_encounters(aa, out, index)

    # Addressables catalog: asset GUID (the cards' ArtKey) -> asset file name.
    import struct
    cat = open(os.path.join(os.path.dirname(aa), "catalog.bin"), "rb").read()
    guid = {}
    for m in re.finditer(rb"\x20\x00\x00\x00([0-9a-f]{32})", cat):
        j = m.end()
        n = struct.unpack("<I", cat[j : j + 4])[0]
        name = cat[j + 4 : j + 4 + n]
        if 0 < n < 200 and all(32 <= c < 127 for c in name):
            guid[m.group(1).decode()] = name.decode()
    with open(os.path.join(out, "guid_map.json"), "w") as f:
        json.dump(guid, f)

    with open(os.path.join(out, "index.json"), "w") as f:
        json.dump(index, f)
    print({k: len(v) for k, v in index.items()})


if __name__ == "__main__":
    main()
