# VEM scripted factory runtime preparation.
#
# Prepares a clean Windows base into the standardized VEM runtime layout. The
# default mode mutates the local host; -DryRun emits the deterministic plan that
# tests and factory review can inspect without touching Windows state.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $false)][string]$DaemonArtifactPath,
  [Parameter(Mandatory = $false)][string]$DaemonSha256,
  [Parameter(Mandatory = $false)][string]$MachineUiArtifactPath,
  [Parameter(Mandatory = $false)][string]$MachineUiSha256,
  [Parameter(Mandatory = $false)][string]$EnvironmentName,
  [Parameter(Mandatory = $false)][string]$ProvisioningEndpoint,
  [Parameter(Mandatory = $false)][string]$MqttUrl,
  [Parameter(Mandatory = $false)][ValidateSet("production", "simulated")][string]$HardwareMode,
  [Parameter(Mandatory = $false)][string]$HardwareModel,
  [Parameter(Mandatory = $false)][string]$TopologyIdentity,
  [Parameter(Mandatory = $false)][string]$TopologyVersion,
  [Parameter(Mandatory = $false)][int]$ExpectedDisplayWidth,
  [Parameter(Mandatory = $false)][int]$ExpectedDisplayHeight,
  [Parameter(Mandatory = $false)][ValidateSet("portrait", "landscape")][string]$ExpectedDisplayOrientation,
  [Parameter(Mandatory = $false)][string]$ExpectedKioskUser,
  [Parameter(Mandatory = $false)][string]$ExpectedMaintenanceUser,
  [Parameter(Mandatory = $false)][string]$ExpectedAutoLogonUser,
  [Parameter(Mandatory = $false)][string]$ExpectedKioskShell,
  [Parameter(Mandatory = $false)][string]$TargetLayoutVersion,
  [Parameter(Mandatory = $false)][ValidateSet("production", "testbed")][string]$FactoryProfile,
  [Parameter(Mandatory = $false)][string]$PersonalizationMediaPath,
  [Parameter(Mandatory = $false)][string]$FactoryMediaRoot,
  [Parameter(Mandatory = $false)][string]$VisionConfigurationSourcePath,
  [Parameter(Mandatory = $false)][string]$OpenSshPackagePath,
  [Parameter(Mandatory = $false)][string]$OpenSshPackageSource,
  [Parameter(Mandatory = $false)][string]$OpenSshPackageVersion,
  [Parameter(Mandatory = $false)][string]$OpenSshPackageSha256,
  [Parameter(Mandatory = $false)][string]$OpenSshApprovedSignerThumbprint,
  [Parameter(Mandatory = $false)][string]$OpenSshApprovedRootThumbprint,
  [Parameter(Mandatory = $false)][string]$WireGuardPackagePath,
  [Parameter(Mandatory = $false)][string]$WireGuardPackageSource,
  [Parameter(Mandatory = $false)][string]$WireGuardPackageVersion,
  [Parameter(Mandatory = $false)][string]$WireGuardPackageSha256,
  [Parameter(Mandatory = $false)][string]$WireGuardApprovedSignerThumbprint,
  [Parameter(Mandatory = $false)][string]$WireGuardApprovedRootThumbprint,
  [Parameter(Mandatory = $false)][string]$MaintenanceSshCaPublicKeyPath,
  [Parameter(Mandatory = $false)][string]$MaintenanceSshCaPublicKeySha256,
  [Parameter(Mandatory = $false)][string[]]$MaintenanceRunnerSourceAllowlist,
  [Parameter(Mandatory = $false)][string[]]$MaintenanceMaintainerSourceAllowlist,
  [Parameter(Mandatory = $false)][string]$MaintenanceWireGuardInterfaceAlias = "VEM-Maintenance",
  [Parameter(Mandatory = $false)][string]$MaintenanceWireGuardListenAddress,

  [switch]$ResetExistingVemState,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$RuntimeRoot = "C:\VEM\bringup"
$ProgramDataRoot = "C:\ProgramData\VEM"

function Assert-RequiredInputs {
  $missing = @()
  foreach ($name in @(
      "DaemonArtifactPath",
      "DaemonSha256",
      "MachineUiArtifactPath",
      "MachineUiSha256",
      "EnvironmentName",
      "ProvisioningEndpoint",
      "MqttUrl",
      "HardwareMode",
      "HardwareModel",
      "TopologyIdentity",
      "TopologyVersion",
      "ExpectedDisplayWidth",
      "ExpectedDisplayHeight",
      "ExpectedDisplayOrientation",
      "ExpectedKioskUser",
      "ExpectedMaintenanceUser",
      "ExpectedAutoLogonUser",
      "ExpectedKioskShell",
      "TargetLayoutVersion",
      "FactoryProfile",
      "OpenSshPackagePath",
      "OpenSshPackageSource",
      "OpenSshPackageVersion",
      "OpenSshPackageSha256",
      "OpenSshApprovedSignerThumbprint",
      "OpenSshApprovedRootThumbprint",
      "WireGuardPackagePath",
      "WireGuardPackageSource",
      "WireGuardPackageVersion",
      "WireGuardPackageSha256",
      "WireGuardApprovedSignerThumbprint",
      "WireGuardApprovedRootThumbprint",
      "MaintenanceSshCaPublicKeyPath",
      "MaintenanceSshCaPublicKeySha256",
      "MaintenanceWireGuardInterfaceAlias",
      "MaintenanceWireGuardListenAddress"
    )) {
    $value = Get-Variable -Name $name -ValueOnly -ErrorAction SilentlyContinue
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value) -or [string]$value -eq "0") {
      $missing += $name
    }
  }

  if ($missing.Count -gt 0) {
    throw ("missing required input: {0}" -f ($missing -join ", "))
  }

  if ($FactoryProfile -eq "production") {
    $visionMissing = @("FactoryMediaRoot", "VisionConfigurationSourcePath") | Where-Object {
      [string]::IsNullOrWhiteSpace([string](Get-Variable -Name $_ -ValueOnly))
    }
    if ($visionMissing.Count -gt 0) {
      throw ("production Factory Vision installation requires: {0}" -f ($visionMissing -join ", "))
    }
  }

  Normalize-Sha256 -Value $DaemonSha256 | Out-Null
  Normalize-Sha256 -Value $MachineUiSha256 | Out-Null
}

function Get-FactoryMaintenanceProfilePolicy {
  param([string]$Profile)

  $policies = @{
    production = [ordered]@{
      maintenanceUser = "Admin"
      caProfile = "production"
      rejectedUsers = @("YKDZ")
      rejectedTokens = @("testbed", "simulator", "shared-password", "test-ca", "test-peer")
    }
    testbed = [ordered]@{
      maintenanceUser = "YKDZ"
      caProfile = "testbed"
      rejectedUsers = @("Admin@real")
      rejectedTokens = @("production-ca", "production-peer", "shared-password")
    }
  }
  if (-not $policies.ContainsKey($Profile)) {
    throw "FactoryProfile must be production or testbed"
  }
  return $policies[$Profile]
}

function Get-FactoryMaintenanceIngressPolicy {
  param(
    [string]$Profile,
    [string]$WireGuardInterfaceAlias,
    [string]$WireGuardListenAddress
  )

  if ($Profile -eq "production") {
    if ([string]::IsNullOrWhiteSpace($WireGuardInterfaceAlias)) {
      throw "production FactoryProfile requires a WireGuard maintenance interface alias"
    }
    if ([string]::IsNullOrWhiteSpace($WireGuardListenAddress) -or $WireGuardListenAddress -eq "0.0.0.0") {
      throw "production FactoryProfile requires a concrete WireGuard maintenance ListenAddress"
    }
    return [ordered]@{
      mode = "wireguard-only"
      effectiveListenAddress = $WireGuardListenAddress
      effectiveFirewallInterfaceScope = $WireGuardInterfaceAlias
    }
  }
  if ($Profile -eq "testbed") {
    return [ordered]@{
      mode = "testbed-bootstrap-certificate"
      effectiveListenAddress = "0.0.0.0"
      effectiveFirewallInterfaceScope = "Any"
    }
  }
  throw "FactoryProfile must be production or testbed"
}

function Assert-ProductionHostIsolation {
  param(
    [string]$DaemonConfigPath = "C:\ProgramData\VEM\vending-daemon\machine-config.json",
    [string]$WireGuardConfigPath = "C:\ProgramData\VEM\maintenance\VEM-Maintenance.conf",
    [string]$MaintenanceCaPath = "C:\ProgramData\VEM\factory\maintenance-ca.pub"
  )

  $findings = [System.Collections.Generic.List[string]]::new()
  if ($null -ne (Get-Command "Get-LocalUser" -ErrorAction SilentlyContinue)) {
    $testbedUser = Get-LocalUser -Name "YKDZ" -ErrorAction SilentlyContinue
    if ($null -ne $testbedUser) { $findings.Add("live YKDZ testbed account") | Out-Null }
  }
  if (-not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable("VEM_MAINTENANCE_PASSWORD"))) {
    $findings.Add("shared maintenance password environment input") | Out-Null
  }
  foreach ($candidate in @(
      [pscustomobject]@{ path = $DaemonConfigPath; pattern = '(?i)"hardwareAdapter"\s*:\s*"mock"|"serialPortPath"\s*:\s*"tcp://|"machineCode"\s*:\s*"[^"]*(testbed|test|sim)' ; label = "daemon simulator/testbed hardware configuration" },
      [pscustomobject]@{ path = $WireGuardConfigPath; pattern = "(?i)testbed|test-peer|simulator|shared-password"; label = "test peer WireGuard configuration" },
      [pscustomobject]@{ path = $MaintenanceCaPath; pattern = "(?i)vem-maintenance-ca:testbed|test-ca"; label = "test Maintenance SSH CA" }
    )) {
    if (Test-Path -LiteralPath $candidate.path -PathType Leaf) {
      $content = [System.IO.File]::ReadAllText($candidate.path, [System.Text.Encoding]::UTF8)
      if ($content -match $candidate.pattern) { $findings.Add([string]$candidate.label) | Out-Null }
    }
  }
  if ($null -ne (Get-Command "Get-Process" -ErrorAction SilentlyContinue)) {
    $simulatorProcesses = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { [string]$_.ProcessName -match "(?i)lower-controller-sim|simulator" })
    if ($simulatorProcesses.Count -gt 0) { $findings.Add("running hardware simulator process") | Out-Null }
  }
  if ($findings.Count -gt 0) {
    throw "production host contamination detected: $($findings -join ', ')"
  }
  return [ordered]@{
    checked = $true
    testbedAccountAbsent = $true
    sharedMaintenanceCredentialAbsent = $true
    testCaPeerAndSimulatorStateAbsent = $true
  }
}

function Assert-FactoryMaintenanceProfile {
  $policy = Get-FactoryMaintenanceProfilePolicy -Profile $FactoryProfile
  if ($ExpectedMaintenanceUser -cne [string]$policy.maintenanceUser) {
    throw "FactoryProfile $FactoryProfile requires maintenance account $($policy.maintenanceUser)"
  }
  if ($FactoryProfile -eq "production" -and $HardwareMode -ne "production") {
    throw "production FactoryProfile cannot use simulated hardware"
  }
  if ($FactoryProfile -eq "testbed" -and $HardwareMode -ne "simulated") {
    throw "testbed FactoryProfile requires simulated hardware"
  }
  if ($FactoryProfile -eq "production") {
    $policy.productionHostIsolation = Assert-ProductionHostIsolation
  }
  foreach ($token in @($policy.rejectedTokens)) {
    foreach ($value in @($EnvironmentName, $HardwareModel, $TopologyIdentity, $MaintenanceSshCaPublicKeyPath)) {
      if ([string]$value -match [regex]::Escape([string]$token)) {
        throw "FactoryProfile $FactoryProfile rejects contaminated input token $token"
      }
    }
  }
  return $policy
}

function Assert-PinnedLocalPackage {
  param(
    [string]$Name,
    [string]$Path,
    [string]$Source,
    [string]$Version,
    [string]$ExpectedSha256,
    [string]$ApprovedSignerThumbprint,
    [string]$ApprovedRootThumbprint
  )

  if ([string]::IsNullOrWhiteSpace($Source) -or $Source -notmatch "^(local-pinned|factory-cas://sha256/[0-9a-f]{64})$") {
    throw "$Name package source must be a declared local-pinned or factory-cas identity"
  }
  if ($Source -match "(?i)(https?|winget|choco|capability|online|latest|floating)" ) {
    throw "$Name package source must not be online, floating, or Windows Capability based"
  }
  if ([string]::IsNullOrWhiteSpace($Version) -or $Version -match "(?i)latest|floating") {
    throw "$Name package version must be fixed"
  }
  $hash = Assert-Sha256 -Path $Path -ExpectedSha256 $ExpectedSha256
  if ($Source -match "^factory-cas://sha256/([0-9a-f]{64})$") {
    $sourceHash = [string]$matches[1]
    if ($sourceHash -cne $hash) {
      throw "$Name content-addressed source does not match measured artifact hash"
    }
  }
  $signature = Get-AuthenticodePackageEvidence -Name $Name -Path $Path -ApprovedSignerThumbprint $ApprovedSignerThumbprint -ApprovedRootThumbprint $ApprovedRootThumbprint
  $signature["artifactSha256"] = $hash
  return [ordered]@{
    name = $Name
    source = $Source
    version = $Version
    sha256 = $hash
    signatureEvidence = $signature
    localInstallPath = $Path
    installedExecutablePaths = if ($Name -eq "OpenSSH") {
      @("C:\Program Files\OpenSSH\sshd.exe", "C:\Windows\System32\OpenSSH\sshd.exe")
    } elseif ($Name -eq "WireGuard") {
      @("C:\Program Files\WireGuard\wireguard.exe", "C:\Program Files (x86)\WireGuard\wireguard.exe")
    } else {
      @()
    }
  }
}

function Normalize-CertificateThumbprint {
  param([string]$Value)
  $normalized = ([string]$Value -replace "[^0-9A-Fa-f]", "").ToUpperInvariant()
  if ($normalized -notmatch "^[0-9A-F]{40}$") {
    throw "approved certificate thumbprint must be 40 hexadecimal characters"
  }
  return $normalized
}

function Get-CertificateChainEvidence {
  param($Certificate)

  $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
  $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
  $valid = $chain.Build($Certificate)
  $elements = @($chain.ChainElements | ForEach-Object { $_.Certificate })
  return [ordered]@{
    valid = $valid
    statuses = @($chain.ChainStatus | ForEach-Object { [string]$_.Status })
    thumbprints = @($elements | ForEach-Object { ([string]$_.Thumbprint).ToUpperInvariant() })
    rootThumbprint = if ($elements.Count -gt 0) { ([string]$elements[-1].Thumbprint).ToUpperInvariant() } else { $null }
  }
}

function Get-AuthenticodePackageEvidence {
  param(
    [string]$Name,
    [string]$Path,
    [string]$ApprovedSignerThumbprint,
    [string]$ApprovedRootThumbprint
  )

  $expectedSigner = Normalize-CertificateThumbprint -Value $ApprovedSignerThumbprint
  $expectedRoot = Normalize-CertificateThumbprint -Value $ApprovedRootThumbprint
  $signature = Get-AuthenticodeSignature -FilePath $Path
  if ($null -eq $signature -or [string]$signature.Status -cne "Valid" -or $null -eq $signature.SignerCertificate) {
    throw "$Name Authenticode signature is not valid: $([string]$signature.StatusMessage)"
  }
  $signerThumbprint = Normalize-CertificateThumbprint -Value ([string]$signature.SignerCertificate.Thumbprint)
  if ($signerThumbprint -cne $expectedSigner) {
    throw "$Name Authenticode signer thumbprint is not approved"
  }
  $chain = Get-CertificateChainEvidence -Certificate $signature.SignerCertificate
  if (-not [bool]$chain.valid) {
    throw "$Name Authenticode certificate chain is not valid: $(@($chain.statuses) -join ', ')"
  }
  if ([string]$chain.rootThumbprint -cne $expectedRoot) {
    throw "$Name Authenticode root certificate thumbprint is not approved"
  }
  return [ordered]@{
    verificationMethod = "authenticode"
    status = [string]$signature.Status
    statusMessage = [string]$signature.StatusMessage
    signerSubject = [string]$signature.SignerCertificate.Subject
    signerIssuer = [string]$signature.SignerCertificate.Issuer
    signerThumbprint = $signerThumbprint
    chainThumbprints = @($chain.thumbprints)
    rootThumbprint = [string]$chain.rootThumbprint
  }
}

function Read-JsonFile {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "JSON file not found: $Path"
  }
  return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
}

function Assert-MaintenanceCaInput {
  $hash = Assert-Sha256 -Path $MaintenanceSshCaPublicKeyPath -ExpectedSha256 $MaintenanceSshCaPublicKeySha256
  $keyLines = @([System.IO.File]::ReadAllLines($MaintenanceSshCaPublicKeyPath, [System.Text.Encoding]::UTF8) | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 -and -not $_.StartsWith("#") })
  if ($keyLines.Count -ne 1) {
    throw "Maintenance SSH CA file must contain exactly one public key"
  }
  $parts = $keyLines[0] -split "\s+", 3
  if ($parts.Count -ne 3 -or $parts[0] -cne "ssh-ed25519") {
    throw "Maintenance SSH CA file must contain exactly one Ed25519 OpenSSH public key with a profile comment"
  }
  try { [Convert]::FromBase64String($parts[1]) | Out-Null } catch { throw "Maintenance SSH CA public key encoding is invalid" }
  if ($parts[2] -notmatch "^vem-maintenance-ca:(production|testbed)$") {
    throw "Maintenance SSH CA public key comment must declare vem-maintenance-ca:<profile>"
  }
  $derivedProfile = $matches[1]
  if ($derivedProfile -cne $FactoryProfile) {
    throw "Maintenance SSH CA profile $derivedProfile does not match FactoryProfile $FactoryProfile"
  }
  $keygen = Get-Command "ssh-keygen.exe" -ErrorAction SilentlyContinue
  if ($null -eq $keygen) { $keygen = Get-Command "ssh-keygen" -ErrorAction SilentlyContinue }
  if ($null -eq $keygen) { throw "ssh-keygen is required to derive the Maintenance SSH CA fingerprint" }
  $fingerprintOutput = ((& $keygen.Source -lf $MaintenanceSshCaPublicKeyPath -E sha256 2>&1) | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $fingerprintOutput -notmatch "(SHA256:[A-Za-z0-9+/]+)") {
    throw "ssh-keygen could not derive the Maintenance SSH CA fingerprint: $fingerprintOutput"
  }
  return [ordered]@{
    profile = $derivedProfile
    sha256 = $hash
    fingerprint = $matches[1]
    keyType = $parts[0]
    keyCount = 1
    publicKeyOnly = $true
  }
}

function Assert-RolePools {
  $all = @($MaintenanceRunnerSourceAllowlist) + @($MaintenanceMaintainerSourceAllowlist)
  if ($all.Count -eq 0) {
    throw "Controlled Maintenance Ingress requires runner and maintainer role pools"
  }
  foreach ($source in $all) {
    foreach ($candidate in ([string]$source -split ",")) {
      $value = $candidate.Trim()
      if ([string]::IsNullOrWhiteSpace($value) -or $value -match "^(Any|\*|Internet|LocalSubnet|DefaultGateway|DHCP|DNS|WINS|0\.0\.0\.0|::|0\.0\.0\.0/0|::/0)$") {
        throw "maintenance role pools must contain only explicit source addresses or CIDRs"
      }
      $parts = $value -split "/", 2
      $address = [System.Net.IPAddress]::None
      if (-not [System.Net.IPAddress]::TryParse($parts[0], [ref]$address)) {
        throw "maintenance role pools must contain only explicit source addresses or CIDRs"
      }
      if ($parts.Count -eq 2) {
        $prefix = 0
        if (-not [int]::TryParse($parts[1], [ref]$prefix)) {
          throw "maintenance role pools must contain only explicit source addresses or CIDRs"
        }
        $maximumPrefix = if ($address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) { 128 } else { 32 }
        if ($prefix -le 0 -or $prefix -gt $maximumPrefix) {
          throw "maintenance role pools must contain only explicit source addresses or CIDRs"
        }
      } elseif ($parts.Count -ne 1) {
        throw "maintenance role pools must contain only explicit source addresses or CIDRs"
      }
    }
  }
  return @($all | ForEach-Object { ([string]$_ -split ",") } | ForEach-Object { $_.Trim() } | Sort-Object -Unique)
}

function Invoke-NamedPowerShellScript {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [Parameter(Mandatory = $true)][hashtable]$Arguments
  )

  & $ScriptPath @Arguments
}

function Get-WireGuardTunnelServiceName {
  return 'WireGuardTunnel$VEM-Maintenance'
}

function Assert-ExactObjectProperties {
  param(
    $Value,
    [string[]]$ExpectedNames,
    [string]$Label
  )

  if ($null -eq $Value -or $Value -is [string] -or $Value -is [array]) {
    throw "$Label must be an object"
  }
  $actualNames = @($Value.PSObject.Properties.Name)
  $unknown = @($actualNames | Where-Object { $_ -notin $ExpectedNames })
  $missing = @($ExpectedNames | Where-Object { $_ -notin $actualNames })
  if ($unknown.Count -gt 0 -or $missing.Count -gt 0 -or $actualNames.Count -ne $ExpectedNames.Count) {
    throw "$Label has an invalid property shape"
  }
}

function Get-RequiredOwnProperty {
  param(
    $Value,
    [string]$Name,
    [string]$Label
  )

  $property = @($Value.PSObject.Properties | Where-Object { $_.Name -ceq $Name })
  if ($property.Count -ne 1) {
    throw "$Label is missing required own property $Name"
  }
  return $property[0].Value
}

function Assert-FactoryPersonalizationMedia {
  if ([string]::IsNullOrWhiteSpace($PersonalizationMediaPath)) { return $null }
  if (-not (Test-Path -LiteralPath $PersonalizationMediaPath -PathType Leaf)) {
    throw "Factory Personalization Media is missing"
  }
  $media = Read-JsonFile -Path $PersonalizationMediaPath
  Assert-ExactObjectProperties -Value $media -ExpectedNames @("schemaVersion", "kind", "mediaId", "profile", "protection", "credentials") -Label "Factory Personalization Media"
  $schemaVersion = Get-RequiredOwnProperty -Value $media -Name "schemaVersion" -Label "Factory Personalization Media"
  $kind = Get-RequiredOwnProperty -Value $media -Name "kind" -Label "Factory Personalization Media"
  $mediaProfile = Get-RequiredOwnProperty -Value $media -Name "profile" -Label "Factory Personalization Media"
  $mediaId = Get-RequiredOwnProperty -Value $media -Name "mediaId" -Label "Factory Personalization Media"
  $protection = Get-RequiredOwnProperty -Value $media -Name "protection" -Label "Factory Personalization Media"
  $credentialObject = Get-RequiredOwnProperty -Value $media -Name "credentials" -Label "Factory Personalization Media"
  if ([string]$schemaVersion -cne "vem-factory-personalization-media/v1" -or [string]$kind -cne "factory-personalization-media") {
    throw "Factory Personalization Media schema is invalid"
  }
  if ([string]$mediaProfile -cne $FactoryProfile) { throw "Factory Personalization Media profile does not match FactoryProfile" }
  if ([string]$mediaId -notmatch "^[a-z0-9][a-z0-9-]{15,127}$") { throw "Factory Personalization Media id is invalid" }
  Assert-ExactObjectProperties -Value $protection -ExpectedNames @("encryptedAtRest", "access", "cache", "retention") -Label "Factory Personalization Media protection"
  $encryptedAtRest = Get-RequiredOwnProperty -Value $protection -Name "encryptedAtRest" -Label "Factory Personalization Media protection"
  if ($encryptedAtRest -isnot [bool] -or $encryptedAtRest -ne $true -or [string](Get-RequiredOwnProperty -Value $protection -Name "access" -Label "Factory Personalization Media protection") -cne "trusted-protected-gate" -or [string](Get-RequiredOwnProperty -Value $protection -Name "cache" -Label "Factory Personalization Media protection") -cne "forbidden" -or [string](Get-RequiredOwnProperty -Value $protection -Name "retention" -Label "Factory Personalization Media protection") -cne "installation-lifecycle-only") {
    throw "Factory Personalization Media protection policy is invalid"
  }
  $credentialNames = if ($FactoryProfile -eq "production") { @("administrator", "kiosk") } else { @("bootstrap", "kiosk") }
  Assert-ExactObjectProperties -Value $credentialObject -ExpectedNames $credentialNames -Label "Factory Personalization Media credentials"
  $maintenanceCredentialName = if ($FactoryProfile -eq "production") { "administrator" } else { "bootstrap" }
  $expectedMaintenanceUser = if ($FactoryProfile -eq "production") { "Admin" } else { "YKDZ" }
  $maintenance = Get-RequiredOwnProperty -Value $credentialObject -Name $maintenanceCredentialName -Label "Factory Personalization Media credentials"
  $kiosk = Get-RequiredOwnProperty -Value $credentialObject -Name "kiosk" -Label "Factory Personalization Media credentials"
  Assert-ExactObjectProperties -Value $maintenance -ExpectedNames @("user", "password") -Label "Factory Personalization Media maintenance credential"
  Assert-ExactObjectProperties -Value $kiosk -ExpectedNames @("user", "password") -Label "Factory Personalization Media kiosk credential"
  $maintenanceUser = Get-RequiredOwnProperty -Value $maintenance -Name "user" -Label "Factory Personalization Media maintenance credential"
  $kioskUser = Get-RequiredOwnProperty -Value $kiosk -Name "user" -Label "Factory Personalization Media kiosk credential"
  $maintenancePassword = Get-RequiredOwnProperty -Value $maintenance -Name "password" -Label "Factory Personalization Media maintenance credential"
  $kioskPassword = Get-RequiredOwnProperty -Value $kiosk -Name "password" -Label "Factory Personalization Media kiosk credential"
  if ([string]$maintenanceUser -cne $expectedMaintenanceUser -or [string]$kioskUser -cne $ExpectedKioskUser) {
    throw "Factory Personalization Media account profile is invalid"
  }
  foreach ($password in @($maintenancePassword, $kioskPassword)) {
    if ($password -isnot [string] -or $password.Length -lt 16 -or $password -match "(?i)shared-password") {
      throw "Factory Personalization Media contains an invalid or shared password"
    }
  }
  if ([string]$maintenancePassword -ceq [string]$kioskPassword) { throw "Factory Personalization Media credentials must be unique" }
  $serialized = $media | ConvertTo-Json -Depth 20 -Compress
  if ($serialized -match "(?i)private.?key|wireguard|wg|peer|certificate|token|secret") {
    throw "Factory Personalization Media must not supply WireGuard key or peer material"
  }
  if ($FactoryProfile -eq "production" -and $serialized -match "(?i)YKDZ|testbed|test-ca|simulator|shared-password") {
    throw "production Factory Personalization Media contains testbed material"
  }
  return [pscustomobject]@{
    KioskPassword = [string]$kioskPassword
    AutoLogonPassword = [string]$kioskPassword
    MaintenancePassword = [string]$maintenancePassword
    MediaId = [string]$mediaId
    Sources = [ordered]@{ personalizationMedia = "trusted-protected-gate" }
    Redaction = [ordered]@{
      schemaVersion = "vem-factory-personalization-media-redaction/v1"
      kind = "factory-personalization-media-redaction"
      profile = $FactoryProfile
      protection = [ordered]@{
        encryptedAtRest = $true
        access = "trusted-protected-gate"
        cache = "forbidden"
        retention = "installation-lifecycle-only"
      }
      credentials = [ordered]@{
        ($maintenanceCredentialName) = "configured"
        kiosk = "configured"
      }
      wireGuardPrivateKey = "not-supplied; generated-locally"
      mediaConsumed = $true
      stagingRetained = $false
    }
  }
}

function Assert-FactoryPersonalizationNotReused {
  param($Preflight)

  $markerPath = Join-Path $ProgramDataRoot "factory\personalization-consumed.json"
  if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { return }
  $marker = Read-JsonFile -Path $markerPath
  if ([string]$marker.mediaId -ceq [string]$Preflight.MediaId) {
    throw "Factory Personalization Media has already been consumed for this installation"
  }
}

function Mark-FactoryPersonalizationConsumed {
  param($Preflight)

  $markerPath = Join-Path $ProgramDataRoot "factory\personalization-consumed.json"
  Write-JsonFile -Path $markerPath -Value ([ordered]@{
      schemaVersion = "vem-factory-personalization-consumption/v1"
      profile = [string]$Preflight.FactoryProfile
      mediaId = [string]$Preflight.MediaId
    })
  icacls.exe $markerPath /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Factory Personalization Media consumption marker ACL setup failed"
  }
}

function Assert-CredentialInputs {
  if ($DryRun) {
    if (-not [string]::IsNullOrWhiteSpace($PersonalizationMediaPath)) {
      throw "Factory Personalization Media must not be mounted for a dry run"
    }
    $dryRunCredentialRedaction = [ordered]@{
      kiosk = "not-configured"
    }
    if ($FactoryProfile -eq "production") {
      $dryRunCredentialRedaction = [ordered]@{
        administrator = "not-configured"
        kiosk = "not-configured"
      }
    } else {
      $dryRunCredentialRedaction = [ordered]@{
        bootstrap = "not-configured"
        kiosk = "not-configured"
      }
    }
    return [pscustomobject]@{
      KioskPassword = $null
      AutoLogonPassword = $null
      MaintenancePassword = $null
      MediaId = $null
      Sources = [ordered]@{ personalizationMedia = "not-mounted-dry-run" }
      Redaction = [ordered]@{
        schemaVersion = "vem-factory-personalization-media-preview/v1"
        kind = "factory-personalization-media-preview"
        profile = $FactoryProfile
        protection = [ordered]@{
          encryptedAtRest = $true
          access = "trusted-protected-gate"
          cache = "forbidden"
          retention = "installation-lifecycle-only"
        }
        credentials = $dryRunCredentialRedaction
        wireGuardPrivateKey = "not-supplied; generated-locally"
        mediaConsumed = $false
        stagingRetained = $false
      }
    }
  }
  $media = Assert-FactoryPersonalizationMedia
  if ($null -ne $media) { return $media }
  throw "Factory Personalization Media is required; direct credential parameters and environment variables are not accepted for factory preparation"
}

function Normalize-Sha256 {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    throw "sha256 is required"
  }
  $normalized = $Value.Trim().ToLowerInvariant()
  if ($normalized -notmatch "^[0-9a-f]{64}$") {
    throw "sha256 must be 64 hex characters"
  }
  return $normalized
}

function Assert-Sha256 {
  param(
    [string]$Path,
    [string]$ExpectedSha256
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "artifact not found: $Path"
  }
  $expected = Normalize-Sha256 -Value $ExpectedSha256
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    throw "hash mismatch for $Path; expected $expected got $actual"
  }
  return $actual
}

function Ensure-Directory {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Write-JsonFile {
  param(
    [string]$Path,
    [object]$Value
  )

  Ensure-Directory -Path (Split-Path -Parent $Path)
  $json = $Value | ConvertTo-Json -Depth 30
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Test-ShellLauncherAvailable {
  $shellLauncher = Get-CimClass -Namespace "root\standardcimv2\embedded" -ClassName "WESL_UserSetting" -ErrorAction SilentlyContinue
  return $null -ne $shellLauncher
}

function New-FactoryWindowsBaselinePolicy {
  return [ordered]@{
    schemaVersion = "factory-windows-baseline-policy/v1"
    model = "allowlist"
    requiredCapabilities = @(
      "defender_enabled",
      "firewall_enabled",
      "no_default_product_remote_ingress",
      "vem_runtime_defender_exclusions",
      "openssh_server_for_maintenance_users",
      "tailscale_not_installed_by_default",
      "kiosk_account_denied_remote_access",
      "windows_event_logging",
      "powershell_management",
      "networking_certificates_time_sync",
      "webview2_runtime_support",
      "display_touch_usb_serial_drivers",
      "fonts_input_methods"
    )
    disabledRuntimeInterference = @(
      "windows_auto_update_installation",
      "windows_auto_update_auto_restart",
      "sleep",
      "hibernation",
      "testsigning",
      "store_automatic_app_updates",
      "consumer_experience_autostart",
      "consumer_experience_foreground_popups",
      "consumer_experience_kiosk_foreground_takeover_best_effort"
    )
    evidenceFields = [ordered]@{
      windowsUpdatePolicy = "assertions.windowsUpdatePolicy"
      powerPolicy = "assertions.powerPolicy"
      bootPolicy = "assertions.bootPolicy"
      securityPosture = "assertions.securityPosture"
      remoteMaintenanceCapability = "assertions.factoryRemoteMaintenanceCapability"
      consumerExperienceInterference = "assertions.consumerExperienceInterference"
    }
  }
}

function Set-DwordValue {
  param(
    [string]$Path,
    [string]$Name,
    [int]$Value
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -Path $Path -Force | Out-Null
  }
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType DWord -Force | Out-Null
}

function Apply-FactoryWindowsBaseline {
  param($Policy)

  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" -Name "NoAutoUpdate" -Value 1
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" -Name "AUOptions" -Value 2
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU" -Name "NoAutoRebootWithLoggedOnUsers" -Value 1
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate" -Name "SetActiveHours" -Value 1
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate" -Name "ActiveHoursStart" -Value 0
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate" -Name "ActiveHoursEnd" -Value 23

  powercfg.exe /change standby-timeout-ac 0 | Out-Null
  powercfg.exe /change standby-timeout-dc 0 | Out-Null
  powercfg.exe /hibernate off | Out-Null
  bcdedit.exe /set testsigning off | Out-Null

  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent" -Name "DisableWindowsConsumerFeatures" -Value 1
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent" -Name "DisableSoftLanding" -Value 1
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent" -Name "DisableWindowsSpotlightFeatures" -Value 1
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\WindowsStore" -Name "AutoDownload" -Value 2
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\WindowsStore" -Name "DisableStoreApps" -Value 0
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Explorer" -Name "DisableNotificationCenter" -Value 1
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\GameDVR" -Name "AllowGameDVR" -Value 0
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\OneDrive" -Name "DisableFileSyncNGSC" -Value 1
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search" -Name "AllowCortana" -Value 0
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search" -Name "DisableWebSearch" -Value 1

  Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True | Out-Null

  if (Get-Command Add-MpPreference -ErrorAction SilentlyContinue) {
    Add-MpPreference -ExclusionPath "C:\VEM\bringup" -ErrorAction SilentlyContinue
    Add-MpPreference -ExclusionPath "C:\ProgramData\VEM" -ErrorAction SilentlyContinue
    Add-MpPreference -ExclusionProcess "vending-daemon.exe" -ErrorAction SilentlyContinue
    Add-MpPreference -ExclusionProcess "machine.exe" -ErrorAction SilentlyContinue
  }

  Set-DwordValue -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" -Name "LocalAccountTokenFilterPolicy" -Value 0

  return [ordered]@{
    schemaVersion = "factory-windows-baseline-application/v1"
    policySchemaVersion = $Policy.schemaVersion
    status = "applied"
  }
}

function Copy-ScriptIfPresent {
  param(
    [string]$Name,
    [string]$TargetDirectory
  )

  $source = Join-Path $PSScriptRoot $Name
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "required support script not found: $source"
  }
  Copy-Item -LiteralPath $source -Destination (Join-Path $TargetDirectory $Name) -Force
}

function Assert-SupportScriptPresent {
  param([string]$Name)

  $source = Join-Path $PSScriptRoot $Name
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
    throw "required support script not found: $source"
  }
  return $source
}

function Assert-FactoryRuntimePreflight {
  $daemonHash = Assert-Sha256 -Path $DaemonArtifactPath -ExpectedSha256 $DaemonSha256
  $machineUiHash = Assert-Sha256 -Path $MachineUiArtifactPath -ExpectedSha256 $MachineUiSha256
  $machineUiSidecarPath = Join-Path (Split-Path -Parent $MachineUiArtifactPath) "WebView2Loader.dll"
  if (-not (Test-Path -LiteralPath $machineUiSidecarPath -PathType Leaf)) {
    throw "required machine UI sidecar missing next to machine.exe: $machineUiSidecarPath"
  }
  $machineUiSidecarHash = (Get-FileHash -LiteralPath $machineUiSidecarPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $credentials = Assert-CredentialInputs
  $profilePolicy = Assert-FactoryMaintenanceProfile
  $openSshPackage = Assert-PinnedLocalPackage -Name "OpenSSH" -Path $OpenSshPackagePath -Source $OpenSshPackageSource -Version $OpenSshPackageVersion -ExpectedSha256 $OpenSshPackageSha256 -ApprovedSignerThumbprint $OpenSshApprovedSignerThumbprint -ApprovedRootThumbprint $OpenSshApprovedRootThumbprint
  $wireGuardPackage = Assert-PinnedLocalPackage -Name "WireGuard" -Path $WireGuardPackagePath -Source $WireGuardPackageSource -Version $WireGuardPackageVersion -ExpectedSha256 $WireGuardPackageSha256 -ApprovedSignerThumbprint $WireGuardApprovedSignerThumbprint -ApprovedRootThumbprint $WireGuardApprovedRootThumbprint
  $maintenanceCa = Assert-MaintenanceCaInput
  $rolePools = Assert-RolePools
  $maintenanceIngress = Get-FactoryMaintenanceIngressPolicy -Profile $FactoryProfile -WireGuardInterfaceAlias $MaintenanceWireGuardInterfaceAlias -WireGuardListenAddress $MaintenanceWireGuardListenAddress
  $supportScripts = @(
    "setup-scheduled-tasks.ps1",
    "verify-factory-runtime.ps1",
    "verify-kiosk-lockdown.ps1",
    "verify-vem-runtime.ps1",
    "apply-managed-update.ps1",
    "provision-vision-factory-release.ps1",
    "install-vision-release.ps1"
  ) | ForEach-Object { Assert-SupportScriptPresent -Name $_ }

  return [pscustomobject]@{
    DaemonSha256 = $daemonHash
    MachineUiSha256 = $machineUiHash
    MachineUiSidecarSha256 = $machineUiSidecarHash
    KioskPassword = $credentials.KioskPassword
    AutoLogonPassword = $credentials.AutoLogonPassword
    MaintenancePassword = $credentials.MaintenancePassword
    PersonalizationRedaction = $credentials.Redaction
    CredentialSources = $credentials.Sources
    FactoryProfile = $FactoryProfile
    ProfilePolicy = $profilePolicy
    OpenSshPackage = $openSshPackage
    WireGuardPackage = $wireGuardPackage
    MaintenanceCa = $maintenanceCa
    RolePools = $rolePools
    RunnerSourceAllowlist = @($MaintenanceRunnerSourceAllowlist)
    MaintainerSourceAllowlist = @($MaintenanceMaintainerSourceAllowlist)
    WireGuardInterfaceAlias = $MaintenanceWireGuardInterfaceAlias
    WireGuardListenAddress = $MaintenanceWireGuardListenAddress
    MaintenanceIngress = $maintenanceIngress
    SupportScripts = @($supportScripts)
  }
}

function New-FactoryRuntimePlan {
  param($Preflight)

  $machineUiSidecarArtifactPath = Join-Path (Split-Path -Parent $MachineUiArtifactPath) "WebView2Loader.dll"
  $factoryRoot = Join-Path $ProgramDataRoot "factory"
  $bringupDataRoot = Join-Path $ProgramDataRoot "bringup"
  $evidenceRoot = Join-Path $ProgramDataRoot "evidence"
  $daemonDataRoot = Join-Path $ProgramDataRoot "vending-daemon"
  $provisioningRoot = Join-Path $ProgramDataRoot "provisioning"
  $secretsRoot = Join-Path $ProgramDataRoot "secrets"
  $overridesRoot = Join-Path $ProgramDataRoot "overrides"
  $scriptsRoot = Join-Path $RuntimeRoot "scripts"
  $factoryWindowsBaselinePolicy = New-FactoryWindowsBaselinePolicy

  return [ordered]@{
    schemaVersion = "vem-factory-runtime-plan/v1"
    generatedAt = "1970-01-01T00:00:00.0000000Z"
    layoutVersion = $TargetLayoutVersion
    factoryWindowsBaselinePolicy = $factoryWindowsBaselinePolicy
    resetExistingVemState = [bool]$ResetExistingVemState
    inputs = [ordered]@{
      environmentName = $EnvironmentName
      provisioningEndpoint = $ProvisioningEndpoint
      hardwareMode = $HardwareMode
      hardwareModel = $HardwareModel
      topologyIdentity = $TopologyIdentity
      topologyVersion = $TopologyVersion
      factoryProfile = $Preflight.FactoryProfile
      factoryMediaRoot = $FactoryMediaRoot
      visionConfigurationSourcePath = $VisionConfigurationSourcePath
      wireGuardInterfaceAlias = $Preflight.WireGuardInterfaceAlias
      wireGuardListenAddress = $Preflight.WireGuardListenAddress
      maintenanceIngress = $Preflight.MaintenanceIngress
      display = [ordered]@{
        width = $ExpectedDisplayWidth
        height = $ExpectedDisplayHeight
        orientation = $ExpectedDisplayOrientation
      }
      accounts = [ordered]@{
        kioskUser = $ExpectedKioskUser
        maintenanceUser = $ExpectedMaintenanceUser
        autoLogonUser = $ExpectedAutoLogonUser
      }
      kiosk = [ordered]@{
        expectedShell = $ExpectedKioskShell
      }
      credentials = $Preflight.CredentialSources
      components = @(
        [ordered]@{
          component = "daemon"
          artifactPath = $DaemonArtifactPath
          sha256 = $Preflight.DaemonSha256
          targetPath = Join-Path $RuntimeRoot "vending-daemon.exe"
        },
        [ordered]@{
          component = "ui"
          artifactPath = $MachineUiArtifactPath
          sha256 = $Preflight.MachineUiSha256
          targetPath = Join-Path $RuntimeRoot "machine.exe"
        },
        [ordered]@{
          component = "ui-webview2-loader"
          artifactPath = $machineUiSidecarArtifactPath
          sha256 = $Preflight.MachineUiSidecarSha256
          targetPath = Join-Path $RuntimeRoot "WebView2Loader.dll"
        }
      )
      packages = [ordered]@{
        openSsh = [ordered]@{
          name = $Preflight.OpenSshPackage.name
          source = $Preflight.OpenSshPackage.source
          version = $Preflight.OpenSshPackage.version
          sha256 = $Preflight.OpenSshPackage.sha256
          signatureEvidence = $Preflight.OpenSshPackage.signatureEvidence
        }
        wireGuard = [ordered]@{
          name = $Preflight.WireGuardPackage.name
          source = $Preflight.WireGuardPackage.source
          version = $Preflight.WireGuardPackage.version
          sha256 = $Preflight.WireGuardPackage.sha256
          signatureEvidence = $Preflight.WireGuardPackage.signatureEvidence
        }
      }
      maintenanceCa = $Preflight.MaintenanceCa
      rolePools = [ordered]@{
        runner = @($Preflight.RunnerSourceAllowlist)
        maintainer = @($Preflight.MaintainerSourceAllowlist)
      }
    }
    layout = [ordered]@{
      runtimeRoot = $RuntimeRoot
      scriptsRoot = $scriptsRoot
      factoryRoot = "C:\ProgramData\VEM\factory"
      manifestPath = Join-Path $factoryRoot "factory-runtime-manifest.json"
      daemonFactoryManifestPath = Join-Path $factoryRoot "factory-manifest.json"
      bringupSettingsPath = Join-Path $bringupDataRoot "local-bringup-settings.json"
      daemonBringupSettingsPath = Join-Path $bringupDataRoot "local-settings.json"
      daemonConfigPath = Join-Path $daemonDataRoot "machine-config.json"
      daemonReadyFile = Join-Path $daemonDataRoot "daemon-ready.json"
      provisioningRoot = $provisioningRoot
      secretsRoot = $secretsRoot
      evidenceRoot = $evidenceRoot
      visionInstallEvidencePath = Join-Path $evidenceRoot "vision-release-install.json"
      visionConfigurationPath = "C:\ProgramData\VEM\vision\config\factory-vision-config.json"
      maintenanceCaPath = Join-Path $factoryRoot "maintenance-ca.pub"
      wireGuardRoot = Join-Path $ProgramDataRoot "maintenance"
      wireGuardConfigPath = Join-Path (Join-Path $ProgramDataRoot "maintenance") "VEM-Maintenance.conf"
      verifierEvidencePath = Join-Path $evidenceRoot "factory-runtime-verification.json"
      overridesRoot = $overridesRoot
    }
    directories = @(
      "C:\VEM\bringup",
      $scriptsRoot,
      "C:\ProgramData\VEM\factory",
      "C:\ProgramData\VEM\bringup",
      "C:\ProgramData\VEM\vending-daemon",
      "C:\ProgramData\VEM\provisioning",
      "C:\ProgramData\VEM\secrets",
      "C:\ProgramData\VEM\evidence",
      "C:\ProgramData\VEM\vision\config",
      (Join-Path $ProgramDataRoot "maintenance"),
      "C:\ProgramData\VEM\overrides"
    )
    registrations = [ordered]@{
      daemonServiceName = "VemVendingDaemon"
      machineUiTaskName = "VEMMachineUI"
      maintenanceUiTaskName = "VEMMaintenanceUI"
      visionTaskName = "VEM\StartVisionServer"
      setupScript = Join-Path $scriptsRoot "setup-scheduled-tasks.ps1"
      verifierScript = Join-Path $scriptsRoot "verify-factory-runtime.ps1"
      wireGuardTunnelServiceName = Get-WireGuardTunnelServiceName
    }
    resetEvidence = New-EmptyResetEvidence
  }
}

function Get-WireGuardExePath {
  foreach ($path in @(
      "C:\Program Files\WireGuard\wireguard.exe",
      "C:\Program Files (x86)\WireGuard\wireguard.exe"
    )) {
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
  }
  return $null
}

function Get-WgExePath {
  foreach ($path in @(
      "C:\Program Files\WireGuard\wg.exe",
      "C:\Program Files (x86)\WireGuard\wg.exe"
    )) {
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
  }
  return $null
}

function Install-PinnedWindowsPackage {
  param($Package)

  foreach ($installedPath in @($Package.installedExecutablePaths)) {
    if (-not (Test-Path -LiteralPath $installedPath -PathType Leaf)) { continue }
    $installed = Get-Item -LiteralPath $installedPath -ErrorAction SilentlyContinue
    if ($null -ne $installed -and (Test-PinnedVersionEquivalent -Actual ([string]$installed.VersionInfo.FileVersion) -Expected ([string]$Package.version))) {
      return [ordered]@{
        skipped = $true
        reason = "matching_pinned_version_installed"
        installedPath = [string]$installedPath
        installedVersion = [string]$installed.VersionInfo.FileVersion
      }
    }
  }

  $extension = [System.IO.Path]::GetExtension([string]$Package.localInstallPath).ToLowerInvariant()
  if ($extension -eq ".msi") {
    $msiPath = [string]$Package.localInstallPath
    if ($msiPath.Contains('"')) { throw "$($Package.name) MSI path contains an invalid quote" }
    $process = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", ('"{0}"' -f $msiPath), "/qn", "/norestart") -PassThru -Wait
  } elseif ($extension -eq ".exe") {
    $process = Start-Process -FilePath ([string]$Package.localInstallPath) -ArgumentList @("/quiet", "/norestart") -PassThru -Wait
  } else {
    throw "$($Package.name) package must be a local MSI or EXE installer"
  }
  if ([int]$process.ExitCode -notin @(0, 3010)) {
    throw "$($Package.name) pinned installer failed with exit code $($process.ExitCode)"
  }
  return [ordered]@{
    skipped = $false
    reason = "pinned_installer_executed"
    exitCode = [int]$process.ExitCode
  }
}

function Test-PinnedVersionEquivalent {
  param(
    [string]$Actual,
    [string]$Expected
  )

  if ($Actual.Trim() -ceq $Expected.Trim()) { return $true }
  $actualMatch = [regex]::Match($Actual, "\d+(?:\.\d+)+")
  $expectedMatch = [regex]::Match($Expected, "\d+(?:\.\d+)+")
  if (-not $actualMatch.Success -or -not $expectedMatch.Success) { return $false }
  $actualParts = [System.Collections.Generic.List[int]]@($actualMatch.Value.Split(".") | ForEach-Object { [int]$_ })
  $expectedParts = [System.Collections.Generic.List[int]]@($expectedMatch.Value.Split(".") | ForEach-Object { [int]$_ })
  while ($actualParts.Count -gt 1 -and $actualParts[-1] -eq 0) { $actualParts.RemoveAt($actualParts.Count - 1) }
  while ($expectedParts.Count -gt 1 -and $expectedParts[-1] -eq 0) { $expectedParts.RemoveAt($expectedParts.Count - 1) }
  return ($actualParts -join ".") -ceq ($expectedParts -join ".")
}

function Ensure-LocalWireGuardTunnelService {
  param($Plan)

  $wireGuardExe = Get-WireGuardExePath
  $wgExe = Get-WgExePath
  if ($null -eq $wireGuardExe -or $null -eq $wgExe) {
    throw "WireGuard executables are unavailable after pinned local installation"
  }
  Ensure-Directory -Path ([string]$Plan.layout.wireGuardRoot)
  $configPath = [string]$Plan.layout.wireGuardConfigPath
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
    $privateKey = (& $wgExe genkey | Out-String).Trim()
    if ($privateKey -notmatch "^[A-Za-z0-9+/]{42,45}={0,2}$") {
      throw "WireGuard did not generate a valid local private key"
    }
    $listenAddress = [System.Net.IPAddress]::None
    if (-not [System.Net.IPAddress]::TryParse([string]$Plan.inputs.wireGuardListenAddress, [ref]$listenAddress)) {
      throw "WireGuard tunnel ListenAddress is invalid: $($Plan.inputs.wireGuardListenAddress)"
    }
    $prefixLength = if ($listenAddress.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) { 128 } else { 32 }
    $config = @(
      "[Interface]",
      "PrivateKey = $privateKey",
      "Address = $($listenAddress.IPAddressToString)/$prefixLength",
      "# VEM daemon replaces peer/address state after Machine Claim"
    )
    Set-Content -LiteralPath $configPath -Value $config -Encoding ASCII
    icacls.exe $configPath /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" | Out-Null
  }
  $serviceName = Get-WireGuardTunnelServiceName
  if ($null -eq (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) {
    & $wireGuardExe /installtunnelservice $configPath | Out-Null
  }
  Set-Service -Name $serviceName -StartupType Automatic
  Start-Service -Name $serviceName -ErrorAction SilentlyContinue
  $service = Get-Service -Name $serviceName -ErrorAction Stop
  $serviceConfig = Get-CimInstance Win32_Service -Filter ("Name = '{0}'" -f $serviceName) -ErrorAction Stop
  $automatic = [string]$serviceConfig.StartMode -eq "Auto"
  $localSystemOwned = [string]$serviceConfig.StartName -match "(?i)^(LocalSystem|NT AUTHORITY\\SYSTEM)$"
  if ([string]$service.Status -ne "Running" -or -not $automatic -or -not $localSystemOwned) {
    throw "WireGuard maintenance tunnel service must be running, automatic, and LocalSystem-owned"
  }
  return [ordered]@{
    serviceName = $serviceName
    status = [string]$service.Status
    startupType = if ($automatic) { "Automatic" } else { [string]$serviceConfig.StartMode }
    startIndependentOfKiosk = $automatic
    owner = [string]$serviceConfig.StartName
    ownerMatches = $localSystemOwned
    interfaceAlias = [string]$Plan.inputs.wireGuardInterfaceAlias
    configPath = $configPath
    privateKey = "local_only_not_emitted"
  }
}

function Set-FactoryMaintenanceAccountPassword {
  param(
    [string]$User,
    [string]$Password
  )

  if ([string]::IsNullOrEmpty($Password)) { return }
  $account = Get-LocalUser -Name $User -ErrorAction SilentlyContinue
  if ($null -eq $account) { throw "Factory Personalization Media requires the existing maintenance account $User" }
  $securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
  Set-LocalUser -Name $User -Password $securePassword
}

function New-EvidenceItem {
  param(
    [string]$Category,
    [string]$Path,
    [string]$Reason
  )

  return [ordered]@{
    category = $Category
    path = $Path
    reason = $Reason
  }
}

function Get-FactoryMaintenanceResetTargets {
  return [ordered]@{
    serviceNames = @(
      (Get-WireGuardTunnelServiceName),
      "WireGuardTunnelVEM-Maintenance"
    )
    paths = @(
      "C:\ProgramData\VEM\maintenance\VEM-Maintenance.conf",
      "C:\ProgramData\VEM\factory\maintenance-ca.pub",
      "C:\ProgramData\VEM\factory\factory-runtime-manifest.json",
      "C:\ProgramData\ssh\sshd_config"
    )
    firewallDisplayNames = @("VEM Controlled Maintenance SSH")
  }
}

function New-EmptyResetEvidence {
  $preserved = @(
    (New-EvidenceItem `
        -Category "platform_business_data" `
        -Path "platform://VEM" `
        -Reason "platform machines, orders, inventory, payments, planograms, and audit records are outside local factory reset")
  )
  $skipped = @()

  return [ordered]@{
    status = "clean"
    dataDir = "C:\ProgramData\VEM\vending-daemon"
    runtimeRoot = "C:\ProgramData\VEM"
    found = @()
    cleared = @()
    preserved = $preserved
    skipped = $skipped
  }
}

function Add-FoundState {
  param(
    [System.Collections.Generic.List[object]]$Found,
    [string]$Category,
    [string]$Path,
    [string]$Reason
  )

  $Found.Add((New-EvidenceItem -Category $Category -Path $Path -Reason $Reason)) | Out-Null
}

function Get-ExistingVemState {
  $found = [System.Collections.Generic.List[object]]::new()
  $maintenanceTargets = Get-FactoryMaintenanceResetTargets
  $paths = @(
    "C:\VEM\bringup",
    "C:\ProgramData\VEM\bringup",
    "C:\ProgramData\VEM\provisioning",
    "C:\ProgramData\VEM\secrets",
    "C:\ProgramData\VEM\vending-daemon",
    "C:\ProgramData\VEM\evidence",
    "C:\ProgramData\VEM\overrides"
  )
  foreach ($path in $paths) {
    if (-not (Test-Path -LiteralPath $path)) {
      continue
    }
    $category = switch ($path) {
      "C:\VEM\bringup" { "runtime_installation" }
      "C:\ProgramData\VEM\bringup" { "local_bring_up_settings" }
      "C:\ProgramData\VEM\provisioning" { "provisioning_profile_cache" }
      "C:\ProgramData\VEM\secrets" { "protected_secret_material" }
      "C:\ProgramData\VEM\vending-daemon" { "daemon_state" }
      "C:\ProgramData\VEM\evidence" { "prior_evidence" }
      "C:\ProgramData\VEM\overrides" { "local_runtime_overrides" }
      default { "local_runtime_state" }
    }
    Add-FoundState -Found $found -Category $category -Path $path -Reason "old local VEM runtime state exists"
  }
  foreach ($path in @($maintenanceTargets.paths)) {
    if (Test-Path -LiteralPath $path) {
      Add-FoundState -Found $found -Category "maintenance_capability_state" -Path $path -Reason "stale factory maintenance configuration exists"
    }
  }

  $service = Get-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue
  if ($null -ne $service) {
    Add-FoundState -Found $found -Category "daemon_service" -Path "service://VemVendingDaemon" -Reason "old VEM daemon service exists"
  }
  foreach ($serviceName in @($maintenanceTargets.serviceNames)) {
    $maintenanceService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -ne $maintenanceService) {
      Add-FoundState -Found $found -Category "maintenance_tunnel_service" -Path "service://$serviceName" -Reason "stale WireGuard maintenance tunnel service exists"
    }
  }
  foreach ($displayName in @($maintenanceTargets.firewallDisplayNames)) {
    $firewallRule = Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue
    if ($null -ne $firewallRule) {
      Add-FoundState -Found $found -Category "maintenance_firewall" -Path "firewall://$displayName" -Reason "stale Controlled Maintenance SSH firewall rule exists"
    }
  }
  $machineUiTask = Get-ScheduledTask -TaskName "VEMMachineUI" -ErrorAction SilentlyContinue
  if ($null -ne $machineUiTask) {
    Add-FoundState -Found $found -Category "startup_command" -Path "task://VEMMachineUI" -Reason "old VEMMachineUI startup task exists"
  }
  $maintenanceUiTask = Get-ScheduledTask -TaskName "VEMMaintenanceUI" -ErrorAction SilentlyContinue
  if ($null -ne $maintenanceUiTask) {
    Add-FoundState -Found $found -Category "startup_command" -Path "task://VEMMaintenanceUI" -Reason "old VEMMaintenanceUI maintenance task exists"
  }
  $visionTask = Get-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
  if ($null -ne $visionTask) {
    $visionTaskName = "VEM\StartVisionServer"
    Add-FoundState -Found $found -Category "startup_command" -Path ("task://{0}" -f $visionTaskName.Replace("\", "/")) -Reason "old VEM vision startup task exists"
  }

  $evidence = New-EmptyResetEvidence
  $evidence.found = @($found)
  if ($found.Count -gt 0) {
    $evidence.status = "dirty"
  }
  return $evidence
}

function Assert-CleanHostOrReset {
  $state = Get-ExistingVemState
  if (@($state.found).Count -gt 0 -and -not $ResetExistingVemState) {
    $summary = ([pscustomobject]$state | ConvertTo-Json -Depth 30 -Compress)
    throw "old local VEM state exists; rerun with -ResetExistingVemState only after an intentional factory reset. reset evidence: $summary"
  }
  return [pscustomobject]$state
}

function Remove-ExistingVemState {
  param($State)

  if (-not $ResetExistingVemState) {
    return
  }

  $maintenanceTargets = Get-FactoryMaintenanceResetTargets
  $wireGuardExe = Get-WireGuardExePath
  if ($null -ne $wireGuardExe) {
    & $wireGuardExe /uninstalltunnelservice "VEM-Maintenance" | Out-Null
  }
  foreach ($serviceName in @($maintenanceTargets.serviceNames)) {
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    if ($null -ne (Get-Service -Name $serviceName -ErrorAction SilentlyContinue)) {
      sc.exe delete $serviceName | Out-Null
    }
  }
  foreach ($displayName in @($maintenanceTargets.firewallDisplayNames)) {
    Get-NetFirewallRule -DisplayName $displayName -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
  }

  Stop-ScheduledTask -TaskName "VEMMachineUI" -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "VEMMachineUI" -Confirm:$false -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName "VEMMaintenanceUI" -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName "VEMMaintenanceUI" -Confirm:$false -ErrorAction SilentlyContinue
  Stop-Process -Name "machine" -Force -ErrorAction SilentlyContinue
  $visionTask = Get-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
  if ($null -ne $visionTask) {
    Stop-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
    schtasks /Delete /TN "VEM\StartVisionServer" /F *> $null
  }
  Stop-Service -Name "VemVendingDaemon" -Force -ErrorAction SilentlyContinue
  $service = Get-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue
  if ($null -ne $service) {
    sc.exe delete "VemVendingDaemon" | Out-Null
  }
  foreach ($item in @($State.found | Where-Object { [string]$_.path -like "C:\*" })) {
    $path = [string]$item.path
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  }
  $State.status = "reset"
  $State.cleared = @($State.found)
  return $State
}

function Assert-FactoryVisionInputFile {
  param([string]$Path, [string]$Label)

  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -match '[\x00-\x1f]' -or $Path -match '^(\\\\|//)' -or $Path -notmatch '^[A-Za-z]:\\') {
    throw "$Label must be an absolute local Windows path"
  }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Label must be a regular non-reparse file"
  }
  return $item.FullName
}

function Invoke-FactoryVisionRelease {
  param($Plan)

  $provisioningManifest = Assert-FactoryVisionInputFile -Path (Join-Path $FactoryMediaRoot "VEM\VISION-FACTORY-PROVISIONING.JSON") -Label "Factory Vision provisioning manifest"
  $factoryMediaRoot = Split-Path -Parent $provisioningManifest
  $configurationSource = Assert-FactoryVisionInputFile -Path $VisionConfigurationSourcePath -Label "Vision configuration source"
  $provisioner = Join-Path $PSScriptRoot "provision-vision-factory-release.ps1"
  if (-not (Test-Path -LiteralPath $provisioner -PathType Leaf)) { throw "Factory Vision provisioner is missing" }
  & $provisioner -FactoryMediaRoot $factoryMediaRoot

  $configurationPath = [string]$Plan.layout.visionConfigurationPath
  New-Item -ItemType Directory -Path (Split-Path -Parent $configurationPath) -Force | Out-Null
  Copy-Item -LiteralPath $configurationSource -Destination $configurationPath -Force
  $configurationDigest = (Get-FileHash -LiteralPath $configurationPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $installer = "C:\VEM\bringup\install-vision-release.ps1"
  if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Factory Vision installer was not provisioned" }
  & $installer -ConfigurationPath $configurationPath -EvidencePath ([string]$Plan.layout.visionInstallEvidencePath) -TaskUser $ExpectedAutoLogonUser

  $evidence = Read-JsonFile -Path ([string]$Plan.layout.visionInstallEvidencePath)
  if (
    [string]$evidence.schemaVersion -cne "vem-vision-install-evidence/v3" -or
    [string]$evidence.kind -cne "vision-release-install-evidence" -or
    $evidence.redacted -ne $true -or
    $evidence.healthOk -ne $true -or
    $evidence.webSocketOk -ne $true -or
    [string]::IsNullOrWhiteSpace([string]$evidence.installedDigest) -or
    [string]$evidence.installedDigest -cne [string]$evidence.bundleDigest -or
    -not [string]::IsNullOrWhiteSpace([string]$evidence.failure)
  ) {
    throw "Factory Vision installation evidence is incomplete or failed"
  }
  return [ordered]@{
    installedDigest = [string]$evidence.installedDigest
    descriptorDigest = [string]$evidence.descriptorDigest
    approvalDigest = [string]$evidence.approvalDigest
    configurationSha256 = $configurationDigest
    evidencePath = [string]$Plan.layout.visionInstallEvidencePath
    healthOk = $true
    webSocketOk = $true
    redacted = $true
  }
}

function Write-FactoryRuntimeFiles {
  param(
    $Plan,
    $Preflight
  )

  Assert-Sha256 -Path $DaemonArtifactPath -ExpectedSha256 $Preflight.DaemonSha256 | Out-Null
  Assert-Sha256 -Path $MachineUiArtifactPath -ExpectedSha256 $Preflight.MachineUiSha256 | Out-Null
  $machineUiSidecarPath = Join-Path (Split-Path -Parent $MachineUiArtifactPath) "WebView2Loader.dll"
  if (-not (Test-Path -LiteralPath $machineUiSidecarPath -PathType Leaf)) {
    throw "required machine UI sidecar missing next to machine.exe: $machineUiSidecarPath"
  }

  foreach ($directory in @($Plan.directories)) {
    Ensure-Directory -Path $directory
  }
  Mark-FactoryPersonalizationConsumed -Preflight $Preflight

  $baselineApplication = Apply-FactoryWindowsBaseline -Policy $Plan.factoryWindowsBaselinePolicy

  $openSshInstallation = Install-PinnedWindowsPackage -Package $Preflight.OpenSshPackage
  $wireGuardInstallation = Install-PinnedWindowsPackage -Package $Preflight.WireGuardPackage
  Set-FactoryMaintenanceAccountPassword -User $ExpectedMaintenanceUser -Password $Preflight.MaintenancePassword

  Copy-Item -LiteralPath $DaemonArtifactPath -Destination (Join-Path $RuntimeRoot "vending-daemon.exe") -Force
  Copy-Item -LiteralPath $MachineUiArtifactPath -Destination (Join-Path $RuntimeRoot "machine.exe") -Force
  Copy-Item -LiteralPath $machineUiSidecarPath -Destination (Join-Path $RuntimeRoot "WebView2Loader.dll") -Force
  Copy-Item -LiteralPath $MaintenanceSshCaPublicKeyPath -Destination ([string]$Plan.layout.maintenanceCaPath) -Force
  icacls.exe ([string]$Plan.layout.maintenanceCaPath) /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" | Out-Null

  $scriptsRoot = [string]$Plan.layout.scriptsRoot
  Copy-ScriptIfPresent -Name "setup-scheduled-tasks.ps1" -TargetDirectory $scriptsRoot
  Copy-ScriptIfPresent -Name "verify-factory-runtime.ps1" -TargetDirectory $scriptsRoot
  Copy-ScriptIfPresent -Name "verify-kiosk-lockdown.ps1" -TargetDirectory $scriptsRoot
  Copy-ScriptIfPresent -Name "verify-vem-runtime.ps1" -TargetDirectory $scriptsRoot
  Copy-ScriptIfPresent -Name "apply-managed-update.ps1" -TargetDirectory $scriptsRoot
  Copy-ScriptIfPresent -Name "provision-vision-factory-release.ps1" -TargetDirectory $scriptsRoot
  Copy-ScriptIfPresent -Name "install-vision-release.ps1" -TargetDirectory $scriptsRoot

  $machineUiStartupMode = if (Test-ShellLauncherAvailable) { "shell_launcher" } else { "scheduled_task" }
  $manifest = [ordered]@{
    schemaVersion = "vem-factory-runtime-manifest/v1"
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    layoutVersion = $TargetLayoutVersion
    environmentName = $EnvironmentName
    provisioningEndpoint = $ProvisioningEndpoint
    factoryProfile = $Preflight.FactoryProfile
    personalization = $Preflight.PersonalizationRedaction
    packages = $Plan.inputs.packages
    packageInstallation = [ordered]@{
      openSsh = $openSshInstallation
      wireGuard = $wireGuardInstallation
    }
    signatureEvidence = [ordered]@{
      openSsh = $Preflight.OpenSshPackage.signatureEvidence
      wireGuard = $Preflight.WireGuardPackage.signatureEvidence
    }
    maintenanceSsh = [ordered]@{
      caProfile = [string]$Preflight.MaintenanceCa.profile
      caSha256 = [string]$Preflight.MaintenanceCa.sha256
      caFingerprint = [string]$Preflight.MaintenanceCa.fingerprint
      caPath = [string]$Plan.layout.maintenanceCaPath
      maintenanceUser = $ExpectedMaintenanceUser
      kioskUser = $ExpectedKioskUser
      runnerSourceAllowlist = @($Preflight.RunnerSourceAllowlist)
      maintainerSourceAllowlist = @($Preflight.MaintainerSourceAllowlist)
      wireGuardInterfaceAlias = [string]$Preflight.WireGuardInterfaceAlias
      wireGuardListenAddress = [string]$Preflight.WireGuardListenAddress
      ingressMode = [string]$Preflight.MaintenanceIngress.mode
      effectiveListenAddress = [string]$Preflight.MaintenanceIngress.effectiveListenAddress
      effectiveFirewallInterfaceScope = [string]$Preflight.MaintenanceIngress.effectiveFirewallInterfaceScope
    }
    wireGuard = [ordered]@{
      serviceName = Get-WireGuardTunnelServiceName
      configPath = [string]$Plan.layout.wireGuardConfigPath
      owner = "LocalSystem"
      startupType = "Automatic"
      privateKeySource = "generated_locally"
    }
    factoryWindowsBaselinePolicy = $Plan.factoryWindowsBaselinePolicy
    factoryWindowsBaselineApplication = $baselineApplication
    hardware = [ordered]@{
      mode = $HardwareMode
      model = $HardwareModel
    }
    topology = [ordered]@{
      identity = $TopologyIdentity
      version = $TopologyVersion
    }
    display = $Plan.inputs.display
    expectations = [ordered]@{
      kioskUser = $ExpectedKioskUser
      maintenanceUser = $ExpectedMaintenanceUser
      autoLogonUser = $ExpectedAutoLogonUser
      kioskShell = $ExpectedKioskShell
      machineUiStartupMode = $machineUiStartupMode
      machineUiTask = [ordered]@{
        name = "VEMMachineUI"
        command = "C:\Windows\System32\wscript.exe"
        argumentsContain = Join-Path $RuntimeRoot "launch-machine-ui.vbs"
        workingDirectory = $RuntimeRoot
      }
      daemonService = [ordered]@{
        name = "VemVendingDaemon"
        binaryPathContains = @(
          (Join-Path $RuntimeRoot "vending-daemon.exe"),
          "--data-dir",
          "C:\ProgramData\VEM\vending-daemon",
          "--print-ready-file",
          "C:\ProgramData\VEM\vending-daemon\daemon-ready.json"
        )
      }
      debugCdpExcluded = $true
      maintenanceRecovery = [ordered]@{
        launcherPath = (Join-Path $RuntimeRoot "launch-machine-ui-debug.vbs")
        setupScript = (Join-Path $scriptsRoot "setup-scheduled-tasks.ps1")
      }
    }
    components = $Plan.inputs.components
    paths = $Plan.layout
  }
  $daemonManifest = [ordered]@{
    layoutVersion = 1
    environment = $EnvironmentName
    provisioningEndpoint = $ProvisioningEndpoint
    hardwareMode = $HardwareMode
    hardwareModel = $HardwareModel
    hardwareSlotTopology = [ordered]@{
      identity = $TopologyIdentity
      version = $TopologyVersion
    }
  }
  Write-JsonFile -Path ([string]$Plan.layout.daemonFactoryManifestPath) -Value ([pscustomobject]$daemonManifest)

  $bringupSettings = [ordered]@{
    schemaVersion = "vem-local-bringup-settings/v1"
    environmentName = $EnvironmentName
    provisioningEndpoint = $ProvisioningEndpoint
    hardwareMode = $HardwareMode
    hardwareModel = $HardwareModel
    topologyIdentity = $TopologyIdentity
    topologyVersion = $TopologyVersion
    layoutVersion = $TargetLayoutVersion
  }
  Write-JsonFile -Path ([string]$Plan.layout.bringupSettingsPath) -Value ([pscustomobject]$bringupSettings)

  $daemonBringupSettings = [ordered]@{
    provisioningEndpointOverride = $ProvisioningEndpoint
  }
  Write-JsonFile -Path ([string]$Plan.layout.daemonBringupSettingsPath) -Value ([pscustomobject]$daemonBringupSettings)

  $daemonConfig = [ordered]@{
    machineCode = $null
    apiBaseUrl = $ProvisioningEndpoint
    mqttUrl = $MqttUrl
    mqttUsername = $null
    hardwareAdapter = if ($HardwareMode -eq "simulated") { "mock" } else { "serial" }
    serialPortPath = $null
    lowerControllerUsbIdentity = $null
    scannerAdapter = "disabled"
    scannerSerialPortPath = $null
    scannerUsbIdentity = $null
    scannerBaudRate = 9600
    scannerFrameSuffix = "crlf"
    visionEnabled = $false
    visionWsUrl = "ws://127.0.0.1:7892/ws"
    visionRequestTimeoutMs = 8000
    kioskMode = $true
    stockMovementRetentionDays = 30
  }
  Write-JsonFile -Path ([string]$Plan.layout.daemonConfigPath) -Value ([pscustomobject]$daemonConfig)

  $wireGuardApplication = Ensure-LocalWireGuardTunnelService -Plan $Plan

  $setupArguments = @{
    ConfigureKioskAccounts = $true
    ConfigureAutoLogon = $true
    KioskPassword = $Preflight.KioskPassword
    AutoLogonPassword = $Preflight.AutoLogonPassword
    KioskUser = $ExpectedKioskUser
    MaintenanceUser = $ExpectedMaintenanceUser
    ConfigureControlledMaintenanceIngress = $true
    MaintenanceSshCaPublicKeyPath = [string]$Plan.layout.maintenanceCaPath
    FactoryProfile = [string]$Preflight.FactoryProfile
    MaintenanceRunnerSourceAllowlist = @($Preflight.RunnerSourceAllowlist)
    MaintenanceMaintainerSourceAllowlist = @($Preflight.MaintainerSourceAllowlist)
    MaintenanceWireGuardInterfaceAlias = [string]$Preflight.WireGuardInterfaceAlias
    MaintenanceWireGuardListenAddress = [string]$Preflight.WireGuardListenAddress
    RunAsUser = $ExpectedAutoLogonUser
    MachineUiExe = Join-Path $RuntimeRoot "machine.exe"
    DaemonExe = Join-Path $RuntimeRoot "vending-daemon.exe"
    ConfigureKioskShell = $true
    UseKioskAccount = $true
  }
  New-Service -Name "VemVendingDaemon" -BinaryPathName (Join-Path $RuntimeRoot "vending-daemon.exe") -StartupType Automatic -DisplayName "VEM Vending Daemon" -ErrorAction SilentlyContinue | Out-Null
  Invoke-NamedPowerShellScript -ScriptPath (Join-Path $scriptsRoot "setup-scheduled-tasks.ps1") -Arguments $setupArguments
  $visionInstallation = if ($FactoryProfile -eq "production") {
    Invoke-FactoryVisionRelease -Plan $Plan
  } else {
    [ordered]@{ status = "not-applicable-testbed"; redacted = $true }
  }
  $manifest["visionRelease"] = $visionInstallation
  Write-JsonFile -Path ([string]$Plan.layout.manifestPath) -Value ([pscustomobject]$manifest)

  return [ordered]@{
    wireGuardApplication = $wireGuardApplication
    packageInstallation = [ordered]@{ openSsh = $openSshInstallation; wireGuard = $wireGuardInstallation }
    visionInstallation = $visionInstallation
  }
}

try {
  Assert-RequiredInputs
  $preflight = Assert-FactoryRuntimePreflight
  if (-not $DryRun) {
    Assert-FactoryPersonalizationNotReused -Preflight $preflight
  }
  $plan = New-FactoryRuntimePlan -Preflight $preflight

  if ($DryRun) {
    $plan | ConvertTo-Json -Depth 30
    exit 0
  }

  $existingState = Assert-CleanHostOrReset
  $resetEvidence = Remove-ExistingVemState -State $existingState
  if ($null -eq $resetEvidence) {
    $resetEvidence = $existingState
  }
  $writeResult = Write-FactoryRuntimeFiles -Plan $plan -Preflight $preflight

  $result = [ordered]@{
    ok = $true
    preparedAt = (Get-Date).ToUniversalTime().ToString("o")
    manifestPath = $plan.layout.manifestPath
    bringupSettingsPath = $plan.layout.bringupSettingsPath
    resetExistingVemState = [bool]$ResetExistingVemState
    resetEvidence = $resetEvidence
    personalization = $preflight.PersonalizationRedaction
    wireGuard = $writeResult.wireGuardApplication
    packageInstallation = $writeResult.packageInstallation
    visionInstallation = $writeResult.visionInstallation
  }
  $result | ConvertTo-Json -Depth 30
} finally {
  if (-not $DryRun -and -not [string]::IsNullOrWhiteSpace($PersonalizationMediaPath)) {
    Remove-Item -LiteralPath $PersonalizationMediaPath -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $PersonalizationMediaPath) {
      throw "Factory Personalization Media staging cleanup failed"
    }
  }
}
