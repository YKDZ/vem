param(
  [string]$ReadyFile = "C:\ProgramData\VEM\vending-daemon\daemon-ready.json",
  [string]$DaemonConfig = "C:\ProgramData\VEM\vending-daemon\machine-config.json",
  [string]$ServiceName = "VemVendingDaemon",
  [switch]$ExpectSimulator,
  [switch]$RequireScannerOnline,
  [switch]$RequireHardwareOnline,
  [switch]$RequireBackendOnline,
  [switch]$RequireMqttConnected,
  [switch]$RequireCanSell
)

$ErrorActionPreference = "Stop"
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

$failures = [System.Collections.Generic.List[string]]::new()
$checks = [ordered]@{}

$service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $service) {
  Add-Failure $failures "service not found: $ServiceName"
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
if (Test-Path $DaemonConfig) {
  $config = Read-JsonFile $DaemonConfig
  $checks.config = [pscustomobject]@{
    machineCode = $config.machineCode
    hardwareAdapter = $config.hardwareAdapter
    serialPortPath = $config.serialPortPath
    scannerAdapter = $config.scannerAdapter
    scannerSerialPortPath = $config.scannerSerialPortPath
    apiBaseUrl = $config.apiBaseUrl
    mqttUrl = $config.mqttUrl
  }
} else {
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
  if ($null -eq $config -or -not ([string]$config.serialPortPath).StartsWith("tcp://")) {
    Add-Failure $failures "ExpectSimulator requires serialPortPath=tcp://..., got: $($config.serialPortPath)"
  }
}

if (Test-Path $ReadyFile) {
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
  $readiness = Invoke-IpcJson "GET" "$base/v1/sale-readiness" $headers
  $scanner = Invoke-IpcJson "GET" "$base/v1/scanner/status" $headers
  $hardware = Invoke-IpcJson "POST" "$base/v1/hardware/self-check" $headers
  $sync = Invoke-IpcJson "GET" "$base/v1/sync/status" $headers

  $checks.ipc = [pscustomobject]@{
    baseUrl = $base
    healthz = $healthz
    readyz = $readyz
    saleReadiness = $readiness
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
  if ($RequireCanSell -and -not [bool]$readyz.canSell) {
    $blocking = @($readyz.blockingCodes) -join ","
    Add-Failure $failures "machine cannot sell: mode=$($readyz.mode) route=$($readyz.suggestedRoute) blockers=$blocking"
  }
} else {
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
