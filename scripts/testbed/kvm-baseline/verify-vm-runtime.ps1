[CmdletBinding()]
param(
  [int] $ExpectedWidth = 1080,
  [int] $ExpectedHeight = 1920,
  [int] $ExpectedScalePercent = 100,
  [Parameter(Mandatory = $true)] [string] $ExpectedInteractiveUser,
  [string] $OutputPath = "C:\ProgramData\WindowsRuntimeBaseline\verification.json"
)

$ErrorActionPreference = "Stop"
$baselineRoot = "C:\ProgramData\WindowsRuntimeBaseline"
$spiceGuestToolsInstallationPath = Join-Path $baselineRoot "spice-guest-tools-installation.json"
$interactiveDisplayReportPath = Join-Path $baselineRoot "interactive-display-report.json"
if (-not (Test-Path -LiteralPath $interactiveDisplayReportPath)) { throw "interactive autologon display report is unavailable" }
$interactiveDisplay = Get-Content -Raw -LiteralPath $interactiveDisplayReportPath | ConvertFrom-Json
if ($interactiveDisplay.schemaVersion -ne "win10-kvm-interactive-display/v1") { throw "interactive display report schema is invalid" }
if ($interactiveDisplay.interactiveUser -notmatch ("\\" + [regex]::Escape($ExpectedInteractiveUser) + "$")) { throw "interactive display report belongs to an unexpected user" }
$interactiveSessionId = 0
if (-not [int]::TryParse([string]$interactiveDisplay.interactiveSessionId, [ref]$interactiveSessionId) -or $interactiveSessionId -lt 1) { throw "interactive display report has an invalid session binding" }
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$webView2 = Get-ChildItem "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients", "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients" -ErrorAction SilentlyContinue |
  Get-ItemProperty -ErrorAction SilentlyContinue |
  Where-Object { $_.pv -and $_.name -match "WebView" } |
  Select-Object -First 1
$spiceGuestTools = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*", "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
  Where-Object { $_.DisplayName -match "SPICE Guest Tools" } |
  Select-Object -First 1
$qxlDisplayAdapter = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -match "QXL" } |
  Select-Object -First 1
$spiceGuestToolsInstallation = $null
if (Test-Path -LiteralPath $spiceGuestToolsInstallationPath -PathType Leaf) {
  $spiceGuestToolsInstallation = Get-Content -Raw -LiteralPath $spiceGuestToolsInstallationPath | ConvertFrom-Json
}
$spiceGuestToolsRebootSemantics = $null -ne $spiceGuestToolsInstallation -and $spiceGuestToolsInstallation.schemaVersion -eq "win10-kvm-spice-guest-tools-installation/v1" -and (
  ($spiceGuestToolsInstallation.exitCode -eq 0 -and -not $spiceGuestToolsInstallation.rebootRequired -and -not $spiceGuestToolsInstallation.rebootApplied) -or
  ($spiceGuestToolsInstallation.exitCode -eq 3010 -and $spiceGuestToolsInstallation.rebootRequired -and $spiceGuestToolsInstallation.rebootApplied -and $spiceGuestToolsInstallation.installBootIdentity -ne $spiceGuestToolsInstallation.resumeBootIdentity)
)
$audioDeviceRoleType = [Windows.Media.Devices.AudioDeviceRole, Windows.Media.Devices, ContentType = WindowsRuntime]
$audioDeviceRole = [System.Enum]::Parse($audioDeviceRoleType, "Default")
$audioEndpoint = [Windows.Media.Devices.MediaDevice, Windows.Media.Devices, ContentType = WindowsRuntime]::GetDefaultAudioRenderId($audioDeviceRole)
$serialPorts = @(Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue)
$runnerService = @(Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "actions.runner*" -and $_.Status -eq "Running" })
$tools = @("git", "node", "pnpm", "cargo", "rustc") | ForEach-Object {
  @{ name = $_; available = $null -ne (Get-Command $_ -ErrorAction SilentlyContinue) }
}
$cacheVolume = Get-Volume -DriveLetter D -ErrorAction SilentlyContinue
$cacheWritable = $null -ne $cacheVolume -and $cacheVolume.FileSystem -eq "NTFS"
if ($cacheWritable) {
  $probe = "D:\runtime-cache\.verification-write-test"
  Set-Content -Encoding ascii -Path $probe -Value "ok"
  Remove-Item -Force $probe
}
$checks = @{
  desktop = $interactiveDisplay.desktop.width -eq $ExpectedWidth -and $interactiveDisplay.desktop.height -eq $ExpectedHeight -and $interactiveDisplay.desktop.scalePercent -eq $ExpectedScalePercent
  SSH = (Get-Service sshd -ErrorAction SilentlyContinue).Status -eq "Running"
  runner = $runnerService.Count -eq 1
  toolchain = @($tools | Where-Object { -not $_.available }).Count -eq 0
  WebView2 = $null -ne $webView2
  SPICEGuestTools = $null -ne $spiceGuestTools -and $null -ne $qxlDisplayAdapter -and $spiceGuestToolsRebootSemantics
  Audio = -not [string]::IsNullOrWhiteSpace($audioEndpoint)
  Serial = $serialPorts.Count -ge 2
  cacheDisk = $cacheWritable
}
$report = @{
  schemaVersion = "win10-kvm-baseline-verification/v1"
  ok = @($checks.Values | Where-Object { -not $_ }).Count -eq 0
  checks = $checks
  desktop = @{ width = $interactiveDisplay.desktop.width; height = $interactiveDisplay.desktop.height; scalePercent = $interactiveDisplay.desktop.scalePercent; interactiveUser = $interactiveDisplay.interactiveUser; interactiveSessionId = $interactiveDisplay.interactiveSessionId; source = "interactive-autologon-report" }
  virtualDevices = @{ serialPortCount = $serialPorts.Count; defaultAudioRenderIdPresent = -not [string]::IsNullOrWhiteSpace($audioEndpoint); qxlDisplayAdapter = $qxlDisplayAdapter.Name; cacheDisk = @{ driveLetter = "D"; fileSystem = $cacheVolume.FileSystem; writable = $cacheWritable } }
  spiceGuestTools = @{ installed = $null -ne $spiceGuestTools; displayName = $spiceGuestTools.DisplayName; qxlDisplayAdapter = $qxlDisplayAdapter.Name; installation = $spiceGuestToolsInstallation; rebootSemanticsValid = $spiceGuestToolsRebootSemantics }
  toolchain = $tools
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $OutputPath
if (-not $report.ok) { exit 1 }
