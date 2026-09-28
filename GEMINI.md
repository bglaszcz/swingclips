# SwingClips: notes for Gemini CLI

Home golf swing system: two Android phones record 240 fps clips when they hear the strike, a Windows
home server analyzes them (pose, club, key positions), and a sim laptop sends Square Omni launch
monitor shots that pair with each swing. The goal is a single-digit handicap (16.4 in Sept 2026).
**README.md** and **HOME-SETUP.md** describe the whole system as it stands; read them first.
`docs/key-positions.md` explains the key-position rules.

## How work is shared

Claude Code (in `D:\SwingClips-dev\swingclips`, branch `main`) is the one who merges. You work in
your own worktree, `D:\SwingClips-dev\swingclips-gemini`, on branch `gemini/work`:

1. Tasks are in `D:\SwingClips-dev\gemini-prompts.md` (outside the repo). Do the one you're given.
2. Start from the latest `main`: `git fetch origin; git rebase origin/main` (or merge) before you begin.
3. Commit on `gemini/work` with clear messages. **Don't push to `main`, don't open pull requests,
   don't force-push.** Claude merges, runs everything against the real clips, phones and server,
   and pushes.
4. When done, write a short summary at the end of your task in `gemini-prompts.md` under
   "Gemini's report": what changed, what you checked, anything left open or unsure.

Neither of you sees the phones, the server or the laptop from here in a live way; Claude checks
real clips and deploys.

## Rules (don't re-litigate)

- **Never hard-delete** user data (clips, pose, labels, shots): move to trash / the Recycle Bin.
- **Nothing DMCA'd**: never use github.com/brentyates/squaregolf-connector or reverse-engineer
  Square's Bluetooth protocol. Reading Square's app's local SQLite DB is fine.
- **Laptop scripts in `relay/`** run in Windows PowerShell 5.1: ASCII only (no smart quotes,
  dashes or emoji), CRLF when copied to Dropbox. A PS function named `R` is shadowed by an alias.
- Findings shown to the golfer need a fault name + drill + swing thought (`server/static/coach.js`),
  and never prescribe a fault the data doesn't show.
- Match the surrounding code: plain wording in comments and UI text, the same comment density,
  no new frameworks. The review page is plain HTML/JS in `server/static/` (no build step).
- Don't change defaults the owner chose (Square app + watcher is the default shot source; the GSPro
  connector is an option; RTMPose-m is the server's body model; sound trigger; auto shutter).

## Tests (all must pass before you say you're done)

```
cd server
..\..\swingclips\server\.venv\Scripts\python.exe -m unittest discover tests
node --test tests/compare.test.js tests/trust.test.js tests/goodshots.test.js
```

The Python venv lives in the main checkout (`D:\SwingClips-dev\swingclips\server\.venv`); use it
from the worktree by that path. The unittest run takes ~3 minutes. List the node test files by name
(`node --test tests/` fails on Windows). Some tests skip without GPU/videos; that's fine.

## Layout

| Folder | What |
|---|---|
| `server/` | FastAPI app (`app.py`), pose/club analysis (`pose.py`, `club.py`), status and practice voice (`status.py`, `practice.py`), tests in `server/tests/` |
| `server/static/` | The review page (`index.html` + one JS file per feature) and `start.html` |
| `capture/` | Android capture app (Kotlin); built and installed by Claude |
| `relay/` | Sim laptop scripts (Square watcher, GSPro shot listener, `start-golf.ps1`) |
| `train/` | Club model training |
| `docs/` | Key-position rules and evidence |
