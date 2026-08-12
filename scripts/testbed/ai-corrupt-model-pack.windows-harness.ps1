$ErrorActionPreference = "Stop"

function Assert-Rejected([scriptblock]$Operation, [string]$Message) {
  try { & $Operation } catch { return $true }
  throw $Message
}

function Get-InventoryText([string]$Path) {
  $root = [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  return (@(Get-ChildItem -LiteralPath $root -File -Recurse -Force | Sort-Object FullName | ForEach-Object {
    "$($_.FullName.Substring($root.Length + 1).Replace('\', '/'))`0$($_.Length)`0$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())"
  }) -join "`n")
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-ai-corrupt-model-pack-harness-" + [guid]::NewGuid().ToString("N"))
$visionApp = Join-Path $root "vision-app"
$visionData = Join-Path $root "vision-data"
$packsRoot = Join-Path $visionData "ai-model-packs\packs"
$sourceRoot = Join-Path $packsRoot "official"
$fakeRoot = Join-Path $packsRoot "fake"
$destinationRoot = Join-Path $packsRoot "test-owned-corrupt-run-42"
$descriptorPath = Join-Path $visionApp "_internal\official-ai-model-pack-descriptor.json"
$modulePath = Join-Path $PSScriptRoot "ai-corrupt-model-pack.psm1"

try {
  New-Item -ItemType Directory -Path (Split-Path -Parent $descriptorPath), (Join-Path $sourceRoot "weights") -Force | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $sourceRoot "weights\model.bin"), [byte[]](1, 2, 3, 4, 5))
  [IO.File]::WriteAllBytes((Join-Path $sourceRoot "tokenizer.bin"), [byte[]](9, 8, 7))
  $files = @(
    [ordered]@{ byteSize = [long]3; format = "bin"; path = "tokenizer.bin"; role = "tokenizer"; sha256 = (Get-FileHash -LiteralPath (Join-Path $sourceRoot "tokenizer.bin") -Algorithm SHA256).Hash.ToLowerInvariant(); upstream = "fixture"; upstreamPath = "tokenizer.bin" },
    [ordered]@{ byteSize = [long]5; format = "bin"; path = "weights/model.bin"; role = "model"; sha256 = (Get-FileHash -LiteralPath (Join-Path $sourceRoot "weights\model.bin") -Algorithm SHA256).Hash.ToLowerInvariant(); upstream = "fixture"; upstreamPath = "weights/model.bin" }
  )
  $descriptor = [ordered]@{
    catvtonSourceRevision = "3b795364a4d2f3b5adb365f39cdea376d20bc53c"
    files = $files
    schemaVersion = "vem-official-ai-model-pack-descriptor/v2"
    totalByteSize = [long]8
    upstreams = @([ordered]@{ id = "fixture"; repository = "fixture/repository"; revision = "a" * 40 })
  }
  $descriptorText = $descriptor | ConvertTo-Json -Compress -Depth 8
  [IO.File]::WriteAllText($descriptorPath, $descriptorText, (New-Object Text.UTF8Encoding $false))
  [IO.File]::WriteAllText((Join-Path $sourceRoot "ai-model-manifest.json"), $descriptorText, (New-Object Text.UTF8Encoding $false))
  Copy-Item -LiteralPath $sourceRoot -Destination $fakeRoot -Recurse
  [IO.File]::WriteAllBytes((Join-Path $fakeRoot "weights\model.bin"), [byte[]](5, 4, 3, 2, 1))

  Import-Module $modulePath -Force
  $sourceBefore = Get-InventoryText $sourceRoot
  $fakeSourceRejected = Assert-Rejected {
    New-TestbedCorruptModelPackClone -SourceRoot $fakeRoot -VisionAppDirectory $visionApp -VisionDataDirectory $visionData -DestinationRoot (Join-Path $packsRoot "test-owned-corrupt-fake") -RunId "fake" | Out-Null
  } "fake source was accepted"
  $ownership = New-TestbedCorruptModelPackClone -SourceRoot $sourceRoot -VisionAppDirectory $visionApp -VisionDataDirectory $visionData -DestinationRoot $destinationRoot -RunId "run-42"
  $sourceAfter = Get-InventoryText $sourceRoot
  $sourceTarget = Join-Path $sourceRoot ($ownership.mutation.path.Replace("/", [IO.Path]::DirectorySeparatorChar))
  $cloneTarget = Join-Path $ownership.cloneRoot ($ownership.mutation.path.Replace("/", [IO.Path]::DirectorySeparatorChar))
  $sourceBytes = [IO.File]::ReadAllBytes($sourceTarget)
  $cloneBytes = [IO.File]::ReadAllBytes($cloneTarget)
  $changedOffsets = @()
  for ($index = 0; $index -lt $sourceBytes.Length; $index += 1) { if ($sourceBytes[$index] -ne $cloneBytes[$index]) { $changedOffsets += $index } }

  $forgedOfficialRejected = Assert-Rejected {
    Remove-TestbedCorruptModelPackClone ([pscustomobject]@{ cloneRoot = $sourceRoot; markerPath = "$sourceRoot.owner.json"; ownershipId = [guid]::NewGuid().ToString("N") })
  } "forged official ownership was accepted"
  $foreignPath = Join-Path $ownership.cloneRoot "foreign.bin"
  [IO.File]::WriteAllBytes($foreignPath, [byte[]](6))
  $foreignCleanupRejected = Assert-Rejected { Remove-TestbedCorruptModelPackClone $ownership } "foreign cleanup was accepted"
  $foreignPreserved = Test-Path -LiteralPath $foreignPath -PathType Leaf
  Remove-Item -LiteralPath $foreignPath -Force
  $markerText = [IO.File]::ReadAllText($ownership.markerPath, [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText($ownership.markerPath, "tampered", (New-Object Text.UTF8Encoding $false))
  $markerCleanupRejected = Assert-Rejected { Remove-TestbedCorruptModelPackClone $ownership } "tampered marker cleanup was accepted"
  $tamperedClonePreserved = Test-Path -LiteralPath $ownership.cloneRoot -PathType Container
  [IO.File]::WriteAllText($ownership.markerPath, $markerText, (New-Object Text.UTF8Encoding $false))
  Remove-TestbedCorruptModelPackClone $ownership

  [ordered]@{
    changedByteCount = $changedOffsets.Count
    changedByteOffset = if ($changedOffsets.Count -eq 1) { $changedOffsets[0] } else { -1 }
    changedFileCount = $ownership.mutation.changedFileCount
    changedLength = $sourceBytes.Length -ne $cloneBytes.Length
    fakeSourceRejected = $fakeSourceRejected
    foreignCleanupRejected = $foreignCleanupRejected
    foreignPreserved = $foreignPreserved
    forgedOfficialRejected = $forgedOfficialRejected
    markerCleanupRejected = $markerCleanupRejected
    sourceUnchanged = $sourceBefore -ceq $sourceAfter
    tamperedClonePreserved = $tamperedClonePreserved
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
