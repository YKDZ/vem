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
  [Parameter(Mandatory = $false)][string]$KioskPassword,
  [Parameter(Mandatory = $false)][string]$MaintenancePassword,
  [Parameter(Mandatory = $false)][string]$AutoLogonPassword,
  [Parameter(Mandatory = $false)][string]$MaintenanceRelayWireGuardInstallerPath,
  [Parameter(Mandatory = $false)][string]$MaintenanceRelayWireGuardInstallerSha256,
  [Parameter(Mandatory = $false)][string]$MaintenanceRelayWireGuardConfigPath,
  [Parameter(Mandatory = $false)][string]$MaintenanceRelayWireGuardConfigSha256,
  [Parameter(Mandatory = $false)][string]$MaintenanceRelayTunnelName = "vem-maint",
  [Parameter(Mandatory = $false)][string[]]$MaintenanceRelaySourceAllowlist,

  [switch]$ResetExistingVemState,
  [switch]$UseSecureCredentialEnvironment,
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
      "TargetLayoutVersion"
    )) {
    $value = Get-Variable -Name $name -ValueOnly -ErrorAction SilentlyContinue
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value) -or [string]$value -eq "0") {
      $missing += $name
    }
  }

  if ($missing.Count -gt 0) {
    throw ("missing required input: {0}" -f ($missing -join ", "))
  }

  Normalize-Sha256 -Value $DaemonSha256 | Out-Null
  Normalize-Sha256 -Value $MachineUiSha256 | Out-Null
}

function Resolve-CredentialInput {
  param(
    [string]$Name,
    [string]$ExplicitValue,
    [string]$EnvironmentName
  )

  if (-not [string]::IsNullOrEmpty($ExplicitValue)) {
    return [ordered]@{
      name = $Name
      value = $ExplicitValue
      source = "explicit_parameter"
    }
  }

  if (-not $UseSecureCredentialEnvironment) {
    throw "missing required credential input: $Name. Pass -$Name explicitly or add explicit -UseSecureCredentialEnvironment acknowledgement"
  }

  $environmentValue = [Environment]::GetEnvironmentVariable($EnvironmentName)
  if ([string]::IsNullOrEmpty($environmentValue)) {
    throw "missing required credential input: $Name from secure environment variable $EnvironmentName"
  }

  return [ordered]@{
    name = $Name
    value = $environmentValue
    source = "secure_environment"
  }
}

function Assert-CredentialInputs {
  $kiosk = Resolve-CredentialInput -Name "KioskPassword" -ExplicitValue $KioskPassword -EnvironmentName "VEM_KIOSK_PASSWORD"
  $maintenance = Resolve-CredentialInput -Name "MaintenancePassword" -ExplicitValue $MaintenancePassword -EnvironmentName "VEM_MAINTENANCE_PASSWORD"
  $autoLogon = Resolve-CredentialInput -Name "AutoLogonPassword" -ExplicitValue $AutoLogonPassword -EnvironmentName "VEM_AUTOLOGON_PASSWORD"

  return [pscustomobject]@{
    KioskPassword = [string]$kiosk.value
    MaintenancePassword = [string]$maintenance.value
    AutoLogonPassword = [string]$autoLogon.value
    Sources = [ordered]@{
      kioskPassword = [string]$kiosk.source
      maintenancePassword = [string]$maintenance.source
      autoLogonPassword = [string]$autoLogon.source
    }
  }
}

function Test-MaintenanceRelayRequested {
  return (
    -not [string]::IsNullOrWhiteSpace($MaintenanceRelayWireGuardInstallerPath) -or
    -not [string]::IsNullOrWhiteSpace($MaintenanceRelayWireGuardInstallerSha256) -or
    -not [string]::IsNullOrWhiteSpace($MaintenanceRelayWireGuardConfigPath) -or
    -not [string]::IsNullOrWhiteSpace($MaintenanceRelayWireGuardConfigSha256) -or
    @($MaintenanceRelaySourceAllowlist).Count -gt 0
  )
}

function Assert-MaintenanceRelayInputs {
  if (-not (Test-MaintenanceRelayRequested)) {
    return [ordered]@{
      enabled = $false
      status = "not_configured"
    }
  }

  $missing = @()
  foreach ($name in @(
      "MaintenanceRelayWireGuardInstallerPath",
      "MaintenanceRelayWireGuardInstallerSha256",
      "MaintenanceRelayWireGuardConfigPath",
      "MaintenanceRelayWireGuardConfigSha256"
    )) {
    $value = Get-Variable -Name $name -ValueOnly -ErrorAction SilentlyContinue
    if ($null -eq $value -or [string]::IsNullOrWhiteSpace([string]$value)) {
      $missing += $name
    }
  }
  if (@($MaintenanceRelaySourceAllowlist).Count -eq 0) {
    $missing += "MaintenanceRelaySourceAllowlist"
  }
  if ($missing.Count -gt 0) {
    throw ("missing maintenance relay input: {0}" -f ($missing -join ", "))
  }

  if ($MaintenanceRelayTunnelName -notmatch "^[A-Za-z0-9_=+.-]{1,32}$") {
    throw "MaintenanceRelayTunnelName must be 1-32 WireGuard tunnel-safe characters"
  }
  foreach ($source in @($MaintenanceRelaySourceAllowlist)) {
    $trimmed = [string]$source
    if ([string]::IsNullOrWhiteSpace($trimmed)) {
      throw "MaintenanceRelaySourceAllowlist must not contain empty values"
    }
    if ($trimmed -match "^(0\.0\.0\.0/0|::/0|Any)$") {
      throw "MaintenanceRelaySourceAllowlist must not contain broad sources: $trimmed"
    }
  }

  $installerHash = Assert-Sha256 -Path $MaintenanceRelayWireGuardInstallerPath -ExpectedSha256 $MaintenanceRelayWireGuardInstallerSha256
  $configHash = Assert-Sha256 -Path $MaintenanceRelayWireGuardConfigPath -ExpectedSha256 $MaintenanceRelayWireGuardConfigSha256
  $configText = [System.IO.File]::ReadAllText($MaintenanceRelayWireGuardConfigPath, [System.Text.Encoding]::UTF8)
  if (-not ($configText -match "(?im)^\s*\[Interface\]\s*$") -or -not ($configText -match "(?im)^\s*PrivateKey\s*=")) {
    throw "maintenance relay WireGuard config must contain an Interface PrivateKey"
  }
  if ($configText -match "(?im)^\s*AllowedIPs\s*=\s*(0\.0\.0\.0/0|::/0)") {
    throw "maintenance relay WireGuard config must not route broad AllowedIPs"
  }

  return [ordered]@{
    enabled = $true
    status = "preflight_passed"
    tunnelName = $MaintenanceRelayTunnelName
    installerPath = $MaintenanceRelayWireGuardInstallerPath
    installerSha256 = $installerHash
    configPath = $MaintenanceRelayWireGuardConfigPath
    configSha256 = $configHash
    sourceAllowlist = @($MaintenanceRelaySourceAllowlist | ForEach-Object { [string]$_ })
  }
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
  $maintenanceRelay = Assert-MaintenanceRelayInputs
  $supportScripts = @(
    "setup-scheduled-tasks.ps1",
    "verify-factory-runtime.ps1",
    "verify-kiosk-lockdown.ps1",
    "verify-vem-runtime.ps1",
    "apply-managed-update.ps1"
  ) | ForEach-Object { Assert-SupportScriptPresent -Name $_ }

  return [pscustomobject]@{
    DaemonSha256 = $daemonHash
    MachineUiSha256 = $machineUiHash
    MachineUiSidecarSha256 = $machineUiSidecarHash
    KioskPassword = $credentials.KioskPassword
    MaintenancePassword = $credentials.MaintenancePassword
    AutoLogonPassword = $credentials.AutoLogonPassword
    CredentialSources = $credentials.Sources
    MaintenanceRelay = $maintenanceRelay
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
      maintenanceRelay = $Preflight.MaintenanceRelay
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
      maintenanceRelayRoot = Join-Path $ProgramDataRoot "maintenance-relay"
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
      (Join-Path $ProgramDataRoot "maintenance-relay"),
      "C:\ProgramData\VEM\overrides"
    )
    registrations = [ordered]@{
      daemonServiceName = "VemVendingDaemon"
      machineUiTaskName = "VEMMachineUI"
      maintenanceUiTaskName = "VEMMaintenanceUI"
      visionTaskName = "VEM\StartVisionServer"
      setupScript = Join-Path $scriptsRoot "setup-scheduled-tasks.ps1"
      verifierScript = Join-Path $scriptsRoot "verify-factory-runtime.ps1"
      maintenanceRelayTunnelServiceName = if ([bool]$Preflight.MaintenanceRelay.enabled) { "WireGuardTunnel${MaintenanceRelayTunnelName}" } else { $null }
    }
    resetEvidence = New-EmptyResetEvidence
  }
}

function Get-WireGuardExePath {
  foreach ($path in @(
      "C:\Program Files\WireGuard\wireguard.exe",
      "C:\Program Files (x86)\WireGuard\wireguard.exe"
    )) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      return $path
    }
  }
  return $null
}

function Get-WgExePath {
  foreach ($path in @(
      "C:\Program Files\WireGuard\wg.exe",
      "C:\Program Files (x86)\WireGuard\wg.exe"
    )) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      return $path
    }
  }
  return $null
}

function Install-MaintenanceRelayWireGuard {
  param($MaintenanceRelay)

  if (-not [bool]$MaintenanceRelay.enabled) {
    return [ordered]@{
      enabled = $false
      status = "not_configured"
    }
  }

  Assert-Sha256 -Path $MaintenanceRelay.installerPath -ExpectedSha256 $MaintenanceRelay.installerSha256 | Out-Null
  Assert-Sha256 -Path $MaintenanceRelay.configPath -ExpectedSha256 $MaintenanceRelay.configSha256 | Out-Null

  $wireGuardExe = Get-WireGuardExePath
  if ($null -eq $wireGuardExe) {
    $extension = [System.IO.Path]::GetExtension([string]$MaintenanceRelay.installerPath).ToLowerInvariant()
    if ($extension -eq ".msi") {
      $process = Start-Process -FilePath "msiexec.exe" -ArgumentList @("/i", [string]$MaintenanceRelay.installerPath, "/qn", "/norestart") -PassThru -Wait
    } else {
      $process = Start-Process -FilePath ([string]$MaintenanceRelay.installerPath) -ArgumentList @("/install", "/quiet", "/norestart") -PassThru -Wait
    }
    if ($process.ExitCode -ne 0) {
      throw "WireGuard installer failed with exit code $($process.ExitCode)"
    }
    $wireGuardExe = Get-WireGuardExePath
  }
  if ($null -eq $wireGuardExe) {
    throw "WireGuard executable not found after installer completed"
  }

  $relayRoot = "C:\ProgramData\VEM\maintenance-relay"
  Ensure-Directory -Path $relayRoot
  $targetConfig = Join-Path $relayRoot ("{0}.conf" -f $MaintenanceRelay.tunnelName)
  Copy-Item -LiteralPath ([string]$MaintenanceRelay.configPath) -Destination $targetConfig -Force
  icacls.exe $targetConfig /inheritance:r /grant:r "SYSTEM:F" "Administrators:F" | Out-Null

  $serviceName = "WireGuardTunnel{0}" -f $MaintenanceRelay.tunnelName
  $existingService = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
  if ($null -ne $existingService) {
    Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
    & $wireGuardExe /uninstalltunnelservice ([string]$MaintenanceRelay.tunnelName) | Out-Null
  }
  & $wireGuardExe /installtunnelservice $targetConfig | Out-Null
  Set-Service -Name $serviceName -StartupType Automatic
  Start-Service -Name $serviceName

  return [ordered]@{
    enabled = $true
    status = "configured"
    tunnelName = [string]$MaintenanceRelay.tunnelName
    serviceName = $serviceName
    serviceStartupType = "Automatic"
    configPath = $targetConfig
    configSha256 = [string]$MaintenanceRelay.configSha256
    installerSha256 = [string]$MaintenanceRelay.installerSha256
    wireGuardExe = $wireGuardExe
    wgExe = Get-WgExePath
    sourceAllowlist = @($MaintenanceRelay.sourceAllowlist)
  }
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

function New-EmptyResetEvidence {
  $preserved = @(
    (New-EvidenceItem `
        -Category "factory_manifest" `
        -Path "C:\ProgramData\VEM\factory" `
        -Reason "factory manifest directory is not local machine state")
  )
  $skipped = @(
    (New-EvidenceItem `
        -Category "platform_business_data" `
        -Path "C:\ProgramData\VEM" `
        -Reason "platform machines, orders, inventory, payments, planograms, and audit records are outside local runtime reset"),
    (New-EvidenceItem `
        -Category "keyring_secret_material" `
        -Path "keyring://VEM" `
        -Reason "keyring-backed secret status is unknown and is not cleared by local filesystem reset")
  )

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

  $service = Get-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue
  if ($null -ne $service) {
    Add-FoundState -Found $found -Category "daemon_service" -Path "service://VemVendingDaemon" -Reason "old VEM daemon service exists"
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

  $baselineApplication = Apply-FactoryWindowsBaseline -Policy $Plan.factoryWindowsBaselinePolicy

  Copy-Item -LiteralPath $DaemonArtifactPath -Destination (Join-Path $RuntimeRoot "vending-daemon.exe") -Force
  Copy-Item -LiteralPath $MachineUiArtifactPath -Destination (Join-Path $RuntimeRoot "machine.exe") -Force
  Copy-Item -LiteralPath $machineUiSidecarPath -Destination (Join-Path $RuntimeRoot "WebView2Loader.dll") -Force

  $scriptsRoot = [string]$Plan.layout.scriptsRoot
  Copy-ScriptIfPresent -Name "setup-scheduled-tasks.ps1" -TargetDirectory $scriptsRoot
  Copy-ScriptIfPresent -Name "verify-factory-runtime.ps1" -TargetDirectory $scriptsRoot
  Copy-ScriptIfPresent -Name "verify-kiosk-lockdown.ps1" -TargetDirectory $scriptsRoot
  Copy-ScriptIfPresent -Name "verify-vem-runtime.ps1" -TargetDirectory $scriptsRoot
  Copy-ScriptIfPresent -Name "apply-managed-update.ps1" -TargetDirectory $scriptsRoot

  $machineUiStartupMode = if (Test-ShellLauncherAvailable) { "shell_launcher" } else { "scheduled_task" }
  $manifest = [ordered]@{
    schemaVersion = "vem-factory-runtime-manifest/v1"
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    layoutVersion = $TargetLayoutVersion
    environmentName = $EnvironmentName
    provisioningEndpoint = $ProvisioningEndpoint
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
      maintenanceRelay = if ([bool]$Preflight.MaintenanceRelay.enabled) {
        [ordered]@{
          kind = "wireguard-maintenance-relay"
          bootstrapMode = "preconfigured-base-image"
          tunnelName = [string]$Preflight.MaintenanceRelay.tunnelName
          tunnelServiceName = "WireGuardTunnel${MaintenanceRelayTunnelName}"
          configPath = Join-Path ([string]$Plan.layout.maintenanceRelayRoot) ("{0}.conf" -f $Preflight.MaintenanceRelay.tunnelName)
          configSha256 = [string]$Preflight.MaintenanceRelay.configSha256
          installerSha256 = [string]$Preflight.MaintenanceRelay.installerSha256
          controlledMaintenanceIngress = [ordered]@{
            transport = "ssh"
            port = 22
            sourceAllowlist = @($Preflight.MaintenanceRelay.sourceAllowlist)
          }
        }
      } else {
        [ordered]@{
          kind = "none"
          bootstrapMode = "not_configured"
        }
      }
    }
    components = $Plan.inputs.components
    paths = $Plan.layout
  }
  Write-JsonFile -Path ([string]$Plan.layout.manifestPath) -Value ([pscustomobject]$manifest)

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

  $maintenanceRelayApplication = Install-MaintenanceRelayWireGuard -MaintenanceRelay $Preflight.MaintenanceRelay

  $setupArguments = @(
    "-ConfigureKioskAccounts",
    "-ConfigureAutoLogon",
    "-KioskPassword",
    $Preflight.KioskPassword,
    "-MaintenancePassword",
    $Preflight.MaintenancePassword,
    "-AutoLogonPassword",
    $Preflight.AutoLogonPassword,
    "-KioskUser",
    $ExpectedKioskUser,
    "-MaintenanceUser",
    $ExpectedMaintenanceUser,
    "-ConfigureLocalMaintenanceAccess",
    "-RunAsUser",
    $ExpectedAutoLogonUser,
    "-MachineUiExe",
    (Join-Path $RuntimeRoot "machine.exe"),
    "-DaemonExe",
    (Join-Path $RuntimeRoot "vending-daemon.exe"),
    "-ConfigureKioskShell",
    "-UseKioskAccount"
  )
  if ([bool]$Preflight.MaintenanceRelay.enabled) {
    $setupArguments += @(
      "-ConfigureControlledMaintenanceIngress",
      "-MaintenanceIngressSourceAllowlist"
    )
    $setupArguments += @($Preflight.MaintenanceRelay.sourceAllowlist)
  }

  New-Service -Name "VemVendingDaemon" -BinaryPathName (Join-Path $RuntimeRoot "vending-daemon.exe") -StartupType Automatic -DisplayName "VEM Vending Daemon" -ErrorAction SilentlyContinue | Out-Null
  & (Join-Path $scriptsRoot "setup-scheduled-tasks.ps1") @setupArguments

  return [ordered]@{
    maintenanceRelayApplication = $maintenanceRelayApplication
  }
}

Assert-RequiredInputs
$preflight = Assert-FactoryRuntimePreflight
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
  maintenanceRelay = $writeResult.maintenanceRelayApplication
}
$result | ConvertTo-Json -Depth 30
