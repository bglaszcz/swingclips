@echo off
rem Starts the SwingClips server. Creates its Python environment on first run.
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (
  echo First run - setting up Python environment...
  py -3.13 -m venv .venv || goto :fail
)
.venv\Scripts\python.exe -m pip install -q --disable-pip-version-check -r requirements.txt || goto :fail
rem Local settings for this PC, e.g. "set SWINGCLIPS_POSE_BACKEND=rtmpose-m" (settings.cmd, not in git).
if exist settings.cmd call settings.cmd
.venv\Scripts\python.exe app.py
:fail
pause
