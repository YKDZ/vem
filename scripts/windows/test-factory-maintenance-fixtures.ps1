[CmdletBinding()]
param(
  [string]$FixtureRoot = (Join-Path $PSScriptRoot "factory-maintenance-fixtures"),
  [string]$PreparePath = (Join-Path $PSScriptRoot "prepare-factory-runtime.ps1"),
  [string]$SetupPath = (Join-Path $PSScriptRoot "setup-scheduled-tasks.ps1"),
  [string]$VerifierPath = (Join-Path $PSScriptRoot "verify-factory-runtime.ps1")
)

$ErrorActionPreference = "Stop"

function Assert-Fixture {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "fixture assertion failed: $Message" }
}

function Assert-ThrowsLike {
  param([scriptblock]$Action, [string]$Pattern, [string]$Message)
  try {
    & $Action
  } catch {
    if ([string]$_ -match $Pattern) { return }
    throw "fixture assertion failed: $Message; unexpected error: $_"
  }
  throw "fixture assertion failed: $Message; action did not throw"
}

function Import-ScriptFunctions {
  param([string]$Path)

  $tokens = $null
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($Path, [ref]$tokens, [ref]$errors)
  Assert-Fixture (@($errors).Count -eq 0) "$Path must parse"
  foreach ($functionAst in $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
    Invoke-Expression ("function global:{0} {1}" -f $functionAst.Name, $functionAst.Body.Extent.Text)
  }
}

Import-ScriptFunctions -Path $PreparePath
Import-ScriptFunctions -Path $SetupPath
Import-ScriptFunctions -Path $VerifierPath

# The real call operator must bind every value by parameter name, including arrays
# and switches. Positional array splatting fails this probe.
$binderTarget = Join-Path ([System.IO.Path]::GetTempPath()) ("vem-binder-" + [guid]::NewGuid().ToString("N") + ".ps1")
try {
  @'
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Profile,
  [Parameter(Mandatory = $true)][string[]]$Sources,
  [switch]$Enabled
)
[pscustomobject]@{ profile = $Profile; sources = @($Sources); enabled = [bool]$Enabled } | ConvertTo-Json -Compress
'@ | Set-Content -LiteralPath $binderTarget -Encoding UTF8
  $bound = Invoke-NamedPowerShellScript -ScriptPath $binderTarget -Arguments @{
    Profile = "production"
    Sources = @("10.77.0.2", "10.77.0.3")
    Enabled = $true
  } | ConvertFrom-Json
  Assert-Fixture ($bound.profile -ceq "production") "named binder must preserve the profile"
  Assert-Fixture (@($bound.sources).Count -eq 2) "named binder must preserve array values"
  Assert-Fixture ([bool]$bound.enabled) "named binder must bind switches"
} finally {
  Remove-Item -LiteralPath $binderTarget -Force -ErrorAction SilentlyContinue
}

# Execute the real tunnel-service function with Windows cmdlets shimmed. Every SCM
# operation must use WireGuard's exact service contract, including the literal '$'.
$script:scmNames = [System.Collections.Generic.List[string]]::new()
function Get-WireGuardExePath { return "C:\Program Files\WireGuard\wireguard.exe" }
function Get-WgExePath { return "C:\Program Files\WireGuard\wg.exe" }
function Ensure-Directory { param([string]$Path) }
function Test-Path { param([string]$LiteralPath, [switch]$PathType) return $true }
function Get-Service {
  param([string]$Name, $ErrorAction)
  $script:scmNames.Add($Name) | Out-Null
  return [pscustomobject]@{ Name = $Name; Status = "Running"; StartType = "Automatic" }
}
function Set-Service {
  param([string]$Name, [string]$StartupType)
  $script:scmNames.Add($Name) | Out-Null
}
function Start-Service {
  param([string]$Name, $ErrorAction)
  $script:scmNames.Add($Name) | Out-Null
}
function Get-CimInstance {
  param([string]$ClassName, [string]$Filter, $ErrorAction)
  return [pscustomobject]@{ StartMode = "Auto"; StartName = "LocalSystem" }
}
$wireGuardResult = Ensure-LocalWireGuardTunnelService -Plan ([pscustomobject]@{
    layout = [pscustomobject]@{ wireGuardRoot = "C:\VEM\maintenance"; wireGuardConfigPath = "C:\VEM\maintenance\VEM-Maintenance.conf" }
    inputs = [pscustomobject]@{ wireGuardInterfaceAlias = "VEM-Maintenance" }
  })
$expectedServiceName = 'WireGuardTunnel$VEM-Maintenance'
Assert-Fixture ($wireGuardResult.serviceName -ceq $expectedServiceName) "WireGuard evidence must use the exact SCM service name"
Assert-Fixture (@($script:scmNames).Count -ge 3) "SCM probe must observe service operations"
Assert-Fixture (@($script:scmNames | Where-Object { $_ -cne $expectedServiceName }).Count -eq 0) "all SCM operations must use the exact WireGuard tunnel service name"
foreach ($shim in @("Get-WireGuardExePath", "Get-WgExePath", "Ensure-Directory", "Test-Path", "Get-Service", "Set-Service", "Start-Service", "Get-CimInstance")) {
  Remove-Item -LiteralPath "Function:global:$shim" -Force -ErrorAction SilentlyContinue
}

# Managed sshd policy is canonical global configuration. It must reject an
# earlier enabled security directive instead of relying on last-value behavior.
$sshdConfig = Join-Path ([System.IO.Path]::GetTempPath()) ("vem-sshd-" + [guid]::NewGuid().ToString("N"))
try {
  @(
    "PasswordAuthentication yes",
    "Subsystem sftp internal-sftp"
  ) | Set-Content -LiteralPath $sshdConfig -Encoding ASCII
  Assert-ThrowsLike -Action {
    Ensure-SshdConfigDenyKioskUser `
      -ConfigPath $sshdConfig `
      -KioskUser "VEMKiosk" `
      -MaintenanceUser "Admin" `
      -CaPath "C:\ProgramData\VEM\factory\maintenance-ca.pub" `
      -ListenAddress "10.77.0.10"
  } -Pattern "conflicting earlier sshd directive" -Message "conflicting earlier sshd policy must be rejected"

  @(
    "# stock OpenSSH config",
    "AuthorizedKeysFile .ssh/authorized_keys",
    "Subsystem sftp internal-sftp",
    "Match Group administrators",
    "       AuthorizedKeysFile __PROGRAMDATA__/ssh/administrators_authorized_keys"
  ) | Set-Content -LiteralPath $sshdConfig -Encoding ASCII
  Ensure-SshdConfigDenyKioskUser `
    -ConfigPath $sshdConfig `
    -KioskUser "VEMKiosk" `
    -MaintenanceUser "Admin" `
    -CaPath "C:\ProgramData\VEM\factory\maintenance-ca.pub" `
    -ListenAddress "10.77.0.10"
  $managedSshd = Get-Content -LiteralPath $sshdConfig
  $enabledSshd = @($managedSshd | Where-Object { $_ -match "^\s*[^#\s]" })
  Assert-Fixture ($enabledSshd[0] -ceq "ListenAddress 10.77.0.10") "ListenAddress must be the first effective managed directive"
  Assert-Fixture (@($enabledSshd | Where-Object { $_ -ceq "AuthorizedKeysFile none" }).Count -eq 1) "all raw authorized-key files must be disabled"
  Assert-Fixture (@($enabledSshd | Where-Object { $_ -ceq "AllowUsers admin" }).Count -eq 1) "AllowUsers must use lowercase Windows account matching"
  Assert-Fixture (@($enabledSshd | Where-Object { $_ -match "(?i)^Match\s" }).Count -eq 0) "terminal Match blocks must not survive canonical rewrite"
  Assert-Fixture (@($enabledSshd | Where-Object { $_ -match "administrators_authorized_keys" }).Count -eq 0) "administrators_authorized_keys must be disabled"
  foreach ($expectedDirective in @(
      "TrustedUserCAKeys C:\ProgramData\VEM\factory\maintenance-ca.pub",
      "PubkeyAuthentication yes",
      "PasswordAuthentication no",
      "KbdInteractiveAuthentication no",
      "AuthenticationMethods publickey",
      "PermitEmptyPasswords no",
      "DenyUsers vemkiosk"
    )) {
    Assert-Fixture (@($enabledSshd | Where-Object { $_ -ceq $expectedDirective }).Count -eq 1) "missing canonical sshd directive: $expectedDirective"
  }

  $localSshd = Get-Command "sshd" -ErrorAction SilentlyContinue
  if ($null -ne $localSshd) {
    $effective = Test-SshdConfiguration `
      -SshdExePath $localSshd.Source `
      -ConfigPath $sshdConfig `
      -MaintenanceUser "admin" `
      -SourceAddress "10.77.0.2"
    Assert-Fixture ($effective.syntaxValid) "real sshd -t must accept the canonical config"
    Assert-Fixture ($effective.listenAddress -ceq "10.77.0.10:22") "real sshd -T must report only the tunnel listener"
    Assert-Fixture ($effective.authorizedKeysFile -ceq "none") "real sshd -T must disable raw authorized keys"
    Assert-Fixture ($effective.passwordAuthentication -ceq "no") "real sshd -T must disable passwords"
    Assert-Fixture ($effective.kbdInteractiveAuthentication -ceq "no") "real sshd -T must disable keyboard-interactive auth"
    Assert-Fixture ($effective.authenticationMethods -ceq "publickey") "real sshd -T must require publickey authentication"
  }
} finally {
  Remove-Item -LiteralPath $sshdConfig -Force -ErrorAction SilentlyContinue
}

# Package trust is measured from Authenticode and the certificate chain. No JSON
# status supplied by the caller participates in acceptance.
Import-ScriptFunctions -Path $PreparePath
$packagePath = Join-Path ([System.IO.Path]::GetTempPath()) ("VEM package with spaces " + [guid]::NewGuid().ToString("N") + ".msi")
try {
  [System.IO.File]::WriteAllBytes($packagePath, [byte[]](1, 2, 3, 4))
  $packageHash = (Get-FileHash -LiteralPath $packagePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $signerThumbprint = "1111111111111111111111111111111111111111"
  $rootThumbprint = "2222222222222222222222222222222222222222"
  function Get-AuthenticodeSignature {
    param([string]$FilePath, [string]$LiteralPath)
    return [pscustomobject]@{
      Status = "Valid"
      StatusMessage = "Signature verified by executable fixture"
      SignerCertificate = [pscustomobject]@{
        Thumbprint = $signerThumbprint
        Subject = "CN=Approved VEM Package Signer"
        Issuer = "CN=Approved VEM Factory Root"
      }
    }
  }
  function Get-CertificateChainEvidence {
    param($Certificate)
    return [ordered]@{
      valid = $true
      statuses = @()
      thumbprints = @($signerThumbprint, $rootThumbprint)
      rootThumbprint = $rootThumbprint
    }
  }

  $trustedPackage = Assert-PinnedLocalPackage `
    -Name "OpenSSH" `
    -Path $packagePath `
    -Source "factory-cas://sha256/$packageHash" `
    -Version "9.8.1" `
    -ExpectedSha256 $packageHash `
    -ApprovedSignerThumbprint $signerThumbprint `
    -ApprovedRootThumbprint $rootThumbprint
  Assert-Fixture ($trustedPackage.signatureEvidence.status -ceq "Valid") "Authenticode status must be measured"
  Assert-Fixture ($trustedPackage.signatureEvidence.signerThumbprint -ceq $signerThumbprint) "approved signer thumbprint must bind the package"
  Assert-Fixture ($trustedPackage.signatureEvidence.rootThumbprint -ceq $rootThumbprint) "approved root thumbprint must bind the chain"
  Assert-Fixture ($trustedPackage.source -ceq "factory-cas://sha256/$packageHash") "CAS identity must bind the measured artifact hash"

  Assert-ThrowsLike -Action {
    Assert-PinnedLocalPackage `
      -Name "OpenSSH" `
      -Path $packagePath `
      -Source ("factory-cas://sha256/" + ("0" * 64)) `
      -Version "9.8.1" `
      -ExpectedSha256 $packageHash `
      -ApprovedSignerThumbprint $signerThumbprint `
      -ApprovedRootThumbprint $rootThumbprint
  } -Pattern "content-addressed source does not match" -Message "CAS source must reject a different artifact hash"
} finally {
  Remove-Item -LiteralPath $packagePath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "Function:global:Get-AuthenticodeSignature" -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath "Function:global:Get-CertificateChainEvidence" -Force -ErrorAction SilentlyContinue
}

# The Maintenance SSH CA is one public key. Its environment profile comes from
# the key comment and its fingerprint comes from ssh-keygen, never caller claims.
$caRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vem-ca-" + [guid]::NewGuid().ToString("N"))
$caPrivatePath = Join-Path $caRoot "maintenance-ca"
$caPublicPath = "$caPrivatePath.pub"
try {
  New-Item -ItemType Directory -Path $caRoot -Force | Out-Null
  & ssh-keygen -q -t ed25519 -N "" -C "vem-maintenance-ca:testbed" -f $caPrivatePath
  Assert-Fixture ($LASTEXITCODE -eq 0) "fixture CA key generation must succeed"
  $script:FactoryProfile = "testbed"
  $script:MaintenanceSshCaPublicKeyPath = $caPublicPath
  $script:MaintenanceSshCaPublicKeySha256 = (Get-FileHash -LiteralPath $caPublicPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $caEvidence = Assert-MaintenanceCaInput
  Assert-Fixture ($caEvidence.profile -ceq "testbed") "CA profile must be derived from the key comment"
  Assert-Fixture ($caEvidence.fingerprint -match "^SHA256:[A-Za-z0-9+/]+$") "CA fingerprint must be measured by ssh-keygen"
  Assert-Fixture ($caEvidence.keyCount -eq 1) "CA file must contain exactly one public key"

  Add-Content -LiteralPath $caPublicPath -Value (Get-Content -LiteralPath $caPublicPath -Raw)
  $script:MaintenanceSshCaPublicKeySha256 = (Get-FileHash -LiteralPath $caPublicPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Assert-ThrowsLike -Action { Assert-MaintenanceCaInput } -Pattern "exactly one" -Message "CA file must reject multiple public keys"
} finally {
  Remove-Item -LiteralPath $caRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Import-ScriptFunctions -Path $SetupPath
function Get-LocalUser {
  param([string]$Name, $ErrorAction)
  return $null
}
Assert-ThrowsLike -Action {
  Assert-ExistingMaintenanceAdministrator -User "Admin"
} -Pattern "must already exist" -Message "factory setup must never create the profile maintenance administrator"
Remove-Item -LiteralPath "Function:global:Get-LocalUser" -Force -ErrorAction SilentlyContinue

# Nested local groups are effective token membership and must not hide kiosk
# administrator, SSH, RDP, or WinRM access.
function Get-LocalGroupMember {
  param([string]$Group, $ErrorAction)
  if ($Group -ceq "Administrators") {
    return @([pscustomobject]@{ Name = "$env:COMPUTERNAME\NestedOperators"; ObjectClass = "Group" })
  }
  if ($Group -ceq "NestedOperators") {
    return @([pscustomobject]@{ Name = "$env:COMPUTERNAME\VEMKiosk"; ObjectClass = "User" })
  }
  return @()
}
Assert-Fixture (Test-LocalUserInGroup -User "VEMKiosk" -Group "Administrators") "nested administrator membership must be detected"
Remove-Item -LiteralPath "Function:global:Get-LocalGroupMember" -Force -ErrorAction SilentlyContinue

Import-ScriptFunctions -Path $SetupPath
$script:removedFirewallRules = [System.Collections.Generic.List[string]]::new()
$script:createdFirewallRule = $null
$existingFirewallRules = @(
  [pscustomobject]@{ Name = "stock-ssh"; DisplayName = "OpenSSH SSH Server"; Direction = "Inbound"; Enabled = "True"; Action = "Allow" },
  [pscustomobject]@{ Name = "unrelated-name"; DisplayName = "Corporate Support"; Direction = "Inbound"; Enabled = "True"; Action = "Allow" },
  [pscustomobject]@{ Name = "web"; DisplayName = "Web"; Direction = "Inbound"; Enabled = "True"; Action = "Allow" }
)
function Get-NetFirewallRule {
  param([string]$DisplayName, $ErrorAction)
  if ([string]::IsNullOrWhiteSpace($DisplayName)) { return $existingFirewallRules }
  return @($existingFirewallRules | Where-Object { $_.DisplayName -ceq $DisplayName })
}
function Get-NetFirewallPortFilter {
  param($AssociatedNetFirewallRule, $ErrorAction)
  if ($AssociatedNetFirewallRule.Name -eq "web") {
    return [pscustomobject]@{ Protocol = "TCP"; LocalPort = "80" }
  }
  return [pscustomobject]@{ Protocol = "TCP"; LocalPort = "22" }
}
function Remove-NetFirewallRule {
  param([Parameter(ValueFromPipeline = $true)]$InputObject)
  process { if ($null -ne $InputObject) { $script:removedFirewallRules.Add([string]$InputObject.Name) | Out-Null } }
}
function Disable-NetFirewallRule {
  param([Parameter(ValueFromPipeline = $true)]$InputObject)
  process { }
}
function New-NetFirewallRule {
  param(
    [string]$DisplayName,
    [string]$Direction,
    [string]$Action,
    [string]$Protocol,
    [string]$LocalPort,
    [string[]]$RemoteAddress,
    [string]$InterfaceAlias,
    [string]$Profile,
    [string]$Description
  )
  $script:createdFirewallRule = [pscustomobject]$PSBoundParameters
}
Ensure-ControlledMaintenanceIngressFirewall -SourceAllowlist @("10.77.0.2", "10.77.0.3") -InterfaceAlias "VEM-Maintenance"
Assert-Fixture ($script:removedFirewallRules.Contains("stock-ssh")) "stock OpenSSH TCP/22 rule must be removed"
Assert-Fixture ($script:removedFirewallRules.Contains("unrelated-name")) "every enabled inbound TCP/22 rule must be removed regardless of name"
Assert-Fixture (-not $script:removedFirewallRules.Contains("web")) "non-SSH inbound rules must remain"
Assert-Fixture ($script:createdFirewallRule.InterfaceAlias -ceq "VEM-Maintenance") "replacement firewall rule must bind the WireGuard interface"
Assert-Fixture ($script:createdFirewallRule.LocalPort -ceq "22") "replacement firewall rule must allow only TCP/22"
foreach ($shim in @("Get-NetFirewallRule", "Get-NetFirewallPortFilter", "Remove-NetFirewallRule", "Disable-NetFirewallRule", "New-NetFirewallRule")) {
  Remove-Item -LiteralPath "Function:global:$shim" -Force -ErrorAction SilentlyContinue
}

Import-ScriptFunctions -Path $VerifierPath
$managedRule = [pscustomobject]@{ Name = "managed"; DisplayName = "VEM Controlled Maintenance SSH"; Direction = "Inbound"; Enabled = "True"; Action = "Allow" }
$rogueRule = [pscustomobject]@{ Name = "rogue"; DisplayName = "Emergency Access"; Direction = "Inbound"; Enabled = "True"; Action = "Allow" }
function Get-NetFirewallRule {
  param([string]$DisplayName, $ErrorAction)
  return @($managedRule, $rogueRule)
}
function Get-NetFirewallPortFilter {
  param($AssociatedNetFirewallRule, $ErrorAction)
  return [pscustomobject]@{ Protocol = "TCP"; LocalPort = "22" }
}
function Get-NetFirewallAddressFilter {
  param($AssociatedNetFirewallRule, $ErrorAction)
  return [pscustomobject]@{ RemoteAddress = @("10.77.0.2", "10.77.0.3") }
}
function Get-NetFirewallInterfaceFilter {
  param($AssociatedNetFirewallRule, $ErrorAction)
  return [pscustomobject]@{ InterfaceAlias = "VEM-Maintenance" }
}
function Get-NetTCPConnection {
  param([int]$LocalPort, [string]$State, $ErrorAction)
  return @(
    [pscustomobject]@{ LocalAddress = "10.77.0.10"; LocalPort = 22; OwningProcess = 100 },
    [pscustomobject]@{ LocalAddress = "0.0.0.0"; LocalPort = 22; OwningProcess = 100 }
  )
}
$firewallEvidence = Get-MaintenanceFirewallEvidence -Manifest ([pscustomobject]@{
    maintenanceSsh = [pscustomobject]@{
      runnerSourceAllowlist = @("10.77.0.2")
      maintainerSourceAllowlist = @("10.77.0.3")
      wireGuardInterfaceAlias = "VEM-Maintenance"
      wireGuardListenAddress = "10.77.0.10"
    }
  })
Assert-Fixture (@($firewallEvidence.enabledInboundTcp22Rules).Count -eq 2) "verifier must enumerate every enabled inbound TCP/22 rule"
Assert-Fixture (@($firewallEvidence.unexpectedEnabledInboundTcp22Rules).Count -eq 1) "verifier must reject arbitrarily named extra TCP/22 rules"
Assert-Fixture (@($firewallEvidence.listeners).Count -eq 2) "verifier must enumerate every TCP/22 listener"
Assert-Fixture (@($firewallEvidence.unexpectedListeners).Count -eq 1) "verifier must reject wildcard or non-tunnel listeners"
foreach ($shim in @("Get-NetFirewallRule", "Get-NetFirewallPortFilter", "Get-NetFirewallAddressFilter", "Get-NetFirewallInterfaceFilter", "Get-NetTCPConnection")) {
  Remove-Item -LiteralPath "Function:global:$shim" -Force -ErrorAction SilentlyContinue
}

Import-ScriptFunctions -Path $PreparePath
$script:installerCalls = [System.Collections.Generic.List[object]]::new()
function Test-Path {
  param([string]$LiteralPath, $PathType)
  return $LiteralPath -ceq "C:\Program Files\OpenSSH\sshd.exe"
}
function Get-Item {
  param([string]$LiteralPath, $ErrorAction)
  return [pscustomobject]@{ VersionInfo = [pscustomobject]@{ FileVersion = "9.8.1" } }
}
function Start-Process {
  param([string]$FilePath, [object[]]$ArgumentList, [switch]$PassThru, [switch]$Wait)
  $script:installerCalls.Add([pscustomobject]@{ FilePath = $FilePath; ArgumentList = @($ArgumentList) }) | Out-Null
  return [pscustomobject]@{ ExitCode = 0 }
}
$packageFixture = [pscustomobject]@{
  name = "OpenSSH"
  version = "9.8.1"
  localInstallPath = "C:\Factory Assets\OpenSSH package.msi"
  installedExecutablePaths = @("C:\Program Files\OpenSSH\sshd.exe")
}
$skipResult = Install-PinnedWindowsPackage -Package $packageFixture
Assert-Fixture ($script:installerCalls.Count -eq 0) "matching pinned package version must not be reinstalled"
Assert-Fixture ([bool]$skipResult.skipped) "matching package evidence must report an idempotent skip"

$packageFixture.version = "9.8.2"
$installResult = Install-PinnedWindowsPackage -Package $packageFixture
Assert-Fixture ($script:installerCalls.Count -eq 1) "mismatched pinned package version must be installed"
Assert-Fixture ($script:installerCalls[0].ArgumentList[0] -ceq "/i") "MSI install must use /i"
Assert-Fixture ($script:installerCalls[0].ArgumentList[1] -ceq '"C:\Factory Assets\OpenSSH package.msi"') "MSI path with spaces must be passed as one quoted argument"
Assert-Fixture (-not [bool]$installResult.skipped) "installation evidence must report the executed installer"
foreach ($shim in @("Test-Path", "Get-Item", "Start-Process")) {
  Remove-Item -LiteralPath "Function:global:$shim" -Force -ErrorAction SilentlyContinue
}

$global:ProgramDataRoot = "C:\ProgramData\VEM"
$resetTargets = Get-FactoryMaintenanceResetTargets
Assert-Fixture (@($resetTargets.serviceNames | Where-Object { $_ -ceq 'WireGuardTunnel$VEM-Maintenance' }).Count -eq 1) "reset must remove the exact WireGuard maintenance service"
Assert-Fixture (@($resetTargets.serviceNames | Where-Object { $_ -ceq "WireGuardTunnelVEM-Maintenance" }).Count -eq 1) "reset must remove the stale malformed WireGuard service"
Assert-Fixture (@($resetTargets.paths | Where-Object { $_ -match "maintenance.+VEM-Maintenance\.conf$" }).Count -eq 1) "reset must remove stale maintenance tunnel config"
Assert-Fixture (@($resetTargets.paths | Where-Object { $_ -match "ssh.+sshd_config$" }).Count -eq 1) "reset must remove stale managed sshd config"
Assert-Fixture (@($resetTargets.firewallDisplayNames | Where-Object { $_ -ceq "VEM Controlled Maintenance SSH" }).Count -eq 1) "reset must remove stale maintenance firewall state"

Import-ScriptFunctions -Path $PreparePath
function Get-LocalUser {
  param([string]$Name, $ErrorAction)
  if ($Name -ceq "YKDZ") { return [pscustomobject]@{ Name = "YKDZ"; Enabled = $true } }
  return $null
}
Assert-ThrowsLike -Action {
  Assert-ProductionHostIsolation -DaemonConfigPath "Z:\missing-daemon.json" -WireGuardConfigPath "Z:\missing-wg.conf" -MaintenanceCaPath "Z:\missing-ca.pub"
} -Pattern "YKDZ" -Message "production must reject a live testbed administrator"
Remove-Item -LiteralPath "Function:global:Get-LocalUser" -Force -ErrorAction SilentlyContinue

$contaminationRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("vem-production-contamination-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Path $contaminationRoot -Force | Out-Null
  $daemonContamination = Join-Path $contaminationRoot "machine-config.json"
  $wireGuardContamination = Join-Path $contaminationRoot "VEM-Maintenance.conf"
  $caContamination = Join-Path $contaminationRoot "maintenance-ca.pub"
  '{"machineCode":"VEM-TESTBED-01","hardwareAdapter":"mock","serialPortPath":"tcp://127.0.0.1:17991"}' | Set-Content -LiteralPath $daemonContamination -Encoding UTF8
  "# test-peer simulator shared-password" | Set-Content -LiteralPath $wireGuardContamination -Encoding ASCII
  "ssh-ed25519 AAAA vem-maintenance-ca:testbed" | Set-Content -LiteralPath $caContamination -Encoding ASCII
  Assert-ThrowsLike -Action {
    Assert-ProductionHostIsolation -DaemonConfigPath $daemonContamination -WireGuardConfigPath $wireGuardContamination -MaintenanceCaPath $caContamination
  } -Pattern "production host contamination" -Message "production must reject actual daemon, test peer, and test CA contamination"
} finally {
  Remove-Item -LiteralPath $contaminationRoot -Recurse -Force -ErrorAction SilentlyContinue
}

Import-ScriptFunctions -Path $VerifierPath
$script:systemProbeUnregistered = $false
function New-ScheduledTaskAction { param($Execute, $Argument) return [pscustomobject]@{} }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) return [pscustomobject]@{ UserId = $UserId } }
function New-ScheduledTaskSettingsSet { param($ExecutionTimeLimit) return [pscustomobject]@{} }
function Register-ScheduledTask { param($TaskName, $Action, $Principal, $Settings, [switch]$Force) return [pscustomobject]@{} }
function Get-ScheduledTask { param($TaskName, $ErrorAction) return [pscustomobject]@{ Principal = [pscustomobject]@{ UserId = "SYSTEM" } } }
function Unregister-ScheduledTask { param($TaskName, [switch]$Confirm, $ErrorAction) $script:systemProbeUnregistered = $true }
$elevationEvidence = Measure-AdministratorToSystemCompatibility -MaintenanceUser "Admin" -MaintenanceAdministrator $true
Assert-Fixture ($elevationEvidence.registrationSucceeded) "administrator-to-SYSTEM compatibility must come from a successful SYSTEM task registration probe"
Assert-Fixture ($elevationEvidence.systemPrincipal -ceq "SYSTEM") "SYSTEM compatibility probe must measure the registered principal"
Assert-Fixture ($script:systemProbeUnregistered) "SYSTEM compatibility probe must clean up its task"
foreach ($shim in @("New-ScheduledTaskAction", "New-ScheduledTaskPrincipal", "New-ScheduledTaskSettingsSet", "Register-ScheduledTask", "Get-ScheduledTask", "Unregister-ScheduledTask")) {
  Remove-Item -LiteralPath "Function:global:$shim" -Force -ErrorAction SilentlyContinue
}

Write-Output "factory maintenance executable PowerShell probes passed"
