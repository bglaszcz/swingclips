# Finds where Square Golf's Windows app puts shot data, so SwingClips can pick it up while you play
# Square's own driving range. Run via "Find Square data.cmd" with Square's app open and connected.
#
# It notes every file in the usual app-data folders, asks you to hit a ball, then reports which
# files changed in that moment, what Square's app has open on the network, and (for text files
# that belong to Square's app) their last lines. The report goes to square-data-report.txt next
# to this script. Nothing is changed or sent anywhere.

param([string]$OutDir = $PSScriptRoot)

$ErrorActionPreference = "Continue"
$report = Join-Path $OutDir "square-data-report.txt"
$lines = New-Object System.Collections.Generic.List[string]
function Out([string]$text, [string]$color = "Gray") { Write-Host $text -ForegroundColor $color; $lines.Add($text) }

# Folders apps write to, plus wherever Square's app itself is installed.
$roots = @(
    $env:LOCALAPPDATA, $env:APPDATA, (Join-Path $env:USERPROFILE "AppData\LocalLow"),
    (Join-Path $env:USERPROFILE "Documents"), $env:ProgramData, $env:TEMP
) | Where-Object { $_ -and (Test-Path $_) }

$square = @(Get-Process | Where-Object { $_.ProcessName -match 'square' -or ($_.Path -and $_.Path -match 'square') })
foreach ($p in $square) { if ($p.Path) { $roots += (Split-Path $p.Path) } }
$roots = $roots | Select-Object -Unique

# Browser, Dropbox and system churn that changes all the time and is never shot data.
$noise = '\\(Google|Microsoft\\Edge|Mozilla|BraveSoftware|Dropbox|Packages|CrashDumps|D3DSCache|NVIDIA|AMD|Intel|Microsoft\\Windows|Windows Defender|Microsoft\\Office|OneDrive|Spotify|Discord|Steam)\\'

function Snapshot {
    $map = @{}
    foreach ($r in $roots) {
        Get-ChildItem -Path $r -Recurse -File -Force -ErrorAction SilentlyContinue |
            Where-Object { $_.FullName -notmatch $noise -and $_.FullName -notlike "$OutDir*" } |
            ForEach-Object { $map[$_.FullName] = "$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" }
    }
    return $map
}

Out "Square data finder - $(Get-Date)"
Out ""
if ($square.Count -eq 0) {
    Out "Square's app doesn't seem to be running. Open it, connect the Omni, go to the driving range, then run this again." "Yellow"
} else {
    Out "Square's app is running:" "Green"
    foreach ($p in $square) { Out "  $($p.ProcessName) (pid $($p.Id))  $($p.Path)" }
    Out ""
    Out "Network ports Square's app has open (a local port could be a data feed):"
    foreach ($p in $square) {
        $conns = Get-NetTCPConnection -OwningProcess $p.Id -ErrorAction SilentlyContinue
        foreach ($c in $conns) { Out "  TCP $($c.LocalAddress):$($c.LocalPort) -> $($c.RemoteAddress):$($c.RemotePort)  $($c.State)" }
        $udp = Get-NetUDPEndpoint -OwningProcess $p.Id -ErrorAction SilentlyContinue
        foreach ($u in $udp) { Out "  UDP $($u.LocalAddress):$($u.LocalPort)" }
        if (-not $conns -and -not $udp) { Out "  (none for $($p.ProcessName))" }
    }
}
Out ""
Out "Looking in: $($roots -join '; ')"
Write-Host "Taking a snapshot of those folders (can take a minute)..." -ForegroundColor Cyan
$before = Snapshot
Write-Host ""
Write-Host "Now hit ONE ball in Square's app. When its numbers are on screen, come back here and press Enter." -ForegroundColor Green
[void](Read-Host)
Write-Host "Looking for what changed..." -ForegroundColor Cyan
Start-Sleep -Seconds 2
$after = Snapshot

$changed = @()
foreach ($k in $after.Keys) {
    if (-not $before.ContainsKey($k)) { $changed += [pscustomobject]@{ Path = $k; What = "new" } }
    elseif ($before[$k] -ne $after[$k]) { $changed += [pscustomobject]@{ Path = $k; What = "changed" } }
}
Out ""
Out "Files that changed while you hit the ball: $($changed.Count)" "Green"
foreach ($c in ($changed | Sort-Object Path)) {
    $fi = Get-Item -LiteralPath $c.Path -Force -ErrorAction SilentlyContinue
    Out ("  [{0}] {1}  ({2:N0} bytes)" -f $c.What, $c.Path, $fi.Length)
}

# Show the end of changed text files that look like Square's (by path or name).
$textExt = '\.(log|txt|json|jsonl|csv|xml|ini|cfg)$'
$squareish = $changed | Where-Object { $_.Path -match '(?i)square' -and $_.Path -match $textExt }
$unityLog = $changed | Where-Object { $_.Path -match '(?i)\\AppData\\LocalLow\\.*\\Player(-prev)?\.log$' }
foreach ($c in @($squareish) + @($unityLog) | Select-Object -Unique Path) {
    Out ""
    Out "---- last 40 lines of $($c.Path)" "Cyan"
    Get-Content -LiteralPath $c.Path -Tail 40 -ErrorAction SilentlyContinue | ForEach-Object { Out "  $_" }
}

$lines | Set-Content -Path $report -Encoding UTF8
Write-Host ""
Write-Host "Report saved to $report" -ForegroundColor Green
