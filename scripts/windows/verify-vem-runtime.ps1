param(
  [string]$ReadyFile = "C:\ProgramData\VEM\vending-daemon\daemon-ready.json",
  [string]$DaemonConfig = "C:\ProgramData\VEM\vending-daemon\runtime-bootstrap.json",
  [string]$ServiceName = "VemVendingDaemon",
  [switch]$ExpectSimulator,
  [switch]$RequireScannerOnline,
  [switch]$RequireHardwareOnline,
  [switch]$RequireVisionOnline,
  [switch]$VisionOnly,
  [switch]$RequireBackendOnline,
  [switch]$RequireMqttConnected,
  [string]$OwnerManifestPath = "C:\ProgramData\VEM\runtime-owners\owner-manifest.json",
  [string]$VisionTaskName = "VEM\StartVisionServer",
  [string]$VisionTaskPath = "\VEM\",
  [string]$VisionDirectory = "C:\VEM\vision",
  [string]$VisionAppDirectory = "C:\VEM\vision\app",
  [string]$VisionLauncher = "C:\VEM\bringup\start_vision.bat",
  [string]$VisionSiteConfiguration = "C:\ProgramData\VEM\vision\site.json",
  [string]$VisionInstallRecord = "C:\ProgramData\VEM\vision\installed.json",
  [string]$VisionFixtureDirectory = "C:\ProgramData\VEM\vision\fixtures",
  [string]$ExpectedMachineUiExe = "C:\VEM\bringup\machine.exe"
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "vision-main-artifacts.psm1") -Force
trap {
  Write-Error $_
  exit 1
}

function Add-Failure([System.Collections.Generic.List[string]]$Failures, [string]$Message) {
  $Failures.Add($Message) | Out-Null
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path $Path)) {
    throw "file not found: $Path"
  }
  return [System.IO.File]::ReadAllText(
    $Path,
    [System.Text.Encoding]::UTF8
  ) | ConvertFrom-Json
}

function Resolve-VisionOwner([string]$ManifestPath) {
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { return $null }
  try {
    $manifest = Read-JsonFile $ManifestPath
    if ([string]$manifest.schemaVersion -cne "vem-runtime-owners/v1") { return $null }
    if ($null -eq $manifest.owners -or $null -eq $manifest.owners.vision) { return $null }
    return $manifest.owners.vision
  } catch {
    return $null
  }
}

function Get-IpcBaseUrl($Ready) {
  $healthz = [string]$Ready.healthzUrl
  if ([string]::IsNullOrWhiteSpace($healthz)) {
    throw "healthzUrl missing from ready file"
  }
  $lastSlash = $healthz.LastIndexOf("/")
  if ($lastSlash -le 0) {
    throw "invalid healthzUrl: $healthz"
  }
  return $healthz.Substring(0, $lastSlash)
}

function Invoke-IpcJson([string]$Method, [string]$Uri, $Headers) {
  if ($Method -eq "POST") {
    return Invoke-RestMethod -Method Post -Uri $Uri -Headers $Headers -TimeoutSec 10
  }
  return Invoke-RestMethod -Method Get -Uri $Uri -Headers $Headers -TimeoutSec 10
}

function Add-VisionFailure($Failures, [string]$Message) {
  Add-Failure $Failures $Message
}

function Test-VisionRuntimeBinding {
  param([System.Collections.Generic.List[string]]$Failures)
  $result = [ordered]@{ installationValid=$false; healthValid=$false; protocolValid=$false }
  try {
    $record = Read-JsonFile $VisionInstallRecord
    if ($record.commit -notmatch '^[a-f0-9]{40}$' -or $record.runtime -cne "vending-vision.exe") { throw "direct Vision install record is invalid" }
    if (-not (Test-Path -LiteralPath (Join-Path $VisionAppDirectory "vending-vision.exe") -PathType Leaf) -or -not (Test-Path -LiteralPath $VisionSiteConfiguration -PathType Leaf)) { throw "direct Vision application or site configuration is missing" }
    $result.installationValid=$true
    $probe = Invoke-VisionMainProbe -ConfigurationPath $VisionSiteConfiguration -FixtureRoot (Join-Path $VisionFixtureDirectory ([string]$record.commit)) -AppDirectory $VisionAppDirectory
    $result.healthValid=$probe.health.cameraReady -eq $true
    $result.protocolValid=($probe.ready.type -ceq "vision.ready" -and $probe.ready.payload.tryOnReady -eq $true -and $probe.ready.payload.visionBusinessReady -eq $true -and $probe.ready.payload.businessReadinessDiagnostic -ceq "ready")
  } catch { Add-VisionFailure $Failures $_.Exception.Message }
  return [pscustomobject]$result
}

$failures = [System.Collections.Generic.List[string]]::new()
$checks = [ordered]@{}

$service = if ($VisionOnly) { $null } else { Get-Service -Name $ServiceName -ErrorAction SilentlyContinue }
if ($null -eq $service) {
  if (-not $VisionOnly) { Add-Failure $failures "service not found: $ServiceName" }
} else {
  $checks.service = [pscustomobject]@{
    name = $service.Name
    status = [string]$service.Status
    startType = [string]$service.StartType
  }
  if ($service.Status -ne "Running") {
    Add-Failure $failures "daemon service is not running: $($service.Status)"
  }
}

$config = $null
if (-not $VisionOnly -and (Test-Path $DaemonConfig)) {
  $config = Read-JsonFile $DaemonConfig
  $checks.config = [pscustomobject]@{
    machineCode = $config.machineCode
    hardwareAdapter = $config.hardwareAdapter
    lowerControllerPath = $config.lowerControllerPath
    scannerAdapter = $config.scannerAdapter
    scannerPath = $config.scannerPath
    apiBaseUrl = $config.apiBaseUrl
    mqttUrl = $config.mqttUrl
  }
} elseif (-not $VisionOnly) {
  Add-Failure $failures "daemon config not found: $DaemonConfig"
}

if ($ExpectSimulator) {
  $simProcess = Get-Process lower-controller-sim -ErrorAction SilentlyContinue | Select-Object -First 1
  $checks.simulator = [pscustomobject]@{
    running = $null -ne $simProcess
    pid = if ($null -ne $simProcess) { $simProcess.Id } else { $null }
  }
  if ($null -eq $simProcess) {
    Add-Failure $failures "lower-controller-sim process is not running"
  }
  if ($null -eq $config -or -not ([string]$config.lowerControllerPath).StartsWith("tcp://")) {
    Add-Failure $failures "ExpectSimulator requires lowerControllerPath=tcp://..., got: $($config.lowerControllerPath)"
  }
}

# Vision ownership has two shapes: the field kit installs Vision as a delegated
# owner task declared by the runtime owner manifest, while a standalone Vision
# deployment records the legacy fixed task. Prefer the manifest so verification
# follows whatever the install record actually names.
$visionOwner = Resolve-VisionOwner $OwnerManifestPath
$resolvedVisionTaskName = if ($null -ne $visionOwner) { [string]$visionOwner.name } else { [string]($VisionTaskName -split '\\')[-1] }
$resolvedVisionTaskPath = if ($null -ne $visionOwner) { [string]$visionOwner.taskPath } else { $VisionTaskPath }
$resolvedVisionLauncher = if ($null -ne $visionOwner) { [string]$visionOwner.launcherPath } else { $VisionLauncher }

$visionTask = Get-ScheduledTask -TaskName $resolvedVisionTaskName -TaskPath $resolvedVisionTaskPath -ErrorAction SilentlyContinue
$visionLauncherExists = Test-Path -LiteralPath $resolvedVisionLauncher
$visionDirectoryExists = Test-Path -LiteralPath $VisionDirectory
$visionAppExists = Test-Path -LiteralPath $VisionAppDirectory
$visionSiteConfigurationExists = Test-Path -LiteralPath $VisionSiteConfiguration
$visionInstallRecordExists = Test-Path -LiteralPath $VisionInstallRecord
$checks.vision = [pscustomobject]@{
  ownerManifest = $OwnerManifestPath
  ownerKind = if ($null -ne $visionOwner) { "delegated" } else { "direct" }
  taskName = "$resolvedVisionTaskPath$resolvedVisionTaskName"
  taskReady = $null -ne $visionTask -and [string]$visionTask.State -ne "Disabled"
  taskState = if ($null -ne $visionTask) { [string]$visionTask.State } else { $null }
  launcher = $resolvedVisionLauncher
  launcherExists = $visionLauncherExists
  directory = $VisionDirectory
  directoryExists = $visionDirectoryExists
  appDirectory = $VisionAppDirectory
  appDirectoryExists = $visionAppExists
  siteConfiguration = $VisionSiteConfiguration
  siteConfigurationExists = $visionSiteConfigurationExists
  installRecord = $VisionInstallRecord
  installRecordExists = $visionInstallRecordExists
  binding = $null
}
if ($RequireVisionOnline) {
  if ($null -eq $visionTask -or [string]$visionTask.State -eq "Disabled") {
    Add-Failure $failures "vision task is not ready: $resolvedVisionTaskPath$resolvedVisionTaskName"
  }
  if (-not $visionLauncherExists) {
    Add-Failure $failures "vision launcher not found: $resolvedVisionLauncher"
  }
  if (-not $visionDirectoryExists) {
    Add-Failure $failures "vision directory not found: $VisionDirectory"
  }
  if (-not $visionAppExists -or -not $visionSiteConfigurationExists -or -not $visionInstallRecordExists) {
    Add-Failure $failures "direct Vision application, site configuration, or install record is missing"
  }
  $checks.vision.binding = @(Test-VisionRuntimeBinding $failures)[-1]
}

if (-not $VisionOnly -and (Test-Path $ReadyFile)) {
  $ready = Read-JsonFile $ReadyFile
  $base = Get-IpcBaseUrl $ready
  $headers = @{ Authorization = ("Bearer " + $ready.ipcToken) }
  $checks.readyFile = [pscustomobject]@{
    path = $ReadyFile
    healthzUrl = $ready.healthzUrl
    readyzUrl = $ready.readyzUrl
  }

  $healthz = Invoke-IpcJson "GET" "$base/healthz" $headers
  $readyz = Invoke-IpcJson "GET" "$base/readyz" $headers
  $scanner = Invoke-IpcJson "GET" "$base/v1/scanner/status" $headers
  $hardware = Invoke-IpcJson "POST" "$base/v1/hardware/self-check" $headers
  $sync = Invoke-IpcJson "GET" "$base/v1/sync/status" $headers

  $checks.ipc = [pscustomobject]@{
    baseUrl = $base
    healthz = $healthz
    readyz = $readyz
    scanner = $scanner
    hardware = $hardware
    sync = $sync
  }

  if ($RequireBackendOnline -and -not [bool]$healthz.backendOnline) {
    Add-Failure $failures "backend is not online"
  }
  if ($RequireMqttConnected -and -not [bool]$healthz.mqttConnected) {
    Add-Failure $failures "mqtt is not connected"
  }
  if ($RequireScannerOnline -and -not [bool]$scanner.online) {
    Add-Failure $failures "scanner is not online: $($scanner.code) $($scanner.message)"
  }
  if ($RequireHardwareOnline -and -not [bool]$hardware.online) {
    Add-Failure $failures "lower controller is not online: $($hardware.message)"
  }
} elseif (-not $VisionOnly) {
  Add-Failure $failures "daemon ready file not found: $ReadyFile"
}

$result = [pscustomobject]@{
  ok = $failures.Count -eq 0
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  failures = @($failures)
  checks = $checks
}

$result | ConvertTo-Json -Depth 30
if ($failures.Count -gt 0) {
  exit 1
}
