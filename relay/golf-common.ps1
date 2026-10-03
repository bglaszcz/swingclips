# Shared helper functions for start-golf.ps1 and golf-agent.ps1.
# Compatible with Windows PowerShell 5.1 (ASCII only, CRLF line endings).

function Get-SquareProcess {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
        ($_.ProcessName -like "*Square*" -or ($_.MainWindowTitle -and $_.MainWindowTitle -like "*Square*Golf*")) -and
        $_.ProcessName -notlike "*GSPro*" -and $_.ProcessName -notlike "*Connect*" -and
        -not ($_.MainWindowTitle -like "*GSPro*" -or $_.MainWindowTitle -like "*Connect*")
    }
}

function Get-WatcherProcess {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*square-watcher.ps1*" }
}

function Get-ConnectorProcess {
    Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -like "*GSPro*" -or ($_.MainWindowTitle -and $_.MainWindowTitle -like "*GSPro*")
    }
}

function Get-ListenerProcess {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*shot-listener.ps1*" }
}

function Find-SquareApp([string]$baseDir = "") {
    if (-not $baseDir) { $baseDir = $PSScriptRoot }
    Find-App "square-app.txt" "*Square*" "*Golf*" "*GSPro*" $baseDir
}

function Find-ConnectorApp([string]$baseDir = "") {
    if (-not $baseDir) { $baseDir = $PSScriptRoot }
    Find-App "connector-app.txt" "*GSPro*" "*Connect*" "" $baseDir
}

function Find-App([string]$savedName, [string]$like, [string]$prefer, [string]$skip, [string]$baseDir = "") {
    if (-not $baseDir) { $baseDir = $PSScriptRoot }
    $saved = Join-Path $baseDir $savedName
    if (Test-Path -LiteralPath $saved) {
        $p = (Get-Content -LiteralPath $saved -TotalCount 1).Trim('" ')
        if ($p -and (Test-Path -LiteralPath $p)) { return @{ kind = "path"; value = $p } }
        if ($p) { return @{ kind = "appid"; value = $p } }
    }
    $apps = @()
    try { $apps = @(Get-StartApps | Where-Object { $_.Name -like $like -and -not ($skip -and $_.Name -like $skip) }) } catch {}
    $best = $apps | Where-Object { $_.Name -like $prefer } | Select-Object -First 1
    if (-not $best) { $best = $apps | Select-Object -First 1 }
    if ($best) { return @{ kind = "appid"; value = $best.AppID } }
    $places = @(
        [Environment]::GetFolderPath("StartMenu"), [Environment]::GetFolderPath("CommonStartMenu"),
        [Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("CommonDesktopDirectory"))
    foreach ($place in $places) {
        if (-not $place -or -not (Test-Path -LiteralPath $place)) { continue }
        # (Not -Include: with -LiteralPath, PowerShell 5.1 ignores it and returns the first folder.)
        $hit = Get-ChildItem -LiteralPath $place -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { ($_.Name -like "$like.lnk" -or $_.Name -like "$like.url") -and -not ($skip -and $_.Name -like $skip) } |
            Select-Object -First 1
        if ($hit) { return @{ kind = "path"; value = $hit.FullName } }
    }
    return $null
}

function Open-App($app, [string]$what, [switch]$DryRun) {
    if (-not $app) { return "No app found for $what" }
    if ($DryRun) { return "Would open $what ($($app.value))" }
    if ($app.kind -eq "appid") {
        Start-Process -FilePath "explorer.exe" -ArgumentList "shell:AppsFolder\$($app.value)"
    } else {
        Start-Process -FilePath $app.value
    }
    return "Opened $what"
}

function Start-SquareApp([string]$baseDir = "", [switch]$DryRun) {
    if (-not $baseDir) { $baseDir = $PSScriptRoot }
    if (Get-SquareProcess) { return "Square Golf app already open" }
    $app = Find-SquareApp $baseDir
    if (-not $app) { return "Couldn't find Square Golf app" }
    return Open-App $app "Square Golf app" -DryRun:$DryRun
}

function Stop-SquareApp([switch]$DryRun) {
    $procs = @(Get-SquareProcess)
    if ($DryRun) { return "Would stop $($procs.Count) Square Golf process(es)" }
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    return "Stopped $($procs.Count) Square Golf process(es)"
}

function Start-SquareWatcher([string]$baseDir = "", [switch]$DryRun) {
    if (-not $baseDir) { $baseDir = $PSScriptRoot }
    if (Get-WatcherProcess) { return "Square watcher already running" }
    if ($DryRun) { return "Would start Square watcher" }
    $cmd = Join-Path $baseDir "Square watcher.cmd"
    if (Test-Path -LiteralPath $cmd) {
        Start-Process -FilePath $cmd -WorkingDirectory $baseDir -WindowStyle Minimized
        return "Started Square watcher"
    }
    return "Square watcher.cmd not found"
}

function Stop-SquareWatcher([switch]$DryRun) {
    $procs = @(Get-WatcherProcess)
    if ($DryRun) { return "Would stop $($procs.Count) Square watcher process(es)" }
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }
    return "Stopped $($procs.Count) Square watcher process(es)"
}

function Start-GSProStack([string]$baseDir = "", [string]$server = "", [switch]$DryRun) {
    if (-not $baseDir) { $baseDir = $PSScriptRoot }
    if ($DryRun) { return "Would start GSPro connector and shot listener" }
    if (-not (Get-ListenerProcess)) {
        $lCmd = Join-Path $baseDir "Shot listener.cmd"
        if (Test-Path -LiteralPath $lCmd) {
            if ($server) {
                Start-Process -FilePath $lCmd -ArgumentList "-Server", $server -WorkingDirectory $baseDir
            } else {
                Start-Process -FilePath $lCmd -WorkingDirectory $baseDir
            }
        }
    }
    if (-not (Get-ConnectorProcess)) {
        $app = Find-ConnectorApp $baseDir
        if ($app) { [void](Open-App $app "Square GSPro connector" -DryRun:$DryRun) }
    }
    return "Started GSPro connector and shot listener"
}

function Stop-GSProStack([switch]$DryRun) {
    $cProcs = @(Get-ConnectorProcess)
    $lProcs = @(Get-ListenerProcess)
    if ($DryRun) { return "Would stop GSPro connector and shot listener" }
    foreach ($p in $cProcs) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch {}
    }
    foreach ($p in $lProcs) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }
    return "Stopped GSPro connector and shot listener"
}

function Get-ShotSource([string]$baseDir = "") {
    if (-not $baseDir) { $baseDir = $PSScriptRoot }
    $src = "square"
    $pick = Join-Path $baseDir "shot-source.txt"
    if (Test-Path -LiteralPath $pick) {
        $want = "$(Get-Content -LiteralPath $pick -TotalCount 1)".Trim().ToLower()
        if ($want -eq "square" -or $want -eq "gspro") { $src = $want }
    }
    return $src
}

function Set-ShotSource([string]$baseDir = "", [string]$newSource = "", [switch]$DryRun) {
    if (-not $baseDir) { $baseDir = $PSScriptRoot }
    if ($newSource -ne "square" -and $newSource -ne "gspro") {
        return "Invalid shot source: $newSource"
    }
    if ($DryRun) { return "Would switch shot source to $newSource" }
    $pick = Join-Path $baseDir "shot-source.txt"
    Set-Content -LiteralPath $pick -Value $newSource -Encoding ASCII
    return "Shot source set to $newSource"
}

# Brings this folder's scripts up to date from the server (GET /api/relay/files: name -> SHA-256), so
# nothing is copied by hand after an update. Only .ps1 / .cmd files the server lists; files only here
# are left alone. Returns the names it replaced (or would, with -DryRun); an empty list when the
# server can't be reached.
function Update-RelayFiles([string]$baseDir = "", [string]$server = "", [switch]$DryRun) {
    if (-not $baseDir) { $baseDir = $PSScriptRoot }
    if (-not $server) { $server = "http://192.168.86.250:8000" }
    $base = $server.TrimEnd('/') + "/api/relay/files"
    $listing = Invoke-RestMethod -Uri $base -TimeoutSec 5 -ErrorAction Stop
    $changed = @()
    foreach ($prop in $listing.files.PSObject.Properties) {
        $name = $prop.Name
        $want = "$($prop.Value)"
        if ($name -notmatch '^[A-Za-z0-9 ()._-]+\.(ps1|cmd)$') { continue }
        $local = Join-Path $baseDir $name
        if ((Test-Path -LiteralPath $local) -and (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash -eq $want) { continue }
        $changed += $name
        if ($DryRun) { continue }
        $tmp = "$local.download"
        Invoke-WebRequest -Uri ($base + "/" + [uri]::EscapeDataString($name)) -OutFile $tmp -UseBasicParsing -TimeoutSec 15 -ErrorAction Stop
        if ((Get-FileHash -LiteralPath $tmp -Algorithm SHA256).Hash -ne $want) {
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
            throw "$name came through damaged"
        }
        Move-Item -LiteralPath $tmp -Destination $local -Force
    }
    return ,$changed
}

function Open-StartPage([string]$server = "", [switch]$DryRun) {
    if (-not $server) { $server = "http://192.168.86.250:8000" }
    $url = $server.TrimEnd('/') + "/start"
    if ($DryRun) { return "Would open $url" }
    Start-Process $url
    return "Opened $url"
}

function Set-StartupShortcut([string]$linkName, [string]$targetCmd, [string]$baseDir = "") {
    if (-not $baseDir) { $baseDir = $PSScriptRoot }
    $link = Join-Path ([Environment]::GetFolderPath("Startup")) $linkName
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut($link)
    $s.TargetPath = Join-Path $baseDir $targetCmd
    $s.WorkingDirectory = $baseDir
    $s.WindowStyle = 7
    $s.Save()
    return $link
}
