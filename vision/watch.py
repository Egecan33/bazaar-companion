"""Screen reader loop: capture the game's display, recognise card art, print one JSON line per frame.

Started by the Node server. Needs macOS Screen Recording permission for the app that launched
it (Terminal when started from the .command file); without it macOS returns frames that show
only the desktop, and nothing is recognised.

Options: --display N (default 1), --interval seconds (default 1.2), --record (keep a frame every
~20 s, newest 200 in data/captures/ for calibration), --once FILE (match one image and exit).
"""
import json
import os
import subprocess
import sys
import tempfile
import time

import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from matcher import ROOT, build_index  # noqa: E402

CAL = os.path.join(ROOT, "data", "calibration.json")
TESSERACT = next((p for p in ("/opt/homebrew/bin/tesseract", "/usr/local/bin/tesseract") if os.path.exists(p)), "tesseract")


def arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        return sys.argv[i + 1] if i + 1 < len(sys.argv) else default
    return default


def game_running():
    return subprocess.run(["/usr/bin/pgrep", "-f", "TheBazaar"], capture_output=True).returncode == 0


def game_in_front():
    """True when The Bazaar is the frontmost app, so other windows are never captured or saved."""
    try:
        asn = subprocess.run(["/usr/bin/lsappinfo", "front"], capture_output=True, timeout=2).stdout.decode().strip()
        name = subprocess.run(["/usr/bin/lsappinfo", "info", "-only", "name", asn], capture_output=True, timeout=2).stdout.decode()
        return "bazaar" in name.lower() and "companion" not in name.lower()
    except Exception:
        return True


# Where the counters sit, as fractions of the frame (x0, y0, x1, y1). Measured on a real
# 3024x1964 full-screen frame of game version 1.0.13176; data/calibration.json overrides them.
DEFAULT_CAL = {"gold": [0.797, 0.751, 0.828, 0.776], "income": [0.735, 0.751, 0.751, 0.776], "health": [0.465, 0.750, 0.535, 0.778], "level": [0.447, 0.895, 0.468, 0.919]}


def read_number(frame, box):
    """OCR one counter (light digits on a dark plate). Returns an int or None."""
    if not box:
        return None
    h, w = frame.shape[:2]
    x0, y0, x1, y1 = int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)
    crop = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2GRAY)
    crop = cv2.resize(crop, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    _, crop = cv2.threshold(crop, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)  # dark digits on white
    crop = cv2.copyMakeBorder(crop, 20, 20, 20, 20, cv2.BORDER_CONSTANT, value=255)
    ok, png = cv2.imencode(".png", crop)
    if not ok:
        return None
    try:
        out = subprocess.run(
            [TESSERACT, "stdin", "stdout", "--psm", "7", "-c", "tessedit_char_whitelist=0123456789"],
            input=png.tobytes(), capture_output=True, timeout=3,
        ).stdout.decode().strip()
        return int(out) if out.isdigit() else None
    except Exception:
        return None


def read_health(frame, cal):
    """The player's health: white digits on the green bar. Keeps only tall white shapes, then OCRs them."""
    box = cal.get("health")
    if not box:
        return None
    import numpy as np

    h, w = frame.shape[:2]
    x0, y0, x1, y1 = int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)
    hsv = cv2.cvtColor(frame[y0:y1, x0:x1], cv2.COLOR_BGR2HSV)
    m = ((hsv[..., 1] < 70) & (hsv[..., 2] > 200)).astype(np.uint8) * 255
    m = cv2.resize(m, None, fx=4, fy=4, interpolation=cv2.INTER_CUBIC)
    n, lab, st, _ = cv2.connectedComponentsWithStats((m > 127).astype(np.uint8))
    out = np.zeros_like(m)
    for i in range(1, n):
        if st[i, 3] >= 0.44 * m.shape[0] and st[i, 2] < 0.3 * m.shape[1]:
            out[lab == i] = 255
    ok, png = cv2.imencode(".png", cv2.copyMakeBorder(255 - out, 20, 20, 20, 20, cv2.BORDER_CONSTANT, value=255))
    try:
        t = subprocess.run([TESSERACT, "stdin", "stdout", "--psm", "7", "-c", "tessedit_char_whitelist=0123456789"],
                           input=png.tobytes(), capture_output=True, timeout=3).stdout.decode().strip()
        return int(t) if t.isdigit() and 50 <= int(t) <= 100000 else None
    except Exception:
        return None


def read_hover(frame):
    """Text of the tooltip the game shows for whatever the cursor is on: [{x, y, w, h, text}], fractions of the frame.

    The tooltip is a dark, solid rectangle; its text is light. The strip just above it is included because an item's
    name sits in a header that is not always part of the dark area.
    """
    import numpy as np

    H, W = frame.shape[:2]
    hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
    dark = (hsv[..., 2] < 52).astype(np.uint8) * 255
    dark = cv2.morphologyEx(dark, cv2.MORPH_CLOSE, np.ones((15, 15), np.uint8))
    out = []
    for c in cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        x, y, w, h = cv2.boundingRect(c)
        if w < 0.12 * W or h < 0.035 * H or w > 0.5 * W or h > 0.5 * H or y < 0.03 * H or cv2.contourArea(c) / (w * h) < 0.75:
            continue
        y0 = max(0, y - int(0.055 * H))
        g = cv2.cvtColor(frame[y0:y + h, x:x + w], cv2.COLOR_BGR2GRAY)
        g = 255 - cv2.resize(g, None, fx=1.5, fy=1.5, interpolation=cv2.INTER_CUBIC)
        ok, png = cv2.imencode(".png", g)
        try:
            text = subprocess.run([TESSERACT, "stdin", "stdout", "--psm", "6"], input=png.tobytes(), capture_output=True, timeout=4).stdout.decode().strip()
        except Exception:
            text = ""
        if text:
            out.append({"x": round(x / W, 3), "y": round(y / H, 3), "w": round(w / W, 3), "h": round(h / H, 3), "text": text[:600]})
    return out[:3]


def read_level(frame, cal):
    """The hero's level, from the badge on the portrait (a single 1 is often not readable)."""
    v = read_number(frame, cal.get("level"))
    return v if v is not None and 1 <= v <= 40 else None


def read_gold(frame, cal):
    return read_number(frame, cal.get("gold"))


def read_income(frame, cal):
    return read_number(frame, cal.get("income"))


SKILL_BAND = (0.28, 0.74, 0.72, 0.95)  # around the hero portrait, as fractions of the frame


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


PAUSED = False  # set by the server while a fight runs: nothing to read then, so the game keeps the CPU


def listen():
    global PAUSED
    for line in sys.stdin:
        PAUSED = line.strip() == "pause"


def main():
    try:
        os.nice(10)  # stay out of the game's way
    except OSError:
        pass
    cv2.setNumThreads(1)
    idx = build_index()
    cal = {**DEFAULT_CAL, **(json.load(open(CAL)) if os.path.exists(CAL) else {})}
    once = arg("--once")
    if once:
        frame = cv2.imread(once)
        emit({"ts": time.time(), "detections": idx.match(frame), "gold": read_gold(frame, cal), "income": read_income(frame, cal), "health": read_health(frame, cal), "hover": read_hover(frame)})
        return
    display = arg("--display", "1")
    interval = float(arg("--interval", "0.8"))
    import threading

    import numpy as np

    threading.Thread(target=listen, daemon=True).start()
    last_small, last_out = None, None
    skill_band, owned_skills = None, None
    counters, counter_patch = {"gold": None, "income": None, "health": None, "level": None}, {}
    record = "--record" in sys.argv
    capdir = os.path.join(ROOT, "data", "captures")
    if record:
        os.makedirs(capdir, exist_ok=True)
    tmp = os.path.join(tempfile.mkdtemp(prefix="bazaar-frame-"), "frame.jpg")
    emit({"ready": True, "art": len(idx.keys)})
    last_saved = 0
    while True:
        t0 = time.time()
        if not game_running():
            emit({"ts": t0, "game": False, "detections": []})
            time.sleep(3)
            continue
        if PAUSED:
            time.sleep(0.5)
            continue
        if not game_in_front():
            emit({"ts": t0, "game": True, "front": False, "detections": []})
            time.sleep(1)
            continue
        r = subprocess.run(["/usr/sbin/screencapture", "-x", "-t", "jpg", "-D", display, tmp], capture_output=True)
        frame = cv2.imread(tmp) if r.returncode == 0 else None
        if frame is None:
            emit({"ts": t0, "game": True, "error": "capture failed", "detections": []})
            time.sleep(interval)
            continue
        # Counters are small and cheap: each is re-read only when its own patch of the screen changed, every loop.
        H, W = frame.shape[:2]
        for key, fn in (("gold", read_gold), ("income", read_income), ("health", read_health), ("level", read_level)):
            bx = cal.get(key)
            if not bx:
                continue
            patch = cv2.cvtColor(frame[int(bx[1] * H):int(bx[3] * H), int(bx[0] * W):int(bx[2] * W)], cv2.COLOR_BGR2GRAY).astype(np.int16)
            old = counter_patch.get(key)
            if old is None or old.shape != patch.shape or float(np.abs(patch - old).mean()) > 1.0:
                counter_patch[key] = patch
                counters[key] = fn(frame, cal)
        # The heavy part (recognising pictures, reading the tooltip) runs only when the play area moved.
        small = cv2.resize(cv2.cvtColor(frame[int(0.08 * H):int(0.74 * H), int(0.16 * W):int(0.84 * W)], cv2.COLOR_BGR2GRAY), (96, 62), interpolation=cv2.INTER_AREA).astype(np.int16)
        if last_small is not None and last_out is not None and float(np.abs(small - last_small).mean()) < 1.5:
            emit({**last_out, **counters, "ts": t0, "ms": int((time.time() - t0) * 1000), "same": True})
            time.sleep(max(0.05, interval - (time.time() - t0)))
            continue
        dets = idx.match(frame)
        # The player's own skills sit as small round icons beside the hero portrait; they shrink as more are
        # owned, which the matcher tolerates. Read that band only when it changed.
        band = cv2.resize(cv2.cvtColor(frame[int(SKILL_BAND[1] * H):int(SKILL_BAND[3] * H), int(SKILL_BAND[0] * W):int(SKILL_BAND[2] * W)], cv2.COLOR_BGR2GRAY), (96, 40), interpolation=cv2.INTER_AREA).astype(np.int16)
        if skill_band is None or float(np.abs(band - skill_band).mean()) > 1.5 or owned_skills is None:
            skill_band = band
            owned_skills = [d for d in idx.match(frame, SKILL_BAND) if d["kind"] == "skills" and "_MON_" not in d["art"] and d["inliers"] >= 12]
        last_small = small
        last_out = {"game": True, "detections": dets, "hover": read_hover(frame), "ownedSkills": owned_skills}
        emit({**last_out, **counters, "ts": t0, "ms": int((time.time() - t0) * 1000)})
        if record and t0 - last_saved > 20:
            cv2.imwrite(os.path.join(capdir, time.strftime("%Y%m%d-%H%M%S") + ".jpg"), frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
            last_saved = t0
            old = sorted(os.listdir(capdir))[:-200]  # keep the newest 200 frames only
            for f in old:
                os.remove(os.path.join(capdir, f))
        time.sleep(max(0.05, interval - (time.time() - t0)))


if __name__ == "__main__":
    main()
