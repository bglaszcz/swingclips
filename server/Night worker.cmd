@echo off
rem The night worker (night_worker.py): on a PC with an NVIDIA graphics card, analyzes the server's clips
rem again with bigger models while nobody is hitting balls. Creates its Python environment on first run
rem (.venv-gpu, CUDA through pip, ~1 GB) and downloads the whole-body model (the club model comes from the server). Runs until closed.
rem Extra arguments go to the worker, e.g. "Night worker.cmd" --hours 23-7
cd /d "%~dp0"
if not exist .venv-gpu\Scripts\python.exe (
  echo First run - setting up the Python environment for the graphics card...
  py -3.13 -m venv .venv-gpu || goto :fail
)
.venv-gpu\Scripts\python.exe -m pip install -q --disable-pip-version-check -r requirements-cuda.txt || goto :fail
.venv-gpu\Scripts\python.exe fetch_models.py rtmw || goto :fail
.venv-gpu\Scripts\python.exe night_worker.py %*
:fail
pause
