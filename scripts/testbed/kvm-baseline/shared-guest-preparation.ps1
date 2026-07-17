[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $WebView2InstallerUri,
  [Parameter(Mandatory = $true)] [string] $SpiceGuestToolsInstallerPath,
  [Parameter(Mandatory = $true)] [string] $AuthorizedKeysPath,
  [int] $DesktopWidth = 1080,
  [int] $DesktopHeight = 1920,
  [int] $DesktopScalePercent = 100
)

$ErrorActionPreference = "Stop"
$baselineRoot = "C:\ProgramData\WindowsRuntimeBaseline"
New-Item -ItemType Directory -Force -Path $baselineRoot | Out-Null

function Set-BaselineService {
  param([string] $Name, [string] $StartupType = "Automatic")
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($null -ne $service) {
    Set-Service -Name $Name -StartupType $StartupType
    if ($service.Status -ne "Running") { Start-Service -Name $Name }
  }
}

function Disable-BaselineService {
  param([string] $Name)
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($null -ne $service) {
    if ($service.Status -ne "Stopped") { Stop-Service -Name $Name -Force -ErrorAction Stop }
    Set-Service -Name $Name -StartupType Disabled
  }
}

function Invoke-Native {
  param([string] $FilePath, [string[]] $ArgumentList, [string] $Description)
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE" }
}

function Get-BootIdentity {
  return (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString("o")
}

function Write-SpiceGuestToolsInstallationState {
  param([object] $State)
  $State | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $baselineRoot "spice-guest-tools-installation.json")
}

function Register-SpiceGuestToolsResume {
  $scriptPath = Join-Path $baselineRoot "scripts\shared-guest-preparation.ps1"
  if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "shared guest preparation script is unavailable for SPICE reboot resume" }
  $arguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $scriptPath + '"'),
    "-WebView2InstallerUri", ('"' + $WebView2InstallerUri + '"'),
    "-SpiceGuestToolsInstallerPath", ('"' + $SpiceGuestToolsInstallerPath + '"'),
    "-AuthorizedKeysPath", ('"' + $AuthorizedKeysPath + '"'),
    "-DesktopWidth", $DesktopWidth,
    "-DesktopHeight", $DesktopHeight,
    "-DesktopScalePercent", $DesktopScalePercent
  ) -join " "
  New-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce" -Force | Out-Null
  Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce" -Name "VemResumeSpiceGuestToolsPreparation" -Value ("powershell.exe " + $arguments)
}

function Invoke-SpiceGuestToolsInstallerAsSystem {
  param([string] $InstallerPath)
  if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) { throw "SPICE guest tools installer is unavailable: $InstallerPath" }
  $taskName = "VemInstallSpiceGuestTools-$PID"
  $startedAt = Get-Date
  $action = New-ScheduledTaskAction -Execute $InstallerPath -Argument "/S"
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal -Force | Out-Null
  try {
    Start-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddMinutes(10)
    do {
      Start-Sleep -Seconds 1
      $task = Get-ScheduledTask -TaskName $taskName
      $info = Get-ScheduledTaskInfo -TaskName $taskName
      if ($task.State -ne "Running" -and $info.LastRunTime -ge $startedAt.AddSeconds(-2)) { return [int] $info.LastTaskResult }
    } while ((Get-Date) -lt $deadline)
    throw "SPICE guest tools installer timed out"
  } finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  }
}

function Install-SpiceGuestTools {
  $statePath = Join-Path $baselineRoot "spice-guest-tools-installation.json"
  $currentBootIdentity = Get-BootIdentity
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ($state.schemaVersion -ne "win10-kvm-spice-guest-tools-installation/v1") { throw "SPICE guest tools installation state schema is invalid" }
    if ($state.exitCode -eq 0 -and -not $state.rebootRequired -and -not $state.rebootApplied) { return }
    if ($state.exitCode -eq 3010 -and $state.rebootRequired -and $state.installBootIdentity -ne $currentBootIdentity) {
      $state.rebootApplied = $true
      $state.resumeBootIdentity = $currentBootIdentity
      Write-SpiceGuestToolsInstallationState -State $state
      return
    }
    throw "SPICE guest tools installation state has invalid reboot semantics"
  }
  $exitCode = Invoke-SpiceGuestToolsInstallerAsSystem -InstallerPath $SpiceGuestToolsInstallerPath
  if ($exitCode -eq 0) {
    Write-SpiceGuestToolsInstallationState -State @{ schemaVersion = "win10-kvm-spice-guest-tools-installation/v1"; installerFile = (Split-Path -Leaf $SpiceGuestToolsInstallerPath); exitCode = 0; rebootRequired = $false; rebootApplied = $false; installBootIdentity = $currentBootIdentity }
    return
  }
  if ($exitCode -eq 3010) {
    Write-SpiceGuestToolsInstallationState -State @{ schemaVersion = "win10-kvm-spice-guest-tools-installation/v1"; installerFile = (Split-Path -Leaf $SpiceGuestToolsInstallerPath); exitCode = 3010; rebootRequired = $true; rebootApplied = $false; installBootIdentity = $currentBootIdentity }
    Register-SpiceGuestToolsResume
    Restart-Computer -Force
    throw "SPICE guest tools requested a reboot but Windows did not restart"
  }
  if ($exitCode -eq 1641) { throw "SPICE guest tools initiated an unmanaged reboot" }
  throw "SPICE guest tools installer failed with exit code $exitCode"
}

function Disable-RemainingAutomaticLogon {
  $winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
  Remove-ItemProperty -Path $winlogon -Name "AutoLogonCount" -ErrorAction SilentlyContinue
  Set-ItemProperty -Path $winlogon -Name "AutoAdminLogon" -Value "0"
}

function Set-ClientDisplayMode {
  param([int] $Width, [int] $Height)
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class Win10Display {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)] public struct DEVMODE { [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName; public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput; public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName; public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency, dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight; }
  [DllImport("user32.dll", CharSet = CharSet.Ansi)] public static extern int ChangeDisplaySettings(ref DEVMODE mode, int flags);
  public const int CDS_UPDATEREGISTRY = 0x00000001;
  public static int Set(int width, int height) { var mode = new DEVMODE(); mode.dmSize = (short)Marshal.SizeOf(mode); mode.dmFields = 0x00080000 | 0x00100000; mode.dmPelsWidth = width; mode.dmPelsHeight = height; return ChangeDisplaySettings(ref mode, CDS_UPDATEREGISTRY); }
}
'@ -ErrorAction SilentlyContinue
  if ([Win10Display]::Set($Width, $Height) -ne 0) { throw "Windows client display mode $Width x $Height is unavailable" }
}

# Retain the Windows facilities used by Tauri, audio, DirectShow/Media Foundation,
# serial hot-plug, network time, scheduled tasks, services, and diagnostics.
foreach ($service in "PlugPlay", "DeviceInstall", "Audiosrv", "AudioEndpointBuilder", "Dhcp", "W32Time", "Schedule", "EventLog") {
  Set-BaselineService -Name $service
}
foreach ($service in "DiagTrack", "SysMain", "MapsBroker", "XblGameSave") {
  Disable-BaselineService -Name $service
}

Invoke-Native -FilePath "powercfg.exe" -ArgumentList @("/setactive", "SCHEME_MIN") -Description "power plan configuration"
foreach ($feature in "MediaPlayback", "WindowsMediaPlayer") {
  $optional = Get-WindowsOptionalFeature -Online -FeatureName $feature -ErrorAction SilentlyContinue
  if ($null -ne $optional -and $optional.State -ne "Enabled") {
    Enable-WindowsOptionalFeature -Online -FeatureName $feature -All -NoRestart | Out-Null
  }
}

Install-SpiceGuestTools

$webView2Installer = Join-Path $env:TEMP "MicrosoftEdgeWebView2Setup.exe"
Invoke-WebRequest -UseBasicParsing -Uri $WebView2InstallerUri -OutFile $webView2Installer
$webView2 = Start-Process -FilePath $webView2Installer -ArgumentList "/silent", "/install" -Wait -PassThru
if ($webView2.ExitCode -ne 0) { throw "WebView2 installer failed with exit code $($webView2.ExitCode)" }

Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" | Out-Null
Set-BaselineService -Name "sshd"
$administratorsKeys = "C:\ProgramData\ssh\administrators_authorized_keys"
Copy-Item -Force $AuthorizedKeysPath $administratorsKeys
Invoke-Native -FilePath "icacls.exe" -ArgumentList @($administratorsKeys, "/inheritance:r", "/grant", "*S-1-5-32-544:F", "/grant", "SYSTEM:F") -Description "OpenSSH administrator key ACL"

Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name LogPixels -Type DWord -Value ([int](96 * $DesktopScalePercent / 100))
Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name Win8DpiScaling -Type DWord -Value 1
Set-ClientDisplayMode -Width $DesktopWidth -Height $DesktopHeight
Disable-RemainingAutomaticLogon

Add-Type -AssemblyName System.Windows.Forms
$primary = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$dpi = Get-ItemPropertyValue -Path "HKCU:\Control Panel\Desktop" -Name LogPixels -ErrorAction Stop
$scalePercent = [int]($dpi * 100 / 96)
$interactiveUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$interactiveSessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
if ($primary.Width -ne $DesktopWidth -or $primary.Height -ne $DesktopHeight -or $scalePercent -ne $DesktopScalePercent) {
  throw "interactive autologon desktop did not apply $DesktopWidth x $DesktopHeight at $DesktopScalePercent percent scale"
}
$interactiveDisplayReport = @{
  schemaVersion = "win10-kvm-interactive-display/v1"
  capturedAt = (Get-Date).ToUniversalTime().ToString("o")
  interactiveUser = $interactiveUser
  interactiveSessionId = $interactiveSessionId
  desktop = @{ width = $primary.Width; height = $primary.Height; scalePercent = $scalePercent }
}
$interactiveDisplayReport | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $baselineRoot "interactive-display-report.json")

@{
  preparedAt = (Get-Date).ToUniversalTime().ToString("o")
  display = $interactiveDisplayReport.desktop
  interactiveDisplayReport = (Join-Path $baselineRoot "interactive-display-report.json")
  retainedServices = @("PlugPlay", "DeviceInstall", "Audiosrv", "AudioEndpointBuilder", "Dhcp", "W32Time", "Schedule", "EventLog")
} | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $baselineRoot "shared-preparation.json")
