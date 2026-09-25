# One click on the sim laptop: opens Square Golf's app (if it isn't open) and the Square watcher in its
# own minimized window (if it isn't running), so a session starts with a double-click on
# "Start golf.cmd". Run with -Startup to also start this at every Windows sign-in.
#
# Square's app is found from its Start menu or desktop shortcut; if yours isn't found, put the full
# path of its shortcut or .exe in square-app.txt next to this file.

param([switch]$Startup)

$ErrorActionPreference = "Continue"
$here = $PSScriptRoot

if ($Startup) {
    $link = Join-Path ([Environment]::GetFolderPath("Startup")) "Start golf.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($link)
    $s.TargetPath = Join-Path $here "Start golf.cmd"
    $s.WorkingDirectory = $here
    $s.WindowStyle = 7   # minimized
    $s.Save()
    Write-Host "Added to Windows sign-in: $link (delete it to undo)." -ForegroundColor Green
}

# ---- Square Golf's app ----
function Find-SquareApp {
    $saved = Join-Path $here "square-app.txt"
    if (Test-Path -LiteralPath $saved) {
        $p = (Get-Content -LiteralPath $saved -TotalCount 1).Trim('" ')
        if ($p -and (Test-Path -LiteralPath $p)) { return $p }
    }
    $places = @(
        [Environment]::GetFolderPath("StartMenu"), [Environment]::GetFolderPath("CommonStartMenu"),
        [Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("CommonDesktopDirectory"))
    foreach ($place in $places) {
        if (-not $place -or -not (Test-Path -LiteralPath $place)) { continue }
        $hit = Get-ChildItem -LiteralPath $place -Recurse -Include "*Square Golf*.lnk", "*Square Golf*.url" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($hit) { return $hit.FullName }
    }
    return $null
}

$running = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ProcessName -like "*Square*" -or ($_.MainWindowTitle -and $_.MainWindowTitle -like "*Square Golf*") }
if ($running) {
    Write-Host "Square Golf's app is already open." -ForegroundColor Gray
} else {
    $app = Find-SquareApp
    if ($app) {
        Write-Host "Opening Square Golf's app ($app)" -ForegroundColor Green
        Start-Process -FilePath $app
    } else {
        Write-Host "Couldn't find Square Golf's app. Open it yourself, or put the path of its shortcut in $here\square-app.txt." -ForegroundColor Yellow
    }
}

# ---- The Square watcher ----
$watcher = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*square-watcher.ps1*" }
if ($watcher) {
    Write-Host "The Square watcher is already running." -ForegroundColor Gray
} else {
    # Square's app creates its shot database on first run: give it a moment when it was just opened.
    $db = Join-Path $env:USERPROFILE "AppData\LocalLow\Invant\Square Golf\SQGDB.bytes"
    for ($i = 0; $i -lt 30 -and -not (Test-Path -LiteralPath $db); $i++) { Start-Sleep -Seconds 1 }
    Write-Host "Starting the Square watcher (minimized window: 'Square watcher')" -ForegroundColor Green
    Start-Process -FilePath (Join-Path $here "Square watcher.cmd") -WorkingDirectory $here -WindowStyle Minimized
}
Write-Host "Ready: hit balls. The watcher's window shows each shot as it's sent." -ForegroundColor Green
