@echo off
rem One click on the sim laptop: opens Square Golf's app and the Square watcher (see start-golf.ps1).
rem "Start golf.cmd -Startup" also adds it to Windows sign-in; "-NoCameras" leaves the phones alone.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-golf.ps1" %*
timeout /t 5 >nul
