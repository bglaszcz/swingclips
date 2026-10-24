# SwingClips

Home golf swing system: two Android phones (`capture/`) record 240 fps clips when they hear the
strike, a Windows home server (`server/`) analyzes them and serves the review page, and the sim
laptop (`relay/`) sends Square Omni shots that pair with each swing. Goal: a single-digit handicap.
README.md and HOME-SETUP.md (the session, setup, settings, troubleshooting) describe the system;
`docs/` has the details per part (phones, review page, scorecard, performance, club model, 3D, relay)
and `docs/key-positions.md` the key-position rules. Update the doc for the part you change.

## Rules

- Never hard-delete user data (clips, pose, labels, shots): move it to the trash.
- Never use `brentyates/squaregolf-connector` or reverse-engineer Square's Bluetooth (DMCA).
  Reading Square's app's local SQLite database is fine.
- `relay/` scripts run in Windows PowerShell 5.1: ASCII only, CRLF. A function named `R` is shadowed.
- Findings shown to the golfer need a fault name, drill and swing thought (`server/static/coach.js`),
  and never a fault the data doesn't show.
- Match the surrounding code: plain wording, the same comment density, no new frameworks. The
  review page is plain HTML/JS in `server/static/`, no build step.
- Keep the owner's defaults: Square app + watcher for shots, RTMPose-m body model, sound trigger,
  auto shutter.
- The phones, server and real clips can't be reached from a cloud session: say what wasn't checked.

## Tests (all must pass)

From `server/`, one command runs everything: the Python tests spread over worker processes, the page's
JavaScript tests and a check of the relay scripts (ASCII, and they parse in PowerShell 5.1). About a
minute; it prints only a summary, and the output of anything that fails:

```
.venv\Scripts\python.exe run_tests.py
```

`run_tests.py test_status` (or `test_status.Class`, `tests\x.test.js`) runs only those. The old commands
still work (`.venv\Scripts\python.exe -m unittest discover tests`, ~4 minutes in one process; `node --test
(Get-ChildItem tests\*.test.js).FullName`). New tests must pass on their own (each test is run in any
order, beside others: `run_tests.py --shuffle 1` checks). Changes in `capture/`: also its JVM tests
(README, "Dev PC": `gradle testDebugUnitTest`).

## Layout

| Folder | What |
|---|---|
| `server/` | FastAPI app (`app.py`), pose and club (`pose.py`, `club.py`), session status and practice voice (`status.py`, `practice.py`), tests in `tests/` |
| `server/static/` | The review page: `index.html` plus one JS file per feature, and `start.html` |
| `capture/` | Android capture app (Kotlin) |
| `relay/` | Sim laptop scripts (Square watcher, GSPro shot listener, `start-golf.ps1`) |
| `train/`, `tools/`, `docs/` | Club model training; dev tools; the details behind HOME-SETUP.md (one file per part) |
