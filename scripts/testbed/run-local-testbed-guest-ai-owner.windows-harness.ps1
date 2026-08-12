$ErrorActionPreference = "Stop"

function Assert-Equal($Actual, $Expected, [string]$Message) {
  if ($Actual -cne $Expected) { throw "$Message; expected $Expected, got $Actual" }
}

$guestScript = Join-Path $PSScriptRoot "run-local-testbed-guest.ps1"
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($guestScript, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count -ne 0) { throw "guest script does not parse" }
$restartFunction = @($ast.FindAll({
  param($node)
  $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq "Restart-TestbedAiVisionOwner"
}, $true))
if ($restartFunction.Count -ne 1) { throw "restart helper is not uniquely defined" }
Invoke-Expression $restartFunction[0].Extent.Text

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-ai-owner-restart-" + [guid]::NewGuid().ToString("N"))
$script:repoRoot = Join-Path $root "repo"
$script:runtimeRoot = Join-Path $root "runtime"
$script:deploymentRoot = Join-Path $root "bringup"
$script:daemonDataRoot = Join-Path $root "daemon"
$installer = Join-Path $script:repoRoot "scripts/windows/install-vem-runtime-owners.ps1"
$global:AiOwnerHarnessCalls = [Collections.Generic.List[string]]::new()
$global:AiOwnerHarnessFailAiInstall = $false

function global:Join-Path {
  param([string]$Path, [string]$ChildPath)
  if ($Path -match '^[A-Za-z]:\\') { return ($Path.TrimEnd("\") + "\" + $ChildPath.TrimStart("\")) }
  return [IO.Path]::Combine($Path, $ChildPath)
}

function global:New-TestbedAiVisionOwnerConfiguration {
  param([object]$GuestInput, [ValidateSet("short", "long")][string]$EvidencePhase)
  $path = Join-Path $root "sink-$EvidencePhase"
  New-Item -ItemType Directory -Path $path | Out-Null
  return [ordered]@{ modelPackRoot = [string]$GuestInput.aiVirtualTryOn.materializedModelPackRoot; acceptanceEvidenceRoot = $path; phase = $EvidencePhase }
}
function global:Get-TestbedKioskPassword { return "harness-password" }
function global:Stop-ScheduledTask { param([string]$TaskName, $ErrorAction) $global:AiOwnerHarnessCalls.Add("stop-task:$TaskName") | Out-Null }
function global:Stop-TestbedCanonicalVision { param([string]$AppDirectory, [string]$ConfigurationPath) $global:AiOwnerHarnessCalls.Add("stop-canonical") | Out-Null }
function global:Get-TestbedCanonicalVisionProcesses { return [pscustomobject]@{ managed = @(); unknown = @() } }
function global:Assert-TestbedNoUnknownCanonicalVisionProcesses { param([object]$VisionProcesses) }
function global:Get-TestbedProcessTreeIds { return @() }
function global:Get-Process { return $null }
function global:Get-NetTCPConnection { return @() }
function global:Start-ScheduledTask { param([string]$TaskName, $ErrorAction) $global:AiOwnerHarnessCalls.Add("start-task:$TaskName") | Out-Null }
function global:Wait-TestbedVisionReady { $global:AiOwnerHarnessCalls.Add("ready") | Out-Null; return [pscustomobject]@{ ok = $true } }

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
  return
}
$global:AiOwnerHarnessCalls.Add("install-ai:$VisionAiAcceptanceEvidenceRoot") | Out-Null
if ($global:AiOwnerHarnessFailAiInstall) { throw "injected AI install failure" }
'@ | Set-Content -LiteralPath $installer -Encoding utf8

  $modelRoot = Join-Path $root "model"
  New-Item -ItemType Directory -Path $modelRoot | Out-Null
  $guestInput = [pscustomobject]@{ aiVirtualTryOn = [pscustomobject]@{ materializedModelPackRoot = $modelRoot } }
  $short = Restart-TestbedAiVisionOwner -GuestInput $guestInput -EvidencePhase short -ModelPackRoot $modelRoot
  $long = Restart-TestbedAiVisionOwner -GuestInput $guestInput -EvidencePhase long -ModelPackRoot $modelRoot
  Assert-Equal ($global:AiOwnerHarnessCalls -join ",") "stop-task:VEMVisionRuntime,stop-canonical,install-ai:$($short.acceptanceEvidenceRoot),start-task:VEMVisionRuntime,ready,stop-task:VEMVisionRuntime,stop-canonical,install-ai:$($long.acceptanceEvidenceRoot),start-task:VEMVisionRuntime,ready" "managed restart call order"
  if ([string]$short.acceptanceEvidenceRoot -ceq [string]$long.acceptanceEvidenceRoot) { throw "short and long evidence roots overlapped" }

  $global:AiOwnerHarnessCalls.Clear()
  $global:AiOwnerHarnessFailAiInstall = $true
  Remove-Item -LiteralPath $short.acceptanceEvidenceRoot -Recurse -Force
  $failure = $null
  try {
    Restart-TestbedAiVisionOwner -GuestInput $guestInput -EvidencePhase short -ModelPackRoot $modelRoot | Out-Null
  } catch { $failure = $_.Exception.Message }
  Assert-Equal ($global:AiOwnerHarnessCalls -join ",") "stop-task:VEMVisionRuntime,stop-canonical,install-ai:$($short.acceptanceEvidenceRoot),install-default" "failed restart fallback order"
  if ($failure -notmatch "injected AI install failure") { throw "restart failure was not preserved" }

  [ordered]@{
    schemaVersion = "vem-ai-owner-restart-harness/v1"
    shortRoot = [string]$short.acceptanceEvidenceRoot
    longRoot = [string]$long.acceptanceEvidenceRoot
    fallback = @($global:AiOwnerHarnessCalls)
  } | ConvertTo-Json -Depth 6
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
