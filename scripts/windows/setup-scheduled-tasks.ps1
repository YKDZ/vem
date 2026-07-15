# VEM Win10 machine provisioning script
#
# Idempotently configures production machine startup:
#   - VemVendingDaemon Windows service, automatic startup.
#   - Restricted kiosk account and separate maintenance account validation.
#   - Optional local SSH maintenance account isolation.
#   - Optional Controlled Maintenance Ingress for SSH with explicit source allowlist.
#   - VEMMachineUI logon task for non-shell-launcher customer sessions.
#   - Optional OS-level kiosk shell lockdown for the kiosk account.
#   - VEM\StartVisionServer logon task, starts vision in the user session.
#   - launch-machine-ui.vbs, starts the UI visibly with WebView CDP disabled.
#   - launch-machine-ui-debug.vbs, explicit maintenance launcher with WebView CDP.
#   - Optional Winlogon auto-logon.
#
# Typical usage from elevated PowerShell:
#   .\setup-scheduled-tasks.ps1
#
# Configure auto-logon. Prefer setting the password through an operator shell
# environment variable so it is not left in command history:
#   $env:VEM_AUTOLOGON_PASSWORD = "..."
#   .\setup-scheduled-tasks.ps1 -ConfigureAutoLogon
#
# If the local Admin account is intentionally passwordless:
#   .\setup-scheduled-tasks.ps1 -ConfigureAutoLogon -AllowBlankAutoLogonPassword
#
# Bind customer logon helpers to the restricted kiosk account only when that is
# intentional:
#   .\setup-scheduled-tasks.ps1 -UseKioskAccount
#
# Enable the maintenance/debug UI auto-start task only for an active maintenance
# session:
#   .\setup-scheduled-tasks.ps1 -EnableMaintenanceDebugTask
#
# Enable host-level emergency maintenance ingress after validating the dedicated
# Maintenance Account credentials and the authorized source addresses:
#   .\setup-scheduled-tasks.ps1 -ConfigureControlledMaintenanceIngress -MaintenanceIngressSourceAllowlist 10.77.20.2/32
#
# Configure only the local OpenSSH maintenance account isolation without adding
# a device VPN or inbound product firewall rule:
#   .\setup-scheduled-tasks.ps1 -ConfigureLocalMaintenanceAccess

[CmdletBinding()]
param(
  [string]$KioskUser = "VEMKiosk",
  [string]$MaintenanceUser = "Admin",
  [string]$RunAsUser = "Admin",
  [string]$AutoLogonDomain = $env:COMPUTERNAME,
  [string]$KioskPassword = $env:VEM_KIOSK_PASSWORD,

  [string]$BringupDir = "C:\VEM\bringup",
  [string]$DaemonExe = "C:\VEM\bringup\vending-daemon.exe",
  [string]$DaemonDataDir = "C:\ProgramData\VEM\vending-daemon",
  [string]$DaemonReadyFile = "C:\ProgramData\VEM\vending-daemon\daemon-ready.json",
  [string]$StartupBringupEvidenceFile = "C:\ProgramData\VEM\vending-daemon\startup-bringup-evidence.json",
  [string]$MachineUiExe = "C:\VEM\bringup\machine.exe",
  [string]$MachineUiLauncher = "C:\VEM\bringup\launch-machine-ui.vbs",
  [string]$MachineUiDebugLauncher = "C:\VEM\bringup\launch-machine-ui-debug.vbs",
  [string]$MachineUiShortcutName = "VEM Machine UI.lnk",
  [string]$MachineUiDebugShortcutName = "VEM Machine UI Debug.lnk",
  [string]$VisionLauncher = "C:\VEM\bringup\start_vision.bat",
  [string]$VisionWorkingDirectory = "C:\VEM\vision",

  [switch]$ConfigureKioskAccounts,
  [switch]$ConfigureLocalMaintenanceAccess,
  [switch]$ConfigureRemoteMaintenanceAccess,
  [switch]$ConfigureControlledMaintenanceIngress,
  [string[]]$MaintenanceIngressSourceAllowlist,
  [string[]]$MaintenanceRunnerSourceAllowlist,
  [string[]]$MaintenanceMaintainerSourceAllowlist,
  [string]$MaintenanceWireGuardInterfaceAlias = "VEM-Maintenance",
  [string]$MaintenanceWireGuardListenAddress,
  [ValidateSet("production", "testbed")][string]$FactoryProfile = "production",
  [string]$MaintenanceSshCaPublicKeyPath = "C:\ProgramData\VEM\factory\maintenance-ca.pub",
  [switch]$EnableMaintenanceDebugTask,
  [string]$SshdConfigPath = "C:\ProgramData\ssh\sshd_config",
  [switch]$UseKioskAccount,
  [switch]$ConfigureKioskShell,
  [switch]$ConfigureAutoLogon,
  [string]$AutoLogonPassword = $env:VEM_AUTOLOGON_PASSWORD,
  [switch]$AllowBlankAutoLogonPassword,
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this script from an elevated PowerShell session"
  }
}

function Escape-XmlText {
  param([string]$Value)
  return [System.Security.SecurityElement]::Escape($Value)
}

function Ensure-Directory {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Ensure-MachineUiLauncher {
  param(
    [string]$LauncherPath,
    [string]$ExePath,
    [string]$WorkingDirectory,
    [string]$DisplayProbePath
  )

  Ensure-Directory -Path (Split-Path -Parent $LauncherPath)
  $content = @(
    'Set oShell = CreateObject("WScript.Shell")',
    ('oShell.CurrentDirectory = "{0}"' -f $WorkingDirectory),
    ('oShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""{0}""", 0, True' -f $DisplayProbePath),
    ('oShell.Run """{0}""", 1, False' -f $ExePath)
  )
  Set-Content -LiteralPath $LauncherPath -Value $content -Encoding ASCII
}

function Ensure-KioskDisplayProbeScript {
  param([string]$Path)

  Ensure-Directory -Path (Split-Path -Parent $Path)
  $content = @'
$ErrorActionPreference = "Stop"
$outDir = Join-Path $env:LOCALAPPDATA "VEM"
$outPath = Join-Path $outDir "kiosk-display-evidence.json"
try {
  Add-Type -AssemblyName System.Windows.Forms
  $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    [ordered]@{
      deviceName = [string]$_.DeviceName
      primary = [bool]$_.Primary
      widthPx = [int]$_.Bounds.Width
      heightPx = [int]$_.Bounds.Height
    }
  })
  $evidence = [ordered]@{
    schemaVersion = "vem-kiosk-display-evidence/v1"
    collectedAt = (Get-Date).ToUniversalTime().ToString("o")
    source = "kiosk_logon_session"
    user = [string]$env:USERNAME
    sessionName = [string]$env:SESSIONNAME
    screens = $screens
    error = $null
  }
} catch {
  $evidence = [ordered]@{
    schemaVersion = "vem-kiosk-display-evidence/v1"
    collectedAt = (Get-Date).ToUniversalTime().ToString("o")
    source = "kiosk_logon_session"
    user = [string]$env:USERNAME
    sessionName = [string]$env:SESSIONNAME
    screens = @()
    error = [string]$_.Exception.Message
  }
}
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$json = $evidence | ConvertTo-Json -Depth 8
[System.IO.File]::WriteAllText($outPath, $json, [System.Text.UTF8Encoding]::new($false))
'@
  Set-Content -LiteralPath $Path -Value $content -Encoding ASCII
}

function Ensure-MachineUiDebugLauncher {
  param(
    [string]$LauncherPath,
    [string]$ExePath,
    [string]$WorkingDirectory
  )

  Ensure-Directory -Path (Split-Path -Parent $LauncherPath)
  $content = @(
    'Set oShell = CreateObject("WScript.Shell")',
    'Set env = oShell.Environment("PROCESS")',
    'env("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS") = "--remote-debugging-port=9222"',
    ('oShell.CurrentDirectory = "{0}"' -f $WorkingDirectory),
    ('oShell.Run """{0}""", 1, False' -f $ExePath)
  )
  Set-Content -LiteralPath $LauncherPath -Value $content -Encoding ASCII
}

function Ensure-KioskAccount {
  param(
    [string]$User,
    [string]$Password,
    [string]$Description
  )

  $existing = Get-LocalUser -Name $User -ErrorAction SilentlyContinue
  if ($null -eq $existing) {
    if ([string]::IsNullOrEmpty($Password)) {
      throw "Creating local account $User requires password parameter or environment variable"
    }
    $securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
    New-LocalUser -Name $User -Password $securePassword -Description $Description -PasswordNeverExpires | Out-Null
  } else {
    Enable-LocalUser -Name $User
    Set-LocalUser -Name $User -Description $Description -PasswordNeverExpires $true
    if (-not [string]::IsNullOrEmpty($Password)) {
      $securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
      Set-LocalUser -Name $User -Password $securePassword
    }
  }

  Add-LocalGroupMember -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-545") -Member $User -ErrorAction SilentlyContinue
  Remove-LocalGroupMember -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-544") -Member $User -ErrorAction SilentlyContinue
  Remove-LocalGroupMember -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-555") -Member $User -ErrorAction SilentlyContinue
  Remove-LocalGroupMember -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-580") -Member $User -ErrorAction SilentlyContinue
}

function Get-BuiltinLocalGroup {
  param([Parameter(Mandatory = $true)][string]$Sid)

  $group = Get-LocalGroup -SID ([Security.Principal.SecurityIdentifier]::new($Sid)) -ErrorAction Stop
  if ($null -eq $group) { throw "required builtin local group is unavailable: $Sid" }
  return $group
}

function Ensure-LocalGroupExists {
  param([string]$Group)

  if (-not (Get-LocalGroup -Name $Group -ErrorAction SilentlyContinue)) {
    New-LocalGroup -Name $Group -Description "VEM controlled remote maintenance access" | Out-Null
  }
}

function Test-LocalUserInGroup {
  param(
    [string]$User,
    $Group
  )

  $initialGroupName = if ($Group.PSObject.Properties.Name -contains "Name") { [string]$Group.Name } else { [string]$Group }
  $pending = [System.Collections.Generic.Queue[string]]::new()
  $visited = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $pending.Enqueue($initialGroupName)
  while ($pending.Count -gt 0) {
    $currentGroup = $pending.Dequeue()
    if (-not $visited.Add($currentGroup)) { continue }
    try {
      $members = @(Get-LocalGroupMember -Group $currentGroup -ErrorAction Stop)
    } catch {
      continue
    }
    foreach ($member in $members) {
      $name = [string]$member.Name
      $leafName = ($name -split "\\")[-1]
      if ($leafName.Equals($User, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
      if ([string]$member.ObjectClass -eq "Group" -and -not [string]::IsNullOrWhiteSpace($leafName)) {
        $pending.Enqueue($leafName)
      }
    }
  }
  return $false
}

function Assert-ExistingMaintenanceAdministrator {
  param([string]$User)

  $account = Get-LocalUser -Name $User -ErrorAction SilentlyContinue
  if ($null -eq $account) {
    throw "profile maintenance administrator must already exist; factory setup will not create it: $User"
  }
  if ($account.PSObject.Properties.Name -contains "Enabled" -and -not [bool]$account.Enabled) {
    throw "profile maintenance administrator must be enabled: $User"
  }
  if (-not (Test-LocalUserInGroup -User $User -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-544"))) {
    throw "profile maintenance account must already be an administrator: $User"
  }
}

function Assert-KioskRemoteAdministrationDenied {
  param([string]$User)

  $boundaries = @((Get-BuiltinLocalGroup -Sid "S-1-5-32-544"), "OpenSSH Users", (Get-BuiltinLocalGroup -Sid "S-1-5-32-555"), (Get-BuiltinLocalGroup -Sid "S-1-5-32-580"))
  $granted = @($boundaries | Where-Object { Test-LocalUserInGroup -User $User -Group $_ })
  if ($granted.Count -gt 0) {
    throw "kiosk account has effective nested remote-administration membership: $($granted -join ', ')"
  }
}

function Assert-RemoteMaintenanceAccountSeparation {
  param(
    [string]$MaintenanceUser,
    [string]$KioskUser
  )

  if (-not (Test-LocalUserInGroup -User $MaintenanceUser -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-544"))) {
    throw "maintenance account must be a local administrator before enabling remote maintenance access: $MaintenanceUser"
  }
  if (Test-LocalUserInGroup -User $KioskUser -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-544")) {
    throw "kiosk account must not be a local administrator before enabling remote maintenance access: $KioskUser"
  }
}

function Ensure-OpenSshServer {
  $sshd = Get-Service -Name "sshd" -ErrorAction SilentlyContinue
  if ($null -eq $sshd) {
    throw "OpenSSH Server service sshd is not available after pinned local installation"
  }

  Set-Service -Name "sshd" -StartupType Automatic
  if ($sshd.Status -eq "Running") {
    Stop-Service -Name "sshd" -Force
  }
}

function Get-OpenSshServerExePath {
  foreach ($path in @(
      "C:\Program Files\OpenSSH\sshd.exe",
      "C:\Windows\System32\OpenSSH\sshd.exe"
    )) {
    if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
  }
  $command = Get-Command "sshd" -ErrorAction SilentlyContinue
  if ($null -ne $command) { return [string]$command.Source }
  return $null
}

function Test-SshdConfiguration {
  param(
    [Parameter(Mandatory = $true)][string]$SshdExePath,
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)][string]$MaintenanceUser,
    [Parameter(Mandatory = $true)][string]$SourceAddress
  )

  $syntaxOutput = @(& $SshdExePath -t -f $ConfigPath 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "sshd -t rejected managed configuration: $($syntaxOutput -join '; ')"
  }
  $effectiveOutput = @(& $SshdExePath -T -f $ConfigPath -C "user=$($MaintenanceUser.ToLowerInvariant()),host=localhost,addr=$SourceAddress" 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "sshd -T rejected managed configuration: $($effectiveOutput -join '; ')"
  }
  $values = @{}
  foreach ($line in $effectiveOutput) {
    $parts = ([string]$line).Trim() -split "\s+", 2
    if ($parts.Count -eq 2 -and -not $values.ContainsKey($parts[0])) {
      $values[$parts[0]] = $parts[1]
    }
  }
  return [ordered]@{
    syntaxValid = $true
    listenAddress = [string]$values.listenaddress
    trustedUserCaKeys = [string]$values.trustedusercakeys
    authorizedKeysFile = [string]$values.authorizedkeysfile
    passwordAuthentication = [string]$values.passwordauthentication
    kbdInteractiveAuthentication = [string]$values.kbdinteractiveauthentication
    authenticationMethods = [string]$values.authenticationmethods
    allowUsers = [string]$values.allowusers
    denyUsers = [string]$values.denyusers
  }
}

function Assert-WireGuardListenAddress {
  param(
    [string]$InterfaceAlias,
    [string]$ListenAddress
  )

  $parsedAddress = [System.Net.IPAddress]::None
  if ([string]::IsNullOrWhiteSpace($InterfaceAlias)) {
    throw "Controlled Maintenance Ingress requires a WireGuard interface alias"
  }
  if ([string]::IsNullOrWhiteSpace($ListenAddress) -or -not [System.Net.IPAddress]::TryParse($ListenAddress, [ref]$parsedAddress) -or
      $parsedAddress.Equals([System.Net.IPAddress]::Any) -or $parsedAddress.Equals([System.Net.IPAddress]::IPv6Any) -or
      $parsedAddress.Equals([System.Net.IPAddress]::Loopback) -or $parsedAddress.Equals([System.Net.IPAddress]::IPv6Loopback)) {
    throw "WireGuard tunnel ListenAddress must not be wildcard or loopback"
  }
  $address = Get-NetIPAddress -InterfaceAlias $InterfaceAlias -IPAddress $parsedAddress.IPAddressToString -ErrorAction SilentlyContinue
  if ($null -eq $address) {
    throw "WireGuard interface $InterfaceAlias does not own required SSH ListenAddress $ListenAddress"
  }
}

function Get-ControlledMaintenanceIngressPolicy {
  param(
    [string]$Profile,
    [string]$WireGuardInterfaceAlias,
    [string]$WireGuardListenAddress
  )

  if ($Profile -ne "production" -and $Profile -ne "testbed") {
    throw "FactoryProfile must be production or testbed"
  }
  Assert-WireGuardListenAddress -InterfaceAlias $WireGuardInterfaceAlias -ListenAddress $WireGuardListenAddress
  return [ordered]@{
    mode = "wireguard-only"
    sshListenAddress = $WireGuardListenAddress
    firewallInterfaceScope = $WireGuardInterfaceAlias
    requiresWireGuardAddress = $true
  }
}

function Assert-ProfileMaintenanceCa {
  param(
    [string]$Path,
    [string]$Profile
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "selected profile CA public key is missing: $Path"
  }
  $keyLines = @([System.IO.File]::ReadAllLines($Path, [System.Text.Encoding]::UTF8) | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 -and -not $_.StartsWith("#") })
  if ($keyLines.Count -ne 1 -or $keyLines[0] -notmatch "^ssh-ed25519\s+[A-Za-z0-9+/=]+\s+vem-maintenance-ca:(production|testbed)$") {
    throw "Maintenance SSH CA must contain exactly one profile-bound Ed25519 public key"
  }
  if ($matches[1] -cne $Profile) {
    throw "Maintenance SSH CA profile does not match FactoryProfile $Profile"
  }
}

function Ensure-SshdConfigDenyKioskUser {
  param(
    [string]$ConfigPath,
    [string]$KioskUser,
    [string]$MaintenanceUser,
    [string]$CaPath,
    [string]$ListenAddress
  )

  Ensure-Directory -Path (Split-Path -Parent $ConfigPath)
  $existing = if (Test-Path -LiteralPath $ConfigPath) {
    Get-Content -LiteralPath $ConfigPath
  } else {
    @()
  }

  $startMarker = "# BEGIN VEM controlled remote maintenance access"
  $endMarker = "# END VEM controlled remote maintenance access"
  if ([string]::IsNullOrWhiteSpace($ListenAddress)) {
    throw "WireGuard tunnel ListenAddress is required"
  }
  $parsedAddress = [System.Net.IPAddress]::None
  if (-not [System.Net.IPAddress]::TryParse($ListenAddress, [ref]$parsedAddress)) {
    throw "WireGuard tunnel ListenAddress must be an IP address: $ListenAddress"
  }
  if ($parsedAddress.Equals([System.Net.IPAddress]::Any) -or $parsedAddress.Equals([System.Net.IPAddress]::IPv6Any) -or
      $parsedAddress.Equals([System.Net.IPAddress]::Loopback) -or $parsedAddress.Equals([System.Net.IPAddress]::IPv6Loopback)) {
    throw "WireGuard tunnel ListenAddress must not be wildcard or loopback"
  }

  $managedBlock = @(
    $startMarker,
    "ListenAddress $($parsedAddress.IPAddressToString)",
    "TrustedUserCAKeys $CaPath",
    "PubkeyAuthentication yes",
    "PasswordAuthentication no",
    "KbdInteractiveAuthentication no",
    "AuthenticationMethods publickey",
    "AuthorizedKeysFile none",
    "AllowUsers $($MaintenanceUser.ToLowerInvariant())",
    "DenyUsers $($KioskUser.ToLowerInvariant())",
    "PermitEmptyPasswords no",
    "# profile CA: $FactoryProfile",
    "# SYSTEM SSH entrypoint: not configured; elevate explicitly from the administrator session",
    $endMarker
  )

  $filtered = [System.Collections.Generic.List[string]]::new()
  $insideManagedBlock = $false
  $insideMatchBlock = $false
  $controlledDirectives = @(
    "listenaddress",
    "trustedusercakeys",
    "pubkeyauthentication",
    "passwordauthentication",
    "kbdinteractiveauthentication",
    "challengeresponseauthentication",
    "authenticationmethods",
    "allowusers",
    "denyusers",
    "permitemptypasswords"
  )
  foreach ($line in $existing) {
    if ($line -eq $startMarker) {
      $insideManagedBlock = $true
      continue
    }
    if ($line -eq $endMarker) {
      $insideManagedBlock = $false
      continue
    }
    if ($insideManagedBlock) {
      continue
    }
    $trimmed = $line.Trim()
    if ($trimmed -match "(?i)^Match(?:\s|$)") {
      $insideMatchBlock = $true
      continue
    }
    if ($insideMatchBlock) {
      continue
    }
    if ($trimmed.Length -gt 0 -and -not $trimmed.StartsWith("#")) {
      $directive = ($trimmed -split "\s+", 2)[0].ToLowerInvariant()
      if ($controlledDirectives -contains $directive) {
        throw "conflicting earlier sshd directive must be removed before VEM policy is applied: $trimmed"
      }
      if ($directive -eq "authorizedkeysfile") {
        continue
      }
    }
    $filtered.Add($line) | Out-Null
  }

  $canonical = [System.Collections.Generic.List[string]]::new()
  foreach ($line in $managedBlock) {
    $canonical.Add($line) | Out-Null
  }
  if ($filtered.Count -gt 0) {
    $canonical.Add("") | Out-Null
    foreach ($line in $filtered) {
      $canonical.Add($line) | Out-Null
    }
  }

  Set-Content -LiteralPath $ConfigPath -Value $canonical -Encoding ASCII
}

function Test-FirewallLocalPortIncludesSsh {
  param($LocalPort)

  foreach ($entry in @($LocalPort)) {
    foreach ($candidate in ([string]$entry -split ",")) {
      $value = $candidate.Trim()
      if ($value -match "^(?i:Any|\*)$" -or $value -eq "22") { return $true }
      if ($value -match "^(\d+)-(\d+)$" -and [int]$matches[1] -le 22 -and [int]$matches[2] -ge 22) { return $true }
    }
  }
  return $false
}

function Get-EnabledInboundSshFirewallRules {
  $rules = @(Get-NetFirewallRule -ErrorAction SilentlyContinue)
  foreach ($rule in $rules) {
    if ([string]$rule.Direction -ne "Inbound" -or [string]$rule.Enabled -ne "True" -or [string]$rule.Action -ne "Allow") {
      continue
    }
    $filters = @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $rule -ErrorAction SilentlyContinue)
    foreach ($filter in $filters) {
      $protocol = [string]$filter.Protocol
      if (($protocol -eq "TCP" -or $protocol -eq "6" -or $protocol -eq "Any") -and (Test-FirewallLocalPortIncludesSsh -LocalPort $filter.LocalPort)) {
        $rule
        break
      }
    }
  }
}

function Assert-ControlledMaintenanceIngressSourceAllowlist {
  param([string[]]$SourceAllowlist)

  if ($null -eq $SourceAllowlist -or @($SourceAllowlist).Count -eq 0) {
    throw "Controlled Maintenance Ingress requires at least one explicit maintenance ingress source address."
  }

  $forbidden = @(
    "Any",
    "*",
    "Internet",
    "LocalSubnet",
    "DefaultGateway",
    "DHCP",
    "DNS",
    "WINS",
    "0.0.0.0",
    "::",
    "0.0.0.0/0",
    "::/0"
  )
  $validated = [System.Collections.Generic.List[string]]::new()

  foreach ($entry in $SourceAllowlist) {
    foreach ($candidate in ([string]$entry -split ",")) {
      $trimmed = $candidate.Trim()
      if ([string]::IsNullOrWhiteSpace($trimmed)) {
        throw "Controlled Maintenance Ingress source address must not be empty."
      }
      if ($forbidden -contains $trimmed) {
        throw "Controlled Maintenance Ingress source address is too broad: $trimmed"
      }

      $addressText = $trimmed
      $prefixLength = $null
      if ($trimmed.Contains("/")) {
        $parts = $trimmed -split "/", 2
        if ($parts.Count -ne 2 -or [string]::IsNullOrWhiteSpace($parts[0]) -or [string]::IsNullOrWhiteSpace($parts[1])) {
          throw "Controlled Maintenance Ingress source address must be an IP address or CIDR: $trimmed"
        }
        $addressText = $parts[0].Trim()
        try {
          $prefixLength = [int]$parts[1].Trim()
        } catch {
          throw "Controlled Maintenance Ingress CIDR prefix must be numeric: $trimmed"
        }
      }

      $ip = [System.Net.IPAddress]::None
      if (-not [System.Net.IPAddress]::TryParse($addressText, [ref]$ip)) {
        throw "Controlled Maintenance Ingress source address must be an IP address or CIDR: $trimmed"
      }
      if ($ip.Equals([System.Net.IPAddress]::Any) -or $ip.Equals([System.Net.IPAddress]::IPv6Any)) {
        throw "Controlled Maintenance Ingress source address is too broad: $trimmed"
      }
      $requiredPrefix = if ($ip.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetworkV6) { 128 } else { 32 }
      if ($null -ne $prefixLength) {
        if ($prefixLength -ne $requiredPrefix) {
          throw "Controlled Maintenance Ingress source address is too broad: $trimmed"
        }
      }

      $normalized = [string]$ip.IPAddressToString
      if (-not $validated.Contains($normalized)) {
        $validated.Add($normalized) | Out-Null
      }
    }
  }

  if ($validated.Count -eq 0) {
    throw "Controlled Maintenance Ingress requires at least one explicit maintenance ingress source address."
  }

  return @($validated)
}

function Ensure-ControlledMaintenanceIngressFirewall {
  param(
    [string[]]$SourceAllowlist,
    [string]$InterfaceAlias,
    [string]$IngressMode
  )

  $ruleName = "VEM Controlled Maintenance SSH"
  $validatedSources = Assert-ControlledMaintenanceIngressSourceAllowlist -SourceAllowlist $SourceAllowlist
  if ([string]::IsNullOrWhiteSpace($InterfaceAlias) -or $InterfaceAlias -ceq "Any") {
    throw "Controlled Maintenance Ingress firewall requires the declared WireGuard interface alias"
  }

  Get-EnabledInboundSshFirewallRules | Remove-NetFirewallRule

  $ruleArguments = @{
    DisplayName = $ruleName
    Direction = "Inbound"
    Action = "Allow"
    Protocol = "TCP"
    LocalPort = 22
    RemoteAddress = $validatedSources
    Profile = "Any"
    Description = "VEM-managed $IngressMode SSH ingress scoped to explicit runner and maintainer role pools."
  }
  $ruleArguments.InterfaceAlias = $InterfaceAlias
  New-NetFirewallRule @ruleArguments | Out-Null
}

function Reject-ControlledMaintenanceIngressMigration {
  throw "ConfigureRemoteMaintenanceAccess has been removed. Use -ConfigureControlledMaintenanceIngress with -MaintenanceIngressSourceAllowlist for transport-neutral Controlled Maintenance Ingress."
}

function Ensure-ControlledMaintenanceIngress {
  param(
    [string]$MaintenanceUser,
    [string]$KioskUser,
    [string]$SshdConfigPath,
    [string[]]$SourceAllowlist,
    [string[]]$RunnerSourceAllowlist,
    [string[]]$MaintainerSourceAllowlist,
    [string]$InterfaceAlias,
    [string]$CaPath,
    [string]$ListenAddress
  )

  if (@($RunnerSourceAllowlist).Count -eq 0 -or @($MaintainerSourceAllowlist).Count -eq 0) {
    throw "Controlled Maintenance Ingress requires explicit runner and maintainer role pools"
  }
  if ($FactoryProfile -eq "production" -and $MaintenanceUser -cne "Admin") {
    throw "production profile permits only the Admin maintenance administrator"
  }
  if ($FactoryProfile -eq "production" -and $null -ne (Get-LocalUser -Name "YKDZ" -ErrorAction SilentlyContinue)) {
    throw "production profile rejects a live YKDZ testbed account"
  }
  if ($FactoryProfile -eq "testbed" -and $MaintenanceUser -cne "YKDZ") {
    throw "testbed profile permits only the YKDZ maintenance administrator"
  }
  $roleSources = @($RunnerSourceAllowlist) + @($MaintainerSourceAllowlist)
  $validatedSources = Assert-ControlledMaintenanceIngressSourceAllowlist -SourceAllowlist $roleSources

  if (-not (Get-LocalUser -Name $MaintenanceUser -ErrorAction SilentlyContinue)) {
    throw "maintenance account not found: $MaintenanceUser. Configure it before enabling Controlled Maintenance Ingress."
  }
  if (-not (Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue)) {
    throw "kiosk account not found: $KioskUser. Configure it before enabling Controlled Maintenance Ingress."
  }
  Assert-RemoteMaintenanceAccountSeparation -MaintenanceUser $MaintenanceUser -KioskUser $KioskUser
  $ingressPolicy = Get-ControlledMaintenanceIngressPolicy -Profile $FactoryProfile -WireGuardInterfaceAlias $InterfaceAlias -WireGuardListenAddress $ListenAddress
  Assert-WireGuardListenAddress -InterfaceAlias $InterfaceAlias -ListenAddress $ListenAddress

  Assert-ProfileMaintenanceCa -Path $CaPath -Profile $FactoryProfile
  Ensure-OpenSshServer
  Ensure-SshdConfigDenyKioskUser -ConfigPath $SshdConfigPath -KioskUser $KioskUser -MaintenanceUser $MaintenanceUser -CaPath $CaPath -ListenAddress ([string]$ingressPolicy.sshListenAddress)
  $sshdExePath = Get-OpenSshServerExePath
  if ([string]::IsNullOrWhiteSpace($sshdExePath)) {
    throw "OpenSSH sshd executable is unavailable after pinned local installation"
  }
  $sshdProbeSource = ([string]$validatedSources[0] -split "/", 2)[0]
  Test-SshdConfiguration -SshdExePath $sshdExePath -ConfigPath $SshdConfigPath -MaintenanceUser $MaintenanceUser -SourceAddress $sshdProbeSource | Out-Null
  Ensure-ControlledMaintenanceIngressFirewall -SourceAllowlist $validatedSources -InterfaceAlias ([string]$ingressPolicy.firewallInterfaceScope) -IngressMode ([string]$ingressPolicy.mode)
  Ensure-LocalGroupExists -Group "OpenSSH Users"
  Add-LocalGroupMember -Group "OpenSSH Users" -Member $MaintenanceUser -ErrorAction SilentlyContinue
  Remove-LocalGroupMember -Group "OpenSSH Users" -Member $KioskUser -ErrorAction SilentlyContinue
  Remove-LocalGroupMember -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-555") -Member $KioskUser -ErrorAction SilentlyContinue
  Remove-LocalGroupMember -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-580") -Member $KioskUser -ErrorAction SilentlyContinue
  Assert-KioskRemoteAdministrationDenied -User $KioskUser

  Start-Service -Name "sshd"

  Write-Host "Configured $($ingressPolicy.mode) Controlled Maintenance Ingress SSH access for $MaintenanceUser on $($ingressPolicy.firewallInterfaceScope); $KioskUser is excluded."
}

function Get-LocalAccountSid {
  param([string]$User)
  $account = New-Object System.Security.Principal.NTAccount($env:COMPUTERNAME, $User)
  return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
}

function Assert-CimMethodSucceeded {
  param(
    [object]$Result,
    [string]$Operation
  )

  if ($null -eq $Result) {
    throw "$Operation did not return a result"
  }

  $returnValue = $Result.ReturnValue
  if ($null -ne $returnValue -and [int]$returnValue -ne 0) {
    throw "$Operation failed with ReturnValue $returnValue"
  }
}

function Test-ShellLauncherAvailable {
  $shellLauncher = Get-CimClass -Namespace "root\standardcimv2\embedded" -ClassName "WESL_UserSetting" -ErrorAction SilentlyContinue
  return $null -ne $shellLauncher
}

function Set-PerUserWinlogonShell {
  param(
    [string]$User,
    [string]$Sid,
    [string]$ShellCommand,
    [string]$UserPassword,
    [string]$Reason
  )

  $userWinlogonPath = "Registry::HKEY_USERS\$sid\Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
  if (-not (Test-Path "Registry::HKEY_USERS\$sid")) {
    if (-not [string]::IsNullOrEmpty($UserPassword)) {
      $securePassword = ConvertTo-SecureString $UserPassword -AsPlainText -Force
      $credential = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\$User", $securePassword)
      $profileProcess = Start-Process `
        -FilePath "C:\Windows\System32\cmd.exe" `
        -ArgumentList "/c exit" `
        -Credential $credential `
        -LoadUserProfile `
        -WindowStyle Hidden `
        -PassThru
      $profileProcess.WaitForExit(15000) | Out-Null
    }
  }
  if (Test-Path "Registry::HKEY_USERS\$sid") {
    if (-not (Test-Path $userWinlogonPath)) {
      New-Item -Path $userWinlogonPath -Force | Out-Null
    }
    New-ItemProperty -Path $userWinlogonPath -Name "Shell" -Value $ShellCommand -PropertyType String -Force | Out-Null
    Write-Host "Configured per-user Winlogon shell for $User ($Reason): $ShellCommand"
    return
  }

  $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$sid'" -ErrorAction SilentlyContinue
  $profilePath = if ($null -ne $profile -and -not [string]::IsNullOrWhiteSpace($profile.LocalPath)) {
    $profile.LocalPath
  } else {
    Join-Path "C:\Users" $User
  }
  $hivePath = Join-Path $profilePath "NTUSER.DAT"
  if (-not (Test-Path -LiteralPath $hivePath)) {
    if ([string]::IsNullOrEmpty($UserPassword)) {
      throw "per-user Winlogon shell requires KioskPassword when the $User profile hive is not loaded"
    }
    throw "could not find profile hive for kiosk user $User at $hivePath"
  }

  $tempHive = "VEMKioskShell-$($sid.Replace('-', '_'))"
  $loaded = $false
  try {
    reg.exe load "HKU\$tempHive" $hivePath | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "failed to load kiosk profile hive: $hivePath"
    }
    $loaded = $true
    $offlineWinlogonPath = "Registry::HKEY_USERS\$tempHive\Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
    if (-not (Test-Path $offlineWinlogonPath)) {
      New-Item -Path $offlineWinlogonPath -Force | Out-Null
    }
    New-ItemProperty -Path $offlineWinlogonPath -Name "Shell" -Value $ShellCommand -PropertyType String -Force | Out-Null
    Write-Host "Configured offline per-user Winlogon shell for $User ($Reason): $ShellCommand"
  } finally {
    if ($loaded) {
      [gc]::Collect()
      [gc]::WaitForPendingFinalizers()
      reg.exe unload "HKU\$tempHive" | Out-Null
    }
  }
}

function Configure-KioskShell {
  param(
    [string]$User,
    [string]$ShellPath,
    [string]$UserPassword
  )

  $sid = Get-LocalAccountSid -User $User
  $shellCommand = ('"{0}"' -f $ShellPath)

  # Shell Launcher is the preferred OS-level kiosk shell when the Windows edition supports it.
  $shellLauncher = Get-CimClass -Namespace "root\standardcimv2\embedded" -ClassName "WESL_UserSetting" -ErrorAction SilentlyContinue
  if ($null -ne $shellLauncher) {
    $enableResult = Invoke-CimMethod -Namespace "root\standardcimv2\embedded" -ClassName "WESL_UserSetting" -MethodName SetEnabled -Arguments @{ Enabled = $true }
    Assert-CimMethodSucceeded -Result $enableResult -Operation "Shell Launcher SetEnabled"
    $customShellResult = Invoke-CimMethod -Namespace "root\standardcimv2\embedded" -ClassName "WESL_UserSetting" -MethodName SetCustomShell -Arguments @{
      Sid = $sid
      Shell = $shellCommand
      CustomReturnCodes = @()
      CustomReturnCodesAction = @()
      DefaultAction = 0
    }
    Assert-CimMethodSucceeded -Result $customShellResult -Operation "Shell Launcher SetCustomShell for $User"
    Set-PerUserWinlogonShell -User $User -Sid $sid -ShellCommand $shellCommand -UserPassword $UserPassword -Reason "Shell Launcher kiosk startup evidence"
    Write-Host "Configured OS-level kiosk shell for $User ($sid): $shellCommand"
  } else {
    Write-Warning "Shell Launcher WMI class not available; VEMMachineUI logon task is the sole kiosk UI owner for $User"
  }
}

function Ensure-DaemonDataDirectory {
  param(
    [string]$BringupDirectory,
    [string]$DataDirectory
  )

  Ensure-Directory -Path $DataDirectory
  $sourceConfig = Join-Path $BringupDirectory "machine-config.json"
  $targetConfig = Join-Path $DataDirectory "machine-config.json"
  if ((Test-Path -LiteralPath $sourceConfig) -and -not (Test-Path -LiteralPath $targetConfig)) {
    Copy-Item -Force -Path $sourceConfig -Destination $targetConfig
  }
}

function Set-ServiceEnvironmentVariable {
  param(
    [string]$ServiceName,
    [string]$Name,
    [string]$Value
  )

  $serviceRegistryPath = "HKLM:\SYSTEM\CurrentControlSet\Services\$ServiceName"
  $existing = @()
  $property = Get-ItemProperty -Path $serviceRegistryPath -Name Environment -ErrorAction SilentlyContinue
  if ($null -ne $property -and $null -ne $property.Environment) {
    $existing = @($property.Environment)
  }

  $prefix = "$Name="
  $next = @($existing | Where-Object { -not $_.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
  if (-not [string]::IsNullOrWhiteSpace($Value)) {
    $next += "$Name=$Value"
  }

  if ($next.Count -gt 0) {
    New-ItemProperty -Path $serviceRegistryPath -Name Environment -PropertyType MultiString -Value $next -Force | Out-Null
  } else {
    Remove-ItemProperty -Path $serviceRegistryPath -Name Environment -ErrorAction SilentlyContinue
  }
}

function Ensure-DaemonService {
  param(
    [string]$ExePath,
    [string]$DataDirectory,
    [string]$ReadyFile,
    [string[]]$ReadyFileReaders = @()
  )

  if (-not (Test-Path -LiteralPath $ExePath)) {
    Write-Warning "daemon exe not found; skipping service creation: $ExePath"
    return
  }

  Ensure-Directory -Path $DataDirectory
  Ensure-Directory -Path (Split-Path -Parent $ReadyFile)
  $binaryPath = ('"{0}" --data-dir "{1}" --print-ready-file "{2}"' -f $ExePath, $DataDirectory, $ReadyFile)

  $existing = Get-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue
  if (-not $existing) {
    New-Service `
      -Name "VemVendingDaemon" `
      -BinaryPathName $binaryPath `
      -DisplayName "VEM Vending Daemon" `
      -StartupType Automatic | Out-Null
  } else {
    sc.exe config VemVendingDaemon binPath= $binaryPath start= auto | Out-Null
  }

  sc.exe failure VemVendingDaemon reset= 86400 actions= restart/5000/restart/15000/""/0 | Out-Null

  Set-ServiceEnvironmentVariable `
    -ServiceName "VemVendingDaemon" `
    -Name "VEM_DAEMON_READY_FILE_READERS" `
    -Value ($ReadyFileReaders -join ";")
}

function Ensure-MachineUiShortcut {
  param(
    [string]$ShortcutName,
    [string]$LauncherPath,
    [string]$WorkingDirectory,
    [string]$IconPath
  )

  $desktop = [Environment]::GetFolderPath("Desktop")
  if ([string]::IsNullOrWhiteSpace($desktop)) {
    Write-Warning "desktop folder not found; skipping machine UI shortcut"
    return
  }

  Ensure-Directory -Path $desktop
  $shortcutPath = Join-Path $desktop $ShortcutName
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = "C:\Windows\System32\wscript.exe"
  $shortcut.Arguments = ('"{0}"' -f $LauncherPath)
  $shortcut.WorkingDirectory = $WorkingDirectory
  if (Test-Path -LiteralPath $IconPath) {
    $shortcut.IconLocation = $IconPath
  }
  $shortcut.Description = "Start VEM kiosk full-screen machine UI"
  $shortcut.Save()
}

function Register-InteractiveLogonTask {
  param(
    [string]$TaskName,
    [string]$Command,
    [string]$Arguments,
    [string]$WorkingDirectory,
    [string]$DelayISO,
    [string]$User,
    [int]$RestartOnFailureCount = 0,
    [string]$RestartOnFailureIntervalISO = "PT1M"
  )

  $commandXml = Escape-XmlText -Value $Command
  $argumentsXml = Escape-XmlText -Value $Arguments
  $workingDirectoryXml = Escape-XmlText -Value $WorkingDirectory
  $userXml = Escape-XmlText -Value $User

  $argumentElement = if ($Arguments.Trim().Length -gt 0) {
    "<Arguments>$argumentsXml</Arguments>"
  } else {
    ""
  }
  $workingDirectoryElement = if ($WorkingDirectory.Trim().Length -gt 0) {
    "<WorkingDirectory>$workingDirectoryXml</WorkingDirectory>"
  } else {
    ""
  }
  $restartOnFailureElement = if ($RestartOnFailureCount -gt 0) {
    $restartIntervalXml = Escape-XmlText -Value $RestartOnFailureIntervalISO
    @"
    <RestartOnFailure>
      <Interval>$restartIntervalXml</Interval>
      <Count>$RestartOnFailureCount</Count>
    </RestartOnFailure>
"@
  } else {
    ""
  }

  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>VEM Provisioning</Author>
    <Description>$TaskName</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$userXml</UserId>
      <Delay>$DelayISO</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$userXml</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    $restartOnFailureElement
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$commandXml</Command>
      $argumentElement
      $workingDirectoryElement
    </Exec>
  </Actions>
</Task>
"@

  $tmpFile = [System.IO.Path]::GetTempFileName() + ".xml"
  try {
    [System.IO.File]::WriteAllText($tmpFile, $xml, [System.Text.Encoding]::Unicode)
    schtasks /Create /TN $TaskName /XML $tmpFile /F | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to register scheduled task: $TaskName"
    }
  } finally {
    Remove-Item $tmpFile -ErrorAction SilentlyContinue
  }
}

function Remove-ScheduledTaskIfExists {
  param([string]$TaskName)

  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  schtasks /Query /TN $TaskName *> $null
  $ErrorActionPreference = $previousErrorActionPreference
  if ($LASTEXITCODE -ne 0) {
    return
  }

  schtasks /Delete /TN $TaskName /F | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to remove scheduled task: $TaskName"
  }
}

function Disable-EdgeAutoLaunch {
  $runPaths = @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Run",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run"
  )

  foreach ($path in $runPaths) {
    if (-not (Test-Path $path)) { continue }
    $item = Get-ItemProperty -Path $path
    foreach ($property in $item.PSObject.Properties) {
      if ($property.Name -match "Edge|msedge|MicrosoftEdge") {
        Remove-ItemProperty -Path $path -Name $property.Name -ErrorAction SilentlyContinue
      }
    }
  }
}

function Configure-WinlogonAutoLogon {
  param(
    [string]$User,
    [string]$Domain,
    [string]$Password,
    [bool]$AllowBlank
  )

  if ($Password.Length -eq 0 -and -not $AllowBlank) {
    throw "Auto-logon requires -AutoLogonPassword, env VEM_AUTOLOGON_PASSWORD, or explicit -AllowBlankAutoLogonPassword"
  }

  $path = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
  Remove-ItemProperty -Path $path -Name "AutoLogonCount" -ErrorAction SilentlyContinue
  New-ItemProperty -Path $path -Name "AutoAdminLogon" -Value "1" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $path -Name "ForceAutoLogon" -Value "1" -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $path -Name "DefaultUserName" -Value $User -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $path -Name "DefaultDomainName" -Value $Domain -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $path -Name "DefaultPassword" -Value $Password -PropertyType String -Force | Out-Null
}

function Get-ScheduledTaskStartupEvidence {
  param(
    [string]$TaskName,
    [string]$TaskPath = "\"
  )

  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    return [ordered]@{
      name = "$TaskPath$TaskName"
      exists = $false
      enabled = $false
      runAsUser = $null
      command = $null
      arguments = $null
      workingDirectory = $null
    }
  }

  $action = @($task.Actions | Select-Object -First 1)
  return [ordered]@{
    name = "$TaskPath$TaskName"
    exists = $true
    enabled = [string]$task.State -ne "Disabled"
    runAsUser = if ($null -ne $task.Principal) { [string]$task.Principal.UserId } else { $null }
    command = if ($action.Count -gt 0) { [string]$action[0].Execute } else { $null }
    arguments = if ($action.Count -gt 0) { [string]$action[0].Arguments } else { $null }
    workingDirectory = if ($action.Count -gt 0) { [string]$action[0].WorkingDirectory } else { $null }
  }
}

function Write-StartupBringupEvidence {
  param(
    [string]$Path,
    [string]$CustomerSessionUser,
    [string]$KioskUser,
    [string]$MaintenanceUser,
    [string]$MachineUiExe,
    [string]$MachineUiLauncher,
    [string]$MachineUiDebugLauncher,
    [bool]$ShellLauncherOwnsStartup
  )

  Ensure-Directory -Path (Split-Path -Parent $Path)
  $winlogon = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -ErrorAction SilentlyContinue
  $machineUiTask = Get-ScheduledTaskStartupEvidence -TaskName "VEMMachineUI"
  $maintenanceUiTask = Get-ScheduledTaskStartupEvidence -TaskName "VEMMaintenanceUI"
  $visionTask = Get-ScheduledTaskStartupEvidence -TaskName "StartVisionServer" -TaskPath "\VEM\"

  $autoLogonUser = if ($null -ne $winlogon -and -not [string]::IsNullOrWhiteSpace($winlogon.DefaultUserName)) {
    [string]$winlogon.DefaultUserName
  } else {
    "unknown"
  }
  $autoLogonDomain = if ($null -ne $winlogon -and -not [string]::IsNullOrWhiteSpace($winlogon.DefaultDomainName)) {
    [string]$winlogon.DefaultDomainName
  } else {
    "unknown"
  }

  $machineUiStartup = if ($ShellLauncherOwnsStartup) {
    [ordered]@{
      configured = Test-Path -LiteralPath $MachineUiExe
      mode = "shell_launcher"
      runAsUser = $KioskUser
      command = $MachineUiExe
    }
  } else {
    [ordered]@{
      configured = [bool]$machineUiTask.exists -and [bool]$machineUiTask.enabled
      mode = "scheduled_task"
      runAsUser = if ([string]::IsNullOrWhiteSpace($machineUiTask.runAsUser)) { "unknown" } else { [string]$machineUiTask.runAsUser }
      command = if ([string]::IsNullOrWhiteSpace($machineUiTask.command)) { "unknown" } else { [string]$machineUiTask.command }
    }
  }

  $evidence = [ordered]@{
    schemaVersion = "vem-startup-bringup-evidence/v1"
    collectedAt = (Get-Date).ToUniversalTime().ToString("o")
    configuredBy = "scripts/windows/setup-scheduled-tasks.ps1"
    productionBringup = $true
    daemonOwnedInitialization = $false
    users = [ordered]@{
      customerSession = $CustomerSessionUser
      kiosk = $KioskUser
      maintenance = $MaintenanceUser
    }
    autoLogon = [ordered]@{
      configured = $null -ne $winlogon -and [string]$winlogon.AutoAdminLogon -eq "1"
      force = $null -ne $winlogon -and [string]$winlogon.ForceAutoLogon -eq "1"
      user = $autoLogonUser
      domain = $autoLogonDomain
    }
    machineUiStartup = $machineUiStartup
    startupCommands = @(
      $machineUiTask,
      $maintenanceUiTask,
      $visionTask,
      [ordered]@{
        name = "MachineUiLauncher"
        exists = Test-Path -LiteralPath $MachineUiLauncher
        enabled = $true
        runAsUser = $CustomerSessionUser
        command = $MachineUiLauncher
        arguments = $null
        workingDirectory = Split-Path -Parent $MachineUiLauncher
      },
      [ordered]@{
        name = "MachineUiDebugLauncher"
        exists = Test-Path -LiteralPath $MachineUiDebugLauncher
        enabled = $true
        runAsUser = $MaintenanceUser
        command = $MachineUiDebugLauncher
        arguments = $null
        workingDirectory = Split-Path -Parent $MachineUiDebugLauncher
      }
    )
  }

  $json = $evidence | ConvertTo-Json -Depth 30
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
  Write-Host "Wrote startup bring-up evidence: $Path"
}

function Show-Verification {
  Write-Host "`n=== VEM startup verification ===" -ForegroundColor Cyan
  Get-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue |
    Select-Object Name, Status, StartType | Format-Table -AutoSize
  foreach ($taskName in @("VEMMachineUI", "VEMMaintenanceUI", "VEM\StartVisionServer")) {
    $previousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    schtasks /Query /TN $taskName /FO LIST 2>$null
    $ErrorActionPreference = $previousErrorActionPreference
  }
  Get-Service -Name "sshd" -ErrorAction SilentlyContinue |
    Select-Object Name, Status, StartType | Format-Table -AutoSize
  Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" |
    Select-Object AutoAdminLogon, ForceAutoLogon, DefaultUserName, DefaultDomainName |
    Format-List
}

Assert-Administrator
Ensure-Directory -Path $BringupDir
Ensure-DaemonDataDirectory -BringupDirectory $BringupDir -DataDirectory $DaemonDataDir

Write-Host "=== VEM Win10 machine provisioning ===" -ForegroundColor Cyan
$CustomerSessionUser = if ($UseKioskAccount -or $ConfigureKioskShell) { $KioskUser } else { $RunAsUser }
$ShellLauncherOwnsStartup = [bool]$ConfigureKioskShell -and (Test-ShellLauncherAvailable)

Write-Host "[1/9] Validate kiosk and maintenance accounts" -ForegroundColor Yellow
if ($ConfigureKioskAccounts) {
  Ensure-KioskAccount -User $KioskUser -Password $KioskPassword -Description "VEM restricted customer kiosk account"
} else {
  if (-not (Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue)) {
    Write-Warning "kiosk account not found: $KioskUser. Re-run with -ConfigureKioskAccounts and VEM_KIOSK_PASSWORD to create it."
  }
  if (-not (Get-LocalUser -Name $MaintenanceUser -ErrorAction SilentlyContinue)) {
    Write-Warning "maintenance account not found: $MaintenanceUser. Factory setup requires the profile administrator to exist before setup."
  }
}
Assert-ExistingMaintenanceAdministrator -User $MaintenanceUser
if (($UseKioskAccount -or $ConfigureKioskShell) -and -not (Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue)) {
  throw "Kiosk account mode requested for $KioskUser, but the account does not exist. Re-run with -ConfigureKioskAccounts and VEM_KIOSK_PASSWORD first."
}
Write-Host "Customer session user: $CustomerSessionUser"

Write-Host "[2/9] Configure controlled remote maintenance access" -ForegroundColor Yellow
if ($ConfigureRemoteMaintenanceAccess) {
  Reject-ControlledMaintenanceIngressMigration
} elseif ($ConfigureControlledMaintenanceIngress) {
  Ensure-ControlledMaintenanceIngress -MaintenanceUser $MaintenanceUser -KioskUser $KioskUser -SshdConfigPath $SshdConfigPath -SourceAllowlist $MaintenanceIngressSourceAllowlist -RunnerSourceAllowlist $MaintenanceRunnerSourceAllowlist -MaintainerSourceAllowlist $MaintenanceMaintainerSourceAllowlist -InterfaceAlias $MaintenanceWireGuardInterfaceAlias -CaPath $MaintenanceSshCaPublicKeyPath -ListenAddress $MaintenanceWireGuardListenAddress
} elseif ($ConfigureLocalMaintenanceAccess) {
  throw "ConfigureLocalMaintenanceAccess has been removed; use the profile CA and WireGuard role-pool Controlled Maintenance Ingress"
} else {
  Write-Host "Controlled maintenance ingress not changed. Re-run with -ConfigureControlledMaintenanceIngress and explicit role pools."
}

Write-Host "[3/9] Write machine UI launchers" -ForegroundColor Yellow
$KioskDisplayProbeScript = Join-Path $BringupDir "capture-kiosk-display.ps1"
Ensure-KioskDisplayProbeScript -Path $KioskDisplayProbeScript
Ensure-MachineUiLauncher `
  -LauncherPath $MachineUiLauncher `
  -ExePath $MachineUiExe `
  -WorkingDirectory $BringupDir `
  -DisplayProbePath $KioskDisplayProbeScript
Ensure-MachineUiDebugLauncher `
  -LauncherPath $MachineUiDebugLauncher `
  -ExePath $MachineUiExe `
  -WorkingDirectory $BringupDir

Write-Host "[4/9] Configure daemon service" -ForegroundColor Yellow
Ensure-DaemonService `
  -ExePath $DaemonExe `
  -DataDirectory $DaemonDataDir `
  -ReadyFile $DaemonReadyFile `
  -ReadyFileReaders @($CustomerSessionUser)

Write-Host "[5/9] Configure VEMMachineUI kiosk logon task" -ForegroundColor Yellow
if (-not $ShellLauncherOwnsStartup) {
  Register-InteractiveLogonTask `
    -TaskName "VEMMachineUI" `
    -Command "C:\Windows\System32\wscript.exe" `
    -Arguments ('"{0}"' -f $MachineUiLauncher) `
    -WorkingDirectory $BringupDir `
    -DelayISO "PT15S" `
    -User $CustomerSessionUser `
    -RestartOnFailureCount 3 `
    -RestartOnFailureIntervalISO "PT1M"
  if ($ConfigureKioskShell) {
    Write-Host "Registered VEMMachineUI logon task because Shell Launcher is unavailable on this Windows edition."
  }
} else {
  Remove-ScheduledTaskIfExists -TaskName "VEMMachineUI"
  Write-Host "Skipped VEMMachineUI logon task because Shell Launcher owns the kiosk UI process."
}

Write-Host "[5b/9] Configure VEMMaintenanceUI debug task" -ForegroundColor Yellow
if ($EnableMaintenanceDebugTask) {
  Register-InteractiveLogonTask `
    -TaskName "VEMMaintenanceUI" `
    -Command "C:\Windows\System32\wscript.exe" `
    -Arguments ('"{0}"' -f $MachineUiDebugLauncher) `
    -WorkingDirectory $BringupDir `
    -DelayISO "PT15S" `
    -User $MaintenanceUser `
    -RestartOnFailureCount 0
} else {
  Remove-ScheduledTaskIfExists -TaskName "VEMMaintenanceUI"
  Write-Host "Maintenance debug UI task not enabled. Re-run with -EnableMaintenanceDebugTask for an active maintenance session."
}

Write-Host "[6/9] Create desktop shortcuts" -ForegroundColor Yellow
Ensure-MachineUiShortcut `
  -ShortcutName $MachineUiShortcutName `
  -LauncherPath $MachineUiLauncher `
  -WorkingDirectory $BringupDir `
  -IconPath $MachineUiExe
Ensure-MachineUiShortcut `
  -ShortcutName $MachineUiDebugShortcutName `
  -LauncherPath $MachineUiDebugLauncher `
  -WorkingDirectory $BringupDir `
  -IconPath $MachineUiExe

Write-Host "[7/9] Configure VEM\StartVisionServer logon task" -ForegroundColor Yellow
if (Test-Path -LiteralPath $VisionLauncher) {
  Register-InteractiveLogonTask `
    -TaskName "VEM\StartVisionServer" `
    -Command "C:\Windows\System32\cmd.exe" `
    -Arguments ('/c ""{0}""' -f $VisionLauncher) `
    -WorkingDirectory $VisionWorkingDirectory `
    -DelayISO "PT10S" `
    -User $CustomerSessionUser `
    -RestartOnFailureCount 999 `
    -RestartOnFailureIntervalISO "PT1M"
} else {
  Write-Warning "vision launcher not found; skipping VEM\StartVisionServer task: $VisionLauncher"
  $visionTask = Get-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
  if ($null -ne $visionTask) {
    schtasks /Delete /TN "VEM\StartVisionServer" /F | Out-Null
  }
}

Write-Host "[8/9] Remove Edge auto-launch entries" -ForegroundColor Yellow
Disable-EdgeAutoLaunch

Write-Host "[9/9] Kiosk shell and auto-logon configuration" -ForegroundColor Yellow
if ($ConfigureKioskShell) {
  Configure-KioskShell -User $KioskUser -ShellPath $MachineUiExe -UserPassword $KioskPassword
} else {
  Write-Host "Kiosk shell lockdown not enabled. Re-run with -ConfigureKioskShell after validating maintenance recovery."
}

if ($ConfigureAutoLogon) {
  $allowBlankAutoLogon = [bool]$AllowBlankAutoLogonPassword
  Configure-WinlogonAutoLogon -User $CustomerSessionUser -Domain $AutoLogonDomain -Password $AutoLogonPassword -AllowBlank $allowBlankAutoLogon
  Write-Host "Enabled Winlogon auto-logon: $AutoLogonDomain\$CustomerSessionUser"
} else {
  Write-Host "Auto-logon not enabled. Re-run with -ConfigureAutoLogon for unattended cold boot."
}

Write-StartupBringupEvidence `
  -Path $StartupBringupEvidenceFile `
  -CustomerSessionUser $CustomerSessionUser `
  -KioskUser $KioskUser `
  -MaintenanceUser $MaintenanceUser `
  -MachineUiExe $MachineUiExe `
  -MachineUiLauncher $MachineUiLauncher `
  -MachineUiDebugLauncher $MachineUiDebugLauncher `
  -ShellLauncherOwnsStartup ([bool]$ShellLauncherOwnsStartup)

if ($StartNow) {
  Start-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue
  schtasks /Run /TN "VEM\StartVisionServer" | Out-Null
  if (-not $ShellLauncherOwnsStartup) {
    schtasks /Run /TN "VEMMachineUI" | Out-Null
  }
}

Show-Verification
Write-Host "`nDone." -ForegroundColor Green
