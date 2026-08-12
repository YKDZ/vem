param(
  [Parameter(Mandatory = $true)][string]$GuestInputPath,
  [Parameter(Mandatory = $true)][string]$HandoffPath,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [Parameter(Mandatory = $true)][string]$FixtureKey
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

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

throw "AI virtual try-on installed acceptance execution is not implemented; verified inputs were not consumed and no report was emitted"
