"""The club labels as a YOLO pose dataset, for training the club model (train/club_train.py).

Every frame with the club labeled (static/labels.js: grip end, hosel and clubhead) is cut from its
clip, turned upright, and saved as an image with a label file next to it in YOLO's pose format: one
line per image, "0 <box cx cy w h> <grip x y v> <hosel x y v> <head x y v>", all in shares of the
picture. A point marked can't-see (X) gets visibility 0, as does one skipped (Tab); a blurred one
(Shift+click) stays visible at its label, which is the middle of the streak. The box is the points'
own, padded (the model finds the club as a box first). A frame with all three marked can't-see is
kept with an empty label file: a picture with no club in it.

Train and validation are split by swing (a face-on clip and its down-the-line partner are one
swing), never by frame: frames a few milliseconds apart are nearly the same picture, and a model
scored on frames of swings it trained on looks better than it is.

Run it on a PC with the clips, from the server folder (the server's own requirements are enough):

  .venv\\Scripts\\python.exe club_dataset.py --out D:\\SwingClips\\club-dataset

Clips come from SWINGCLIPS_CLIPS (and its trash folder, where the scorecard looks too), labels from
SWINGCLIPS_LABELS, as for the server. Writes images/{train,val}, labels/{train,val}, data.yaml (for
Ultralytics) and dataset.json (what went where). Running it again rebuilds the folder.
"""
import argparse
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path

import av
import cv2

import pose

CLIPS_DIR = Path(os.environ.get("SWINGCLIPS_CLIPS", r"D:\SwingClips\clips"))
TRASH_DIR = Path(os.environ.get("SWINGCLIPS_TRASH", CLIPS_DIR.parent / "trash"))
LABELS_DIR = Path(os.environ.get("SWINGCLIPS_LABELS", CLIPS_DIR.parent / "labels"))

POINTS = ("grip", "hosel", "head")
# Keypoint order after a left-right flip: none of the three has a side, so each stays itself.
FLIP_IDX = [0, 1, 2]
VAL_SHARE = 0.2
# The box around the points, grown on each side by this share of its longer side, plus this share
# of the picture height (so a short club, seen end on, still gets a box of some size).
BOX_PAD, BOX_MIN_PAD = 0.1, 0.02
# A labeled frame belongs to the video frame starting within this much of it (s), as in eval.py.
SAME_FRAME = 0.001
JPEG_QUALITY = 95


def keypoints(points: dict) -> list[tuple[float, float, int]] | None:
    """[(x, y, visibility)] for grip, hosel and head from one labeled frame: 2 in sight (blurred
    too), 0 can't-see or not labeled (at 0, 0). None if none of the three was labeled on it."""
    if not any(k in points for k in POINTS):
        return None
    out = []
    for k in POINTS:
        p = points.get(k)
        if isinstance(p, dict) and not p.get("hidden") and "x" in p and "y" in p:
            out.append((min(max(float(p["x"]), 0.0), 1.0), min(max(float(p["y"]), 0.0), 1.0), 2))
        else:
            out.append((0.0, 0.0, 0))
    return out


def box(kps, w: int, h: int) -> tuple[float, float, float, float] | None:
    """(cx, cy, bw, bh) in shares of the picture, around the points in sight, padded and kept inside
    the picture; None if none are in sight."""
    xy = [(x * w, y * h) for x, y, v in kps if v]
    if not xy:
        return None
    xs, ys = [p[0] for p in xy], [p[1] for p in xy]
    pad = BOX_PAD * max(max(xs) - min(xs), max(ys) - min(ys)) + BOX_MIN_PAD * h
    x0, x1 = max(0.0, min(xs) - pad), min(float(w), max(xs) + pad)
    y0, y1 = max(0.0, min(ys) - pad), min(float(h), max(ys) + pad)
    return (x0 + x1) / 2 / w, (y0 + y1) / 2 / h, (x1 - x0) / w, (y1 - y0) / h


def label_line(kps, w: int, h: int) -> str:
    """The frame's line in YOLO pose format, or "" for a frame with no club in sight."""
    b = box(kps, w, h)
    if b is None:
        return ""
    return " ".join(["0", *(f"{v:.6f}" for v in b), *(f"{x:.6f} {y:.6f} {v}" for x, y, v in kps)])


def label_docs(folder: Path) -> dict[str, dict]:
    """First-pass label files by clip name. (A second pass labels the same frames again: no new pictures.)"""
    out = {}
    if folder.is_dir():
        for f in sorted(folder.glob("*.json")):
            if f.name.endswith(".pass2.json"):
                continue
            doc = json.loads(f.read_text(encoding="utf-8"))
            out[doc["clip"]["name"]] = doc
    return out


def swings(docs: dict[str, dict]) -> dict[str, str]:
    """Each clip's swing: the first name, alphabetically, of the clips linked to it as partners
    (either label file saying so is enough)."""
    parent = {name: name for name in docs}

    def root(n):
        while parent[n] != n:
            parent[n] = parent[parent[n]]
            n = parent[n]
        return n

    for name, doc in docs.items():
        other = (doc.get("partner") or {}).get("name")
        if other:
            parent.setdefault(other, other)
            a, b = sorted((root(name), root(other)))
            parent[b] = a
    return {name: root(name) for name in docs}


def split(swing_names, val_share: float = VAL_SHARE) -> set[str]:
    """The swings for validation: a fixed-looking random share of them, by a hash of their names (the
    same on every run and PC), at least one when there are two or more swings, and never all."""
    names = sorted(set(swing_names), key=lambda s: hashlib.sha1(s.encode()).hexdigest())
    n = len(names)
    k = min(max(round(n * val_share), 1 if n >= 2 else 0), max(n - 1, 0))
    return set(names[:k])


def clip_path(name: str) -> Path | None:
    return next((p for p in (CLIPS_DIR / name, TRASH_DIR / name) if p.is_file()), None)


def frames_at(path: Path, times: list[float]):
    """(t, upright BGR picture) for each wanted time the clip has a frame starting at (within
    SAME_FRAME), in order."""
    _, _, rotation = pose.probe(str(path))
    want = sorted(times)
    k = 0
    with av.open(str(path)) as c:
        s = c.streams.video[0]
        tb = float(s.time_base)
        for f in c.decode(s):
            if k >= len(want):
                break
            if f.pts is None:
                continue
            t = f.pts * tb
            while k < len(want) and want[k] < t - SAME_FRAME:
                k += 1                                  # no frame starts there: skipped
            if k < len(want) and abs(want[k] - t) <= SAME_FRAME:
                img = f.to_ndarray(format="bgr24")
                if rotation in pose.ROTATE_CW:
                    img = cv2.rotate(img, pose.ROTATE_CW[rotation])
                yield want[k], img
                k += 1


def prepare(out: Path, force: bool) -> None:
    """An empty dataset folder: a folder this script wrote before is rebuilt, anything else refused."""
    if out.exists() and any(out.iterdir()):
        if not (out / "data.yaml").is_file() and not force:
            raise SystemExit(f"{out} has other things in it: pick an empty folder (or --force)")
        for sub in ("images", "labels"):
            shutil.rmtree(out / sub, ignore_errors=True)
        for f in ("data.yaml", "dataset.json"):
            (out / f).unlink(missing_ok=True)
    for sub in ("images", "labels"):
        for part in ("train", "val"):
            (out / sub / part).mkdir(parents=True, exist_ok=True)


def data_yaml() -> str:
    return "\n".join([
        "# Written by server/club_dataset.py: the club's three points, for train/club_train.py.",
        "# No path: Ultralytics takes this file's folder, so the dataset can be copied to another PC.",
        "train: images/train",
        "val: images/val",
        "# Keypoints: 0 grip end, 1 hosel, 2 clubhead; x, y and visibility each.",
        "kpt_shape: [3, 3]",
        "# A left-right flip keeps each point itself (none of them has a side).",
        f"flip_idx: {FLIP_IDX}",
        "names:",
        "  0: club",
        "",
    ])


def export(out: Path, val_share: float = VAL_SHARE, force: bool = False, labels_dir: Path | None = None) -> dict:
    """Writes the dataset; returns what went where (also saved as dataset.json)."""
    docs = label_docs(labels_dir or LABELS_DIR)
    swing_of = swings(docs)
    todo = {}                                             # clip -> {t: (keypoints, blurred points)}
    for name, doc in docs.items():
        got = {}
        for tkey, points in (doc.get("frames") or {}).items():
            points = points or {}
            kps = keypoints(points)
            # A frame with some points skipped and none in sight says nothing: left out.
            if kps is not None and (any(v for *_, v in kps) or all((points.get(k) or {}).get("hidden") for k in POINTS)):
                got[float(tkey)] = kps, [k for k in POINTS if (points.get(k) or {}).get("blur")]
        if got:
            todo[name] = got
    manifest = {"images": [], "skipped": [], "swings": {"train": [], "val": []}}
    paths = {}
    for name in sorted(todo):
        paths[name] = clip_path(name)
        if paths[name] is None:
            manifest["skipped"].append({"clip": name, "why": "clip not found"})
            print(f"  skipped {name}: not in {CLIPS_DIR} or the trash")
    # Split among the swings that are there, so a missing clip can't leave validation empty.
    val = split([swing_of[n] for n in todo if paths[n]], val_share)
    prepare(out, force)
    for name in sorted(todo):
        part = "val" if swing_of[name] in val else "train"
        path = paths[name]
        if path is None:
            continue
        wanted = todo[name]
        found = set()
        stem = Path(name).stem
        for t, img in frames_at(path, list(wanted)):
            found.add(t)
            h, w = img.shape[:2]
            file = f"{stem}_{round(t * 1e6):010d}"
            cv2.imwrite(str(out / "images" / part / f"{file}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            kps, blur = wanted[t]
            line = label_line(kps, w, h)
            (out / "labels" / part / f"{file}.txt").write_text(line + "\n" if line else "", encoding="utf-8")
            manifest["images"].append({"image": f"images/{part}/{file}.jpg", "clip": name, "t": t,
                                       "swing": swing_of[name], "split": part, "size": [w, h],
                                       "visible": [k for k, (*_, v) in zip(POINTS, kps) if v], "blur": blur})
        for t in sorted(set(wanted) - found):
            manifest["skipped"].append({"clip": name, "t": t, "why": "no frame starts there"})
            print(f"  skipped {name} at {t:.6f} s: no frame of the clip starts there")
    for part in ("train", "val"):
        manifest["swings"][part] = sorted({i["swing"] for i in manifest["images"] if i["split"] == part})
    (out / "data.yaml").write_text(data_yaml(), encoding="utf-8")
    (out / "dataset.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return manifest


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True, help="the dataset folder (rebuilt if this script made it)")
    ap.add_argument("--val", type=float, default=VAL_SHARE, help=f"share of swings for validation (default {VAL_SHARE})")
    ap.add_argument("--force", action="store_true", help="use --out even if something else is in it")
    args = ap.parse_args(argv)
    if not LABELS_DIR.is_dir():
        print(f"No labels in {LABELS_DIR}: label some clips in the review page first (press L).")
        return 1
    m = export(args.out, args.val, args.force)
    for part in ("train", "val"):
        imgs = [i for i in m["images"] if i["split"] == part]
        print(f"{part}: {len(imgs)} frame(s) from {len(m['swings'][part])} swing(s); "
              f"clubhead in sight {sum('head' in i['visible'] for i in imgs)}, blurred {sum('head' in i['blur'] for i in imgs)}, "
              f"no club {sum(not i['visible'] for i in imgs)}")
    print(f"Wrote {args.out / 'data.yaml'}" + (f" ({len(m['skipped'])} skipped, see dataset.json)" if m["skipped"] else ""))
    return 0 if m["images"] else 1


if __name__ == "__main__":
    sys.exit(main())
