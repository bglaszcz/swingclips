@echo off
rem Copies Square Golf's local database next to this file, to check whether shots can be read from it.
rem Only copies; Square's own file is left untouched.
set "SRC=%USERPROFILE%\AppData\LocalLow\Invant\Square Golf\SQGDB.bytes"
if not exist "%SRC%" (
  echo Can't find %SRC%
  pause
  exit /b 1
)
copy /y "%SRC%" "%~dp0SQGDB-copy.bytes"
echo.
echo Copied to %~dp0SQGDB-copy.bytes
pause
