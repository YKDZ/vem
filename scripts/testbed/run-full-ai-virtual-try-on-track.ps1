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

function Get-RegularDirectoryIdentity([string]$Path, [bool]$Nested, [string]$Label) {
  Require-AbsoluteDirectory $Path $Label
  $files = @(Get-ChildItem -LiteralPath $Path -File -Recurse -Force)
  $directories = @(Get-ChildItem -LiteralPath $Path -Directory -Recurse -Force)
  if (@($files + $directories | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) { throw "$Label must not contain reparse points" }
  if (-not $Nested -and $directories.Count -ne 0) { throw "$Label must contain direct regular files only" }
  return @($files | ForEach-Object {
    [ordered]@{ name = [IO.Path]::GetRelativePath($Path, $_.FullName).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant(); byteSize = [long]$_.Length }
  } | Sort-Object name)
}

function Assert-GuestFileIdentity([string]$Path, [object]$Identity, [string]$Label) {
  Require-AbsoluteLeaf $Path $Label
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne [string]$Identity.sha256 -or (Get-Item -LiteralPath $Path).Length -ne [long]$Identity.byteSize) { throw "$Label identity is invalid" }
}

function Assert-GuestDirectoryIdentity([string]$Path, [object]$Identity, [bool]$Nested, [string]$Label) {
  $actual = @(Get-RegularDirectoryIdentity $Path $Nested $Label)
  $expected = @($Identity.members | ForEach-Object { [ordered]@{ name = [string]$_.name; sha256 = [string]$_.sha256; byteSize = [long]$_.byteSize } } | Sort-Object name)
  if (($actual | ConvertTo-Json -Compress -Depth 4) -cne ($expected | ConvertTo-Json -Compress -Depth 4)) { throw "$Label member identities are invalid" }
  $bytes = [long]($actual | Measure-Object -Property byteSize -Sum).Sum
  if ($bytes -ne [long]$Identity.byteSize) { throw "$Label byte size is invalid" }
  $lines = @($actual | ForEach-Object { "$($_.name)`0$($_.sha256)`0$($_.byteSize)`n" }) -join ""
  $sha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($lines))).ToLowerInvariant()
  if ($sha -cne [string]$Identity.sha256) { throw "$Label aggregate identity is invalid" }
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
Require-AbsoluteLeaf ([string]$inputs.acceptanceAuthorityReceipt) "installed Windows acceptance authority receipt"
$phase = [string]$inputs.phase
if ($phase -notin @("measurement", "formal")) { throw "installed AI acceptance phase is invalid" }
if ($phase -eq "formal") {
  Require-AbsoluteLeaf ([string]$inputs.calibratedRegionalPolicy) "calibrated AI regional evidence policy"
  Require-AbsoluteLeaf ([string]$inputs.calibrationReceipt) "calibrated AI regional evidence receipt"
  Require-AbsoluteDirectory ([string]$inputs.calibrationSourceInput) "calibration source bundle"
}

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

$authority = Get-Content -Raw -LiteralPath ([string]$inputs.acceptanceAuthorityReceipt) -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
if ([string]$authority.schemaVersion -cne "vem.testbed.ai-acceptance-authority/v1" -or [string]$authority.scope -cne "installed_windows_acceptance" -or [string]$authority.trustStatus -cne "verified_for_acceptance") {
  throw "installed Windows acceptance authority receipt identity is invalid"
}
$installedVision = $guestInput.workflowIdentity.visionCore
if ($null -eq $installedVision -or
  [string]$installedVision.runtimeArchive.sha256 -cne [string]$authority.candidate.subjectSha256 -or
  [string]$installedVision.runtimeArchive.sourceCommit -cne [string]$authority.candidate.sourceCommit -or
  [string]$installedVision.recordedFixtureArchive.sha256 -cne [string]$authority.companion.archiveSha256 -or
  [string]$installedVision.recordedFixtureArchive.sourceCommit -cne [string]$authority.companion.sourceCommit) {
  throw "installed Vision core identity does not match acceptance authority"
}

Require-AbsoluteLeaf ([string]$inputs.installedVisionRuntimeArchive) "installed Vision runtime archive"
Require-AbsoluteLeaf ([string]$inputs.recordedFixtureArchive) "recorded front/top fixture archive"
Require-AbsoluteLeaf ([string]$inputs.modelPackArchive) "official model pack archive"

$modelPackSource = [string]$inputs.modelPackSource
if ($modelPackSource -cne "host-local-cache" -and [string]$inputs.modelPackUrl -notmatch '^https://') { throw "official model URL must use HTTPS" }
if ($modelPackSource -notin @("host-local-cache", "host-controlled-https")) { throw "official model source is invalid" }
if ([string]$inputs.modelPackSha256 -notmatch '^[a-f0-9]{64}$') { throw "official model SHA-256 is invalid" }
if ($inputs.modelPackByteSize -isnot [long] -or [long]$inputs.modelPackByteSize -le 0) { throw "official model byte size is invalid" }
if ([string]$inputs.modelPackSha256 -cne [string]$authority.modelPack.archive.sha256 -or [long]$inputs.modelPackByteSize -ne [long]$authority.modelPack.archive.byteSize) {
  throw "materialized model pack does not match acceptance authority"
}

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
$identities = $inputs.identities
Assert-GuestDirectoryIdentity ([string]$inputs.candidateInputDirectory) $identities.candidateInput $false "candidate exact-four input"
Assert-GuestDirectoryIdentity ([string]$inputs.windowsProofInputDirectory) $identities.windowsProofInput $false "companion proof exact-three input"
Assert-GuestFileIdentity ([string]$inputs.acceptanceAuthorityReceipt) $identities.acceptanceAuthorityReceipt "installed Windows acceptance authority receipt"
if ($phase -eq "formal") {
  Assert-GuestFileIdentity ([string]$inputs.calibratedRegionalPolicy) $identities.calibratedRegionalPolicy "calibrated AI regional evidence policy"
  Assert-GuestFileIdentity ([string]$inputs.calibrationReceipt) $identities.calibrationReceipt "calibrated AI regional evidence receipt"
  Assert-GuestDirectoryIdentity ([string]$inputs.calibrationSourceInput) $identities.calibrationSourceInput $true "calibration source bundle"
}
Assert-GuestFileIdentity ([string]$inputs.installedVisionRuntimeArchive) $identities.installedVisionRuntimeArchive "installed Vision runtime archive"
Assert-GuestFileIdentity ([string]$inputs.recordedFixtureArchive) $identities.recordedFixtureArchive "recorded front/top fixture archive"
Assert-GuestFileIdentity ([string]$inputs.modelPackArchive) $identities.modelPackArchive "official model pack archive"
Assert-GuestDirectoryIdentity $modelPackRoot $identities.materializedModelPackRoot $true "materialized official model pack"
([ordered]@{ schemaVersion = "vem.testbed.ai-input-identity/v1"; manifestSha256 = [string]$identities.manifestSha256; identities = $identities } | ConvertTo-Json -Depth 12) | Set-Content -LiteralPath (Join-Path $artifactRoot "validated-input-identity.json") -Encoding utf8
$shortFacts = Join-Path $artifactRoot "short-attempt.json"
$longFacts = Join-Path $artifactRoot "long-attempt.json"
$saleFacts = Join-Path $artifactRoot "ordinary-sale.json"
$missingFacts = Join-Path $artifactRoot "missing-model-degradation.json"
$corruptFacts = Join-Path $artifactRoot "corrupt-model-degradation.json"
$workerFailureFacts = Join-Path $artifactRoot "worker-failure-degradation.json"
$verifiedRecoveryFacts = Join-Path $artifactRoot "verified-owner-recovery.json"
$nodeEntry = Join-Path $PSScriptRoot "ai-virtual-try-on-installed-entry.mjs"
$restorationRequired = $false
$restorationSupport = Join-Path $artifactRoot "default-owner-restoration.json"
$trackSucceeded = $false
$verifiedConfiguration = $null
$corruptConfiguration = $null
$corruptOwnership = $null
$workerFailureConfiguration = $null
$workerFault = $null
$restoredWorker = $null
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
  $workerFailureConfiguration = Restart-TestbedAiDegradedVisionOwner -GuestInput $guestInput -Fault worker -ModelPackRoot $modelPackRoot
  $workerFault = $workerFailureConfiguration.workerFault
  node $nodeEntry degradation --fault worker --guest-input $GuestInputPath --handoff $HandoffPath --out $workerFailureFacts
  if ($LASTEXITCODE -ne 0) { throw "worker failure installed degradation failed" }
  $restoredWorker = Restore-TestbedAiVisionWorkerFault -WorkerFault $workerFault
  $workerFault = $null
  $restoredConfiguration = Restart-TestbedAiVisionOwner -GuestInput $guestInput -EvidencePhase recovery -ModelPackRoot $modelPackRoot
  $verifiedConfiguration = $restoredConfiguration
  if ($null -eq $restoredWorker -or [string]$restoredWorker.workerExecutableSha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw "restored installed AI worker identity is invalid"
  }
  [ordered]@{
    facts = [ordered]@{ recovery = [ordered]@{
      aiReadinessDiagnostic = [string]$restoredConfiguration.health.aiReadinessDiagnostic
      aiReady = [bool]$restoredConfiguration.health.aiReady
      modelPackSha256 = [string]$authority.modelPack.archive.sha256
      runtimeDescriptorSha256 = [string]$authority.resources.runtimeDescriptorSha256
      sourceCommit = [string]$authority.candidate.sourceCommit
      workerExecutableSha256 = [string]$restoredWorker.workerExecutableSha256
    } }
    kind = "installed-runtime"
    schemaVersion = "vem.testbed.ai-virtual-try-on-support.v1"
  } | ConvertTo-Json -Compress -Depth 8 | ForEach-Object { [IO.File]::WriteAllText($verifiedRecoveryFacts, "$_`n", [Text.UTF8Encoding]::new($false)) }
  $assemble = @("assemble", "--artifact-root", $artifactRoot, "--candidate-input-directory", [string]$inputs.candidateInputDirectory, "--windows-proof-input-directory", [string]$inputs.windowsProofInputDirectory)
  if ($phase -eq "formal") {
    $assemble += @("--calibrated-policy", [string]$inputs.calibratedRegionalPolicy, "--calibration-receipt", [string]$inputs.calibrationReceipt, "--calibration-source-input", (Join-Path ([string]$inputs.calibrationSourceInput) "calibration-source-input.json"))
  }
  $assemble += @("--short-attempt", $shortFacts, "--long-attempt", $longFacts, "--sale", $saleFacts, "--missing-degradation", $missingFacts, "--corrupt-degradation", $corruptFacts, "--worker-failure-degradation", $workerFailureFacts, "--recovery", $verifiedRecoveryFacts, "--out", $OutPath)
  node $nodeEntry @assemble
  if ($LASTEXITCODE -ne 0) { throw "installed AI acceptance assembly failed" }
  if ($phase -eq "measurement") {
    $measurementEntry = Join-Path $PSScriptRoot "run-ai-regional-measurement.mjs"
    $measurementOutput = Join-Path $artifactRoot "ai-regional-measurement.json"
    $measurementSource = Join-Path $artifactRoot "calibration-source"
    node $measurementEntry --report $OutPath --artifact-root $artifactRoot --acceptance-authority-receipt ([string]$inputs.acceptanceAuthorityReceipt) --release-proof (Join-Path ([string]$inputs.windowsProofInputDirectory) "precutover-ai-proof.json") --recovery-support $verifiedRecoveryFacts --source-root $measurementSource --out $measurementOutput
    if ($LASTEXITCODE -ne 0) { throw "installed AI regional measurement collection failed" }
  }
  $trackSucceeded = $true
} catch {
  $trackFailure = $_.Exception
} finally {
  $cleanupFailures = [Collections.Generic.List[Exception]]::new()
  try {
    if ($restorationRequired) {
      if ($null -ne $workerFault) {
        $restoredWorker = Restore-TestbedAiVisionWorkerFault -WorkerFault $workerFault
        $workerFault = $null
      }
      $restored = Restore-TestbedDefaultVisionOwner -GuestInput $guestInput
      if ($null -ne $verifiedConfiguration) {
        Remove-Item -LiteralPath ([string]$verifiedConfiguration.acceptanceEvidenceRoot) -Recurse -Force -ErrorAction Stop
      }
      if ($null -ne $corruptConfiguration) {
        Remove-Item -LiteralPath ([string]$corruptConfiguration.acceptanceEvidenceRoot) -Recurse -Force -ErrorAction Stop
      }
      if ($null -ne $workerFailureConfiguration) {
        Remove-Item -LiteralPath ([string]$workerFailureConfiguration.acceptanceEvidenceRoot) -Recurse -Force -ErrorAction Stop
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
exit 0
