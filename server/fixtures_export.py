"""Copies the hand labels and the pose files they need from the server into tests/fixtures/real, so the
scorecard (eval.py) runs on real swings anywhere: no clips, no server. Only pose results and labels go
in (skeleton points, ball, shaft angle, key moments), never video.

  .venv\\Scripts\\python.exe fixtures_export.py                       from the server on this network
  .venv\\Scripts\\python.exe fixtures_export.py --server http://192.168.86.250:8000

Run it again after labeling more: it replaces what's there. Then score with (see the folder's README):
  SWINGCLIPS_LABELS=tests/fixtures/real/labels SWINGCLIPS_POSE=tests/fixtures/real/pose python eval.py --no-noise --no-quality
"""
import argparse
import gzip
import json
import shutil
import urllib.request
from pathlib import Path

import pose

HERE = Path(__file__).parent
OUT = HERE / "tests" / "fixtures" / "real"
# What the clip listing says about each clip that's worth keeping: no file sizes or local paths.
CLIP_FIELDS = ("name", "angle", "strike", "partner", "recorded", "camera", "quality", "shot", "excluded")


def get(server: str, path: str) -> bytes:
    with urllib.request.urlopen(server.rstrip("/") + path, timeout=60) as r:
        return r.read()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--server", default="http://192.168.86.250:8000")
    ap.add_argument("--out", type=Path, default=OUT)
    args = ap.parse_args(argv)

    listing = {c["name"]: c for c in json.loads(get(args.server, "/api/clips"))}
    passes = json.loads(get(args.server, "/api/labels"))
    for sub in ("labels", "pose"):
        shutil.rmtree(args.out / sub, ignore_errors=True)
        (args.out / sub).mkdir(parents=True)

    need = set()
    for label_pass, names in passes.items():
        for name in names:
            doc = json.loads(get(args.server, f"/api/labels/{name}?pass={label_pass}"))
            suffix = ".json" if label_pass == "1" else f".pass{label_pass}.json"
            (args.out / "labels" / (name + suffix)).write_text(json.dumps(doc, indent=1), encoding="utf-8")
            need.add(name)
            if (doc.get("partner") or {}).get("name"):
                need.add(doc["partner"]["name"])

    clips, missing = [], []
    for name in sorted(need):
        try:
            body = get(args.server, f"/api/pose/{name}")
        except OSError:
            missing.append(name)
            continue
        if body[:2] != b"\x1f\x8b":
            body = gzip.compress(body)
        (args.out / "pose" / f"{name}.v{pose.VERSION}.json.gz").write_bytes(body)
        if name in listing:
            clips.append({k: listing[name].get(k) for k in CLIP_FIELDS})
    (args.out / "clips.json").write_text(json.dumps(clips, indent=1), encoding="utf-8")

    labeled = sum(len(v) for v in passes.values())
    print(f"{labeled} label file(s), {len(clips)} clip(s) with pose into {args.out}"
          + (f"; no pose (still queued, or trashed) for: {', '.join(missing)}" if missing else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
