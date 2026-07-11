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
  [string]$TaskUser = "VEMKiosk",
  [switch]$Library
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

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
$FactoryVisionDeliveryRoot = "C:\ProgramData\VEM\factory\vision-release"
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

function Get-Digest([byte[]]$Bytes) {
  return "sha256:" + ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($Bytes))).ToLowerInvariant()
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
    if ($parent -eq $cursor) { break }
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
  try { $value = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json -Depth 64 } catch { Throw-InstallError "$Label is not valid UTF-8 JSON" }
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
  # Arguments are one value each through ProcessStartInfo, never a command string.
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = (Get-Item -LiteralPath $FactoryEvidenceVerifierPath -Force).FullName
  $start.UseShellExecute = $false; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  $start.ArgumentList.Add("verify")
  foreach ($name in @("descriptor", "attestation", "sbom", "provenance", "conformance", "approval", "manifest")) {
    $start.ArgumentList.Add("--$name-digest"); $start.ArgumentList.Add([string]$Documents[$name].digest)
    $start.ArgumentList.Add("--$name-path"); $start.ArgumentList.Add([string]$Documents[$name].path)
  }
  $start.ArgumentList.Add("--policy"); $start.ArgumentList.Add((Get-Item -LiteralPath $FactoryTrustPolicyPath -Force).FullName)
  $process = [Diagnostics.Process]::Start($start)
  $stdout = $process.StandardOutput.ReadToEnd(); $stderr = $process.StandardError.ReadToEnd(); $process.WaitForExit()
  if ($process.ExitCode -ne 0 -or $stdout.Length -gt 16384) { Throw-InstallError "cryptographic release evidence verification failed" }
  try { $result = $stdout | ConvertFrom-Json -Depth 16 } catch { Throw-InstallError "cryptographic release evidence verifier returned invalid output" }
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
  if ($asset[0].digest -cne $Descriptor.bundle.digest -or $asset[0].version -cne $Descriptor.releaseVersion -or $selection.descriptorDigest -cne $Descriptor.identity -or $selection.attestationDigest -cne $Documents.attestation.digest -or $selection.approvalDigest -cne $Approval.identity -or $selection.conformanceEvidenceDigest -cne $Documents.conformance.digest -or $Attestation.bundleDigest -cne $Descriptor.bundle.digest -or $Attestation.descriptorDigest -cne $Descriptor.identity -or $Attestation.sbomDigest -cne $Descriptor.sbom.digest -or $Attestation.provenanceDigest -cne $Descriptor.provenance.digest -or $Approval.bundleDigest -cne $Descriptor.bundle.digest -or $Approval.descriptorDigest -cne $Descriptor.identity -or $Approval.attestationDigest -cne $Documents.attestation.digest -or $Approval.conformanceEvidenceDigest -cne $Documents.conformance.digest -or $Approval.releaseVersion -cne $Descriptor.releaseVersion) { Throw-InstallError "release evidence does not bind the selected approved bundle" }
}

function Get-VerifiedBundleStream {
  param([object]$Descriptor)
  $item = Get-Item -LiteralPath $BundlePath -Force -ErrorAction Stop
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { Throw-InstallError "Vision bundle must be a regular non-reparse file" }
  if ($item.Length -ne [Int64]$Descriptor.bundle.bytes) { Throw-InstallError "Vision bundle byte count does not match descriptor" }
  $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    $buffer = [byte[]]::new(1048576); $readTotal = [Int64]0
    while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) { $hash.TransformBlock($buffer, 0, $count, $null, 0) | Out-Null; $readTotal += $count }
    $hash.TransformFinalBlock([byte[]]::new(0), 0, 0) | Out-Null
    if ($readTotal -ne $item.Length -or ("sha256:" + ([Convert]::ToHexString($hash.Hash)).ToLowerInvariant()) -cne [string]$Descriptor.bundle.digest) { Throw-InstallError "Vision bundle exact bytes do not match approved descriptor" }
    $stream.Position = 0
    return $stream
  } catch { $stream.Dispose(); throw } finally { $hash.Dispose() }
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
  $actual = Get-ExtractedFileManifest ([string]$Record.installDirectory)
  $expected = @($Record.files)
  if ($actual.Count -ne $expected.Count -or (($actual | ConvertTo-Json -Depth 8 -Compress) -cne ($expected | ConvertTo-Json -Depth 8 -Compress))) { Throw-InstallError "installed Vision release files do not match immutable metadata" }
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

function Expand-ZipSafely {
  param([IO.Stream]$BundleStream, [string]$Destination, [object]$Descriptor)
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipArchive]::new($BundleStream, [IO.Compression.ZipArchiveMode]::Read, $true)
  try {
    if ($archive.Entries.Count -lt 1 -or $archive.Entries.Count -gt $maxArchiveEntries) { Throw-InstallError "Vision archive entry count is unsafe" }
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase); $expanded = [Int64]0; $compressed = [Int64]0
    foreach ($entry in $archive.Entries) {
      $relative = Get-SafeArchivePath $entry.FullName
      if ($entry.FullName.EndsWith("/")) { continue }
      if (-not $seen.Add($relative)) { Throw-InstallError "Vision archive has case-colliding paths" }
      if ($entry.Length -lt 0 -or $entry.CompressedLength -lt 0) { Throw-InstallError "Vision archive lengths are invalid" }
      $expanded += $entry.Length; $compressed += $entry.CompressedLength
      if ($expanded -gt $maxExpandedBytes -or ($compressed -gt 0 -and $expanded -gt ($compressed * $maxExpansionRatio))) { Throw-InstallError "Vision archive expansion budget is unsafe" }
    }
    $drive = [IO.DriveInfo]::new((Split-Path -Qualifier $Destination))
    if ($drive.AvailableFreeSpace -lt ($expanded + 256MB)) { Throw-InstallError "insufficient disk space for Vision archive" }
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName.EndsWith("/")) { continue }
      $target = Join-Path $Destination (Get-SafeArchivePath $entry.FullName)
      $parent = Split-Path -Parent $target; New-Item -ItemType Directory -Path $parent -Force | Out-Null
      $input = $entry.Open(); $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
      if ((Get-Item -LiteralPath $target -Force).Length -ne $entry.Length) { Throw-InstallError "Vision archive entry was extracted incompletely" }
    }
  } finally { $archive.Dispose() }
}

function Write-AtomicJson([string]$Path, [object]$Value) {
  $parent = Split-Path -Parent $Path; New-Item -ItemType Directory -Path $parent -Force | Out-Null
  $temporary = Join-Path $parent ("." + [guid]::NewGuid().ToString("N") + ".tmp")
  try { [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 64 -Compress), [Text.UTF8Encoding]::new($false)); if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, $null) } else { [IO.File]::Move($temporary, $Path) } } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

function Set-SystemInstallerAcl([string]$Path, [bool]$KioskReadable) {
  if ($env:OS -ne "Windows_NT") { return }
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
  foreach ($identity in @("SYSTEM", "BUILTIN\\Administrators")) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")) }
  if ($KioskReadable) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new("VEMKiosk", "ReadAndExecute", "ContainerInherit,ObjectInherit", "None", "Allow")) }
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

function Stop-RecordedVision([object]$Selection) {
  Stop-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
  if (-not (Test-Path -LiteralPath $processPath -PathType Leaf)) { return }
  $record = (Read-StrictJson $processPath "Vision process record").value
  Assert-Keys $record @("bundleDigest", "processId", "creationTimeUtc", "executablePath", "executableDigest", "selectionRevision") "Vision process record"
  $approved = Resolve-ApprovedVisionExecution $Selection
  [int]$recordedProcessId = 0
  if ($record.bundleDigest -cne $approved.bundleDigest -or $record.selectionRevision -cne $approved.revision -or -not [int]::TryParse([string]$record.processId, [ref]$recordedProcessId) -or $recordedProcessId -lt 1) { return }
  $process = Get-Process -Id $recordedProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process -or $process.StartTime.ToUniversalTime().ToString("o") -cne [string]$record.creationTimeUtc -or -not (Test-Path -LiteralPath $process.Path -PathType Leaf)) { return }
  try {
    $actualPath = Get-CanonicalContainedPath $releaseRoot ([string]$process.Path) "recorded Vision executable"
  } catch {
    return
  }
  if ($actualPath -cne $approved.executablePath) { return }
  if (("sha256:" + (Get-FileHash -LiteralPath $actualPath -Algorithm SHA256).Hash.ToLowerInvariant()) -cne $approved.executableDigest) { return }
  Stop-Process -Id $process.Id -Force -ErrorAction Stop
  Remove-Item -LiteralPath $processPath -Force -ErrorAction SilentlyContinue
}

function Write-VisionLauncher {
  New-Item -ItemType Directory -Path (Split-Path -Parent $launcherPath) -Force | Out-Null
  $launcher = @'
$ErrorActionPreference = "Stop"
$stateRoot = "C:\ProgramData\VEM\vision"
$selection = Get-Content -LiteralPath (Join-Path $stateRoot "current.json") -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 32
$entrypoint = Join-Path $selection.installDirectory $selection.entrypoint
if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) { throw "selected Vision entrypoint missing" }
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = $entrypoint
$start.WorkingDirectory = $selection.installDirectory
$start.UseShellExecute = $false
foreach ($argument in @($selection.arguments) + @($selection.configurationArgument, $selection.configurationPath)) { $start.ArgumentList.Add([string]$argument) }
$process = [Diagnostics.Process]::Start($start)
$current = Get-Content -LiteralPath (Join-Path $stateRoot "current.json") -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 32
if ($current.revision -cne $selection.revision) { Stop-Process -Id $process.Id -Force; throw "Vision selection changed before process record" }
$record = [ordered]@{ bundleDigest=$selection.bundleDigest; processId=$process.Id; creationTimeUtc=$process.StartTime.ToUniversalTime().ToString("o"); executablePath=$entrypoint; executableDigest=("sha256:" + (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash.ToLowerInvariant()); selectionRevision=$selection.revision }
$processState = Join-Path $stateRoot "process-state"; $target = Join-Path $processState "active-process.json"; $temporary = Join-Path $processState ("." + [guid]::NewGuid().ToString("N") + ".tmp")
[IO.File]::WriteAllText($temporary, ($record | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false)); if (Test-Path -LiteralPath $target) { [IO.File]::Replace($temporary, $target, $null) } else { [IO.File]::Move($temporary, $target) }
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
  do {
    try {
      $response = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}{1}" -f $Descriptor.health.port, $Descriptor.health.path) -TimeoutSec 2
      $active = (Read-StrictJson $processPath "Vision process record").value
      if ($response.pid -eq $active.processId -and $response.bundleDigest -ceq $Selection.bundleDigest -and $response.executableDigest -ceq $active.executableDigest -and $response.protocolVersion -ceq $Descriptor.protocol.version -and $response.schemaVersion -ceq "vem-machine-vision-health/v1") { break }
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
    $ready = [Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count) | ConvertFrom-Json -Depth 16
    Assert-Keys $ready @("protocol","type","messageId","timestamp","payload") "Vision WebSocket ready envelope"
    Assert-Keys $ready.payload @("serverName","serverVersion","cameraReady","modelReady","capabilities") "Vision WebSocket ready payload"
    if ($Descriptor.protocol.version -cne "vem.vision.v1" -or $ready.protocol -cne "vem.vision.v1" -or $ready.type -cne "vision.ready" -or [string]::IsNullOrWhiteSpace([string]$ready.messageId) -or [string]::IsNullOrWhiteSpace([string]$ready.timestamp) -or [string]::IsNullOrWhiteSpace([string]$ready.payload.serverName) -or [string]::IsNullOrWhiteSpace([string]$ready.payload.serverVersion) -or $ready.payload.cameraReady -isnot [bool] -or $ready.payload.modelReady -isnot [bool] -or $ready.payload.capabilities -isnot [array]) { Throw-InstallError "Vision WebSocket ready does not satisfy vem.vision.v1" }
  } finally { $socket.Dispose(); $cancel.Dispose() }
}

function Sanitize([string]$Message) {
  $clean = ([regex]::Replace($Message, '(?i)(token|password|secret|key|path)\s*[=:]?\s*[^\r\n]*|(?:[A-Z]:\\|\\\\[^\\]+\\[^\\]+|/(?:[^\s\r\n]+/)*[^\s\r\n]+)[^\r\n]*', '')).Trim()
  return $clean.Substring(0, [Math]::Min(240, $clean.Length))
}

if ($Library) { return }

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

$evidence = [ordered]@{ schemaVersion="vem-vision-install-evidence/v3"; kind="vision-release-install-evidence"; bundleDigest=$null; descriptorDigest=$null; approvalDigest=$null; previousDigest=$null; installedDigest=$null; healthOk=$false; webSocketOk=$false; rollbackAttempted=$false; rollbackOk=$false; failure=""; redacted=$true }
$mutex = [Threading.Mutex]::new($false, "Global\VEMVisionReleaseInstaller")
$previous = $null; $next = $null; $activationStarted = $false; $lockHeld = $false
try {
  if (-not $mutex.WaitOne([TimeSpan]::FromMinutes(5))) { Throw-InstallError "another Vision installation is active" }
  $lockHeld = $true
  if (-not (Test-Path -LiteralPath $selectionPath -PathType Leaf)) {
    Assert-NonReparsePath $FactoryVisionDeliveryRoot "Factory Vision delivery unit"
    $BundlePath = "$FactoryVisionDeliveryRoot\bundle.bin"
    $DescriptorPath = "$FactoryVisionDeliveryRoot\descriptor.json"
    $AttestationPath = "$FactoryVisionDeliveryRoot\attestation.json"
    $SbomPath = "$FactoryVisionDeliveryRoot\sbom.json"
    $ProvenancePath = "$FactoryVisionDeliveryRoot\provenance.json"
    $ConformanceEvidencePath = "$FactoryVisionDeliveryRoot\conformance.json"
    $ApprovalPath = "$FactoryVisionDeliveryRoot\approval.json"
    $FactoryManifestPath = "$FactoryVisionDeliveryRoot\factory-manifest.json"
  }
  foreach ($required in @($BundlePath,$DescriptorPath,$AttestationPath,$SbomPath,$ProvenancePath,$ConformanceEvidencePath,$ApprovalPath,$FactoryManifestPath,$ConfigurationPath)) { if ([string]::IsNullOrWhiteSpace($required)) { Throw-InstallError "all release inputs are required" } }
  foreach ($input in @($DescriptorPath,$AttestationPath,$SbomPath,$ProvenancePath,$ConformanceEvidencePath,$ApprovalPath,$FactoryManifestPath,$ConfigurationPath)) { [void](Get-ExactFileBytes $input "release input") }
  $documents = @{}
  foreach ($pair in @(@("descriptor",$DescriptorPath),@("attestation",$AttestationPath),@("sbom",$SbomPath),@("provenance",$ProvenancePath),@("conformance",$ConformanceEvidencePath),@("approval",$ApprovalPath),@("manifest",$FactoryManifestPath))) { $read=Read-StrictJson $pair[1] ("Vision " + $pair[0]); $documents[$pair[0]]=[pscustomobject]@{ path=$pair[1]; digest=$read.digest; value=$read.value } }
  New-Item -ItemType Directory -Path $configurationRoot -Force | Out-Null
  [void](Get-CanonicalContainedPath $configurationRoot $ConfigurationPath "Vision configuration")
  $policy=Get-FactoryTrustPolicy; Invoke-ReleaseEvidenceVerifier $policy $documents; Assert-ReleaseContracts $documents.descriptor.value $documents.attestation.value $documents.approval.value $documents.manifest.value $documents
  $descriptor=$documents.descriptor.value; $bundle=Get-VerifiedBundleStream $descriptor; $evidence.bundleDigest=$descriptor.bundle.digest; $evidence.descriptorDigest=$descriptor.identity; $evidence.approvalDigest=$documents.approval.digest
  $key=(($descriptor.releaseVersion -replace '\+','_') + "-" + $descriptor.bundle.digest.Substring(7,16)); $install=Join-Path $releaseRoot $key; $metadata=Join-Path $metadataRoot "$key.json"
  New-Item -ItemType Directory -Path $releaseRoot,$metadataRoot,$configurationRoot -Force | Out-Null
  Assert-NonReparsePath $VisionRoot "Vision root"
  Assert-NonReparsePath $StateRoot "Vision state root"
  Set-SystemInstallerAcl $VisionRoot $false
  Set-SystemInstallerAcl $metadataRoot $false
  Set-VisionStateAcl
  $releaseAlreadyPresent = Test-Path -LiteralPath $install
  if ($releaseAlreadyPresent -and -not (Test-Path -LiteralPath $metadata -PathType Leaf)) {
    $bundle.Dispose()
    Quarantine-UntrustedReleaseDirectory $install $key
    Throw-InstallError "existing Vision release directory has no trusted metadata and was quarantined"
  }
  if (-not $releaseAlreadyPresent) {
    $staging=Join-Path $StateRoot ("staging\\" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    try {
      if ($descriptor.bundle.extractor.handler -cne "zip-safe-v1") { Throw-InstallError "declared extractor handler is not installed" }
      Expand-ZipSafely $bundle $staging $descriptor
      $entry=Join-TrustedRelativePath $staging $descriptor.entrypoint.command "staged Vision entrypoint"
      if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { Throw-InstallError "declared Vision entrypoint was not extracted" }
      Move-Item -LiteralPath $staging -Destination $install
      Set-SystemInstallerAcl $install $true
    } finally {
      $bundle.Dispose()
      Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
    }
  } else {
    $bundle.Dispose()
  }
  $entrypoint=Join-TrustedRelativePath $install $descriptor.entrypoint.command "Vision entrypoint"
  $storedDocuments=[ordered]@{}
  foreach($name in @("descriptor","attestation","sbom","provenance","conformance","approval","manifest")){
    $storedDocuments[$name]=[ordered]@{ digest=$documents[$name].digest; value=$documents[$name].value }
  }
  $record=[ordered]@{ schemaVersion="vem-vision-release-record/v2"; bundleDigest=$descriptor.bundle.digest; descriptorDigest=$descriptor.identity; approvalDigest=$documents.approval.digest; installDirectory=$install; entrypoint=$descriptor.entrypoint.command; entrypointDigest=("sha256:" + (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash.ToLowerInvariant()); files=(Get-ExtractedFileManifest $install); descriptor=$descriptor; attestation=$documents.attestation.value; approval=$documents.approval.value; documents=$storedDocuments }
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
  Write-VisionLauncher; Ensure-VisionTask; $previous=if(Test-Path $selectionPath){(Read-StrictJson $selectionPath "Vision selection").value}else{$null}; if($previous){$evidence.previousDigest=$previous.bundleDigest}; $next=$candidate; $activationStarted=$true; if($previous){Stop-RecordedVision $previous}; Write-AtomicJson $selectionPath $next; Start-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\"; Test-VisionProtocol $next $descriptor; $evidence.healthOk=$true; $evidence.webSocketOk=$true; $evidence.installedDigest=$record.bundleDigest
} catch {
  $evidence.failure=Sanitize $_.Exception.Message
  if($activationStarted){$evidence.rollbackAttempted=$true; try { Rollback-PreviousRelease $previous $next; $evidence.rollbackOk=$true } catch {$evidence.rollbackOk=$false} }
  throw
} finally {
  try { Write-InstallEvidence $evidence } finally { if($mutex){if($lockHeld){ $mutex.ReleaseMutex() };$mutex.Dispose()} }
}
