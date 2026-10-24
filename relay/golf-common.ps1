# Shared helper functions for start-golf.ps1 and golf-agent.ps1.
# Compatible with Windows PowerShell 5.1 (ASCII only, CRLF line endings).

# ---- Finding the server ----
# The server's address can change (a new router, another subnet: in Oct 2026 it moved from 192.168.86.250
# to 192.168.7.250), so these scripts look for it: the address given (-Server), else the one that worked
# last time (server.txt next to these scripts), else $DefaultServer; when none of those answers, a look
# round each network this laptop is on, the last address's and $HomeNetworks (where the server lives:
# other subnets and VLANs reach it through the router), host $ServerHost first on each, then the rest.
# What's found goes in server.txt. The phones (ServerFinder.kt) and the night worker (server/findserver.py)
# look the same way. The server is whatever answers GET /api/time with {"ms": ...} (and app "swingclips").
$DefaultServer = "http://192.168.7.250:8000"
$HomeNetworks = @("192.168.7")
$ServerHost = 250
$ServerPort = 8000
# For the scripts that run for hours (Step-SwingServer): since when the server hasn't answered, and how
# long (s) to go without it before looking round again.
$SwingServerState = @{ downSince = $null; wait = 60 }

function Test-SwingServer([string]$url, [int]$timeoutSec = 2) {
    if (-not $url) { return $false }
    try {
        $r = Invoke-RestMethod -Uri ($url.TrimEnd('/') + "/api/time") -TimeoutSec $timeoutSec -ErrorAction Stop
        return ($null -ne $r) -and ($null -ne $r.ms) -and ($r.ms -is [ValueType]) -and -not ($r.ms -is [bool]) -and
            (-not $r.app -or $r.app -eq "swingclips")
    } catch {
        return $false
    }
}

function Get-NetworkOf([string]$address) {
    # "192.168.7" from "http://192.168.7.250:8000" or "192.168.7.250"; nothing for a name.
    if ($address -match '^(?:https?://)?(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}(?::\d+)?/?$') { return $Matches[1] }
    return $null
}

function Get-PortOf([string]$url) {
    if ($url -match '^(?:https?://)?[^/:]+:(\d+)') { return [int]$Matches[1] }
    return $ServerPort
}

function Get-LocalNetworks {
    # The networks of this PC's IPv4 addresses (not loopback, nor 169.254: no answer from DHCP).
    $out = @()
    try {
        foreach ($a in @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop)) {
            $n = Get-NetworkOf "$($a.IPAddress)"
            if ($n -and $n -notlike "127.*" -and $n -notlike "169.254*") { $out += $n }
        }
    } catch {}
    return @($out | Select-Object -Unique)
}

function Find-SwingServerOn([string[]]$networks, [int]$port = $ServerPort) {
    # Host $ServerHost of each network first, then every other one: the first that answers as the server.
    $first = @($networks | ForEach-Object { "$_.$ServerHost" })
    $rest = @(foreach ($n in $networks) { foreach ($i in 1..254) { if ($i -ne $ServerHost) { "$n.$i" } } })
    foreach ($ips in @($first, $rest)) {
        # Every address at once (a closed or empty one just doesn't connect), then the open ones asked.
        $tries = @(foreach ($ip in $ips) {
            $c = New-Object System.Net.Sockets.TcpClient
            [pscustomobject]@{ ip = $ip; c = $c; t = $c.ConnectAsync($ip, $port) }
        })
        $until = (Get-Date).AddMilliseconds(1500)
        while ((Get-Date) -lt $until -and @($tries | Where-Object { -not $_.t.IsCompleted }).Count) { Start-Sleep -Milliseconds 100 }
        $open = @($tries | Where-Object { $_.t.IsCompleted -and -not $_.t.IsFaulted -and $_.c.Connected } | ForEach-Object { $_.ip })
        foreach ($x in $tries) { try { $x.c.Close() } catch {} }
        foreach ($ip in $open) {
            $url = "http://${ip}:$port"
            if (Test-SwingServer $url) { return $url }
        }
    }
    return $null
}

function Save-SwingServer([string]$file, [string]$url) {
    try {
        $was = if (Test-Path -LiteralPath $file) { "$(Get-Content -LiteralPath $file -TotalCount 1)".Trim() } else { "" }
        if ($was -ne $url) { Set-Content -LiteralPath $file -Value $url -Encoding ASCII }
    } catch {}
}

# The server's address (see above). An address given is used as it is (and kept, once it answers).
function Resolve-SwingServer([string]$given = "", [string]$baseDir = "") {
    if (-not $baseDir) { $baseDir = $PSScriptRoot }
    $file = Join-Path $baseDir "server.txt"
    if ($given) {
        $given = $given.TrimEnd('/')
        if (Test-SwingServer $given) { Save-SwingServer $file $given }
        return $given
    }
    $last = ""
    if (Test-Path -LiteralPath $file) { $last = "$(Get-Content -LiteralPath $file -TotalCount 1)".Trim().TrimEnd('/') }
    foreach ($url in @(@($last, $DefaultServer) | Where-Object { $_ } | Select-Object -Unique)) {
        if (Test-SwingServer $url) { Save-SwingServer $file $url; return $url }
    }
    $from = if ($last) { $last } else { $DefaultServer }
    $nets = @(@(Get-NetworkOf $from) + @(Get-LocalNetworks) + $HomeNetworks | Where-Object { $_ } | Select-Object -Unique)
    $found = Find-SwingServerOn $nets (Get-PortOf $from)
    if ($found) {
        Save-SwingServer $file $found
        return $found
    }
    return $from
}

# For a script that runs for hours: each try's outcome; after a minute without the server it's looked
# for again (it may have moved). Found nowhere else, it's off rather than moved: the next look waits twice
# as long, up to 10 minutes (a look round holds the script up a few seconds). Returns the address to use.
function Step-SwingServer([string]$current, [bool]$reached, [string]$baseDir = "") {
    if ($reached) { $SwingServerState.downSince = $null; $SwingServerState.wait = 60; return $current }
    if (-not $SwingServerState.downSince) { $SwingServerState.downSince = Get-Date; return $current }
    if (((Get-Date) - $SwingServerState.downSince).TotalSeconds -lt $SwingServerState.wait) { return $current }
    $SwingServerState.downSince = Get-Date
    $found = Resolve-SwingServer "" $baseDir
    if ($found -eq $current) { $SwingServerState.wait = [math]::Min(600, 2 * $SwingServerState.wait) }
    return $found
}

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

function Start-SquareWatcher([string]$baseDir = "", [string]$server = "", [switch]$DryRun) {
    if (-not $baseDir) { $baseDir = $PSScriptRoot }
    if (Get-WatcherProcess) { return "Square watcher already running" }
    if ($DryRun) { return "Would start Square watcher" }
    $cmd = Join-Path $baseDir "Square watcher.cmd"
    if (Test-Path -LiteralPath $cmd) {
        # The server it sends to, as the caller has it (before, the watcher always used its own default).
        if ($server) {
            Start-Process -FilePath $cmd -ArgumentList "-Server", $server -WorkingDirectory $baseDir -WindowStyle Minimized
        } else {
            Start-Process -FilePath $cmd -WorkingDirectory $baseDir -WindowStyle Minimized
        }
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
    $said = @()
    if (Get-ListenerProcess) {
        $said += "shot listener already running"
    } else {
        $lCmd = Join-Path $baseDir "Shot listener.cmd"
        if (Test-Path -LiteralPath $lCmd) {
            if ($server) {
                Start-Process -FilePath $lCmd -ArgumentList "-Server", $server -WorkingDirectory $baseDir
            } else {
                Start-Process -FilePath $lCmd -WorkingDirectory $baseDir
            }
            $said += "started the shot listener"
        } else {
            $said += "Shot listener.cmd not found"
        }
    }
    if (Get-ConnectorProcess) {
        $said += "connector already open"
    } else {
        $app = Find-ConnectorApp $baseDir
        if ($app) {
            [void](Open-App $app "Square GSPro connector" -DryRun:$DryRun)
            $said += "opened the GSPro connector"
        } else {
            $said += "couldn't find the GSPro connector (put its path in connector-app.txt)"
        }
    }
    return "GSPro: " + ($said -join ", ")
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
    if (-not $server) { $server = Resolve-SwingServer }
    $base = $server.TrimEnd('/') + "/api/relay/files"
    $listing = Invoke-RestMethod -Uri $base -TimeoutSec 5 -ErrorAction Stop
    $changed = @()
    foreach ($prop in $listing.files.PSObject.Properties) {
        $name = $prop.Name
        $want = "$($prop.Value)"
        if ($name -notmatch '^[A-Za-z0-9 ()._-]+\.(ps1|cmd)$') { continue }
        $local = Join-Path $baseDir $name
        if ((Test-Path -LiteralPath $local) -and (Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash -eq $want) { continue }
        # cmd reads a batch file by position as it runs: one whose window is open is left for next time.
        if (($name -eq "Square watcher.cmd" -and (Get-WatcherProcess)) -or ($name -eq "Shot listener.cmd" -and (Get-ListenerProcess))) { continue }
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

# $do picks what the Start page shows (start.html ?do=: hit, plan, program, game, noball).
# Ends the session on the server: both phones stop recording (on their next poll), and a drill, game or
# plan block still running ends, saved as it stands (POST /api/session/close).
function Stop-PhoneRecording([string]$server = "", [switch]$DryRun) {
    if (-not $server) { $server = Resolve-SwingServer }
    if ($DryRun) { return "Would stop the phones recording and end what's running" }
    try {
        $r = Invoke-RestMethod -Uri ($server.TrimEnd('/') + "/api/session/close") -Method Post -ContentType "application/json" `
            -Body '{}' -TimeoutSec 5 -ErrorAction Stop
        $bad = @($r.results | Where-Object { $_.error })
        $said = if ($bad.Count) { "Phones: " + (($bad | ForEach-Object { "$($_.angle): $($_.error)" }) -join "; ") } else { "Phones told to stop recording" }
        if (@($r.ended).Count) { $said += "; ended " + (@($r.ended) -join ", ") }
        return $said
    } catch {
        return "Couldn't reach the server to stop the phones: $($_.Exception.Message)"
    }
}

function Open-StartPage([string]$server = "", [switch]$DryRun, [string]$do = "") {
    if (-not $server) { $server = Resolve-SwingServer }
    $url = $server.TrimEnd('/') + "/start"
    if ($do) { $url += "?do=" + $do }
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
