"""Trains the club model: YOLO11 pose with three keypoints (grip end, hosel, clubhead), on the dataset
server/club_dataset.py makes from the hand labels, then exports it to ONNX for the server
(SWINGCLIPS_CLUB_BACKEND=yolo, models.py). Meant for a PC with an NVIDIA GPU; see HOME-SETUP.md,
"Training the club model", for installing (an RTX 50xx needs a PyTorch build for CUDA 12.8 or newer).

  python club_train.py --data D:\\SwingClips\\club-dataset\\data.yaml
  python club_train.py --data ... --model yolo11n-pose.pt          the small one (faster on the server's CPU)
  python club_train.py --data ... --pretrain D:\\golf_club_pose\\data.yaml --pretrain-points 0,1,2
                                                                   first a pass on another YOLO pose set

Augmentation: left-right flips (the keypoints keep their order: none of them has a side, see the
flip_idx in data.yaml), brightness (Ultralytics' hsv_v, plus brightness/contrast and gamma for
evening light), motion blur (the clubhead streaks in the downswing, the hands too) and JPEG
artefacts (phone clips are compressed), on top of Ultralytics' mosaic, scale and shift.

Writes the Ultralytics run to runs/<name> (best.pt, plots, metrics) and the ONNX model to --out
(default: public/models/club-yolo-pose.onnx in this repository), to copy to the server's
public\\models.
"""
import argparse
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "public" / "models" / "club-yolo-pose.onnx"
POINTS = ("grip", "hosel", "head")

# Ultralytics' own augmentation settings (the rest stay at its defaults).
TRAIN_ARGS = dict(
    fliplr=0.5, flipud=0.0,         # mirrored = a left-handed golfer, still a golfer; upside down isn't
    hsv_h=0.015, hsv_s=0.5, hsv_v=0.5,
    degrees=10.0, translate=0.1, scale=0.5, mosaic=1.0, close_mosaic=10, mixup=0.0,
    patience=40, cos_lr=True,
)


def augmentations():
    """The extra ones, through Albumentations (Ultralytics runs them after mosaic and scaling)."""
    import albumentations as A
    return [
        A.MotionBlur(blur_limit=(3, 21), p=0.3),
        A.RandomBrightnessContrast(brightness_limit=0.25, contrast_limit=0.2, p=0.4),
        A.RandomGamma(gamma_limit=(70, 150), p=0.2),
        A.ImageCompression(quality_range=(50, 95), p=0.3),
    ]


def check_device(device: str) -> None:
    """Says which GPU will be used, and stops early if the PyTorch build can't use it."""
    import torch
    if device == "cpu":
        print("Training on the CPU: fine for trying the script, far too slow for a real run.")
        return
    if not torch.cuda.is_available():
        sys.exit(f"PyTorch {torch.__version__} sees no CUDA GPU. Install the CUDA build (HOME-SETUP.md, "
                 "\"Training the club model\"), or --device cpu to try the script.")
    i = int(device.split(",")[0]) if device[:1].isdigit() else 0
    major, minor = torch.cuda.get_device_capability(i)
    arch = f"sm_{major}{minor}"
    print(f"GPU: {torch.cuda.get_device_name(i)} ({arch}), PyTorch {torch.__version__}, CUDA {torch.version.cuda}")
    if arch not in torch.cuda.get_arch_list():
        sys.exit(f"This PyTorch build has no kernels for {arch} ({', '.join(torch.cuda.get_arch_list())}). "
                 "An RTX 50xx (Blackwell, sm_120) needs a build for CUDA 12.8 or newer: see HOME-SETUP.md.")


# ---- Another YOLO pose dataset, as a first pass ----

def read_yaml(path: Path) -> dict:
    import yaml
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def split_dirs(root: Path, data: dict) -> dict[str, Path]:
    """Image folders by split: Roboflow's layout (train/images, valid/images next to data.yaml) or
    the paths in data.yaml."""
    out = {}
    for split, names in (("train", ("train",)), ("val", ("valid", "val"))):
        found = next((root / n / "images" for n in names if (root / n / "images").is_dir()), None)
        if found is None and isinstance(data.get(split), str):
            p = Path(data[split])
            for cand in (p, root / p, root / data.get("path", "") / p):
                if cand.is_dir():
                    found = cand
                    break
        if found is not None:
            out[split] = found
    return out


def convert_pretrain(src_yaml: Path, points: list[int], club_class: str | None, work: Path) -> Path:
    """Another YOLO pose dataset in this model's shape: only the club class, its keypoints picked and
    ordered as grip, hosel, head (-1 for one it doesn't have: not labeled). Returns the new data.yaml."""
    root = src_yaml.parent
    data = read_yaml(src_yaml)
    shape = data.get("kpt_shape")
    names = data.get("names")
    names = dict(enumerate(names)) if isinstance(names, list) else dict(names or {})
    describe = (f"{src_yaml}: classes {names}, kpt_shape {shape}"
                + (f", keypoints {data['kpt_names']}" if data.get("kpt_names") else ""))
    if not shape or len(shape) != 2 or shape[1] not in (2, 3):
        sys.exit(f"Not a YOLO pose dataset: {describe}")
    if len(points) != 3 or any(p >= shape[0] or p < -1 for p in points) or all(p < 0 for p in points):
        sys.exit(f"{describe}\n--pretrain-points: which of its {shape[0]} keypoints are the grip end, hosel "
                 "and clubhead, e.g. 0,1,2 (-1 for one it doesn't have)")
    if club_class is None:
        cls = [k for k, n in names.items() if "club" in str(n).lower()]
        if len(cls) != 1:
            sys.exit(f"{describe}\n--pretrain-class: which class is the club")
        cls = cls[0]
    else:
        cls = next((k for k, n in names.items() if str(n) == club_class or str(k) == club_class), None)
        if cls is None:
            sys.exit(f"No class {club_class!r}: {describe}")
    dims = shape[1]
    dirs = split_dirs(root, data)
    if "train" not in dirs:
        sys.exit(f"No training images found for {src_yaml} (looked for train/images next to it)")
    shutil.rmtree(work, ignore_errors=True)
    kept = 0
    for split, images in dirs.items():
        labels = images.parent / "labels"
        (work / "images" / split).mkdir(parents=True)
        (work / "labels" / split).mkdir(parents=True)
        for img in sorted(images.iterdir()):
            if img.suffix.lower() not in (".jpg", ".jpeg", ".png", ".bmp", ".webp"):
                continue
            src = labels / f"{img.stem}.txt"
            lines = []
            for row in (src.read_text().split("\n") if src.is_file() else []):
                v = row.split()
                if not v or int(float(v[0])) != int(cls):
                    continue
                kps = [float(x) for x in v[5:]]
                out = ["0", *v[1:5]]
                for p in points:
                    if p < 0:
                        out += ["0", "0", "0"]
                        continue
                    x, y = kps[p * dims], kps[p * dims + 1]
                    vis = kps[p * dims + 2] if dims == 3 else (2 if x or y else 0)
                    out += [f"{x:.6f}", f"{y:.6f}", "2"] if vis > 0 else ["0", "0", "0"]
                lines.append(" ".join(out))
            shutil.copy2(img, work / "images" / split / img.name)
            (work / "labels" / split / f"{img.stem}.txt").write_text("\n".join(lines) + ("\n" if lines else ""))
            kept += bool(lines)
    if "val" not in dirs:
        print("  (no validation split there: validating on its training images)")
    out = work / "data.yaml"
    out.write_text("\n".join([
        f"# {src_yaml}, keypoints {points} as grip, hosel, head (club_train.py --pretrain)",
        "train: images/train",
        f"val: images/{'val' if 'val' in dirs else 'train'}",
        "kpt_shape: [3, 3]", "flip_idx: [0, 1, 2]", "names:", "  0: club", ""]))
    print(f"Pretraining set: {kept} image(s) with a club, from {src_yaml}")
    return out


# ---- Training and export ----

def train(model: str, data: Path, args, name: str, epochs: int) -> Path:
    """One Ultralytics run; the best weights."""
    from ultralytics import YOLO
    yolo = YOLO(model)
    yolo.train(data=str(data), epochs=epochs, imgsz=args.imgsz, batch=args.batch, device=args.device,
               workers=args.workers, project=str(args.project), name=name, exist_ok=True, seed=0,
               augmentations=augmentations(), **TRAIN_ARGS)
    best = Path(yolo.trainer.best)
    if not best.is_file():
        best = Path(yolo.trainer.last)
    print(f"Best weights: {best}")
    return best


def export(weights: Path, imgsz: int, out: Path) -> Path:
    """ONNX, fixed input 1x3xSxS and no NMS in it (the server takes the best anchor), copied to `out`,
    then checked with ONNX Runtime the way the server will run it."""
    from ultralytics import YOLO
    onnx = Path(YOLO(str(weights)).export(format="onnx", imgsz=imgsz, dynamic=False, simplify=True, nms=False))
    out.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(onnx, out)
    import numpy as np
    import onnxruntime as ort
    s = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    got = s.run(None, {s.get_inputs()[0].name: np.zeros((1, 3, imgsz, imgsz), np.float32)})[0]
    if got.ndim != 3 or got.shape[1] != 4 + 1 + 3 * len(POINTS):
        sys.exit(f"{out}: output {got.shape}, expected (1, {4 + 1 + 3 * len(POINTS)}, anchors)")
    print(f"ONNX model: {out} ({out.stat().st_size >> 20} MB, output {tuple(got.shape)})")
    return out


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", type=Path, required=True, help="data.yaml from server/club_dataset.py")
    ap.add_argument("--model", default="yolo11s-pose.pt", help="starting weights: yolo11s-pose.pt (default) or "
                    "yolo11n-pose.pt (downloaded by Ultralytics), or a .pt of your own")
    ap.add_argument("--epochs", type=int, default=150)
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--batch", type=int, default=16, help="16 fits yolo11s at 640 in 16 GB with room to spare")
    ap.add_argument("--device", default="0", help="GPU index, or cpu")
    ap.add_argument("--workers", type=int, default=4, help="data loader processes")
    ap.add_argument("--project", type=Path, default=HERE / "runs")
    ap.add_argument("--name", default="club")
    ap.add_argument("--out", type=Path, default=OUT, help=f"the ONNX model (default {OUT})")
    ap.add_argument("--pretrain", type=Path, help="another YOLO pose data.yaml (e.g. Roboflow's golf_club_pose, "
                    "exported as YOLOv8 pose) to train on first")
    ap.add_argument("--pretrain-points", help="its keypoint indices for grip end, hosel, clubhead, e.g. 0,1,2 "
                    "(-1 for one it lacks); run without it to see its layout")
    ap.add_argument("--pretrain-class", help="its club class name (default: the one with 'club' in it)")
    ap.add_argument("--pretrain-epochs", type=int, default=50)
    ap.add_argument("--no-export", action="store_true", help="train only")
    args = ap.parse_args(argv)

    if not args.data.is_file():
        sys.exit(f"{args.data} not found: make it with server/club_dataset.py")
    check_device(args.device)
    start = args.model
    if args.pretrain:
        points = [int(p) for p in args.pretrain_points.split(",")] if args.pretrain_points else []
        work = args.project / f"{args.name}-pretrain-data"
        pre = convert_pretrain(args.pretrain, points, args.pretrain_class, work)
        start = str(train(start, pre, args, f"{args.name}-pretrain", args.pretrain_epochs))
    best = train(start, args.data, args, args.name, args.epochs)
    if not args.no_export:
        export(best, args.imgsz, args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
