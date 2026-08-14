$ErrorActionPreference = "Stop"

function Assert-Rejected([scriptblock]$Operation, [string]$Message) {
  try { & $Operation } catch { return $true }
  throw $Message
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-ai-corrupt-model-pack-harness-" + [guid]::NewGuid().ToString("N"))
$sourceRoot = Join-Path $root "testbed\ai-inputs\run-42\model-pack"
$destinationRoot = Join-Path (Split-Path -Parent $sourceRoot) "corrupt-run-42"
$modulePath = Join-Path $PSScriptRoot "ai-corrupt-model-pack.psm1"

try {
  New-Item -ItemType Directory -Path (Join-Path $sourceRoot "weights") -Force | Out-Null
  $sourceManifestPath = Join-Path $sourceRoot "ai-model-manifest.json"
  $sourceWeightPath = Join-Path $sourceRoot "weights\model.bin"
  [IO.File]::WriteAllText($sourceManifestPath, '{"schemaVersion":"fixture"}', (New-Object Text.UTF8Encoding $false))
  [IO.File]::WriteAllBytes($sourceWeightPath, [byte[]](1, 2, 3, 4, 5))

  Import-Module $modulePath -Force
  $sourceManifestBefore = [IO.File]::ReadAllBytes($sourceManifestPath)
  $sourceWeightBefore = (Get-FileHash -LiteralPath $sourceWeightPath -Algorithm SHA256).Hash
  $ownership = New-TestbedCorruptModelPack -SourceRoot $sourceRoot -DestinationRoot $destinationRoot -RunId "run-42"
  $sourceManifestAfter = [IO.File]::ReadAllBytes($sourceManifestPath)
  $sourceWeightAfter = (Get-FileHash -LiteralPath $sourceWeightPath -Algorithm SHA256).Hash
  $cloneManifestPath = Join-Path $ownership.cloneRoot "ai-model-manifest.json"
  $cloneManifest = [IO.File]::ReadAllBytes($cloneManifestPath)
  $cloneContainsOnlyCorruptManifest = @((Get-ChildItem -LiteralPath $ownership.cloneRoot -File -Recurse -Force)).Count -eq 1
  $changedOffsets = @()
  for ($index = 0; $index -lt $sourceManifestBefore.Length; $index += 1) {
    if ($sourceManifestBefore[$index] -ne $cloneManifest[$index]) { $changedOffsets += $index }
  }

  $forgedOfficialRejected = Assert-Rejected {
    Remove-TestbedCorruptModelPack ([pscustomobject]@{ cloneRoot = $sourceRoot; markerPath = "$sourceRoot.owner.json"; ownershipId = [guid]::NewGuid().ToString("N") })
  } "forged source ownership was accepted"
  $foreignPath = Join-Path $ownership.cloneRoot "foreign.bin"
  [IO.File]::WriteAllBytes($foreignPath, [byte[]](6))
  $foreignCleanupRejected = Assert-Rejected { Remove-TestbedCorruptModelPack $ownership } "foreign cleanup was accepted"
  $foreignPreserved = Test-Path -LiteralPath $foreignPath -PathType Leaf
  Remove-Item -LiteralPath $foreignPath -Force
  $markerText = [IO.File]::ReadAllText($ownership.markerPath, [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText($ownership.markerPath, "tampered", (New-Object Text.UTF8Encoding $false))
  $markerCleanupRejected = Assert-Rejected { Remove-TestbedCorruptModelPack $ownership } "tampered marker cleanup was accepted"
  $tamperedClonePreserved = Test-Path -LiteralPath $ownership.cloneRoot -PathType Container
  [IO.File]::WriteAllText($ownership.markerPath, $markerText, (New-Object Text.UTF8Encoding $false))
  Remove-TestbedCorruptModelPack $ownership

  [ordered]@{
    changedByteCount = $changedOffsets.Count
    changedByteOffset = if ($changedOffsets.Count -eq 1) { $changedOffsets[0] } else { -1 }
    cloneContainsOnlyCorruptManifest = $cloneContainsOnlyCorruptManifest
    foreignCleanupRejected = $foreignCleanupRejected
    foreignPreserved = $foreignPreserved
    forgedOfficialRejected = $forgedOfficialRejected
    markerCleanupRejected = $markerCleanupRejected
    sourceManifestUnchanged = [Convert]::ToBase64String($sourceManifestBefore) -ceq [Convert]::ToBase64String($sourceManifestAfter)
    sourceWeightUnchanged = $sourceWeightBefore -ceq $sourceWeightAfter
    tamperedClonePreserved = $tamperedClonePreserved
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
