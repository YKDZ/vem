# VEM scripted factory runtime verifier.

[CmdletBinding()]
param(
  [string]$ManifestPath = "C:\ProgramData\VEM\factory\factory-runtime-manifest.json",
  [string]$EvidencePath = "C:\ProgramData\VEM\evidence\factory-runtime-verification.json"
)

$ErrorActionPreference = "Stop"

function Add-Failure {
  param(
    [System.Collections.Generic.List[string]]$Failures,
    [string]$Message
  )

  $Failures.Add($Message) | Out-Null
}

function Get-WireGuardTunnelServiceName {
  return 'WireGuardTunnel$VEM-Maintenance'
}

function Ensure-Directory {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path -Force | Out-Null
  }
}

function Read-JsonFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "file not found: $Path"
  }
  return [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
}

function Write-Evidence {
  param(
    [string]$Path,
    [object]$Evidence
  )

  Ensure-Directory -Path (Split-Path -Parent $Path)
  $json = $Evidence | ConvertTo-Json -Depth 30
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Normalize-Sha256 {
  param([string]$Value)

  $normalized = $Value.Trim().ToLowerInvariant()
  if ($normalized -notmatch "^[0-9a-f]{64}$") {
    throw "sha256 must be 64 hex characters"
  }
  return $normalized
}

function Assert-Sha256 {
  param(
    [string]$Path,
    [string]$ExpectedSha256,
    [System.Collections.Generic.List[string]]$Failures
  )

  $expected = Normalize-Sha256 -Value $ExpectedSha256
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Add-Failure $Failures "component file missing: $Path"
    return [pscustomobject]@{
      path = $Path
      expectedSha256 = $expected
      actualSha256 = $null
      ok = $false
    }
  }

  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  $ok = $actual -eq $expected
  if (-not $ok) {
    Add-Failure $Failures "hash mismatch for $Path; expected $expected got $actual"
  }
  return [pscustomobject]@{
    path = $Path
    expectedSha256 = $expected
    actualSha256 = $actual
    ok = $ok
  }
}

function Test-PrincipalMatches {
  param(
    [string]$Principal,
    [string]$ExpectedUser
  )

  return $Principal -eq $ExpectedUser -or $Principal -eq ".\$ExpectedUser" -or $Principal -eq "$env:COMPUTERNAME\$ExpectedUser"
}

function Normalize-ShellCommand {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return ""
  }
  return $Value.Trim().Trim('"')
}

function Test-ShellCommandMatches {
  param(
    [string]$Shell,
    [string]$ExpectedShell
  )

  return (Normalize-ShellCommand -Value $Shell) -eq (Normalize-ShellCommand -Value $ExpectedShell)
}

function Get-ScheduledTaskEvidence {
  param([string]$TaskName)

  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    return [pscustomobject]@{
      exists = $false
      enabled = $false
      principal = $null
      command = $null
      arguments = $null
      workingDirectory = $null
    }
  }

  $action = @($task.Actions | Select-Object -First 1)
  return [pscustomobject]@{
    exists = $true
    enabled = [string]$task.State -ne "Disabled"
    principal = if ($null -ne $task.Principal) { [string]$task.Principal.UserId } else { $null }
    command = if ($action.Count -gt 0) { [string]$action[0].Execute } else { $null }
    arguments = if ($action.Count -gt 0) { [string]$action[0].Arguments } else { $null }
    workingDirectory = if ($action.Count -gt 0) { [string]$action[0].WorkingDirectory } else { $null }
  }
}

function Get-WinlogonEvidence {
  $winlogon = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -ErrorAction SilentlyContinue
  if ($null -eq $winlogon) {
    return [pscustomobject]@{
      configured = $false
      force = $false
      user = $null
      domain = $null
    }
  }

  return [pscustomobject]@{
    configured = [string]$winlogon.AutoAdminLogon -eq "1"
    force = [string]$winlogon.ForceAutoLogon -eq "1"
    user = if ([string]::IsNullOrWhiteSpace($winlogon.DefaultUserName)) { $null } else { [string]$winlogon.DefaultUserName }
    domain = if ([string]::IsNullOrWhiteSpace($winlogon.DefaultDomainName)) { $null } else { [string]$winlogon.DefaultDomainName }
  }
}

function Get-LocalAccountSidOrNull {
  param([string]$User)

  try {
    $account = New-Object System.Security.Principal.NTAccount($env:COMPUTERNAME, $User)
    return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
  } catch {
    return $null
  }
}

function Get-KioskShellEvidence {
  param(
    [string]$Sid,
    [string]$ExpectedShell
  )

  $shellLauncherEvidence = [pscustomobject]@{
    available = $false
    shell = $null
    configured = $false
    error = $null
  }
  $shellLauncher = Get-CimClass -Namespace "root\standardcimv2\embedded" -ClassName "WESL_UserSetting" -ErrorAction SilentlyContinue
  if ($null -ne $shellLauncher) {
    try {
      $customShell = Invoke-CimMethod -Namespace "root\standardcimv2\embedded" -ClassName "WESL_UserSetting" -MethodName GetCustomShell -Arguments @{ Sid = $Sid }
      $shellLauncherEvidence = [pscustomobject]@{
        available = $true
        shell = $customShell.Shell
        configured = Test-ShellCommandMatches -Shell ([string]$customShell.Shell) -ExpectedShell $ExpectedShell
        error = $null
      }
    } catch {
      $shellLauncherEvidence = [pscustomobject]@{
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
      $tempHive = "VEMFactoryVerify-$($Sid.Replace('-', '_'))"
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

  $winlogonConfigured = Test-ShellCommandMatches -Shell ([string]$shell) -ExpectedShell $ExpectedShell
  $configured = if ([bool]$shellLauncherEvidence.available) {
    $winlogonConfigured -and [bool]$shellLauncherEvidence.configured
  } else {
    $winlogonConfigured
  }

  return [pscustomobject]@{
    mode = if ([bool]$shellLauncherEvidence.available) { "Shell Launcher + per-user Winlogon shell" } else { "per-user Winlogon shell" }
    shell = $shell
    winlogonShell = $shell
    shellLauncher = $shellLauncherEvidence
    expectedShell = $ExpectedShell
    configured = $configured
  }
}

function Get-DisplayEvidence {
  try {
    $video = Get-CimInstance -ClassName Win32_VideoController -ErrorAction Stop | Select-Object -First 1
    if ($null -ne $video -and $null -ne $video.CurrentHorizontalResolution -and $null -ne $video.CurrentVerticalResolution) {
      return [pscustomobject]@{
        available = $true
        width = [int]$video.CurrentHorizontalResolution
        height = [int]$video.CurrentVerticalResolution
        orientation = if ([int]$video.CurrentVerticalResolution -gt [int]$video.CurrentHorizontalResolution) { "portrait" } else { "landscape" }
        source = "Win32_VideoController"
      }
    }
  } catch {
    $videoError = $_.Exception.Message
  }

  try {
    $displayKeys = Get-ChildItem -Path "HKLM:\SYSTEM\CurrentControlSet\Control\GraphicsDrivers\Configuration" -Recurse -ErrorAction Stop
    $displayModes = @()
    foreach ($key in @($displayKeys)) {
      $value = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction SilentlyContinue
      $width = $value."ActiveSize.cx"
      $height = $value."ActiveSize.cy"
      if ($null -eq $width -or $null -eq $height) {
        $width = $value."PrimSurfSize.cx"
        $height = $value."PrimSurfSize.cy"
      }
      if ($null -ne $width -and $null -ne $height -and [int]$width -gt 0 -and [int]$height -gt 0) {
        $displayModes += [pscustomobject]@{
          width = [int]$width
          height = [int]$height
          orientation = if ([int]$height -gt [int]$width) { "portrait" } else { "landscape" }
          area = [int]$width * [int]$height
          registryPath = [string]$key.Name
        }
      }
    }
    $display = @($displayModes | Sort-Object -Property @{ Expression = { $_.orientation -eq "portrait" }; Descending = $true }, @{ Expression = "area"; Descending = $true } | Select-Object -First 1)
    if ($display.Count -gt 0) {
      return [pscustomobject]@{
        available = $true
        width = [int]$display[0].width
        height = [int]$display[0].height
        orientation = [string]$display[0].orientation
        source = "GraphicsDrivers.Configuration"
        registryPath = [string]$display[0].registryPath
        win32VideoControllerAvailable = $null -ne $video
      }
    }
  } catch {
    $registryError = $_.Exception.Message
  }

  return [pscustomobject]@{
    available = $false
    width = $null
    height = $null
    orientation = $null
    source = "display_unavailable"
    error = @(
      if ($videoError) { "Win32_VideoController: $videoError" }
      if ($registryError) { "GraphicsDrivers.Configuration: $registryError" }
    ) -join "; "
  }
}

function Read-DwordValue {
  param(
    [string]$Path,
    [string]$Name
  )

  $item = Get-ItemProperty -Path $Path -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $item) {
    return $null
  }
  return [int]$item.$Name
}

function Read-StringValue {
  param(
    [string]$Path,
    [string]$Name
  )

  $item = Get-ItemProperty -Path $Path -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $item) {
    return $null
  }
  return [string]$item.$Name
}

function Get-WindowsUpdatePolicyEvidence {
  $auPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU"
  $wuPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate"
  $noAutoUpdate = Read-DwordValue -Path $auPath -Name "NoAutoUpdate"
  $auOptions = Read-DwordValue -Path $auPath -Name "AUOptions"
  $noAutoReboot = Read-DwordValue -Path $auPath -Name "NoAutoRebootWithLoggedOnUsers"
  $setActiveHours = Read-DwordValue -Path $wuPath -Name "SetActiveHours"
  $activeHoursStart = Read-DwordValue -Path $wuPath -Name "ActiveHoursStart"
  $activeHoursEnd = Read-DwordValue -Path $wuPath -Name "ActiveHoursEnd"

  return [ordered]@{
    status = if ($noAutoUpdate -eq 1 -and $auOptions -eq 2 -and $noAutoReboot -eq 1) { "passed" } else { "failed" }
    automaticUpdateInstallation = if ($noAutoUpdate -eq 1 -and $auOptions -eq 2) { "disabled" } else { "enabled_or_unmanaged" }
    automaticRestart = if ($noAutoReboot -eq 1) { "disabled" } else { "enabled_or_unmanaged" }
    registry = [ordered]@{
      noAutoUpdate = $noAutoUpdate
      auOptions = $auOptions
      noAutoRebootWithLoggedOnUsers = $noAutoReboot
      setActiveHours = $setActiveHours
      activeHoursStart = $activeHoursStart
      activeHoursEnd = $activeHoursEnd
    }
  }
}

function Get-PowerPolicyEvidence {
  $powerSchemesPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes"
  $sleepSubgroupGuid = "238C9FA8-0AAD-41ED-83F4-97BE242C8F20"
  $standbyIdleGuid = "29F6C1DB-86DA-48C5-9FDB-F2B67B1F44DA"
  $activeSchemeGuid = Read-StringValue -Path $powerSchemesPath -Name "ActivePowerScheme"
  $activeSchemeSource = "registry"
  if ([string]::IsNullOrWhiteSpace($activeSchemeGuid)) {
    $powercfgActiveScheme = (powercfg.exe /getactivescheme 2>$null) -join "`n"
    if ($powercfgActiveScheme -match "([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})") {
      $activeSchemeGuid = $Matches[1]
      $activeSchemeSource = "powercfg_guid_fallback"
    }
  }
  $standbyPath = if ([string]::IsNullOrWhiteSpace($activeSchemeGuid)) {
    $null
  } else {
    Join-Path (Join-Path (Join-Path $powerSchemesPath $activeSchemeGuid) $sleepSubgroupGuid) $standbyIdleGuid
  }
  $acStandbySeconds = if ($null -ne $standbyPath) { Read-DwordValue -Path $standbyPath -Name "ACSettingIndex" } else { $null }
  $dcStandbySeconds = if ($null -ne $standbyPath) { Read-DwordValue -Path $standbyPath -Name "DCSettingIndex" } else { $null }
  $sleepDisabled = $acStandbySeconds -eq 0 -and $dcStandbySeconds -eq 0
  $hibernateEnabled = Read-DwordValue -Path "HKLM:\SYSTEM\CurrentControlSet\Control\Power" -Name "HibernateEnabled"
  $hibernationFile = Test-Path -LiteralPath "C:\hiberfil.sys"
  $hibernationDisabled = $hibernateEnabled -eq 0 -or ($null -eq $hibernateEnabled -and -not $hibernationFile)
  return [ordered]@{
    status = if ($sleepDisabled -and $hibernationDisabled) { "passed" } else { "failed" }
    sleep = if ($sleepDisabled) { "disabled" } else { "enabled_or_unmanaged" }
    hibernation = if ($hibernationDisabled) { "disabled" } else { "enabled_or_unmanaged" }
    activeScheme = $activeSchemeGuid
    activeSchemeSource = $activeSchemeSource
    standbyTimeoutSeconds = [ordered]@{
      ac = $acStandbySeconds
      dc = $dcStandbySeconds
    }
    registry = [ordered]@{
      standbyPath = $standbyPath
      hibernateEnabled = $hibernateEnabled
    }
    hibernationFilePresent = $hibernationFile
  }
}

function Get-BootPolicyEvidence {
  $bcd = (bcdedit.exe /enum "{current}" 2>$null) -join "`n"
  $testsigningEnabled = $bcd -match "(?im)^\s*testsigning\s+Yes\s*$"
  return [ordered]@{
    status = if ($testsigningEnabled) { "failed" } else { "passed" }
    testsigning = if ($testsigningEnabled) { "on" } else { "off" }
    source = "bcdedit /enum {current}"
  }
}

function Get-SecurityPostureEvidence {
  $defenderStatus = if (Get-Command Get-MpComputerStatus -ErrorAction SilentlyContinue) {
    Get-MpComputerStatus -ErrorAction SilentlyContinue
  } else {
    $null
  }
  $defenderPreference = if (Get-Command Get-MpPreference -ErrorAction SilentlyContinue) {
    Get-MpPreference -ErrorAction SilentlyContinue
  } else {
    $null
  }
  $firewallProfiles = Get-NetFirewallProfile -ErrorAction SilentlyContinue
  $vemRules = Get-NetFirewallRule -DisplayName "VEM *" -ErrorAction SilentlyContinue
  $fileSharingRulesEnabled = @(Get-NetFirewallRule -ErrorAction SilentlyContinue |
    Where-Object {
      $_.Direction -eq "Inbound" -and
      [string]$_.Enabled -eq "True" -and
      (
        [string]$_.DisplayGroup -eq "File and Printer Sharing" -or
        [string]$_.Group -eq "File and Printer Sharing" -or
        [string]$_.Group -match "FirewallAPI\.dll,-28502"
      )
    } |
    ForEach-Object { [string]$_.DisplayName })
  $requiredExclusions = @("C:\VEM\bringup", "C:\ProgramData\VEM")
  $actualExclusions = @()
  if ($null -ne $defenderPreference) {
    $actualExclusions = @($defenderPreference.ExclusionPath)
  }
  $missingExclusions = @($requiredExclusions | Where-Object { $actualExclusions -notcontains $_ })
  $firewallEnabled = @($firewallProfiles | Where-Object { -not [bool]$_.Enabled }).Count -eq 0 -and @($firewallProfiles).Count -gt 0
  $enabledVemInboundRules = @($vemRules | Where-Object { [string]$_.Enabled -eq "True" } | ForEach-Object { [string]$_.DisplayName })
  $disallowedEnabledVemInboundRules = @($enabledVemInboundRules | Where-Object { $_ -ne "VEM Controlled Maintenance SSH" })
  $defenderEnabled = if ($null -ne $defenderStatus) { [bool]$defenderStatus.AntispywareEnabled } else { $true }

  return [ordered]@{
    status = if ($defenderEnabled -and $firewallEnabled -and $disallowedEnabledVemInboundRules.Count -eq 0 -and $missingExclusions.Count -eq 0 -and $fileSharingRulesEnabled.Count -eq 0) { "passed" } else { "failed" }
    defender = if ($defenderEnabled) { "enabled" } else { "disabled" }
    firewall = if ($firewallEnabled) { "enabled" } else { "disabled_or_unavailable" }
    defenderExclusions = $actualExclusions
    missingDefenderExclusions = $missingExclusions
    inboundFirewallRules = @($vemRules | ForEach-Object { [string]$_.DisplayName })
    enabledVemInboundRules = @($enabledVemInboundRules)
    disallowedEnabledVemInboundRules = @($disallowedEnabledVemInboundRules)
    fileAndPrinterSharing = if ($fileSharingRulesEnabled.Count -eq 0) { "not_enabled" } else { "enabled" }
    fileAndPrinterSharingEnabledRules = $fileSharingRulesEnabled
  }
}

function Get-BuiltinLocalGroup {
  param([Parameter(Mandatory = $true)][string]$Sid)

  $group = Get-LocalGroup -SID ([Security.Principal.SecurityIdentifier]::new($Sid)) -ErrorAction Stop
  if ($null -eq $group) { throw "required builtin local group is unavailable: $Sid" }
  return $group
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
    $members = @(Get-LocalGroupMember -Group $currentGroup -ErrorAction SilentlyContinue)
    foreach ($member in $members) {
      $name = [string]$member.Name
      $leafName = ($name -split "\\")[-1]
      if ($leafName.Equals($User, [StringComparison]::OrdinalIgnoreCase)) { return $true }
      if ([string]$member.ObjectClass -eq "Group" -and -not [string]::IsNullOrWhiteSpace($leafName)) {
        $pending.Enqueue($leafName)
      }
    }
  }
  return $false
}

function Measure-AdministratorToSystemCompatibility {
  param(
    [string]$MaintenanceUser,
    [bool]$MaintenanceAdministrator
  )

  $taskName = "VEM-System-Elevation-Probe-$([guid]::NewGuid().ToString('N'))"
  $registered = $false
  $principal = $null
  $errorMessage = $null
  try {
    if (-not $MaintenanceAdministrator) { throw "maintenance user is not an administrator" }
    $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument "/d /c exit 0"
    $systemPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $taskName -Action $action -Principal $systemPrincipal -Settings $settings -Force | Out-Null
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $principal = [string]$task.Principal.UserId
    $registered = $principal -match "(?i)^(NT AUTHORITY\\)?SYSTEM$"
  } catch {
    $errorMessage = [string]$_
  } finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }
  return [ordered]@{
    maintenanceUser = $MaintenanceUser
    maintenanceAdministratorMeasured = $MaintenanceAdministrator
    probeTaskName = $taskName
    systemPrincipal = $principal
    registrationSucceeded = $registered
    error = $errorMessage
  }
}

function Test-SshdConfigDeniesUser {
  param(
    [string]$ConfigPath,
    [string]$User
  )

  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    return $false
  }

  $expectedUser = $User.ToLowerInvariant()
  foreach ($line in Get-Content -LiteralPath $ConfigPath) {
    $trimmed = $line.Trim()
    if ($trimmed.Length -eq 0 -or $trimmed.StartsWith("#")) {
      continue
    }
    $tokens = $trimmed -split "\s+"
    if ($tokens.Count -lt 2 -or -not $tokens[0].Equals("DenyUsers", [StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    $deniedUsers = @($tokens[1..($tokens.Count - 1)] | ForEach-Object { [string]$_ })
    if (@($deniedUsers | Where-Object { $_.ToLowerInvariant() -eq $expectedUser }).Count -gt 0) {
      return $true
    }
  }

  return $false
}

function Get-FactoryRemoteMaintenanceCapabilityEvidence {
  param(
    [string]$KioskUser,
    [string]$MaintenanceUser,
    $Manifest
  )

  $sshd = Get-Service -Name "sshd" -ErrorAction SilentlyContinue
  $tailscale = Get-Service -Name "Tailscale" -ErrorAction SilentlyContinue
  $tailscaleCli = Get-Command "tailscale.exe" -ErrorAction SilentlyContinue
  $sshdConfigPath = "C:\ProgramData\ssh\sshd_config"
  $kioskUserForSshdDeny = $KioskUser.ToLowerInvariant()
  $sshdConfigDeniesKioskUser = Test-SshdConfigDeniesUser -ConfigPath $sshdConfigPath -User $kioskUserForSshdDeny
  $maintenanceInOpenSshUsers = Test-LocalUserInGroup -User $MaintenanceUser -Group "OpenSSH Users"
  $kioskInOpenSshUsers = Test-LocalUserInGroup -User $KioskUser -Group "OpenSSH Users"
  $kioskInRemoteDesktopUsers = Test-LocalUserInGroup -User $KioskUser -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-555")
  $kioskInRemoteManagementUsers = Test-LocalUserInGroup -User $KioskUser -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-580")
  $kioskAdministrator = Test-LocalUserInGroup -User $KioskUser -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-544")
  $maintenanceAdministrator = Test-LocalUserInGroup -User $MaintenanceUser -Group (Get-BuiltinLocalGroup -Sid "S-1-5-32-544")
  $kioskRemoteAccessDenied = $sshdConfigDeniesKioskUser -and -not $kioskInOpenSshUsers -and -not $kioskInRemoteDesktopUsers -and -not $kioskInRemoteManagementUsers -and -not $kioskAdministrator
  $sshdReady = $null -ne $sshd -and [string]$sshd.Status -eq "Running" -and [string]$sshd.StartType -eq "Automatic"
  $tailscaleAbsent = $null -eq $tailscale -and $null -eq $tailscaleCli
  $sshdEffectiveConfig = Get-SshdEffectiveConfigEvidence -ConfigPath $sshdConfigPath -MaintenanceUser $MaintenanceUser -KioskUser $KioskUser -CaPath ([string]$Manifest.maintenanceSsh.caPath) -Manifest $Manifest
  $packageVersions = Get-FactoryPackageEvidence -Manifest $Manifest
  $caEvidence = Get-MaintenanceCaEvidence -Manifest $Manifest
  $firewallScope = Get-MaintenanceFirewallEvidence -Manifest $Manifest
  $ingress = Get-MaintenanceIngressEvidence -Manifest $Manifest
  $wireGuardService = Get-WireGuardServiceEvidence -Manifest $Manifest
  $accountPolicy = [ordered]@{
    profile = [string]$Manifest.factoryProfile
    maintenanceUser = $MaintenanceUser
    expectedMaintenanceUser = if ([string]$Manifest.factoryProfile -eq "production") { "Admin" } else { "YKDZ" }
    kioskUser = $KioskUser
    maintenanceAdministrator = $maintenanceAdministrator
    kioskAdministrator = $kioskAdministrator
    maintenanceInOpenSshUsers = $maintenanceInOpenSshUsers
    kioskInOpenSshUsers = $kioskInOpenSshUsers
    kioskInRemoteDesktopUsers = $kioskInRemoteDesktopUsers
    kioskInRemoteManagementUsers = $kioskInRemoteManagementUsers
    sshDenied = $sshdConfigDeniesKioskUser -and -not $kioskInOpenSshUsers
    remoteInteractiveDenied = -not $kioskAdministrator -and -not $kioskInRemoteDesktopUsers
    winRmDenied = -not $kioskAdministrator -and -not $kioskInRemoteManagementUsers
    effectiveKioskRemoteAdministrationDenied = $kioskRemoteAccessDenied
  }
  $passwordFallback = -not ($sshdEffectiveConfig.passwordAuthentication -and $sshdEffectiveConfig.keyboardInteractiveAuthentication -and $sshdEffectiveConfig.authenticationMethods -and $sshdEffectiveConfig.authorizedKeysFile)
  $passwordAuthentication = [ordered]@{
    sshdPasswordAuthentication = $sshdEffectiveConfig.passwordAuthentication
    sshdKeyboardInteractiveAuthentication = $sshdEffectiveConfig.keyboardInteractiveAuthentication
    effectiveMode = if ($passwordFallback) { "fallback_present" } else { "certificate_publickey_only" }
    passwordFallback = $passwordFallback
  }
  $elevationProbe = Measure-AdministratorToSystemCompatibility -MaintenanceUser $MaintenanceUser -MaintenanceAdministrator $maintenanceAdministrator
  $elevationCompatibility = [ordered]@{
    systemSshEntrypoint = if ($sshdEffectiveConfig.systemEntrypoint) { "not_configured" } else { "configured" }
    administratorToSystem = if ($elevationProbe.registrationSucceeded) { "measured_supported" } else { "measured_failed" }
    probe = $elevationProbe
    wireGuardOwner = [string]$wireGuardService.owner
  }

  return [ordered]@{
    status = if ($sshdReady -and $tailscaleAbsent -and $maintenanceInOpenSshUsers -and $kioskRemoteAccessDenied) { "passed" } else { "failed" }
    opensshServer = if ($null -ne $sshd) { "available" } else { "missing" }
    opensshStartupType = if ($null -ne $sshd) { [string]$sshd.StartType } else { $null }
    opensshStatus = if ($null -ne $sshd) { [string]$sshd.Status } else { $null }
    tailscale = if ($tailscaleAbsent) { "not_installed_by_default" } else { "present" }
    tailscaleCliPath = if ($null -ne $tailscaleCli) { [string]$tailscaleCli.Source } else { $null }
    tailscaleStartupType = if ($null -ne $tailscale) { [string]$tailscale.StartType } else { $null }
    tailscaleStatus = if ($null -ne $tailscale) { [string]$tailscale.Status } else { $null }
    kioskRemoteAccess = if ($kioskRemoteAccessDenied) { "denied" } else { "allowed" }
    maintenanceUsersOnly = $kioskRemoteAccessDenied
    sshdConfigPath = $sshdConfigPath
    sshdConfigDeniesKioskUser = $sshdConfigDeniesKioskUser
    sshdConfigDenyUsersExpectedLowercase = $kioskUserForSshdDeny
    maintenanceInOpenSshUsers = $maintenanceInOpenSshUsers
    kioskInOpenSshUsers = $kioskInOpenSshUsers
    kioskInRemoteDesktopUsers = $kioskInRemoteDesktopUsers
    kioskInRemoteManagementUsers = $kioskInRemoteManagementUsers
    packageVersions = $packageVersions
    signatureEvidence = [ordered]@{
      openSsh = $Manifest.signatureEvidence.openSsh
      wireGuard = $Manifest.signatureEvidence.wireGuard
    }
    caFingerprint = $caEvidence
    ingress = $ingress
    sshdEffectiveConfig = $sshdEffectiveConfig
    firewallScope = $firewallScope
    accountPolicy = $accountPolicy
    passwordAuthentication = $passwordAuthentication
    wireGuardService = $wireGuardService
    elevationCompatibility = $elevationCompatibility
  }
}

function Get-ConsumerExperienceInterferenceEvidence {
  $cloudPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\CloudContent"
  $storePath = "HKLM:\SOFTWARE\Policies\Microsoft\WindowsStore"
  $explorerPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Explorer"
  $gameDvrPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\GameDVR"
  $oneDrivePath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\OneDrive"
  $searchPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\Windows Search"
  $disabled = [ordered]@{
    disableWindowsConsumerFeatures = Read-DwordValue -Path $cloudPath -Name "DisableWindowsConsumerFeatures"
    disableSoftLanding = Read-DwordValue -Path $cloudPath -Name "DisableSoftLanding"
    disableWindowsSpotlightFeatures = Read-DwordValue -Path $cloudPath -Name "DisableWindowsSpotlightFeatures"
    storeAutoDownload = Read-DwordValue -Path $storePath -Name "AutoDownload"
    disableNotificationCenter = Read-DwordValue -Path $explorerPath -Name "DisableNotificationCenter"
    allowGameDvr = Read-DwordValue -Path $gameDvrPath -Name "AllowGameDVR"
    disableOneDrive = Read-DwordValue -Path $oneDrivePath -Name "DisableFileSyncNGSC"
    allowCortana = Read-DwordValue -Path $searchPath -Name "AllowCortana"
    disableWebSearch = Read-DwordValue -Path $searchPath -Name "DisableWebSearch"
  }
  $ok = $disabled.disableWindowsConsumerFeatures -eq 1 -and
    $disabled.disableSoftLanding -eq 1 -and
    $disabled.disableWindowsSpotlightFeatures -eq 1 -and
    $disabled.storeAutoDownload -eq 2 -and
    $disabled.disableNotificationCenter -eq 1 -and
    $disabled.allowGameDvr -eq 0 -and
    $disabled.disableOneDrive -eq 1 -and
    $disabled.allowCortana -eq 0 -and
    $disabled.disableWebSearch -eq 1

  return [ordered]@{
    status = if ($ok) { "passed" } else { "failed" }
    componentAutostart = if ($ok) { "policy_configured" } else { "not_fully_configured" }
    foregroundPopups = if ($ok) { "policy_configured" } else { "not_fully_configured" }
    storeAutomaticAppUpdates = if ($disabled.storeAutoDownload -eq 2) { "disabled" } else { "enabled_or_unmanaged" }
    kioskForegroundTakeover = if ($ok) { "best_effort_policy_configured" } else { "not_fully_configured" }
    applicability = "Windows 10 Pro CloudContent and Spotlight policies are recorded as configured best-effort evidence, not proof that every consumer-experience foreground takeover path is impossible."
    registry = $disabled
  }
}

function Read-TextIfExists {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  return Get-Content -LiteralPath $Path -Raw
}

function Get-MaintenanceIngressEvidence {
  param($Manifest)

  $policy = $Manifest.maintenanceSsh
  $profile = [string]$Manifest.factoryProfile
  $mode = [string]$policy.ingressMode
  $listenAddress = [string]$policy.effectiveListenAddress
  $interfaceScope = [string]$policy.effectiveFirewallInterfaceScope
  $expected = if ($profile -eq "production") {
    [ordered]@{
      mode = "wireguard-only"
      listenAddress = [string]$policy.wireGuardListenAddress
      interfaceScope = [string]$policy.wireGuardInterfaceAlias
    }
  } elseif ($profile -eq "testbed") {
    [ordered]@{
      mode = "testbed-bootstrap-certificate"
      listenAddress = "0.0.0.0"
      interfaceScope = "Any"
    }
  } else {
    $null
  }
  return [ordered]@{
    profile = $profile
    mode = $mode
    effectiveListenAddress = $listenAddress
    effectiveFirewallInterfaceScope = $interfaceScope
    expectedMode = if ($null -ne $expected) { [string]$expected.mode } else { $null }
    expectedListenAddress = if ($null -ne $expected) { [string]$expected.listenAddress } else { $null }
    expectedFirewallInterfaceScope = if ($null -ne $expected) { [string]$expected.interfaceScope } else { $null }
    profileBound = $null -ne $expected -and
      $mode -ceq [string]$expected.mode -and
      $listenAddress -ceq [string]$expected.listenAddress -and
      $interfaceScope -ceq [string]$expected.interfaceScope
    bootstrapTestbedOnly = $profile -eq "testbed" -and $mode -eq "testbed-bootstrap-certificate"
  }
}

function Get-SshdEffectiveConfigEvidence {
  param(
    [string]$ConfigPath,
    [string]$MaintenanceUser,
    [string]$KioskUser,
    [string]$CaPath,
    $Manifest
  )
  $sshdExePath = @(
    "C:\Program Files\OpenSSH\sshd.exe",
    "C:\Windows\System32\OpenSSH\sshd.exe"
  ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace([string]$sshdExePath)) {
    $sshdCommand = Get-Command "sshd.exe" -ErrorAction SilentlyContinue
    if ($null -eq $sshdCommand) { $sshdCommand = Get-Command "sshd" -ErrorAction SilentlyContinue }
    if ($null -ne $sshdCommand) { $sshdExePath = [string]$sshdCommand.Source }
  }
  $syntaxValid = $false
  $syntaxError = $null
  $values = @{}
  if (-not [string]::IsNullOrWhiteSpace([string]$sshdExePath) -and (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    $syntaxOutput = @(& $sshdExePath -t -f $ConfigPath 2>&1)
    $syntaxValid = $LASTEXITCODE -eq 0
    if (-not $syntaxValid) { $syntaxError = $syntaxOutput -join "; " }
    if ($syntaxValid) {
      $sourceAddress = ([string]$Manifest.maintenanceSsh.runnerSourceAllowlist[0] -split "/", 2)[0]
      $effectiveOutput = @(& $sshdExePath -T -f $ConfigPath -C "user=$($MaintenanceUser.ToLowerInvariant()),host=localhost,addr=$sourceAddress" 2>&1)
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
  $expectedListen = [string]$Manifest.maintenanceSsh.effectiveListenAddress
  $actualListen = [string]$values.listenaddress
  $allowUsers = [string]$values.allowusers
  $denyUsers = [string]$values.denyusers
  return [ordered]@{
    path = $ConfigPath
    executablePath = $sshdExePath
    syntaxValid = $syntaxValid
    syntaxError = $syntaxError
    listenAddress = $actualListen
    listenAddressMatches = $actualListen -ceq "$expectedListen`:22"
    trustedUserCaKeysValue = [string]$values.trustedusercakeys
    trustedUserCaKeys = [string]$values.trustedusercakeys -ceq $CaPath
    pubkeyAuthentication = [string]$values.pubkeyauthentication -ceq "yes"
    passwordAuthentication = [string]$values.passwordauthentication -ceq "no"
    keyboardInteractiveAuthentication = [string]$values.kbdinteractiveauthentication -ceq "no"
    authenticationMethods = [string]$values.authenticationmethods -ceq "publickey"
    authorizedKeysFileValue = [string]$values.authorizedkeysfile
    authorizedKeysFile = [string]$values.authorizedkeysfile -ceq "none"
    allowUsersValue = $allowUsers
    allowUsers = $allowUsers -ceq $MaintenanceUser.ToLowerInvariant()
    denyUsersValue = $denyUsers
    denyUsers = @($denyUsers -split "\s+" | Where-Object { $_ -ceq $KioskUser.ToLowerInvariant() }).Count -gt 0
    systemEntrypoint = $allowUsers -notmatch "(?i)(^|\s)SYSTEM($|\s)"
    effectivePolicy = if ($syntaxValid) { "measured" } else { "invalid" }
  }
}

function Test-PinnedAuthenticodeTimeAcceptance {
  param(
    $Certificate,
    [bool]$ChainValid,
    [string[]]$Statuses
  )
  if ($ChainValid) { return $true }
  # Match installation trust: pinned bytes and identities may outlive an
  # otherwise valid signer certificate, but no other chain failure is allowed.
  return (
    $Statuses.Count -gt 0 -and
    @($Statuses | Where-Object { $_ -cne "NotTimeValid" }).Count -eq 0 -and
    $Certificate.NotBefore.ToUniversalTime() -le [DateTime]::UtcNow -and
    $Certificate.NotAfter.ToUniversalTime() -lt [DateTime]::UtcNow
  )
}

function Get-FactoryPackageEvidence {
  param($Manifest)
  $result = [ordered]@{}
  foreach ($package in @(
      [pscustomobject]@{ name = "openSsh"; expected = $Manifest.packages.openSsh; executable = "C:\Program Files\OpenSSH\sshd.exe" },
      [pscustomobject]@{ name = "wireGuard"; expected = $Manifest.packages.wireGuard; executable = "C:\Program Files\WireGuard\wireguard.exe" }
    )) {
    $file = Get-Item -LiteralPath $package.executable -ErrorAction SilentlyContinue
    $signature = $package.expected.signatureEvidence
    $installedSignature = $null
    if ($null -ne $file) {
      $authenticode = Get-AuthenticodeSignature -FilePath ([string]$file.FullName)
      $chainValid = $false
      $chainThumbprints = @()
      $rootThumbprint = $null
      if ($null -ne $authenticode.SignerCertificate) {
        $chain = [System.Security.Cryptography.X509Certificates.X509Chain]::new()
        $chain.ChainPolicy.RevocationMode = [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
        $chainValid = $chain.Build($authenticode.SignerCertificate)
        $chainStatuses = @($chain.ChainStatus | ForEach-Object { [string]$_.Status })
        $chainValid = Test-PinnedAuthenticodeTimeAcceptance -Certificate $authenticode.SignerCertificate -ChainValid $chainValid -Statuses $chainStatuses
        $chainThumbprints = @($chain.ChainElements | ForEach-Object { ([string]$_.Certificate.Thumbprint).ToUpperInvariant() })
        if ($chainThumbprints.Count -gt 0) { $rootThumbprint = $chainThumbprints[-1] }
      }
      $installedSignerThumbprint = if ($null -ne $authenticode.SignerCertificate) { ([string]$authenticode.SignerCertificate.Thumbprint).ToUpperInvariant() } else { $null }
      $installedSignature = [ordered]@{
        status = [string]$authenticode.Status
        statusMessage = [string]$authenticode.StatusMessage
        signerSubject = if ($null -ne $authenticode.SignerCertificate) { [string]$authenticode.SignerCertificate.Subject } else { $null }
        signerThumbprint = $installedSignerThumbprint
        rootThumbprint = $rootThumbprint
        chainThumbprints = $chainThumbprints
        chainValid = $chainValid
        signerMatchesApproved = $installedSignerThumbprint -ceq [string]$signature.signerThumbprint
        rootMatchesApproved = $rootThumbprint -ceq [string]$signature.rootThumbprint
      }
    }
    $result[$package.name] = [ordered]@{
      source = [string]$package.expected.source
      version = [string]$package.expected.version
      sha256 = [string]$package.expected.sha256
      signatureEvidence = $signature
      executablePath = if ($null -ne $file) { [string]$file.FullName } else { $package.executable }
      installed = $null -ne $file
      fileVersion = if ($null -ne $file) { [string]$file.VersionInfo.FileVersion } else { $null }
      versionMatches = $null -ne $file -and (Test-PinnedVersionEquivalent -Actual ([string]$file.VersionInfo.FileVersion) -Expected ([string]$package.expected.version))
      installedSignature = $installedSignature
    }
  }
  return $result
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

function Get-MaintenanceCaEvidence {
  param($Manifest)
  $ca = $Manifest.maintenanceSsh
  $exists = Test-Path -LiteralPath ([string]$ca.caPath) -PathType Leaf
  $hash = if ($exists) { (Get-FileHash -LiteralPath ([string]$ca.caPath) -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
  $keyLines = if ($exists) { @([System.IO.File]::ReadAllLines([string]$ca.caPath, [System.Text.Encoding]::UTF8) | ForEach-Object { $_.Trim() } | Where-Object { $_.Length -gt 0 -and -not $_.StartsWith("#") }) } else { @() }
  $keyType = $null
  $profile = $null
  if ($keyLines.Count -eq 1) {
    $parts = $keyLines[0] -split "\s+", 3
    if ($parts.Count -eq 3) {
      $keyType = $parts[0]
      if ($parts[2] -match "^vem-maintenance-ca:(production|testbed)$") { $profile = $matches[1] }
    }
  }
  $keygen = Get-Command "ssh-keygen.exe" -ErrorAction SilentlyContinue
  if ($null -eq $keygen) { $keygen = Get-Command "ssh-keygen" -ErrorAction SilentlyContinue }
  $fingerprint = $null
  if ($exists -and $null -ne $keygen) {
    $fingerprint = ((& $keygen.Source -lf ([string]$ca.caPath) -E sha256 2>$null) | Out-String).Trim()
    if ($fingerprint -match "(SHA256:[A-Za-z0-9+/=]+)") { $fingerprint = $matches[1] }
  }
  return [ordered]@{
    path = [string]$ca.caPath
    exists = $exists
    sha256 = $hash
    sha256Matches = $exists -and $hash -eq ([string]$ca.caSha256).ToLowerInvariant()
    profile = $profile
    expectedProfile = [string]$Manifest.factoryProfile
    profileMatches = $profile -ceq [string]$Manifest.factoryProfile
    keyType = $keyType
    keyCount = $keyLines.Count
    expectedFingerprint = [string]$ca.caFingerprint
    fingerprint = $fingerprint
    fingerprintMatches = $exists -and $null -ne $fingerprint -and $fingerprint -eq [string]$ca.caFingerprint
    publicKeyOnly = $exists -and $keyLines.Count -eq 1 -and $keyType -ceq "ssh-ed25519"
  }
}

function Get-MaintenanceFirewallEvidence {
  param($Manifest)
  $policy = $Manifest.maintenanceSsh
  $allRules = @(Get-NetFirewallRule -ErrorAction SilentlyContinue)
  $sshRules = [System.Collections.Generic.List[object]]::new()
  foreach ($candidate in $allRules) {
    if ([string]$candidate.Direction -ne "Inbound" -or [string]$candidate.Enabled -ne "True" -or [string]$candidate.Action -ne "Allow") { continue }
    foreach ($candidatePort in @(Get-NetFirewallPortFilter -AssociatedNetFirewallRule $candidate -ErrorAction SilentlyContinue)) {
      $protocol = [string]$candidatePort.Protocol
      $includesSsh = $false
      foreach ($entry in @($candidatePort.LocalPort)) {
        foreach ($part in ([string]$entry -split ",")) {
          $value = $part.Trim()
          if ($value -match "^(?i:Any|\*)$" -or $value -eq "22" -or ($value -match "^(\d+)-(\d+)$" -and [int]$matches[1] -le 22 -and [int]$matches[2] -ge 22)) {
            $includesSsh = $true
          }
        }
      }
      if (($protocol -eq "TCP" -or $protocol -eq "6" -or $protocol -eq "Any") -and $includesSsh) {
        $addressFilter = Get-NetFirewallAddressFilter -AssociatedNetFirewallRule $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
        $interfaceFilter = Get-NetFirewallInterfaceFilter -AssociatedNetFirewallRule $candidate -ErrorAction SilentlyContinue | Select-Object -First 1
        $sshRules.Add([pscustomobject]@{
            name = [string]$candidate.Name
            displayName = [string]$candidate.DisplayName
            protocol = $protocol
            localPort = [string]$candidatePort.LocalPort
            remoteAddress = @($addressFilter.RemoteAddress | ForEach-Object { [string]$_ })
            interfaceAlias = [string]$interfaceFilter.InterfaceAlias
          }) | Out-Null
        break
      }
    }
  }
  $managedRules = @($sshRules | Where-Object { $_.displayName -ceq "VEM Controlled Maintenance SSH" })
  $rule = if ($managedRules.Count -eq 1) { $managedRules[0] } else { $null }
  $actual = if ($null -ne $rule) { @($rule.remoteAddress | Sort-Object -Unique) } else { @() }
  $expected = @(@($policy.runnerSourceAllowlist) + @($policy.maintainerSourceAllowlist) | ForEach-Object { [string]$_ } | Sort-Object -Unique)
  $listeners = @(Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
      [pscustomobject]@{ localAddress = [string]$_.LocalAddress; localPort = [int]$_.LocalPort; owningProcess = [int]$_.OwningProcess }
    })
  $expectedListenAddress = [string]$policy.effectiveListenAddress
  $unexpectedRules = @($sshRules | Where-Object { $_.displayName -cne "VEM Controlled Maintenance SSH" })
  $unexpectedListeners = @($listeners | Where-Object { $_.localAddress -cne $expectedListenAddress })
  return [ordered]@{
    exists = $null -ne $rule
    enabled = $null -ne $rule
    protocol = if ($null -ne $rule) { [string]$rule.protocol } else { $null }
    localPort = if ($null -ne $rule) { [string]$rule.localPort } else { $null }
    interfaceAlias = if ($null -ne $rule) { [string]$rule.interfaceAlias } else { $null }
    expectedInterfaceAlias = [string]$policy.effectiveFirewallInterfaceScope
    sourceRolePools = $actual
    expectedSourceRolePools = $expected
    sourceRolePoolsMatch = ($actual -join ",") -eq ($expected -join ",")
    expectedListenAddress = $expectedListenAddress
    enabledInboundTcp22Rules = @($sshRules)
    unexpectedEnabledInboundTcp22Rules = $unexpectedRules
    listeners = $listeners
    unexpectedListeners = $unexpectedListeners
  }
}

function Get-WireGuardServiceEvidence {
  param($Manifest)
  $expected = $Manifest.wireGuard
  $serviceName = Get-WireGuardTunnelServiceName
  $manifestServiceName = [string]$expected.serviceName
  $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  $serviceConfig = Get-CimInstance Win32_Service -Filter ("Name = '{0}'" -f $serviceName) -ErrorAction SilentlyContinue
  $configExists = Test-Path -LiteralPath ([string]$expected.configPath) -PathType Leaf
  $configText = if ($configExists) { Get-Content -LiteralPath ([string]$expected.configPath) -Raw } else { "" }
  $dependencyNames = if ($null -ne $service) { @($service.ServicesDependedOn | ForEach-Object { [string]$_.Name }) } else { @() }
  $automatic = $null -ne $serviceConfig -and [string]$serviceConfig.StartMode -eq "Auto"
  $localSystemOwned = $null -ne $serviceConfig -and [string]$serviceConfig.StartName -match "(?i)^(LocalSystem|NT AUTHORITY\\SYSTEM)$"
  return [ordered]@{
    serviceName = $serviceName
    manifestServiceName = $manifestServiceName
    serviceNameMatches = $manifestServiceName -ceq $serviceName
    exists = $null -ne $service
    status = if ($null -ne $service) { [string]$service.Status } else { $null }
    startupType = if ($automatic) { "Automatic" } elseif ($null -ne $serviceConfig) { [string]$serviceConfig.StartMode } else { $null }
    automatic = $automatic
    owner = if ($null -ne $serviceConfig) { [string]$serviceConfig.StartName } else { $null }
    expectedOwner = [string]$expected.owner
    ownerMatches = $localSystemOwned
    configPath = [string]$expected.configPath
    configExists = $configExists
    privateKeyPresentLocally = $configText -match "(?im)^\s*PrivateKey\s*="
    profileContamination = $configText -match "(?i)testbed|YKDZ|test-peer|simulator|shared-password"
    serviceDependencies = $dependencyNames
    independentOfKiosk = $automatic -and @($dependencyNames | Where-Object { $_ -match "(?i)VEMMachineUI|machine|kiosk" }).Count -eq 0
  }
}

function Assert-ExactPersonalizationProperties {
  param($Value, [string[]]$ExpectedNames, [string]$Label)

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

function Get-RequiredPersonalizationProperty {
  param($Value, [string]$Name, [string]$Label)

  $property = @($Value.PSObject.Properties | Where-Object { $_.Name -ceq $Name })
  if ($property.Count -ne 1) {
    throw "$Label is missing required own property $Name"
  }
  return $property[0].Value
}

function Get-FactoryPersonalizationRedaction {
  param($Manifest)

  $redaction = $Manifest.personalization
  Assert-ExactPersonalizationProperties -Value $redaction -ExpectedNames @("schemaVersion", "kind", "profile", "protection", "credentials", "wireGuardPrivateKey", "mediaConsumed", "stagingRetained") -Label "Factory Personalization redaction"
  $profile = Get-RequiredPersonalizationProperty -Value $redaction -Name "profile" -Label "Factory Personalization redaction"
  if ([string]$redaction.schemaVersion -cne "vem-factory-personalization-media-redaction/v1" -or
      [string]$redaction.kind -cne "factory-personalization-media-redaction" -or
      [string]$profile -cne [string]$Manifest.factoryProfile -or
      [string]$redaction.wireGuardPrivateKey -cne "not-supplied; generated-locally" -or
      $redaction.mediaConsumed -isnot [bool] -or $redaction.mediaConsumed -ne $true -or
      $redaction.stagingRetained -isnot [bool] -or $redaction.stagingRetained -ne $false) {
    throw "Factory Personalization Media redaction contract is invalid"
  }
  $protection = Get-RequiredPersonalizationProperty -Value $redaction -Name "protection" -Label "Factory Personalization redaction"
  Assert-ExactPersonalizationProperties -Value $protection -ExpectedNames @("encryptedAtRest", "access", "cache", "retention") -Label "Factory Personalization redaction protection"
  if ($protection.encryptedAtRest -isnot [bool] -or $protection.encryptedAtRest -ne $true -or
      [string]$protection.access -cne "trusted-protected-gate" -or
      [string]$protection.cache -cne "forbidden" -or
      [string]$protection.retention -cne "installation-lifecycle-only") {
    throw "Factory Personalization Media redaction protection contract is invalid"
  }
  $credentialNames = if ([string]$profile -ceq "production") { @("administrator", "kiosk") } else { @("bootstrap", "kiosk") }
  $credentials = Get-RequiredPersonalizationProperty -Value $redaction -Name "credentials" -Label "Factory Personalization redaction"
  Assert-ExactPersonalizationProperties -Value $credentials -ExpectedNames $credentialNames -Label "Factory Personalization redaction credentials"
  foreach ($name in $credentialNames) {
    if ([string](Get-RequiredPersonalizationProperty -Value $credentials -Name $name -Label "Factory Personalization redaction credentials") -cne "configured") {
      throw "Factory Personalization Media redaction credential contract is invalid"
    }
  }
  $credentialEvidence = [ordered]@{}
  foreach ($name in $credentialNames) {
    $credentialEvidence[$name] = "configured"
  }
  # Reconstruct only the allowlisted facts; never carry manifest input through.
  return [ordered]@{
    schemaVersion = "vem-factory-personalization-media-redaction/v1"
    kind = "factory-personalization-media-redaction"
    profile = [string]$profile
    protection = [ordered]@{
      encryptedAtRest = $true
      access = "trusted-protected-gate"
      cache = "forbidden"
      retention = "installation-lifecycle-only"
    }
    credentials = $credentialEvidence
    wireGuardPrivateKey = "not-supplied; generated-locally"
    mediaConsumed = $true
    stagingRetained = $false
  }
}

function Get-FactoryPersonalizationEvidence {
  param($Manifest)

  $markerPath = "C:\ProgramData\VEM\factory\personalization-consumed.json"
  $markerExists = Test-Path -LiteralPath $markerPath -PathType Leaf
  $marker = if ($markerExists) { Read-JsonFile -Path $markerPath } else { $null }
  $retainedMedia = @(
    Get-ChildItem -LiteralPath "C:\ProgramData\VEM\factory" -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "(?i)personalization.*media|personalization\.json" }
  )
  $redaction = Get-FactoryPersonalizationRedaction -Manifest $Manifest
  return [ordered]@{
    profile = [string]$Manifest.factoryProfile
    consumed = $markerExists
    profileMatches = $markerExists -and [string]$marker.profile -ceq [string]$Manifest.factoryProfile
    retainedMediaPresent = $retainedMedia.Count -gt 0
    credentials = $redaction.credentials
  }
}

$failures = [System.Collections.Generic.List[string]]::new()
$checks = [ordered]@{}
$manifest = $null

try {
  $manifest = Read-JsonFile -Path $ManifestPath
  $checks.manifest = [ordered]@{
    path = $ManifestPath
    schemaVersion = $manifest.schemaVersion
    layoutVersion = $manifest.layoutVersion
    factoryProfile = $manifest.factoryProfile
    hardwareMode = $manifest.hardware.mode
    hardwareModel = $manifest.hardware.model
    topologyIdentity = $manifest.topology.identity
    topologyVersion = $manifest.topology.version
    exists = $true
  }
  if ([string]$manifest.schemaVersion -ne "vem-factory-runtime-manifest/v1") {
    Add-Failure $failures "unexpected factory manifest schema: $($manifest.schemaVersion)"
  }
  if ([string]$manifest.factoryProfile -notin @("production", "testbed")) {
    Add-Failure $failures "factory manifest must declare production or testbed profile"
  }
  if ($null -eq $manifest.packages.openSsh -or $null -eq $manifest.packages.wireGuard) {
    Add-Failure $failures "factory manifest must declare pinned OpenSSH and WireGuard packages"
  }
  if ($null -eq $manifest.maintenanceSsh -or $null -eq $manifest.wireGuard) {
    Add-Failure $failures "factory manifest must declare Maintenance SSH CA and WireGuard ownership"
  }
  $checks.visionRelease = $manifest.visionRelease
  if ([string]$manifest.factoryProfile -eq "production") {
    $vision = $manifest.visionRelease
    if (
      $null -eq $vision -or
      [string]$vision.installedDigest -notmatch '^sha256:[a-f0-9]{64}$' -or
      [string]$vision.descriptorDigest -notmatch '^sha256:[a-f0-9]{64}$' -or
      [string]$vision.approvalDigest -notmatch '^sha256:[a-f0-9]{64}$' -or
      [string]$vision.configurationSha256 -notmatch '^[a-f0-9]{64}$' -or
      $vision.healthOk -ne $true -or
      $vision.webSocketOk -ne $true -or
      $vision.redacted -ne $true -or
      -not (Test-Path -LiteralPath ([string]$vision.evidencePath) -PathType Leaf)
    ) {
      Add-Failure $failures "production Factory Vision installation evidence is missing or invalid"
    }
  }
  $checks.personalization = Get-FactoryPersonalizationRedaction -Manifest $manifest
  $checks.personalizationLifecycle = Get-FactoryPersonalizationEvidence -Manifest $manifest
  if (-not [bool]$checks.personalizationLifecycle.consumed -or
      -not [bool]$checks.personalizationLifecycle.profileMatches -or
      [bool]$checks.personalizationLifecycle.retainedMediaPresent) {
    Add-Failure $failures "Factory Personalization Media lifecycle marker or staging cleanup is invalid"
  }
} catch {
  Add-Failure $failures $_.Exception.Message
}

if ($null -ne $manifest) {
  # FactoryProfile is a strict production/testbed boundary, not a display label.
  $expectedPaths = [ordered]@{
    runtimeRoot = "C:\VEM\bringup"
    daemonExecutable = "C:\VEM\bringup\vending-daemon.exe"
    machineUiExecutable = "C:\VEM\bringup\machine.exe"
    machineUiWebView2Loader = "C:\VEM\bringup\WebView2Loader.dll"
    factoryRoot = "C:\ProgramData\VEM\factory"
    bringupSettings = "C:\ProgramData\VEM\bringup\local-bringup-settings.json"
    provisioningRoot = "C:\ProgramData\VEM\provisioning"
    secretsRoot = "C:\ProgramData\VEM\secrets"
    daemonRoot = "C:\ProgramData\VEM\vending-daemon"
    evidenceRoot = "C:\ProgramData\VEM\evidence"
    overridesRoot = "C:\ProgramData\VEM\overrides"
  }
  $pathEvidence = [ordered]@{}
  foreach ($entry in $expectedPaths.GetEnumerator()) {
    $pathEvidence[$entry.Key] = [ordered]@{
      path = $entry.Value
      exists = Test-Path -LiteralPath $entry.Value
    }
    if (-not [bool]$pathEvidence[$entry.Key].exists) {
      Add-Failure $failures "required runtime path missing: $($entry.Value)"
    }
  }
  $checks.fixedPaths = $pathEvidence

  $settingsPath = "C:\ProgramData\VEM\bringup\local-bringup-settings.json"
  if (Test-Path -LiteralPath $settingsPath -PathType Leaf) {
    $settings = Read-JsonFile -Path $settingsPath
    $checks.localBringupSettings = [ordered]@{
      path = $settingsPath
      schemaVersion = $settings.schemaVersion
      environmentName = $settings.environmentName
      provisioningEndpoint = $settings.provisioningEndpoint
    }
    if ([string]$settings.schemaVersion -ne "vem-local-bringup-settings/v1") {
      Add-Failure $failures "unexpected local bring-up settings schema: $($settings.schemaVersion)"
    }
  } else {
    Add-Failure $failures "local bring-up settings missing: $settingsPath"
  }

  $componentChecks = @()
  foreach ($component in @($manifest.components)) {
    $componentChecks += Assert-Sha256 -Path ([string]$component.targetPath) -ExpectedSha256 ([string]$component.sha256) -Failures $failures
  }
  $checks.components = $componentChecks

  $service = Get-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue
  $serviceConfig = Get-CimInstance Win32_Service -Filter "Name = 'VemVendingDaemon'" -ErrorAction SilentlyContinue
  $checks.daemonService = [ordered]@{
    name = "VemVendingDaemon"
    exists = $null -ne $service
    status = if ($null -ne $service) { [string]$service.Status } else { $null }
    startType = if ($null -ne $service) { [string]$service.StartType } else { $null }
    binaryPath = if ($null -ne $serviceConfig) { [string]$serviceConfig.PathName } else { $null }
  }
  if ($null -eq $service) {
    Add-Failure $failures "daemon service missing: VemVendingDaemon"
  } elseif ([string]$service.StartType -ne "Automatic") {
    Add-Failure $failures "daemon service is not Automatic: $($service.StartType)"
  }
  $daemonBinaryNeedles = @($manifest.expectations.daemonService.binaryPathContains)
  if ($daemonBinaryNeedles.Count -eq 0) {
    $daemonBinaryNeedles = @(
      "C:\VEM\bringup\vending-daemon.exe",
      "--data-dir",
      "C:\ProgramData\VEM\vending-daemon",
      "--print-ready-file",
      "C:\ProgramData\VEM\vending-daemon\daemon-ready.json"
    )
  }
  foreach ($needle in $daemonBinaryNeedles) {
    if ($null -eq $serviceConfig -or -not ([string]$serviceConfig.PathName).Contains([string]$needle)) {
      Add-Failure $failures "daemon service binary path does not include $needle`: $($serviceConfig.PathName)"
    }
  }

  $uiTask = Get-ScheduledTaskEvidence -TaskName "VEMMachineUI"
  $machineUiStartupMode = if ([string]::IsNullOrWhiteSpace($manifest.expectations.machineUiStartupMode)) {
    "scheduled_task"
  } else {
    [string]$manifest.expectations.machineUiStartupMode
  }
  $machineUiStartup = [ordered]@{
    mode = $machineUiStartupMode
    machineUiTask = $uiTask
    maintenanceUiTaskName = "VEMMaintenanceUI"
    visionTaskName = "VEM\StartVisionServer"
    shell = $null
  }
  switch ($machineUiStartupMode) {
    "scheduled_task" {
      if (-not [bool]$uiTask.exists) {
        Add-Failure $failures "machine UI task missing: VEMMachineUI"
      } else {
        if (-not [bool]$uiTask.enabled) {
          Add-Failure $failures "machine UI task is disabled: VEMMachineUI"
        }
        if (-not (Test-PrincipalMatches -Principal ([string]$uiTask.principal) -ExpectedUser ([string]$manifest.expectations.autoLogonUser))) {
          Add-Failure $failures "machine UI task principal mismatch: expected $($manifest.expectations.autoLogonUser), got $($uiTask.principal)"
        }
        if ([string]$uiTask.command -ne [string]$manifest.expectations.machineUiTask.command) {
          Add-Failure $failures "machine UI task command mismatch: expected $($manifest.expectations.machineUiTask.command), got $($uiTask.command)"
        }
        if (-not ([string]$uiTask.arguments).Contains([string]$manifest.expectations.machineUiTask.argumentsContain)) {
          Add-Failure $failures "machine UI task arguments do not reference $($manifest.expectations.machineUiTask.argumentsContain): $($uiTask.arguments)"
        }
        if ([string]$uiTask.workingDirectory -ne [string]$manifest.expectations.machineUiTask.workingDirectory) {
          Add-Failure $failures "machine UI task working directory mismatch: expected $($manifest.expectations.machineUiTask.workingDirectory), got $($uiTask.workingDirectory)"
        }
      }
    }
    "shell_launcher" {
      if ([bool]$uiTask.exists -and [bool]$uiTask.enabled) {
        Add-Failure $failures "VEMMachineUI scheduled task should be removed or disabled when Shell Launcher owns startup"
      }
      $kioskSidForShell = Get-LocalAccountSidOrNull -User ([string]$manifest.expectations.kioskUser)
      $expectedShell = if ([string]::IsNullOrWhiteSpace($manifest.expectations.kioskShell)) {
        ('"{0}"' -f "C:\VEM\bringup\machine.exe")
      } else {
        [string]$manifest.expectations.kioskShell
      }
      $shellEvidence = if ($null -ne $kioskSidForShell) {
        Get-KioskShellEvidence -Sid $kioskSidForShell -ExpectedShell $expectedShell
      } else {
        [pscustomobject]@{
          mode = "Shell Launcher"
          shell = $null
          expectedShell = $expectedShell
          configured = $false
          error = "kiosk SID not found"
        }
      }
      $machineUiStartup.shell = $shellEvidence
      if (-not [bool]$shellEvidence.configured) {
        Add-Failure $failures "OS-level kiosk shell is not configured for $($manifest.expectations.kioskUser) with expected shell $expectedShell"
      }
    }
    default {
      Add-Failure $failures "unknown machine UI startup mode: $machineUiStartupMode"
    }
  }
  $checks.machineUiStartup = $machineUiStartup

  $kiosk = Get-LocalUser -Name ([string]$manifest.expectations.kioskUser) -ErrorAction SilentlyContinue
  $maintenance = Get-LocalUser -Name ([string]$manifest.expectations.maintenanceUser) -ErrorAction SilentlyContinue
  $checks.accounts = [ordered]@{
    ExpectedKioskUser = $manifest.expectations.kioskUser
    ExpectedMaintenanceUser = $manifest.expectations.maintenanceUser
    kioskExists = $null -ne $kiosk
    maintenanceExists = $null -ne $maintenance
  }
  if ($null -eq $kiosk) {
    Add-Failure $failures "expected kiosk account missing: $($manifest.expectations.kioskUser)"
  }
  if ($null -eq $maintenance) {
    Add-Failure $failures "expected maintenance account missing: $($manifest.expectations.maintenanceUser)"
  }

  $winlogon = Get-WinlogonEvidence
  $checks.autoLogon = [ordered]@{
    ExpectedAutoLogonUser = $manifest.expectations.autoLogonUser
    live = $winlogon
  }
  if (-not [bool]$winlogon.configured -or -not [bool]$winlogon.force) {
    Add-Failure $failures "Winlogon autologon is not configured with ForceAutoLogon"
  }
  if ([string]$winlogon.user -ne [string]$manifest.expectations.autoLogonUser) {
    Add-Failure $failures "Winlogon autologon user mismatch: expected $($manifest.expectations.autoLogonUser), got $($winlogon.user)"
  }

  $normalLauncher = Read-TextIfExists -Path "C:\VEM\bringup\launch-machine-ui.vbs"
  $debugLauncher = Read-TextIfExists -Path "C:\VEM\bringup\launch-machine-ui-debug.vbs"
  $checks.kiosk = [ordered]@{
    ExpectedKioskShell = $manifest.expectations.kioskShell
    normalLauncher = "C:\VEM\bringup\launch-machine-ui.vbs"
    normalLauncherExists = $null -ne $normalLauncher
    normalLauncherDebugCdpExcluded = $null -ne $normalLauncher -and -not ($normalLauncher -match "remote-debugging-port")
    debugLauncher = "C:\VEM\bringup\launch-machine-ui-debug.vbs"
    maintenanceRecovery = [ordered]@{
      debugLauncherExists = $null -ne $debugLauncher
      debugLauncherEnablesCdp = $null -ne $debugLauncher -and $debugLauncher.Contains("remote-debugging-port=9222")
    }
  }
  if ($null -eq $normalLauncher) {
    Add-Failure $failures "normal machine UI launcher missing"
  } elseif ($normalLauncher -match "remote-debugging-port") {
    Add-Failure $failures "customer launcher enables WebView CDP remote-debugging-port"
  }
  if ($null -eq $debugLauncher) {
    Add-Failure $failures "maintenance recovery debug launcher missing"
  } elseif (-not $debugLauncher.Contains("remote-debugging-port=9222")) {
    Add-Failure $failures "maintenance recovery debug launcher does not enable CDP"
  }

  $display = Get-DisplayEvidence
  $expectedDisplay = $manifest.display
  $checks.display = [ordered]@{
    expected = $expectedDisplay
    live = $display
  }
  if ([bool]$display.available) {
    if ([int]$display.width -ne [int]$expectedDisplay.width) {
      Add-Failure $failures "display width mismatch: expected $($expectedDisplay.width), got $($display.width)"
    }
    if ([int]$display.height -ne [int]$expectedDisplay.height) {
      Add-Failure $failures "display height mismatch: expected $($expectedDisplay.height), got $($display.height)"
    }
    if ([string]$display.orientation -ne [string]$expectedDisplay.orientation) {
      Add-Failure $failures "display orientation mismatch: expected $($expectedDisplay.orientation), got $($display.orientation)"
    }
  }

  $checks.windowsUpdatePolicy = Get-WindowsUpdatePolicyEvidence
  if ([string]$checks.windowsUpdatePolicy.automaticUpdateInstallation -ne "disabled") {
    Add-Failure $failures "Windows automatic update installation is not disabled"
  }
  if ([string]$checks.windowsUpdatePolicy.automaticRestart -ne "disabled") {
    Add-Failure $failures "Windows automatic restart after updates is not disabled"
  }

  $checks.powerPolicy = Get-PowerPolicyEvidence
  if ([string]$checks.powerPolicy.sleep -ne "disabled") {
    Add-Failure $failures "sleep is not disabled"
  }
  if ([string]$checks.powerPolicy.hibernation -ne "disabled") {
    Add-Failure $failures "hibernation is not disabled"
  }

  $checks.bootPolicy = Get-BootPolicyEvidence
  if ([string]$checks.bootPolicy.testsigning -ne "off") {
    Add-Failure $failures "Windows testsigning must be off"
  }

  $checks.securityPosture = Get-SecurityPostureEvidence
  if ([string]$checks.securityPosture.defender -ne "enabled") {
    Add-Failure $failures "Defender must remain enabled with VEM runtime exclusions"
  }
  if ([string]$checks.securityPosture.firewall -ne "enabled") {
    Add-Failure $failures "Firewall must remain enabled with explicit VEM inbound rules"
  }
  if (@($checks.securityPosture.missingDefenderExclusions).Count -gt 0) {
    Add-Failure $failures "Defender VEM runtime exclusions missing: $($checks.securityPosture.missingDefenderExclusions -join ', ')"
  }
  $enabledVemInboundRules = @($checks.securityPosture.enabledVemInboundRules)
  $disallowedVemInboundRules = @($enabledVemInboundRules | Where-Object { [string]$_ -ne "VEM Controlled Maintenance SSH" })
  if (@($disallowedVemInboundRules).Count -gt 0) {
    Add-Failure $failures "default Factory Runtime Image must not enable product-managed inbound remote access rules: $($disallowedVemInboundRules -join ', ')"
  }
  if ([string]$checks.securityPosture.fileAndPrinterSharing -ne "not_enabled") {
    Add-Failure $failures "File and Printer Sharing firewall rules must not be enabled as a maintenance entry"
  }

  $checks.factoryRemoteMaintenanceCapability = Get-FactoryRemoteMaintenanceCapabilityEvidence -KioskUser ([string]$manifest.expectations.kioskUser) -MaintenanceUser ([string]$manifest.expectations.maintenanceUser) -Manifest $manifest
  if ([string]$checks.factoryRemoteMaintenanceCapability.opensshServer -ne "available") {
    Add-Failure $failures "Factory Remote Maintenance Capability requires OpenSSH Server"
  }
  if ([string]$checks.factoryRemoteMaintenanceCapability.opensshStatus -ne "Running" -or [string]$checks.factoryRemoteMaintenanceCapability.opensshStartupType -ne "Automatic") {
    Add-Failure $failures "Factory Remote Maintenance Capability requires running automatic sshd"
  }
  if ([string]$checks.factoryRemoteMaintenanceCapability.tailscale -ne "not_installed_by_default") {
    Add-Failure $failures "default Factory Runtime Image must not include Tailscale service or CLI"
  }
  if (-not [bool]$checks.factoryRemoteMaintenanceCapability.sshdConfigDeniesKioskUser) {
    Add-Failure $failures "sshd_config must explicitly deny the lowercase kiosk account"
  }
  if (-not [bool]$checks.factoryRemoteMaintenanceCapability.maintenanceInOpenSshUsers) {
    Add-Failure $failures "maintenance account must be allowed through OpenSSH Users"
  }
  if ([string]$checks.factoryRemoteMaintenanceCapability.kioskRemoteAccess -ne "denied") {
    Add-Failure $failures "kiosk account must not have remote maintenance access"
  }
  if ([string]$manifest.factoryProfile -eq "production" -and [string]$manifest.expectations.maintenanceUser -cne "Admin") {
    Add-Failure $failures "production verifier requires the Admin maintenance administrator"
  }
  $personalizationJson = $checks.personalization | ConvertTo-Json -Depth 12 -Compress
  if ([string]$manifest.factoryProfile -eq "production" -and $personalizationJson -match "(?i)YKDZ|testbed|test-ca|test-peer|simulator|shared-password") {
    Add-Failure $failures "production verifier rejects testbed Factory Personalization Media contamination"
  }
  if ([string]$manifest.factoryProfile -eq "production" -and [string]$manifest.expectations.maintenanceUser -eq "YKDZ") {
    Add-Failure $failures "production verifier rejects the testbed YKDZ maintenance administrator"
  }
  if ([string]$manifest.factoryProfile -eq "testbed" -and [string]$manifest.expectations.maintenanceUser -cne "YKDZ") {
    Add-Failure $failures "testbed verifier requires the existing YKDZ maintenance administrator"
  }
  $maintenanceIngress = $checks.factoryRemoteMaintenanceCapability.ingress
  if (-not [bool]$maintenanceIngress.profileBound) {
    Add-Failure $failures "Factory Maintenance SSH ingress mode, listen address, and firewall interface scope must match the selected profile"
  }
  if ([string]$manifest.factoryProfile -eq "production" -and
      ([string]$maintenanceIngress.effectiveListenAddress -eq "0.0.0.0" -or [string]$maintenanceIngress.effectiveFirewallInterfaceScope -eq "Any")) {
    Add-Failure $failures "production verifier rejects wildcard SSH listener or firewall interface scope"
  }
  if ([string]$manifest.factoryProfile -eq "testbed" -and -not [bool]$maintenanceIngress.bootstrapTestbedOnly) {
    Add-Failure $failures "testbed verifier requires the explicit testbed bootstrap certificate ingress mode"
  }
  if ([string]$manifest.factoryProfile -eq "production" -and [string]$manifest.hardware.mode -ne "production") {
    Add-Failure $failures "production verifier rejects simulated hardware mode"
  }
  if ([string]$manifest.factoryProfile -eq "production" -and [string]$manifest.hardware.model -match "(?i)simulator|mock|tcp") {
    Add-Failure $failures "production verifier rejects simulator and TCP hardware identities"
  }
  if ([string]$manifest.factoryProfile -eq "production" -and $null -ne (Get-LocalUser -Name "YKDZ" -ErrorAction SilentlyContinue)) {
    Add-Failure $failures "production verifier rejects a live YKDZ testbed account"
  }
  if ([string]$manifest.factoryProfile -eq "production") {
    $daemonConfigPath = [string]$manifest.paths.daemonConfigPath
    if (Test-Path -LiteralPath $daemonConfigPath -PathType Leaf) {
      $daemonConfigText = Get-Content -LiteralPath $daemonConfigPath -Raw
      if ($daemonConfigText -match '(?i)"hardwareAdapter"\s*:\s*"mock"|"serialPortPath"\s*:\s*"tcp://|"machineCode"\s*:\s*"[^"]*(testbed|test|sim)') {
        Add-Failure $failures "production verifier rejects live daemon simulator/testbed hardware configuration"
      }
    }
  }
  if (-not [bool]$checks.factoryRemoteMaintenanceCapability.sshdEffectiveConfig.trustedUserCaKeys -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.sshdEffectiveConfig.syntaxValid -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.sshdEffectiveConfig.listenAddressMatches -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.sshdEffectiveConfig.passwordAuthentication -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.sshdEffectiveConfig.keyboardInteractiveAuthentication -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.sshdEffectiveConfig.authenticationMethods -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.sshdEffectiveConfig.authorizedKeysFile -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.sshdEffectiveConfig.allowUsers -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.sshdEffectiveConfig.denyUsers -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.sshdEffectiveConfig.systemEntrypoint) {
    Add-Failure $failures "effective sshd configuration must require the selected CA and public-key-only authentication without SYSTEM entrypoint"
  }
  if (-not [bool]$checks.factoryRemoteMaintenanceCapability.firewallScope.exists -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.firewallScope.enabled -or
      [string]$checks.factoryRemoteMaintenanceCapability.firewallScope.protocol -ne "TCP" -or
      [string]$checks.factoryRemoteMaintenanceCapability.firewallScope.localPort -ne "22" -or
      [string]$checks.factoryRemoteMaintenanceCapability.firewallScope.interfaceAlias -ne [string]$manifest.maintenanceSsh.effectiveFirewallInterfaceScope -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.firewallScope.sourceRolePoolsMatch -or
      @($checks.factoryRemoteMaintenanceCapability.firewallScope.unexpectedEnabledInboundTcp22Rules).Count -gt 0 -or
      @($checks.factoryRemoteMaintenanceCapability.firewallScope.listeners).Count -eq 0 -or
      @($checks.factoryRemoteMaintenanceCapability.firewallScope.unexpectedListeners).Count -gt 0) {
    Add-Failure $failures "Controlled Maintenance SSH firewall must be TCP 22 with the profile-bound listener/interface scope and exact runner/maintainer role pools"
  }
  if ([string]$checks.factoryRemoteMaintenanceCapability.wireGuardService.startupType -ne "Automatic" -or
      [string]$checks.factoryRemoteMaintenanceCapability.wireGuardService.status -ne "Running" -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.wireGuardService.serviceNameMatches -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.wireGuardService.ownerMatches -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.wireGuardService.independentOfKiosk -or
      ([string]$manifest.factoryProfile -eq "production" -and [bool]$checks.factoryRemoteMaintenanceCapability.wireGuardService.profileContamination)) {
    Add-Failure $failures "WireGuard machine maintenance service must be automatic and LocalSystem-owned"
  }
  foreach ($packageName in @("openSsh", "wireGuard")) {
    $package = $checks.factoryRemoteMaintenanceCapability.packageVersions.$packageName
    if (-not [bool]$package.installed -or -not [bool]$package.versionMatches -or [string]$package.source -notmatch "^(local-pinned|factory-cas://sha256/)" -or
        [string]$package.installedSignature.status -ne "Valid" -or -not [bool]$package.installedSignature.chainValid -or
        -not [bool]$package.installedSignature.signerMatchesApproved -or -not [bool]$package.installedSignature.rootMatchesApproved) {
      Add-Failure $failures "pinned $packageName package is not installed at the declared version/source"
    }
  }
  if (-not [bool]$checks.factoryRemoteMaintenanceCapability.caFingerprint.sha256Matches -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.caFingerprint.fingerprintMatches -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.caFingerprint.publicKeyOnly -or
      -not [bool]$checks.factoryRemoteMaintenanceCapability.caFingerprint.profileMatches -or
      [int]$checks.factoryRemoteMaintenanceCapability.caFingerprint.keyCount -ne 1) {
    Add-Failure $failures "Maintenance SSH CA fingerprint/hash does not match the selected profile"
  }
  $accountPolicy = $checks.factoryRemoteMaintenanceCapability.accountPolicy
  if (-not [bool]$accountPolicy.maintenanceAdministrator -or [bool]$accountPolicy.kioskAdministrator -or
      [string]$accountPolicy.maintenanceUser -cne [string]$accountPolicy.expectedMaintenanceUser -or
      [bool]$accountPolicy.kioskInOpenSshUsers -or [bool]$accountPolicy.kioskInRemoteDesktopUsers -or
      [bool]$accountPolicy.kioskInRemoteManagementUsers -or -not [bool]$accountPolicy.sshDenied -or
      -not [bool]$accountPolicy.remoteInteractiveDenied -or -not [bool]$accountPolicy.winRmDenied -or
      -not [bool]$accountPolicy.effectiveKioskRemoteAdministrationDenied) {
    Add-Failure $failures "maintenance administrator or kiosk effective remote-administration flags are incorrect"
  }
  if ([bool]$checks.factoryRemoteMaintenanceCapability.passwordAuthentication.passwordFallback) {
    Add-Failure $failures "OpenSSH password or raw authorized-key fallback remains enabled"
  }
  if ([string]$checks.factoryRemoteMaintenanceCapability.elevationCompatibility.systemSshEntrypoint -ne "not_configured" -or
      [string]$checks.factoryRemoteMaintenanceCapability.elevationCompatibility.administratorToSystem -ne "measured_supported") {
    Add-Failure $failures "explicit administrator-to-SYSTEM compatibility probe failed or SYSTEM SSH was configured"
  }

  $checks.consumerExperienceInterference = Get-ConsumerExperienceInterferenceEvidence
  if ([string]$checks.consumerExperienceInterference.storeAutomaticAppUpdates -ne "disabled") {
    Add-Failure $failures "Store automatic app updates are not disabled"
  }
  if ([string]$checks.consumerExperienceInterference.kioskForegroundTakeover -ne "best_effort_policy_configured") {
    Add-Failure $failures "consumer-experience best-effort foreground takeover policy evidence is not configured"
  }
}

$result = [ordered]@{
  schemaVersion = "vem-factory-runtime-verification/v2"
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  ok = $failures.Count -eq 0
  manifestPath = $ManifestPath
  evidencePath = $EvidencePath
  failures = @($failures)
  checks = $checks
}

Write-Evidence -Path $EvidencePath -Evidence ([pscustomobject]$result)
[pscustomobject]$result | ConvertTo-Json -Depth 30
if ($failures.Count -gt 0) {
  exit 1
}
exit 0
