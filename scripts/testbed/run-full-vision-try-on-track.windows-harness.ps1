$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Write-Archive([string]$Path, [hashtable]$Files) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $root = "$Path.source"
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  try {
    foreach ($entry in $Files.GetEnumerator()) {
      $destination = Join-Path $root ([string]$entry.Key)
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      [IO.File]::WriteAllText($destination, [string]$entry.Value, [Text.UTF8Encoding]::new($false))
    }
    [IO.Compression.ZipFile]::CreateFromDirectory($root, $Path)
  } finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function New-CandidateArchive([string]$Path, [string]$Marker, [string]$Commit) {
  $root = "$Path.source"
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  try {
    $files = [ordered]@{
      "vending-vision/vending-vision.exe" = "runtime-$Marker"
      "vending-vision-ai-worker/vending-vision-ai-worker.exe" = "worker-$Marker"
      "vending-vision/_internal/contracts/vem_vision_v2/fixtures/client-invalid.json" = "{}"
      "vending-vision/_internal/contracts/vem_vision_v2/fixtures/client-valid.json" = "{}"
      "vending-vision/_internal/contracts/vem_vision_v2/fixtures/server-invalid.json" = "{}"
      "vending-vision/_internal/contracts/vem_vision_v2/fixtures/server-valid.json" = "{}"
    }
    foreach ($entry in $files.GetEnumerator()) {
      $destination = Join-Path $root ([string]$entry.Key)
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      [IO.File]::WriteAllText($destination, [string]$entry.Value, [Text.UTF8Encoding]::new($false))
    }
    $manifestFiles = @($files.Keys | ForEach-Object {
      $file = Join-Path $root $_
      [ordered]@{ path = $_; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant(); size = [long](Get-Item -LiteralPath $file).Length }
    })
    [IO.File]::WriteAllText((Join-Path $root "candidate-manifest.json"), (@{ schemaVersion = "vending-vision-candidate-artifact/v3"; sourceCommit = $Commit; files = $manifestFiles } | ConvertTo-Json -Compress -Depth 8), [Text.UTF8Encoding]::new($false))
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($root, $Path)
  } finally {
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-full-vision-delivery-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $runnerPath = Join-Path $PSScriptRoot "run-full-vision-try-on-track.ps1"
  $runnerSource = Get-Content -Raw -LiteralPath $runnerPath
  $definitions = $runnerSource.Substring($runnerSource.IndexOf('$ErrorActionPreference'), $runnerSource.IndexOf('$guestInput =') - $runnerSource.IndexOf('$ErrorActionPreference'))
  Import-Module (Join-Path $PSScriptRoot "..\windows\vision-main-artifacts.psm1") -Force
  Invoke-Expression $definitions
  $commit = "a" * 40
  $fixture = Join-Path $root "fixture.zip"
  Write-Archive $fixture @{
    "recorded-video/top.mp4" = "top"
    "recorded-video/front.mp4" = "front"
    "recorded-video/expected-results.json" = "{}"
    "vision-artifact.json" = (@{ schemaVersion = "vending-vision-main-artifacts/v1"; commit = $commit; runtimeArchive = "vending-vision-windows-x86_64.zip"; fixtureArchive = "vending-vision-test-fixtures.zip" } | ConvertTo-Json -Compress)
  }
  $firstCandidate = Join-Path $root "candidate-first.zip"
  $secondCandidate = Join-Path $root "candidate-second.zip"
  New-CandidateArchive $firstCandidate "first" $commit
  New-CandidateArchive $secondCandidate "second" $commit
  $first = Rebuild-ProvisionedVisionCoreDelivery ([pscustomobject]@{ runtimeArchive = $firstCandidate; fixtureArchive = $fixture; commit = $commit })
  $seededRuntimeSha256 = (Get-FileHash -LiteralPath ([string]$first.runtimeArchive) -Algorithm SHA256).Hash.ToLowerInvariant()
  $second = Rebuild-ProvisionedVisionCoreDelivery ([pscustomobject]@{ runtimeArchive = $secondCandidate; fixtureArchive = $fixture; commit = $commit })
  $rebuiltRuntimeSha256 = (Get-FileHash -LiteralPath ([string]$second.runtimeArchive) -Algorithm SHA256).Hash.ToLowerInvariant()
  @{ seededRuntimeSha256 = $seededRuntimeSha256; rebuiltRuntimeSha256 = $rebuiltRuntimeSha256; rebuiltFromCurrentCandidate = ($rebuiltRuntimeSha256 -ne $seededRuntimeSha256) } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
