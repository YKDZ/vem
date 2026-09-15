[CmdletBinding()]
param(
  [string]$DaemonServiceName = "VemVendingDaemon",
  [string]$MachineUiTaskName = "VEMMachineUI",
  [string]$VisionTaskName = "VEMVisionRuntime",
  [int]$VisionReadinessPort = 7892,
  [int]$VisionStartupGraceSeconds = 90,
  [string]$OwnerManifestPath = "C:\ProgramData\VEM\runtime-owners\owner-manifest.json",
  [string]$LogPath = "C:\ProgramData\VEM\runtime-owners\results\watchdog.log",
  [string]$DisableFlagPath = "C:\ProgramData\VEM\runtime-owners\watchdog.disabled",
  [string]$KioskUser = "VEMKiosk",
  [string]$KioskShellExpectationPath = "C:\ProgramData\VEM\kiosk\shell-expected.json",
  [string]$KioskShellScript = "C:\VEM\bringup\set-vem-kiosk-shell.ps1",
  [string]$DesktopModeScript = "C:\VEM\bringup\set-vem-desktop-mode.ps1",
  [string]$TailnetOfflineSincePath = "C:\ProgramData\VEM\kiosk\tailnet-offline-since.txt",
  [int]$TailnetOfflineGraceMinutes = 10,
  [switch]$DryRun,
  [int]$LogMaxBytes = 262144
)

$ErrorActionPreference = "Stop"

# The installed runtime owners are one-shot launchers: they start the canonical
# process, report readiness, and exit. A process that dies afterwards (camera
# failure, driver fault, external kill) would otherwise stay down until the next
# logon, which silently breaks Vision-dependent surfaces such as the maintenance
# camera panel and virtual try-on. This watchdog only starts owner tasks whose
# canonical process is missing; it never stops or replaces anything.

function Write-WatchdogLog {
  param([string]$Message)
  try {
    $directory = Split-Path -Parent $LogPath
    if (-not (Test-Path -LiteralPath $directory)) {
      New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -gt $LogMaxBytes) {
      $archive = "$LogPath.1"
      Move-Item -LiteralPath $LogPath -Destination $archive -Force
    }
    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'")
    Add-Content -LiteralPath $LogPath -Value "$timestamp $Message" -Encoding UTF8
  } catch {
    # A watchdog must never fail because it cannot write its own log.
  }
}

function Test-OwnerProcess([string]$Name) {
  return [bool](Get-Process -Name $Name -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Test-ShouldWrite([string]$Action) {
  if ($DryRun) {
    Write-Host ("what-if: " + $Action)
    return $false
  }
  return $true
}

function Get-TailnetOnlineState {
  $tailscale = "C:\Program Files\Tailscale\tailscale.exe"
  if (-not (Test-Path -LiteralPath $tailscale)) { return $null }
  $service = Get-Service -Name "Tailscale" -ErrorAction SilentlyContinue
  if ($null -ne $service -and $service.Status -ne "Running") { return $false }
  # The CLI can refuse to answer for a non-daemon caller, so only a positive
  # signal counts. A missing tailnet address is itself a confident offline sign.
  $tailnetAddresses = @(
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object { $_.IPAddress -like "100.*" }
  )
  if ($tailnetAddresses.Count -eq 0 -and $null -ne $service) { return $false }
  try {
    $json = & $tailscale status --json 2>$null | Out-String
    if ([string]::IsNullOrWhiteSpace($json)) { return $null }
    $status = $json | ConvertFrom-Json
    $propertyNames = @($status.PSObject.Properties.Name)
    if ($propertyNames -contains "Self") { return [bool]$status.Self.Online }
    if ($propertyNames -contains "BackendState") { return ([string]$status.BackendState -eq "Running") }
    return $null
  } catch {
    return $null
  }
}

function Get-TailnetEscapeDecision([object]$Online, [object]$OfflineSince, [int]$GraceMinutes, [datetime]$Now) {
  if ($null -eq $Online) { return "not-applicable" }
  if ($Online) { return "online" }
  if ($null -eq $OfflineSince) { return "arm" }
  if (($Now.ToUniversalTime() - ([datetime]$OfflineSince).ToUniversalTime()).TotalMinutes -lt $GraceMinutes) { return "wait" }
  return "escape"
}

function Invoke-KioskShellSelfHeal {
  if (-not (Test-Path -LiteralPath $KioskShellExpectationPath)) { return }
  if (-not (Test-Path -LiteralPath $KioskShellScript)) {
    Write-WatchdogLog "kiosk-shell-script-missing path=$KioskShellScript"
    return
  }
  $expected = $null
  try { $expected = Get-Content -LiteralPath $KioskShellExpectationPath -Raw | ConvertFrom-Json } catch { return }
  if ($null -eq $expected -or [string]::IsNullOrWhiteSpace([string]$expected.holderPath)) { return }
  if (-not (Get-Command -Name Get-LocalUser -ErrorAction SilentlyContinue)) { return }
  $user = Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue
  if ($null -eq $user) { return }
  $sid = [string]$user.SID
  if ($sid -notmatch '^S-\d-\d+(-\d+)+$') { return }
  $shell = $null
  try {
    $shell = (Get-ItemProperty -Path "Registry::HKEY_USERS\$sid\Software\Microsoft\Windows NT\CurrentVersion\Winlogon" -Name Shell -ErrorAction Stop).Shell
  } catch {
    return
  }
  if ("$shell" -match 'kiosk-shell-holder\.ps1') { return }
  if (-not (Test-ShouldWrite "re-apply kiosk shell for $KioskUser (current='$shell')")) { return }
  & $KioskShellScript -KioskUser $KioskUser -RuntimeDirectory (Split-Path -Parent ([string]$expected.holderPath)) | Out-Null
  Write-WatchdogLog "kiosk-shell-reapplied user=$KioskUser previous='$shell'"
}

function Invoke-TailnetOfflineEscape {
  $online = Get-TailnetOnlineState
  if ($null -eq $online) { return }

  $offlineSince = $null
  if (Test-Path -LiteralPath $TailnetOfflineSincePath) {
    $text = (Get-Content -LiteralPath $TailnetOfflineSincePath -Raw -ErrorAction SilentlyContinue).Trim()
    $parsed = [DateTime]::MinValue
    if ([DateTime]::TryParse($text, [ref]$parsed)) { $offlineSince = $parsed }
  }

  $decision = Get-TailnetEscapeDecision -Online $online -OfflineSince $offlineSince -GraceMinutes $TailnetOfflineGraceMinutes -Now (Get-Date)
  switch ($decision) {
    "online" {
      if (Test-Path -LiteralPath $TailnetOfflineSincePath) {
        if (Test-ShouldWrite "clear tailnet offline marker") {
          Remove-Item -LiteralPath $TailnetOfflineSincePath -Force -ErrorAction SilentlyContinue
          Write-WatchdogLog "tailnet-online"
        }
      }
    }
    "arm" {
      if (Test-ShouldWrite "record tailnet offline since $(Get-Date -Format o)") {
        [IO.File]::WriteAllText($TailnetOfflineSincePath, [DateTime]::UtcNow.ToString("o"), [Text.UTF8Encoding]::new($false))
        Write-WatchdogLog "tailnet-offline-armed"
      }
    }
    "escape" {
      if (-not (Test-Path -LiteralPath $DesktopModeScript)) {
        Write-WatchdogLog "tailnet-offline-desktop-script-missing path=$DesktopModeScript"
        return
      }
      if (-not (Test-ShouldWrite "enable local desktop because the tailnet is offline")) { return }
      & $DesktopModeScript -Mode enable -ExpiresInMinutes (2 * $TailnetOfflineGraceMinutes) | Out-Null
      Write-WatchdogLog "tailnet-offline-local-desktop minutes=$([int]((Get-Date).ToUniversalTime() - ([datetime]$offlineSince).ToUniversalTime()).TotalMinutes)"
    }
    default { return }
  }
}

function Get-VisionListenerProcess {
  $listener = Get-NetTCPConnection -LocalPort $VisionReadinessPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($null -eq $listener) { return $null }
  return Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
}

function Start-OwnerTask([string]$TaskName) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    Write-WatchdogLog "missing-task task=$TaskName"
    return $false
  }
  Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop
  Write-WatchdogLog "started-task task=$TaskName state=$($task.State)"
  return $true
}

if (Test-Path -LiteralPath $DisableFlagPath) {
  exit 0
}

$service = Get-Service -Name $DaemonServiceName -ErrorAction SilentlyContinue
if ($null -eq $service) {
  Write-WatchdogLog "missing-service name=$DaemonServiceName"
} elseif ($service.Status -ne "Running") {
  try {
    Start-Service -Name $DaemonServiceName
    Write-WatchdogLog "started-service name=$DaemonServiceName previous=$($service.Status)"
  } catch {
    Write-WatchdogLog "service-start-failed name=$DaemonServiceName error=$($_.Exception.Message)"
  }
}

if (-not (Test-OwnerProcess "machine")) {
  try { Start-OwnerTask $MachineUiTaskName | Out-Null } catch {
    Write-WatchdogLog "task-start-failed task=$MachineUiTaskName error=$($_.Exception.Message)"
  }
}

$visionListener = Get-VisionListenerProcess
if ($null -eq $visionListener) {
  # The readiness listener, not the process name, is the canonical liveness
  # signal: a killed main process can leave fork workers behind that would
  # otherwise look healthy while port 7892 stays closed.
  $workerProcesses = @(Get-Process -Name "vending-vision" -ErrorAction SilentlyContinue)
  $startingSince = (Get-Date).AddSeconds(-1 * $VisionStartupGraceSeconds)
  $startingProcesses = @($workerProcesses | Where-Object { $_.StartTime -gt $startingSince })
  if ($workerProcesses.Count -gt 0 -and $startingProcesses.Count -eq 0) {
    $staleCount = $workerProcesses.Count
    $workerProcesses | Stop-Process -Force -ErrorAction SilentlyContinue
    Write-WatchdogLog "vision-stale-orphans cleared=$staleCount"
    Start-Sleep -Seconds 2
  } elseif ($startingProcesses.Count -gt 0) {
    Write-WatchdogLog "vision-starting-in-progress processes=$($workerProcesses.Count)"
  }
  if ($startingProcesses.Count -eq 0) {
    try { Start-OwnerTask $VisionTaskName | Out-Null } catch {
      Write-WatchdogLog "task-start-failed task=$VisionTaskName error=$($_.Exception.Message)"
    }
  }
}

if (Test-Path -LiteralPath $OwnerManifestPath) {
  # Presence check only: a missing manifest means the runtime owners were never
  # installed on this host, which is an operator-visible installation problem.
  $null = Get-Content -LiteralPath $OwnerManifestPath -Raw
}

Invoke-KioskShellSelfHeal
Invoke-TailnetOfflineEscape
