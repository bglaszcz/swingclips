@echo off
rem Finds where Square Golf's app writes shot data. Open Square's app on the driving range first.
echo Square data finder: starting from %~dp0
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0find-square-data.ps1" %*
pause
