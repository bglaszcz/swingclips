# Background launcher agent for the sim laptop.
# Runs minimized at Windows sign-in (or started via Golf agent.cmd).
# Reports what is running on the sim laptop to SwingClips server and executes queued launcher commands.
# Compatible with Windows PowerShell 5.1 (ASCII only, CRLF line endings).

param(
    [switch]$Startup,
    [switch]$DryRun,
    [switch]$Once,
    [string]$Server = "http://192.168.86.250:8000"
)

$ErrorActionPreference = "Continue"
$here = $PSScriptRoot
. (Join-Path $here "golf-common.ps1")
$log = Join-Path $here "golf-agent-log.txt"

function Say([string]$text, [string]$color = "Gray") {
    Write-Host $text -ForegroundColor $color
    try { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $text" -Encoding UTF8 } catch {}
}

Say "Golf agent ($env:COMPUTERNAME, PowerShell $($PSVersionTable.PSVersion)), server: $Server" $(if ($DryRun) { "Yellow" } else { "Gray" })
if ($DryRun) { Say "DryRun mode enabled: actions will be logged without execution" "Yellow" }

if ($Startup) {
    $link = Set-StartupShortcut "Golf agent.lnk" "Golf agent.cmd" $here
    Say "Added to Windows sign-in: $link (delete it to undo)." "Green"
}

$lastAction = ""
$lastResult = ""

while ($true) {
    $sq = [bool](Get-SquareProcess)
    $watcher = [bool](Get-WatcherProcess)
    $connector = [bool](Get-ConnectorProcess)
    $listener = [bool](Get-ListenerProcess)
    $src = Get-ShotSource $here

    $payload = @{
        squareRunning = $sq
        watcherRunning = $watcher
        connectorRunning = $connector
        listenerRunning = $listener
        source = $src
        version = "1.0"
        computer = $env:COMPUTERNAME
        lastAction = $lastAction
        lastResult = $lastResult
    }
    $json = ConvertTo-Json $payload -Compress

    $waitSec = if ($Once) { "0" } else { "15" }
    $url = $Server.TrimEnd('/') + "/api/relay/agent?wait=" + $waitSec
    $resp = $null
    try {
        $resp = Invoke-RestMethod -Uri $url -Method Post -ContentType "application/json" -Body $json -TimeoutSec 25
    } catch {
        Say "Server poll failed: $($_.Exception.Message)" "Yellow"
        if ($Once) { break }
        Start-Sleep -Seconds 5
        continue
    }

    if ($resp -and $resp.commands) {
        foreach ($c in $resp.commands) {
            $act = $c.action
            $cid = $c.id
            Say "Received command [$cid]: $act" "Cyan"
            $res = ""
            if ($act -eq "start_square") {
                $res = Start-SquareApp $here -DryRun:$DryRun
            } elseif ($act -eq "stop_square") {
                $res = Stop-SquareApp -DryRun:$DryRun
            } elseif ($act -eq "start_watcher") {
                $res = Start-SquareWatcher $here -DryRun:$DryRun
            } elseif ($act -eq "stop_watcher") {
                $res = Stop-SquareWatcher -DryRun:$DryRun
            } elseif ($act -eq "switch_source") {
                $targetSrc = $c.source
                if (-not $targetSrc) {
                    $targetSrc = if ($src -eq "square") { "gspro" } else { "square" }
                }
                $res = Set-ShotSource $here $targetSrc -DryRun:$DryRun
            } elseif ($act -eq "start_gspro") {
                $res = Start-GSProStack $here $Server -DryRun:$DryRun
            } elseif ($act -eq "stop_gspro") {
                $res = Stop-GSProStack -DryRun:$DryRun
            } elseif ($act -eq "open_start") {
                $res = Open-StartPage $Server -DryRun:$DryRun
            } else {
                $res = "Rejected unknown action: $act"
            }
            Say "Command [$cid] result: $res" "Green"
            $lastAction = $act
            $lastResult = $res
        }
    }

    if ($Once) { break }
    Start-Sleep -Milliseconds 200
}
