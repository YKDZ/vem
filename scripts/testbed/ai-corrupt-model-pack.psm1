Set-StrictMode -Version 2.0

$script:OwnedCorruptModelPacks = @{}
Import-Module (Join-Path $PSScriptRoot "..\windows\vision-ai-model-pack.psm1") -Force

function Get-CorruptPackInventory([string]$Root) {
  $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $entries = @(Get-ChildItem -LiteralPath $normalizedRoot -Recurse -Force -ErrorAction Stop)
  if (@($entries | Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 }).Count -ne 0) { throw "corrupt model pack contains a reparse entry" }
  return @($entries | Where-Object { -not $_.PSIsContainer } | ForEach-Object {
    [pscustomobject]@{
      byteSize = [long]$_.Length
      path = $_.FullName.Substring($normalizedRoot.Length + 1).Replace("\", "/")
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  } | Sort-Object path -CaseSensitive)
}

function Get-CorruptPackInventoryText([object[]]$Inventory) {
  return (@($Inventory | ForEach-Object { "$([string]$_.path)`0$([long]$_.byteSize)`0$([string]$_.sha256)" }) -join "`n")
}

function New-TestbedCorruptModelPackClone {
  param(
    [Parameter(Mandatory = $true)][string]$SourceRoot,
    [Parameter(Mandatory = $true)][string]$VisionAppDirectory,
    [Parameter(Mandatory = $true)][string]$VisionDataDirectory,
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [Parameter(Mandatory = $true)][string]$RunId
  )
  if ($RunId -cnotmatch "^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$") { throw "corrupt model pack run identity is invalid" }
  $verified = Assert-VemOfficialAiModelPack -ModelRoot $SourceRoot -VisionAppDirectory $VisionAppDirectory -VisionDataDirectory $VisionDataDirectory
  $sourceBefore = Get-CorruptPackInventory $verified.modelRoot
  $authorityRoot = [IO.Path]::GetFullPath((Join-Path $VisionDataDirectory "ai-model-packs\packs")).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $cloneRoot = [IO.Path]::GetFullPath($DestinationRoot).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  if ($cloneRoot -ieq $verified.modelRoot -or -not $cloneRoot.StartsWith($authorityRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw "corrupt model pack destination must be a private path under the model pack authority" }
  $markerPath = $cloneRoot + ".owner.json"
  if ((Test-Path -LiteralPath $cloneRoot) -or (Test-Path -LiteralPath $markerPath)) { throw "corrupt model pack owned path already exists" }
  $state = [pscustomobject]@{ cloneRoot = [IO.Path]::GetFullPath($cloneRoot); markerPath = [IO.Path]::GetFullPath($markerPath); ownershipId = [guid]::NewGuid().ToString("N"); sourceRoot = [IO.Path]::GetFullPath($verified.modelRoot) }
  try {
    New-Item -ItemType Directory -Path $cloneRoot -ErrorAction Stop | Out-Null
    foreach ($file in $sourceBefore) {
      $relative = ([string]$file.path).Replace("/", [IO.Path]::DirectorySeparatorChar)
      $destination = Join-Path $cloneRoot $relative
      New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force -ErrorAction Stop | Out-Null
      Copy-Item -LiteralPath (Join-Path $verified.modelRoot $relative) -Destination $destination -ErrorAction Stop
    }
    [void](Assert-VemOfficialAiModelPack -ModelRoot $cloneRoot -VisionAppDirectory $VisionAppDirectory -VisionDataDirectory $VisionDataDirectory)
    $cloneBefore = Get-CorruptPackInventory $cloneRoot
    if ((Get-CorruptPackInventoryText $cloneBefore) -cne (Get-CorruptPackInventoryText $sourceBefore)) { throw "corrupt model pack clone does not match the verified source" }
    $targetRelative = [string]$verified.files[0].path
    $sourceTarget = Join-Path $verified.modelRoot ($targetRelative.Replace("/", [IO.Path]::DirectorySeparatorChar))
    $cloneTarget = Join-Path $cloneRoot ($targetRelative.Replace("/", [IO.Path]::DirectorySeparatorChar))
    $sourceBytes = [IO.File]::ReadAllBytes($sourceTarget)
    $cloneBytes = [IO.File]::ReadAllBytes($cloneTarget)
    if ($sourceBytes.Length -lt 1 -or $cloneBytes.Length -ne $sourceBytes.Length) { throw "corrupt model pack mutation target is invalid" }
    $cloneBytes[0] = [byte]($cloneBytes[0] -bxor 1)
    [IO.File]::WriteAllBytes($cloneTarget, $cloneBytes)
    $mutatedBytes = [IO.File]::ReadAllBytes($cloneTarget)
    $changedOffsets = @()
    for ($index = 0; $index -lt $sourceBytes.Length; $index += 1) { if ($sourceBytes[$index] -ne $mutatedBytes[$index]) { $changedOffsets += $index } }
    if ($mutatedBytes.Length -ne $sourceBytes.Length -or $changedOffsets.Count -ne 1 -or $changedOffsets[0] -ne 0 -or $mutatedBytes[0] -ne [byte]($sourceBytes[0] -bxor 1)) { throw "corrupt model pack mutation was not exactly one first-byte xor" }
    $sourceAfter = Get-CorruptPackInventory $verified.modelRoot
    [void](Assert-VemOfficialAiModelPack -ModelRoot $verified.modelRoot -VisionAppDirectory $VisionAppDirectory -VisionDataDirectory $VisionDataDirectory)
    if ((Get-CorruptPackInventoryText $sourceAfter) -cne (Get-CorruptPackInventoryText $sourceBefore)) { throw "verified official model pack source changed" }
    $cloneAfter = Get-CorruptPackInventory $cloneRoot
    $changedFiles = @($cloneAfter | Where-Object { $cloneFile = $_; $sourceFile = @($sourceBefore | Where-Object { [string]$_.path -ceq [string]$cloneFile.path })[0]; $null -eq $sourceFile -or [long]$sourceFile.byteSize -ne [long]$cloneFile.byteSize -or [string]$sourceFile.sha256 -cne [string]$cloneFile.sha256 })
    if ($cloneAfter.Count -ne $sourceBefore.Count -or $changedFiles.Count -ne 1 -or [string]$changedFiles[0].path -cne $targetRelative) { throw "corrupt model pack changed outside its single allowlisted target" }
    $marker = ([ordered]@{ cloneRoot = $state.cloneRoot; ownershipId = $state.ownershipId; runId = $RunId; schemaVersion = "vem-testbed-ai-corrupt-model-pack-owner/v1"; sourceRoot = $state.sourceRoot } | ConvertTo-Json -Compress) + "`n"
    $stream = [IO.File]::Open($markerPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $markerBytes = (New-Object Text.UTF8Encoding $false).GetBytes($marker); $stream.Write($markerBytes, 0, $markerBytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    $state | Add-Member -NotePropertyName expectedInventory -NotePropertyValue $cloneAfter
    $state | Add-Member -NotePropertyName markerText -NotePropertyValue $marker
    $state | Add-Member -NotePropertyName mutation -NotePropertyValue ([pscustomobject]@{ changedByteOffset = 0; changedFileCount = 1; path = $targetRelative })
    $script:OwnedCorruptModelPacks[$state.ownershipId] = $state
    return $state
  } catch {
    Remove-Item -LiteralPath $markerPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $cloneRoot -Recurse -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Remove-TestbedCorruptModelPackClone([object]$Ownership) {
  $ownershipId = [string]$Ownership.ownershipId
  if ([string]::IsNullOrWhiteSpace($ownershipId) -or -not $script:OwnedCorruptModelPacks.ContainsKey($ownershipId)) { throw "corrupt model pack ownership is not registered" }
  $state = $script:OwnedCorruptModelPacks[$ownershipId]
  if ([string]$Ownership.cloneRoot -cne [string]$state.cloneRoot -or [string]$Ownership.markerPath -cne [string]$state.markerPath) { throw "corrupt model pack ownership does not match its registered clone" }
  if (-not (Test-Path -LiteralPath $state.markerPath -PathType Leaf)) { throw "corrupt model pack owner marker is missing" }
  $markerItem = Get-Item -LiteralPath $state.markerPath -Force -ErrorAction Stop
  if (($markerItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or [IO.File]::ReadAllText($state.markerPath, [Text.Encoding]::UTF8) -cne [string]$state.markerText) { throw "corrupt model pack owner marker does not match" }
  $rootItem = Get-Item -LiteralPath $state.cloneRoot -Force -ErrorAction Stop
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "corrupt model pack cleanup root is not regular" }
  $actual = Get-CorruptPackInventory $state.cloneRoot
  if ((Get-CorruptPackInventoryText $actual) -cne (Get-CorruptPackInventoryText $state.expectedInventory)) { throw "corrupt model pack cleanup found a foreign or changed member" }
  Remove-Item -LiteralPath $state.cloneRoot -Recurse -Force -ErrorAction Stop
  Remove-Item -LiteralPath $state.markerPath -Force -ErrorAction Stop
  $script:OwnedCorruptModelPacks.Remove($ownershipId)
}

Export-ModuleMember -Function New-TestbedCorruptModelPackClone, Remove-TestbedCorruptModelPackClone
