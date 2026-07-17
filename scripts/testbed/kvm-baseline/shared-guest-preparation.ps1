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

# Retain the Windows facilities used by Tauri, audio, DirectShow/Media Foundation,
# serial hot-plug, network time, scheduled tasks, services, and diagnostics.
foreach ($service in "PlugPlay", "DeviceInstall", "Audiosrv", "AudioEndpointBuilder", "Dhcp", "W32Time", "Schedule", "EventLog") {
  Set-BaselineService -Name $service
}
foreach ($service in "DiagTrack", "SysMain", "MapsBroker", "XblGameSave") {
  $candidate = Get-Service -Name $service -ErrorAction SilentlyContinue
  if ($null -ne $candidate) { Set-Service -Name $service -StartupType Disabled }
}

powercfg /setactive SCHEME_MIN | Out-Null
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
icacls $administratorsKeys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null

Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name LogPixels -Type DWord -Value ([int](96 * $DesktopScalePercent / 100))
Set-ItemProperty -Path "HKCU:\Control Panel\Desktop" -Name Win8DpiScaling -Type DWord -Value 1
Set-DisplayResolution -Width $DesktopWidth -Height $DesktopHeight -Force

@{
  preparedAt = (Get-Date).ToUniversalTime().ToString("o")
  display = @{ width = $DesktopWidth; height = $DesktopHeight; scalePercent = $DesktopScalePercent }
  retainedServices = @("PlugPlay", "DeviceInstall", "Audiosrv", "AudioEndpointBuilder", "Dhcp", "W32Time", "Schedule", "EventLog")
} | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $baselineRoot "shared-preparation.json")
