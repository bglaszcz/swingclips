@echo off
rem Starts the SwingClips server. Creates its Python environment on first run.
cd /d "%~dp0"
rem Local settings for this PC, e.g. "set SWINGCLIPS_POSE_BACKEND=rtmpose-m" (settings.cmd, not in git).
rem First, since they can pick the packages: "set SWINGCLIPS_REQUIREMENTS=requirements-dml.txt" for a GPU.
if exist settings.cmd call settings.cmd
if not defined SWINGCLIPS_REQUIREMENTS set SWINGCLIPS_REQUIREMENTS=requirements.txt
if not exist .venv\Scripts\python.exe (
  echo First run - setting up Python environment...
  py -3.13 -m venv .venv || goto :fail
)
rem Only one ONNX Runtime package at a time: the CPU one, DirectML or CUDA (ort_package.py).
.venv\Scripts\python.exe ort_package.py "%SWINGCLIPS_REQUIREMENTS%" || goto :fail
.venv\Scripts\python.exe -m pip install -q --disable-pip-version-check -r "%SWINGCLIPS_REQUIREMENTS%" || goto :fail
.venv\Scripts\python.exe app.py
:fail
pause
