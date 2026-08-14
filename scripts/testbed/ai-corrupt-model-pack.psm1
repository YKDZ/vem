Set-StrictMode -Version 2.0

$script:OwnedCorruptModelPacks = @{}

function Get-RegularCorruptModelPackDirectory([string]$Path, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
    throw "$Label must be an absolute directory"
  }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Label must be a regular non-reparse directory"
  }
  return [IO.Path]::GetFullPath($item.FullName).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Get-RegularCorruptModelPackFile([string]$Path, [string]$Label) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Label must be a regular non-reparse file"
  }
  return [IO.Path]::GetFullPath($item.FullName)
}

function Test-CorruptModelPackBytes([byte[]]$Expected, [byte[]]$Actual) {
  if ($Expected.Length -ne $Actual.Length) { return $false }
  for ($index = 0; $index -lt $Expected.Length; $index += 1) {
    if ($Expected[$index] -ne $Actual[$index]) { return $false }
  }
  return $true
}

function New-TestbedCorruptModelPack {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [Parameter(Mandatory = $true)][string]$RunId
  )
  if ($RunId -cnotmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$") { throw "corrupt model pack run identity is invalid" }
  $sourceRoot = Get-RegularCorruptModelPackDirectory $SourceRoot "corrupt model pack source"
  $cloneRoot = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $sourceParent = [IO.Path]::GetFullPath((Split-Path -Parent $sourceRoot)).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $cloneParent = [IO.Path]::GetFullPath((Split-Path -Parent $cloneRoot)).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ($cloneRoot -ieq $sourceRoot -or $cloneParent -ine $sourceParent) {
    throw "corrupt model pack destination must be a new sibling of the source"
  }
  $markerPath = $cloneRoot + ".owner.json"
  if ((Test-Path -LiteralPath $cloneRoot) -or (Test-Path -LiteralPath $markerPath)) {
    throw "corrupt model pack owned path already exists"
  }
  $sourceManifestPath = Get-RegularCorruptModelPackFile (Join-Path $sourceRoot "ai-model-manifest.json") "corrupt model pack source manifest"
  $sourceManifest = [IO.File]::ReadAllBytes($sourceManifestPath)
  if ($sourceManifest.Length -lt 1) { throw "corrupt model pack source manifest is empty" }
  $invalidManifest = [byte[]]$sourceManifest.Clone()
  $invalidManifest[0] = [byte]($invalidManifest[0] -bxor 1)
  $state = [pscustomobject]@{
    cloneRoot = $cloneRoot
    markerPath = [IO.Path]::GetFullPath($markerPath)
    ownershipId = [guid]::NewGuid().ToString("N")
    sourceRoot = $sourceRoot
    invalidManifestSha256 = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($invalidManifest)).ToLowerInvariant()
  }
  $marker = ([ordered]@{
    cloneRoot = $state.cloneRoot
    ownershipId = $state.ownershipId
    runId = $RunId
    schemaVersion = "vem-testbed-ai-corrupt-model-pack-owner/v2"
    sourceRoot = $state.sourceRoot
  } | ConvertTo-Json -Compress) + "`n"
  $created = $false
  try {
    New-Item -ItemType Directory -Path $cloneRoot -ErrorAction Stop | Out-Null
    $created = $true
    $manifestPath = Join-Path $cloneRoot "ai-model-manifest.json"
    $stream = [IO.File]::Open($manifestPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($invalidManifest, 0, $invalidManifest.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    $markerBytes = (New-Object Text.UTF8Encoding $false).GetBytes($marker)
    $markerStream = [IO.File]::Open($state.markerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $markerStream.Write($markerBytes, 0, $markerBytes.Length); $markerStream.Flush($true) } finally { $markerStream.Dispose() }
    if (-not (Test-CorruptModelPackBytes $sourceManifest ([IO.File]::ReadAllBytes($sourceManifestPath)))) {
      throw "corrupt model pack source manifest changed"
    }
    $state | Add-Member -NotePropertyName markerText -NotePropertyValue $marker
    $state | Add-Member -NotePropertyName mutation -NotePropertyValue ([pscustomobject]@{ changedByteOffset = 0; changedByteCount = 1; path = "ai-model-manifest.json" })
    $script:OwnedCorruptModelPacks[$state.ownershipId] = $state
    return $state
  } catch {
    if ($created) {
      Remove-Item -LiteralPath $state.markerPath -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $cloneRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
  }
}

function Remove-TestbedCorruptModelPack([object]$Ownership) {
  $ownershipId = [string]$Ownership.ownershipId
  if ([string]::IsNullOrWhiteSpace($ownershipId) -or -not $script:OwnedCorruptModelPacks.ContainsKey($ownershipId)) { throw "corrupt model pack ownership is not registered" }
  $state = $script:OwnedCorruptModelPacks[$ownershipId]
  if ([string]$Ownership.cloneRoot -cne [string]$state.cloneRoot -or [string]$Ownership.markerPath -cne [string]$state.markerPath) { throw "corrupt model pack ownership does not match its registered root" }
  $markerPath = Get-RegularCorruptModelPackFile $state.markerPath "corrupt model pack owner marker"
  if ([IO.File]::ReadAllText($markerPath, [Text.Encoding]::UTF8) -cne [string]$state.markerText) { throw "corrupt model pack owner marker does not match" }
  $root = Get-RegularCorruptModelPackDirectory $state.cloneRoot "corrupt model pack cleanup root"
  $members = @(Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)
  if ($members.Count -ne 1 -or $members[0].Name -cne "ai-model-manifest.json") { throw "corrupt model pack cleanup found a foreign member" }
  $manifestPath = Get-RegularCorruptModelPackFile $members[0].FullName "corrupt model pack manifest"
  $actualSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualSha256 -cne [string]$state.invalidManifestSha256) { throw "corrupt model pack manifest changed" }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction Stop
  Remove-Item -LiteralPath $markerPath -Force -ErrorAction Stop
  $script:OwnedCorruptModelPacks.Remove($ownershipId)
}

Export-ModuleMember -Function New-TestbedCorruptModelPack, Remove-TestbedCorruptModelPack
