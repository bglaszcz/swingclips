@echo off
rem Sim laptop launcher agent for SwingClips: polls the server for launcher commands.
rem "Golf agent.cmd -Startup" adds it to Windows sign-in.
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Minimized -File "%~dp0golf-agent.ps1" %*
