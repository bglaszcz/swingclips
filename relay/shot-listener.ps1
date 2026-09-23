# Stands in for GSPro: listens where GSPro Connect would (127.0.0.1:921), answers every message
# the way GSPro does, and logs each one with the time it arrived. Run via "Shot listener.cmd".
#
# First job: find out what Square's software sends, and when. Every message is saved to
# shots-<date>.jsonl next to this script, one JSON object per line, with the arrival time added.
#
# Protocol notes (GSPro Open Connect v1, https://gsprogolf.com/GSProConnectV1.html, and the
# client survey in PinPoint-Golf/libgspro docs/protocol.md):
#  - bare JSON objects back to back, no delimiter, so messages are split by counting braces;
#  - one reply per message, quickly: some connectors re-send a shot after 2 s without one;
#  - heartbeats and status updates get a 200 too.

param(
    [int]$Port = 921,
    [string]$LogDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

function Split-JsonObjects([System.Text.StringBuilder]$buf) {
    # Pulls every complete top-level {...} out of $buf (string-aware), leaving any partial tail.
    $text = $buf.ToString()
    $objects = New-Object System.Collections.Generic.List[string]
    $depth = 0; $inString = $false; $escape = $false; $start = -1; $consumed = 0
    for ($i = 0; $i -lt $text.Length; $i++) {
        $c = $text[$i]
        if ($inString) {
            if ($escape) { $escape = $false }
            elseif ($c -eq '\') { $escape = $true }
            elseif ($c -eq '"') { $inString = $false }
            continue
        }
        if ($c -eq '"') { $inString = $true }
        elseif ($c -eq '{') { if ($depth -eq 0) { $start = $i }; $depth++ }
        elseif ($c -eq '}' -and $depth -gt 0) {
            $depth--
            if ($depth -eq 0) { $objects.Add($text.Substring($start, $i - $start + 1)); $consumed = $i + 1 }
        }
    }
    if ($consumed -gt 0) { [void]$buf.Remove(0, $consumed) }
    # Anything before a '{' that never opened is noise (e.g. stray newlines).
    if ($depth -eq 0 -and $buf.Length -gt 0 -and $buf.ToString().Trim() -eq "") { [void]$buf.Clear() }
    return $objects
}

function Describe($msg) {
    $o = $msg.ShotDataOptions
    if ($o -and $o.IsHeartBeat -and -not $o.ContainsBallData) { return "heartbeat" }
    if ($o -and -not $o.ContainsBallData -and -not $o.ContainsClubData) {
        return "status (ready=$($o.LaunchMonitorIsReady), ball detected=$($o.LaunchMonitorBallDetected))"
    }
    $parts = @("SHOT #$($msg.ShotNumber)")
    if ($msg.BallData) {
        $b = $msg.BallData
        $parts += "ball $($b.Speed) $(if ($msg.Units) { $msg.Units } else { '' })".Trim()
        $parts += "launch $($b.VLA)/$($b.HLA) deg"
        $parts += "spin $($b.TotalSpin)"
        if ($b.CarryDistance) { $parts += "carry $($b.CarryDistance)" }
    }
    if ($msg.ClubData -and $o.ContainsClubData) {
        $c = $msg.ClubData
        $parts += "club $($c.Speed), path $($c.Path), face $($c.FaceToTarget), AoA $($c.AngleOfAttack)"
    }
    return ($parts -join " | ")
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try {
    $listener.Start()
} catch {
    Write-Host "Can't listen on port $Port - is GSPro (or another listener) already running? Close it and try again." -ForegroundColor Yellow
    exit 1
}
Write-Host "Listening on 127.0.0.1:$Port as if I were GSPro. Start Square's software now; Ctrl+C to stop." -ForegroundColor Green
Write-Host "Log: $(Join-Path $LogDir ("shots-" + (Get-Date -Format yyyy-MM-dd) + ".jsonl"))"

$reply = [System.Text.Encoding]::UTF8.GetBytes('{"Code":200,"Message":"Shot received successfully"}')

while ($true) {
    $client = $listener.AcceptTcpClient()
    $peer = $client.Client.RemoteEndPoint
    Write-Host ""
    Write-Host "$(Get-Date -Format HH:mm:ss) Connected: $peer" -ForegroundColor Cyan
    $stream = $client.GetStream()
    $bytes = New-Object byte[] 65536
    $buf = New-Object System.Text.StringBuilder
    try {
        while ($true) {
            $n = $stream.Read($bytes, 0, $bytes.Length)
            if ($n -le 0) { break }
            $received = Get-Date
            [void]$buf.Append([System.Text.Encoding]::UTF8.GetString($bytes, 0, $n))
            foreach ($json in (Split-JsonObjects $buf)) {
                # Reply first: the connector may be waiting on it.
                $stream.Write($reply, 0, $reply.Length)
                $stream.Flush()
                $logFile = Join-Path $LogDir ("shots-" + $received.ToString("yyyy-MM-dd") + ".jsonl")
                try {
                    $msg = $json | ConvertFrom-Json
                    $line = @{ received = $received.ToString("o"); message = $msg } | ConvertTo-Json -Depth 10 -Compress
                    Write-Host "$($received.ToString('HH:mm:ss.fff'))  $(Describe $msg)"
                } catch {
                    $line = @{ received = $received.ToString("o"); unparsed = $json } | ConvertTo-Json -Compress
                    Write-Host "$($received.ToString('HH:mm:ss.fff'))  (not valid JSON) $json" -ForegroundColor Yellow
                }
                Add-Content -Path $logFile -Value $line -Encoding UTF8
            }
        }
    } catch {
        Write-Host "Connection error: $($_.Exception.Message)" -ForegroundColor Yellow
    } finally {
        $client.Close()
        Write-Host "$(Get-Date -Format HH:mm:ss) Disconnected" -ForegroundColor Cyan
    }
}
