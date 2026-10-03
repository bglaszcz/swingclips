"""Updating the server from the review page (static/update.js: Tools > Update the server), and the sim
laptop's scripts from the server (relay/golf-launcher.ps1 fetches them each time it opens).

The update is a fast-forward `git pull` of this checkout. Whether the server then has to restart
depends on what changed: the review page's own files are served fresh from disk, but the Python, the
scripts the server runs itself (summary.js and friends, in V8) and the requirements are only read at
start. A restart is the server exiting with RESTART_EXIT, which "Start server.cmd" takes as "run me
again" (after pip, for new requirements). A change to "Start server.cmd" itself needs a restart by
hand: cmd reads a batch file line by line from disk, so it can't safely loop round a file that moved.
"""

import hashlib
import subprocess
from pathlib import Path

import swings

REPO = Path(__file__).resolve().parent.parent
RELAY_DIR = REPO / "relay"
RELAY_KINDS = (".ps1", ".cmd")
RESTART_EXIT = 3
# The review page's scripts the server runs as well (swings.py, games.py): a change needs a restart.
SERVER_JS = set(swings.JS_FILES + swings.JS_3D + ("games.js",))
START_CMD = "server/Start server.cmd"


class GitError(Exception):
    pass


def git(*args: str, timeout: float = 60) -> str:
    try:
        done = subprocess.run(["git", "-C", str(REPO), *args], capture_output=True, text=True,
                              timeout=timeout, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        raise GitError("git isn't installed on the server (or not on its PATH)")
    except subprocess.TimeoutExpired:
        raise GitError(f"git {args[0]} took longer than {timeout:.0f} s")
    if done.returncode != 0:
        raise GitError((done.stderr or done.stdout).strip() or f"git {args[0]} failed")
    return done.stdout


def restart_needed(files: list[str]) -> str:
    """What the changed files (repo paths) need: "none" (the page's own files, docs, the phones' app,
    the laptop's scripts), "auto" (the server restarts itself) or "manual" (Start server.cmd changed)."""
    need = "none"
    for f in files:
        if f == START_CMD:
            return "manual"
        if not f.startswith("server/") or f.startswith("server/tests/"):
            continue
        if f.startswith("server/static/") and f.rsplit("/", 1)[-1] not in SERVER_JS:
            continue
        need = "auto"
    return need


def _commits(span: str) -> list[dict]:
    out = []
    for line in git("log", "--format=%h%x09%cI%x09%s", span).splitlines():
        sha, when, subject = (line.split("\t", 2) + ["", ""])[:3]
        out.append({"sha": sha, "when": when, "subject": subject})
    return out


def _files(span: str) -> list[str]:
    return [f for f in git("diff", "--name-only", span).splitlines() if f]


def check() -> dict:
    """What an update would bring: fetches, then the commits and files between here and upstream."""
    git("fetch", "--quiet", timeout=30)
    try:
        upstream = git("rev-parse", "--abbrev-ref", "@{u}").strip()
    except GitError:
        raise GitError("This checkout's branch doesn't track a remote branch")
    files = _files("HEAD...@{u}")
    ahead = git("rev-list", "--count", "@{u}..HEAD").strip()
    return {"current": git("rev-parse", "--short", "HEAD").strip(), "upstream": upstream,
            "commits": _commits("HEAD..@{u}"), "files": files, "restart": restart_needed(files),
            "ahead": int(ahead or 0),
            "changed": _files("HEAD")}


def pull() -> dict:
    """Fast-forward to upstream. Never merges or overwrites local edits: git refuses, and says why."""
    before = git("rev-parse", "HEAD").strip()
    git("pull", "--ff-only", "--quiet", timeout=120)
    after = git("rev-parse", "HEAD").strip()
    span = f"{before}..{after}"
    files = _files(span) if before != after else []
    return {"from": before[:7], "to": after[:7], "commits": _commits(span) if files else [],
            "files": files, "restart": restart_needed(files)}


def relay_files() -> dict[str, str]:
    """The sim laptop's scripts by name, with their SHA-256 (hex): the launcher fetches the ones that differ."""
    out = {}
    for p in sorted(RELAY_DIR.iterdir()):
        if p.is_file() and p.suffix.lower() in RELAY_KINDS:
            out[p.name] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def relay_file(name: str) -> Path | None:
    """One of relay_files(), or None for any other name (no paths, no other kinds of file)."""
    return RELAY_DIR / name if name in relay_files() else None
