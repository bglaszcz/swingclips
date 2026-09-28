@echo off
rem One click on the sim laptop, shots through Square's GSPro connector instead of Square's app:
rem starts the shot listener and opens SQG GSPro Connect, then starts both phones (see start-golf.ps1).
rem Close Square Golf's app first: the Omni takes one Bluetooth connection. "Start golf.cmd" is the usual setup.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-golf.ps1" -Source gspro %*
timeout /t 5 >nul
