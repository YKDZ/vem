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
  $defenderEnabled = if ($null -ne $defenderStatus) { [bool]$defenderStatus.AntispywareEnabled } else { $true }

  return [ordered]@{
    status = if ($defenderEnabled -and $firewallEnabled -and $enabledVemInboundRules.Count -eq 0 -and $missingExclusions.Count -eq 0 -and $fileSharingRulesEnabled.Count -eq 0) { "passed" } else { "failed" }
    defender = if ($defenderEnabled) { "enabled" } else { "disabled" }
    firewall = if ($firewallEnabled) { "enabled" } else { "disabled_or_unavailable" }
    defenderExclusions = $actualExclusions
    missingDefenderExclusions = $missingExclusions
    inboundFirewallRules = @($vemRules | ForEach-Object { [string]$_.DisplayName })
    enabledVemInboundRules = @($enabledVemInboundRules)
    fileAndPrinterSharing = if ($fileSharingRulesEnabled.Count -eq 0) { "not_enabled" } else { "enabled" }
    fileAndPrinterSharingEnabledRules = $fileSharingRulesEnabled
  }
}

function Test-LocalUserInGroup {
  param(
    [string]$User,
    [string]$Group
  )

  $members = @(Get-LocalGroupMember -Group $Group -ErrorAction SilentlyContinue)
  foreach ($member in $members) {
    $name = [string]$member.Name
    if ($name -eq $User -or $name -eq ".\$User" -or $name -eq "$env:COMPUTERNAME\$User" -or $name.EndsWith("\$User", [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  return $false
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
    [string]$MaintenanceUser
  )

  $sshd = Get-Service -Name "sshd" -ErrorAction SilentlyContinue
  $tailscale = Get-Service -Name "Tailscale" -ErrorAction SilentlyContinue
  $tailscaleCli = Get-Command "tailscale.exe" -ErrorAction SilentlyContinue
  $sshdConfigPath = "C:\ProgramData\ssh\sshd_config"
  $kioskUserForSshdDeny = $KioskUser.ToLowerInvariant()
  $sshdConfigDeniesKioskUser = Test-SshdConfigDeniesUser -ConfigPath $sshdConfigPath -User $kioskUserForSshdDeny
  $maintenanceInOpenSshUsers = Test-LocalUserInGroup -User $MaintenanceUser -Group "OpenSSH Users"
  $kioskInOpenSshUsers = Test-LocalUserInGroup -User $KioskUser -Group "OpenSSH Users"
  $kioskInRemoteDesktopUsers = Test-LocalUserInGroup -User $KioskUser -Group "Remote Desktop Users"
  $kioskRemoteAccessDenied = $sshdConfigDeniesKioskUser -and -not $kioskInOpenSshUsers -and -not $kioskInRemoteDesktopUsers
  $sshdReady = $null -ne $sshd -and [string]$sshd.Status -eq "Running" -and [string]$sshd.StartType -eq "Automatic"
  $tailscaleAbsent = $null -eq $tailscale -and $null -eq $tailscaleCli

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

$failures = [System.Collections.Generic.List[string]]::new()
$checks = [ordered]@{}
$manifest = $null

try {
  $manifest = Read-JsonFile -Path $ManifestPath
  $checks.manifest = [ordered]@{
    path = $ManifestPath
    schemaVersion = $manifest.schemaVersion
    layoutVersion = $manifest.layoutVersion
    hardwareMode = $manifest.hardware.mode
    hardwareModel = $manifest.hardware.model
    topologyIdentity = $manifest.topology.identity
    topologyVersion = $manifest.topology.version
    exists = $true
  }
  if ([string]$manifest.schemaVersion -ne "vem-factory-runtime-manifest/v1") {
    Add-Failure $failures "unexpected factory manifest schema: $($manifest.schemaVersion)"
  }
} catch {
  Add-Failure $failures $_.Exception.Message
}

if ($null -ne $manifest) {
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
  if (@($checks.securityPosture.enabledVemInboundRules).Count -gt 0) {
    Add-Failure $failures "default Factory Runtime Image must not enable product-managed inbound remote access rules: $($checks.securityPosture.enabledVemInboundRules -join ', ')"
  }
  if ([string]$checks.securityPosture.fileAndPrinterSharing -ne "not_enabled") {
    Add-Failure $failures "File and Printer Sharing firewall rules must not be enabled as a maintenance entry"
  }

  $checks.factoryRemoteMaintenanceCapability = Get-FactoryRemoteMaintenanceCapabilityEvidence -KioskUser ([string]$manifest.expectations.kioskUser) -MaintenanceUser ([string]$manifest.expectations.maintenanceUser)
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

  $checks.consumerExperienceInterference = Get-ConsumerExperienceInterferenceEvidence
  if ([string]$checks.consumerExperienceInterference.storeAutomaticAppUpdates -ne "disabled") {
    Add-Failure $failures "Store automatic app updates are not disabled"
  }
  if ([string]$checks.consumerExperienceInterference.kioskForegroundTakeover -ne "best_effort_policy_configured") {
    Add-Failure $failures "consumer-experience best-effort foreground takeover policy evidence is not configured"
  }
}

$result = [ordered]@{
  schemaVersion = "vem-factory-runtime-verification/v1"
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
