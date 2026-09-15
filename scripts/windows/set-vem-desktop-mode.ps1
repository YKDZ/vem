[CmdletBinding()]
param(
  [ValidateSet("enable", "disable")][string]$Mode = "enable",
  [string]$KioskUser = "VEMKiosk",
  [string]$DesktopFlagPath = "C:\ProgramData\VEM\kiosk\desktop-mode.flag",
  [string]$TaskName = "VEMDesktopModeOnce",
  [int]$ExpiresInMinutes = 0,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"

# Operator escape hatch for the shell-replaced kiosk. Run over SSH as admin.
#
#   enable  -> create the desktop flag and start explorer.exe inside the kiosk
#              user's interactive session so maintenance work can use the desktop
#   disable -> remove the flag and terminate that session's explorer again
#
# The kiosk shell holder watches the flag, so the desktop also comes back after a
# kiosk re-logon while the flag exists.

function Test-ShouldWrite([string]$Action) {
  if ($DryRun) {
    Write-Host ("what-if: " + $Action)
    return $false
  }
  return $true
}

function Get-KioskSessionId {
  $process = Get-Process -Name machine -ErrorAction SilentlyContinue |
    Sort-Object StartTime -Descending |
    Select-Object -First 1
  if ($null -ne $process) { return [int]$process.SessionId }
  $sessions = (quser 2>$null) -split "`n" | Where-Object { $_ -match [regex]::Escape($KioskUser) }
  foreach ($session in $sessions) {
    $columns = ($session -replace '\s+', ' ').Trim() -split ' '
    foreach ($column in $columns) {
      if ($column -match '^\d+$') { return [int]$column }
    }
  }
  return $null
}

$flagDirectory = Split-Path -Parent $DesktopFlagPath
if (-not (Test-Path -LiteralPath $flagDirectory)) {
  New-Item -ItemType Directory -Path $flagDirectory -Force | Out-Null
}

if ($Mode -eq "enable") {
  if (Test-ShouldWrite "create desktop mode flag $DesktopFlagPath") {
    Set-Content -LiteralPath $DesktopFlagPath -Value "enabled $(Get-Date -Format o)" -Encoding ASCII
    if ($ExpiresInMinutes -gt 0) {
      $expiry = (Get-Date).ToUniversalTime().AddMinutes($ExpiresInMinutes).ToString("o")
      Add-Content -LiteralPath $DesktopFlagPath -Value "expires=$expiry" -Encoding ASCII
    }
  }

  $action = New-ScheduledTaskAction -Execute (Join-Path $env:windir "explorer.exe")
  $principal = New-ScheduledTaskPrincipal -UserId $KioskUser -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
  if (Test-ShouldWrite "start explorer.exe in the kiosk session (task $TaskName)") {
    Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 5
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }

  $sessionId = Get-KioskSessionId
  Write-Output "desktop mode enabled (flag: $DesktopFlagPath, kiosk session: $sessionId)"
  Get-Process -Name explorer -ErrorAction SilentlyContinue |
    Select-Object Id, SessionId | Format-Table -AutoSize | Out-String -Width 80
} else {
  if (Test-Path -LiteralPath $DesktopFlagPath) {
    if (Test-ShouldWrite "remove desktop mode flag $DesktopFlagPath") {
      Remove-Item -LiteralPath $DesktopFlagPath -Force
    }
  }
  $sessionId = Get-KioskSessionId
  $targets = Get-Process -Name explorer -ErrorAction SilentlyContinue |
    Where-Object { $null -eq $sessionId -or [int]$_.SessionId -eq $sessionId }
  if (Test-ShouldWrite "stop explorer processes in kiosk session $sessionId") {
    foreach ($target in @($targets)) {
      Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue
    }
  }
  Write-Output "desktop mode disabled: flag removed, explorer stopped ($(@($targets).Count) process(es))"
}
