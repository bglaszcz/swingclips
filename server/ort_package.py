"""Before pip installs a requirements file: takes out the ONNX Runtime packages it doesn't ask for.

onnxruntime (CPU), onnxruntime-directml and onnxruntime-gpu all install the same "onnxruntime"
folder, so two at once overwrite each other's files, and taking one out later breaks the other.
Start server.cmd runs this first with the file it's about to install (requirements.txt, or the one
SWINGCLIPS_REQUIREMENTS in settings.cmd names): when another flavour is installed, every flavour
comes out and pip then puts the wanted one back whole. Otherwise it does nothing.

  .venv\\Scripts\\python.exe ort_package.py requirements-dml.txt
"""
import re
import subprocess
import sys
from importlib import metadata
from pathlib import Path

FLAVOURS = ("onnxruntime", "onnxruntime-directml", "onnxruntime-gpu")


def normalize(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def wanted(requirements: Path) -> str | None:
    """The ONNX Runtime package a requirements file asks for (following -r), or None."""
    for line in requirements.read_text(encoding="utf-8").splitlines():
        line = line.split("#", 1)[0].strip()
        if line.startswith(("-r ", "--requirement ")):
            got = wanted(requirements.parent / line.split(None, 1)[1])
            if got:
                return got
            continue
        m = re.match(r"[A-Za-z0-9._-]+", line)
        if m and normalize(m.group()) in FLAVOURS:
            return normalize(m.group())
    return None


def installed() -> set[str]:
    return {normalize(d.metadata["Name"]) for d in metadata.distributions() if d.metadata["Name"]} & set(FLAVOURS)


def to_remove(want: str | None, have: set[str]) -> list[str]:
    """Every installed flavour when one other than `want` is among them (the wanted one too: its
    files may have been overwritten), else nothing."""
    if want is None or not have - {want}:
        return []
    return sorted(have)


def main(argv=None) -> int:
    args = sys.argv[1:] if argv is None else argv
    requirements = Path(args[0] if args else "requirements.txt")
    remove = to_remove(wanted(requirements), installed())
    if not remove:
        return 0
    print(f"ONNX Runtime: switching to {wanted(requirements)} ({requirements.name}); taking out {', '.join(remove)}",
          flush=True)
    return subprocess.run([sys.executable, "-m", "pip", "uninstall", "-y", "-q", *remove]).returncode


if __name__ == "__main__":
    sys.exit(main())
