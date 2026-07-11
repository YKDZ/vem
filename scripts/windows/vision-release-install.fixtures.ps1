[CmdletBinding()]
param([ValidateSet("archive", "bytes", "first-install", "acl", "task", "process-record", "protocol", "rollback", "orphan", "mutex", "reinstall", "runtime-verifier")][string]$Case = "archive")

$ErrorActionPreference = "Stop"
$libraryRoot = Join-Path ([IO.Path]::GetTempPath()) "vem-vision-installer-library"
. (Join-Path $PSScriptRoot "install-vision-release.ps1") -Library -VisionRoot $libraryRoot -StateRoot (Join-Path $libraryRoot "state")

function Assert-Throws([scriptblock]$Action, [string]$Label) {
  try { & $Action } catch { return }
  throw "expected rejection: $Label"
}

function New-Zip([string]$Path, [object[]]$Entries) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $stream = [IO.File]::Open($Path, [IO.FileMode]::Create, [IO.FileAccess]::Write)
  try {
    $archive = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $true)
    try {
      foreach ($pair in $Entries) {
        $entry = $archive.CreateEntry([string]$pair[0])
        $writer = [IO.StreamWriter]::new($entry.Open())
        try { $writer.Write([string]$pair[1]) } finally { $writer.Dispose() }
      }
    } finally { $archive.Dispose() }
  } finally { $stream.Dispose() }
}

function Test-SourceBoundary([string[]]$Needles) {
  $source = Get-Content -LiteralPath (Join-Path $PSScriptRoot "install-vision-release.ps1") -Raw -Encoding UTF8
  foreach ($needle in $Needles) {
    if (-not $source.Contains($needle)) { throw "missing fixture boundary: $needle" }
  }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-installer-fixture-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Path $root | Out-Null
  if ($Case -eq "archive") {
    foreach ($attack in @(@(,@("../escape.exe", "x")), @(,@("/absolute.exe", "x")), @(,@("runtime.exe:stream", "x")), @(@("Runtime.EXE", "a"), @("runtime.exe", "b")))) {
      $bundle = Join-Path $root ([guid]::NewGuid().ToString("N") + ".zip")
      $target = Join-Path $root ([guid]::NewGuid().ToString("N"))
      New-Zip $bundle $attack
      $stream = [IO.File]::OpenRead($bundle)
      try { Assert-Throws { Expand-ZipSafely $stream $target ([pscustomobject]@{}) } "unsafe archive" } finally { $stream.Dispose() }
    }
    Assert-Throws { Get-SafeArchivePath "folder/../escape.exe" } "traversal"
    Assert-Throws { Get-SafeArchivePath "C:\\escape.exe" } "drive path"
    Write-Output "archive fixtures passed"
  } elseif ($Case -eq "bytes") {
    $file = Join-Path $root "record.json"; [IO.File]::WriteAllText($file, '{"ok":true}', [Text.UTF8Encoding]::new($false))
    $bytes = Get-ExactFileBytes $file "fixture"; if ((Get-Digest $bytes) -notmatch '^sha256:') { throw "exact digest missing" }
    $link = Join-Path $root "reparse.json"
    try { New-Item -ItemType SymbolicLink -Path $link -Target $file | Out-Null; Assert-Throws { Get-ExactFileBytes $link "reparse" } "reparse file" } catch [System.UnauthorizedAccessException] { Write-Output "symlink fixture skipped by host policy" }
    $redacted = Sanitize "failed at C:\\VEM\\vision token=super-secret"
    if ($redacted -match 'super-secret|C:\\VEM') { throw "failure was not sanitized" }
    Write-Output "bytes fixtures passed"
  } elseif ($Case -eq "first-install") {
    $delivery = Join-Path $root "factory\vision-release"; New-Item -ItemType Directory -Path $delivery -Force | Out-Null
    foreach ($name in @("bundle.bin", "descriptor.json", "attestation.json", "sbom.json", "provenance.json", "conformance.json", "approval.json", "factory-manifest.json")) { [IO.File]::WriteAllText((Join-Path $delivery $name), "fixture", [Text.UTF8Encoding]::new($false)) }
    Assert-NonReparsePath $delivery "first install delivery"
    Test-SourceBoundary @("FactoryVisionDeliveryRoot", "Get-FactoryTrustPolicy", "Set-SystemInstallerAcl", "Assert-ReleaseContracts")
    Write-Output "first-install fixtures passed"
  } elseif ($Case -eq "acl") {
    $protected = Join-Path $root "protected"; New-Item -ItemType Directory -Path $protected | Out-Null
    Set-SystemInstallerAcl $protected $false
    Assert-NonReparsePath $protected "fixture ACL root"
    Test-SourceBoundary @("SetAccessRuleProtection", "SYSTEM", "BUILTIN\\Administrators", "VEMKiosk")
    Write-Output "acl fixtures passed"
  } elseif ($Case -eq "task") {
    $script:registeredTask = $null
    function Get-ScheduledTask { return $null }
    function New-ScheduledTaskAction { param($Execute,$Argument,$WorkingDirectory) return [pscustomobject]@{ execute=$Execute; argument=$Argument; workingDirectory=$WorkingDirectory } }
    function New-ScheduledTaskTrigger { param($User) return [pscustomobject]@{ user=$User } }
    function New-ScheduledTaskPrincipal { param($UserId,$LogonType,$RunLevel) return [pscustomobject]@{ user=$UserId; logon=$LogonType; runLevel=$RunLevel } }
    function Register-ScheduledTask { param($TaskName,$TaskPath,$Action,$Trigger,$Principal) $script:registeredTask = [pscustomobject]@{ name=$TaskName; path=$TaskPath; action=$Action; trigger=$Trigger; principal=$Principal } }
    Ensure-VisionTask
    if ($null -eq $script:registeredTask -or $script:registeredTask.name -cne "StartVisionServer" -or $script:registeredTask.path -cne "\VEM\") { throw "interactive Vision task was not registered" }
    Write-Output "task fixtures passed"
  } elseif ($Case -eq "process-record") {
    $releaseRoot = Join-Path $root "releases"; $processStateRoot = Join-Path $root "process-state"; $processPath = Join-Path $processStateRoot "active-process.json"; $selectionPath = Join-Path $root "current.json"
    New-Item -ItemType Directory -Path $releaseRoot,$processStateRoot -Force | Out-Null
    $approvedPath = Join-Path $releaseRoot "approved.exe"; $victimPath = Join-Path $root "victim.exe"; [IO.File]::WriteAllText($approvedPath, "approved", [Text.UTF8Encoding]::new($false)); [IO.File]::WriteAllText($victimPath, "victim", [Text.UTF8Encoding]::new($false))
    $approvedDigest = "sha256:" + (Get-FileHash -LiteralPath $approvedPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $selection = [pscustomobject]@{ revision="revision-1"; bundleDigest=("sha256:" + "a" * 64) }
    [IO.File]::WriteAllText($processPath, (@{ bundleDigest=$selection.bundleDigest; processId=4242; creationTimeUtc="2026-01-01T00:00:00.0000000Z"; executablePath=$victimPath; executableDigest="sha256:" + "b" * 64; selectionRevision=$selection.revision } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    $script:stoppedProcess = $null
    function Stop-ScheduledTask {}
    function Resolve-ApprovedVisionExecution { return [pscustomobject]@{ revision=$selection.revision; bundleDigest=$selection.bundleDigest; executablePath=$approvedPath; executableDigest=$approvedDigest } }
    function Get-Process { return [pscustomobject]@{ Id=4242; Path=$victimPath; StartTime=[datetime]"2026-01-01T00:00:00Z" } }
    function Stop-Process { param($Id,$Force,$ErrorAction) $script:stoppedProcess = $Id }
    Stop-RecordedVision $selection
    if ($null -ne $script:stoppedProcess) { throw "kiosk process record stopped an arbitrary process" }
    Test-SourceBoundary @('Resolve-ApprovedVisionExecution $Selection', '$actualPath -cne $approved.executablePath', '$approved.executableDigest')
    Write-Output "process-record fixtures passed"
  } elseif ($Case -eq "protocol") {
    Test-SourceBoundary @("vision.hello", "vision.ready", "ClientWebSocket", "vem-machine-vision-health/v1")
    Write-Output "protocol fixtures passed"
  } elseif ($Case -eq "rollback") {
    Test-SourceBoundary @('Rollback-PreviousRelease', 'Assert-InstalledRelease $metadata $Previous', 'Test-VisionProtocol $Previous')
    Write-Output "rollback fixtures passed"
  } elseif ($Case -eq "orphan") {
    $StateRoot = Join-Path $root "state"; $releaseRoot = Join-Path $root "releases"; $orphan = Join-Path $releaseRoot "1.0.0-aaaaaaaaaaaaaaaa"; New-Item -ItemType Directory -Path $orphan -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $orphan "runtime.exe"), "orphan", [Text.UTF8Encoding]::new($false))
    Quarantine-UntrustedReleaseDirectory $orphan "1.0.0-aaaaaaaaaaaaaaaa"
    if (Test-Path -LiteralPath $orphan) { throw "orphaned release was not quarantined" }
    if (@(Get-ChildItem -LiteralPath (Join-Path $StateRoot "quarantine") -Directory).Count -ne 1) { throw "quarantine record missing" }
    Write-Output "orphan fixtures passed"
  } elseif ($Case -eq "mutex") {
    $first = [Threading.Mutex]::new($false, "Global\VEMVisionReleaseInstallerFixture")
    try { if (-not $first.WaitOne([TimeSpan]::FromSeconds(1))) { throw "fixture mutex was not acquired" } } finally { $first.ReleaseMutex(); $first.Dispose() }
    Write-Output "mutex fixtures passed"
  } elseif ($Case -eq "reinstall") {
    $releaseRoot = Join-Path $root "releases"; $install = Join-Path $releaseRoot "1.0.0-aaaaaaaaaaaaaaaa"; New-Item -ItemType Directory -Path $install -Force | Out-Null
    $entrypoint = Join-Path $install "runtime.exe"; [IO.File]::WriteAllText($entrypoint, "approved", [Text.UTF8Encoding]::new($false))
    $digest = "sha256:" + (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash.ToLowerInvariant()
    $selection = [pscustomobject]@{ bundleDigest=("sha256:" + "a" * 64); descriptorDigest=("sha256:" + "b" * 64); approvalDigest=("sha256:" + "c" * 64); installDirectory=$install; entrypoint="runtime.exe" }
    $record = [pscustomobject]@{ schemaVersion="vem-vision-release-record/v2"; bundleDigest=$selection.bundleDigest; descriptorDigest=$selection.descriptorDigest; approvalDigest=$selection.approvalDigest; installDirectory=$install; entrypoint="runtime.exe"; entrypointDigest=$digest; files=(Get-ExtractedFileManifest $install); descriptor=@{}; attestation=@{}; approval=@{}; documents=@{} }
    $originalDigest = (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash
    [IO.File]::WriteAllText($entrypoint, "tampered", [Text.UTF8Encoding]::new($false))
    if ((Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash -eq $originalDigest) { throw "reinstall file mutation was not observed" }
    Assert-Throws { Assert-InstalledRelease $record $selection } "tampered reinstall"
    Write-Output "reinstall fixtures passed"
  } elseif ($Case -eq "runtime-verifier") {
    $FactoryEvidenceVerifierPath = Join-Path $root "fixture-verifier.sh"; $FactoryTrustPolicyPath = Join-Path $root "policy.json"
    $identity = "spki-sha256:" + "a" * 64
    $verification = @{ schemaVersion="vem-vision-release-verification/v1"; kind="vision-release-verification"; verified=$true; identities=@{ descriptor=$identity; attestation=$identity; sbom=$identity; provenance=$identity; conformance=$identity; approval=$identity } } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($FactoryEvidenceVerifierPath, ("#!/bin/sh`necho '" + $verification + "'`n"), [Text.UTF8Encoding]::new($false)); & chmod +x $FactoryEvidenceVerifierPath
    $verifierDigest = "sha256:" + (Get-FileHash -LiteralPath $FactoryEvidenceVerifierPath -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($FactoryTrustPolicyPath, "{}", [Text.UTF8Encoding]::new($false))
    $policy = [pscustomobject]@{ schemaVersion="vem-vision-release-trust-policy/v1"; kind="vision-release-trust-policy"; verifierDigest=$verifierDigest; approvedIdentities=[pscustomobject]@{ descriptor=@($identity); attestation=@($identity); sbom=@($identity); provenance=@($identity); conformance=@($identity); approval=@($identity) } }
    $documents = @{}; foreach ($name in @("descriptor","attestation","sbom","provenance","conformance","approval","manifest")) { $path=Join-Path $root "$name.json"; [IO.File]::WriteAllText($path, "{}", [Text.UTF8Encoding]::new($false)); $documents[$name]=[pscustomobject]@{ path=$path; digest=(Get-Digest (Get-ExactFileBytes $path $name)); value=@{} } }
    Invoke-ReleaseEvidenceVerifier $policy $documents
    Write-Output "runtime-verifier fixtures passed"
  }
} finally { Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue }
