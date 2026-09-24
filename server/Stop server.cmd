@echo off
rem Stops the SwingClips server, including the one the auto-start task runs in the background.
rem PowerShell gets no keyboard (< nul) so it can't leave this window's input in a bad state.
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0stop-server.ps1" %* < nul
rem Wait for a key only when double-clicked, so the result stays on screen; not from a prompt.
echo %cmdcmdline% | "%SystemRoot%\System32\find.exe" /i "%~nx0" > nul && pause
