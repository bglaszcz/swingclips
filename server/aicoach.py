"""AI coach for SwingClips: one short take after each session, from the session and the focus.

Any of the big AI providers, with the owner's own API key (the owner, Oct 9: "AI agnostic"):
Anthropic (Claude, through its official SDK), OpenAI, Google (Gemini), or any other OpenAI-compatible
service (xAI, Mistral, DeepSeek, OpenRouter, a local Ollama...) by its base URL. The provider and model
are picked on Tools > AI coach; the models offered come from the provider's own list, so a name never
goes stale. Keys stay on the server (an environment variable, or a key file next to shots.jsonl, which
the page can write) and are never sent back to the browser or logged.

Only the text brief goes out (static/aicoach.js builds it): no video, pictures or names. One answer per
session is kept in coach-notes.jsonl; at most DAILY_CAP calls a day.
"""
from __future__ import annotations

from datetime import datetime
import json
import os
from pathlib import Path
import threading
import time
from typing import Any, Callable
import urllib.error
import urllib.request

try:
    import anthropic
except ImportError:   # not installed yet: Claude can't be used until it is (requirements-common.txt)
    anthropic = None

DAILY_CAP = 10
PROMPT_FILE = Path(__file__).parent / "aicoach_prompt.md"
MAX_TOKENS = 2000
TIMEOUT_S = 120

# The providers: their names on the page, the key's environment variable and file, the default model
# (None: picked from the provider's list on Tools > AI coach), and where to make a key.
PROVIDERS = {
    "anthropic": {"name": "Anthropic (Claude)", "env": ["ANTHROPIC_API_KEY"], "file": "anthropic-key.txt",
                  "model": "claude-opus-5-5", "keys": "console.anthropic.com"},
    "openai": {"name": "OpenAI (ChatGPT)", "env": ["OPENAI_API_KEY"], "file": "openai-key.txt",
               "model": None, "keys": "platform.openai.com/api-keys"},
    "google": {"name": "Google (Gemini)", "env": ["GEMINI_API_KEY", "GOOGLE_API_KEY"], "file": "gemini-key.txt",
               "model": None, "keys": "aistudio.google.com/apikey"},
    "other": {"name": "Other (OpenAI-compatible: xAI, Mistral, DeepSeek, OpenRouter, Ollama...)",
              "env": ["AICOACH_OTHER_API_KEY"], "file": "other-ai-key.txt", "model": None,
              "keys": "the provider's site (and its API base URL, e.g. https://api.x.ai/v1)"},
}
OPENAI_URL = "https://api.openai.com/v1"
GOOGLE_URL = "https://generativelanguage.googleapis.com/v1beta"
# Claude models that take effort and the server-side fallback on a declined request.
CLAUDE_FALLBACK = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}
CLAUDE_EFFORT_PREFIXES = ("claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-fable",
                          "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-5")
# OpenAI's list has non-chat models too: these words mark them.
OPENAI_NOT_CHAT = ("audio", "realtime", "tts", "transcribe", "image", "embedding", "search", "moderation",
                   "dall-e", "whisper", "davinci", "babbage", "computer-use")

HOW_TO_ADD = ("Pick a provider on Tools > AI coach, paste your API key there (it's kept on the home server), "
              "and pick a model from the provider's list.")

notes_lock = threading.Lock()
settings_lock = threading.Lock()


class CoachError(Exception):
    """Something to say on the page instead of an answer."""


# ---- Where things are kept ----

def get_base_dir() -> Path:
    if "SWINGCLIPS_SHOTS" in os.environ:
        return Path(os.environ["SWINGCLIPS_SHOTS"]).parent
    clips_dir = Path(os.environ.get("SWINGCLIPS_CLIPS", r"D:\SwingClips\clips"))
    return clips_dir.parent


def get_notes_file() -> Path:
    if "SWINGCLIPS_COACH_NOTES" in os.environ:
        return Path(os.environ["SWINGCLIPS_COACH_NOTES"])
    return get_base_dir() / "coach-notes.jsonl"


def get_settings_file() -> Path:
    return get_base_dir() / "ai-coach.json"


def get_key_file(provider: str = "anthropic") -> Path:
    if provider == "anthropic" and "SWINGCLIPS_COACH_KEY" in os.environ:
        return Path(os.environ["SWINGCLIPS_COACH_KEY"])
    return get_base_dir() / PROVIDERS[provider]["file"]


def get_api_key(provider: str = "anthropic", key_file: Path | None = None) -> str | None:
    """The provider's key: its environment variable, else the first line of its key file."""
    for var in PROVIDERS[provider]["env"]:
        v = os.environ.get(var, "").strip()
        if v:
            return v
    kf = key_file or get_key_file(provider)
    try:
        for line in kf.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                return line
    except OSError:
        pass
    return None


def save_key(provider: str, key: str) -> None:
    """Writes (or, with an empty key, clears) the provider's key file; atomically."""
    if provider not in PROVIDERS:
        raise ValueError("Unknown provider")
    kf = get_key_file(provider)
    kf.parent.mkdir(parents=True, exist_ok=True)
    tmp = kf.with_suffix(".tmp")
    tmp.write_text((key or "").strip() + "\n", encoding="utf-8")
    tmp.replace(kf)


def load_settings() -> dict[str, Any]:
    try:
        s = json.loads(get_settings_file().read_text(encoding="utf-8"))
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def save_settings(provider: str | None = None, model: str | None = None, base_url: str | None = None) -> dict:
    """The provider in use, its model and (for "other") the base URL; kept in ai-coach.json."""
    if provider is not None and provider not in PROVIDERS:
        raise ValueError("Unknown provider")
    with settings_lock:
        s = load_settings()
        if provider is not None:
            s["provider"] = provider
        p = s.get("provider") or "anthropic"
        if model is not None:
            s.setdefault("models", {})[p] = model.strip() or None
        if base_url is not None:
            s["baseUrl"] = base_url.strip().rstrip("/")
        f = get_settings_file()
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(".tmp")
        tmp.write_text(json.dumps(s, indent=1), encoding="utf-8")
        tmp.replace(f)
        return s


def current(key_file: Path | None = None) -> dict[str, Any]:
    """The provider in use (the one picked, else the first with a key), its model, base URL and key."""
    s = load_settings()
    provider = s.get("provider")
    if provider not in PROVIDERS:
        provider = next((p for p in PROVIDERS if get_api_key(p)), "anthropic")
    model = (s.get("models") or {}).get(provider) or PROVIDERS[provider]["model"]
    return {"provider": provider, "model": model, "baseUrl": s.get("baseUrl") or "",
            "key": get_api_key(provider, key_file if provider == "anthropic" else None)}


def get_system_prompt() -> str:
    try:
        return PROMPT_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


# ---- Notes ----

def load_notes(notes_file: Path | None = None) -> list[dict[str, Any]]:
    nf = notes_file or get_notes_file()
    notes: list[dict[str, Any]] = []
    try:
        for line in nf.read_text(encoding="utf-8").splitlines():
            if line.strip():
                try:
                    notes.append(json.loads(line))
                except ValueError:
                    continue
    except OSError:
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
        try:
            if datetime.fromtimestamp(note["t"]).date() == today:
                count += 1
        except (KeyError, TypeError, ValueError, OSError):
            pass
    return count


def save_note(note: dict[str, Any], notes_file: Path | None = None, lock: threading.Lock | None = None) -> None:
    nf = notes_file or get_notes_file()
    nf.parent.mkdir(parents=True, exist_ok=True)
    with lock or notes_lock:
        with open(nf, "a", encoding="utf-8") as f:
            f.write(json.dumps(note) + "\n")


def status(notes_file: Path | None = None, key_file: Path | None = None) -> dict[str, Any]:
    cur = current(key_file)
    return {
        "ready": bool(cur["key"]) and bool(cur["model"]) and (cur["provider"] != "other" or bool(cur["baseUrl"])),
        "provider": cur["provider"], "model": cur["model"], "baseUrl": cur["baseUrl"],
        "providers": [{"id": p, "name": v["name"], "hasKey": bool(get_api_key(p, key_file if p == "anthropic" else None)),
                       "keys": v["keys"]} for p, v in PROVIDERS.items()],
        "callsToday": calls_today(notes_file=notes_file), "cap": DAILY_CAP, "howToAdd": HOW_TO_ADD,
    }


# ---- Talking to the providers ----

def _http(method: str, url: str, headers: dict, body: dict | None = None) -> dict:
    """One JSON request; HTTP errors become CoachError with what to do."""
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={**headers, **({"Content-Type": "application/json"} if data else {})})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise CoachError(http_problem(e.code)) from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise CoachError("Couldn't reach the provider: no internet?") from None
    except ValueError:
        raise CoachError("The provider sent back something unreadable: try again later") from None


def http_problem(code: int) -> str:
    if code in (401, 403):
        return "The API key isn't right (or has no access): check it on Tools > AI coach"
    if code == 404:
        return "That model isn't available with this key: pick another on Tools > AI coach"
    if code == 429:
        return "Rate limited or out of credit with the provider: try again later"
    if code >= 500:
        return "The provider is having trouble: try again later"
    return f"The provider refused the request ({code})"


def _openai_headers(key: str) -> dict:
    return {"Authorization": f"Bearer {key}"}


def list_models(provider: str, key: str | None = None, base_url: str = "", http: Callable = _http,
                client: Any = None) -> list[str]:
    """The provider's models that can write a reply, by id, sorted (newest names last)."""
    key = key or get_api_key(provider)
    if not key:
        raise CoachError("Add the API key first")
    if provider == "anthropic":
        if client is None:
            if anthropic is None:
                raise CoachError("The server needs the anthropic package: Tools > Update the server")
            client = anthropic.Anthropic(api_key=key)
        try:
            return sorted(m.id for m in client.models.list())
        except Exception as e:   # the SDK's errors, as for a call
            raise CoachError(_anthropic_problem(e)) from None
    if provider == "google":
        got = http("GET", f"{GOOGLE_URL}/models?pageSize=1000", {"x-goog-api-key": key})
        return sorted(m["name"].removeprefix("models/") for m in got.get("models", [])
                      if "generateContent" in (m.get("supportedGenerationMethods") or []))
    url = OPENAI_URL if provider == "openai" else base_url
    if not url:
        raise CoachError("Add the provider's API base URL first")
    got = http("GET", f"{url}/models", _openai_headers(key))
    ids = [m.get("id") for m in got.get("data", []) if m.get("id")]
    if provider == "openai":
        ids = [i for i in ids if i.startswith(("gpt", "o", "chatgpt")) and not any(w in i for w in OPENAI_NOT_CHAT)]
    return sorted(ids)


def _anthropic_problem(e: Exception) -> str:
    if anthropic is None:
        return "The provider is having trouble: try again later"
    if isinstance(e, anthropic.AuthenticationError) or isinstance(e, anthropic.PermissionDeniedError):
        return http_problem(401)
    if isinstance(e, anthropic.NotFoundError):
        return http_problem(404)
    if isinstance(e, anthropic.RateLimitError):
        return http_problem(429)
    if isinstance(e, anthropic.APIStatusError):
        return http_problem(getattr(e, "status_code", 500) or 500)
    if isinstance(e, anthropic.APIConnectionError):
        return "Couldn't reach the provider: no internet?"
    return "The provider is having trouble: try again later"


def call_anthropic(model: str, key: str, system: str, brief: str, client: Any = None) -> dict:
    if client is None:
        if anthropic is None:
            raise CoachError("The server needs the anthropic package: Tools > Update the server")
        client = anthropic.Anthropic(api_key=key)
    args = {"model": model, "max_tokens": MAX_TOKENS, "system": system,
            "messages": [{"role": "user", "content": brief}]}
    if model.startswith(CLAUDE_EFFORT_PREFIXES):
        args["output_config"] = {"effort": "medium"}
    try:
        if model in CLAUDE_FALLBACK:
            # A declined request is retried on another model, server side.
            response = client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **args)
        else:
            response = client.messages.create(**args)
    except Exception as e:
        raise CoachError(_anthropic_problem(e)) from None
    if getattr(response, "stop_reason", None) == "refusal":
        return {"text": "The coach couldn't answer this one.", "usage": {}}
    text = "".join(b.text for b in getattr(response, "content", []) if getattr(b, "type", None) == "text")
    u = getattr(response, "usage", None)
    return {"text": text, "usage": {"input_tokens": getattr(u, "input_tokens", 0), "output_tokens": getattr(u, "output_tokens", 0)} if u else {}}


def call_openai(model: str, key: str, system: str, brief: str, base_url: str = OPENAI_URL, http: Callable = _http) -> dict:
    got = http("POST", f"{base_url}/chat/completions", _openai_headers(key),
               {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": brief}]})
    msg = ((got.get("choices") or [{}])[0].get("message") or {})
    if msg.get("refusal") and not msg.get("content"):
        return {"text": "The coach couldn't answer this one.", "usage": {}}
    u = got.get("usage") or {}
    return {"text": msg.get("content") or "", "usage": {"input_tokens": u.get("prompt_tokens", 0), "output_tokens": u.get("completion_tokens", 0)}}


def call_google(model: str, key: str, system: str, brief: str, http: Callable = _http) -> dict:
    got = http("POST", f"{GOOGLE_URL}/models/{model}:generateContent", {"x-goog-api-key": key},
               {"systemInstruction": {"parts": [{"text": system}]},
                "contents": [{"role": "user", "parts": [{"text": brief}]}]})
    cand = (got.get("candidates") or [{}])[0]
    parts = (cand.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts)
    if not text and ((got.get("promptFeedback") or {}).get("blockReason") or cand.get("finishReason") in ("SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST")):
        return {"text": "The coach couldn't answer this one.", "usage": {}}
    u = got.get("usageMetadata") or {}
    return {"text": text, "usage": {"input_tokens": u.get("promptTokenCount", 0), "output_tokens": u.get("candidatesTokenCount", 0)}}


def ask(
    session: str | int,
    brief: str,
    again: bool = False,
    client: Any = None,
    notes_file: Path | None = None,
    key_file: Path | None = None,
    lock: threading.Lock | None = None,
    http: Callable = _http,
) -> dict[str, Any]:
    """The coach's take on a session: the kept one, or a new call to the provider in use."""
    session_str = str(session).strip()
    if not session_str:
        return {"error": "session is required"}
    if not again:
        kept = get_kept_note(session_str, notes_file=notes_file)
        if kept is not None:
            return {"text": kept.get("text", ""), "model": kept.get("model", ""), "provider": kept.get("provider", "anthropic"),
                    "t": kept.get("t", 0), "kept": True}
    cur = current(key_file)
    provider, model = cur["provider"], cur["model"]
    if not cur["key"] and client is None:
        return {"error": "Add an API key to get the coach's take (Tools > AI coach)"}
    if not model:
        return {"error": "Pick a model for the coach (Tools > AI coach)"}
    if calls_today(notes_file=notes_file) >= DAILY_CAP:
        return {"error": f"Daily limit reached ({DAILY_CAP} calls a day). Try again tomorrow."}
    system = get_system_prompt()
    try:
        if provider == "anthropic":
            got = call_anthropic(model, cur["key"], system, brief, client=client)
        elif provider == "google":
            got = call_google(model, cur["key"], system, brief, http=http)
        elif provider == "openai":
            got = call_openai(model, cur["key"], system, brief, http=http)
        else:
            if not cur["baseUrl"]:
                return {"error": "Add the provider's API base URL (Tools > AI coach)"}
            got = call_openai(model, cur["key"], system, brief, base_url=cur["baseUrl"], http=http)
    except CoachError as e:
        return {"error": str(e)}
    if not got["text"].strip():
        return {"error": "The coach sent back nothing: try again later"}
    now = time.time()
    save_note({"session": session_str, "t": now, "provider": provider, "model": model, "brief": brief,
               "text": got["text"], "usage": got["usage"]}, notes_file=notes_file, lock=lock)
    return {"text": got["text"], "model": model, "provider": provider, "t": now, "kept": False}
