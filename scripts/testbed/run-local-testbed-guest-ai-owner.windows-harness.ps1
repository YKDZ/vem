$ErrorActionPreference = "Stop"

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -cne $Expected) { throw "$Message; expected $Expected, got $Actual" }
}

$ownerModulePath = Join-Path $PSScriptRoot "ai-vision-owner.psm1"
Import-Module $ownerModulePath -Force

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-ai-owner-restart-" + [guid]::NewGuid().ToString("N"))
$script:repoRoot = Join-Path $root "repo"
$script:runtimeRoot = Join-Path $root "runtime"
$script:deploymentRoot = Join-Path $root "bringup"
$script:daemonDataRoot = Join-Path $root "daemon"
$installer = Join-Path $script:repoRoot "scripts/windows/install-vem-runtime-owners.ps1"
$global:AiOwnerHarnessCalls = [Collections.Generic.List[string]]::new()
$global:AiOwnerHarnessFailAiInstall = $false
$global:AiOwnerHarnessFailurePoint = $null
$global:AiOwnerHarnessDefaultOnline = $false
$global:AiOwnerHarnessAiEnvironment = $false
$global:AiOwnerHarnessDiagnostic = $null
$global:AiOwnerHarnessFailDefaultInstall = $false
$global:AiOwnerHarnessStopAfterSideEffectFailure = $false
$global:AiOwnerHarnessWorkerDisabled = $false
$env:NODE_ENV = "test"

function global:Join-Path {
  param([string]$Path, [string]$ChildPath)
  if ($Path -match '^[A-Za-z]:\\') { return ($Path.TrimEnd("\") + "\" + $ChildPath.TrimStart("\")) }
  return [IO.Path]::Combine($Path, $ChildPath)
}

$testOperations = @{
  StopOwner = {
    param([string]$AppDirectory, [string]$ConfigurationPath)
    $global:AiOwnerHarnessCalls.Add("stop-task:VEMVisionRuntime") | Out-Null
    $global:AiOwnerHarnessCalls.Add("stop-canonical") | Out-Null
    $global:AiOwnerHarnessDefaultOnline = $false
    if ($global:AiOwnerHarnessStopAfterSideEffectFailure) {
      $global:AiOwnerHarnessStopAfterSideEffectFailure = $false
      throw "injected stop-after-side-effect failure"
    }
  }
  StartOwner = {
  $global:AiOwnerHarnessCalls.Add("start-task:VEMVisionRuntime") | Out-Null
  if ($global:AiOwnerHarnessFailurePoint -ceq "start" -and $global:AiOwnerHarnessAiEnvironment) { throw "injected start failure" }
  $global:AiOwnerHarnessDefaultOnline = -not $global:AiOwnerHarnessAiEnvironment
  }
  WaitReady = {
  $global:AiOwnerHarnessCalls.Add("ready") | Out-Null
  if ($global:AiOwnerHarnessFailurePoint -ceq "ready" -and $global:AiOwnerHarnessAiEnvironment) { throw "injected ready failure" }
  if (-not [string]::IsNullOrWhiteSpace([string]$global:AiOwnerHarnessDiagnostic)) {
    return [pscustomobject]@{ ok = $true; aiReady = $false; aiReadinessDiagnostic = $global:AiOwnerHarnessDiagnostic }
  }
  if ($global:AiOwnerHarnessWorkerDisabled) {
    return [pscustomobject]@{ ok = $true; aiReady = $false; aiReadinessDiagnostic = "worker_unavailable" }
  }
  if ($global:AiOwnerHarnessAiEnvironment) {
    return [pscustomobject]@{ ok = $true; aiReady = $true; aiReadinessDiagnostic = "ready" }
  }
  return [pscustomobject]@{ ok = $true; aiReady = $false; aiReadinessDiagnostic = "model_pack_missing" }
  }
  ReadOwnerIdentity = {
    return [pscustomobject]@{ ProcessId = 4242; ExecutablePath = "C:\VEM\vision\app\vending-vision.exe" }
  }
  InstallOwner = {
    param([object]$GuestInput, [object]$Configuration)
    if ($null -eq $Configuration) {
      $global:AiOwnerHarnessCalls.Add("install-default") | Out-Null
      if ($global:AiOwnerHarnessFailDefaultInstall) { throw "injected default recovery failure" }
      $global:AiOwnerHarnessAiEnvironment = $false
      $global:AiOwnerHarnessDiagnostic = $null
      return
    }
    $global:AiOwnerHarnessCalls.Add("install-ai:$($Configuration.acceptanceEvidenceRoot)") | Out-Null
    $global:AiOwnerHarnessAiEnvironment = $true
    $global:AiOwnerHarnessDiagnostic = $null
    if ($global:AiOwnerHarnessFailurePoint -ceq "install") { throw "injected install failure" }
  }
  InstallCorruptOwner = {
    param([object]$GuestInput, [object]$Configuration)
    $global:AiOwnerHarnessCalls.Add("install-corrupt-launcher:$($Configuration.modelPackRoot)") | Out-Null
    $global:AiOwnerHarnessAiEnvironment = $true
    $global:AiOwnerHarnessDiagnostic = "model_pack_invalid"
  }
  DisableWorker = {
    param([object]$Configuration)
    $global:AiOwnerHarnessCalls.Add("disable-canonical-worker") | Out-Null
    $global:AiOwnerHarnessWorkerDisabled = $true
    return [ordered]@{
      canonicalWorkerPath = "C:\VEM\vision\app\vending-vision-ai-worker\vending-vision-ai-worker.exe"
      disabledWorkerPath = ([string]$Configuration.acceptanceEvidenceRoot + "\vending-vision-ai-worker.exe.disabled")
      workerExecutableSha256 = ("a" * 64)
    }
  }
  RestoreWorker = {
    param([object]$WorkerFault)
    if (-not $global:AiOwnerHarnessWorkerDisabled) { throw "worker fault was not active during restoration" }
    $global:AiOwnerHarnessCalls.Add("restore-canonical-worker") | Out-Null
    $global:AiOwnerHarnessWorkerDisabled = $false
    return [ordered]@{ workerExecutableSha256 = [string]$WorkerFault.workerExecutableSha256 }
  }
}

try {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $installer), $script:runtimeRoot, $script:deploymentRoot, $script:daemonDataRoot | Out-Null
  @'
param(
  [string]$RuntimeDirectory, [string]$DaemonDataDirectory, [string]$VisionAppDirectory,
  [string]$VisionDataDirectory, [string]$KioskPassword, [int]$MachineUiWebViewDebugPort,
  [string]$VisionAiModelPackRoot, [string]$VisionAiAcceptanceEvidenceRoot, [string]$OwnerManifestPath
)
if ([string]::IsNullOrWhiteSpace($VisionAiModelPackRoot)) {
  $global:AiOwnerHarnessCalls.Add("install-default") | Out-Null
  if ($global:AiOwnerHarnessFailDefaultInstall) { throw "injected default recovery failure" }
  $global:AiOwnerHarnessAiEnvironment = $false
  return
}
$global:AiOwnerHarnessCalls.Add("install-ai:$VisionAiAcceptanceEvidenceRoot") | Out-Null
$global:AiOwnerHarnessAiEnvironment = $true
if ($global:AiOwnerHarnessFailurePoint -ceq "install") { throw "injected install failure" }
'@ | Set-Content -LiteralPath $installer -Encoding utf8

  $modelRoot = Join-Path $root "model"
  New-Item -ItemType Directory -Path $modelRoot | Out-Null
  Initialize-TestbedAiVisionOwnerContext -RepoRoot $script:repoRoot -RuntimeRoot $script:runtimeRoot -DeploymentRoot $script:deploymentRoot -DaemonDataRoot $script:daemonDataRoot -AcceptanceAuthorityRoot (Join-Path $root "acceptance") -TestOperations $testOperations
  $guestInput = [pscustomobject]@{ runId = "owner-harness"; interactiveUserPassword = "harness-password"; aiVirtualTryOn = [pscustomobject]@{ materializedModelPackRoot = $modelRoot } }
  $short = Restart-TestbedAiVisionOwner -GuestInput $guestInput -EvidencePhase short -ModelPackRoot $modelRoot
  $long = Restart-TestbedAiVisionOwner -GuestInput $guestInput -EvidencePhase long -ModelPackRoot $modelRoot
  Assert-Equal ($global:AiOwnerHarnessCalls -join ",") "stop-task:VEMVisionRuntime,stop-canonical,install-ai:$($short.acceptanceEvidenceRoot),start-task:VEMVisionRuntime,ready,stop-task:VEMVisionRuntime,stop-canonical,install-ai:$($long.acceptanceEvidenceRoot),start-task:VEMVisionRuntime,ready" "managed restart call order"
  if ([string]$short.acceptanceEvidenceRoot -ceq [string]$long.acceptanceEvidenceRoot) { throw "short and long evidence roots overlapped" }

  $global:AiOwnerHarnessCalls.Clear()
  $missing = Restart-TestbedAiDegradedVisionOwner -GuestInput $guestInput -Fault missing
  if ($missing.aiReady -ne $false -or $missing.aiReadinessDiagnostic -cne "model_pack_missing") {
    throw "missing model owner did not expose the public diagnostic"
  }
  if ($global:AiOwnerHarnessAiEnvironment) { throw "missing model owner retained AI environment" }
  $global:AiOwnerHarnessCalls.Clear()
  $corruptRoot = Join-Path $root "corrupt-model"
  New-Item -ItemType Directory -Path $corruptRoot | Out-Null
  $corrupt = Restart-TestbedAiDegradedVisionOwner -GuestInput $guestInput -Fault corrupt -ModelPackRoot $corruptRoot
  if ($corrupt.health.aiReady -ne $false -or $corrupt.health.aiReadinessDiagnostic -cne "model_pack_invalid") { throw "corrupt model owner did not expose the public diagnostic" }
  $corruptCalls = @($global:AiOwnerHarnessCalls)
  Assert-Equal ($corruptCalls -join ",") ("stop-task:VEMVisionRuntime,stop-canonical,install-default,install-corrupt-launcher:" + $corruptRoot + ",start-task:VEMVisionRuntime,ready") "managed corrupt restart call order"
  $global:AiOwnerHarnessCalls.Clear()
  $worker = Restart-TestbedAiDegradedVisionOwner -GuestInput $guestInput -Fault worker -ModelPackRoot $modelRoot
  if ($worker.health.aiReady -ne $false -or $worker.health.aiReadinessDiagnostic -cne "worker_unavailable") { throw "worker failure owner did not expose the public diagnostic" }
  Assert-Equal ($global:AiOwnerHarnessCalls -join ",") ("stop-task:VEMVisionRuntime,stop-canonical,install-ai:$($worker.acceptanceEvidenceRoot),disable-canonical-worker,start-task:VEMVisionRuntime,ready") "managed worker failure restart call order"
  $restoredWorker = Restore-TestbedAiVisionWorkerFault -WorkerFault $worker.workerFault
  if ($global:AiOwnerHarnessWorkerDisabled -or [string]$restoredWorker.workerExecutableSha256 -cne ("a" * 64)) { throw "worker failure restoration did not recover the canonical worker identity" }
  Remove-Item -LiteralPath $worker.acceptanceEvidenceRoot -Recurse -Force -ErrorAction Stop
  $global:AiOwnerHarnessCalls.Clear()
  $global:AiOwnerHarnessFailurePoint = "start"
  $workerFailure = $null
  try { Restart-TestbedAiDegradedVisionOwner -GuestInput $guestInput -Fault worker -ModelPackRoot $modelRoot | Out-Null }
  catch { $workerFailure = $_.Exception.Message }
  if ($workerFailure -notmatch "injected start failure") { throw "worker failure primary error was not preserved: $workerFailure" }
  if ($global:AiOwnerHarnessWorkerDisabled -or -not $global:AiOwnerHarnessDefaultOnline) { throw "worker failure recovery did not restore the canonical worker and default owner" }
  if (($global:AiOwnerHarnessCalls -join ",") -notmatch "disable-canonical-worker,start-task:VEMVisionRuntime,restore-canonical-worker,stop-task:VEMVisionRuntime,stop-canonical,install-default,start-task:VEMVisionRuntime,ready") {
    throw "worker failure recovery order is invalid: $($global:AiOwnerHarnessCalls -join ',')"
  }
  $global:AiOwnerHarnessFailurePoint = $null
  $restored = Restart-TestbedAiVisionOwner -GuestInput $guestInput -EvidencePhase recovery -ModelPackRoot $modelRoot
  if (-not $global:AiOwnerHarnessAiEnvironment) { throw "verified AI owner was not restored after missing model proof" }
  Remove-Item -LiteralPath $restored.acceptanceEvidenceRoot -Recurse -Force -ErrorAction SilentlyContinue

  $failures = [ordered]@{}
  foreach ($failurePoint in @("install", "start", "ready")) {
    $global:AiOwnerHarnessCalls.Clear()
    $global:AiOwnerHarnessFailurePoint = $failurePoint
    $global:AiOwnerHarnessDefaultOnline = $false
    $global:AiOwnerHarnessAiEnvironment = $false
    Remove-Item -LiteralPath $short.acceptanceEvidenceRoot -Recurse -Force -ErrorAction SilentlyContinue
    $failure = $null
    try {
      Restart-TestbedAiVisionOwner -GuestInput $guestInput -EvidencePhase short -ModelPackRoot $modelRoot | Out-Null
    } catch { $failure = $_.Exception.Message }
    if ($failure -notmatch "injected $failurePoint failure") { throw "$failurePoint primary failure was not preserved: $failure" }
    if (-not $global:AiOwnerHarnessDefaultOnline) { throw "$failurePoint recovery did not leave the default owner online" }
    if ($global:AiOwnerHarnessAiEnvironment) { throw "$failurePoint recovery left AI environment enabled" }
    $calls = @($global:AiOwnerHarnessCalls)
    $defaultInstall = [Array]::IndexOf($calls, "install-default")
    if ($defaultInstall -lt 0 -or [Array]::IndexOf($calls, "stop-task:VEMVisionRuntime", 1) -lt 0 -or $calls[-2] -cne "start-task:VEMVisionRuntime" -or $calls[-1] -cne "ready") {
      throw "$failurePoint recovery did not stop, restore, start, and wait: $($calls -join ',')"
    }
    $failures[$failurePoint] = $calls
  }

  $global:AiOwnerHarnessCalls.Clear()
  $global:AiOwnerHarnessFailurePoint = $null
  $global:AiOwnerHarnessStopAfterSideEffectFailure = $true
  Remove-Item -LiteralPath $short.acceptanceEvidenceRoot -Recurse -Force -ErrorAction SilentlyContinue
  $stopFailure = $null
  try {
    Restart-TestbedAiVisionOwner -GuestInput $guestInput -EvidencePhase short -ModelPackRoot $modelRoot | Out-Null
  } catch { $stopFailure = $_.Exception.Message }
  if ($stopFailure -notmatch "stop-after-side-effect") { throw "partial stop primary failure was not preserved: $stopFailure" }
  if (-not $global:AiOwnerHarnessDefaultOnline -or $global:AiOwnerHarnessAiEnvironment) {
    throw "partial stop recovery did not restore the AI-free default owner"
  }
  $failures["partial-stop"] = @($global:AiOwnerHarnessCalls)

  $global:AiOwnerHarnessCalls.Clear()
  $global:AiOwnerHarnessFailurePoint = "install"
  $global:AiOwnerHarnessFailDefaultInstall = $true
  Remove-Item -LiteralPath $short.acceptanceEvidenceRoot -Recurse -Force -ErrorAction SilentlyContinue
  $aggregateFailure = $null
  try {
    Restart-TestbedAiVisionOwner -GuestInput $guestInput -EvidencePhase short -ModelPackRoot $modelRoot | Out-Null
  } catch { $aggregateFailure = $_.Exception.ToString() }
  if ($aggregateFailure -notmatch "injected install failure" -or $aggregateFailure -notmatch "injected default recovery failure") {
    throw "restart did not preserve primary and recovery failures: $aggregateFailure"
  }

  [ordered]@{
    schemaVersion = "vem-ai-owner-restart-harness/v1"
    shortRoot = [string]$short.acceptanceEvidenceRoot
    longRoot = [string]$long.acceptanceEvidenceRoot
    corruptDiagnostic = [string]$corrupt.health.aiReadinessDiagnostic
    corruptCalls = $corruptCalls
    workerFailureDiagnostic = [string]$worker.health.aiReadinessDiagnostic
    failures = $failures
    aggregateFailure = $aggregateFailure
  } | ConvertTo-Json -Depth 6
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
