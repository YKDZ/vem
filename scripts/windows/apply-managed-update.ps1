# VEM Managed Machine Update
#
# Applies daemon and/or machine UI artifacts from a local manifest or direct
# single-component parameters. This is the normal first-pilot update path on
# the Windows host; SSH remains emergency access for recovery and evidence
# collection.
#
# Manifest example:
# {
#   "updateId": "2026-06-27-local",
#   "components": [
#     {
#       "component": "daemon",
#       "artifactPath": "C:\\VEM\\updates\\vending-daemon.exe",
#       "sha256": "...",
#       "targetPath": "C:\\VEM\\bringup\\vending-daemon.exe"
#     },
#     {
#       "component": "ui",
#       "artifactPath": "C:\\VEM\\updates\\machine.exe",
#       "sha256": "...",
#       "targetPath": "C:\\VEM\\bringup\\machine.exe"
#     }
#   ]
# }

[CmdletBinding()]
param(
  [string]$ManifestPath,
  [ValidateSet("daemon", "ui")]
  [string]$Component,
  [string]$ArtifactPath,
  [string]$Sha256,
  [string]$TargetPath,

  [string]$EvidencePath,
  [string]$BackupRoot = "C:\VEM\bringup\managed-update-backups",
  [string]$DaemonServiceName = "VemVendingDaemon",
  [string]$MachineUiTaskName = "VEMMachineUI",
  [ValidateSet("auto", "scheduledTask", "directProcess")]
  [string]$UiLaunchMode = "auto",
  [string]$DaemonReadyFile = "C:\ProgramData\VEM\vending-daemon\daemon-ready.json",
  [int]$HealthTimeoutSeconds = 30,
  [int]$HealthPollSeconds = 2
)

$ErrorActionPreference = "Stop"

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session"
  }
}

function Ensure-Directory {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Normalize-Sha256 {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "sha256 is required"
  }
  $normalized = $Value.Trim().ToLowerInvariant()
  if ($normalized -notmatch "^[0-9a-f]{64}$") {
    throw "sha256 must be 64 hex characters"
  }
  return $normalized
}

function Get-DefaultTargetPath {
  param([string]$Component)

  if ($Component -eq "daemon") {
    return "C:\VEM\bringup\vending-daemon.exe"
  }
  if ($Component -eq "ui") {
    return "C:\VEM\bringup\machine.exe"
  }
  throw "component must be daemon or ui"
}

function Normalize-WindowsPath {
  param([string]$Path)
  return $Path.Trim().TrimEnd("\").ToLowerInvariant()
}

function Assert-AllowedTargetPath {
  param(
    [string]$Component,
    [string]$TargetPath
  )

  $allowed = Get-DefaultTargetPath -Component $Component
  $normalizedTarget = Normalize-WindowsPath -Path $TargetPath
  $normalizedAllowed = Normalize-WindowsPath -Path $allowed
  if ($normalizedTarget -ne $normalizedAllowed) {
    if ($Component -eq "daemon") {
      throw "targetPath for daemon must be C:\VEM\bringup\vending-daemon.exe"
    }
    throw "targetPath for ui must be C:\VEM\bringup\machine.exe"
  }
  return $allowed
}

function Assert-Sha256 {
  param(
    [string]$Path,
    [string]$ExpectedSha256
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "artifact not found: $Path"
  }
  $expected = Normalize-Sha256 -Value $ExpectedSha256
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "hash mismatch for $Path; expected $expected got $actual"
  }
  return $actual
}

function New-BackupPath {
  param(
    [string]$Component,
    [string]$TargetPath,
    [string]$BackupRoot
  )

  Ensure-Directory -Path $BackupRoot
  $timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  $leaf = Split-Path -Leaf $TargetPath
  return Join-Path $BackupRoot "$Component-$timestamp-$leaf.bak"
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "file not found: $Path"
  }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Get-ReadyEndpointUrl {
  param(
    $Ready,
    [string]$PropertyName
  )

  $endpoint = [string]$Ready.$PropertyName
  if ([string]::IsNullOrWhiteSpace($endpoint)) {
    throw "$PropertyName missing from ready file"
  }
  if (-not [System.Uri]::IsWellFormedUriString($endpoint, [System.UriKind]::Absolute)) {
    throw "invalid $PropertyName`: $endpoint"
  }
  return $endpoint
}

function Test-DaemonHealth {
  param(
    [string]$ReadyFile,
    [int]$TimeoutSeconds,
    [int]$PollSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  do {
    try {
      $ready = Read-JsonFile -Path $ReadyFile
      $healthzUrl = Get-ReadyEndpointUrl -Ready $ready -PropertyName "healthzUrl"
      $readyzUrl = Get-ReadyEndpointUrl -Ready $ready -PropertyName "readyzUrl"
      $headers = @{ Authorization = ("Bearer " + $ready.ipcToken) }
      $health = Invoke-RestMethod -Method Get -Uri $healthzUrl -Headers $headers -TimeoutSec 5
      $readyz = Invoke-RestMethod -Method Get -Uri $readyzUrl -Headers $headers -TimeoutSec 5
      return [pscustomobject]@{
        ok = $true
        readyFile = $ReadyFile
        healthzUrl = $healthzUrl
        readyzUrl = $readyzUrl
        healthzOk = $true
        readyzOk = $true
        status = $health.status
        mode = $readyz.mode
        blockingCodes = @($readyz.blockingCodes)
        readyzStatus = $readyz.status
        backendOnline = $health.backendOnline
        mqttConnected = $health.mqttConnected
        hardwareOnline = $health.hardwareOnline
        scannerOnline = $health.scannerOnline
      }
    } catch {
      $lastError = $_.Exception.Message
      Start-Sleep -Seconds $PollSeconds
    }
  } while ((Get-Date) -lt $deadline)

  return [pscustomobject]@{
    ok = $false
    readyFile = $ReadyFile
    healthzOk = $false
    readyzOk = $false
    error = $lastError
  }
}

function Get-ExactMachineProcess {
  param([string]$TargetPath)

  $normalizedTarget = Normalize-WindowsPath -Path $TargetPath
  return Get-Process machine -ErrorAction SilentlyContinue |
    Where-Object {
      -not [string]::IsNullOrWhiteSpace($_.Path) -and
      (Normalize-WindowsPath -Path $_.Path) -eq $normalizedTarget
    }
}

function Get-MachineUiTask {
  try {
    return Get-ScheduledTask -TaskName $MachineUiTaskName -ErrorAction Stop
  } catch {
    return $null
  }
}

function Resolve-UiLaunchMode {
  if ($UiLaunchMode -eq "scheduledTask") {
    if ($null -eq (Get-MachineUiTask)) {
      throw "VEMMachineUI scheduled task not found and -UiLaunchMode scheduledTask was requested"
    }
    return "scheduledTask"
  }
  if ($UiLaunchMode -eq "directProcess") {
    return "directProcess"
  }
  if ($null -ne (Get-MachineUiTask)) {
    return "scheduledTask"
  }
  return "directProcess"
}

function Test-UiHealth {
  param(
    [string]$TargetPath,
    [string]$ExpectedSha256,
    [string]$LaunchMode,
    [int]$TimeoutSeconds,
    [int]$PollSeconds
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $lastError = $null
  do {
    try {
      $targetSha256 = Assert-Sha256 -Path $TargetPath -ExpectedSha256 $ExpectedSha256
      $process = Get-ExactMachineProcess -TargetPath $TargetPath | Select-Object -First 1
      if ($null -ne $process) {
        return [pscustomobject]@{
          ok = $true
          launchMode = $LaunchMode
          processId = $process.Id
          processName = $process.ProcessName
          path = $process.Path
          targetPath = $TargetPath
          targetSha256 = $targetSha256
        }
      }
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Seconds $PollSeconds
  } while ((Get-Date) -lt $deadline)

  return [pscustomobject]@{
    ok = $false
    launchMode = $LaunchMode
    targetPath = $TargetPath
    targetSha256 = if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
      (Get-FileHash -LiteralPath $TargetPath -Algorithm SHA256).Hash.ToLowerInvariant()
    } else {
      $null
    }
    error = if ([string]::IsNullOrWhiteSpace($lastError)) { "machine.exe process for $TargetPath not observed after UI restart" } else { $lastError }
  }
}

function Stop-ComponentForReplace {
  param(
    [string]$Component,
    [string]$TargetPath
  )

  if ($Component -eq "daemon") {
    Stop-Service -Name $DaemonServiceName -Force -ErrorAction Stop
    return
  }

  Stop-ScheduledTask -TaskName $MachineUiTaskName -ErrorAction SilentlyContinue
  Get-ExactMachineProcess -TargetPath $TargetPath | Stop-Process -Force
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $runningProcess = Get-ExactMachineProcess -TargetPath $TargetPath |
      Select-Object -First 1
    if ($null -eq $runningProcess) {
      return
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  throw "machine.exe still running after stop request: $TargetPath"
}

function Restart-DaemonComponent {
  Restart-Service -Name $DaemonServiceName -Force -ErrorAction Stop
}

function Restart-UiComponent {
  param([string]$TargetPath)

  $launchMode = Resolve-UiLaunchMode
  Stop-ScheduledTask -TaskName $MachineUiTaskName -ErrorAction SilentlyContinue
  Get-ExactMachineProcess -TargetPath $TargetPath | Stop-Process -Force
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $runningProcess = Get-ExactMachineProcess -TargetPath $TargetPath |
      Select-Object -First 1
    if ($null -eq $runningProcess) {
      break
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  if ($launchMode -eq "scheduledTask") {
    Start-ScheduledTask -TaskName $MachineUiTaskName -ErrorAction Stop
  } else {
    Start-Process -FilePath $TargetPath -WorkingDirectory (Split-Path -Parent $TargetPath) | Out-Null
  }

  return [pscustomobject]@{
    launchMode = $launchMode
    targetPath = $TargetPath
  }
}

function Restart-Component {
  param(
    [string]$Component,
    [string]$TargetPath
  )

  if ($Component -eq "daemon") {
    Restart-DaemonComponent
    return [pscustomobject]@{
      launchMode = "service"
      serviceName = $DaemonServiceName
    }
  } else {
    return Restart-UiComponent -TargetPath $TargetPath
  }
}

function Test-ComponentHealth {
  param(
    [string]$Component,
    [string]$TargetPath,
    [string]$ExpectedSha256,
    [string]$LaunchMode
  )

  if ($Component -eq "daemon") {
    return Test-DaemonHealth -ReadyFile $DaemonReadyFile -TimeoutSeconds $HealthTimeoutSeconds -PollSeconds $HealthPollSeconds
  }
  return Test-UiHealth -TargetPath $TargetPath -ExpectedSha256 $ExpectedSha256 -LaunchMode $LaunchMode -TimeoutSeconds $HealthTimeoutSeconds -PollSeconds $HealthPollSeconds
}

function Restore-ComponentBackup {
  param(
    [string]$Component,
    [string]$BackupPath,
    [string]$TargetPath
  )

  if (-not (Test-Path -LiteralPath $BackupPath -PathType Leaf)) {
    throw "backup missing, cannot rollback: $BackupPath"
  }
  Stop-ComponentForReplace -Component $Component -TargetPath $TargetPath
  Copy-Item -LiteralPath $BackupPath -Destination $TargetPath -Force
  return Restart-Component -Component $Component -TargetPath $TargetPath
}

function ConvertTo-ComponentSpec {
  param($Item)

  $componentName = [string]$Item.component
  if ($componentName -ne "daemon" -and $componentName -ne "ui") {
    throw "component must be daemon or ui"
  }
  if ([string]::IsNullOrWhiteSpace([string]$Item.artifactPath)) {
    throw "artifactPath is required for $componentName"
  }
  $requestedTargetPath = [string]$Item.targetPath
  if ([string]::IsNullOrWhiteSpace($requestedTargetPath)) {
    $requestedTargetPath = Get-DefaultTargetPath -Component $componentName
  }
  $targetPath = Assert-AllowedTargetPath -Component $componentName -TargetPath $requestedTargetPath
  $normalizedSha256 = Normalize-Sha256 -Value ([string]$Item.sha256)

  return [pscustomobject]@{
    component = $componentName
    artifactPath = [string]$Item.artifactPath
    sha256 = $normalizedSha256
    targetPath = $targetPath
  }
}

function Get-RequestedComponents {
  if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) {
    $manifest = Read-JsonFile -Path $ManifestPath
    if ($null -eq $manifest.components) {
      throw "manifest must contain components array"
    }
    if (@($manifest.components).Count -eq 0) {
      throw "manifest components array must not be empty"
    }
    $specs = @()
    foreach ($component in @($manifest.components)) {
      $specs += ConvertTo-ComponentSpec -Item $component
    }
    return $specs
  }

  if (
    [string]::IsNullOrWhiteSpace($Component) -or
    [string]::IsNullOrWhiteSpace($ArtifactPath) -or
    [string]::IsNullOrWhiteSpace($Sha256)
  ) {
    throw "provide -ManifestPath or direct -Component -ArtifactPath -Sha256"
  }

  return @(
    ConvertTo-ComponentSpec -Item ([pscustomobject]@{
        component = $Component
        artifactPath = $ArtifactPath
        sha256 = $Sha256
        targetPath = $TargetPath
      })
  )
}

function Write-Evidence {
  param(
    [string]$Path,
    [object]$Evidence
  )

  if ([string]::IsNullOrWhiteSpace($Path)) {
    $Path = Join-Path $env:TEMP ("vem-managed-update-evidence-{0}.json" -f (Get-Date -Format "yyyyMMddHHmmss"))
  }
  Ensure-Directory -Path (Split-Path -Parent $Path)
  $Evidence | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $Path -Encoding UTF8
  return $Path
}

function Install-Component {
  param($Spec)

  $startedAt = (Get-Date).ToUniversalTime().ToString("o")
  $result = [ordered]@{
    component = $Spec.component
    artifactPath = $Spec.artifactPath
    targetPath = $Spec.targetPath
    expectedSha256 = $Spec.sha256
    startedAt = $startedAt
    backupPath = $null
    installedSha256 = $null
    restart = $null
    healthCheck = $null
    rollbackAttempted = $false
    rollbackOk = $null
    ok = $false
    error = $null
  }

  try {
    Assert-Sha256 -Path $Spec.artifactPath -ExpectedSha256 $Spec.sha256 | Out-Null
    if (-not (Test-Path -LiteralPath $Spec.targetPath -PathType Leaf)) {
      throw "target executable not found: $($Spec.targetPath)"
    }

    $backupPath = New-BackupPath -Component $Spec.component -TargetPath $Spec.targetPath -BackupRoot $BackupRoot
    Copy-Item -LiteralPath $Spec.targetPath -Destination $backupPath -Force
    $result.backupPath = $backupPath

    Stop-ComponentForReplace -Component $Spec.component -TargetPath $Spec.targetPath
    Copy-Item -LiteralPath $Spec.artifactPath -Destination $Spec.targetPath -Force
    $installedSha256 = Assert-Sha256 -Path $Spec.targetPath -ExpectedSha256 $Spec.sha256
    $result.installedSha256 = $installedSha256

    $restart = Restart-Component -Component $Spec.component -TargetPath $Spec.targetPath
    $result.restart = $restart
    $health = Test-ComponentHealth -Component $Spec.component -TargetPath $Spec.targetPath -ExpectedSha256 $Spec.sha256 -LaunchMode $restart.launchMode
    $result.healthCheck = $health
    if (-not [bool]$health.ok) {
      throw "post-update health check failed for $($Spec.component)"
    }

    $result.ok = $true
  } catch {
    $result.error = $_.Exception.Message
    if ($null -ne $result.backupPath) {
      $result.rollbackAttempted = $true
      try {
        $rollbackRestart = Restore-ComponentBackup -Component $Spec.component -BackupPath $result.backupPath -TargetPath $Spec.targetPath
        $result.rollbackRestart = $rollbackRestart
        $rollbackHealth = Test-ComponentHealth -Component $Spec.component -TargetPath $Spec.targetPath -ExpectedSha256 ((Get-FileHash -LiteralPath $Spec.targetPath -Algorithm SHA256).Hash.ToLowerInvariant()) -LaunchMode $rollbackRestart.launchMode
        $result.rollbackOk = [bool]$rollbackHealth.ok
        $result.rollbackHealthCheck = $rollbackHealth
      } catch {
        $result.rollbackOk = $false
        $result.rollbackError = $_.Exception.Message
      }
    }
  } finally {
    $result.finishedAt = (Get-Date).ToUniversalTime().ToString("o")
  }

  return [pscustomobject]$result
}

Assert-Administrator

$manifestUpdateId = "direct-input"
if (-not [string]::IsNullOrWhiteSpace($ManifestPath)) {
  $manifestForEvidence = Read-JsonFile -Path $ManifestPath
  if ([string]::IsNullOrWhiteSpace([string]$manifestForEvidence.updateId)) {
    throw "manifest updateId is required"
  }
  $manifestUpdateId = [string]$manifestForEvidence.updateId
}

$components = Get-RequestedComponents
$evidence = [ordered]@{
  ok = $false
  updateId = $manifestUpdateId
  manifestPath = $ManifestPath
  startedAt = (Get-Date).ToUniversalTime().ToString("o")
  host = $env:COMPUTERNAME
  components = @()
  evidencePath = $null
}

foreach ($spec in $components) {
  $componentResult = Install-Component -Spec $spec
  $evidence.components += $componentResult
  if (-not [bool]$componentResult.ok) {
    break
  }
}

$failedComponents = @($evidence.components | Where-Object { -not [bool]$_.ok })
$evidence.ok = @($evidence.components).Count -eq @($components).Count -and $failedComponents.Count -eq 0
$evidence.finishedAt = (Get-Date).ToUniversalTime().ToString("o")
$writtenEvidencePath = Write-Evidence -Path $EvidencePath -Evidence ([pscustomobject]$evidence)
$evidence.evidencePath = $writtenEvidencePath
Write-Evidence -Path $writtenEvidencePath -Evidence ([pscustomobject]$evidence) | Out-Null

[pscustomobject]$evidence | ConvertTo-Json -Depth 30
if (-not [bool]$evidence.ok) {
  exit 1
}
