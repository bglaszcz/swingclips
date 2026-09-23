@echo off
rem Pretends to be GSPro so Square's software sends it shots; logs them next to this file.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0shot-listener.ps1" %*
pause
