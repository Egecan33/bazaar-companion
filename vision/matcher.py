"""Recognise card art in a screenshot by local-feature matching against the game's own art.

Reference art comes from extract_art.py (the installed game's bundles). No network, no OCR.
Method: SIFT keypoints on every reference image go into one FLANN index; a frame's keypoints
vote for reference images; each candidate is verified with a RANSAC similarity transform.
"""
import difflib
import json
import os
import re

import cv2
import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ART = os.path.join(ROOT, "data", "art")
CACHE = os.path.join(ART, "features-v3.npz")
# The game draws item art squeezed to the card: 1 slot wide for Small, 2 for Medium, 3 for Large,
# all the same height. References are reshaped the same way before features are taken.
ASPECT = {"Small": 0.5, "Medium": 1.0, "Large": 1.5}
FRAME_WIDTH = 2200  # width the play-area crop is matched at
ROI = (0.16, 0.08, 0.84, 0.74)  # play area as fractions of the frame: x0, y0, x1, y1
MIN_INLIERS = 7


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


SIZES = {}


def art_to_cards():
    """Map every art file to the card ids that use it, via the game's addressables catalog."""
    with open(os.path.join(ROOT, "data", "cards.json")) as f:
        cards = json.load(f)["cards"]
    gpath = os.path.join(ART, "guid_map.json")
    guid = json.load(open(gpath)) if os.path.exists(gpath) else {}
    items = {norm(f[:-4]): f[:-4] for f in os.listdir(os.path.join(ART, "items"))}
    skills = {f[:-4].lower(): f[:-4] for f in os.listdir(os.path.join(ART, "skills"))}
    mdir = os.path.join(ART, "monsters")
    monsters = {norm(f[:-4]): f[:-4] for f in os.listdir(mdir)} if os.path.isdir(mdir) else {}
    out = {}
    misc = {norm(f[:-4]): f[:-4] for f in os.listdir(os.path.join(ART, "misc"))}
    edir = os.path.join(ART, "encounters")
    encounters = {norm(f[:-4]): f[:-4] for f in os.listdir(edir)} if os.path.isdir(edir) else {}
    for c in cards.values():
        key = c.get("artKey") or ""
        if c["type"] == "Item":
            fname = guid.get(key, "")
            base = norm(re.sub(r"_CardData\.asset$", "", fname))
            art = items.get(base) or items.get(norm(c["internalName"])) or items.get(norm(c["name"]))
            if art:
                out.setdefault("items/" + art, []).append(c["id"])
                SIZES["items/" + art] = c.get("size")
        elif c["type"] == "CombatEncounter":
            m = re.match(r"Monster_(.+?)\.?_(CombatData|QuestData)\.asset$", guid.get(key, ""))
            art = monsters.get(norm(m.group(1))) if m else None
            art = art or monsters.get(norm(c["internalName"])) or monsters.get(norm(c["name"]))
            if art:
                out.setdefault("monsters/" + art, []).append(c["id"])
        elif c["type"] in ("EventEncounter", "PedestalEncounter"):
            m = re.match(r"(Event|Merchant)_(.+?)_(QuestData|MerchantData)\d*\.asset$", guid.get(key, ""))
            art = encounters.get(norm(m.group(1) + m.group(2))) if m else None
            if m and not art:  # asset and texture names differ by typos (Merchant_Argent vs Merchant_Argenta)
                near = difflib.get_close_matches(norm(m.group(1) + m.group(2)), list(encounters), n=1, cutoff=0.88)
                art = encounters[near[0]] if near else None
            if art:
                out.setdefault("encounters/" + art, []).append(c["id"])
        elif c["type"] == "EncounterStep":
            art = misc.get(norm(re.sub(r"\.png$", "", key)))  # reward tiles name their texture directly
            if art:
                out.setdefault("misc/" + art, []).append(c["id"])
        elif c["type"] == "Skill":
            art = skills.get(re.sub(r"\.png$", "", key).lower())
            if art:
                out.setdefault("skills/" + art, []).append(c["id"])
    return out


def build_index(force=False):
    mapping = art_to_cards()
    keys = sorted(mapping)
    with open(os.path.join(ART, "card_art.json"), "w") as f:  # card id -> art file, for the UI thumbnails
        json.dump({cid: k for k, ids in mapping.items() for cid in ids}, f)
    if os.path.exists(CACHE) and not force:
        z = np.load(CACHE, allow_pickle=False)
        if list(z["keys"]) == keys:
            return Index(keys, mapping, z["desc"], z["pts"], z["owner"])
    sift = cv2.SIFT_create(nfeatures=420)
    cap = {"Small": 160, "Medium": 240, "Large": 420}  # bigger cards show more of the picture, so keep more points
    descs, pts, owner = [], [], []
    for i, k in enumerate(keys):
        img = cv2.imread(os.path.join(ART, k + ".png"), cv2.IMREAD_GRAYSCALE)
        if img is None:
            continue
        ax = ASPECT.get(SIZES.get(k), 1.0)
        if ax != 1.0:
            img = cv2.resize(img, (int(img.shape[1] * ax), img.shape[0]), interpolation=cv2.INTER_AREA)
        kp, d = sift.detectAndCompute(img, None)
        if d is None:
            continue
        n = cap.get(SIZES.get(k), 160)
        order = np.argsort([-p.response for p in kp])[:n]
        descs.append(d[order])
        pts.append(np.array([kp[j].pt for j in order], dtype=np.float32))
        owner.append(np.full(len(order), i, dtype=np.int32))
    desc = np.vstack(descs).astype(np.float32)
    pts = np.vstack(pts)
    owner = np.concatenate(owner)
    np.savez(CACHE, keys=np.array(keys), desc=desc, pts=pts, owner=owner)
    return Index(keys, mapping, desc, pts, owner)


class Index:
    def __init__(self, keys, mapping, desc, pts, owner):
        self.keys = list(keys)
        self.mapping = mapping
        self.desc = desc
        self.pts = pts
        self.owner = owner
        self.flann = cv2.FlannBasedMatcher(dict(algorithm=1, trees=4), dict(checks=40))
        self.flann.add([desc])
        self.flann.train()
        self.sift = cv2.SIFT_create(nfeatures=9000)
        self._sizes = {}
        # The same picture can exist as an item, a monster and a skill icon (Tortuga). Such look-alikes must not
        # cancel each other in the ratio test, so references are grouped by their bare name.
        names = {}
        self.group = np.array([names.setdefault(norm(re.sub(r"^(Icon_Skills?_(MON_)?|Monster_|Merchant_|Event_)", "", k.split("/")[1])), len(names)) for k in self.keys], dtype=np.int32)

    def ref_size(self, key):
        """Width and height of a reference image as it was indexed (after the card-shape squeeze)."""
        if key not in self._sizes:
            img = cv2.imread(os.path.join(ART, key + ".png"), cv2.IMREAD_GRAYSCALE)
            hh, ww = img.shape[:2] if img is not None else (320, 320)
            self._sizes[key] = (int(ww * ASPECT.get(SIZES.get(key), 1.0)), hh)
        return self._sizes[key]

    def match(self, frame_bgr, roi=None):
        """Return detections: [{art, kind, cardIds, cx, cy, size, inliers}], coords in 0..1."""
        # Only the play area matters (offers row + own board + encounter row); matching it at close
        # to native resolution is what makes the narrow small-item cards recognisable.
        H0, W0 = frame_bgr.shape[:2]
        rx0, ry0, rx1, ry1 = roi or ROI
        x0, y0, x1, y1 = int(rx0 * W0), int(ry0 * H0), int(rx1 * W0), int(ry1 * H0)
        gray = cv2.cvtColor(frame_bgr[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
        s = min(1.0, FRAME_WIDTH / float(x1 - x0))
        if s < 1:
            gray = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_AREA)
        h, w = gray.shape[:2]
        kp, d = self.sift.detectAndCompute(gray, None)
        if d is None or len(kp) < MIN_INLIERS:
            return []
        fpts = np.array([p.pt for p in kp], dtype=np.float32)
        votes = {}
        for pair in self.flann.knnMatch(d, k=2):
            if len(pair) < 2:
                continue
            a, b = pair
            oa, ob = int(self.owner[a.trainIdx]), int(self.owner[b.trainIdx])
            same = self.group[oa] == self.group[ob]
            if a.distance < 0.72 * b.distance or (same and a.distance < 220):
                votes.setdefault(oa, []).append((a.trainIdx, a.queryIdx))
                if same and oa != ob and b.distance < 240:  # the look-alike gets the point too; position decides later
                    votes.setdefault(ob, []).append((b.trainIdx, b.queryIdx))
        dets = []
        for ref, ms in votes.items():
            if len(ms) < MIN_INLIERS:
                continue
            src = self.pts[[m[0] for m in ms]]
            dst = fpts[[m[1] for m in ms]]
            key = self.keys[ref]
            # The same item can be on screen several times: fit one copy, drop its points, fit again.
            first = None
            boxes = []
            for _ in range(6):
                if len(src) < MIN_INLIERS:
                    break
                M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=4.0)
                if M is None or inl is None:
                    break
                keep = inl.ravel() == 1
                n = int(keep.sum())
                scale = float(np.hypot(M[0, 0], M[0, 1]))
                if n < MIN_INLIERS or not (0.12 < scale < 2.0):
                    break
                if first is not None and n < max(12, 0.3 * first):  # further copies must be clear, not leftovers
                    break
                first = first or n
                cx, cy = dst[keep].mean(axis=0)
                rw, rh = self.ref_size(key)
                corners = cv2.transform(np.array([[[0, 0], [rw, 0], [rw, rh], [0, rh]]], dtype=np.float32), M)[0]
                bx0, by0 = corners.min(axis=0)
                bx1, by1 = corners.max(axis=0)
                # A second "copy" whose centre lies inside a copy already found is the same card seen twice.
                if any(b[0] <= cx <= b[2] and b[1] <= cy <= b[3] for b in boxes):
                    src, dst = src[~keep], dst[~keep]
                    continue
                boxes.append((bx0, by0, bx1, by1))
                fx = lambda v: round(rx0 + (rx1 - rx0) * float(v) / w, 4)  # noqa: E731
                fy = lambda v: round(ry0 + (ry1 - ry0) * float(v) / h, 4)  # noqa: E731
                dets.append(
                    {
                        "art": key,
                        "kind": key.split("/")[0],
                        "cardIds": self.mapping.get(key, []),
                        "cx": round(rx0 + (rx1 - rx0) * float(cx) / w, 4),
                        "cy": round(ry0 + (ry1 - ry0) * float(cy) / h, 4),
                        "size": round((rx1 - rx0) * scale * 320 / w, 4),
                        "inliers": n,
                        "box": [fx(bx0), fy(by0), fx(bx1), fy(by1)],  # the art's outline in the frame
                    }
                )
                src, dst = src[~keep], dst[~keep]
        # Where a picture exists in several kinds, the place on screen says which one it is: the lower row holds
        # the player's items, the top of the screen holds portraits.
        def rank(x):
            fits = (x["kind"] == "items" and x["cy"] >= 0.33) or (x["kind"] in ("monsters", "encounters") and x["cy"] < 0.5)
            return -(x["inliers"] + (10000 if fits else 0))

        dets.sort(key=rank)
        kept = []
        for dd in dets:  # two detections claiming the same spot: keep the stronger one
            inside = lambda k: k["box"][0] <= dd["cx"] <= k["box"][2] and k["box"][1] <= dd["cy"] <= k["box"][3]  # noqa: E731
            if all((abs(dd["cx"] - k["cx"]) > 0.02 or abs(dd["cy"] - k["cy"]) > 0.03) and not (inside(k) and (k["kind"] == dd["kind"] == "items" or self.group[self.keys.index(k["art"])] == self.group[self.keys.index(dd["art"])])) for k in kept):
                kept.append(dd)
        return kept


if __name__ == "__main__":
    import sys
    import time

    t = time.time()
    idx = build_index(force="--rebuild" in sys.argv)
    print(f"index: {len(idx.keys)} art files, {len(idx.desc)} descriptors, {time.time() - t:.1f}s")
    for p in [a for a in sys.argv[1:] if not a.startswith("--")]:
        t = time.time()
        res = idx.match(cv2.imread(p))
        print(p, f"{time.time() - t:.2f}s")
        for r in res:
            print("  ", r["art"], r["cx"], r["cy"], r["inliers"])
