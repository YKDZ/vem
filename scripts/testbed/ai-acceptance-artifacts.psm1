Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$script:MarkerName = ".vem-ai-acceptance-owner.json"
$script:Schema = "vem.testbed.ai-acceptance-artifact-owner.v1"
$script:SupportSchema = "vem.testbed.ai-virtual-try-on-support.v1"

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
  $marker = Join-Path $Root $script:MarkerName
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) { throw "AI artifact owner marker is missing" }
  $markerItem = Get-Item -LiteralPath $marker -Force
  if (($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "AI artifact owner marker is linked" }
  try {
    $raw = Get-Content -Raw -LiteralPath $marker -Encoding utf8
    $value = $raw | ConvertFrom-Json -ErrorAction Stop
    $actualKeys = @($value.PSObject.Properties | ForEach-Object { $_.Name } | Sort-Object -CaseSensitive) -join "`n"
  } catch { throw "AI artifact owner marker identity is invalid" }
  $expectedKeys = @("facts", "kind", "schemaVersion") -join "`n"
  if ($actualKeys -cne $expectedKeys -or
      [string]$value.schemaVersion -cne $script:SupportSchema -or [string]$value.kind -cne "installed-runtime" -or
      [string]$value.facts.ownerSchema -cne $script:Schema -or [string]$value.facts.runId -cne $RunId -or
      [string]$value.facts.fixtureKey -cne $FixtureKey -or [int]$value.facts.pass -notin @(1, 2) -or
      $raw -cne (Get-TestbedAiArtifactMarkerText $RunId ([int]$value.facts.pass) $FixtureKey)) {
    throw "AI artifact owner marker identity is invalid"
  }
  $allowedLeaf = @(
    $script:MarkerName, "short-attempt.json", "long-attempt.json", "ordinary-sale.json",
    "missing-model-degradation.json", "corrupt-model-degradation.json", "worker-failure-degradation.json", "verified-owner-recovery.json",
    "default-owner-restoration.json"
  )
  foreach ($entry in @(Get-ChildItem -LiteralPath $Root -Force -Recurse)) {
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "AI artifact inventory contains a linked member" }
    $relative = [IO.Path]::GetRelativePath($Root, $entry.FullName).Replace("\", "/")
    if ($entry.PSIsContainer) {
      if ($relative -notin @("regional", "regional/short", "regional/long")) { throw "AI artifact inventory contains a foreign directory: $relative" }
    } elseif ($relative -notin $allowedLeaf -and $relative -cnotmatch '^regional/(short|long)/[0-9a-f-]{36}\.regional-evidence\.json$') {
      throw "AI artifact inventory contains a foreign file: $relative"
    }
  }
  Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction Stop
}

Export-ModuleMember -Function New-TestbedAiAcceptanceArtifactRoot, Remove-TestbedAiAcceptanceArtifactRoot
