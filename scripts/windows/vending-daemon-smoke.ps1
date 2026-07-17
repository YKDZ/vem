param(
  [Parameter(Mandatory = $true)][string]$DaemonExe,
  [Parameter(Mandatory = $true)][string]$MachineUiExe,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [string]$RuntimeBootstrap = "",
  [string]$DefaultApiBaseUrl = "",
  [string]$ClaimCode = "",
  [string]$ServiceName = "VemVendingDaemon",
  [string]$SensitivePaymentCode = "",
  [switch]$FirstBootMachineClaimCodePageObserved,
  [switch]$FirstBootBackendUrlInputAbsent
)

$ErrorActionPreference = "Stop"
$record = [ordered]@{
  startedAt = (Get-Date).ToString("o")
  os = (Get-CimInstance Win32_OperatingSystem).Caption
  webView2 = $null
  serviceName = $ServiceName
  dataDir = $DataDir
  runtimeBootstrap = $RuntimeBootstrap
  checks = @()
}

function Add-Check([string]$Name, [bool]$Passed, [string]$Detail) {
  $record.checks += [ordered]@{ name = $Name; passed = $Passed; detail = $Detail }
  if (-not $Passed) { throw "$Name failed: $Detail" }
}

function Confirm-ManualCheck([string]$Name, $Confirmed, [string]$Prompt, [string]$Detail) {
  if ($Confirmed.IsPresent) {
    Add-Check $Name $true $Detail
    return
  }
  $answer = ""
  try { $answer = Read-Host "$Prompt [y/N]" } catch { $answer = "" }
  Add-Check $Name ($answer -match "^(y|yes)$") $Detail
}

function Write-Utf8NoBom([string]$Path, [string]$Value) {
  [IO.File]::WriteAllText($Path, $Value, [Text.UTF8Encoding]::new($false))
}

function Read-DaemonReady([string]$Path) {
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      try { return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json } catch {}
    }
    Start-Sleep -Milliseconds 500
  }
  throw "daemon ready file did not become readable: $Path"
}

function Restart-Daemon([string]$Name, [string]$ReadyPath) {
  Remove-Item -Force -LiteralPath $ReadyPath -ErrorAction SilentlyContinue
  $service = Get-Service $Name -ErrorAction Stop
  if ($service.Status -ne "Stopped") {
    Stop-Service $Name -Force -ErrorAction SilentlyContinue
    $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(20))
  }
  Start-Service $Name
  return Read-DaemonReady $ReadyPath
}

function Read-RuntimeConfiguration($Ready) {
  $baseUrl = $Ready.healthzUrl -replace "/healthz$", ""
  $headers = @{ Authorization = "Bearer $($Ready.ipcToken)" }
  return Invoke-RestMethod "$baseUrl/v1/runtime-configuration" -Headers $headers
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$targetBootstrap = Join-Path $DataDir "runtime-bootstrap.json"
if ($RuntimeBootstrap.Length -gt 0) {
  Add-Check "runtime-bootstrap-source-exists" (Test-Path -LiteralPath $RuntimeBootstrap -PathType Leaf) $RuntimeBootstrap
  $bootstrapJson = Get-Content -Raw -LiteralPath $RuntimeBootstrap
  $null = $bootstrapJson | ConvertFrom-Json
  Write-Utf8NoBom $targetBootstrap $bootstrapJson
} elseif ($DefaultApiBaseUrl.Length -gt 0) {
  $bootstrap = [ordered]@{
    schemaVersion = 1
    provisioningApiBaseUrl = $DefaultApiBaseUrl.Trim().TrimEnd("/")
    hardwareModel = "vem-prod-24"
    topology = [ordered]@{ identity = "vem-prod-24"; version = "2026-06-adr0026" }
  }
  Write-Utf8NoBom $targetBootstrap ($bootstrap | ConvertTo-Json -Depth 10)
}
Add-Check "runtime-bootstrap-present" (Test-Path -LiteralPath $targetBootstrap -PathType Leaf) $targetBootstrap

$webViewKey = "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients"
$webView = Get-ChildItem $webViewKey -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ItemProperty $_.PsPath } |
  Where-Object { $_.name -like "*WebView2*" } |
  Select-Object -First 1
$record.webView2 = $webView.pv
Add-Check "webview2-installed" ($null -ne $webView) "version=$($webView.pv)"

$readyFile = Join-Path $DataDir "daemon-ready.json"
Remove-Item -Force -LiteralPath $readyFile -ErrorAction SilentlyContinue
if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  Stop-Service $ServiceName -Force -ErrorAction SilentlyContinue
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}
sc.exe create $ServiceName binPath= "`"$DaemonExe`" --data-dir `"$DataDir`" --print-ready-file `"$readyFile`"" start= auto | Out-Null
sc.exe failure $ServiceName reset= 60 actions= restart/5000/restart/5000/""/5000 | Out-Null
Start-Service $ServiceName
$ready = Read-DaemonReady $readyFile
$svc = Get-Service $ServiceName
Add-Check "service-running" ($svc.Status -eq "Running") "status=$($svc.Status)"

$health = Invoke-RestMethod $ready.healthzUrl
Add-Check "healthz-json" ($null -ne $health.status) ($health | ConvertTo-Json -Compress)
$configuration = Read-RuntimeConfiguration $ready
Add-Check "runtime-bootstrap-projected" ($null -ne $configuration.sourceDocuments.bootstrap) ($configuration | ConvertTo-Json -Depth 12 -Compress)
Add-Check "runtime-bootstrap-owns-provisioning-url" (-not [string]::IsNullOrWhiteSpace([string]$configuration.sourceDocuments.bootstrap.provisioningApiBaseUrl)) ($configuration.sourceDocuments.bootstrap | ConvertTo-Json -Compress)

if (-not [string]::IsNullOrWhiteSpace($ClaimCode)) {
  $baseUrl = $ready.healthzUrl -replace "/healthz$", ""
  $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
  $claim = Invoke-RestMethod "$baseUrl/v1/provisioning/claim" -Method Post -Headers $headers -ContentType "application/json" -Body (@{
    claimCode = $ClaimCode.Trim()
  } | ConvertTo-Json -Compress)
  Add-Check "real-claim-accepted" ($claim.status -eq "provisioned" -and -not [string]::IsNullOrWhiteSpace([string]$claim.machineCode)) ($claim | ConvertTo-Json -Depth 12 -Compress)

  $ready = Restart-Daemon $ServiceName $readyFile
  $configuration = Read-RuntimeConfiguration $ready
  Add-Check "accepted-profile-projected" ($null -ne $configuration.sourceDocuments.profileCache) ($configuration | ConvertTo-Json -Depth 12 -Compress)
  Add-Check "claimed-machine-projected" ([string]$configuration.machine.code -eq [string]$claim.machineCode) ($configuration.machine | ConvertTo-Json -Compress)
}

$baseUrl = $ready.healthzUrl -replace "/healthz$", ""
$headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
$scanner = Invoke-RestMethod "$baseUrl/v1/scanner/status" -Headers $headers
Add-Check "scanner-adapter-serial-text" ($scanner.adapter -eq "serial_text") ($scanner | ConvertTo-Json -Compress)
Add-Check "scanner-status-diagnostic" ($scanner.code.Length -gt 0 -and $scanner.message.Length -gt 0) ($scanner | ConvertTo-Json -Compress)

$bindings = Invoke-RestMethod "$baseUrl/v1/hardware-bindings" -Headers $headers
$lowerBinding = @($bindings.bindings | Where-Object { $_.role -eq "lower_controller" })
$scannerBinding = @($bindings.bindings | Where-Object { $_.role -eq "scanner" })
Add-Check "lower-controller-binding-observed" ($lowerBinding.Count -eq 1) ($bindings | ConvertTo-Json -Depth 12 -Compress)
Add-Check "scanner-binding-observed" ($scannerBinding.Count -eq 1) ($bindings | ConvertTo-Json -Depth 12 -Compress)

$previousReadyFile = [Environment]::GetEnvironmentVariable("VEM_DAEMON_READY_FILE", "Process")
$previousDataDir = [Environment]::GetEnvironmentVariable("VEM_DAEMON_DATA_DIR", "Process")
[Environment]::SetEnvironmentVariable("VEM_DAEMON_READY_FILE", $readyFile, "Process")
[Environment]::SetEnvironmentVariable("VEM_DAEMON_DATA_DIR", $DataDir, "Process")
try {
  $ui = Start-Process -FilePath $MachineUiExe -PassThru
} finally {
  [Environment]::SetEnvironmentVariable("VEM_DAEMON_READY_FILE", $previousReadyFile, "Process")
  [Environment]::SetEnvironmentVariable("VEM_DAEMON_DATA_DIR", $previousDataDir, "Process")
}
Start-Sleep -Seconds 5
try {
  Add-Check "kiosk-started" (-not $ui.HasExited) "pid=$($ui.Id)"
  if ([string]::IsNullOrWhiteSpace($ClaimCode)) {
    Confirm-ManualCheck "first-boot-machine-claim-code-page" $FirstBootMachineClaimCodePageObserved "Is the visible first boot page the Machine Claim Code page?" "operator confirmed visible Machine Claim Code page"
    Confirm-ManualCheck "first-boot-backend-url-input-absent" $FirstBootBackendUrlInputAbsent "Is the backend URL input absent from first boot?" "operator confirmed backend URL input is absent"
  }
} finally {
  if ($null -ne $ui -and -not $ui.HasExited) { $ui.Kill() }
}

$ready = Restart-Daemon $ServiceName $readyFile
Add-Check "service-restart-running" ((Get-Service $ServiceName).Status -eq "Running") "ready=$($ready.healthzUrl)"

if ($SensitivePaymentCode.Length -gt 0) {
  $logText = Get-ChildItem -Path $DataDir -Recurse -File |
    Where-Object { $_.Extension -in ".json", ".jsonl", ".log", ".txt" } |
    ForEach-Object { Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue } |
    Out-String
  Add-Check "payment-code-plaintext-absent" (-not $logText.Contains($SensitivePaymentCode)) "data dir text scanned"
}

$record.finishedAt = (Get-Date).ToString("o")
$out = Join-Path $DataDir "windows-hardware-acceptance.json"
$record | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 $out
Write-Output "acceptance record: $out"
