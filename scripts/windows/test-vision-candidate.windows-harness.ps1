[CmdletBinding()]
param(
  [string]$CandidatePath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if ([string]::IsNullOrWhiteSpace($CandidatePath)) {
  $CandidatePath = Join-Path $PSScriptRoot "test-vision-candidate.ps1"
}

function Get-HarnessSha256([string]$Path) {
  $stream = [IO.File]::Open(
    $Path,
    [IO.FileMode]::Open,
    [IO.FileAccess]::Read,
    [IO.FileShare]::Read
  )
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    return "sha256:" + ([BitConverter]::ToString($hash.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
  } finally {
    $hash.Dispose()
    $stream.Dispose()
  }
}

function Get-HarnessSha256Bytes([byte[]]$Bytes) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($hash.ComputeHash($Bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $hash.Dispose()
  }
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

function Assert-CandidateFailureReport([string]$Path, [string]$PrimaryFailureCode) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Candidate entrypoint did not emit its failure report"
  }
  $report = [IO.File]::ReadAllText($Path) | ConvertFrom-Json
  if ($report.ok -ne $false -or $report.primaryFailureCode -cne $PrimaryFailureCode) {
    throw "Candidate failure report did not preserve its primary failure code"
  }
  if ($report.cleanupOk -ne $true) {
    throw "Candidate failure report recorded cleanup failure codes: $(@($report.cleanupFailureCodes) -join ','); residuals: $(@($report.cleanupResidualCodes) -join ',')"
  }
  if (@($report.cleanupFailureCodes).Count -ne 0 -or @($report.cleanupResidualCodes).Count -ne 0) {
    throw "Candidate failure report contains cleanup diagnostics despite cleanupOk=true"
  }
}

function New-CandidateHarnessInputs([string]$Root) {
  $content = Join-Path $Root "bundle source"
  $bundle = Join-Path $Root "candidate bundle.zip"
  New-Item -ItemType Directory -Path (Join-Path $content "bin") -Force | Out-Null
  $lockedEntrypoint = @'
@echo off
> "%~dp0lock-target.bin" echo locked
powershell.exe -NoProfile -Command "$stream=[IO.File]::Open($args[0],[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::None);try{[Threading.Thread]::Sleep(30000)}finally{$stream.Dispose()}" "%~dp0lock-target.bin"
'@
  [IO.File]::WriteAllText((Join-Path $content "bin\runtime.cmd"), $lockedEntrypoint, [Text.UTF8Encoding]::new($false))
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

function ConvertTo-HarnessCanonicalJson([object]$Value) {
  if ($null -eq $Value) { return "null" }
  if ($Value -is [string] -or $Value -is [char] -or $Value -is [bool] -or $Value -is [ValueType]) { return (ConvertTo-Json -InputObject $Value -Compress) }
  if ($Value -is [Array]) { return "[" + ((@($Value) | ForEach-Object { ConvertTo-HarnessCanonicalJson $_ }) -join ",") + "]" }
  if ($Value -is [Collections.IDictionary]) { return "{" + ((@($Value.Keys | Sort-Object) | ForEach-Object { (ConvertTo-Json -InputObject ([string]$_) -Compress) + ":" + (ConvertTo-HarnessCanonicalJson $Value[$_]) }) -join ",") + "}" }
  return "{" + ((@($Value.PSObject.Properties | Sort-Object Name) | ForEach-Object { (ConvertTo-Json -InputObject $_.Name -Compress) + ":" + (ConvertTo-HarnessCanonicalJson $_.Value) }) -join ",") + "}"
}

function New-PreapprovalDeliveryUnit([string]$Root, [string]$SourceEntrypoint, [object]$Inputs) {
  $delivery = Join-Path $Root "preapproval-delivery"
  New-Item -ItemType Directory -Path $delivery -Force | Out-Null
  $sourceRoot = Split-Path -Parent $SourceEntrypoint
  foreach ($name in @("test-vision-candidate.ps1", "vision-release-materialization.psm1", "vision-diagnostic-redaction.psm1")) {
    Copy-Item -LiteralPath (Join-Path $sourceRoot $name) -Destination (Join-Path $delivery $name) -Force
  }
  Copy-Item -LiteralPath $Inputs.bundle -Destination (Join-Path $delivery "bundle.bin") -Force
  Copy-Item -LiteralPath $Inputs.descriptor -Destination (Join-Path $delivery "vision-release-descriptor.json") -Force
  $files = [ordered]@{}
  foreach ($name in @("bundle.bin", "vision-release-descriptor.json", "test-vision-candidate.ps1", "vision-release-materialization.psm1", "vision-diagnostic-redaction.psm1")) {
    $files[$name] = Get-HarnessSha256 (Join-Path $delivery $name)
  }
  $unsigned = [ordered]@{ schemaVersion="vem-vision-preapproval-delivery/v1"; kind="vision-preapproval-delivery"; expectedDigest=$Inputs.digest; descriptorDigest=$files["vision-release-descriptor.json"]; files=$files }
  $identityBytes = [Text.UTF8Encoding]::new($false).GetBytes(((ConvertTo-HarnessCanonicalJson $unsigned) + [char]10))
  $manifest = [ordered]@{ schemaVersion=$unsigned.schemaVersion; kind=$unsigned.kind; expectedDigest=$unsigned.expectedDigest; descriptorDigest=$unsigned.descriptorDigest; files=$files; identity=("sha256:" + (Get-HarnessSha256Bytes $identityBytes)) }
  $manifestPath = Join-Path $delivery "preapproval-manifest.json"
  [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 16 -Compress), [Text.UTF8Encoding]::new($false))
  return [pscustomobject]@{ root=$delivery; entrypoint=(Join-Path $delivery "test-vision-candidate.ps1"); bundle=(Join-Path $delivery "bundle.bin"); descriptor=(Join-Path $delivery "vision-release-descriptor.json"); manifest=$manifestPath }
}

if (-not (Test-Path -LiteralPath $CandidatePath -PathType Leaf)) {
  throw "Candidate entrypoint is missing: $CandidatePath"
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem candidate entrypoint with spaces-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  $inputs = New-CandidateHarnessInputs $root
  $delivery = New-PreapprovalDeliveryUnit $root $CandidatePath $inputs

  # A delivery module is executable code.  Its digest must be checked before
  # Import-Module can run its top-level statements, even on the failure path.
  $markerPath = Join-Path $root "unverified-module-was-imported.txt"
  $materializerPath = Join-Path $delivery.root "vision-release-materialization.psm1"
  $originalMaterializer = [IO.File]::ReadAllBytes($materializerPath)
  $markerLiteral = $markerPath.Replace("'", "''")
  $injectedMaterializer = "[IO.File]::WriteAllText('$markerLiteral', 'executed')`r`n" + [Text.UTF8Encoding]::new($false).GetString($originalMaterializer)
  [IO.File]::WriteAllText($materializerPath, $injectedMaterializer, [Text.UTF8Encoding]::new($false))
  $tamperedReportPath = Join-Path $root "tampered report.json"
  Assert-ExpectedFailure {
    & $delivery.entrypoint -BundlePath $delivery.bundle -ExpectedDigest $inputs.digest -DescriptorPath $delivery.descriptor -PreapprovalManifestPath $delivery.manifest -ConformanceEvidencePath (Join-Path $root "tampered conformance.json") -ReportPath $tamperedReportPath -WorkRoot (Join-Path $root "tampered work root")
  } "Vision preapproval delivery file digest is invalid"
  Assert-CandidateFailureReport $tamperedReportPath "preapproval-delivery-digest-invalid"
  if (Test-Path -LiteralPath $markerPath -PathType Leaf) {
    throw "Candidate imported a tampered delivery module before manifest verification"
  }
  [IO.File]::WriteAllBytes($materializerPath, $originalMaterializer)

  # Replace an already-created work-root path with a junction.  The actual
  # entrypoint must reject this reparse traversal before materializing bytes.
  $reparseTarget = Join-Path $root "reparse target"
  $replacedWorkRoot = Join-Path $root "work root replaced"
  New-Item -ItemType Directory -Path $reparseTarget,$replacedWorkRoot -Force | Out-Null
  Remove-Item -LiteralPath $replacedWorkRoot -Force
  New-Item -ItemType Junction -Path $replacedWorkRoot -Target $reparseTarget | Out-Null
  $reparseReportPath = Join-Path $root "reparse report.json"
  Assert-ExpectedFailure {
    & $delivery.entrypoint -BundlePath $delivery.bundle -ExpectedDigest $inputs.digest -DescriptorPath $delivery.descriptor -PreapprovalManifestPath $delivery.manifest -ConformanceEvidencePath (Join-Path $root "reparse conformance.json") -ReportPath $reparseReportPath -WorkRoot $replacedWorkRoot
  } "must not traverse a reparse point"
  Assert-CandidateFailureReport $reparseReportPath "reparse-path-rejected"

  # Execute the entrypoint again through a normal path with spaces.  The
  # harmless .cmd bundle deliberately fails its process-path binding only after
  # the Candidate writes and revalidates its external configuration path.
  $workRoot = Join-Path $root "candidate work root with spaces"
  $reportPath = Join-Path $root "candidate report with spaces.json"
  Assert-ExpectedFailure {
    & $delivery.entrypoint -BundlePath $delivery.bundle -ExpectedDigest $inputs.digest -DescriptorPath $delivery.descriptor -PreapprovalManifestPath $delivery.manifest -ConformanceEvidencePath (Join-Path $root "candidate conformance with spaces.json") -ReportPath $reportPath -WorkRoot $workRoot
  } "Vision Candidate did not remain at the exact extracted entrypoint"
  Assert-CandidateFailureReport $reportPath "entrypoint-process-binding-failed"
  Write-Output "candidate entrypoint harness passed"
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
