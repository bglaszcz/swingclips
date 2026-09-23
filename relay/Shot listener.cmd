@echo off
rem Pretends to be GSPro so Square's software sends it shots; logs them next to this file.
echo Shot listener: starting from %~dp0
if not exist "%~dp0shot-listener.ps1" (
  echo.
  echo shot-listener.ps1 is missing. Put it in the same folder as this file and try again.
  pause
  exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0shot-listener.ps1" %*
echo.
echo Shot listener stopped. If something went wrong, see listener-log.txt in this folder.
pause
