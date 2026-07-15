[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$FactoryMediaRoot,
  # Test-only producer mode: use a disposable root while retaining the exact
  # manifest verification and copy loop used by Factory provisioning.
  [switch]$DeliveryAssemblyEvidenceOnly,
  [Parameter(Mandatory = $false)][string]$DeliveryAssemblyOutputRoot,
  [Parameter(Mandatory = $false)][string]$DeliveryAssemblyContractNonce
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
if ($PSVersionTable.PSEdition -eq "Desktop") { $env:PSModulePath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\Modules;$env:PSModulePath" }

$script:AllowDeliveryAssemblyTestPaths = [bool]$DeliveryAssemblyEvidenceOnly
if ($DeliveryAssemblyEvidenceOnly) {
  if ([string]::IsNullOrWhiteSpace($DeliveryAssemblyOutputRoot)) {
    throw "DeliveryAssemblyOutputRoot is required with DeliveryAssemblyEvidenceOnly"
  }
  $deliveryOutputRoot = [IO.Path]::GetFullPath($DeliveryAssemblyOutputRoot)
  if (Test-Path -LiteralPath $deliveryOutputRoot) {
    throw "DeliveryAssemblyOutputRoot must not already exist"
  }
  $factoryRoot = Join-Path $deliveryOutputRoot "factory"
  $trustRoot = Join-Path $deliveryOutputRoot "factory-trust"
  $bringupRoot = Join-Path $deliveryOutputRoot "bringup"
} else {
  $factoryRoot = "C:\ProgramData\VEM\factory"
  $trustRoot = "C:\ProgramData\VEM\factory-trust"
  $bringupRoot = "C:\VEM\bringup"
}

function Assert-SafeWindowsPath([string]$Path, [string]$Label) {
  if (
    [string]::IsNullOrWhiteSpace($Path) -or
    $Path -match '[\x00-\x1f]' -or
    $Path -match '^(\\\\|//)' -or
    (-not $script:AllowDeliveryAssemblyTestPaths -and $Path -notmatch '^[A-Za-z]:\\')
  ) {
    throw "$Label must be an absolute local Windows path"
  }
}

function Assert-NonReparsePath([string]$Path, [string]$Label) {
  Assert-SafeWindowsPath $Path $Label
  $cursor = [IO.Path]::GetFullPath($Path)
  while ($true) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label must not traverse a reparse point"
      }
    }
    $parent = Split-Path -Parent $cursor
    if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $cursor) { break }
    $cursor = $parent
  }
}

function Get-Sha256Digest([string]$Path) {
  $stream = $null
  $hash = $null
  try {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $hash = [Security.Cryptography.SHA256]::Create()
    $digest = $hash.ComputeHash($stream)
    return "sha256:" + ([BitConverter]::ToString($digest).Replace("-", "")).ToLowerInvariant()
  } finally {
    if ($null -ne $hash) { $hash.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

function Set-SystemOnlyAcl([string]$Path) {
  if ($env:OS -ne "Windows_NT") { return }
  $inheritanceFlags = if ((Get-Item -LiteralPath $Path -Force).PSIsContainer) {
    "ContainerInherit,ObjectInherit"
  } else {
    "None"
  }
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
  $system = [Security.Principal.SecurityIdentifier]::new("S-1-5-18")
  $administrators = [Security.Principal.SecurityIdentifier]::new("S-1-5-32-544")
  $acl.SetOwner($system)
  foreach ($identity in @($system, $administrators)) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $identity, "FullControl", $inheritanceFlags, "None", "Allow"
    ))
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

Assert-SafeWindowsPath $FactoryMediaRoot "Factory media root"
Assert-NonReparsePath $FactoryMediaRoot "Factory media root"
$manifestPath = Join-Path $FactoryMediaRoot "VISION-FACTORY-PROVISIONING.JSON"
Assert-NonReparsePath $manifestPath "Factory Vision provisioning manifest"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (
  $manifest.schemaVersion -cne "vem-vision-factory-provisioning/v1" -or
  $manifest.kind -cne "vision-factory-provisioning" -or
  $null -eq $manifest.files
) {
  throw "Factory Vision provisioning manifest is invalid"
}

$destinations = @{
  "VISION-RELEASE/" = (Join-Path $factoryRoot "vision-release")
  "VISION-TRUST/" = $trustRoot
  "VISION-INSTALLER/install-vision-release.ps1" = (Join-Path $bringupRoot "install-vision-release.ps1")
  "VISION-INSTALLER/vision-release-materialization.psm1" = (Join-Path $bringupRoot "vision-release-materialization.psm1")
  "VISION-INSTALLER/vision-diagnostic-redaction.psm1" = (Join-Path $bringupRoot "vision-diagnostic-redaction.psm1")
  "VISION-INSTALLER/provision-vision-factory-release.ps1" = (Join-Path $bringupRoot "provision-vision-factory-release.ps1")
}
$installedFiles = @()
foreach ($property in @($manifest.files.PSObject.Properties)) {
  $relative = [string]$property.Name
  $expected = [string]$property.Value
  if ($relative -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$' -or $expected -notmatch '^sha256:[a-f0-9]{64}$') {
    throw "Factory Vision provisioning manifest contains an unsafe file"
  }
  $source = Join-Path $FactoryMediaRoot ($relative.Replace('/', '\\'))
  Assert-NonReparsePath $source "Factory Vision source"
  $sourceExists = Test-Path -LiteralPath $source -PathType Leaf
  $actual = if ($sourceExists) { Get-Sha256Digest $source } else { "missing" }
  if (-not $sourceExists -or $actual -cne $expected) {
    throw "Factory Vision source hash does not match provisioning manifest: relative=$relative expected=$expected actual=$actual"
  }
  $destination = $null
  foreach ($prefix in $destinations.Keys) {
    if ($relative.StartsWith($prefix, [StringComparison]::Ordinal)) {
      $suffix = $relative.Substring($prefix.Length).Replace('/', '\\')
      $destination = if ($prefix.EndsWith('/')) { Join-Path $destinations[$prefix] $suffix } else { $destinations[$prefix] }
      break
    }
  }
  if ($null -eq $destination) { throw "Factory Vision source has no protected destination" }
  $parent = Split-Path -Parent $destination
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  Assert-NonReparsePath $parent "Factory Vision destination"
  Copy-Item -LiteralPath $source -Destination $destination -Force
  if ((Get-Sha256Digest $destination) -cne $expected) { throw "Factory Vision destination hash mismatch" }
  $installedFiles += [ordered]@{ relative=$relative; path=$destination; digest=$expected }
}
$protectedRoots = @($factoryRoot, $trustRoot, $bringupRoot, (Join-Path $factoryRoot "vision-release"))
foreach ($path in $protectedRoots) {
  Assert-NonReparsePath $path "Factory Vision installed root"
  if (-not (Test-Path -LiteralPath $path -PathType Container)) {
    New-Item -ItemType Directory -Path $path -Force | Out-Null
  }
}
foreach ($path in $protectedRoots + @($installedFiles | ForEach-Object { [string]$_.path }) | Select-Object -Unique) {
  Assert-NonReparsePath $path "Factory Vision installed path"
  Set-SystemOnlyAcl $path
}

$evidenceFiles = [ordered]@{}
foreach ($installed in $installedFiles | Sort-Object relative) {
  $evidenceFiles[[string]$installed.relative] = [ordered]@{
    destination = [string]$installed.path
    digest = [string]$installed.digest
  }
}
[ordered]@{
  schemaVersion = "vem-factory-vision-provisioning-evidence/v1"
  kind = "factory-vision-provisioning-evidence"
  deliveryAssemblyContractNonce = $DeliveryAssemblyContractNonce
  sourceManifestDigest = Get-Sha256Digest $manifestPath
  files = $evidenceFiles
} | ConvertTo-Json -Depth 20
