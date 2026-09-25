"""Downloads the body models models.py can run into public/models (or SWINGCLIPS_MODELS), from
MMPose's official releases. Each release is a zip with the ONNX file (end2end.onnx) inside; only
that is kept, renamed after the model (rtmpose-m-256x192.onnx and so on).

  .venv\\Scripts\\python.exe fetch_models.py               all of them (~400 MB)
  .venv\\Scripts\\python.exe fetch_models.py rtmpose-m     just the ones named
  .venv\\Scripts\\python.exe fetch_models.py --force       again, over what's there
"""
import argparse
import io
import sys
import urllib.request
import zipfile

import models


def fetch(name: str, force: bool = False) -> None:
    spec = models.SPECS[name]
    dest = models.model_path(name)
    if dest.is_file() and not force:
        print(f"{name}: already there ({dest})")
        return
    print(f"{name}: downloading {spec.url}", flush=True)
    with urllib.request.urlopen(spec.url, timeout=60) as r:
        total = int(r.headers.get("Content-Length") or 0)
        buf = io.BytesIO()
        while chunk := r.read(1 << 20):
            buf.write(chunk)
            if total:
                print(f"\r  {buf.tell() >> 20} of {total >> 20} MB", end="", flush=True)
    print()
    with zipfile.ZipFile(buf) as z:
        onnx = [n for n in z.namelist() if n.endswith(".onnx")]
        if not onnx:
            raise RuntimeError(f"{spec.url} has no .onnx file in it")
        member = next((n for n in onnx if n.endswith("end2end.onnx")), onnx[0])
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_suffix(".part")
        tmp.write_bytes(z.read(member))
        tmp.replace(dest)
    print(f"  saved {dest} ({dest.stat().st_size >> 20} MB)")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("names", nargs="*", metavar="name", help=f"which: {', '.join(models.SPECS)} (default: all)")
    ap.add_argument("--force", action="store_true", help="download again even if the file is there")
    args = ap.parse_args(argv)
    unknown = [n for n in args.names if n not in models.SPECS]
    if unknown:
        ap.error(f"no model called {', '.join(unknown)}: use {', '.join(models.SPECS)}")
    failed = []
    for name in args.names or list(models.SPECS):
        try:
            fetch(name, args.force)
        except Exception as e:  # keep going: one blocked download shouldn't stop the others
            print(f"{name}: failed: {e}")
            failed.append(name)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
