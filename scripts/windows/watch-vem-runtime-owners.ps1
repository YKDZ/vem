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
