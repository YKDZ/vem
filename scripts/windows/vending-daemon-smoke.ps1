param(
  [Parameter(Mandatory = $true)][string]$DaemonExe,
  [Parameter(Mandatory = $true)][string]$MachineUiExe,
  [Parameter(Mandatory = $true)][string]$DataDir,
  [string]$RuntimeBootstrap = "",
  [string]$DefaultApiBaseUrl = "",
  [string]$ServiceName = "VemVendingDaemon",
  [string]$ComPort = "COM3",
  [string]$ScannerPort = "COM4",
  [string]$SensitivePaymentCode = "",
  [string]$MaintenancePin = "",
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
  defaultApiBaseUrl = $DefaultApiBaseUrl
  comPort = $ComPort
  scannerPort = $ScannerPort
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
  try {
    $answer = Read-Host "$Prompt [y/N]"
  } catch {
    $answer = ""
  }
  Add-Check $Name ($answer -match "^(y|yes)$") $Detail
}

function Get-HttpErrorInfo($ErrorRecord) {
  $statusCode = $null
  $bodyText = ""
  $response = $ErrorRecord.Exception.Response

  if ($null -ne $response) {
    if ($null -ne $response.StatusCode) {
      $statusCode = [int]$response.StatusCode
    }
    if ($null -ne $response.Content) {
      try {
        $bodyText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      } catch {
        $bodyText = ""
      }
    } elseif ($response.PSObject.Methods.Name -contains "GetResponseStream") {
      try {
        $stream = $response.GetResponseStream()
        if ($null -ne $stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          $bodyText = $reader.ReadToEnd()
        }
      } catch {
        $bodyText = ""
      }
    }
  }

  if ($bodyText.Length -eq 0 -and $null -ne $ErrorRecord.ErrorDetails -and $null -ne $ErrorRecord.ErrorDetails.Message) {
    $bodyText = $ErrorRecord.ErrorDetails.Message
  }

  $body = $null
  if ($bodyText.Length -gt 0) {
    try {
      $body = $bodyText | ConvertFrom-Json -ErrorAction Stop
    } catch {
      $body = $null
    }
  }

  [pscustomobject]@{
    StatusCode = $statusCode
    BodyText = $bodyText
    Body = $body
  }
}

function Get-ProtectedMaintenanceHeaders {
  param(
    [string]$BaseUrl,
    [hashtable]$DaemonHeaders,
    [string]$RuntimeDataDir,
    [string]$Pin
  )

  $headers = @{}
  foreach ($entry in $DaemonHeaders.GetEnumerator()) {
    $headers[[string]$entry.Key] = [string]$entry.Value
  }
  if (-not [string]::IsNullOrWhiteSpace($Pin)) {
    $session = Invoke-RestMethod "$BaseUrl/v1/maintenance/sessions" -Method Post -Headers $headers -ContentType "application/json" -Body (@{
      pin = $Pin
      scopes = @()
      operatorId = "windows-smoke"
    } | ConvertTo-Json -Compress)
  } else {
    return $headers
  }
  if ([string]::IsNullOrWhiteSpace([string]$session.sessionId)) {
    throw "daemon did not issue a protected maintenance session"
  }
  $headers["x-vem-maintenance-session"] = [string]$session.sessionId
  return $headers
}

New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$targetConfig = Join-Path $DataDir "runtime-bootstrap.json"
if ($RuntimeBootstrap.Length -gt 0) {
  Add-Check "runtime-bootstrap-source-exists" (Test-Path $RuntimeBootstrap) $RuntimeBootstrap
  Copy-Item -Force -Path $RuntimeBootstrap -Destination $targetConfig
  Add-Check "runtime-bootstrap-seeded" (Test-Path $targetConfig) $targetConfig
} elseif ($DefaultApiBaseUrl.Length -gt 0) {
  $bootstrap = [ordered]@{
    schemaVersion = 1
    provisioningApiBaseUrl = $DefaultApiBaseUrl.Trim().TrimEnd("/")
    hardwareModel = "vem-prod-24"
    topology = [ordered]@{
      identity = "vem-prod-24"
      version = "2026-06-adr0026"
    }
  }
  $bootstrap | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $targetConfig -Encoding UTF8
  Add-Check "runtime-bootstrap-created" (Test-Path $targetConfig) $targetConfig
}
$acl = Get-Acl $DataDir
Add-Check "data-dir-acl-readable" ($acl.Access.Count -gt 0) "ACL entries: $($acl.Access.Count)"

$webViewKey = "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients"
$webView = Get-ChildItem $webViewKey -ErrorAction SilentlyContinue |
  ForEach-Object { Get-ItemProperty $_.PsPath } |
  Where-Object { $_.name -like "*WebView2*" } |
  Select-Object -First 1
$record.webView2 = $webView.pv
Add-Check "webview2-installed" ($null -ne $webView) "version=$($webView.pv)"

$readyFile = Join-Path $DataDir "daemon-ready.json"

if (Get-Service $ServiceName -ErrorAction SilentlyContinue) {
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}
sc.exe create $ServiceName binPath= "`"$DaemonExe`" --data-dir `"$DataDir`" --print-ready-file `"$readyFile`"" start= auto | Out-Null
sc.exe failure $ServiceName reset= 60 actions= restart/5000/restart/5000/""/5000 | Out-Null
Start-Service $ServiceName
Start-Sleep -Seconds 5
$svc = Get-Service $ServiceName
Add-Check "service-running" ($svc.Status -eq "Running") "status=$($svc.Status)"

Add-Check "ready-file-exists" (Test-Path $readyFile) $readyFile
$ready = Get-Content $readyFile | ConvertFrom-Json
Add-Check "advanced-debug-default-disabled" (-not $ready.runtimeFlags.advancedMaintenanceConfig) ($ready.runtimeFlags | ConvertTo-Json -Compress)
$health = Invoke-RestMethod $ready.healthzUrl
Add-Check "healthz-json" ($null -ne $health.status) ($health | ConvertTo-Json -Compress)
$baseUrl = $ready.healthzUrl -replace "/healthz$", ""
$headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
$maintenanceHeaders = Get-ProtectedMaintenanceHeaders -BaseUrl $baseUrl -DaemonHeaders $headers -RuntimeDataDir $DataDir -Pin $MaintenancePin
$configSummary = Invoke-RestMethod "$baseUrl/v1/config/summary" -Headers $headers
$groupedRuntimeConfig = $null -ne $configSummary.sourceDocuments -and $null -ne $configSummary.sourceDocuments.bootstrap
$legacyRuntimeConfig = $null -ne $configSummary.effectivePublic -and $null -ne $configSummary.configuredState
Add-Check "runtime-config-summary" ($groupedRuntimeConfig -or $legacyRuntimeConfig) ($configSummary | ConvertTo-Json -Compress)
$config = if ($groupedRuntimeConfig) {
  [pscustomobject]@{
    apiBaseUrl = if ($null -ne $configSummary.platform) { $configSummary.platform.apiBaseUrl } else { $configSummary.sourceDocuments.bootstrap.provisioningApiBaseUrl }
  }
} else {
  $configSummary.effectivePublic
}
if ($DefaultApiBaseUrl.Length -gt 0) {
  $expectedApiBaseUrl = $DefaultApiBaseUrl.Trim().TrimEnd("/")
  if (Test-Path $targetConfig) {
    $seededConfig = Get-Content $targetConfig -Raw | ConvertFrom-Json
    if ($null -ne $seededConfig.provisioningApiBaseUrl -and $seededConfig.provisioningApiBaseUrl.Length -gt 0) {
      $expectedApiBaseUrl = $seededConfig.provisioningApiBaseUrl.Trim().TrimEnd("/")
    }
  }
  Add-Check "default-api-base-url-configured" ($config.apiBaseUrl -eq $expectedApiBaseUrl) ($config | ConvertTo-Json -Compress)

  $bringUp = Invoke-RestMethod "$baseUrl/v1/bring-up" -Headers $headers
  $claimTask = $bringUp.currentTask
  Add-Check "claim-task-is-current" ($null -ne $claimTask -and $claimTask.kind -eq "claim_machine") ($bringUp | ConvertTo-Json -Compress)
  $claimPayload = @{
    contractVersion = $claimTask.contractVersion
    taskId = $claimTask.taskId
    taskVersion = $claimTask.taskVersion
    kind = $claimTask.kind
    intent = $claimTask.intent
    mutation = @{ type = "claim_machine"; claimCode = "WXYZ-2345" }
  } | ConvertTo-Json -Compress
  try {
    $claimResponse = Invoke-RestMethod "$baseUrl/v1/bring-up/tasks/execute" -Method Post -Headers $maintenanceHeaders -ContentType "application/json" -Body $claimPayload
    Add-Check "claim-endpoint-reachable-invalid-claim" $false "unexpectedly provisioned with invalid smoke claim: $($claimResponse | ConvertTo-Json -Compress)"
  } catch {
    $claimError = Get-HttpErrorInfo $_
    $claimCode = ""
    if ($null -ne $claimError.Body -and $null -ne $claimError.Body.code) {
      $claimCode = [string]$claimError.Body.code
    }
    $businessClaimErrors = @(
      "machine_claim_invalid",
      "machine_claim_invalid_or_expired",
      "machine_claim_expired",
      "machine_claim_used",
      "machine_claim_revoked",
      "machine_claim_locked"
    )
    $claimDetail = "status=$($claimError.StatusCode) code=$claimCode body=$($claimError.BodyText)"
    Add-Check "claim-endpoint-backend-unavailable-fails-smoke" ($claimCode -ne "machine_claim_backend_unavailable") $claimDetail
    Add-Check "claim-endpoint-reachable-invalid-claim" (($claimError.StatusCode -ge 400 -and $claimError.StatusCode -lt 500) -and ($businessClaimErrors -contains $claimCode)) $claimDetail
  }
}
$scanner = Invoke-RestMethod "$baseUrl/v1/scanner/status" -Headers $maintenanceHeaders
Add-Check "scanner-adapter-serial-text" ($scanner.adapter -eq "serial_text") ($scanner | ConvertTo-Json -Compress)
Add-Check "scanner-status-diagnostic" ($scanner.code.Length -gt 0 -and $scanner.message.Length -gt 0) ($scanner | ConvertTo-Json -Compress)

$ports = [System.IO.Ports.SerialPort]::GetPortNames()
Add-Check "lower-controller-com-port-present" ($ports -contains $ComPort) ($ports -join ",")
Add-Check "scanner-com-port-present" ($ports -contains $ScannerPort) ($ports -join ",")

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
  Write-Output "first boot UI verification: confirm the visible page is Machine Claim Code and no backend URL input is shown or required."
  Confirm-ManualCheck "first-boot-machine-claim-code-page" $FirstBootMachineClaimCodePageObserved "Is the visible first boot page the Machine Claim Code page?" "operator confirmed visible Machine Claim Code page"
  Confirm-ManualCheck "first-boot-backend-url-input-absent" $FirstBootBackendUrlInputAbsent "Is the backend URL input absent from first boot?" "operator confirmed backend URL input is absent"
} finally {
  if ($null -ne $ui -and -not $ui.HasExited) {
    $ui.Kill()
  }
}

Restart-Service $ServiceName
Start-Sleep -Seconds 5
$svc = Get-Service $ServiceName
Add-Check "service-restart-running" ($svc.Status -eq "Running") "status=$($svc.Status)"

if ($SensitivePaymentCode.Length -gt 0) {
  $logText = Get-ChildItem -Path $DataDir -Recurse -File |
    Where-Object { $_.Extension -in ".json",".jsonl",".log",".txt" } |
    ForEach-Object { Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue } |
    Out-String
  Add-Check "payment-code-plaintext-absent" (-not $logText.Contains($SensitivePaymentCode)) "data dir text scanned"
}

$record.finishedAt = (Get-Date).ToString("o")
$out = Join-Path $DataDir "windows-hardware-acceptance.json"
$record | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $out
Write-Output "acceptance record: $out"
