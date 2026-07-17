[CmdletBinding()]
param(
  [int] $ExpectedWidth = 1080,
  [int] $ExpectedHeight = 1920,
  [int] $ExpectedScalePercent = 100,
  [string] $OutputPath = "C:\ProgramData\WindowsRuntimeBaseline\verification.json"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$primary = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$dpi = Get-ItemPropertyValue -Path "HKCU:\Control Panel\Desktop" -Name LogPixels -ErrorAction SilentlyContinue
if ($null -eq $dpi) { $dpi = 96 }
$scalePercent = [int]($dpi * 100 / 96)
$webView2 = Get-ChildItem "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients", "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients" -ErrorAction SilentlyContinue |
  Get-ItemProperty -ErrorAction SilentlyContinue |
  Where-Object { $_.pv -and $_.name -match "WebView" } |
  Select-Object -First 1
$audioEndpoint = [Windows.Media.Devices.MediaDevice, Windows.Media.Devices, ContentType = WindowsRuntime]::GetDefaultAudioRenderId("AudioRender")
$serialPorts = @(Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue)
$runnerService = @(Get-Service -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "actions.runner*" -and $_.Status -eq "Running" })
$tools = @("git", "node", "pnpm", "cargo", "rustc") | ForEach-Object {
  @{ name = $_; available = $null -ne (Get-Command $_ -ErrorAction SilentlyContinue) }
}
$checks = @{
  desktop = $primary.Width -eq $ExpectedWidth -and $primary.Height -eq $ExpectedHeight -and $scalePercent -eq $ExpectedScalePercent
  SSH = (Get-Service sshd -ErrorAction SilentlyContinue).Status -eq "Running"
  runner = $runnerService.Count -eq 1
  toolchain = @($tools | Where-Object { -not $_.available }).Count -eq 0
  WebView2 = $null -ne $webView2
  Audio = -not [string]::IsNullOrWhiteSpace($audioEndpoint)
  Serial = $serialPorts.Count -ge 2
}
$report = @{
  schemaVersion = "win10-kvm-baseline-verification/v1"
  ok = @($checks.Values | Where-Object { -not $_ }).Count -eq 0
  checks = $checks
  desktop = @{ width = $primary.Width; height = $primary.Height; scalePercent = $scalePercent }
  virtualDevices = @{ serialPortCount = $serialPorts.Count; defaultAudioRenderIdPresent = -not [string]::IsNullOrWhiteSpace($audioEndpoint) }
  toolchain = $tools
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputPath) | Out-Null
$report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 $OutputPath
if (-not $report.ok) { exit 1 }
