@echo off
rem Stops the SwingClips server, including the one the auto-start task runs in the background.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-server.ps1" %*
pause
