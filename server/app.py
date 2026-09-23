"""SwingClips home server: lists the clips in CLIPS_DIR and serves them to any browser on the LAN.

Run with "Start server.cmd", or:  .venv\\Scripts\\python.exe app.py
Settings (environment variables): SWINGCLIPS_CLIPS (clips folder), SWINGCLIPS_PORT (default 8000).
"""
import os
import re
from datetime import datetime
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse

CLIPS_DIR = Path(os.environ.get("SWINGCLIPS_CLIPS", r"D:\SwingClips\clips"))
PORT = int(os.environ.get("SWINGCLIPS_PORT", "8000"))
STATIC_DIR = Path(__file__).parent / "static"
VIDEO_TYPES = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}

# Probe clips end in _<unix seconds>.mp4, e.g. c0_1920x1080_240_hs_1789123456.mp4
UNIX_TIME_SUFFIX = re.compile(r"_(\d{10})$")

app = FastAPI(title="SwingClips")


def recorded_at(path: Path) -> float:
    """When the clip was recorded: from its filename if it carries a timestamp, else file mtime.

    Clips copied off the phone with adb get the copy time as mtime, so the name is more accurate.
    """
    m = UNIX_TIME_SUFFIX.search(path.stem)
    return float(m.group(1)) if m else path.stat().st_mtime


@app.get("/api/clips")
def list_clips():
    if not CLIPS_DIR.is_dir():
        raise HTTPException(503, f"Clips folder not found: {CLIPS_DIR}")
    clips = []
    for p in CLIPS_DIR.iterdir():
        if p.is_file() and p.suffix.lower() in VIDEO_TYPES:
            t = recorded_at(p)
            clips.append({
                "name": p.name,
                "size": p.stat().st_size,
                "recorded": datetime.fromtimestamp(t).isoformat(timespec="seconds"),
                "_t": t,
            })
    clips.sort(key=lambda c: c.pop("_t"), reverse=True)
    return clips


@app.get("/clips/{name}")
def get_clip(name: str):
    # Only plain filenames of videos directly inside CLIPS_DIR - no paths.
    path = CLIPS_DIR / name
    if Path(name).name != name or path.suffix.lower() not in VIDEO_TYPES or not path.is_file():
        raise HTTPException(404, "No such clip")
    # FileResponse handles Range requests, which browsers need to seek in a video.
    return FileResponse(path, media_type=VIDEO_TYPES[path.suffix.lower()])


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


if __name__ == "__main__":
    print(f"Serving clips from {CLIPS_DIR}")
    print(f"Open http://localhost:{PORT} here, or http://<this PC's name>:{PORT} from other devices")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
