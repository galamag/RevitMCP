<#
.SYNOPSIS
  Closes Revit safely, rebuilds and deploys the plugin, starts Revit and waits until the plugin is up.

.DESCRIPTION
  1. If Revit is running: `npm run revit:can-close` must pass (every open document saved in
     %USERPROFILE%\Documents\RevitMCP, or none open), otherwise the script stops and Revit is left alone.
  2. Revit is closed with CloseMainWindow, once, and given 60 s to exit. If it does not exit, the script
     stops and reports. It never kills the process (no Stop-Process, no taskkill).
  3. `dotnet build RevitMCP.sln -p:DeployToRevit=true`. A failed build stops the script.
  4. Revit is started and the script waits up to 120 s for a connection.json written by the new process.

  When Revit is not running, steps 1 and 2 are skipped.
  The RevitInstallDir environment variable overrides C:\Program Files\Autodesk\Revit 2027.
  The connection token is never printed.

.EXAMPLE
  powershell -File scripts\restart-revit.ps1
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$CloseTimeoutSeconds = 60
$StartTimeoutSeconds = 120

function Stop-Script([string]$Message) {
    Write-Host "restart-revit: STOPPED. $Message" -ForegroundColor Red
    exit 1
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$installDir = if ($env:RevitInstallDir) { $env:RevitInstallDir } else { 'C:\Program Files\Autodesk\Revit 2027' }
$revitExe = Join-Path $installDir 'Revit.exe'
$connectionFile = Join-Path $env:LOCALAPPDATA 'RevitMCP\connection.json'

if (-not (Test-Path -LiteralPath $revitExe)) {
    Stop-Script "Revit.exe was not found at $revitExe. Set RevitInstallDir to the Revit install folder."
}

# 1-2. Close a running Revit, but only when that loses no work.
$running = @(Get-Process -Name 'Revit' -ErrorAction SilentlyContinue)

if ($running.Count -gt 1) {
    Stop-Script "$($running.Count) Revit processes are running (ids: $($running.Id -join ', ')). can-close checks only one of them, so close them yourself."
}

if ($running.Count -eq 1) {
    $revit = $running[0]
    Write-Host "restart-revit: Revit is running (process $($revit.Id)); checking that it can be closed."

    Push-Location (Join-Path $repoRoot 'src\server')
    try {
        & npm.cmd run revit:can-close
        $canCloseExit = $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
    if ($canCloseExit -ne 0) {
        Stop-Script "can-close exited with code $canCloseExit, so Revit was NOT closed. Save the open documents in $env:USERPROFILE\Documents\RevitMCP, or close Revit yourself."
    }

    Write-Host 'restart-revit: closing Revit with CloseMainWindow.'
    if (-not $revit.CloseMainWindow()) {
        Stop-Script 'Revit has no main window that accepts a close request. It was not closed.'
    }

    if (-not $revit.WaitForExit($CloseTimeoutSeconds * 1000)) {
        Stop-Script "Revit did not exit within $CloseTimeoutSeconds s (a dialog may be open). It is still running; the script never kills it. Look at the Revit window."
    }
    Write-Host 'restart-revit: Revit has exited.'
}
else {
    Write-Host 'restart-revit: Revit is not running; skipping the close step.'
}

# 3. Build and deploy the plugin while Revit does not hold its files.
Write-Host 'restart-revit: building and deploying the plugin.'
Push-Location $repoRoot
try {
    & dotnet build RevitMCP.sln -p:DeployToRevit=true
    $buildExit = $LASTEXITCODE
}
finally {
    Pop-Location
}
if ($buildExit -ne 0) {
    Stop-Script "dotnet build failed with code $buildExit. Revit was not started."
}

# 4. Start Revit and wait for the new plugin to announce itself.
Write-Host "restart-revit: starting $revitExe."
$started = Start-Process -FilePath $revitExe -PassThru
$deadline = (Get-Date).AddSeconds($StartTimeoutSeconds)

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2

    if ($started.HasExited) {
        Stop-Script "The new Revit process $($started.Id) exited with code $($started.ExitCode) before the plugin came up."
    }

    if (Test-Path -LiteralPath $connectionFile) {
        try {
            $info = Get-Content -LiteralPath $connectionFile -Raw | ConvertFrom-Json
            if ([int]$info.pid -eq $started.Id -and [int]$info.port -gt 0) {
                Write-Host "restart-revit: DONE. Revit process $($started.Id) is up; the plugin listens on port $($info.port)."
                exit 0
            }
        }
        catch {
            # The file may be half written or left over; read it again on the next round.
        }
    }
}

Stop-Script "No connection.json from process $($started.Id) appeared within $StartTimeoutSeconds s. Revit may still be loading, or the plugin failed to start; check for a dialog."
