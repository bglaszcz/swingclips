# Stops the SwingClips server wherever it's running: in a window, or in the background where the
# auto-start task runs it (no window, nothing on the taskbar). It's found by the port it listens on,
# or, if it has already let go of the port (stuck shutting down), by its own Python in .venv.
param([int]$Port = 8000)

function Get-Proc($id) { Get-CimInstance Win32_Process -Filter "ProcessId = $id" -ErrorAction SilentlyContinue }

# The venv's python.exe is a launcher that starts the real one, under "Start server.cmd": walk up to
# the top of that chain so nothing is left behind (e.g. the script waiting at its "pause").
function Get-Top($proc) {
  while ($proc) {
    $parent = Get-Proc $proc.ParentProcessId
    if (-not $parent) { break }
    $ours = $parent.Name -eq "python.exe" -or ($parent.Name -eq "cmd.exe" -and $parent.CommandLine -like "*Start server*")
    if (-not $ours) { break }
    $proc = $parent
  }
  $proc
}

$found = @()
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($conn) { $found += Get-Proc $conn.OwningProcess }
$venv = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"
$found += Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath -ieq $venv }

$tops = $found | Where-Object { $_ } | ForEach-Object { Get-Top $_ } | Sort-Object ProcessId -Unique
if (-not $tops) {
  Write-Host "The server isn't running."
  exit 0
}
foreach ($top in $tops) {
  Write-Host "Stopping the server ($($top.Name), process $($top.ProcessId))..."
  taskkill /f /t /pid $top.ProcessId | Out-Null
}
Start-Sleep -Milliseconds 500
$left = Get-CimInstance Win32_Process -Filter "Name = 'python.exe'" | Where-Object { $_.ExecutablePath -ieq $venv }
if ($left -or (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
  Write-Host "It's still running. Try again from a Command Prompt opened with 'Run as administrator'."
  exit 1
}
Write-Host "Stopped."
