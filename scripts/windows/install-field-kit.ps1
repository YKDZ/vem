[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$StagingDirectory,
  [Parameter(Mandatory = $true)][string]$KioskPassword,
  [string]$VisionSiteSource = "C:\ProgramData\VEM\vision\site.json"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Assert-Hash([string]$Path, [string]$Expected, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "missing $Label : $Path" }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne $Expected) { throw "$Label digest mismatch: $Path" }
  Write-Output ("OK  {0}" -f $Label)
}

Write-Output "== Step 1/4: verify kit manifest and members =="
$kitManifestPath = Join-Path $StagingDirectory "vem-field-kit-manifest.json"
$kit = Get-Content -Raw -LiteralPath $kitManifestPath -Encoding UTF8 | ConvertFrom-Json
if ($kit.schemaVersion -cne "vem-field-kit/v1") { throw "invalid field kit manifest" }
foreach ($member in @($kit.members)) {
  Assert-Hash (Join-Path $StagingDirectory $member.name) ([string]$member.sha256) ([string]$member.name)
}
$runtimeCommit = [string]$kit.vemCommit

Write-Output "== Step 2/4: preserve physical DirectShow site.json =="
if (-not (Test-Path -LiteralPath $VisionSiteSource -PathType Leaf)) {
  throw "physical Vision site.json is missing: $VisionSiteSource"
}
Copy-Item -LiteralPath $VisionSiteSource -Destination (Join-Path $StagingDirectory "site.json") -Force

Write-Output "== Step 3/4: deploy runtime owners and Vision =="
& (Join-Path $StagingDirectory "install-vision-main-artifact.ps1") `
  -RuntimeArchive (Join-Path $StagingDirectory "vending-vision-windows-x86_64.zip") `
  -Commit ([string]$kit.visionCommit) `
  -SiteConfigurationPath (Join-Path $StagingDirectory "site.json") `
  -SkipRuntimeOwnerTask | Out-Null
& (Join-Path $StagingDirectory "install-vem-runtime-owners.ps1") `
  -RuntimeDirectory "C:\VEM\bringup" `
  -DaemonDataDirectory "C:\ProgramData\VEM\vending-daemon" `
  -KioskPassword $KioskPassword `
  -OwnerManifestPath "C:\ProgramData\VEM\runtime-owners\owner-manifest.json" | Out-Null

Write-Output "== Step 4/4: runtime probe =="
& (Join-Path $StagingDirectory "probe-vem-runtime.ps1") `
  -DaemonDataDirectory "C:\ProgramData\VEM\vending-daemon" `
  -OwnerManifestPath "C:\ProgramData\VEM\runtime-owners\owner-manifest.json" `
  -RequireHealthy | Out-Null

[ordered]@{
  schemaVersion = "vem-field-kit-install/v1"
  vemCommit = $runtimeCommit
  visionCommit = [string]$kit.visionCommit
  ownerManifest = "C:\ProgramData\VEM\runtime-owners\owner-manifest.json"
} | ConvertTo-Json -Depth 8
