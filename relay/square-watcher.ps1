# Sends each shot you hit in Square Golf's own Windows app to the SwingClips server, so you can play
# Square's driving range and still get every swing clip tagged with its numbers. Run via
# "Square watcher.cmd" alongside Square's app.
#
# Square's app saves every shot to a local SQLite database (SQGDB.bytes). This only reads it - a
# quick read-only look whenever the file changes - using the SQLite built into Windows
# (winsqlite3.dll), so nothing needs installing. Shots carry no time of their own in there, so each
# is stamped with the moment it appears.
#
# Square's units and signs (checked against its CSV export): speeds m/s, distances m; direction,
# side, path and face negative = left; spin axis and side spin POSITIVE = left, so those two are
# flipped here to match GSPro's convention (positive = right).

param(
    [string]$Server = "http://192.168.86.250:8000",
    [string]$Database = (Join-Path $env:USERPROFILE "AppData\LocalLow\Invant\Square Golf\SQGDB.bytes"),
    [string]$LogDir = $PSScriptRoot
)

$ErrorActionPreference = "Stop"
$diagLog = Join-Path $LogDir "watcher-log.txt"

function Say([string]$text, [string]$color = "Gray") {
    Write-Host $text -ForegroundColor $color
    try { Add-Content -Path $diagLog -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff')  $text" -Encoding UTF8 } catch {}
}

Say "Square watcher starting (PowerShell $($PSVersionTable.PSVersion))"
trap {
    Say "STOPPED BY AN ERROR: $($_.Exception.Message)" "Red"
    Say "  at: $($_.InvocationInfo.PositionMessage -replace '\s+', ' ')" "Red"
    exit 1
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

// Just enough of SQLite (Windows' own copy) to run read-only queries.
public static class WinSqlite {
    const string Dll = "winsqlite3.dll";
    [DllImport(Dll)] static extern int sqlite3_open_v2(byte[] filename, out IntPtr db, int flags, IntPtr vfs);
    [DllImport(Dll)] static extern int sqlite3_close_v2(IntPtr db);
    [DllImport(Dll)] static extern int sqlite3_busy_timeout(IntPtr db, int ms);
    [DllImport(Dll)] static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int nBytes, out IntPtr stmt, IntPtr tail);
    [DllImport(Dll)] static extern int sqlite3_step(IntPtr stmt);
    [DllImport(Dll)] static extern int sqlite3_finalize(IntPtr stmt);
    [DllImport(Dll)] static extern int sqlite3_column_count(IntPtr stmt);
    [DllImport(Dll)] static extern IntPtr sqlite3_column_text(IntPtr stmt, int col);
    [DllImport(Dll)] static extern int sqlite3_column_bytes(IntPtr stmt, int col);
    [DllImport(Dll)] static extern IntPtr sqlite3_errmsg(IntPtr db);

    const int READONLY = 1, ROW = 100, DONE = 101;

    static byte[] Utf8z(string s) { return Encoding.UTF8.GetBytes(s + "\0"); }

    public static List<string[]> Query(string path, string sql) {
        IntPtr db;
        if (sqlite3_open_v2(Utf8z(path), out db, READONLY, IntPtr.Zero) != 0) {
            sqlite3_close_v2(db);
            throw new Exception("Can't open " + path);
        }
        try {
            sqlite3_busy_timeout(db, 2000);  // Square may be mid-write; wait briefly rather than fail
            IntPtr stmt;
            if (sqlite3_prepare_v2(db, Utf8z(sql), -1, out stmt, IntPtr.Zero) != 0)
                throw new Exception(Marshal.PtrToStringAnsi(sqlite3_errmsg(db)));
            var rows = new List<string[]>();
            try {
                int rc;
                while ((rc = sqlite3_step(stmt)) == ROW) {
                    int n = sqlite3_column_count(stmt);
                    var row = new string[n];
                    for (int i = 0; i < n; i++) {
                        IntPtr p = sqlite3_column_text(stmt, i);
                        if (p == IntPtr.Zero) continue;
                        var bytes = new byte[sqlite3_column_bytes(stmt, i)];
                        Marshal.Copy(p, bytes, 0, bytes.Length);
                        row[i] = Encoding.UTF8.GetString(bytes);
                    }
                    rows.Add(row);
                }
                if (rc != DONE) throw new Exception(Marshal.PtrToStringAnsi(sqlite3_errmsg(db)));
            } finally { sqlite3_finalize(stmt); }
            return rows;
        } finally { sqlite3_close_v2(db); }
    }
}
'@

# Square's club numbers -> the codes the rest of SwingClips uses. Worked out from your sessions'
# per-club shot counts; 23 (lob wedge) is inferred from the order and not yet seen.
$ClubCodes = @{ 0 = "DR"; 2 = "W3"; 9 = "H4"; 15 = "I5"; 16 = "I6"; 17 = "I7"; 18 = "I8"; 19 = "I9";
                20 = "PW"; 21 = "GW"; 22 = "SW"; 23 = "LW"; 24 = "PT" }

$MPH = 2.23694; $YD = 1.09361; $FT = 3.28084
# (Not "R": that name is taken by PowerShell's built-in alias for re-running history.)
function Round2([double]$v, [int]$d = 2) { [math]::Round($v, $d) }
# Square marks unreliable readings (e.g. no impact location) with IsValid* = false.
function V($obj, [string]$name, [double]$scale = 1) {
    $valid = $obj.PSObject.Properties["IsValid$name"]
    if ($valid -and -not $valid.Value) { return $null }
    return Round2 ($obj.$name * $scale)
}

function New-Shot($row, [datetime]$received) {
    $id, $session, $clubType, $mode, $shotJson, $resultJson, $clubJson, $sessionName = $row
    $s = $shotJson | ConvertFrom-Json
    $r = if ($resultJson) { $resultJson | ConvertFrom-Json } else { $null }
    $c = if ($clubJson) { $clubJson | ConvertFrom-Json } else { $null }
    $code = $ClubCodes[[int]$clubType]; if (-not $code) { $code = "club$clubType" }
    $axis = V $s "SpinAxis"; $sideSpin = V $s "SideSpin"
    $shot = [ordered]@{
        received = $received.ToString("o")
        source = "square-app"
        device = "Square Golf app"
        shotNumber = [int]$id
        session = $sessionName
        mode = $mode
        club = $code
        ball = [ordered]@{
            speed = V $s "Speed" $MPH; vla = V $s "Angle"; hla = V $s "Direction"
            totalSpin = V $s "SpinRate"; backSpin = V $s "BackSpin"
            sideSpin = $(if ($null -ne $sideSpin) { -$sideSpin }); spinAxis = $(if ($null -ne $axis) { -$axis })
            carry = $(if ($r) { Round2 ($r.CarryDistance * $YD) 1 }); total = $(if ($r) { Round2 ($r.TotalDistance * $YD) 1 })
            side = $(if ($r) { Round2 ($r.SideError * $YD) 1 }); apexFt = $(if ($r) { Round2 ($r.ApexHeight * $FT) 0 })
            landingAngle = $(if ($r) { Round2 $r.LandingAngle 1 })
        }
        clubData = $null
    }
    if ($c) {
        $shot.clubData = [ordered]@{
            speed = V $c "ClubSpeed" $MPH; smash = V $c "SmashFactor"
            angleOfAttack = V $c "AttackAngle"; faceToTarget = V $c "FaceAngle"; path = V $c "Path"
            loft = V $c "DynamicLoft"; faceImpactH = V $c "ImpactHorizontal"; faceImpactV = V $c "ImpactVertical"
        }
    }
    return $shot
}

$unsent = New-Object System.Collections.Generic.List[object]
function Send-Shot($shot) {
    if (-not $Server) { return $true }
    try {
        Invoke-RestMethod -Uri ($Server.TrimEnd('/') + "/api/shots") -Method Post -ContentType "application/json" `
            -Body ($shot | ConvertTo-Json -Depth 5 -Compress) -TimeoutSec 3 | Out-Null
        return $true
    } catch {
        $unsent.Add($shot)
        Say "         couldn't reach the server ($($_.Exception.Message)) - will retry" "Yellow"
        return $false
    }
}

# Every ~20 s: tell the server the watcher is alive, whether Square's app is open and when the last
# shot came (the review page's Ready panel shows it). Quiet if the server doesn't take it (older server).
$lastShotAt = $null
$lastBeat = [datetime]::MinValue
function Test-SquareRunning {
    [bool](Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -like "*Square*" -or ($_.MainWindowTitle -and $_.MainWindowTitle -like "*Square Golf*") })
}
function Send-Heartbeat {
    if (-not $Server) { return }
    $beat = [ordered]@{ source = "square-watcher"; squareRunning = (Test-SquareRunning)
                        lastShotAt = $lastShotAt; version = 1 }
    try {
        Invoke-RestMethod -Uri ($Server.TrimEnd('/') + "/api/relay/heartbeat") -Method Post -ContentType "application/json" `
            -Body ($beat | ConvertTo-Json -Compress) -TimeoutSec 3 | Out-Null
    } catch {}
}

if (-not (Test-Path -LiteralPath $Database)) {
    Say "Can't find Square's shot database at $Database. Has Square Golf's app been run on this PC?" "Yellow"
    exit 1
}
$last = [long]([WinSqlite]::Query($Database, "select ifnull(max(ShotID), 0) from IVShotLog")[0][0])
Say "Watching $Database" "Green"
Say "Newest shot already saved: #$last. Only shots after it are sent. Sending to $Server"
Say "Play in Square's app as usual. Close this window (or press Ctrl+C) to stop."

$files = @($Database, "$Database-journal", "$Database-wal")
function Stamp { ($files | ForEach-Object { if (Test-Path -LiteralPath $_) { (Get-Item -LiteralPath $_).LastWriteTimeUtc.Ticks } }) -join "," }
$seen = Stamp
$lastRetry = Get-Date

while ($true) {
    Start-Sleep -Milliseconds 500
    if (((Get-Date) - $lastBeat).TotalSeconds -ge 20) { $lastBeat = Get-Date; Send-Heartbeat }
    if ($unsent.Count -gt 0 -and ((Get-Date) - $lastRetry).TotalSeconds -gt 15) {
        $lastRetry = Get-Date
        $retry = @($unsent); $unsent.Clear()
        foreach ($s in $retry) { if (Send-Shot $s) { Say "         sent #$($s.shotNumber) (retry)" "DarkGray" } }
    }
    $now = Stamp
    if ($now -eq $seen) { continue }
    $seen = $now
    $received = Get-Date
    try {
        $rows = [WinSqlite]::Query($Database,
            "select l.ShotID, l.SessionID, l.ClubType, l.Mode, l.ShotData, l.ShotResult, l.ClubData, s.Name " +
            "from IVShotLog l left join IVSession s on s.SessionID = l.SessionID where l.ShotID > $last order by l.ShotID")
    } catch {
        Say "Couldn't read Square's database just now ($($_.Exception.Message)) - will try again" "Yellow"
        $seen = ""
        continue
    }
    foreach ($row in $rows) {
        $last = [long]$row[0]
        try { $shot = New-Shot $row $received } catch { Say "Skipped shot #$last (unreadable: $($_.Exception.Message))" "Yellow"; continue }
        $b = $shot.ball; $c = $shot.clubData
        $line = "{0}  #{1} {2}  ball {3} mph | launch {4} | spin {5} | carry {6} yd, total {7} yd" -f `
            $received.ToString("HH:mm:ss.fff"), $shot.shotNumber, $shot.club, $b.speed, $b.vla, $b.totalSpin, $b.carry, $b.total
        if ($c) { $line += " | club {0} mph, smash {1}" -f $c.speed, $c.smash }
        Say $line "White"
        Add-Content -Path (Join-Path $LogDir ("square-shots-" + $received.ToString("yyyy-MM-dd") + ".jsonl")) `
            -Value ($shot | ConvertTo-Json -Depth 5 -Compress) -Encoding UTF8
        $lastShotAt = $received.ToString("o")
        if (Send-Shot $shot) { Say "         sent to the server" "DarkGray" }
    }
}
