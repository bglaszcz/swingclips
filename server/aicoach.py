"""AI coach for SwingClips: one short take after each session, from the session and the focus.

Calls Claude (Anthropic API) from the server with the owner's API key.
"""
from __future__ import annotations

from datetime import datetime
import json
import os
from pathlib import Path
import threading
import time
from typing import Any

try:
    import anthropic
except ImportError:
    # Fallback stub when anthropic SDK is not yet installed in local environment
    import types, sys
    _mod = types.ModuleType("anthropic")

    class AuthenticationError(Exception):
        status_code = 401

    class RateLimitError(Exception):
        status_code = 429

    class APIStatusError(Exception):
        def __init__(self, message="", *, response=None, body=None, status_code=500):
            super().__init__(message)
            self.status_code = status_code

    class APIConnectionError(Exception):
        pass

    class Anthropic:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("anthropic package not installed")

    _mod.AuthenticationError = AuthenticationError
    _mod.RateLimitError = RateLimitError
    _mod.APIStatusError = APIStatusError
    _mod.APIConnectionError = APIConnectionError
    _mod.Anthropic = Anthropic
    sys.modules["anthropic"] = _mod
    anthropic = _mod


MODEL = "claude-opus-5-5"
DAILY_CAP = 10
PROMPT_FILE = Path(__file__).parent / "aicoach_prompt.md"

HOW_TO_ADD = (
    "Make an API key at console.anthropic.com, paste it into anthropic-key.txt "
    "next to shots.jsonl (or set ANTHROPIC_API_KEY), then Tools > Update the server."
)

notes_lock = threading.Lock()


def get_base_dir() -> Path:
    if "SWINGCLIPS_SHOTS" in os.environ:
        return Path(os.environ["SWINGCLIPS_SHOTS"]).parent
    clips_dir = Path(os.environ.get("SWINGCLIPS_CLIPS", r"D:\SwingClips\clips"))
    return clips_dir.parent


def get_notes_file() -> Path:
    if "SWINGCLIPS_COACH_NOTES" in os.environ:
        return Path(os.environ["SWINGCLIPS_COACH_NOTES"])
    return get_base_dir() / "coach-notes.jsonl"


def get_key_file() -> Path:
    if "SWINGCLIPS_COACH_KEY" in os.environ:
        return Path(os.environ["SWINGCLIPS_COACH_KEY"])
    return get_base_dir() / "anthropic-key.txt"


def get_api_key(key_file: Path | None = None) -> str | None:
    """Reads API key from ANTHROPIC_API_KEY or key_file. Never logs or returns the key in status."""
    env_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if env_key:
        return env_key
    kf = key_file or get_key_file()
    if kf.exists():
        try:
            for line in kf.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line and not line.startswith("#"):
                    return line
        except Exception:
            pass
    return None


def get_system_prompt() -> str:
    if PROMPT_FILE.exists():
        return PROMPT_FILE.read_text(encoding="utf-8").strip()
    return ""


def load_notes(notes_file: Path | None = None) -> list[dict[str, Any]]:
    nf = notes_file or get_notes_file()
    if not nf.exists():
        return []
    notes: list[dict[str, Any]] = []
    try:
        content = nf.read_text(encoding="utf-8")
        for line in content.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                notes.append(json.loads(line))
            except Exception:
                continue
    except Exception:
        pass
    return notes


def get_kept_note(session: str | int, notes_file: Path | None = None) -> dict[str, Any] | None:
    target = str(session).strip()
    for note in reversed(load_notes(notes_file)):
        if str(note.get("session", "")).strip() == target:
            return note
    return None


def get_all_notes(notes_file: Path | None = None) -> list[dict[str, Any]]:
    return list(reversed(load_notes(notes_file)))


def calls_today(notes_file: Path | None = None) -> int:
    today = datetime.now().date()
    count = 0
    for note in load_notes(notes_file):
        t = note.get("t")
        if t is not None:
            try:
                if datetime.fromtimestamp(t).date() == today:
                    count += 1
            except Exception:
                pass
    return count


def save_note(
    note: dict[str, Any],
    notes_file: Path | None = None,
    lock: threading.Lock | None = None,
) -> None:
    nf = notes_file or get_notes_file()
    nf.parent.mkdir(parents=True, exist_ok=True)
    lk = lock or notes_lock
    with lk:
        with open(nf, "a", encoding="utf-8") as f:
            f.write(json.dumps(note) + "\n")


def status(notes_file: Path | None = None, key_file: Path | None = None) -> dict[str, Any]:
    key = get_api_key(key_file=key_file)
    return {
        "ready": bool(key),
        "callsToday": calls_today(notes_file=notes_file),
        "cap": DAILY_CAP,
        "howToAdd": HOW_TO_ADD,
    }


def ask(
    session: str | int,
    brief: str,
    again: bool = False,
    client: Any = None,
    notes_file: Path | None = None,
    key_file: Path | None = None,
    lock: threading.Lock | None = None,
) -> dict[str, Any]:
    session_str = str(session).strip()
    if not session_str:
        return {"error": "session is required"}

    if not again:
        kept = get_kept_note(session_str, notes_file=notes_file)
        if kept is not None:
            return {
                "text": kept.get("text", ""),
                "model": kept.get("model", MODEL),
                "t": kept.get("t", 0),
                "kept": True,
            }

    key = get_api_key(key_file=key_file)
    if not key and client is None:
        return {"error": "Add an API key to get the coach's take (Tools > AI coach)"}

    if calls_today(notes_file=notes_file) >= DAILY_CAP:
        return {"error": "Daily limit reached (10 calls/day). Try again tomorrow."}

    system_prompt = get_system_prompt()

    try:
        if client is None:
            client = anthropic.Anthropic(api_key=key)
        response = client.beta.messages.create(
            model=MODEL,
            max_tokens=2000,
            output_config={"effort": "medium"},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            system=system_prompt,
            messages=[{"role": "user", "content": brief}],
        )
    except anthropic.AuthenticationError:
        return {"error": "the API key isn't right"}
    except anthropic.RateLimitError:
        return {"error": "try again later"}
    except anthropic.APIStatusError as err:
        if getattr(err, "status_code", 0) >= 500:
            return {"error": "try again later"}
        return {"error": "try again later"}
    except anthropic.APIConnectionError:
        return {"error": "no internet?"}
    except Exception:
        return {"error": "try again later"}

    if getattr(response, "stop_reason", None) == "refusal":
        text = "The coach couldn't answer this one"
    else:
        text = "".join(b.text for b in getattr(response, "content", []) if getattr(b, "type", None) == "text")

    usage: dict[str, int] = {}
    resp_usage = getattr(response, "usage", None)
    if resp_usage:
        usage = {
            "input_tokens": getattr(resp_usage, "input_tokens", 0),
            "output_tokens": getattr(resp_usage, "output_tokens", 0),
        }

    now = time.time()
    note = {
        "session": session_str,
        "t": now,
        "model": MODEL,
        "brief": brief,
        "text": text,
        "usage": usage,
    }
    save_note(note, notes_file=notes_file, lock=lock)

    return {
        "text": text,
        "model": MODEL,
        "t": now,
        "kept": False,
    }
