param(
  [string]$KioskUser = "VEMKiosk",
  [string]$MaintenanceUser = "Admin",
  [string]$MachineUiExe = "C:\VEM\bringup\machine.exe",
  [string]$MachineUiLauncher = "C:\VEM\bringup\launch-machine-ui.vbs",
  [string]$MachineUiDebugLauncher = "C:\VEM\bringup\launch-machine-ui-debug.vbs",
  [string]$SshdConfigPath = "C:\ProgramData\ssh\sshd_config",
  [string]$MaintenanceSshCaPublicKeyPath = "C:\ProgramData\VEM\factory\maintenance-ca.pub",
  [string]$MaintenanceWireGuardInterfaceAlias,
  [string]$MaintenanceWireGuardListenAddress,
  [string]$EvidencePath = "C:\ProgramData\VEM\kiosk-lockdown-evidence.json",
  [string[]]$MaintenanceIngressSourceAllowlist,

  [switch]$TouchEdgeGesturesBlocked,
  [switch]$CloseMinimizeControlsUnavailable,
  [switch]$DesktopShellUnavailable,
  [switch]$DebugRoutesUnavailable,
  [switch]$MaintenanceRecoveryConfirmed,
  [switch]$MaintenanceIngressConfirmed,
  [string]$NegativeKioskSshEvidence = $env:VEM_NEGATIVE_KIOSK_SSH_EVIDENCE,
  [switch]$MaintenanceDebugTaskExpected
)

$ErrorActionPreference = "Stop"

function Add-Failure([System.Collections.Generic.List[string]]$Failures, [string]$Message) {
  $Failures.Add($Message) | Out-Null
}

function Read-TextIfExists([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return $null
  }
  return Get-Content -LiteralPath $Path -Raw
}

function Get-LocalAccountSidOrNull([string]$User) {
  try {
    $account = New-Object System.Security.Principal.NTAccount($env:COMPUTERNAME, $User)
    return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    return $null
  }
}

function Get-BuiltinLocalGroup {
  param([Parameter(Mandatory = $true)][string]$Sid)

  $group = Get-LocalGroup -SID ([Security.Principal.SecurityIdentifier]::new($Sid)) -ErrorAction Stop
  if ($null -eq $group) { throw "required builtin local group is unavailable: $Sid" }
  return $group
}

function Test-LocalUserInGroup([string]$User, $Group) {
  try {
    $members = Get-LocalGroupMember -Group $Group -ErrorAction Stop
    return $null -ne ($members | Where-Object { $_.Name -eq "$env:COMPUTERNAME\$User" -or $_.Name -eq $User } | Select-Object -First 1)
  } catch {
    return $false
  }
}

function Test-PrincipalMatches([string]$Principal, [string]$User) {
  if ([string]::IsNullOrWhiteSpace($Principal)) {
    return $false
  }

  return $Principal -eq $User -or $Principal -eq ".\$User" -or $Principal -eq "$env:COMPUTERNAME\$User"
}

function Get-ServiceStateOrNull([string]$Name) {
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $service) {
    return $null
  }

  return [pscustomobject]@{
    name = $service.Name
    status = [string]$service.Status
    startType = [string]$service.StartType
  }
}

function Test-SshdConfigDeniesUser([string]$ConfigPath, [string]$User) {
  if (-not (Test-Path -LiteralPath $ConfigPath)) {
    return $false
  }

  $expectedUser = $User.ToLowerInvariant()
  foreach ($line in Get-Content -LiteralPath $ConfigPath) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) {
      continue
    }
    $tokens = $trimmed -split "\s+"
    if ($tokens.Count -lt 2 -or $tokens[0] -ne "DenyUsers") {
      continue
    }
    if ($tokens[1..($tokens.Count - 1)] -contains $expectedUser) {
      return $true
    }
  }

  return $false
}

function Get-WireGuardListenAddressEvidence {
  param(
    [string]$InterfaceAlias,
    [string]$ListenAddress
  )

  $parsedAddress = [System.Net.IPAddress]::None
  $addressIsConcrete = -not [string]::IsNullOrWhiteSpace($InterfaceAlias) -and
    -not [string]::IsNullOrWhiteSpace($ListenAddress) -and
    [System.Net.IPAddress]::TryParse($ListenAddress, [ref]$parsedAddress) -and
    -not $parsedAddress.Equals([System.Net.IPAddress]::Any) -and
    -not $parsedAddress.Equals([System.Net.IPAddress]::IPv6Any) -and
    -not $parsedAddress.Equals([System.Net.IPAddress]::Loopback) -and
    -not $parsedAddress.Equals([System.Net.IPAddress]::IPv6Loopback)
  $ownedAddress = if ($addressIsConcrete) {
    Get-NetIPAddress -InterfaceAlias $InterfaceAlias -IPAddress $parsedAddress.IPAddressToString -ErrorAction SilentlyContinue | Select-Object -First 1
  } else {
    $null
  }
  return [pscustomobject]@{
    wireGuardInterfaceAlias = $InterfaceAlias
    wireGuardListenAddress = $ListenAddress
    addressIsConcrete = [bool]$addressIsConcrete
    addressOwnedByInterface = $null -ne $ownedAddress
  }
}

function Get-OpenSshServerExePath {
  foreach ($candidate in @(
      "C:\Program Files\OpenSSH\sshd.exe",
      "C:\Windows\System32\OpenSSH\sshd.exe"
    )) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  $command = Get-Command "sshd.exe" -ErrorAction SilentlyContinue
  if ($null -eq $command) { $command = Get-Command "sshd" -ErrorAction SilentlyContinue }
  if ($null -ne $command) { return [string]$command.Source }
  return $null
}

function Get-ControlledMaintenanceIngressSshdState {
  param(
    [string]$ConfigPath,
    [string]$MaintenanceUser,
    [string]$CaPath,
    [string]$ListenAddress
  )

  $sshdExePath = Get-OpenSshServerExePath
  $values = @{}
  $syntaxValid = $false
  $syntaxError = $null
  if (-not [string]::IsNullOrWhiteSpace($sshdExePath) -and (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    $syntaxOutput = @(& $sshdExePath -t -f $ConfigPath 2>&1)
    $syntaxValid = $LASTEXITCODE -eq 0
    if (-not $syntaxValid) { $syntaxError = $syntaxOutput -join "; " }
    if ($syntaxValid) {
      $effectiveOutput = @(& $sshdExePath -T -f $ConfigPath -C "user=$($MaintenanceUser.ToLowerInvariant()),host=localhost,addr=127.0.0.1" 2>&1)
      if ($LASTEXITCODE -ne 0) {
        $syntaxValid = $false
        $syntaxError = $effectiveOutput -join "; "
      } else {
        foreach ($line in $effectiveOutput) {
          $parts = ([string]$line).Trim() -split "\s+", 2
          if ($parts.Count -eq 2 -and -not $values.ContainsKey($parts[0])) { $values[$parts[0]] = $parts[1] }
        }
      }
    }
  }
  $listeners = @(Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [string]$_.LocalAddress })
  $actualListenAddress = [string]$values.listenaddress
  return [pscustomobject]@{
    syntaxValid = $syntaxValid
    syntaxError = $syntaxError
    listenAddress = $actualListenAddress
    listenAddressMatches = $actualListenAddress -ceq "$ListenAddress`:22"
    onlyDeclaredWireGuardListener = $listeners.Count -gt 0 -and @($listeners | Where-Object { $_ -cne $ListenAddress }).Count -eq 0
    trustedUserCaKeys = [string]$values.trustedusercakeys -ceq $CaPath
    pubkeyAuthentication = [string]$values.pubkeyauthentication -ceq "yes"
    passwordAuthentication = [string]$values.passwordauthentication -ceq "no"
    keyboardInteractiveAuthentication = [string]$values.kbdinteractiveauthentication -ceq "no"
    authenticationMethods = [string]$values.authenticationmethods -ceq "publickey"
    authorizedKeysFile = [string]$values.authorizedkeysfile -ceq "none"
    authorizedKeysCommand = [string]$values.authorizedkeyscommand -ceq "none"
    authorizedKeysCommandUser = [string]$values.authorizedkeyscommanduser -ceq "nobody"
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

function Get-ControlledMaintenanceIngressFirewallState {
  param(
    [string[]]$SourceAllowlist,
    [string]$InterfaceAlias
  )

  $ruleName = "VEM Controlled Maintenance SSH"
  try {
    $normalizedExpectedRemoteAddresses = Assert-ControlledMaintenanceIngressSourceAllowlist -SourceAllowlist $SourceAllowlist
  } catch {
    return [pscustomobject]@{
      ruleName = $ruleName
      exists = $false
      ok = $false
      expectedRemoteAddress = @()
      defaultOpenSshInboundRulesEnabled = @()
      error = [string]$_.Exception.Message
    }
  }

  try {
    $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -eq $rule) {
      return [pscustomobject]@{
        ruleName = $ruleName
        exists = $false
        ok = $false
        defaultOpenSshInboundRulesEnabled = @()
        error = $null
      }
    }

    $portFilter = $rule | Get-NetFirewallPortFilter
    $addressFilter = $rule | Get-NetFirewallAddressFilter
    $interfaceFilter = $rule | Get-NetFirewallInterfaceFilter
    $defaultOpenSshInboundRulesEnabled = @(Get-NetFirewallRule -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Direction -eq "Inbound" -and
        $_.DisplayName -like "OpenSSH*" -and
        $_.DisplayName -ne $ruleName -and
        $_.Enabled -eq "True"
      } |
      Select-Object -ExpandProperty DisplayName)

    $remoteAddresses = @($addressFilter.RemoteAddress)
    $normalizedRemoteAddresses = @()
    $remoteAddressValidationError = $null
    try {
      $normalizedRemoteAddresses = Assert-ControlledMaintenanceIngressSourceAllowlist -SourceAllowlist $remoteAddresses
    } catch {
      $remoteAddressValidationError = [string]$_.Exception.Message
    }
    $missingRemoteAddresses = @($normalizedExpectedRemoteAddresses | Where-Object { $normalizedRemoteAddresses -notcontains $_ })
    $extraRemoteAddresses = @($normalizedRemoteAddresses | Where-Object { $normalizedExpectedRemoteAddresses -notcontains $_ })
    $remoteAddressMatches = $null -eq $remoteAddressValidationError -and
      $normalizedRemoteAddresses.Count -eq $normalizedExpectedRemoteAddresses.Count -and
      $missingRemoteAddresses.Count -eq 0 -and
      $extraRemoteAddresses.Count -eq 0
    $ok = $rule.Enabled -eq "True" -and
      $rule.Direction -eq "Inbound" -and
      $rule.Action -eq "Allow" -and
      $portFilter.Protocol -eq "TCP" -and
      $portFilter.LocalPort -eq "22" -and
      [string]$interfaceFilter.InterfaceAlias -ceq $InterfaceAlias -and
      [string]$interfaceFilter.InterfaceAlias -cne "Any" -and
      $remoteAddressMatches -and
      $defaultOpenSshInboundRulesEnabled.Count -eq 0

    return [pscustomobject]@{
      ruleName = $ruleName
      exists = $true
      enabled = [string]$rule.Enabled
      direction = [string]$rule.Direction
      action = [string]$rule.Action
      profile = [string]$rule.Profile
      protocol = [string]$portFilter.Protocol
      localPort = [string]$portFilter.LocalPort
      interfaceAlias = [string]$interfaceFilter.InterfaceAlias
      expectedInterfaceAlias = $InterfaceAlias
      remoteAddress = $remoteAddresses
      normalizedRemoteAddress = @($normalizedRemoteAddresses)
      expectedRemoteAddress = @($normalizedExpectedRemoteAddresses)
      missingRemoteAddress = @($missingRemoteAddresses)
      extraRemoteAddress = @($extraRemoteAddresses)
      defaultOpenSshInboundRulesEnabled = $defaultOpenSshInboundRulesEnabled
      ok = [bool]$ok
      error = $remoteAddressValidationError
    }
  } catch {
    return [pscustomobject]@{
      ruleName = $ruleName
      exists = $false
      ok = $false
      defaultOpenSshInboundRulesEnabled = @()
      error = [string]$_.Exception.Message
    }
  }
}

function Get-KioskShellState([string]$Sid, [string]$ExpectedShell) {
  $shellLauncherState = [pscustomobject]@{
    available = $false
    shell = $null
    configured = $false
    error = $null
  }
  $shellLauncher = Get-CimClass -Namespace "root\standardcimv2\embedded" -ClassName "WESL_UserSetting" -ErrorAction SilentlyContinue
  if ($null -ne $shellLauncher) {
    try {
      $customShell = Invoke-CimMethod -Namespace "root\standardcimv2\embedded" -ClassName "WESL_UserSetting" -MethodName GetCustomShell -Arguments @{ Sid = $Sid }
      $shellLauncherState = [pscustomobject]@{
        available = $true
        shell = $customShell.Shell
        configured = ([string]$customShell.Shell) -eq $ExpectedShell
        error = $null
      }
    } catch {
      $shellLauncherState = [pscustomobject]@{
        available = $true
        shell = $null
        configured = $false
        error = [string]$_.Exception.Message
      }
    }
  }

  $userWinlogonPath = "Registry::HKEY_USERS\$Sid\Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
  $shell = $null
  if (Test-Path $userWinlogonPath) {
    $shell = (Get-ItemProperty -Path $userWinlogonPath -Name "Shell" -ErrorAction SilentlyContinue).Shell
  } else {
    $profile = Get-CimInstance Win32_UserProfile -Filter "SID='$Sid'" -ErrorAction SilentlyContinue
    $profilePath = if ($null -ne $profile -and -not [string]::IsNullOrWhiteSpace($profile.LocalPath)) {
      $profile.LocalPath
    } else {
      $null
    }
    $hivePath = if ($null -ne $profilePath) { Join-Path $profilePath "NTUSER.DAT" } else { $null }
    if ($null -ne $hivePath -and (Test-Path -LiteralPath $hivePath)) {
      $tempHive = "VEMKioskVerify-$($Sid.Replace('-', '_'))"
      $loaded = $false
      try {
        reg.exe load "HKU\$tempHive" $hivePath | Out-Null
        if ($LASTEXITCODE -eq 0) {
          $loaded = $true
          $offlineWinlogonPath = "Registry::HKEY_USERS\$tempHive\Software\Microsoft\Windows NT\CurrentVersion\Winlogon"
          if (Test-Path $offlineWinlogonPath) {
            $shell = (Get-ItemProperty -Path $offlineWinlogonPath -Name "Shell" -ErrorAction SilentlyContinue).Shell
          }
        }
      } finally {
        if ($loaded) {
          [gc]::Collect()
          [gc]::WaitForPendingFinalizers()
          reg.exe unload "HKU\$tempHive" | Out-Null
        }
      }
    }
  }
  $winlogonConfigured = ([string]$shell) -eq $ExpectedShell
  $configured = if ([bool]$shellLauncherState.available) {
    $winlogonConfigured -and [bool]$shellLauncherState.configured
  } else {
    $winlogonConfigured
  }
  return [pscustomobject]@{
    mode = if ([bool]$shellLauncherState.available) { "Shell Launcher + per-user Winlogon shell" } else { "per-user Winlogon shell" }
    shell = $shell
    winlogonShell = $shell
    shellLauncher = $shellLauncherState
    expectedShell = $ExpectedShell
    configured = $configured
  }
}

$failures = [System.Collections.Generic.List[string]]::new()
$kiosk = Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue
$maintenance = Get-LocalUser -Name $MaintenanceUser -ErrorAction SilentlyContinue
$kioskSid = Get-LocalAccountSidOrNull -User $KioskUser

if ($null -eq $kiosk) {
  Add-Failure $failures "kiosk account not found: $KioskUser"
}
if ($null -eq $maintenance) {
  Add-Failure $failures "maintenance account not found: $MaintenanceUser"
}
if ($null -eq $kioskSid) {
  Add-Failure $failures "could not resolve kiosk account SID: $KioskUser"
}

$kioskIsAdmin = Test-LocalUserInGroup -User $KioskUser -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-544")
$maintenanceIsAdmin = Test-LocalUserInGroup -User $MaintenanceUser -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-544")
if ($kioskIsAdmin) {
  Add-Failure $failures "kiosk account is a local administrator: $KioskUser"
}
if (-not $maintenanceIsAdmin) {
  Add-Failure $failures "maintenance account is not a local administrator: $MaintenanceUser"
}

$maintenanceInOpenSshUsers = Test-LocalUserInGroup -User $MaintenanceUser -Group "OpenSSH Users"
$kioskInOpenSshUsers = Test-LocalUserInGroup -User $KioskUser -Group "OpenSSH Users"
$kioskInRemoteDesktopUsers = Test-LocalUserInGroup -User $KioskUser -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-555")
if (-not $maintenanceInOpenSshUsers) {
  Add-Failure $failures "maintenance account is not allowed through OpenSSH Users: $MaintenanceUser"
}
if ($kioskInOpenSshUsers) {
  Add-Failure $failures "kiosk account is allowed through OpenSSH Users: $KioskUser"
}
if ($kioskInRemoteDesktopUsers) {
  Add-Failure $failures "kiosk account is allowed through Remote Desktop Users: $KioskUser"
}
$kioskUserForSshdDeny = $KioskUser.ToLowerInvariant()
$sshdConfigDeniesKioskUser = Test-SshdConfigDeniesUser -ConfigPath $SshdConfigPath -User $kioskUserForSshdDeny
if (-not $sshdConfigDeniesKioskUser) {
  Add-Failure $failures "sshd_config does not deny the lowercase kiosk account: $kioskUserForSshdDeny"
}

$wireGuardListenAddressEvidence = Get-WireGuardListenAddressEvidence -InterfaceAlias $MaintenanceWireGuardInterfaceAlias -ListenAddress $MaintenanceWireGuardListenAddress
if (-not [bool]$wireGuardListenAddressEvidence.addressIsConcrete -or -not [bool]$wireGuardListenAddressEvidence.addressOwnedByInterface) {
  Add-Failure $failures "Controlled Maintenance Ingress requires the declared concrete WireGuard listener address on its interface"
}

$controlledMaintenanceIngressFirewall = Get-ControlledMaintenanceIngressFirewallState -SourceAllowlist $MaintenanceIngressSourceAllowlist -InterfaceAlias $MaintenanceWireGuardInterfaceAlias
if (-not [bool]$controlledMaintenanceIngressFirewall.ok) {
  Add-Failure $failures "VEM Controlled Maintenance SSH firewall rule is missing, too broad, not scoped to the declared WireGuard interface, does not match the explicit allowlist, or default OpenSSH inbound rules remain enabled"
}

$sshdEffectiveConfig = Get-ControlledMaintenanceIngressSshdState -ConfigPath $SshdConfigPath -MaintenanceUser $MaintenanceUser -CaPath $MaintenanceSshCaPublicKeyPath -ListenAddress $MaintenanceWireGuardListenAddress
if (-not [bool]$sshdEffectiveConfig.syntaxValid -or
    -not [bool]$sshdEffectiveConfig.listenAddressMatches -or
    -not [bool]$sshdEffectiveConfig.onlyDeclaredWireGuardListener -or
    -not [bool]$sshdEffectiveConfig.trustedUserCaKeys -or
    -not [bool]$sshdEffectiveConfig.pubkeyAuthentication -or
    -not [bool]$sshdEffectiveConfig.passwordAuthentication -or
    -not [bool]$sshdEffectiveConfig.keyboardInteractiveAuthentication -or
    -not [bool]$sshdEffectiveConfig.authenticationMethods -or
    -not [bool]$sshdEffectiveConfig.authorizedKeysFile -or
    -not [bool]$sshdEffectiveConfig.authorizedKeysCommand -or
    -not [bool]$sshdEffectiveConfig.authorizedKeysCommandUser) {
  Add-Failure $failures "effective sshd configuration must require the declared TrustedUserCAKeys certificate policy, publickey authentication, disabled password/keyboard-interactive authentication, and no authorized-key file or command bypass on the WireGuard listener"
}

$sshdService = Get-ServiceStateOrNull -Name "sshd"
if ($null -eq $sshdService) {
  Add-Failure $failures "OpenSSH Server service sshd is not installed"
} else {
  if ($sshdService.status -ne "Running") {
    Add-Failure $failures "OpenSSH Server service sshd is not running"
  }
  if ($sshdService.startType -ne "Automatic") {
    Add-Failure $failures "OpenSSH Server service sshd is not automatic"
  }
}

$port22 = Test-NetConnection -ComputerName $MaintenanceWireGuardListenAddress -Port 22 -WarningAction SilentlyContinue
if (-not [bool]$port22.TcpTestSucceeded) {
  Add-Failure $failures "OpenSSH port 22 is not reachable on the declared WireGuard listener"
}

if (-not [bool]$MaintenanceIngressConfirmed) {
  Add-Failure $failures "manual Controlled Maintenance Ingress SSH login not confirmed"
}
if ([string]::IsNullOrWhiteSpace($NegativeKioskSshEvidence)) {
  Add-Failure $failures "negative kiosk SSH attempt evidence is required"
}

$normalLauncher = Read-TextIfExists -Path $MachineUiLauncher
$debugLauncher = Read-TextIfExists -Path $MachineUiDebugLauncher
if ($null -eq $normalLauncher) {
  Add-Failure $failures "normal launcher not found: $MachineUiLauncher"
} elseif ($normalLauncher -match "remote-debugging-port") {
  Add-Failure $failures "normal kiosk launcher enables WebView CDP"
}
if ($null -eq $debugLauncher) {
  Add-Failure $failures "maintenance debug launcher not found: $MachineUiDebugLauncher"
} elseif ($debugLauncher -notmatch "remote-debugging-port=9222") {
  Add-Failure $failures "maintenance debug launcher does not explicitly enable WebView CDP"
}

$expectedShell = ('"{0}"' -f $MachineUiExe)
$shellState = if ($null -ne $kioskSid) { Get-KioskShellState -Sid $kioskSid -ExpectedShell $expectedShell } else { $null }

$port9222 = Test-NetConnection -ComputerName "127.0.0.1" -Port 9222 -WarningAction SilentlyContinue
if ([bool]$port9222.TcpTestSucceeded) {
  Add-Failure $failures "WebView CDP port 9222 is reachable in the current launch state"
}

$manualTouchChecks = [ordered]@{
  touchEdgeGesturesBlocked = [bool]$TouchEdgeGesturesBlocked
  closeMinimizeControlsUnavailable = [bool]$CloseMinimizeControlsUnavailable
  desktopShellUnavailable = [bool]$DesktopShellUnavailable
  debugRoutesUnavailable = [bool]$DebugRoutesUnavailable
  maintenanceRecoveryConfirmed = [bool]$MaintenanceRecoveryConfirmed
  maintenanceIngressConfirmed = [bool]$MaintenanceIngressConfirmed
}

foreach ($property in $manualTouchChecks.GetEnumerator()) {
  if (-not [bool]$property.Value) {
    Add-Failure $failures "manual touch-screen check not confirmed: $($property.Key)"
  }
}

$tasks = [ordered]@{}
foreach ($taskName in @("VEMMachineUI", "VEMMaintenanceUI")) {
  $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $tasks[$taskName] = if ($null -eq $task) {
    $null
  } else {
    [pscustomobject]@{
      taskName = $task.TaskName
      userId = $task.Principal.UserId
      logonType = [string]$task.Principal.LogonType
      runLevel = [string]$task.Principal.RunLevel
    }
  }
}

$machineUiTask = $tasks["VEMMachineUI"]
$shellLauncherAvailable = $null -ne $shellState -and [bool]$shellState.shellLauncher.available
if ($shellLauncherAvailable) {
  if (-not [bool]$shellState.configured) {
    Add-Failure $failures "OS-level kiosk shell is not configured for $KioskUser with expected shell $expectedShell"
  }
  if ($null -ne $machineUiTask -and (Test-PrincipalMatches -Principal $machineUiTask.userId -User $KioskUser)) {
    Add-Failure $failures "VEMMachineUI task still targets kiosk user while Shell Launcher should own the kiosk UI process"
  }
} elseif ($null -eq $machineUiTask -or -not (Test-PrincipalMatches -Principal $machineUiTask.userId -User $KioskUser)) {
  Add-Failure $failures "VEMMachineUI task must be the kiosk UI owner when Shell Launcher is unavailable"
}
$maintenanceUiTask = $tasks["VEMMaintenanceUI"]
if ($MaintenanceDebugTaskExpected -and $null -eq $maintenanceUiTask) {
  Add-Failure $failures "VEMMaintenanceUI maintenance debug task is not registered"
} elseif ($MaintenanceDebugTaskExpected -and -not (Test-PrincipalMatches -Principal $maintenanceUiTask.userId -User $MaintenanceUser)) {
  Add-Failure $failures "VEMMaintenanceUI task principal is not the maintenance user: $($maintenanceUiTask.userId)"
} elseif (-not $MaintenanceDebugTaskExpected -and $null -ne $maintenanceUiTask) {
  Add-Failure $failures "unexpected VEMMaintenanceUI maintenance debug task is registered without -MaintenanceDebugTaskExpected"
}

$result = [pscustomobject]@{
  ok = $failures.Count -eq 0
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  failures = @($failures)
  accounts = [pscustomobject]@{
    kioskUser = $KioskUser
    kioskSid = $kioskSid
    kioskEnabled = if ($null -ne $kiosk) { [bool]$kiosk.Enabled } else { $false }
    kioskIsAdministrator = $kioskIsAdmin
    kioskInRemoteDesktopUsers = $kioskInRemoteDesktopUsers
    maintenanceUser = $MaintenanceUser
    maintenanceEnabled = if ($null -ne $maintenance) { [bool]$maintenance.Enabled } else { $false }
    maintenanceIsAdministrator = $maintenanceIsAdmin
  }
  controlledMaintenanceIngress = [pscustomobject]@{
    sshd = $sshdService
    localPort22Reachable = [bool]$port22.TcpTestSucceeded
    sshdConfigPath = $SshdConfigPath
    sshdConfigDeniesKioskUser = $sshdConfigDeniesKioskUser
    sshdConfigDenyUsersExpectedLowercase = $kioskUserForSshdDeny
    maintenanceInOpenSshUsers = $maintenanceInOpenSshUsers
    kioskInOpenSshUsers = $kioskInOpenSshUsers
    kioskInRemoteDesktopUsers = $kioskInRemoteDesktopUsers
    maintenanceIngressSourceAllowlist = @($MaintenanceIngressSourceAllowlist)
    firewall = $controlledMaintenanceIngressFirewall
    wireGuardListenAddressEvidence = $wireGuardListenAddressEvidence
    sshdEffectiveConfig = $sshdEffectiveConfig
    hitlMaintenanceIngressConfirmed = [bool]$MaintenanceIngressConfirmed
    negativeKioskSshEvidence = $NegativeKioskSshEvidence
  }
  launchers = [pscustomobject]@{
    normalPath = $MachineUiLauncher
    normalHasRemoteDebugging = if ($null -ne $normalLauncher) { $normalLauncher -match "remote-debugging-port" } else { $null }
    debugPath = $MachineUiDebugLauncher
    debugHasRemoteDebugging = if ($null -ne $debugLauncher) { $debugLauncher -match "remote-debugging-port=9222" } else { $null }
  }
  shell = $shellState
  tasks = $tasks
  maintenanceDebugTaskExpected = [bool]$MaintenanceDebugTaskExpected
  webViewCdp = [pscustomobject]@{
    port = 9222
    reachable = [bool]$port9222.TcpTestSucceeded
  }
  manualTouchChecks = $manualTouchChecks
}

$parent = Split-Path -Parent $EvidencePath
if (-not [string]::IsNullOrWhiteSpace($parent) -and -not (Test-Path -LiteralPath $parent)) {
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
}

$json = $result | ConvertTo-Json -Depth 20
Set-Content -LiteralPath $EvidencePath -Value $json -Encoding UTF8
$json

if ($failures.Count -gt 0) {
  exit 1
}
