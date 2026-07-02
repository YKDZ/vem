param(
  [string]$KioskUser = "VEMKiosk",
  [string]$MaintenanceUser = "Admin",
  [string]$MachineUiExe = "C:\VEM\bringup\machine.exe",
  [string]$MachineUiLauncher = "C:\VEM\bringup\launch-machine-ui.vbs",
  [string]$MachineUiDebugLauncher = "C:\VEM\bringup\launch-machine-ui-debug.vbs",
  [string]$TailscaleExe = "C:\Program Files\Tailscale\tailscale.exe",
  [string]$SshdConfigPath = "C:\ProgramData\ssh\sshd_config",
  [string]$EvidencePath = "C:\ProgramData\VEM\kiosk-lockdown-evidence.json",

  [switch]$TouchEdgeGesturesBlocked,
  [switch]$CloseMinimizeControlsUnavailable,
  [switch]$DesktopShellUnavailable,
  [switch]$DebugRoutesUnavailable,
  [switch]$MaintenanceRecoveryConfirmed,
  [switch]$RemoteMaintenanceConfirmed,
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

function Test-LocalUserInGroup([string]$User, [string]$Group) {
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

function Get-TailscaleStatus([string]$TailscalePath) {
  $service = Get-ServiceStateOrNull -Name "Tailscale"
  $state = [ordered]@{
    service = $service
    cliPath = $TailscalePath
    cliExists = Test-Path -LiteralPath $TailscalePath
    backendState = $null
    tailscaleIps = @()
    error = $null
  }

  if (-not [bool]$state.cliExists) {
    $state.error = "Tailscale CLI not found"
    return [pscustomobject]$state
  }

  try {
    $raw = & $TailscalePath status --json 2>&1
    if ($LASTEXITCODE -ne 0) {
      $state.error = [string]($raw -join "`n")
    } else {
      try {
        $parsed = ($raw | Out-String) | ConvertFrom-Json
        $state.backendState = $parsed.BackendState
        $state.tailscaleIps = @($parsed.Self.TailscaleIPs)
      } catch {
        $state.error = [string]$_.Exception.Message
      }
    }

    if (@($state.tailscaleIps).Count -eq 0) {
      $ipRaw = & $TailscalePath ip -4 2>&1
      if ($LASTEXITCODE -eq 0) {
        $state.backendState = "Running"
        $state.tailscaleIps = @($ipRaw | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        $state.error = $null
      }
    }
  } catch {
    $state.error = [string]$_.Exception.Message
  }

  return [pscustomobject]$state
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

function Get-VemTailscaleSshFirewallState {
  $ruleName = "VEM Tailscale SSH"
  $expectedRemoteAddresses = @("100.64.0.0/10", "100.64.0.0/255.192.0.0")
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
    $defaultOpenSshInboundRulesEnabled = @(Get-NetFirewallRule -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Direction -eq "Inbound" -and
        $_.DisplayName -like "OpenSSH*" -and
        $_.DisplayName -ne $ruleName -and
        $_.Enabled -eq "True"
      } |
      Select-Object -ExpandProperty DisplayName)

    $remoteAddresses = @($addressFilter.RemoteAddress)
    $ok = $rule.Enabled -eq "True" -and
      $rule.Direction -eq "Inbound" -and
      $rule.Action -eq "Allow" -and
      $portFilter.Protocol -eq "TCP" -and
      $portFilter.LocalPort -eq "22" -and
      @($remoteAddresses | Where-Object { $expectedRemoteAddresses -contains $_ }).Count -gt 0 -and
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
      remoteAddress = $remoteAddresses
      expectedRemoteAddress = $expectedRemoteAddresses[0]
      defaultOpenSshInboundRulesEnabled = $defaultOpenSshInboundRulesEnabled
      ok = [bool]$ok
      error = $null
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
  $shellLauncher = Get-CimClass -Namespace "root\standardcimv2\embedded" -ClassName "WESL_UserSetting" -ErrorAction SilentlyContinue
  if ($null -ne $shellLauncher) {
    try {
      $customShell = Invoke-CimMethod -Namespace "root\standardcimv2\embedded" -ClassName "WESL_UserSetting" -MethodName GetCustomShell -Arguments @{ Sid = $Sid }
      return [pscustomobject]@{
        mode = "Shell Launcher"
        shell = $customShell.Shell
        expectedShell = $ExpectedShell
        configured = ([string]$customShell.Shell) -eq $ExpectedShell
      }
    } catch {
      return [pscustomobject]@{
        mode = "Shell Launcher"
        shell = $null
        expectedShell = $ExpectedShell
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
  return [pscustomobject]@{
    mode = "per-user Winlogon shell"
    shell = $shell
    expectedShell = $ExpectedShell
    configured = ([string]$shell) -eq $ExpectedShell
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

$kioskIsAdmin = Test-LocalUserInGroup -User $KioskUser -Group "Administrators"
$maintenanceIsAdmin = Test-LocalUserInGroup -User $MaintenanceUser -Group "Administrators"
if ($kioskIsAdmin) {
  Add-Failure $failures "kiosk account is a local administrator: $KioskUser"
}
if (-not $maintenanceIsAdmin) {
  Add-Failure $failures "maintenance account is not a local administrator: $MaintenanceUser"
}

$maintenanceInOpenSshUsers = Test-LocalUserInGroup -User $MaintenanceUser -Group "OpenSSH Users"
$kioskInOpenSshUsers = Test-LocalUserInGroup -User $KioskUser -Group "OpenSSH Users"
$kioskInRemoteDesktopUsers = Test-LocalUserInGroup -User $KioskUser -Group "Remote Desktop Users"
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

$tailscaleSshFirewall = Get-VemTailscaleSshFirewallState
if (-not [bool]$tailscaleSshFirewall.ok) {
  Add-Failure $failures "VEM Tailscale SSH firewall rule is missing, too broad, or default OpenSSH inbound rules remain enabled"
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

$port22 = Test-NetConnection -ComputerName "127.0.0.1" -Port 22 -WarningAction SilentlyContinue
if (-not [bool]$port22.TcpTestSucceeded) {
  Add-Failure $failures "OpenSSH port 22 is not reachable locally"
}

$tailscaleStatus = Get-TailscaleStatus -TailscalePath $TailscaleExe
if ($null -eq $tailscaleStatus.service) {
  Add-Failure $failures "Tailscale service is not installed"
} elseif ($tailscaleStatus.service.status -ne "Running") {
  Add-Failure $failures "Tailscale service is not running"
}
if ($tailscaleStatus.backendState -ne "Running") {
  Add-Failure $failures "Tailscale backend is not running"
}
if (@($tailscaleStatus.tailscaleIps).Count -eq 0) {
  Add-Failure $failures "Tailscale has no assigned IPs"
}
if (-not [bool]$RemoteMaintenanceConfirmed) {
  Add-Failure $failures "manual remote maintenance SSH login not confirmed"
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
if ($null -eq $shellState -or -not [bool]$shellState.configured) {
  Add-Failure $failures "OS-level kiosk shell is not configured for $KioskUser with expected shell $expectedShell"
}

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
  remoteMaintenanceConfirmed = [bool]$RemoteMaintenanceConfirmed
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
if ($null -ne $machineUiTask -and (Test-PrincipalMatches -Principal $machineUiTask.userId -User $KioskUser)) {
  Add-Failure $failures "VEMMachineUI task still targets kiosk user while Shell Launcher should own the kiosk UI process"
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
  remoteMaintenance = [pscustomobject]@{
    sshd = $sshdService
    localPort22Reachable = [bool]$port22.TcpTestSucceeded
    sshdConfigPath = $SshdConfigPath
    sshdConfigDeniesKioskUser = $sshdConfigDeniesKioskUser
    sshdConfigDenyUsersExpectedLowercase = $kioskUserForSshdDeny
    maintenanceInOpenSshUsers = $maintenanceInOpenSshUsers
    kioskInOpenSshUsers = $kioskInOpenSshUsers
    kioskInRemoteDesktopUsers = $kioskInRemoteDesktopUsers
    firewall = $tailscaleSshFirewall
    tailscale = $tailscaleStatus
    hitlRemoteMaintenanceConfirmed = [bool]$RemoteMaintenanceConfirmed
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
