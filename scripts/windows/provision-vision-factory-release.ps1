[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$FactoryMediaRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$factoryRoot = "C:\ProgramData\VEM\factory"
$trustRoot = "C:\ProgramData\VEM\factory-trust"
$bringupRoot = "C:\VEM\bringup"

function Assert-SafeWindowsPath([string]$Path, [string]$Label) {
  if (
    [string]::IsNullOrWhiteSpace($Path) -or
    $Path -match '[\x00-\x1f]' -or
    $Path -match '^(\\\\|//)' -or
    $Path -notmatch '^[A-Za-z]:\\'
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
    if ($parent -eq $cursor) { break }
    $cursor = $parent
  }
}

function Get-Sha256Digest([string]$Path) {
  return "sha256:" + (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Set-SystemOnlyAcl([string]$Path) {
  if ($env:OS -ne "Windows_NT") { return }
  $acl = Get-Acl -LiteralPath $Path
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
  foreach ($identity in @("SYSTEM", "BUILTIN\Administrators")) {
    $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new(
      $identity, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow"
    ))
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}

Assert-SafeWindowsPath $FactoryMediaRoot "Factory media root"
Assert-NonReparsePath $FactoryMediaRoot "Factory media root"
$manifestPath = Join-Path $FactoryMediaRoot "VISION-FACTORY-PROVISIONING.JSON"
Assert-NonReparsePath $manifestPath "Factory Vision provisioning manifest"
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -Depth 32
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
  "VISION-INSTALLER/provision-vision-factory-release.ps1" = (Join-Path $bringupRoot "provision-vision-factory-release.ps1")
}
foreach ($property in @($manifest.files.PSObject.Properties)) {
  $relative = [string]$property.Name
  $expected = [string]$property.Value
  if ($relative -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$' -or $expected -notmatch '^sha256:[a-f0-9]{64}$') {
    throw "Factory Vision provisioning manifest contains an unsafe file"
  }
  $source = Join-Path $FactoryMediaRoot ($relative.Replace('/', '\\'))
  Assert-NonReparsePath $source "Factory Vision source"
  if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or (Get-Sha256Digest $source) -cne $expected) {
    throw "Factory Vision source hash does not match provisioning manifest"
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
}
foreach ($path in @($factoryRoot, $trustRoot, $bringupRoot, (Join-Path $factoryRoot "vision-release"), (Join-Path $bringupRoot "install-vision-release.ps1"))) {
  Assert-NonReparsePath $path "Factory Vision installed path"
  Set-SystemOnlyAcl $path
}
