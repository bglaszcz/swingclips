"""Public golf-club outline datasets (Roboflow Universe, CC BY 4.0) as a club pose dataset for pretraining
(club_train.py --pretrain): the shaft outline's two ends become the grip end and the hosel, the clubhead
outline's middle the clubhead, in this model's keypoint order (grip, hosel, head).

Which shaft end is which: the one nearer the clubhead is the hosel; with no clubhead outlined, the one
nearer the hand (sets that outline hands); with neither, the frame is left out (the ends can't be told).
A clubhead with no shaft gives the clubhead alone (grip and hosel not labeled).

  python public_club.py --out D:\\SwingClips-dev\\public-data\\club-pose ^
      D:\\SwingClips-dev\\public-data\\golf-swing-v9 D:\\SwingClips-dev\\public-data\\golf-swing-analyzer-DTL

Each source is a YOLO instance segmentation export (data.yaml with names; train/valid/test folders of
images and labels). Class names are matched by meaning: shaft / stick, clubhead / head, hand. Then:

  python club_train.py --data <club dataset>\\data.yaml --pretrain <out>\\data.yaml --pretrain-points 0,1,2 --pretrain-class club
"""
import argparse
import os
import re
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

SHAFT, HEAD, HAND = ("shaft", "stick"), ("clubhead", "head", "club head", "club_head"), ("hand", "hands")
SPLITS = {"train": "train", "valid": "valid", "val": "valid", "test": "train"}   # their test set trains here
# A clubhead this far (shares of the shaft's length) from the nearer shaft end doesn't belong to it.
HEAD_FAR = 0.6
BOX_PAD, BOX_MIN_PAD = 0.1, 0.02   # as server/club_dataset.py


def read_names(data_yaml: Path) -> list[str]:
    text = data_yaml.read_text(encoding="utf-8")
    m = re.search(r"names:\s*\[(.*?)\]", text, re.S)
    if m:
        return [n.strip().strip("'\"") for n in m.group(1).split(",")]
    return [n.strip().strip("'\"") for n in re.findall(r"^\s+\d+:\s*(.+)$", text, re.M)]


def roles(names: list[str]) -> dict[int, str]:
    out = {}
    for i, n in enumerate(names):
        n = n.lower()
        out[i] = "shaft" if n in SHAFT else "head" if n in HEAD else "hand" if n in HAND else ""
    return out


def polygons(label: Path, role_of: dict[int, str], w: int, h: int) -> dict[str, list[np.ndarray]]:
    out = {"shaft": [], "head": [], "hand": []}
    for row in label.read_text().split("\n"):
        v = row.split()
        if len(v) < 7:
            continue
        r = role_of.get(int(float(v[0])), "")
        if r:
            pts = np.array(v[1:], float).reshape(-1, 2) * [w, h]
            out[r].append(pts)
    return out


def shaft_ends(poly: np.ndarray) -> tuple[np.ndarray, np.ndarray, float]:
    """The two ends of a thin outline along its long axis, and its length (px)."""
    c = poly.mean(axis=0)
    _, _, vt = np.linalg.svd(poly - c, full_matrices=False)
    proj = (poly - c) @ vt[0]
    lo, hi = proj.min(), proj.max()
    # The middle of the outline's points near each end (a few % of the length), not one corner.
    near_lo = poly[proj <= lo + 0.03 * (hi - lo)].mean(axis=0)
    near_hi = poly[proj >= hi - 0.03 * (hi - lo)].mean(axis=0)
    return near_lo, near_hi, float(hi - lo)


def keypoints(polys: dict, w: int, h: int):
    """[(x, y, v)] * 3 in shares (grip, hosel, head), or None when the frame can't be used."""
    head = max(polys["head"], key=len).mean(axis=0) if polys["head"] else None
    hand = max(polys["hand"], key=len).mean(axis=0) if polys["hand"] else None
    if polys["shaft"]:
        a, b, length = max((shaft_ends(p) for p in polys["shaft"]), key=lambda e: e[2])
        if length < 0.03 * max(w, h):
            return None
        if head is not None:
            da, db = np.linalg.norm(a - head), np.linalg.norm(b - head)
            hosel, grip = (a, b) if da < db else (b, a)
            if min(da, db) > HEAD_FAR * length:
                head = None   # outlined elsewhere: keep the shaft, not the clubhead
        elif hand is not None:
            grip, hosel = (a, b) if np.linalg.norm(a - hand) < np.linalg.norm(b - hand) else (b, a)
        else:
            return None
        pts = [grip, hosel, head]
    elif head is not None:
        pts = [None, None, head]
    else:
        return None
    out = []
    for p in pts:
        if p is None:
            out.append((0.0, 0.0, 0))
        else:
            out.append((min(max(p[0] / w, 0.0), 1.0), min(max(p[1] / h, 0.0), 1.0), 2))
    return out


def label_line(kps, w: int, h: int) -> str:
    xy = [(x * w, y * h) for x, y, v in kps if v]
    xs, ys = [p[0] for p in xy], [p[1] for p in xy]
    pad = BOX_PAD * max(max(xs) - min(xs), max(ys) - min(ys)) + BOX_MIN_PAD * h
    x0, x1 = max(0.0, min(xs) - pad), min(float(w), max(xs) + pad)
    y0, y1 = max(0.0, min(ys) - pad), min(float(h), max(ys) + pad)
    b = ((x0 + x1) / 2 / w, (y0 + y1) / 2 / h, (x1 - x0) / w, (y1 - y0) / h)
    return " ".join(["0", *(f"{v:.6f}" for v in b), *(f"{x:.6f} {y:.6f} {v}" for x, y, v in kps)])


def convert(sources: list[Path], out: Path) -> dict:
    shutil.rmtree(out, ignore_errors=True)
    counts = {}
    for si, src in enumerate(sources):
        role_of = roles(read_names(src / "data.yaml"))
        if "shaft" not in role_of.values() and "head" not in role_of.values():
            sys.exit(f"{src}: no shaft or clubhead class in {read_names(src / 'data.yaml')}")
        c = counts.setdefault(src.name, {"used": 0, "shaft+head": 0, "shaft+hand": 0, "head only": 0, "left out": 0})
        for folder, split in SPLITS.items():
            images = src / folder / "images"
            if not images.is_dir():
                continue
            # Roboflow's layout (train/images beside train/labels), as club_train.py --pretrain reads it.
            (out / split / "images").mkdir(parents=True, exist_ok=True)
            (out / split / "labels").mkdir(parents=True, exist_ok=True)
            for n, img in enumerate(sorted(images.iterdir())):
                lab = src / folder / "labels" / f"{img.stem}.txt"
                if not lab.is_file():
                    continue
                with Image.open(img) as im:
                    w, h = im.size
                polys = polygons(lab, role_of, w, h)
                kps = keypoints(polys, w, h)
                if kps is None:
                    c["left out"] += 1
                    continue
                c["used"] += 1
                c["head only" if not kps[0][2] else "shaft+head" if kps[2][2] else "shaft+hand"] += 1
                # Short names: Roboflow's run ~100 characters, past Windows' 260 in a training folder.
                name = f"s{si}-{folder[:2]}-{n:05d}{img.suffix.lower()}"
                dst = out / split / "images" / name
                try:
                    os.link(img, dst)
                except OSError:
                    shutil.copy2(img, dst)
                (out / split / "labels" / f"{Path(name).stem}.txt").write_text(label_line(kps, w, h) + "\n")
    (out / "data.yaml").write_text("\n".join([
        f"# public_club.py from {', '.join(s.name for s in sources)} (CC BY 4.0, Roboflow Universe)",
        "path: .", "train: train/images", "val: valid/images",
        "kpt_shape: [3, 3]", "flip_idx: [0, 1, 2]", "names:", "  0: club", ""]), encoding="utf-8")
    return counts


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sources", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    for name, c in convert(args.sources, args.out).items():
        print(f"{name}: {c}")
    print(f"Wrote {args.out / 'data.yaml'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
