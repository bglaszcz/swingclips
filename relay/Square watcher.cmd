@echo off
rem Sends each shot from Square Golf's own app to the SwingClips server. Run alongside Square's app.
echo Square watcher: starting from %~dp0
if not exist "%~dp0square-watcher.ps1" (
  echo.
  echo square-watcher.ps1 is missing. Put it in the same folder as this file and try again.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0square-watcher.ps1" %*
echo.
echo Square watcher stopped. If something went wrong, see watcher-log.txt in this folder.
pause
