param(
  [Parameter(Mandatory = $true)][string]$GuestInputPath,
  [Parameter(Mandatory = $true)][string]$HandoffPath,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [Parameter(Mandatory = $true)][string]$FixtureKey
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
Import-Module (Join-Path $PSScriptRoot "ai-vision-owner.psm1") -Force
Import-Module (Join-Path $PSScriptRoot "ai-acceptance-artifacts.psm1") -Force
Import-Module (Join-Path $PSScriptRoot "ai-corrupt-model-pack.psm1") -Force

function Require-AbsoluteLeaf([string]$Path, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathFullyQualified($Path)) {
    throw "$Label is required as an absolute path"
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing"
  }
}

function Require-AbsoluteDirectory([string]$Path, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathFullyQualified($Path)) {
    throw "$Label is required as an absolute path"
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    throw "$Label is missing"
  }
}

function Require-ExactRegularMembers([string]$Path, [string[]]$Names, [string]$Label) {
  $entries = @(Get-ChildItem -LiteralPath $Path -Force)
  $actual = @($entries | ForEach-Object { $_.Name } | Sort-Object -CaseSensitive)
  $expected = @($Names | Sort-Object -CaseSensitive)
  if (($actual -join "`n") -cne ($expected -join "`n")) { throw "$Label member set is invalid" }
  if (@($entries | Where-Object { -not $_.PSIsContainer -and ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0 }).Count -ne $Names.Count) {
    throw "$Label members must be regular files"
  }
}

Require-AbsoluteLeaf $GuestInputPath "guest input"
Require-AbsoluteLeaf $HandoffPath "runtime handoff"
if ($FixtureKey -cne "aiVirtualTryOn") { throw "AI fixture key is invalid" }

$guestInput = Get-Content -Raw -LiteralPath $GuestInputPath -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
$inputsProperty = $guestInput.PSObject.Properties["aiVirtualTryOn"]
$inputs = if ($null -eq $inputsProperty) { $null } else { $inputsProperty.Value }
if ($null -eq $inputs) { throw "candidate exact-four input directory is required" }

Require-AbsoluteDirectory ([string]$inputs.candidateInputDirectory) "candidate exact-four input directory"
Require-AbsoluteDirectory ([string]$inputs.windowsProofInputDirectory) "companion proof exact-three input directory"
Require-AbsoluteLeaf ([string]$inputs.approvedPrecutoverReceipt) "B2 approved receipt"

$candidateArchives = @(Get-ChildItem -LiteralPath ([string]$inputs.candidateInputDirectory) -File | Where-Object { $_.Extension -ceq ".zip" })
if ($candidateArchives.Count -ne 1) { throw "candidate exact-four archive set is invalid" }
Require-ExactRegularMembers ([string]$inputs.candidateInputDirectory) @(
  [string]$candidateArchives[0].Name,
  "candidate-manifest.json",
  "github-build-provenance.sigstore.json",
  "trusted-builder-evidence.json"
) "candidate exact-four input"
Require-ExactRegularMembers ([string]$inputs.windowsProofInputDirectory) @(
    "precutover-ai-proof.json",
    "precutover-ai-proof.sigstore.json",
    "trusted-precutover-proof-evidence.json"
) "companion proof exact-three input"

$approved = Get-Content -Raw -LiteralPath ([string]$inputs.approvedPrecutoverReceipt) -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
if ([string]$approved.schemaVersion -cne "vem.precutover.ai.v2" -or [string]$approved.trustStatus -cne "pending_final_aggregate_approval") {
  throw "B2 approved receipt identity is invalid"
}

Require-AbsoluteLeaf ([string]$inputs.installedVisionRuntimeArchive) "installed Vision runtime archive"
Require-AbsoluteLeaf ([string]$inputs.recordedFixtureArchive) "recorded front/top fixture archive"

if ([string]$inputs.modelPackUrl -notmatch '^https://') { throw "official model URL must use HTTPS" }
if ([string]$inputs.modelPackSha256 -notmatch '^[a-f0-9]{64}$') { throw "official model SHA-256 is invalid" }
if ($inputs.modelPackByteSize -isnot [long] -or [long]$inputs.modelPackByteSize -le 0) { throw "official model byte size is invalid" }

Initialize-TestbedAiVisionOwnerContext `
  -RepoRoot $repoRoot `
  -RuntimeRoot "C:\ProgramData\VEM" `
  -DeploymentRoot "C:\VEM\bringup" `
  -DaemonDataRoot "C:\ProgramData\VEM\vending-daemon"

$modelPackRoot = [string]$inputs.materializedModelPackRoot
Require-AbsoluteDirectory $modelPackRoot "materialized official model pack"
$artifactRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($OutPath)) "ai-virtual-try-on-artifacts"))
$pass = if ($guestInput.workflowIdentity.pass) { [int]$guestInput.workflowIdentity.pass } else { 1 }
New-TestbedAiAcceptanceArtifactRoot -Root $artifactRoot -RunId ([string]$guestInput.runId) -Pass $pass -FixtureKey $FixtureKey | Out-Null
$shortFacts = Join-Path $artifactRoot "short-attempt.json"
$longFacts = Join-Path $artifactRoot "long-attempt.json"
$saleFacts = Join-Path $artifactRoot "ordinary-sale.json"
$missingFacts = Join-Path $artifactRoot "missing-model-degradation.json"
$corruptFacts = Join-Path $artifactRoot "corrupt-model-degradation.json"
$verifiedRecoveryFacts = Join-Path $artifactRoot "verified-owner-recovery.json"
$nodeEntry = Join-Path $PSScriptRoot "ai-virtual-try-on-installed-entry.mjs"
$restorationRequired = $false
$restorationSupport = Join-Path $artifactRoot "default-owner-restoration.json"
$trackSucceeded = $false
$verifiedConfiguration = $null
$corruptConfiguration = $null
$corruptOwnership = $null
$trackFailure = $null
try {
  # The first stop is a mutating operation; restoration is required before it.
  $restorationRequired = $true
  $shortConfiguration = Restart-TestbedAiVisionOwner -GuestInput $guestInput -EvidencePhase short -ModelPackRoot $modelPackRoot
  node $nodeEntry attempt --case short --guest-input $GuestInputPath --handoff $HandoffPath --regional-root ([string]$shortConfiguration.acceptanceEvidenceRoot) --artifact-root $artifactRoot --out $shortFacts
  if ($LASTEXITCODE -ne 0) { throw "short installed AI attempt failed" }
  $longConfiguration = Restart-TestbedAiVisionOwner -GuestInput $guestInput -EvidencePhase long -ModelPackRoot $modelPackRoot
  node $nodeEntry attempt --case long --guest-input $GuestInputPath --handoff $HandoffPath --regional-root ([string]$longConfiguration.acceptanceEvidenceRoot) --artifact-root $artifactRoot --out $longFacts
  if ($LASTEXITCODE -ne 0) { throw "long installed AI attempt failed" }
  node $nodeEntry sale --guest-input $GuestInputPath --handoff $HandoffPath --out $saleFacts
  if ($LASTEXITCODE -ne 0) { throw "ordinary installed-owner sale failed" }
  Restart-TestbedAiDegradedVisionOwner -GuestInput $guestInput -Fault missing | Out-Null
  node $nodeEntry degradation --fault missing --guest-input $GuestInputPath --handoff $HandoffPath --out $missingFacts
  if ($LASTEXITCODE -ne 0) { throw "missing model installed degradation failed" }
  $corruptModelRoot = Join-Path (Split-Path -Parent $modelPackRoot) ("ai-acceptance-corrupt-" + [string]$guestInput.runId + "-pass-" + $pass)
  $corruptOwnership = New-TestbedCorruptModelPackClone -SourceRoot $modelPackRoot -VisionAppDirectory "C:\VEM\vision\app" -VisionDataDirectory "C:\ProgramData\VEM\vision" -DestinationRoot $corruptModelRoot -RunId ([string]$guestInput.runId)
  $corruptConfiguration = Restart-TestbedAiDegradedVisionOwner -GuestInput $guestInput -Fault corrupt -ModelPackRoot ([string]$corruptOwnership.cloneRoot)
  node $nodeEntry degradation --fault corrupt --guest-input $GuestInputPath --handoff $HandoffPath --out $corruptFacts
  if ($LASTEXITCODE -ne 0) { throw "corrupt model installed degradation failed" }
  $restoredConfiguration = Restart-TestbedAiVisionOwner -GuestInput $guestInput -EvidencePhase recovery -ModelPackRoot $modelPackRoot
  $verifiedConfiguration = $restoredConfiguration
  $windowsProof = Get-Content -Raw -LiteralPath (Join-Path ([string]$inputs.windowsProofInputDirectory) "precutover-ai-proof.json") -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
  [ordered]@{
    facts = [ordered]@{ recovery = [ordered]@{
      aiReadinessDiagnostic = "ready"
      aiReady = $true
      modelPackSha256 = [string]$windowsProof.modelPack.archive.sha256
      runtimeDescriptorSha256 = [string]$windowsProof.resources.runtimeDescriptorSha256
      sourceCommit = [string]$windowsProof.candidate.sourceCommit
      workerExecutableSha256 = [string]$windowsProof.candidate.workerExecutableSha256
    } }
    kind = "installed-runtime"
    schemaVersion = "vem.testbed.ai-virtual-try-on-support.v1"
  } | ConvertTo-Json -Compress -Depth 8 | ForEach-Object { [IO.File]::WriteAllText($verifiedRecoveryFacts, "$_`n", [Text.UTF8Encoding]::new($false)) }
  node $nodeEntry assemble --artifact-root $artifactRoot --candidate-input-directory ([string]$inputs.candidateInputDirectory) --windows-proof-input-directory ([string]$inputs.windowsProofInputDirectory) --short-attempt $shortFacts --long-attempt $longFacts --sale $saleFacts --missing-degradation $missingFacts --corrupt-degradation $corruptFacts --recovery $verifiedRecoveryFacts --out $OutPath
  if ($LASTEXITCODE -ne 0) { throw "installed AI acceptance assembly failed" }
  $trackSucceeded = $true
} catch {
  $trackFailure = $_.Exception
} finally {
  $cleanupFailures = [Collections.Generic.List[Exception]]::new()
  try {
    if ($restorationRequired) {
      $restored = Restore-TestbedDefaultVisionOwner -GuestInput $guestInput
      if ($null -ne $verifiedConfiguration) {
        Remove-Item -LiteralPath ([string]$verifiedConfiguration.acceptanceEvidenceRoot) -Recurse -Force -ErrorAction Stop
      }
      if ($null -ne $corruptConfiguration) {
        Remove-Item -LiteralPath ([string]$corruptConfiguration.acceptanceEvidenceRoot) -Recurse -Force -ErrorAction Stop
      }
      if ($null -ne $corruptOwnership) { Remove-TestbedCorruptModelPackClone $corruptOwnership }
      [ordered]@{
        facts = [ordered]@{
          aiEnvironmentCleared = $true
          owner = $restored
        }
        kind = "installed-runtime"
        schemaVersion = "vem.testbed.ai-virtual-try-on-support.v1"
      } | ConvertTo-Json -Compress -Depth 12 | ForEach-Object { [IO.File]::WriteAllText($restorationSupport, "$_`n", [Text.UTF8Encoding]::new($false)) }
    }
  } catch {
    Remove-Item -LiteralPath $OutPath -Force -ErrorAction SilentlyContinue
    $cleanupFailures.Add($_.Exception)
  }
  if (-not $trackSucceeded) {
    Remove-Item -LiteralPath $OutPath -Force -ErrorAction SilentlyContinue
    try { Remove-TestbedAiAcceptanceArtifactRoot -Root $artifactRoot -RunId ([string]$guestInput.runId) -FixtureKey $FixtureKey }
    catch { $cleanupFailures.Add($_.Exception) }
  }
  if ($cleanupFailures.Count -gt 0) {
    if ($null -ne $trackFailure) {
      throw [AggregateException]::new("AI track and cleanup both failed", @($trackFailure) + @($cleanupFailures))
    }
    if ($cleanupFailures.Count -eq 1) { throw $cleanupFailures[0] }
    throw [AggregateException]::new("AI track cleanup failed", @($cleanupFailures))
  }
}
if ($null -ne $trackFailure) { throw $trackFailure }
Write-Error "installed worker failure probe not executed; AI regional evidence policy awaits Issue10 two-garment calibration" -ErrorAction Continue
exit 1
