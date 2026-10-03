# The golf launcher for the sim laptop: a small window with one button per kind of session. Each
# starts only what that session needs (Square Golf's app and the Square watcher, or Square's GSPro
# connector and the shot listener, or nothing for no-ball drills), then opens the server's Start page.
# While the window is open, the golf agent (golf-agent.ps1) runs hidden too, so the Start page's
# launcher buttons work; closing the window stops it. Nothing starts at Windows sign-in.
#
# "Put an icon on the desktop" (shown until there is one) adds a "Golf" shortcut to this window.
# On opening it fetches any scripts in this folder that differ from the server's copy (Update-RelayFiles
# in golf-common.ps1) and, if there were any, opens the new launcher instead (-NoUpdate skips it).
# -DryRun only logs what each button would do; -SelfTest opens the window, presses every button in
# dry-run, prints the log and closes (for testing on another PC). Log: golf-launcher-log.txt here.

param([string]$Server = "http://192.168.86.250:8000", [switch]$DryRun, [switch]$SelfTest, [switch]$NoUpdate,
      [string]$Updated = "")

$ErrorActionPreference = "Continue"
$here = $PSScriptRoot
. (Join-Path $here "golf-common.ps1")
$log = Join-Path $here "golf-launcher-log.txt"
if ($SelfTest) { $DryRun = $true }
$script:message = $null

function Say([string]$text, [string]$color = "Gray") {
    try { Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')  $text" -Encoding UTF8 } catch {}
    if ($SelfTest) { Write-Host $text }
    if ($script:message) { $script:message.Text = $text; $script:message.Refresh() }
}

# ---- The golf agent, while the window is open ----
function Get-AgentProcess {
    Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*golf-agent.ps1*" }
}

function Start-Agent {
    if (Get-AgentProcess) { return }
    if ($DryRun) { Say "Would start the golf agent"; return }
    $agentArgs = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File",
                   "`"$(Join-Path $here 'golf-agent.ps1')`"", "-Server", $Server)
    Start-Process -FilePath "powershell.exe" -ArgumentList $agentArgs -WindowStyle Hidden
}

function Stop-Agent {
    foreach ($p in @(Get-AgentProcess)) {
        try { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue } catch {}
    }
}

# ---- The buttons ----
function Start-Range {
    Say "Driving range: starting Square Golf and the watcher..."
    if (Get-ConnectorProcess) { Say (Stop-GSProStack -DryRun:$DryRun) }   # one Bluetooth connection to the Omni
    Say (Set-ShotSource $here "square" -DryRun:$DryRun)
    Say (Start-SquareApp $here -DryRun:$DryRun)
    Say (Start-SquareWatcher $here -DryRun:$DryRun)
    Start-Agent
    Say (Open-StartPage $Server -DryRun:$DryRun)
    Say "Driving range ready: pick your session on the Start page."
}

function Start-GSPro {
    Say "GSPro connector: closing Square Golf, starting the connector and the shot listener..."
    if (Get-SquareProcess) { Say (Stop-SquareApp -DryRun:$DryRun) }        # the connector needs the Omni to itself
    if (Get-WatcherProcess) { Say (Stop-SquareWatcher -DryRun:$DryRun) }
    Say (Set-ShotSource $here "gspro" -DryRun:$DryRun)
    Say (Start-GSProStack $here $Server -DryRun:$DryRun)
    Start-Agent
    Say (Open-StartPage $Server -DryRun:$DryRun)
    Say "GSPro connector ready: pick your session on the Start page."
}

function Start-Drills {
    Say "Drills, no ball: nothing to start on the laptop."
    Start-Agent
    Say (Open-StartPage $Server -DryRun:$DryRun)
    Say "Pick your drills on the Start page."
}

function Close-Everything {
    Say "Closing everything..."
    if (Get-WatcherProcess) { Say (Stop-SquareWatcher -DryRun:$DryRun) }
    if ((Get-ConnectorProcess) -or (Get-ListenerProcess)) { Say (Stop-GSProStack -DryRun:$DryRun) }
    if (Get-SquareProcess) { Say (Stop-SquareApp -DryRun:$DryRun) }
    if (-not $DryRun) { Stop-Agent }
    Say "Everything closed."
}

# ---- The desktop icon ----
function Get-IconPath { Join-Path ([Environment]::GetFolderPath("Desktop")) "Golf.lnk" }

function Add-DesktopIcon {
    if ($DryRun) { Say "Would put a Golf icon on the desktop"; return }
    $shell = New-Object -ComObject WScript.Shell
    $s = $shell.CreateShortcut((Get-IconPath))
    $s.TargetPath = "powershell.exe"
    $s.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $here 'golf-launcher.ps1')`""
    $s.WorkingDirectory = $here
    $s.IconLocation = "$env:SystemRoot\System32\shell32.dll,137"
    $s.Description = "SwingClips golf launcher"
    $s.Save()
    Say "Added the Golf icon to the desktop."
}

# ---- Up to date with the server ----
if (-not $NoUpdate) {
    try {
        $got = Update-RelayFiles $here $Server -DryRun:$DryRun
        if ($got.Count -and $DryRun) {
            Say "Would update from the server: $($got -join ', ')"
        } elseif ($got.Count) {
            $names = $got -join ', '
            Say "Updated from the server: $names"
            $again = @("-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File",
                       "`"$PSCommandPath`"", "-Server", $Server, "-NoUpdate", "-Updated", "`"$names`"")
            Start-Process -FilePath "powershell.exe" -ArgumentList $again -WindowStyle Hidden
            exit
        }
    } catch {
        Say "Couldn't get newer scripts from the server: $($_.Exception.Message)"
    }
}

# ---- The window ----
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "SwingClips golf"
$form.StartPosition = "CenterScreen"
$form.ClientSize = New-Object System.Drawing.Size(460, 500)
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font("Segoe UI", 10)

$head = New-Object System.Windows.Forms.Label
$head.Text = "What are you doing today?"
$head.Font = New-Object System.Drawing.Font("Segoe UI", 15, [System.Drawing.FontStyle]::Bold)
$head.Location = New-Object System.Drawing.Point(20, 14)
$head.AutoSize = $true
$form.Controls.Add($head)

$y = 58
$buttons = @()
$choices = @(
    @{ text = "Driving range`nSquare Golf and the watcher"; act = "Start-Range" },
    @{ text = "GSPro connector`nInstead of Square Golf's app"; act = "Start-GSPro" },
    @{ text = "Drills, no ball`nNothing to start: just the Start page"; act = "Start-Drills" },
    @{ text = "Close everything`nSquare Golf, watcher, connector"; act = "Close-Everything" })
foreach ($c in $choices) {
    $btn = New-Object System.Windows.Forms.Button
    $btn.Text = $c.text
    $btn.Tag = $c.act
    $btn.Font = New-Object System.Drawing.Font("Segoe UI", 12)
    $btn.Location = New-Object System.Drawing.Point(20, $y)
    $btn.Size = New-Object System.Drawing.Size(420, 72)
    $btn.Add_Click({
        param($sender, $e)
        $form.UseWaitCursor = $true
        try { & $sender.Tag } catch { Say "Something went wrong: $($_.Exception.Message)" }
        $form.UseWaitCursor = $false
        Update-State
    })
    $form.Controls.Add($btn)
    $buttons += $btn
    $y += 82
}

$state = New-Object System.Windows.Forms.Label
$state.Location = New-Object System.Drawing.Point(20, ($y + 2))
$state.Size = New-Object System.Drawing.Size(420, 22)
$state.ForeColor = [System.Drawing.Color]::DimGray
$form.Controls.Add($state)

$script:message = New-Object System.Windows.Forms.Label
$script:message.Location = New-Object System.Drawing.Point(20, ($y + 26))
$script:message.Size = New-Object System.Drawing.Size(420, 40)
$form.Controls.Add($script:message)

$icon = New-Object System.Windows.Forms.LinkLabel
$icon.Text = "Put an icon on the desktop"
$icon.Location = New-Object System.Drawing.Point(20, ($y + 70))
$icon.AutoSize = $true
$icon.Visible = -not (Test-Path -LiteralPath (Get-IconPath))
$icon.Add_LinkClicked({ Add-DesktopIcon; $icon.Visible = $false })
$form.Controls.Add($icon)

function OnOff($x) { if ($x) { "on" } else { "off" } }

function Update-State {
    $state.Text = "Square Golf " + (OnOff (Get-SquareProcess)) + "  -  watcher " + (OnOff (Get-WatcherProcess)) +
        "  -  connector " + (OnOff (Get-ConnectorProcess)) + "  -  Start page link " + (OnOff (Get-AgentProcess))
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 3000
$timer.Add_Tick({ Update-State })
$form.Add_Shown({
    Update-State
    $timer.Start()
    if ($Updated) {
        $note = "Scripts updated from the server: $Updated."
        if ((Get-WatcherProcess) -and $Updated -like "*square-watcher*") { $note += " To restart the watcher: Close everything, then Driving range." }
        Say $note
    }
    if ($SelfTest) {
        foreach ($b in $buttons) { $b.PerformClick() }
        Add-DesktopIcon
        Write-Host "State: $($state.Text)"
        $form.Close()
    }
})
$form.Add_FormClosed({ $timer.Stop(); if (-not $DryRun) { Stop-Agent } })
Say "Golf launcher ($env:COMPUTERNAME), server $Server$(if ($DryRun) { ', dry run' })"
[void]$form.ShowDialog()
