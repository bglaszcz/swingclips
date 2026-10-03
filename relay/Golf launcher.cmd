@echo off
rem Opens the golf launcher window (one button per kind of session). Double-click it; the window has
rem "Put an icon on the desktop" for next time.
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0golf-launcher.ps1" %*
