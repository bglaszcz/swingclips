# Stops the SwingClips server wherever it's running: in a window, or in the background where the
# auto-start task runs it (no window, nothing on the taskbar). It's found by the port it listens on.
param([int]$Port = 8000)

$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $conn) {
  Write-Host "The server isn't running (nothing is listening on port $Port)."
  exit 0
}

# The venv's python.exe is a launcher that starts the real one, under "Start server.cmd": walk up to
# the top of that chain so nothing is left behind (e.g. the script waiting at its "pause").
$top = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)"
while ($top) {
  $parent = Get-CimInstance Win32_Process -Filter "ProcessId = $($top.ParentProcessId)" -ErrorAction SilentlyContinue
  if (-not $parent) { break }
  $ours = $parent.Name -eq "python.exe" -or ($parent.Name -eq "cmd.exe" -and $parent.CommandLine -like "*Start server*")
  if (-not $ours) { break }
  $top = $parent
}

Write-Host "Stopping the server ($($top.Name), process $($top.ProcessId))..."
taskkill /f /t /pid $top.ProcessId | Out-Null
Start-Sleep -Milliseconds 500
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "It's still running. Try again from a Command Prompt opened with 'Run as administrator'."
  exit 1
}
Write-Host "Stopped."
