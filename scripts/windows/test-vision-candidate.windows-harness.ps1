[CmdletBinding()]
param(
  [string]$CandidatePath = (Join-Path $PSScriptRoot "test-vision-candidate.ps1")
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-HarnessSha256([string]$Path) {
  return "sha256:" + (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Assert-ExpectedFailure([scriptblock]$Action, [string]$ExpectedMessage) {
  try {
    & $Action
  } catch {
    if ($_.Exception.Message -notmatch [regex]::Escape($ExpectedMessage)) {
      throw "expected failure '$ExpectedMessage', got '$($_.Exception.Message)'"
    }
    return
  }
  throw "expected Candidate entrypoint failure: $ExpectedMessage"
}

function New-CandidateHarnessInputs([string]$Root) {
  $content = Join-Path $Root "bundle source"
  $bundle = Join-Path $Root "candidate bundle.zip"
  New-Item -ItemType Directory -Path (Join-Path $content "bin") -Force | Out-Null
  [IO.File]::WriteAllText(
    (Join-Path $content "bin\runtime.cmd"),
    "@echo off`r`nping -n 4 127.0.0.1 > nul`r`n",
    [Text.UTF8Encoding]::new($false)
  )
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($content, $bundle)
  $bundleDigest = Get-HarnessSha256 $bundle
  $descriptor = [ordered]@{
    identity = "sha256:" + ("a" * 64)
    releaseVersion = "0.0.0-harness"
    bundle = [ordered]@{
      digest = $bundleDigest
      bytes = [Int64](Get-Item -LiteralPath $bundle).Length
      extractor = [ordered]@{ handler = "zip-safe-v1" }
    }
    entrypoint = [ordered]@{ command = "bin/runtime.cmd"; arguments = @() }
    configuration = [ordered]@{
      schemaVersion = "vending-vision-site-config/v1"
      argument = "--config"
    }
    health = [ordered]@{ port = 38999; path = "/health"; timeoutMs = 500 }
    protocol = [ordered]@{ version = "vem.vision.v1"; webSocketPath = "/ws" }
  }
  $descriptorPath = Join-Path $Root "candidate descriptor.json"
  [IO.File]::WriteAllText($descriptorPath, ($descriptor | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
  return [pscustomobject]@{ bundle = $bundle; digest = $bundleDigest; descriptor = $descriptorPath }
}

if (-not (Test-Path -LiteralPath $CandidatePath -PathType Leaf)) {
  throw "Candidate entrypoint is missing: $CandidatePath"
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem candidate entrypoint with spaces-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $inputs = New-CandidateHarnessInputs $root

  # Replace an already-created work-root path with a junction.  The actual
  # entrypoint must reject this reparse traversal before materializing bytes.
  $reparseTarget = Join-Path $root "reparse target"
  $replacedWorkRoot = Join-Path $root "work root replaced"
  New-Item -ItemType Directory -Path $reparseTarget,$replacedWorkRoot -Force | Out-Null
  Remove-Item -LiteralPath $replacedWorkRoot -Force
  New-Item -ItemType Junction -Path $replacedWorkRoot -Target $reparseTarget | Out-Null
  Assert-ExpectedFailure {
    & $CandidatePath -BundlePath $inputs.bundle -ExpectedDigest $inputs.digest -DescriptorPath $inputs.descriptor -ConformanceEvidencePath (Join-Path $root "reparse conformance.json") -ReportPath (Join-Path $root "reparse report.json") -WorkRoot $replacedWorkRoot
  } "must not traverse a reparse point"

  # Execute the entrypoint again through a normal path with spaces.  The
  # harmless .cmd bundle deliberately fails its process-path binding only after
  # the Candidate writes and revalidates its external configuration path.
  $workRoot = Join-Path $root "candidate work root with spaces"
  $reportPath = Join-Path $root "candidate report with spaces.json"
  Assert-ExpectedFailure {
    & $CandidatePath -BundlePath $inputs.bundle -ExpectedDigest $inputs.digest -DescriptorPath $inputs.descriptor -ConformanceEvidencePath (Join-Path $root "candidate conformance with spaces.json") -ReportPath $reportPath -WorkRoot $workRoot
  } "Vision Candidate did not remain at the exact extracted entrypoint"
  if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    throw "Candidate entrypoint did not emit its report through a spaced path"
  }
  Write-Output "candidate entrypoint harness passed"
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
