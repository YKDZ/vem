Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:MarkerName = ".vem-ai-acceptance-owner.json"
$script:Schema = "vem.testbed.ai-acceptance-artifact-owner.v1"
$script:SupportSchema = "vem.testbed.ai-virtual-try-on-support.v1"

function Get-ContainedRelativePath([string]$Root, [string]$Path, [string]$Label) {
  $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar))
  $normalizedPath = [IO.Path]::GetFullPath($Path)
  $prefix = $normalizedRoot + [IO.Path]::DirectorySeparatorChar
  if (-not $normalizedPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be contained by its root"
  }
  return $normalizedPath.Substring($prefix.Length)
}

function Assert-TestbedAiArtifactIdentity([string]$RunId, [int]$Pass, [string]$FixtureKey) {
  if ($RunId -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$') { throw "AI artifact owner runId is invalid" }
  if ($Pass -notin @(1, 2)) { throw "AI artifact owner pass is invalid" }
  if ($FixtureKey -cne "aiVirtualTryOn") { throw "AI artifact owner fixture is invalid" }
}

function Get-TestbedAiArtifactMarkerText([string]$RunId, [int]$Pass, [string]$FixtureKey) {
  return ([ordered]@{
    facts = [ordered]@{
      fixtureKey = $FixtureKey
      ownerSchema = $script:Schema
      pass = $Pass
      runId = $RunId
    }
    kind = "installed-runtime"
    schemaVersion = $script:SupportSchema
  } | ConvertTo-Json -Compress) + "`n"
}

function New-TestbedAiAcceptanceArtifactRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][int]$Pass,
    [Parameter(Mandatory = $true)][string]$FixtureKey
  )
  Assert-TestbedAiArtifactIdentity $RunId $Pass $FixtureKey
  if (-not [IO.Path]::IsPathFullyQualified($Root) -or (Test-Path -LiteralPath $Root)) {
    throw "AI acceptance artifact root must be a fresh absolute path"
  }
  New-Item -ItemType Directory -Path $Root | Out-Null
  $item = Get-Item -LiteralPath $Root -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "AI acceptance artifact root is not a regular directory"
  }
  $marker = Join-Path $Root $script:MarkerName
  [IO.File]::WriteAllText($marker, (Get-TestbedAiArtifactMarkerText $RunId $Pass $FixtureKey), [Text.UTF8Encoding]::new($false))
  return $marker
}

function Remove-TestbedAiAcceptanceArtifactRoot {
  param(
    [Parameter(Mandatory = $true)][string]$Root,
    [Parameter(Mandatory = $true)][string]$RunId,
    [Parameter(Mandatory = $true)][string]$FixtureKey
  )
  if (-not (Test-Path -LiteralPath $Root)) { return }
  if (-not [IO.Path]::IsPathFullyQualified($Root)) { throw "AI artifact cleanup root must be absolute" }
  $rootItem = Get-Item -LiteralPath $Root -Force
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
      [IO.Path]::GetFullPath($rootItem.FullName) -cne [IO.Path]::GetFullPath($Root)) {
    throw "AI artifact cleanup root is not the exact regular directory"
  }
  Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction Stop
}

function Complete-TestbedAiAcceptanceArtifacts {
  param(
    [Parameter(Mandatory = $true)][string]$OutPath,
    [Parameter(Mandatory = $true)][bool]$TrackSucceeded
  )
  if ($TrackSucceeded) { return }
  Remove-Item -LiteralPath $OutPath -Force -ErrorAction SilentlyContinue
}

Export-ModuleMember -Function New-TestbedAiAcceptanceArtifactRoot, Remove-TestbedAiAcceptanceArtifactRoot, Complete-TestbedAiAcceptanceArtifacts
