# One click on the sim laptop: opens Square Golf's app (if it isn't open), the Square watcher in its
# own minimized window (if it isn't running), and then starts both phones recording once they're
# connected to the server (open SwingClips on them first). Run with -Startup to also start this at
# every Windows sign-in, and with -NoCameras to leave the phones alone.
#
# Square's app is found from the Start menu's app list (which covers Microsoft Store apps too) or a
# shortcut; if yours isn't found, put the full path of its shortcut or .exe, or its Start menu app
# ID, in square-app.txt next to this file. Everything it does goes to start-golf-log.txt here too.

param([switch]$Startup, [switch]$NoCameras, [string]$Server = "http://192.168.86.250:8000")

$ErrorActionPreference = "Continue"
$here = $PSScriptRoot
$log = Join-Path $here "start-golf-log.txt"

function Say([string]$text, [string]$color = "Gray") {
    Write-Host $text -ForegroundColor $color
    try { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $text" -Encoding UTF8 } catch {}
}

Say "Start golf ($env:COMPUTERNAME, PowerShell $($PSVersionTable.PSVersion))"

if ($Startup) {
    $link = Join-Path ([Environment]::GetFolderPath("Startup")) "Start golf.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($link)
    $s.TargetPath = Join-Path $here "Start golf.cmd"
    $s.WorkingDirectory = $here
    $s.WindowStyle = 7   # minimized
    $s.Save()
    Say "Added to Windows sign-in: $link (delete it to undo)." "Green"
}

# ---- Square Golf's app ----
function Get-SquareProcess {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -like "*Square*" -or ($_.MainWindowTitle -and $_.MainWindowTitle -like "*Square*Golf*") }
}

# Returns @{kind = "path" | "appid"; value = ...} or $null.
function Find-SquareApp {
    $saved = Join-Path $here "square-app.txt"
    if (Test-Path -LiteralPath $saved) {
        $p = (Get-Content -LiteralPath $saved -TotalCount 1).Trim('" ')
        if ($p -and (Test-Path -LiteralPath $p)) { return @{ kind = "path"; value = $p } }
        if ($p) { return @{ kind = "appid"; value = $p } }
    }
    # The Start menu's app list: desktop and Microsoft Store apps alike.
    $apps = @()
    try { $apps = @(Get-StartApps | Where-Object { $_.Name -like "*Square*" }) } catch {}
    foreach ($a in $apps) { Say "  Start menu app: '$($a.Name)'  id: $($a.AppID)" "DarkGray" }
    $best = $apps | Where-Object { $_.Name -like "*Golf*" } | Select-Object -First 1
    if (-not $best) { $best = $apps | Select-Object -First 1 }
    if ($best) { return @{ kind = "appid"; value = $best.AppID } }
    $places = @(
        [Environment]::GetFolderPath("StartMenu"), [Environment]::GetFolderPath("CommonStartMenu"),
        [Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("CommonDesktopDirectory"))
    foreach ($place in $places) {
        if (-not $place -or -not (Test-Path -LiteralPath $place)) { continue }
        $hit = Get-ChildItem -LiteralPath $place -Recurse -Include "*Square*.lnk", "*Square*.url" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($hit) { return @{ kind = "path"; value = $hit.FullName } }
    }
    return $null
}

$running = Get-SquareProcess
if ($running) {
    Say "Square Golf's app is already open ($(($running | ForEach-Object ProcessName | Sort-Object -Unique) -join ', '))."
} else {
    $app = Find-SquareApp
    if (-not $app) {
        Say "Couldn't find Square Golf's app. Open it yourself this time; to fix it, put the path of its shortcut or .exe in $here\square-app.txt." "Yellow"
    } else {
        $before = @(Get-Process -ErrorAction SilentlyContinue | ForEach-Object Id)
        if ($app.kind -eq "appid") {
            Say "Opening Square Golf's app (Start menu app $($app.value))" "Green"
            Start-Process -FilePath "explorer.exe" -ArgumentList "shell:AppsFolder\$($app.value)"
        } else {
            Say "Opening Square Golf's app ($($app.value))" "Green"
            Start-Process -FilePath $app.value
        }
        # Note what it runs as, so the next start can tell it's already open.
        for ($i = 0; $i -lt 20 -and -not (Get-SquareProcess); $i++) { Start-Sleep -Seconds 1 }
        $new = Get-Process -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id -and $_.MainWindowTitle }
        if ($new) { Say "  new windows: $(($new | ForEach-Object { "$($_.ProcessName) '$($_.MainWindowTitle)'" }) -join '; ')" "DarkGray" }
    }
}

# ---- The Square watcher ----
$watcher = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*square-watcher.ps1*" }
if ($watcher) {
    Say "The Square watcher is already running."
} else {
    # Square's app creates its shot database on first run: give it a moment when it was just opened.
    $db = Join-Path $env:USERPROFILE "AppData\LocalLow\Invant\Square Golf\SQGDB.bytes"
    for ($i = 0; $i -lt 30 -and -not (Test-Path -LiteralPath $db); $i++) { Start-Sleep -Seconds 1 }
    Say "Starting the Square watcher (minimized window: 'Square watcher')" "Green"
    Start-Process -FilePath (Join-Path $here "Square watcher.cmd") -WorkingDirectory $here -WindowStyle Minimized
}

# ---- The phones ----
if ($NoCameras) {
    Say "Ready: start the phones from the review page ($Server)." "Green"
    exit 0
}
Say "Waiting for both phones (open SwingClips on them) ..."
$started = $false
for ($i = 0; $i -lt 40; $i++) {
    try {
        $st = Invoke-RestMethod -Uri ($Server.TrimEnd('/') + "/api/status") -TimeoutSec 3
        $face = $st.phones.face; $dtl = $st.phones.dtl
        $up = @($face, $dtl | Where-Object { $_ -and $_.connected })
        $rec = @($face, $dtl | Where-Object { $_ -and $_.recording })
        if ($rec.Count -ge 2) { Say "Both phones are already recording." "Green"; $started = $true; break }
        if ($up.Count -ge 2) {
            $r = Invoke-RestMethod -Uri ($Server.TrimEnd('/') + "/api/phones/command") -Method Post -ContentType "application/json" `
                -Body '{"action":"start","angle":"both"}' -TimeoutSec 5
            foreach ($x in $r.results) { Say "  $($x.angle): $(if ($x.error) { $x.error } else { 'start sent' })" }
            $started = $true
            break
        }
    } catch {
        if ($i -eq 0) { Say "  the server isn't answering yet ($($_.Exception.Message))" "Yellow" }
    }
    Start-Sleep -Seconds 3
}
if ($started) {
    Say "Ready: the phones say 'Recording'. Hit balls." "Green"
} else {
    Say "The phones didn't connect within 2 minutes: open SwingClips on them, then press Start both on the review page ($Server)." "Yellow"
}
