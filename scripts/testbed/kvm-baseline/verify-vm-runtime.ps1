[CmdletBinding()]
param(
  [int] $ExpectedWidth = 1080,
  [int] $ExpectedHeight = 1920,
  [int] $ExpectedScalePercent = 100,
  [Parameter(Mandatory = $true)] [string] $ExpectedInteractiveUser,
  [Parameter(Mandatory = $true)] [string] $ExpectedRunnerUrl,
  [Parameter(Mandatory = $true)] [string] $ExpectedRunnerName,
  [Parameter(Mandatory = $true)] [string] $ExpectedRunnerServiceName,
  [Parameter(Mandatory = $true)] [ValidateSet("ich9")] [string] $ExpectedAudioModel,
  [Parameter(Mandatory = $true)] [ValidateSet("spice")] [string] $ExpectedAudioBackend,
  [Parameter(Mandatory = $true)] [string] $ExpectedAudioDeviceIdentity,
  [Parameter(Mandatory = $true)] [string[]] $ExpectedSerialRole,
  [Parameter(Mandatory = $true)] [string[]] $ExpectedSerialDeviceIdentity,
  [string] $OutputPath = "C:\ProgramData\WindowsRuntimeBaseline\verification.json"
)

$ErrorActionPreference = "Stop"
$baselineRoot = "C:\ProgramData\WindowsRuntimeBaseline"
$spiceGuestToolsInstallationPath = Join-Path $baselineRoot "spice-guest-tools-installation.json"
$interactiveDisplayReportPath = Join-Path $baselineRoot "interactive-display-report.json"
$runnerRegistrationPath = Join-Path $baselineRoot "runner-registration.json"
if (-not (Test-Path -LiteralPath $interactiveDisplayReportPath)) { throw "interactive autologon display report is unavailable" }
$interactiveDisplay = Get-Content -Raw -LiteralPath $interactiveDisplayReportPath | ConvertFrom-Json
if ($interactiveDisplay.schemaVersion -ne "win10-kvm-interactive-display/v1") { throw "interactive display report schema is invalid" }
if ($interactiveDisplay.interactiveUser -notmatch ("\\" + [regex]::Escape($ExpectedInteractiveUser) + "$")) { throw "interactive display report belongs to an unexpected user" }
$interactiveSessionId = 0
if (-not [int]::TryParse([string]$interactiveDisplay.interactiveSessionId, [ref]$interactiveSessionId) -or $interactiveSessionId -lt 1) { throw "interactive display report has an invalid session binding" }
if ($ExpectedSerialRole.Count -ne 2 -or $ExpectedSerialDeviceIdentity.Count -ne $ExpectedSerialRole.Count -or @($ExpectedSerialRole | Select-Object -Unique).Count -ne $ExpectedSerialRole.Count) {
  throw "the verifier requires exactly two unique serial roles with matching QEMU USB serial identities"
}
if ($ExpectedSerialRole[0] -cne "lower-controller" -or $ExpectedSerialRole[1] -cne "scanner") {
  throw "the verifier requires lower-controller and scanner QEMU USB serial roles in profile order"
}
if (-not (Test-Path -LiteralPath $runnerRegistrationPath -PathType Leaf)) { throw "runner registration evidence is unavailable" }
$runnerRegistration = Get-Content -Raw -LiteralPath $runnerRegistrationPath | ConvertFrom-Json
if ($runnerRegistration.schemaVersion -ne "win10-kvm-runner-registration/v1") { throw "runner registration evidence schema is invalid" }
$runnerConfigurationPath = "C:\actions-runner\.runner"
if (-not (Test-Path -LiteralPath $runnerConfigurationPath -PathType Leaf)) { throw "actions runner configuration is unavailable" }
$runnerConfiguration = Get-Content -Raw -LiteralPath $runnerConfigurationPath | ConvertFrom-Json
$runnerConfigurationUrl = [string]$runnerConfiguration.gitHubUrl
if ([string]::IsNullOrWhiteSpace($runnerConfigurationUrl)) { $runnerConfigurationUrl = [string]$runnerConfiguration.serverUrl }
$runnerService = Get-Service -Name $ExpectedRunnerServiceName -ErrorAction SilentlyContinue
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
$soundDevices = @(Get-CimInstance Win32_SoundDevice -ErrorAction SilentlyContinue)
$audioDevice = @($soundDevices | Where-Object {
  ($_.Name -match [regex]::Escape($ExpectedAudioDeviceIdentity)) -or
  ($_.Caption -match [regex]::Escape($ExpectedAudioDeviceIdentity)) -or
  ($_.PNPDeviceID -match [regex]::Escape($ExpectedAudioDeviceIdentity))
} | Select-Object -First 1)
$serialPorts = @(Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue | Sort-Object DeviceID)
$remainingSerialPorts = @($serialPorts)
$serialRoleDevices = @()
for ($index = 0; $index -lt $ExpectedSerialRole.Count; $index += 1) {
  $identity = $ExpectedSerialDeviceIdentity[$index]
  $match = @($remainingSerialPorts | Where-Object { $_.PNPDeviceID -match [regex]::Escape($identity) } | Select-Object -First 1)
  if ($match.Count -ne 1) { continue }
  $device = $match[0]
  $serialRoleDevices += @{ role = $ExpectedSerialRole[$index]; expectedIdentity = $identity; deviceId = $device.DeviceID; name = $device.Name; pnpDeviceId = $device.PNPDeviceID }
  $remainingSerialPorts = @($remainingSerialPorts | Where-Object { $_.DeviceID -ne $device.DeviceID })
}
$tools = @("git", "node", "pnpm", "cargo", "rustc") | ForEach-Object {
  @{ name = $_; available = $null -ne (Get-Command $_ -ErrorAction SilentlyContinue) }
}
$cacheVolume = Get-Volume -DriveLetter D -ErrorAction SilentlyContinue
$cacheWritable = $null -ne $cacheVolume -and $cacheVolume.FileSystem -eq "NTFS"
if ($cacheWritable) {
  $probe = "D:\runtime-cache\v1\.verification-write-test"
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $probe) | Out-Null
  Set-Content -Encoding ascii -Path $probe -Value "ok"
  Remove-Item -Force $probe
}
$checks = @{
  desktop = $interactiveDisplay.desktop.width -eq $ExpectedWidth -and $interactiveDisplay.desktop.height -eq $ExpectedHeight -and $interactiveDisplay.desktop.scalePercent -eq $ExpectedScalePercent
  SSH = (Get-Service sshd -ErrorAction SilentlyContinue).Status -eq "Running"
  runner = $null -ne $runnerService -and $runnerService.Status -eq "Running" -and $runnerRegistration.runnerUrl -ceq $ExpectedRunnerUrl -and $runnerRegistration.runnerName -ceq $ExpectedRunnerName -and $runnerRegistration.serviceName -ceq $ExpectedRunnerServiceName -and $runnerConfiguration.agentName -ceq $ExpectedRunnerName -and $runnerConfigurationUrl -ceq $ExpectedRunnerUrl -and $runnerRegistration.runnerWorkRoot -ceq "C:\actions-runner\_work"
  toolchain = @($tools | Where-Object { -not $_.available }).Count -eq 0
  WebView2 = $null -ne $webView2
  SPICEGuestTools = $null -ne $spiceGuestTools -and $null -ne $qxlDisplayAdapter -and $spiceGuestToolsRebootSemantics
  Audio = $ExpectedAudioModel -ceq "ich9" -and $ExpectedAudioBackend -ceq "spice" -and -not [string]::IsNullOrWhiteSpace($audioEndpoint) -and $audioDevice.Count -eq 1
  Serial = $serialPorts.Count -eq $ExpectedSerialRole.Count -and $serialRoleDevices.Count -eq $ExpectedSerialRole.Count -and $remainingSerialPorts.Count -eq 0
  cacheDisk = $cacheWritable
}
$report = @{
  schemaVersion = "win10-kvm-baseline-verification/v1"
  ok = @($checks.Values | Where-Object { -not $_ }).Count -eq 0
  checks = $checks
  desktop = @{ width = $interactiveDisplay.desktop.width; height = $interactiveDisplay.desktop.height; scalePercent = $interactiveDisplay.desktop.scalePercent; interactiveUser = $interactiveDisplay.interactiveUser; interactiveSessionId = $interactiveDisplay.interactiveSessionId; source = "interactive-autologon-report" }
  runner = @{ expected = @{ url = $ExpectedRunnerUrl; name = $ExpectedRunnerName; serviceName = $ExpectedRunnerServiceName }; registration = $runnerRegistration; configuration = @{ agentName = $runnerConfiguration.agentName; url = $runnerConfigurationUrl }; service = @{ name = $runnerService.Name; status = [string]$runnerService.Status } }
  virtualDevices = @{ serialRoles = $serialRoleDevices; expectedAudio = @{ model = $ExpectedAudioModel; backend = $ExpectedAudioBackend; deviceIdentity = $ExpectedAudioDeviceIdentity }; defaultAudioRenderIdPresent = -not [string]::IsNullOrWhiteSpace($audioEndpoint); audioDevice = @{ name = $audioDevice[0].Name; pnpDeviceId = $audioDevice[0].PNPDeviceID }; qxlDisplayAdapter = $qxlDisplayAdapter.Name; cacheDisk = @{ driveLetter = "D"; fileSystem = $cacheVolume.FileSystem; writable = $cacheWritable } }
  spiceGuestTools = @{ installed = $null -ne $spiceGuestTools; displayName = $spiceGuestTools.DisplayName; qxlDisplayAdapter = $qxlDisplayAdapter.Name; installation = $spiceGuestToolsInstallation; rebootSemanticsValid = $spiceGuestToolsRebootSemantics }
  toolchain = $tools
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $OutputPath
if (-not $report.ok) { exit 1 }
