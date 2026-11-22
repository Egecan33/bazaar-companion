"""Recognition regression on real frames captured during a run (test/fixtures/frames).

Run: vision/.venv/bin/python vision/test_matcher.py
Needs data/art (extract_art.py) built from the installed game.
"""
import collections
import os
import sys

import cv2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from matcher import ROOT, build_index  # noqa: E402
from watch import DEFAULT_CAL, read_gold, read_health, read_income  # noqa: E402

FRAMES = os.path.join(ROOT, "test", "fixtures", "frames")


def names(dets, lo, hi):
    return collections.Counter(d["art"].split("/")[1] for d in dets if lo <= d["cy"] < hi)


def main():
    idx = build_index()
    # Own board, left to right: Sextant, Marlon, Flying Fish, Piranha, IllusoRay, Piranha, Piranha, Seaweed.
    dets = idx.match(cv2.imread(os.path.join(FRAMES, "board-three-piranhas.jpg")))
    board = names(dets, 0.5, 1)
    want = {"Sextant": 1, "BlackMarlin": 1, "FlyingFish": 1, "Piranha": 3, "IllusoRay": 1, "Seaweed": 1}
    assert board == want, f"board: {dict(board)}"
    order = [d["art"].split("/")[1] for d in sorted((d for d in dets if d["cy"] >= 0.5), key=lambda d: d["cx"])]
    assert order == ["Sextant", "BlackMarlin", "FlyingFish", "Piranha", "IllusoRay", "Piranha", "Piranha", "Seaweed"], order
    # A fight: the monster portrait and both boards.
    dets = idx.match(cv2.imread(os.path.join(FRAMES, "fight-happy-camper.jpg")))
    assert any(d["art"] == "monsters/HappyCamper" for d in dets), "monster portrait not recognised"
    assert names(dets, 0.5, 1) == {"Jellyfish": 1, "IllusoRay": 1, "Barrel": 1}, dict(names(dets, 0.5, 1))
    assert set(names(dets, 0.3, 0.5)) >= {"PortableStove", "Skewer", "Citrus", "Cinder"}, dict(names(dets, 0.3, 0.5))
    # Counters.
    frame = cv2.imread(os.path.join(FRAMES, "gold-15-income-5.jpg"))
    assert (read_gold(frame, DEFAULT_CAL), read_income(frame, DEFAULT_CAL), read_health(frame, DEFAULT_CAL)) == (15, 5, 300)
    print("ok: 3 real frames")


if __name__ == "__main__":
    main()
