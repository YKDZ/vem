[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $WebView2InstallerUri,
  [Parameter(Mandatory = $true)] [string] $AuthorizedKeysPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
# Direct physical SSH host preparation invokes this shared entrypoint with only
# WebView2 and administrator-key inputs; it deliberately has no VM devices.
$baselineRoot = "C:\ProgramData\WindowsRuntimeBaseline"
New-Item -ItemType Directory -Force -Path $baselineRoot | Out-Null

function Set-BaselineService {
  param([string] $Name, [string] $StartupType = "Automatic", [switch] $PreserveStartupType)
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $service) { throw "$Name service is unavailable" }
  if (-not $PreserveStartupType) {
    Set-Service -Name $Name -StartupType $StartupType
  }
  if ($service.Status -ne "Running") { Start-Service -Name $Name }
  if ((Get-Service -Name $Name -ErrorAction Stop).Status -ne "Running") {
    throw "$Name must be running after baseline preparation"
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

# Retain the Windows facilities used by Tauri, audio, DirectShow/Media Foundation,
# serial hot-plug, network time, scheduled tasks, services, and diagnostics.
foreach ($service in "PlugPlay", "DeviceInstall", "Audiosrv", "AudioEndpointBuilder", "Dhcp", "W32Time", "EventLog") {
  Set-BaselineService -Name $service
}
# Task Scheduler protects its startup configuration. Retain its configured
# startup type, start it only when necessary, and require it to be running.
Set-BaselineService -Name "Schedule" -PreserveStartupType
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

for ($attempt = 1; $attempt -le 3; $attempt++) {
  try {
    Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" | Out-Null
  } catch {
    if ($attempt -eq 3) { throw }
    Start-Sleep -Seconds 10
    continue
  }
  $openSsh = Get-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0"
  if ([string]$openSsh.State -eq "Installed") { break }
  if ($attempt -eq 3) { throw "OpenSSH Server capability did not reach Installed state" }
  Start-Sleep -Seconds 10
}
Set-BaselineService -Name "sshd"
$administratorsKeys = "C:\ProgramData\ssh\administrators_authorized_keys"
Copy-Item -Force $AuthorizedKeysPath $administratorsKeys
Invoke-Native -FilePath "icacls.exe" -ArgumentList @($administratorsKeys, "/inheritance:r", "/grant", "*S-1-5-32-544:F", "/grant", "SYSTEM:F") -Description "OpenSSH administrator key ACL"

@{
  preparedAt = (Get-Date).ToUniversalTime().ToString("o")
  retainedServices = @("PlugPlay", "DeviceInstall", "Audiosrv", "AudioEndpointBuilder", "Dhcp", "W32Time", "Schedule", "EventLog")
} | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 (Join-Path $baselineRoot "shared-preparation.json")
