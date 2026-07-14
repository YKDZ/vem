[CmdletBinding()]
param(
  [string]$BundlePath,
  [string]$DescriptorPath,
  [string]$AttestationPath,
  [string]$SbomPath,
  [string]$ProvenancePath,
  [string]$ConformanceEvidencePath,
  [string]$ApprovalPath,
  [string]$FactoryManifestPath,
  [string]$ConfigurationPath,
  [string]$EvidencePath = "C:\ProgramData\VEM\evidence\vision-release-install.json",
  [string]$VisionRoot = "C:\VEM\vision",
  [string]$StateRoot = "C:\ProgramData\VEM\vision",
  [string]$TaskUser = "VEMKiosk"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -eq "Desktop") { $env:PSModulePath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\Modules;$env:PSModulePath" }
Import-Module (Join-Path $PSScriptRoot "vision-release-materialization.psm1") -Force -ErrorAction Stop

$releaseRoot = Join-Path $VisionRoot "releases"
$visionRoot = $VisionRoot # Kept for task/runbook compatibility.
$configurationRoot = Join-Path $StateRoot "config"
$selectionPath = Join-Path $StateRoot "current.json"
$metadataRoot = Join-Path $StateRoot "release-metadata"
$processStateRoot = Join-Path $StateRoot "process-state"
$processPath = Join-Path $processStateRoot "active-process.json"
$launcherPath = "C:\VEM\bringup\start_vision.bat"
$launcherScriptPath = "C:\VEM\bringup\launch-vision-release.ps1"
$FactoryTrustRoot = "C:\ProgramData\VEM\factory-trust"
$FactoryTrustPolicyPath = "$FactoryTrustRoot\vision-release-trust-policy.json"
$FactoryEvidenceVerifierPath = "$FactoryTrustRoot\vision-release-verifier.exe"
$FactoryTrustAnchorPath = "$FactoryTrustRoot\vision-release-trust-anchor.json"
$maxArchiveEntries = 4096
$maxExpandedBytes = 4GB
$maxExpansionRatio = 200

function Throw-InstallError([string]$Message) { throw "Vision release installation failed: $Message" }

function Assert-SafeLocalPath([string]$Path, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '[\x00-\x1f]' -or $Path -match '^(\\\\|//)') {
    Throw-InstallError "$Label must be an absolute local path"
  }
  if ($env:OS -eq "Windows_NT") {
    if ($Path -notmatch '^[A-Za-z]:\\') { Throw-InstallError "$Label must be an absolute local Windows path" }
  } elseif ($Path -notmatch '^/' -or $Path -match '^[A-Za-z]:|\\') {
    Throw-InstallError "$Label must be an absolute local Unix path"
  }
}

function Assert-Digest([string]$Digest, [string]$Label) {
  if ($Digest -notmatch '^sha256:[a-f0-9]{64}$') { Throw-InstallError "$Label digest is invalid" }
}

function ConvertTo-LowerHex([byte[]]$Bytes) {
  return ([BitConverter]::ToString($Bytes).Replace("-", "")).ToLowerInvariant()
}

function Get-Digest([byte[]]$Bytes) {
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    return "sha256:" + (ConvertTo-LowerHex $hash.ComputeHash($Bytes))
  } finally {
    $hash.Dispose()
  }
}

function ConvertTo-WindowsCommandLineArgument([string]$Argument) {
  if ($null -eq $Argument) { return '""' }
  $escaped = [regex]::Replace($Argument, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}

function Get-ExactFileBytes {
  param([string]$Path, [string]$Label, [Int64]$MaximumBytes = 16MB)
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    Throw-InstallError "$Label must be a regular non-reparse file"
  }
  if ($item.Length -lt 1 -or $item.Length -gt $MaximumBytes) { Throw-InstallError "$Label size is invalid" }
  $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    if ($stream.Length -ne $item.Length) { Throw-InstallError "$Label changed while opening" }
    $bytes = [byte[]]::new($stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($count -le 0) { Throw-InstallError "$Label read was incomplete" }
      $offset += $count
    }
    if ($stream.Length -ne $item.Length -or (Get-Item -LiteralPath $item.FullName -Force).Length -ne $item.Length) {
      Throw-InstallError "$Label changed while reading"
    }
    return ,$bytes
  } finally { $stream.Dispose() }
}

function Assert-NonReparsePath([string]$Path, [string]$Label) {
  Assert-SafeLocalPath $Path $Label
  $cursor = [IO.Path]::GetFullPath($Path)
  while (-not [string]::IsNullOrWhiteSpace($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Throw-InstallError "$Label must not traverse a reparse point"
      }
    }
    $parent = Split-Path -Parent $cursor
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
}

function Get-CanonicalContainedPath([string]$Root, [string]$Candidate, [string]$Label) {
  Assert-NonReparsePath $Root "$Label root"
  Assert-NonReparsePath $Candidate $Label
  $canonicalRoot = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
  $canonicalCandidate = [IO.Path]::GetFullPath($Candidate)
  $prefix = $canonicalRoot + [IO.Path]::DirectorySeparatorChar
  if (-not $canonicalCandidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    Throw-InstallError "$Label is outside its trusted root"
  }
  return $canonicalCandidate
}

function Join-TrustedRelativePath([string]$Root, [string]$Relative, [string]$Label) {
  if ($Relative -notmatch '^(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[A-Za-z0-9][A-Za-z0-9._-]*(?:[\\/][A-Za-z0-9][A-Za-z0-9._-]*)*$') {
    Throw-InstallError "$Label must be a canonical relative path"
  }
  return Get-CanonicalContainedPath $Root (Join-Path $Root $Relative) $Label
}

function Assert-SystemOwnedPath([string]$Path, [string]$Label) {
  Assert-NonReparsePath $Path $Label
  if ($env:OS -ne "Windows_NT") { return }
  $acl = Get-Acl -LiteralPath $Path
  foreach ($rule in @($acl.Access)) {
    if ($rule.AccessControlType -eq "Allow" -and [string]$rule.IdentityReference -match 'VEMKiosk|Users|Everyone' -and (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -ne 0)) {
      Throw-InstallError "$Label is writable by an untrusted identity"
    }
  }
}

function Assert-FactoryTrustAcl {
  Assert-NonReparsePath $FactoryTrustRoot "factory trust root"
  foreach ($path in @($FactoryTrustRoot, $FactoryTrustPolicyPath, $FactoryEvidenceVerifierPath, $FactoryTrustAnchorPath)) {
    if (-not (Test-Path -LiteralPath $path)) { Throw-InstallError "factory-installed trust material is missing" }
  }
  if ($env:OS -ne "Windows_NT") { return }
  foreach ($path in @($FactoryTrustRoot, $FactoryTrustPolicyPath, $FactoryEvidenceVerifierPath, $FactoryTrustAnchorPath)) {
    $acl = Get-Acl -LiteralPath $path
    if (-not $acl.AreAccessRulesProtected) { Throw-InstallError "factory trust material ACL is inherited" }
    foreach ($rule in @($acl.Access)) {
      if ($rule.AccessControlType -eq "Allow" -and [string]$rule.IdentityReference -match "VEMKiosk|Users|Everyone" -and (($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write) -ne 0)) {
        Throw-InstallError "factory trust material is writable by an untrusted identity"
      }
    }
  }
}

function Get-FactoryTrustPolicy {
  Assert-FactoryTrustAcl
  $anchor = Read-StrictJson $FactoryTrustAnchorPath "factory Vision trust anchor"
  Assert-Keys $anchor.value @("schemaVersion", "kind", "trustPolicyDigest", "verifierDigest") "factory Vision trust anchor"
  if ($anchor.value.schemaVersion -cne "vem-factory-vision-trust-anchor/v1" -or $anchor.value.kind -cne "factory-vision-trust-anchor") { Throw-InstallError "factory Vision trust anchor schema is invalid" }
  Assert-Digest ([string]$anchor.value.trustPolicyDigest) "factory Vision trust policy"; Assert-Digest ([string]$anchor.value.verifierDigest) "factory Vision verifier"
  $policy = Read-StrictJson $FactoryTrustPolicyPath "factory Vision trust policy"
  if ($policy.digest -cne [string]$anchor.value.trustPolicyDigest) { Throw-InstallError "factory Vision trust policy digest mismatch" }
  $verifier = Get-ExactFileBytes $FactoryEvidenceVerifierPath "factory Vision verifier" 64MB
  if ((Get-Digest $verifier) -cne [string]$anchor.value.verifierDigest) { Throw-InstallError "factory Vision verifier digest mismatch" }
  return $policy.value
}

function Read-StrictJson {
  param([string]$Path, [string]$Label, [Int64]$MaximumBytes = 16MB)
  $bytes = Get-ExactFileBytes -Path $Path -Label $Label -MaximumBytes $MaximumBytes
  try { $value = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json } catch { Throw-InstallError "$Label is not valid UTF-8 JSON" }
  return [pscustomobject]@{ value = $value; bytes = $bytes; digest = (Get-Digest $bytes) }
}

function Assert-Keys {
  param([object]$Value, [string[]]$Keys, [string]$Label)
  if ($null -eq $Value) { Throw-InstallError "$Label is missing" }
  $actual = @($Value.PSObject.Properties.Name | Sort-Object)
  $expected = @($Keys | Sort-Object)
  if ($actual.Count -ne $expected.Count -or (Compare-Object $actual $expected)) { Throw-InstallError "$Label has unknown or missing fields" }
}

function Assert-EvidenceReference {
  param([string]$Identity, [string]$Digest, [string]$Label)
  Assert-Digest $Digest $Label
  if ($Identity -cne ("factory-evidence://" + $Digest.Replace(':', '/'))) { Throw-InstallError "$Label identity does not bind its exact bytes" }
}

function Assert-SemVer([string]$Value, [string]$Label) {
  if ($Value -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$') { Throw-InstallError "$Label is not strict SemVer" }
}

function Invoke-ReleaseEvidenceVerifier {
  param([object]$Policy, [hashtable]$Documents)
  Assert-Keys $Policy @("schemaVersion", "kind", "verifierDigest", "approvedIdentities") "Vision trust policy"
  Assert-Keys $Policy.approvedIdentities @("descriptor", "attestation", "sbom", "provenance", "conformance", "approval") "Vision trust policy identities"
  if ($Policy.schemaVersion -cne "vem-vision-release-trust-policy/v1" -or $Policy.kind -cne "vision-release-trust-policy") { Throw-InstallError "Vision trust policy contract is invalid" }
  Assert-Digest ([string]$Policy.verifierDigest) "Vision evidence verifier"
  $verifierBytes = Get-ExactFileBytes -Path $FactoryEvidenceVerifierPath -Label "Vision evidence verifier" -MaximumBytes 64MB
  if ((Get-Digest $verifierBytes) -cne [string]$Policy.verifierDigest) { Throw-InstallError "Vision evidence verifier digest mismatch" }
  if (@($Documents.Values | Where-Object { $_.digest -notmatch '^sha256:' }).Count -ne 0) { Throw-InstallError "Vision evidence inputs are invalid" }
  # The verifier is a separately pinned, language-neutral release-contract implementation.
  # Quote every value with the Windows CommandLineToArgvW-compatible routine before assigning Arguments.
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = (Get-Item -LiteralPath $FactoryEvidenceVerifierPath -Force).FullName
  $start.UseShellExecute = $false; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  $arguments = [Collections.Generic.List[string]]::new()
  $arguments.Add("verify")
  foreach ($name in @("descriptor", "attestation", "sbom", "provenance", "conformance", "approval", "manifest")) {
    $arguments.Add("--$name-digest"); $arguments.Add([string]$Documents[$name].digest)
    $arguments.Add("--$name-path"); $arguments.Add([string]$Documents[$name].path)
  }
  $arguments.Add("--policy"); $arguments.Add((Get-Item -LiteralPath $FactoryTrustPolicyPath -Force).FullName)
  $start.Arguments = ((@($arguments) | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string]$_) }) -join " ")
  $process = [Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd(); $stderr = $process.StandardError.ReadToEnd(); $process.WaitForExit()
  if ($process.ExitCode -ne 0 -or $stdout.Length -gt 16384) { Throw-InstallError "cryptographic release evidence verification failed" }
  try { $result = $stdout | ConvertFrom-Json } catch { Throw-InstallError "cryptographic release evidence verifier returned invalid output" }
  Assert-Keys $result @("schemaVersion", "kind", "verified", "identities") "Vision evidence verification result"
  if ($result.schemaVersion -cne "vem-vision-release-verification/v1" -or $result.kind -cne "vision-release-verification" -or $result.verified -ne $true) { Throw-InstallError "cryptographic release evidence verification was not approved" }
  foreach ($role in @("descriptor", "attestation", "sbom", "provenance", "conformance", "approval")) {
    $approved = @($Policy.approvedIdentities.$role)
    if ($approved.Count -eq 0 -or @($approved | Where-Object { [string]$_ -notmatch '^spki-sha256:[a-f0-9]{64}$' }).Count -gt 0) { Throw-InstallError "Vision $role approved identities are invalid" }
    if ($approved -notcontains [string]$result.identities.$role) { Throw-InstallError "Vision $role signer is not an approved identity" }
  }
}

function Assert-ReleaseContracts {
  param([object]$Descriptor, [object]$Attestation, [object]$Approval, [object]$Manifest, [hashtable]$Documents)
  Assert-Keys $Descriptor @("schemaVersion", "kind", "identity", "releaseVersion", "bundle", "entrypoint", "lifecycle", "configuration", "health", "protocol", "sbom", "provenance") "Vision descriptor"
  Assert-Keys $Descriptor.bundle @("digest", "bytes", "platform", "format", "extractor") "Vision descriptor bundle"
  Assert-Keys $Descriptor.bundle.platform @("os", "architecture") "Vision descriptor platform"
  Assert-Keys $Descriptor.bundle.extractor @("contractVersion", "handler") "Vision descriptor extractor"
  Assert-Keys $Descriptor.entrypoint @("command", "arguments") "Vision descriptor entrypoint"
  Assert-Keys $Descriptor.lifecycle @("requiresInteractiveSession", "shutdownTimeoutMs") "Vision descriptor lifecycle"
  Assert-Keys $Descriptor.configuration @("format", "schemaVersion", "argument") "Vision descriptor configuration"
  Assert-Keys $Descriptor.health @("port", "path", "expectedStatus", "timeoutMs") "Vision descriptor health"
  Assert-Keys $Descriptor.protocol @("version", "webSocketPath") "Vision descriptor protocol"
  Assert-Keys $Descriptor.sbom @("identity", "digest", "format") "Vision descriptor SBOM"
  Assert-Keys $Descriptor.provenance @("identity", "digest", "predicateType") "Vision descriptor provenance"
  if ($Descriptor.schemaVersion -cne "vem-vision-release-descriptor/v1" -or $Descriptor.kind -cne "vision-release-descriptor" -or $Descriptor.bundle.platform.os -cne "windows" -or $Descriptor.lifecycle.requiresInteractiveSession -ne $true -or $Descriptor.bundle.platform.architecture -notin @("x86_64", "arm64") -or $Descriptor.bundle.extractor.handler -notin @("zip-safe-v1", "vendor-installer-v1") -or $Descriptor.configuration.format -notin @("json", "yaml", "toml") -or $Descriptor.protocol.version -cne "vem.vision.v1" -or $Descriptor.sbom.format -notin @("spdx-json", "cyclonedx-json") -or $Descriptor.provenance.predicateType -cne "https://slsa.dev/provenance/v1") { Throw-InstallError "Vision descriptor contract is invalid" }
  Assert-SemVer ([string]$Descriptor.releaseVersion) "Vision descriptor releaseVersion"
  Assert-Digest ([string]$Descriptor.identity) "Vision descriptor"; Assert-Digest ([string]$Descriptor.bundle.digest) "Vision bundle"
  if (-not [Int64]::TryParse([string]$Descriptor.bundle.bytes, [ref]([Int64]0)) -or [Int64]$Descriptor.bundle.bytes -lt 1 -or [Int64]$Descriptor.health.port -lt 1 -or [Int64]$Descriptor.health.port -gt 65535 -or [Int64]$Descriptor.health.expectedStatus -lt 200 -or [Int64]$Descriptor.health.expectedStatus -gt 299 -or [Int64]$Descriptor.health.timeoutMs -lt 100 -or [Int64]$Descriptor.health.timeoutMs -gt 120000 -or [Int64]$Descriptor.lifecycle.shutdownTimeoutMs -lt 100 -or [Int64]$Descriptor.lifecycle.shutdownTimeoutMs -gt 120000) { Throw-InstallError "Vision descriptor numeric contract is invalid" }
  if ($Descriptor.bundle.extractor.contractVersion -cne "vem-vision-extractor/v1" -or [string]::IsNullOrWhiteSpace([string]$Descriptor.bundle.extractor.handler)) { Throw-InstallError "Vision extractor contract is invalid" }
  if ([string]$Descriptor.entrypoint.command -notmatch '^(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[A-Za-z0-9][A-Za-z0-9._-]*(?:[\\/][A-Za-z0-9][A-Za-z0-9._-]*)*$') { Throw-InstallError "Vision entrypoint is unsafe" }
  if ([string]$Descriptor.configuration.argument -notmatch '^--[A-Za-z0-9][A-Za-z0-9-]*$') { Throw-InstallError "Vision configuration argument is unsafe" }
  foreach ($item in @(@{ value = $Descriptor.sbom; name = "SBOM"; document = "sbom" }, @{ value = $Descriptor.provenance; name = "provenance"; document = "provenance" })) {
    Assert-EvidenceReference ([string]$item.value.identity) ([string]$item.value.digest) ("Vision " + $item.name)
    if ($Documents[$item.document].digest -cne [string]$item.value.digest) { Throw-InstallError "Vision $($item.name) bytes do not match descriptor" }
  }
  Assert-Keys $Attestation @("schemaVersion", "kind", "bundleDigest", "descriptorDigest", "sbomDigest", "provenanceDigest", "signerIdentity") "Vision attestation"
  Assert-Keys $Approval @("schemaVersion", "kind", "identity", "releaseVersion", "bundleDigest", "descriptorDigest", "attestationDigest", "conformanceEvidenceDigest", "approverIdentity") "Vision approval"
  if ($Attestation.schemaVersion -cne "vem-vision-artifact-attestation/v1" -or $Attestation.kind -cne "vision-artifact-attestation" -or $Approval.schemaVersion -cne "vem-vision-release-approval/v1" -or $Approval.kind -cne "vision-release-approval") { Throw-InstallError "Vision attestation or approval schema is invalid" }
  foreach ($name in @("bundleDigest", "descriptorDigest", "sbomDigest", "provenanceDigest")) { Assert-Digest ([string]$Attestation.$name) "Vision attestation $name" }
  foreach ($name in @("identity", "bundleDigest", "descriptorDigest", "attestationDigest", "conformanceEvidenceDigest")) { Assert-Digest ([string]$Approval.$name) "Vision approval $name" }
  if ([string]$Attestation.signerIdentity -notmatch '^spki-sha256:[a-f0-9]{64}$' -or [string]$Approval.approverIdentity -notmatch '^vem-release-approval:[a-z0-9-]+$') { Throw-InstallError "Vision signer identity is invalid" }
  $conformance = $Documents.conformance.value
  Assert-Keys $conformance @("schemaVersion", "kind", "bundleDigest", "descriptorDigest", "protocolVersion") "Vision conformance evidence"
  if ($conformance.schemaVersion -cne "vem-vision-conformance/v1" -or $conformance.kind -cne "vision-release-conformance" -or $conformance.protocolVersion -cne "vem.vision.v1" -or $conformance.bundleDigest -cne $Descriptor.bundle.digest -or $conformance.descriptorDigest -cne $Descriptor.identity) { Throw-InstallError "Vision conformance evidence is invalid" }
  $asset = @($Manifest.assets | Where-Object { $_.role -ceq "vision-release" })
  if ($asset.Count -ne 1) { Throw-InstallError "Factory Manifest must select exactly one Vision release" }
  $selection = $asset[0].release
  foreach ($name in @("descriptor", "attestation", "approval", "conformanceEvidence")) { Assert-EvidenceReference ([string]$selection."$($name)Identity") ([string]$selection."$($name)Digest") "Factory Manifest $name" }
  if ($asset[0].digest -cne $Descriptor.bundle.digest -or $asset[0].version -cne $Descriptor.releaseVersion -or $selection.descriptorDigest -cne $Descriptor.identity -or $selection.attestationDigest -cne $Documents.attestation.digest -or $selection.approvalDigest -cne $Documents.approval.digest -or $selection.conformanceEvidenceDigest -cne $Documents.conformance.digest -or $Attestation.bundleDigest -cne $Descriptor.bundle.digest -or $Attestation.descriptorDigest -cne $Descriptor.identity -or $Attestation.sbomDigest -cne $Descriptor.sbom.digest -or $Attestation.provenanceDigest -cne $Descriptor.provenance.digest -or $Approval.bundleDigest -cne $Descriptor.bundle.digest -or $Approval.descriptorDigest -cne $Descriptor.identity -or $Approval.attestationDigest -cne $Documents.attestation.digest -or $Approval.conformanceEvidenceDigest -cne $Documents.conformance.digest -or $Approval.releaseVersion -cne $Descriptor.releaseVersion) { Throw-InstallError "release evidence does not bind the selected approved bundle" }
}

function Get-SafeArchivePath([string]$Name) {
  if ([string]::IsNullOrWhiteSpace($Name) -or $Name -match '^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)|(^|[\\/])[^\\/]*:|[\x00-\x1f]') { Throw-InstallError "Vision archive contains an unsafe path" }
  $segments = $Name -split '[\\/]'
  if ($segments | Where-Object { $_ -eq "" -or $_ -eq "." -or $_.EndsWith(".") -or $_.EndsWith(" ") -or $_ -match '^(?i:(CON|PRN|AUX|NUL|CLOCK\$|COM[1-9]|LPT[1-9]))(?:\..*)?$' }) { Throw-InstallError "Vision archive contains an unsafe or reserved device path" }
  return ($segments -join "\\")
}

function Get-ExtractedFileManifest([string]$InstallDirectory) {
  Assert-NonReparsePath $InstallDirectory "Vision release directory"
  $files = [Collections.Generic.List[object]]::new()
  foreach ($directory in @(Get-ChildItem -LiteralPath $InstallDirectory -Directory -Recurse -Force)) {
    if (($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Throw-InstallError "Vision release contains a reparse directory" }
  }
  foreach ($item in @(Get-ChildItem -LiteralPath $InstallDirectory -File -Recurse -Force | Sort-Object FullName)) {
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { Throw-InstallError "Vision release contains a reparse file" }
    [void](Get-CanonicalContainedPath $InstallDirectory $item.FullName "Vision extracted file")
    $relative = $item.FullName.Substring($InstallDirectory.Length).TrimStart('\','/')
    [void](Get-SafeArchivePath $relative)
    $files.Add([ordered]@{ path=$relative.Replace('\','/'); bytes=[Int64]$item.Length; digest=("sha256:" + (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()) })
  }
  if ($files.Count -eq 0) { Throw-InstallError "Vision release contains no files" }
  return @($files)
}

function Assert-InstalledRelease([object]$Record, [object]$Selection) {
  Assert-Keys $Record @("schemaVersion","bundleDigest","descriptorDigest","approvalDigest","installDirectory","entrypoint","entrypointDigest","files","descriptor","attestation","approval","documents") "Vision release record"
  if ($Record.schemaVersion -cne "vem-vision-release-record/v2" -or $Record.bundleDigest -cne $Selection.bundleDigest -or $Record.descriptorDigest -cne $Selection.descriptorDigest -or $Record.approvalDigest -cne $Selection.approvalDigest -or $Record.installDirectory -cne $Selection.installDirectory -or $Record.entrypoint -cne $Selection.entrypoint) { Throw-InstallError "installed Vision release metadata does not bind selection" }
  Assert-Digest ([string]$Record.entrypointDigest) "Vision entrypoint"; [void](Get-CanonicalContainedPath $releaseRoot ([string]$Record.installDirectory) "Vision release directory")
  $actual = @(Get-ExtractedFileManifest ([string]$Record.installDirectory))
  $expected = @($Record.files)
  if ($actual.Count -ne $expected.Count) { Throw-InstallError "installed Vision release files do not match immutable metadata" }
  for ($index = 0; $index -lt $actual.Count; $index++) {
    Assert-Keys $expected[$index] @("path", "bytes", "digest") "Vision release file record"
    if (
      [string]$actual[$index].path -cne [string]$expected[$index].path -or
      [Int64]$actual[$index].bytes -ne [Int64]$expected[$index].bytes -or
      [string]$actual[$index].digest -cne [string]$expected[$index].digest
    ) {
      Throw-InstallError ("installed Vision release file[{0}] mismatch: actual={1} expected={2}" -f $index, ($actual[$index] | ConvertTo-Json -Compress), ($expected[$index] | ConvertTo-Json -Compress))
    }
  }
  $entrypoint = Join-TrustedRelativePath $Record.installDirectory $Record.entrypoint "Vision entrypoint"
  if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf) -or ("sha256:" + (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash.ToLowerInvariant()) -cne $Record.entrypointDigest) { Throw-InstallError "installed Vision entrypoint digest does not match immutable metadata" }
}

function Resolve-ApprovedVisionExecution([object]$ExpectedSelection) {
  Assert-SystemOwnedPath $selectionPath "Vision current selection"
  $selection = (Read-StrictJson $selectionPath "Vision current selection").value
  Assert-Keys $selection @("schemaVersion","revision","bundleDigest","descriptorDigest","approvalDigest","installDirectory","entrypoint","arguments","configurationArgument","configurationPath","metadataPath") "Vision current selection"
  if ($selection.schemaVersion -cne "vem-vision-selection/v1" -or $selection.revision -cne $ExpectedSelection.revision -or $selection.bundleDigest -cne $ExpectedSelection.bundleDigest) { Throw-InstallError "Vision current selection does not match the approved revision" }
  [void](Get-CanonicalContainedPath $metadataRoot ([string]$selection.metadataPath) "Vision release metadata")
  Assert-SystemOwnedPath ([string]$selection.metadataPath) "Vision release metadata"
  $record = (Read-StrictJson ([string]$selection.metadataPath) "Vision release record").value
  Assert-InstalledRelease $record $selection
  $documents = @{}
  foreach ($name in @("descriptor","attestation","sbom","provenance","conformance","approval","manifest")) {
    $documents[$name] = [pscustomobject]@{ value=$record.documents.$name.value; digest=$record.documents.$name.digest; path=$null }
  }
  Assert-ReleaseContracts $record.descriptor $record.attestation $record.approval $documents.manifest.value $documents
  $entrypoint = Join-TrustedRelativePath ([string]$record.installDirectory) ([string]$record.entrypoint) "approved Vision executable"
  return [pscustomobject]@{ revision=$selection.revision; bundleDigest=$record.bundleDigest; executablePath=$entrypoint; executableDigest=$record.entrypointDigest }
}

function Quarantine-UntrustedReleaseDirectory([string]$InstallDirectory, [string]$ReleaseKey) {
  if (-not (Test-Path -LiteralPath $InstallDirectory)) { return }
  $quarantineRoot = Join-Path $StateRoot "quarantine"
  New-Item -ItemType Directory -Path $quarantineRoot -Force | Out-Null
  Set-SystemInstallerAcl $quarantineRoot $false
  $destination = Join-Path $quarantineRoot ("{0}-{1}" -f $ReleaseKey, [guid]::NewGuid().ToString("N"))
  Assert-NonReparsePath $InstallDirectory "untrusted Vision release directory"
  Move-Item -LiteralPath $InstallDirectory -Destination $destination -ErrorAction Stop
  Assert-NonReparsePath $destination "quarantined Vision release directory"
  Set-SystemInstallerAcl $destination $false
}

function Write-AtomicJson([string]$Path, [object]$Value) {
  $parent = Split-Path -Parent $Path; New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporary = Join-Path $parent ("." + [guid]::NewGuid().ToString("N") + ".tmp")
  $backup = Join-Path $parent ("." + [guid]::NewGuid().ToString("N") + ".bak")
  try { [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 64 -Compress), [Text.UTF8Encoding]::new($false)); if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, $backup) } else { [IO.File]::Move($temporary, $Path) } } finally { Remove-Item -LiteralPath $temporary,$backup -Force -ErrorAction SilentlyContinue }
}

function Set-SystemInstallerAcl([string]$Path, [bool]$KioskReadable) {
  if ($env:OS -ne "Windows_NT") { return }
  $inheritanceFlags = if ((Get-Item -LiteralPath $Path -Force).PSIsContainer) {
    "ContainerInherit,ObjectInherit"
  } else {
    "None"
  }
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
  foreach ($identity in @("SYSTEM", "BUILTIN\\Administrators")) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, "FullControl", $inheritanceFlags, "None", "Allow")) }
  if ($KioskReadable) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new("VEMKiosk", "ReadAndExecute", $inheritanceFlags, "None", "Allow")) }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

function Set-VisionStateAcl {
  New-Item -ItemType Directory -Path $StateRoot,$processStateRoot -Force | Out-Null
  Set-SystemInstallerAcl $StateRoot $true
  Set-SystemInstallerAcl $processStateRoot $false
  if ($env:OS -eq "Windows_NT") {
    $acl = Get-Acl -LiteralPath $processStateRoot
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new("VEMKiosk", "Modify", "ContainerInherit,ObjectInherit", "None", "Allow"))
    Set-Acl -LiteralPath $processStateRoot -AclObject $acl
  }
}

function Stop-VerifiedProcessTree([Diagnostics.Process]$Process) {
  if ($env:OS -ne "Windows_NT") {
    $Process.Kill()
    return
  }

  $taskKillPath = Join-Path $env:WINDIR "System32\taskkill.exe"
  & $taskKillPath /PID ([string]$Process.Id) /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Throw-InstallError "recorded Vision process $($Process.Id) tree cleanup failed: taskkill /T /F exited with code $LASTEXITCODE"
  }
}

function Stop-RecordedVision([object]$Selection) {
  Stop-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $processPath -PathType Leaf)) { return }
  $record = (Read-StrictJson $processPath "Vision process record").value
  $legacyKeys = @("bundleDigest", "processId", "creationTimeUtc", "executablePath", "executableDigest", "selectionRevision")
  $recordKeys = @($record.PSObject.Properties.Name | Sort-Object)
  $expectedLegacyKeys = @($legacyKeys | Sort-Object)
  $isExpectedLegacyRecord = $null -ne $record.PSObject.Properties["creationTimeUtc"] -and $null -eq $record.PSObject.Properties["creationTimeUtcTicks"] -and $recordKeys.Count -eq $expectedLegacyKeys.Count -and -not (Compare-Object $recordKeys $expectedLegacyKeys)
  if ($isExpectedLegacyRecord) {
    Throw-InstallError "Vision process record uses unsupported legacy creationTimeUtc identity; hard migration requires creationTimeUtcTicks"
  }
  Assert-Keys $record @("bundleDigest", "processId", "creationTimeUtcTicks", "executablePath", "executableDigest", "selectionRevision") "Vision process record"
  $approved = Resolve-ApprovedVisionExecution $Selection
  [int]$recordedProcessId = 0
  if ($record.bundleDigest -cne $approved.bundleDigest -or $record.selectionRevision -cne $approved.revision -or -not [int]::TryParse([string]$record.processId, [ref]$recordedProcessId) -or $recordedProcessId -lt 1 -or $record.creationTimeUtcTicks -isnot [Int64] -or $record.creationTimeUtcTicks -lt 1) { return }
  $process = Get-Process -Id $recordedProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    Remove-Item -LiteralPath $processPath -Force -ErrorAction SilentlyContinue
    return
  }
  if ($process -isnot [Diagnostics.Process]) { return }
  try {
    if ($process.HasExited) {
      Remove-Item -LiteralPath $processPath -Force -ErrorAction SilentlyContinue
      return
    }
    if ($process.StartTime.ToUniversalTime().Ticks -ne $record.creationTimeUtcTicks -or -not (Test-Path -LiteralPath $process.Path -PathType Leaf)) { return }
    try {
      $actualPath = Get-CanonicalContainedPath $releaseRoot ([string]$process.Path) "recorded Vision executable"
    } catch {
      return
    }
    if ($actualPath -cne $approved.executablePath) { return }
    if (("sha256:" + (Get-FileHash -LiteralPath $actualPath -Algorithm SHA256).Hash.ToLowerInvariant()) -cne $approved.executableDigest) { return }
    if (-not $process.HasExited) {
      try {
        Stop-VerifiedProcessTree $process
      } catch [InvalidOperationException] {
        if (-not $process.HasExited) { throw }
      }
    }
    if (-not $process.WaitForExit(5000) -and -not $process.HasExited) {
      Throw-InstallError "recorded Vision process $recordedProcessId did not exit after termination"
    }
    Remove-Item -LiteralPath $processPath -Force -ErrorAction SilentlyContinue
  } catch [InvalidOperationException] {
    if (-not $process.HasExited) { throw }
    Remove-Item -LiteralPath $processPath -Force -ErrorAction SilentlyContinue
  } finally {
    $process.Dispose()
  }
}

function Write-VisionLauncher {
  New-Item -ItemType Directory -Path (Split-Path -Parent $launcherPath) -Force | Out-Null
  $launcher = @'
$ErrorActionPreference = "Stop"
$stateRoot = "C:\ProgramData\VEM\vision"
$selection = Get-Content -LiteralPath (Join-Path $stateRoot "current.json") -Raw -Encoding UTF8 | ConvertFrom-Json
$entrypoint = Join-Path $selection.installDirectory $selection.entrypoint
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) { throw "selected Vision entrypoint missing" }
function ConvertTo-WindowsCommandLineArgument([string]$Argument) {
  if ($null -eq $Argument) { return '""' }
  $escaped = [regex]::Replace($Argument, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}
if ($null -eq ("VemVisionLauncher.NativeProcess" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace VemVisionLauncher {
  public sealed class NativeProcess : IDisposable {
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint WAIT_OBJECT_0 = 0;
    private const uint WAIT_TIMEOUT = 258;
    private const uint TERMINATION_CONFIRMATION_TIMEOUT_MS = 5000;
    private IntPtr processHandle;
    private IntPtr threadHandle;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO {
      public uint cb;
      public IntPtr lpReserved;
      public IntPtr lpDesktop;
      public IntPtr lpTitle;
      public uint dwX;
      public uint dwY;
      public uint dwXSize;
      public uint dwYSize;
      public uint dwXCountChars;
      public uint dwYCountChars;
      public uint dwFillAttribute;
      public uint dwFlags;
      public ushort wShowWindow;
      public ushort cbReserved2;
      public IntPtr lpReserved2;
      public IntPtr hStdInput;
      public IntPtr hStdOutput;
      public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION {
      public IntPtr hProcess;
      public IntPtr hThread;
      public uint dwProcessId;
      public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CreateProcessW(
      string applicationName,
      StringBuilder commandLine,
      IntPtr processAttributes,
      IntPtr threadAttributes,
      bool inheritHandles,
      uint creationFlags,
      IntPtr environment,
      string currentDirectory,
      ref STARTUPINFO startupInfo,
      out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private NativeProcess(PROCESS_INFORMATION information) {
      processHandle = information.hProcess;
      threadHandle = information.hThread;
      ProcessId = information.dwProcessId;
    }

    public IntPtr ProcessHandle { get { return processHandle; } }
    public uint ProcessId { get; private set; }

    private static IntPtr CreateEnvironmentBlock() {
      var entries = new List<string>();
      foreach (DictionaryEntry entry in Environment.GetEnvironmentVariables()) {
        entries.Add(Convert.ToString(entry.Key) + "=" + Convert.ToString(entry.Value));
      }
      entries.Sort(StringComparer.OrdinalIgnoreCase);
      return Marshal.StringToHGlobalUni(String.Join("\0", entries.ToArray()) + "\0\0");
    }

    public static NativeProcess Start(string applicationName, string commandLine, string currentDirectory) {
      if (String.IsNullOrEmpty(applicationName) || String.IsNullOrEmpty(commandLine) || String.IsNullOrEmpty(currentDirectory)) {
        throw new ArgumentException("CreateProcessW requires application name, command line, and current directory");
      }
      var startupInfo = new STARTUPINFO();
      startupInfo.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
      var mutableCommandLine = new StringBuilder(commandLine, Math.Max(commandLine.Length + 1, 32767));
      var environment = CreateEnvironmentBlock();
      try {
        PROCESS_INFORMATION processInformation;
        if (!CreateProcessW(applicationName, mutableCommandLine, IntPtr.Zero, IntPtr.Zero, false, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, environment, currentDirectory, ref startupInfo, out processInformation)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessW failed");
        }
        return new NativeProcess(processInformation);
      } finally {
        Marshal.FreeHGlobal(environment);
      }
    }

    public void Resume() {
      if (threadHandle == IntPtr.Zero) { throw new ObjectDisposedException("NativeProcess"); }
      if (ResumeThread(threadHandle) == UInt32.MaxValue) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "ResumeThread failed");
      }
    }

    public void Terminate() {
      if (processHandle == IntPtr.Zero) { return; }
      if (TerminateProcess(processHandle, 1)) { return; }
      var error = Marshal.GetLastWin32Error();
      // A Job Object may have already initiated termination, while this handle has not signaled yet.
      if (WaitForSingleObject(processHandle, TERMINATION_CONFIRMATION_TIMEOUT_MS) == WAIT_OBJECT_0) { return; }
      throw new Win32Exception(error, "TerminateProcess failed");
    }

    public void Dispose() {
      Exception failure = null;
      if (threadHandle != IntPtr.Zero) {
        var handle = threadHandle;
        threadHandle = IntPtr.Zero;
        if (!CloseHandle(handle)) { failure = new Win32Exception(Marshal.GetLastWin32Error(), "CloseHandle for process thread failed"); }
      }
      if (processHandle != IntPtr.Zero) {
        var handle = processHandle;
        processHandle = IntPtr.Zero;
        if (!CloseHandle(handle) && failure == null) { failure = new Win32Exception(Marshal.GetLastWin32Error(), "CloseHandle for process failed"); }
      }
      if (failure != null) { throw failure; }
      GC.SuppressFinalize(this);
    }
  }

  public sealed class KillOnCloseJob : IDisposable {
    private const uint JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private IntPtr handle;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS {
      public ulong ReadOperationCount;
      public ulong WriteOperationCount;
      public ulong OtherOperationCount;
      public ulong ReadTransferCount;
      public ulong WriteTransferCount;
      public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
      public long PerProcessUserTimeLimit;
      public long PerJobUserTimeLimit;
      public uint LimitFlags;
      public UIntPtr MinimumWorkingSetSize;
      public UIntPtr MaximumWorkingSetSize;
      public uint ActiveProcessLimit;
      public UIntPtr Affinity;
      public uint PriorityClass;
      public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
      public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
      public IO_COUNTERS IoInfo;
      public UIntPtr ProcessMemoryLimit;
      public UIntPtr JobMemoryLimit;
      public UIntPtr PeakProcessMemoryUsed;
      public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, uint informationClass, IntPtr information, uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    private void SetLimitFlags(uint limitFlags) {
      var information = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      information.BasicLimitInformation.LimitFlags = limitFlags;
      var size = Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
      var buffer = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(information, buffer, false);
        if (!SetInformationJobObject(handle, JobObjectExtendedLimitInformation, buffer, (uint)size)) {
          throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
        }
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }

    public KillOnCloseJob() {
      handle = CreateJobObject(IntPtr.Zero, null);
      if (handle == IntPtr.Zero) { throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObject failed"); }
      try {
        SetLimitFlags(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
      } catch {
        Dispose();
        throw;
      }
    }

    public void Assign(IntPtr processHandle) {
      if (handle == IntPtr.Zero) { throw new ObjectDisposedException("KillOnCloseJob"); }
      if (!AssignProcessToJobObject(handle, processHandle)) {
        throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
      }
    }

    public void Release() {
      if (handle == IntPtr.Zero) { throw new ObjectDisposedException("KillOnCloseJob"); }
      SetLimitFlags(0);
      Dispose();
    }

    public void Terminate() {
      if (handle == IntPtr.Zero) { return; }
      if (TerminateJobObject(handle, 1)) { return; }
      throw new Win32Exception(Marshal.GetLastWin32Error(), "TerminateJobObject failed");
    }

    public void Dispose() {
      if (handle != IntPtr.Zero) {
        var previous = handle;
        if (!CloseHandle(previous)) { throw new Win32Exception(Marshal.GetLastWin32Error(), "CloseHandle for Job Object failed"); }
        handle = IntPtr.Zero;
      }
      GC.SuppressFinalize(this);
    }
  }
}
"@
}
$commandLine = ((@($entrypoint) + @($selection.arguments) + @($selection.configurationArgument, $selection.configurationPath) | ForEach-Object { ConvertTo-WindowsCommandLineArgument ([string]$_) }) -join ' ')
$processState = Join-Path $stateRoot "process-state"
$nativeProcess = $null
$process = $null
$job = $null
$recordCommitted = $false
$launchFailure = $null
$cleanupFailure = $null
try {
  $job = [VemVisionLauncher.KillOnCloseJob]::new()
  $nativeProcess = [VemVisionLauncher.NativeProcess]::Start($entrypoint, $commandLine, $selection.installDirectory)
  $job.Assign($nativeProcess.ProcessHandle)
  $nativeProcess.Resume()
  $process = [Diagnostics.Process]::GetProcessById([int]$nativeProcess.ProcessId)
  $current = Get-Content -LiteralPath (Join-Path $stateRoot "current.json") -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($current.revision -cne $selection.revision) {
    throw "Vision selection changed before process record"
  }
  $record = [ordered]@{ bundleDigest=$selection.bundleDigest; processId=$process.Id; creationTimeUtcTicks=$process.StartTime.ToUniversalTime().Ticks; executablePath=$entrypoint; executableDigest=("sha256:" + (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash.ToLowerInvariant()); selectionRevision=$selection.revision }
  $target = Join-Path $processState "active-process.json"; $temporary = Join-Path $processState ("." + [guid]::NewGuid().ToString("N") + ".tmp"); $backup = Join-Path $processState ("." + [guid]::NewGuid().ToString("N") + ".bak")
  try { [IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false)); if (Test-Path -LiteralPath $target) { [IO.File]::Replace($temporary, $target, $backup) } else { [IO.File]::Move($temporary, $target) } } finally { Remove-Item -LiteralPath $temporary,$backup -Force -ErrorAction SilentlyContinue }
  $job.Release()
  $job = $null
  $recordCommitted = $true
} catch {
  $launchFailure = $_
} finally {
  $cleanupFailures = [Collections.Generic.List[Exception]]::new()
  if (-not $recordCommitted) {
    if ($null -ne $job) {
      try { $job.Terminate() } catch { $cleanupFailures.Add($_.Exception) }
    }
    if ($null -ne $nativeProcess) {
      try { $nativeProcess.Terminate() } catch { $cleanupFailures.Add($_.Exception) }
    }
    Remove-Item -LiteralPath (Join-Path $processState "active-process.json") -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $job) {
    try { $job.Dispose() } catch { $cleanupFailures.Add($_.Exception) }
  }
  if ($null -ne $process) {
    try { $process.Dispose() } catch { $cleanupFailures.Add($_.Exception) }
  }
  if ($null -ne $nativeProcess) {
    try { $nativeProcess.Dispose() } catch { $cleanupFailures.Add($_.Exception) }
  }
  if ($cleanupFailures.Count -eq 1) {
    $cleanupFailure = $cleanupFailures[0]
  } elseif ($cleanupFailures.Count -gt 1) {
    $cleanupFailure = [AggregateException]::new("Vision launcher cleanup failed", [Exception[]]$cleanupFailures.ToArray())
  }
}
if ($null -ne $launchFailure) {
  if ($null -ne $cleanupFailure) {
    throw [AggregateException]::new("Vision launcher failed and cleanup failed", [Exception[]]@($launchFailure.Exception, $cleanupFailure))
  }
  throw $launchFailure
}
if ($null -ne $cleanupFailure) {
  throw $cleanupFailure
}
'@
  [IO.File]::WriteAllText($launcherScriptPath, $launcher, [Text.UTF8Encoding]::new($false)); [IO.File]::WriteAllText($launcherPath, "@echo off`r`npowershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$launcherScriptPath`"`r`n", [Text.UTF8Encoding]::new($false))
  Set-SystemInstallerAcl $launcherScriptPath $true; Set-SystemInstallerAcl $launcherPath $true
}

function Ensure-VisionTask {
  if (Get-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue) { return }
  $action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\cmd.exe" -Argument ('/c ""{0}""' -f $launcherPath) -WorkingDirectory $VisionRoot
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $TaskUser
  $principal = New-ScheduledTaskPrincipal -UserId $TaskUser -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -Action $action -Trigger $trigger -Principal $principal -Force | Out-Null
}

function Test-VisionProtocol([object]$Selection, [object]$Descriptor) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$Descriptor.health.timeoutMs)
  while (-not (Test-Path -LiteralPath $processPath -PathType Leaf) -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 150
  }
  if (-not (Test-Path -LiteralPath $processPath -PathType Leaf)) {
    Throw-InstallError "Vision launcher did not commit its process record"
  }
  $active = (Read-StrictJson $processPath "Vision process record").value
  $entrypoint = Join-TrustedRelativePath ([string]$Selection.installDirectory) ([string]$Selection.entrypoint) "Vision selected entrypoint"
  $process = Get-Process -Id ([int]$active.processId) -ErrorAction Stop
  if (
    $active.bundleDigest -cne $Selection.bundleDigest -or
    $active.selectionRevision -cne $Selection.revision -or
    $active.executablePath -cne $entrypoint -or
    $process.StartTime.ToUniversalTime().Ticks -ne $active.creationTimeUtcTicks -or
    $process.Path -cne $entrypoint -or
    ("sha256:" + (Get-FileHash -LiteralPath $process.Path -Algorithm SHA256).Hash.ToLowerInvariant()) -cne $active.executableDigest
  ) { Throw-InstallError "Vision launched process does not bind the selected executable" }
  do {
    try {
      $response = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}{1}" -f $Descriptor.health.port, $Descriptor.health.path) -TimeoutSec 2
      if (
        $response.status -in @("ok", "degraded") -and
        $response.protocol -ceq $Descriptor.protocol.version -and
        $response.version -ceq $Descriptor.releaseVersion -and
        $response.mockScenario -ceq "off" -and
        $response.cameraReady -is [bool] -and
        $response.modelReady -is [bool] -and
        $response.modelReady -eq $true
      ) { break }
    } catch {}
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  if ([DateTime]::UtcNow -ge $deadline) { Throw-InstallError "Vision health did not bind to launched approved process" }
  $socket = [Net.WebSockets.ClientWebSocket]::new(); $cancel = [Threading.CancellationTokenSource]::new([TimeSpan]::FromMilliseconds([int]$Descriptor.health.timeoutMs))
  try {
    $socket.ConnectAsync([Uri]("ws://127.0.0.1:{0}{1}" -f $Descriptor.health.port, $Descriptor.protocol.webSocketPath), $cancel.Token).GetAwaiter().GetResult()
    $buffer = [byte[]]::new(8192)
    $hello = [ordered]@{ protocol="vem.vision.v1"; type="vision.hello"; messageId=("installer-" + [guid]::NewGuid().ToString("N")); timestamp=[DateTime]::UtcNow.ToString("o"); payload=[ordered]@{ clientRole="machine"; machineCode=$null; protocolVersion=1; capabilities=@("profile_push","presence_status","person_departed","ambient_light") } }
    $helloBytes = [Text.Encoding]::UTF8.GetBytes(($hello | ConvertTo-Json -Depth 8 -Compress)); $socket.SendAsync([ArraySegment[byte]]::new($helloBytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $cancel.Token).GetAwaiter().GetResult()
    $received = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $cancel.Token).GetAwaiter().GetResult()
    $ready = [Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count) | ConvertFrom-Json
    Assert-Keys $ready @("protocol","type","messageId","timestamp","payload") "Vision WebSocket ready envelope"
    Assert-Keys $ready.payload @("serverName","serverVersion","cameraReady","modelReady","capabilities") "Vision WebSocket ready payload"
    if ($Descriptor.protocol.version -cne "vem.vision.v1" -or $ready.protocol -cne "vem.vision.v1" -or $ready.type -cne "vision.ready" -or [string]::IsNullOrWhiteSpace([string]$ready.messageId) -or [string]::IsNullOrWhiteSpace([string]$ready.timestamp) -or [string]::IsNullOrWhiteSpace([string]$ready.payload.serverName) -or $ready.payload.serverVersion -cne $Descriptor.releaseVersion -or $ready.payload.cameraReady -isnot [bool] -or $ready.payload.modelReady -isnot [bool] -or $ready.payload.modelReady -ne $true -or $ready.payload.capabilities -isnot [array]) { Throw-InstallError "Vision WebSocket ready does not satisfy vem.vision.v1" }
  } finally { $socket.Dispose(); $cancel.Dispose() }
}

function Sanitize([string]$Message) {
  $clean = ([regex]::Replace($Message, '(?i)(token|password|secret|key|path)\s*[=:]?\s*[^\r\n]*|(?:[A-Z]:\\|\\\\[^\\]+\\[^\\]+|/(?:[^\s\r\n]+/)*[^\s\r\n]+)[^\r\n]*', '')).Trim()
  return $clean.Substring(0, [Math]::Min(240, $clean.Length))
}

function Rollback-PreviousRelease([object]$Previous, [object]$Candidate) {
  Stop-RecordedVision $Candidate
  if ($null -eq $Previous) {
    Remove-Item -LiteralPath $selectionPath -Force -ErrorAction SilentlyContinue
    return
  }
  $metadata = (Read-StrictJson $Previous.metadataPath "previous Vision release record").value
  Assert-InstalledRelease $metadata $Previous
  $priorDocuments = @{}
  foreach ($name in @("descriptor","attestation","sbom","provenance","conformance","approval","manifest")) {
    $priorDocuments[$name] = [pscustomobject]@{ value=$metadata.documents.$name.value; digest=$metadata.documents.$name.digest; path=$null }
  }
  Assert-ReleaseContracts $metadata.descriptor $metadata.attestation $metadata.approval $priorDocuments.manifest.value $priorDocuments
  Write-AtomicJson $selectionPath $Previous
  Set-SystemInstallerAcl $selectionPath $true
  Start-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\"
  Test-VisionProtocol $Previous $metadata.descriptor
}

function Write-InstallEvidence([object]$Value) {
  Assert-Keys $Value @("schemaVersion","kind","bundleDigest","descriptorDigest","approvalDigest","previousDigest","installedDigest","healthOk","webSocketOk","rollbackAttempted","rollbackOk","failure","redacted") "Vision install evidence"
  foreach ($key in @("bundleDigest","descriptorDigest","approvalDigest","previousDigest","installedDigest")) { if ($null -ne $Value.$key) { Assert-Digest ([string]$Value.$key) "Vision evidence $key" } }
  if ($Value.failure -isnot [string] -or $Value.failure.Length -gt 240 -or $Value.failure -match '(?i)token|password|secret|[A-Z]:\\|\\\\[^\\]+\\|/(?:[^\s\r\n]+/)+') { Throw-InstallError "sanitized Vision evidence is invalid" }
  if ($Value.healthOk -isnot [bool] -or $Value.webSocketOk -isnot [bool] -or $Value.rollbackAttempted -isnot [bool] -or $Value.rollbackOk -isnot [bool] -or $Value.redacted -ne $true) { Throw-InstallError "Vision evidence fields are invalid" }
  Write-AtomicJson $EvidencePath $Value
}

$evidence = [pscustomobject][ordered]@{ schemaVersion="vem-vision-install-evidence/v3"; kind="vision-release-install-evidence"; bundleDigest=$null; descriptorDigest=$null; approvalDigest=$null; previousDigest=$null; installedDigest=$null; healthOk=$false; webSocketOk=$false; rollbackAttempted=$false; rollbackOk=$false; failure=""; redacted=$true }
$mutex = [Threading.Mutex]::new($false, "Global\VEMVisionReleaseInstaller")
$previous = $null; $next = $null; $activationStarted = $false; $lockHeld = $false
try {
  if (-not $mutex.WaitOne([TimeSpan]::FromMinutes(5))) { Throw-InstallError "another Vision installation is active" }
  $lockHeld = $true
  foreach ($required in @($BundlePath,$DescriptorPath,$AttestationPath,$SbomPath,$ProvenancePath,$ConformanceEvidencePath,$ApprovalPath,$FactoryManifestPath,$ConfigurationPath)) { if ([string]::IsNullOrWhiteSpace($required)) { Throw-InstallError "all release inputs are required" } }
  foreach ($input in @($DescriptorPath,$AttestationPath,$SbomPath,$ProvenancePath,$ConformanceEvidencePath,$ApprovalPath,$FactoryManifestPath,$ConfigurationPath)) { [void](Get-ExactFileBytes $input "release input") }
  $documents = @{}
  foreach ($pair in @(@("descriptor",$DescriptorPath),@("attestation",$AttestationPath),@("sbom",$SbomPath),@("provenance",$ProvenancePath),@("conformance",$ConformanceEvidencePath),@("approval",$ApprovalPath),@("manifest",$FactoryManifestPath))) { $read=Read-StrictJson $pair[1] ("Vision " + $pair[0]); $documents[$pair[0]]=[pscustomobject]@{ path=$pair[1]; digest=$read.digest; value=$read.value } }
  New-Item -ItemType Directory -Path $configurationRoot -Force | Out-Null
  [void](Get-CanonicalContainedPath $configurationRoot $ConfigurationPath "Vision configuration")
  $policy=Get-FactoryTrustPolicy; Invoke-ReleaseEvidenceVerifier $policy $documents; Assert-ReleaseContracts $documents.descriptor.value $documents.attestation.value $documents.approval.value $documents.manifest.value $documents
  $descriptor=$documents.descriptor.value; $evidence.bundleDigest=$descriptor.bundle.digest; $evidence.descriptorDigest=$descriptor.identity; $evidence.approvalDigest=$documents.approval.digest
  $key=(($descriptor.releaseVersion -replace '\+','_') + "-" + $descriptor.bundle.digest.Substring(7,16)); $install=Join-Path $releaseRoot $key; $metadata=Join-Path $metadataRoot "$key.json"
  New-Item -ItemType Directory -Path $releaseRoot,$metadataRoot,$configurationRoot -Force | Out-Null
  Assert-NonReparsePath $VisionRoot "Vision root"
  Assert-NonReparsePath $StateRoot "Vision state root"
  Set-SystemInstallerAcl $VisionRoot $false
  Set-SystemInstallerAcl $metadataRoot $false
  Set-VisionStateAcl
  $releaseAlreadyPresent = Test-Path -LiteralPath $install
  if ($releaseAlreadyPresent -and -not (Test-Path -LiteralPath $metadata -PathType Leaf)) {
    Quarantine-UntrustedReleaseDirectory $install $key
    Throw-InstallError "existing Vision release directory has no trusted metadata and was quarantined"
  }
  if (-not $releaseAlreadyPresent) {
    $staging=Join-Path $StateRoot ("staging\\" + [guid]::NewGuid().ToString("N"))
    try {
      if ($descriptor.bundle.extractor.handler -cne "zip-safe-v1") { Throw-InstallError "declared extractor handler is not installed" }
      # Merge preservation: VEM materializes the supplier's exact candidate bytes;
      # it never rebuilds or selects an implicit Vision bundle.
      Invoke-VisionReleaseMaterialization -CandidatePath $BundlePath -ExpectedDigest $descriptor.bundle.digest -Descriptor $descriptor -Destination $staging -ExtractionPolicy @{ MaxArchiveEntries=$maxArchiveEntries; MaxExpandedBytes=$maxExpandedBytes; MaxExpansionRatio=$maxExpansionRatio } | Out-Null
      $entry=Join-TrustedRelativePath $staging $descriptor.entrypoint.command "staged Vision entrypoint"
      if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { Throw-InstallError "declared Vision entrypoint was not extracted" }
      Move-Item -LiteralPath $staging -Destination $install
      Set-SystemInstallerAcl $install $true
    } finally {
      Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  $entrypoint=Join-TrustedRelativePath $install $descriptor.entrypoint.command "Vision entrypoint"
  $storedDocuments=[ordered]@{}
  foreach($name in @("descriptor","attestation","sbom","provenance","conformance","approval","manifest")){
    $storedDocuments[$name]=[ordered]@{ digest=$documents[$name].digest; value=$documents[$name].value }
  }
  $record=[ordered]@{ schemaVersion="vem-vision-release-record/v2"; bundleDigest=$descriptor.bundle.digest; descriptorDigest=$descriptor.identity; approvalDigest=$documents.approval.digest; installDirectory=$install; entrypoint=$descriptor.entrypoint.command; entrypointDigest=("sha256:" + (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash.ToLowerInvariant()); files=@(Get-ExtractedFileManifest $install); descriptor=$descriptor; attestation=$documents.attestation.value; approval=$documents.approval.value; documents=$storedDocuments }
  if (-not (Test-Path -LiteralPath $metadata -PathType Leaf)) {
    Write-AtomicJson $metadata $record
    Set-SystemInstallerAcl $metadata $false
  }
  Assert-SystemOwnedPath $metadata "Vision release metadata"
  $existing=(Read-StrictJson $metadata "Vision release record").value
  $candidate=[ordered]@{ schemaVersion="vem-vision-selection/v1"; revision=[guid]::NewGuid().ToString("N"); bundleDigest=$record.bundleDigest; descriptorDigest=$record.descriptorDigest; approvalDigest=$record.approvalDigest; installDirectory=$install; entrypoint=$descriptor.entrypoint.command; arguments=@($descriptor.entrypoint.arguments); configurationArgument=$descriptor.configuration.argument; configurationPath=$ConfigurationPath; metadataPath=$metadata }
  Assert-InstalledRelease $existing $candidate
  $existingDocuments = @{}
  foreach($name in @("descriptor","attestation","sbom","provenance","conformance","approval","manifest")) { $existingDocuments[$name]=[pscustomobject]@{ value=$existing.documents.$name.value; digest=$existing.documents.$name.digest; path=$null } }
  Assert-ReleaseContracts $existing.descriptor $existing.attestation $existing.approval $existingDocuments.manifest.value $existingDocuments
  Write-VisionLauncher; Ensure-VisionTask; $previous=if(Test-Path $selectionPath){(Read-StrictJson $selectionPath "Vision selection").value}else{$null}; if($previous){$evidence.previousDigest=$previous.bundleDigest}; $next=$candidate; $activationStarted=$true; if($previous){Stop-RecordedVision $previous}; Write-AtomicJson $selectionPath $next; Set-SystemInstallerAcl $selectionPath $true; Start-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\"; Test-VisionProtocol $next $descriptor; $evidence.healthOk=$true; $evidence.webSocketOk=$true; $evidence.installedDigest=$record.bundleDigest
} catch {
  $evidence.failure=Sanitize $_.Exception.Message
  if($activationStarted){$evidence.rollbackAttempted=$true; try { Rollback-PreviousRelease $previous $next; $evidence.rollbackOk=$true } catch {$evidence.rollbackOk=$false; $rollbackFailure=Sanitize $_.Exception.Message; if(-not [string]::IsNullOrWhiteSpace($rollbackFailure)){$evidence.failure=Sanitize ("$($evidence.failure); rollback: $rollbackFailure")} } }
  throw
} finally {
  try { Write-InstallEvidence $evidence } finally { if($mutex){if($lockHeld){ $mutex.ReleaseMutex() };$mutex.Dispose()} }
}
