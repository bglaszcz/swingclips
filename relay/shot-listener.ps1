# Stands in for GSPro: listens where GSPro Connect would (127.0.0.1:921), answers every message
# the way GSPro does, and logs each one with the time it arrived. Run via "Shot listener.cmd".
#
# Every message is saved to shots-<date>.jsonl next to this script, one JSON object per line,
# with the arrival time added. Type a club code (DR, W3, H4, I7, PW, SW, PT, ...) and press Enter
# to change club, the way you would in GSPro.
#
# Protocol notes (GSPro Open Connect v1, https://gsprogolf.com/GSProConnectV1.html, and the
# client survey in PinPoint-Golf/libgspro docs/protocol.md):
#  - bare JSON objects back to back, no delimiter, so messages are split by counting braces;
#  - one reply per message, quickly: some connectors re-send a shot after 2 s without one;
#  - heartbeats and status updates get a 200 too;
#  - GSPro also sends player info (201: handedness, club, distance) and "GSPro ready" (202)
#    unprompted. Square's connector connects and reports LaunchMonitorIsReady=false until it
#    has had these, so they're sent after the first message on each connection.

param(
    [int]$Port = 921,
    [string]$LogDir = $PSScriptRoot,
    [string]$Club = "DR",
    [ValidateSet("RH", "LH")] [string]$Handed = "RH"
)

$ErrorActionPreference = "Stop"
$diagLog = Join-Path $LogDir "listener-log.txt"
$Clubs = @("DR", "W2", "W3", "W4", "W5", "W6", "W7", "H2", "H3", "H4", "H5", "H6", "H7",
           "I1", "I2", "I3", "I4", "I5", "I6", "I7", "I8", "I9", "PW", "GW", "SW", "LW", "PT")

function Say([string]$text, [string]$color = "Gray") {
    # To the window and to listener-log.txt, so a problem on the sim laptop can be read afterwards.
    Write-Host $text -ForegroundColor $color
    try { Add-Content -Path $diagLog -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')  $text" -Encoding UTF8 } catch {}
}

Say "Shot listener starting (PowerShell $($PSVersionTable.PSVersion), $([Environment]::OSVersion.VersionString))"
trap {
    Say "STOPPED BY AN ERROR: $($_.Exception.Message)" "Red"
    Say "  at: $($_.InvocationInfo.PositionMessage -replace '\s+', ' ')" "Red"
    exit 1
}

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
    $flags = "ready=$($o.LaunchMonitorIsReady), ball detected=$($o.LaunchMonitorBallDetected)"
    if ($o -and $o.IsHeartBeat) { return "heartbeat ($flags)" }
    $ballSpeed = if ($msg.BallData) { [double]$msg.BallData.Speed } else { 0 }
    if (-not $o -or (-not $o.ContainsBallData -and -not $o.ContainsClubData) -or $ballSpeed -eq 0) {
        return "status ($flags)"
    }
    $parts = @("SHOT #$($msg.ShotNumber)")
    $b = $msg.BallData
    $parts += "ball $($b.Speed) mph"
    $parts += "launch $($b.VLA)/$($b.HLA) deg"
    $parts += "spin $($b.TotalSpin)"
    if ($b.CarryDistance) { $parts += "carry $($b.CarryDistance)" }
    if ($msg.ClubData -and $o.ContainsClubData) {
        $c = $msg.ClubData
        $parts += "club $($c.Speed), path $($c.Path), face $($c.FaceToTarget), AoA $($c.AngleOfAttack)"
    }
    return ($parts -join " | ")
}

function Send-Json($stream, [string]$json) {
    $b = [System.Text.Encoding]::UTF8.GetBytes($json)
    $stream.Write($b, 0, $b.Length)
    $stream.Flush()
}

function Send-PlayerInfo($stream) {
    Send-Json $stream ('{"Code":201,"Message":"GSPro Player Information","Player":{"Handed":"' + $Handed +
        '","Club":"' + $script:Club + '","DistanceToTarget":200.0}}')
}

# Typed club codes, read a key at a time so waiting for shots never blocks on the keyboard.
$typed = ""
function Check-Keys($stream) {
    try { if (-not [Console]::KeyAvailable) { return } } catch { return }  # no console window
    while ([Console]::KeyAvailable) {
        $k = [Console]::ReadKey($true)
        if ($k.Key -eq "Enter") {
            $code = $script:typed.Trim().ToUpper()
            $script:typed = ""
            Write-Host ""
            if ($code -eq "") { continue }
            if ($Clubs -notcontains $code) {
                Say "Unknown club '$code'. Use one of: $($Clubs -join ' ')" "Yellow"
                continue
            }
            $script:Club = $code
            if ($stream) {
                Send-PlayerInfo $stream
                Say "Club changed to $code (sent to the launch monitor)" "Green"
            } else {
                Say "Club set to $code (will be sent when the launch monitor connects)" "Green"
            }
        } elseif ($k.Key -eq "Backspace") {
            if ($script:typed.Length -gt 0) { $script:typed = $script:typed.Substring(0, $script:typed.Length - 1); Write-Host -NoNewline "`b `b" }
        } elseif ($k.KeyChar -match '[A-Za-z0-9]') {
            $script:typed += $k.KeyChar
            Write-Host -NoNewline $k.KeyChar
        }
    }
}

$listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), $Port
try {
    $listener.Start()
} catch {
    Say "Can't listen on port $Port - is GSPro (or another listener) already running? Close it and try again." "Yellow"
    Say "  ($($_.Exception.Message))" "Yellow"
    exit 1
}
Say "Listening on 127.0.0.1:$Port as if I were GSPro." "Green"
Say "Shots will be saved to $(Join-Path $LogDir ("shots-" + (Get-Date -Format yyyy-MM-dd) + ".jsonl"))"
Say "Club: $Club ($Handed). To change club, type its code (DR W3 H4 I7 PW SW PT ...) and press Enter."

# Prove the listener works on this PC before blaming anything else: send ourselves one message.
# It connects into the listen queue now and is read by the loop below as the first connection.
$selfTest = New-Object System.Net.Sockets.TcpClient
$selfTest.Connect([System.Net.IPAddress]::Loopback, $Port)
$testBytes = [System.Text.Encoding]::UTF8.GetBytes('{"DeviceID":"self-test","ShotDataOptions":{"IsHeartBeat":true}}')
$selfTest.GetStream().Write($testBytes, 0, $testBytes.Length)
$selfTest.Close()

$reply = '{"Code":200,"Message":"Shot received successfully"}'
Say "Close this window (or press Ctrl+C) to stop."

while ($true) {
    # Wait in short naps rather than one blocking call, which Ctrl+C can't interrupt.
    while (-not $listener.Pending()) { Check-Keys $null; Start-Sleep -Milliseconds 200 }
    $client = $listener.AcceptTcpClient()
    $peer = $client.Client.RemoteEndPoint
    $isSelfTest = $false
    $greeted = $false
    $lastReady = $null
    $stream = $client.GetStream()
    $socket = $client.Client
    $bytes = New-Object byte[] 65536
    $buf = New-Object System.Text.StringBuilder
    try {
        while ($true) {
            # Same here: poll for up to 0.2 s at a time so Ctrl+C and typed clubs get a look in.
            Check-Keys $(if ($greeted) { $stream } else { $null })
            if (-not $socket.Poll(200000, [System.Net.Sockets.SelectMode]::SelectRead)) { continue }
            if ($socket.Available -eq 0) { break }  # readable with nothing to read = closed
            $n = $stream.Read($bytes, 0, $bytes.Length)
            if ($n -le 0) { break }
            $received = Get-Date
            [void]$buf.Append([System.Text.Encoding]::UTF8.GetString($bytes, 0, $n))
            foreach ($json in (Split-JsonObjects $buf)) {
                if ($json -match '"DeviceID":"self-test"') {
                    $isSelfTest = $true
                    Say "Self-test OK: the listener works on this PC. Now start Square's software and hit a ball." "Green"
                    continue
                }
                # Reply first: the connector may be waiting on it.
                Send-Json $stream $reply
                if (-not $greeted) {
                    Write-Host ""
                    Say "Launch monitor connected ($peer). Sending club $Club and 'ready', like GSPro does." "Cyan"
                    Send-PlayerInfo $stream
                    Send-Json $stream '{"Code":202,"Message":"GSPro ready"}'
                    $greeted = $true
                }
                $logFile = Join-Path $LogDir ("shots-" + $received.ToString("yyyy-MM-dd") + ".jsonl")
                try {
                    $msg = $json | ConvertFrom-Json
                    $line = @{ received = $received.ToString("o"); club = $Club; message = $msg } | ConvertTo-Json -Depth 10 -Compress
                    $ready = $msg.ShotDataOptions.LaunchMonitorIsReady
                    $what = Describe $msg
                    if ($what.StartsWith("SHOT")) {
                        Say "$($received.ToString('HH:mm:ss.fff'))  $what  [$Club]" "White"
                    } elseif ($ready -ne $lastReady) {
                        Say "$($received.ToString('HH:mm:ss.fff'))  launch monitor $(if ($ready) { 'READY' } else { 'not ready' }): $what" $(if ($ready) { "Green" } else { "Yellow" })
                    }
                    $lastReady = $ready
                } catch {
                    $line = @{ received = $received.ToString("o"); unparsed = $json } | ConvertTo-Json -Compress
                    Say "$($received.ToString('HH:mm:ss.fff'))  (not valid JSON) $json" "Yellow"
                }
                Add-Content -Path $logFile -Value $line -Encoding UTF8
            }
        }
    } catch {
        Say "Connection error: $($_.Exception.Message)" "Yellow"
    } finally {
        $client.Close()
        if (-not $isSelfTest) { Say "Launch monitor disconnected" "Cyan" }
    }
}
