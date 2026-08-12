$ErrorActionPreference = "Stop"
$module = Import-Module (Join-Path $PSScriptRoot "ai-acceptance-artifacts.psm1") -Force -PassThru
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-ai-artifacts-" + [guid]::NewGuid().ToString("N"))
function New-Owned([string]$Path) {
  & $module { param($Owned) New-TestbedAiAcceptanceArtifactRoot -Root $Owned -RunId "run-pass-two" -Pass 1 -FixtureKey "aiVirtualTryOn" } $Path | Out-Null
}
function Assert-PreservedFailure([string]$Path, [scriptblock]$Mutate, [string]$Pattern) {
  New-Owned $Path
  & $Mutate $Path
  $message = $null
  try { & $module { param($Owned) Remove-TestbedAiAcceptanceArtifactRoot -Root $Owned -RunId "run-pass-two" -FixtureKey "aiVirtualTryOn" } $Path }
  catch { $message = $_.Exception.Message }
  if ($message -notmatch $Pattern -or -not (Test-Path -LiteralPath $Path)) { throw "owned artifact mutation was not preserved failclosed: $message" }
  Remove-Item -LiteralPath $Path -Recurse -Force
}
try {
  $normal = "$root-normal"
  New-Owned $normal
  & $module { param($Owned) Remove-TestbedAiAcceptanceArtifactRoot -Root $Owned -RunId "run-pass-two" -FixtureKey "aiVirtualTryOn" } $normal
  if (Test-Path -LiteralPath $normal) { throw "normal pass-two cleanup retained owned root" }
  Assert-PreservedFailure "$root-sentinel" { param($path) Set-Content -LiteralPath (Join-Path $path "foreign.txt") -Value foreign } "foreign file"
  Assert-PreservedFailure "$root-marker" { param($path) Set-Content -LiteralPath (Join-Path $path ".vem-ai-acceptance-owner.json") -Value '{}' } "marker identity"
  $target = "$root-target"; New-Item -ItemType Directory -Path $target | Out-Null
  New-Item -ItemType SymbolicLink -Path "$root-link" -Target $target | Out-Null
  $linkedFailure = $null
  try { & $module { param($Owned) Remove-TestbedAiAcceptanceArtifactRoot -Root $Owned -RunId "run-pass-two" -FixtureKey "aiVirtualTryOn" } "$root-link" }
  catch { $linkedFailure = $_.Exception.Message }
  if ($linkedFailure -notmatch "exact regular directory" -or -not (Test-Path -LiteralPath "$root-link")) { throw "linked root was not preserved failclosed: $linkedFailure" }
  [ordered]@{ schemaVersion = "vem-ai-artifact-harness/v1"; ok = $true } | ConvertTo-Json -Compress
} finally {
  foreach ($path in @("$root-normal", "$root-sentinel", "$root-marker", "$root-link", "$root-target")) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue }
}
