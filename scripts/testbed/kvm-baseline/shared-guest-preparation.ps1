[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $WebView2InstallerUri,
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

$webView2Installer = Join-Path $env:TEMP "MicrosoftEdgeWebView2Setup.exe"
Invoke-WebRequest -UseBasicParsing -Uri $WebView2InstallerUri -OutFile $webView2Installer
$webView2 = Start-Process -FilePath $webView2Installer -ArgumentList "/silent", "/install" -Wait -PassThru
if ($webView2.ExitCode -ne 0) { throw "WebView2 installer failed with exit code $($webView2.ExitCode)" }

Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" | Out-Null
Set-BaselineService -Name "sshd"
$administratorsKeys = "C:\ProgramData\ssh\administrators_authorized_keys"
Copy-Item -Force $AuthorizedKeysPath $administratorsKeys
Invoke-Native -FilePath "icacls.exe" -ArgumentList @($administratorsKeys, "/inheritance:r", "/grant", "Administrators:F", "/grant", "SYSTEM:F") -Description "OpenSSH administrator key ACL"

Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name LogPixels -Type DWord -Value ([int](96 * $DesktopScalePercent / 100))
Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name Win8DpiScaling -Type DWord -Value 1
Set-ClientDisplayMode -Width $DesktopWidth -Height $DesktopHeight

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
