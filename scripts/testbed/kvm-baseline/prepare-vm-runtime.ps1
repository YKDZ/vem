[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [ValidateSet("PrepareToolchain", "PrepareKvmGuest", "RegisterRunner")] [string] $Mode,
  [string] $RunnerArchivePath,
  [string] $RunnerUrl,
  [string] $RunnerRegistrationToken,
  [string] $RunnerName,
  [string] $SpiceGuestToolsInstallerPath,
  [int] $DesktopWidth = 1080,
  [int] $DesktopHeight = 1920,
  [int] $DesktopScalePercent = 100
)

$ErrorActionPreference = "Stop"
$cacheRoot = "D:\runtime-cache\v1"
$toolchainRoot = "C:\ProgramData\VEM\Toolchains"
$runnerRoot = "C:\actions-runner"
$runnerWorkRoot = "C:\actions-runner\_work"
$nodeVersion = "24.16.0"
$rustToolchain = "1.96.0-x86_64-pc-windows-msvc"
$rustCacheNamespace = "rust-1.96.0"

function Get-CachePaths {
  return @{
    PNPM_HOME = "$toolchainRoot\pnpm-home\node-$nodeVersion"
    CARGO_HOME = "$cacheRoot\cargo\$rustCacheNamespace"
    RUSTUP_HOME = "C:\ProgramData\VEM\Toolchains\rustup\rust-1.96.0"
    CARGO_TARGET_DIR = "$cacheRoot\target\$rustCacheNamespace"
    SCCACHE_DIR = "$cacheRoot\sccache\$rustCacheNamespace"
    TURBO_CACHE_DIR = "$cacheRoot\turbo\turbo-v2"
    npm_config_cache = "$cacheRoot\npm\node-$nodeVersion"
    PNPM_STORE_PATH = "$cacheRoot\pnpm-store\node-$nodeVersion"
  }
}

function Invoke-Native {
  param([string] $FilePath, [string[]] $ArgumentList, [string] $Description)
  & $FilePath @ArgumentList
  if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE" }
}

function Get-FreeDriveLetter {
  foreach ($letter in [char[]]("E".."Z")) {
    if ($null -eq (Get-Volume -DriveLetter $letter -ErrorAction SilentlyContinue)) { return [string]$letter }
  }
  throw "no free drive letter is available to move an optical volume away from D:"
}

function Move-OpticalVolumesOffD {
  $opticalVolumes = @(Get-CimInstance Win32_Volume -Filter "DriveType = 5" -ErrorAction Stop | Where-Object { $_.DriveLetter -eq "D:" })
  foreach ($volume in $opticalVolumes) {
    $newLetter = Get-FreeDriveLetter
    $volume.DriveLetter = "${newLetter}:"
    Set-CimInstance -InputObject $volume | Out-Null
  }
  if (@(Get-CimInstance Win32_Volume -Filter "DriveType = 5" -ErrorAction Stop | Where-Object { $_.DriveLetter -eq "D:" }).Count -ne 0) {
    throw "an optical volume still owns D: after relocation"
  }
}

function Get-CacheDisk {
  $systemDiskNumber = (Get-Partition -DriveLetter C -ErrorAction Stop | Select-Object -First 1).DiskNumber
  $candidateDisks = @(Get-Disk | Where-Object {
    $_.Number -ne $systemDiskNumber -and $_.BusType -ne "CDROM" -and $_.Size -gt 0
  })
  $labeledDisks = @(
    $candidateDisks | Where-Object {
      @(
        Get-Partition -DiskNumber $_.Number -ErrorAction SilentlyContinue |
          Get-Volume -ErrorAction SilentlyContinue |
          Where-Object { $_.FileSystemLabel -eq "VEMCACHE" }
      ).Count -gt 0
    }
  )
  if ($labeledDisks.Count -gt 1) { throw "more than one disk is labelled VEMCACHE" }
  if ($labeledDisks.Count -eq 1) { return $labeledDisks[0] }
  if ($candidateDisks.Count -ne 1) { throw "expected exactly one non-system cache disk when VEMCACHE is not yet labelled" }
  return $candidateDisks[0]
}

function Initialize-CacheDisk {
  Move-OpticalVolumesOffD
  $disk = Get-CacheDisk
  Set-Disk -Number $disk.Number -IsOffline $false -IsReadOnly $false -ErrorAction Stop
  $disk = Get-Disk -Number $disk.Number -ErrorAction Stop
  if ($disk.PartitionStyle -eq "RAW") {
    Initialize-Disk -Number $disk.Number -PartitionStyle GPT -ErrorAction Stop | Out-Null
    $partition = New-Partition -DiskNumber $disk.Number -UseMaximumSize -DriveLetter D -ErrorAction Stop
    $partition | Format-Volume -FileSystem NTFS -NewFileSystemLabel "VEMCACHE" -Confirm:$false -ErrorAction Stop | Out-Null
    return
  }
  if ($disk.PartitionStyle -ne "GPT") { throw "cache disk $($disk.Number) must be GPT" }
  $partitions = @(Get-Partition -DiskNumber $disk.Number -ErrorAction Stop | Where-Object { $_.Type -ne "Reserved" })
  if ($partitions.Count -ne 1) { throw "cache disk $($disk.Number) must have exactly one usable partition" }
  $partition = $partitions[0]
  $volume = $partition | Get-Volume -ErrorAction Stop
  if ($volume.FileSystem -ne "NTFS" -or $volume.FileSystemLabel -ne "VEMCACHE") {
    throw "existing cache disk must be NTFS and labelled VEMCACHE"
  }
  if ($partition.DriveLetter -ne "D") {
    $occupied = Get-Volume -DriveLetter D -ErrorAction SilentlyContinue
    if ($null -ne $occupied) { throw "D: is occupied by a non-cache volume" }
    Set-Partition -DiskNumber $disk.Number -PartitionNumber $partition.PartitionNumber -NewDriveLetter D -ErrorAction Stop
  }
}

function Set-CacheEnvironment {
  New-Item -ItemType Directory -Force -Path $cacheRoot, $runnerRoot, $runnerWorkRoot | Out-Null
  Set-Content -Encoding ascii -Path "$cacheRoot\.write-test" -Value "runtime-cache"
  Remove-Item -Force "$cacheRoot\.write-test"
  foreach ($entry in (Get-CachePaths).GetEnumerator() | Where-Object { $_.Key -ne "PNPM_STORE_PATH" }) {
    New-Item -ItemType Directory -Force -Path $entry.Value | Out-Null
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Machine")
    Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value
  }
}

function Refresh-ProcessPath {
  $cachePaths = Get-CachePaths
  $env:Path = $cachePaths.CARGO_HOME + "\bin;" + $cachePaths.PNPM_HOME + ";" + [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\ProgramData\chocolatey\bin"
}

function Test-WindowsMediaStack {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VemMediaSmoke {
  [DllImport("mfplat.dll")] public static extern int MFStartup(int version, int flags);
  [DllImport("mfplat.dll")] public static extern int MFShutdown();
}
'@
  if ([VemMediaSmoke]::MFStartup(0x00020070, 0) -ne 0) { throw "Media Foundation MFStartup smoke failed" }
  if ([VemMediaSmoke]::MFShutdown() -ne 0) { throw "Media Foundation MFShutdown smoke failed" }
  $filterGraph = New-Object -ComObject "FilterGraph"
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($filterGraph)
}

function Install-Toolchain {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Set-ExecutionPolicy Bypass -Scope Process -Force
  Invoke-Expression ((New-Object Net.WebClient).DownloadString("https://community.chocolatey.org/install.ps1"))
  Refresh-ProcessPath
  Invoke-Native -FilePath "choco.exe" -ArgumentList @("install", "-y", "git", "rustup.install", "visualstudio2022buildtools", "visualstudio2022-workload-vctools") -Description "Windows build toolchain installation"
  Invoke-Native -FilePath "choco.exe" -ArgumentList @("install", "-y", "nodejs-lts", "--version=24.16.0") -Description "pinned Node.js installation"
  Refresh-ProcessPath
  Invoke-Native -FilePath "corepack.cmd" -ArgumentList @("enable") -Description "Corepack enable"
  Invoke-Native -FilePath "rustup.exe" -ArgumentList @("toolchain", "install", "1.96.0-x86_64-pc-windows-msvc", "--profile", "minimal") -Description "pinned Rust toolchain installation"
  Invoke-Native -FilePath "rustup.exe" -ArgumentList @("default", "1.96.0-x86_64-pc-windows-msvc") -Description "pinned Rust toolchain activation"
  $cachePaths = Get-CachePaths
  New-Item -ItemType Directory -Force -Path $cachePaths.PNPM_STORE_PATH | Out-Null
  Invoke-Native -FilePath "pnpm.cmd" -ArgumentList @("config", "set", "store-dir", $cachePaths.PNPM_STORE_PATH, "--global") -Description "pnpm cache configuration"
  foreach ($tool in @("git.exe", "node.exe", "pnpm.cmd", "cargo.exe", "rustc.exe")) {
    Invoke-Native -FilePath $tool -ArgumentList @("--version") -Description "$tool version probe"
  }
  if ((& node.exe --version).Trim().TrimStart("v") -ne $nodeVersion) { throw "Node.js version does not match $nodeVersion" }
  if ((& rustc.exe --version) -notmatch "^rustc 1\\.96\\.0 ") { throw "Rust version does not match $rustToolchain" }
  $vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path -LiteralPath $vswhere)) { throw "vswhere.exe is unavailable" }
  $vsInstall = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Workload.VCTools -property installationPath).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($vsInstall)) { throw "Visual C++ workload is unavailable" }
  $vcvars = Join-Path $vsInstall "VC\Auxiliary\Build\vcvars64.bat"
  if (-not (Test-Path -LiteralPath $vcvars)) { throw "Visual C++ build environment is unavailable" }
  $probeSource = Join-Path $env:TEMP "vem-cl-smoke.cpp"
  $probeObject = Join-Path $env:TEMP "vem-cl-smoke.obj"
  Set-Content -Encoding ascii -Path $probeSource -Value "int main() { return 0; }"
  Invoke-Native -FilePath "cmd.exe" -ArgumentList @("/d", "/c", "call `"$vcvars`" >nul && cl.exe /nologo /c /Fo`"$probeObject`" `"$probeSource`"") -Description "Visual C++ cl.exe smoke build"
  Remove-Item -Force $probeSource, $probeObject -ErrorAction SilentlyContinue
  Test-WindowsMediaStack
}

function Register-Runner {
  foreach ($required in @("RunnerArchivePath", "RunnerUrl", "RunnerRegistrationToken", "RunnerName")) {
    if ([string]::IsNullOrWhiteSpace((Get-Variable -Name $required -ValueOnly))) { throw "$required is required for runner registration" }
  }
  if (-not (Test-Path -LiteralPath $RunnerArchivePath -PathType Leaf)) { throw "RunnerArchivePath is unavailable" }
  $archive = (Resolve-Path -LiteralPath $RunnerArchivePath -ErrorAction Stop).Path
  Expand-Archive -Force -Path $archive -DestinationPath $runnerRoot
  Push-Location $runnerRoot
  try {
    Invoke-Native -FilePath ".\config.cmd" -ArgumentList @("--unattended", "--url", $RunnerUrl, "--token", $RunnerRegistrationToken, "--name", $RunnerName, "--work", $runnerWorkRoot, "--runasservice") -Description "actions runner registration"
    $services = @(Get-Service -ErrorAction Stop | Where-Object { $_.Name -like "actions.runner*" })
    if ($services.Count -ne 1) { throw "expected exactly one actions runner service after registration" }
    $runnerConfiguration = Get-Content -Raw -LiteralPath (Join-Path $runnerRoot ".runner") | ConvertFrom-Json
    if ($runnerConfiguration.agentName -ne $RunnerName) { throw "actions runner configuration name does not match registration input" }
    $configuredUrl = [string]$runnerConfiguration.gitHubUrl
    if ([string]::IsNullOrWhiteSpace($configuredUrl)) { $configuredUrl = [string]$runnerConfiguration.serverUrl }
    if ($configuredUrl -ne $RunnerUrl) { throw "actions runner configuration URL does not match registration input" }
    @{
      schemaVersion = "win10-kvm-runner-registration/v1"
      runnerUrl = $RunnerUrl
      runnerName = $RunnerName
      serviceName = $services[0].Name
      runnerRoot = $runnerRoot
      runnerWorkRoot = $runnerWorkRoot
      cacheRoot = $cacheRoot
    } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 "C:\ProgramData\WindowsRuntimeBaseline\runner-registration.json"
  } finally {
    Pop-Location
  }
}

function Get-BootIdentity {
  return (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString("o")
}

function Write-SpiceGuestToolsInstallationState {
  param([object] $State)
  $State | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 "C:\ProgramData\WindowsRuntimeBaseline\spice-guest-tools-installation.json"
}

function Register-SpiceGuestToolsResume {
  $scriptPath = "C:\ProgramData\WindowsRuntimeBaseline\scripts\prepare-vm-runtime.ps1"
  if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "VM preparation script is unavailable for SPICE reboot resume" }
  $arguments = @(
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $scriptPath + '"'),
    "-Mode", "PrepareKvmGuest",
    "-SpiceGuestToolsInstallerPath", ('"' + $SpiceGuestToolsInstallerPath + '"'),
    "-DesktopWidth", $DesktopWidth,
    "-DesktopHeight", $DesktopHeight,
    "-DesktopScalePercent", $DesktopScalePercent
  ) -join " "
  New-Item -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce" -Force | Out-Null
  Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce" -Name "VemResumeSpiceGuestToolsPreparation" -Value ("powershell.exe " + $arguments)
}

function Remove-SpiceGuestToolsResume {
  Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce" -Name "VemResumeSpiceGuestToolsPreparation" -ErrorAction SilentlyContinue
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
  if ([string]::IsNullOrWhiteSpace($SpiceGuestToolsInstallerPath)) { throw "SpiceGuestToolsInstallerPath is required for KVM guest preparation" }
  $statePath = "C:\ProgramData\WindowsRuntimeBaseline\spice-guest-tools-installation.json"
  $currentBootIdentity = Get-BootIdentity
  if (Test-Path -LiteralPath $statePath -PathType Leaf) {
    $state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
    if ($state.schemaVersion -ne "win10-kvm-spice-guest-tools-installation/v1") { throw "SPICE guest tools installation state schema is invalid" }
    if ($state.exitCode -eq 0 -and -not $state.rebootRequired -and -not $state.rebootApplied) { return }
    if ($state.phase -eq "installing" -and $state.installBootIdentity -ne $currentBootIdentity) {
      $state.phase = "complete"
      $state.exitCode = 3010
      $state.rebootRequired = $true
      $state.rebootApplied = $true
      $state | Add-Member -NotePropertyName "resumeBootIdentity" -NotePropertyValue $currentBootIdentity -Force
      Write-SpiceGuestToolsInstallationState -State $state
      Remove-SpiceGuestToolsResume
      return
    }
    if ($state.exitCode -eq 3010 -and $state.rebootRequired -and $state.installBootIdentity -ne $currentBootIdentity) {
      $state.rebootApplied = $true
      $state | Add-Member -NotePropertyName "resumeBootIdentity" -NotePropertyValue $currentBootIdentity -Force
      Write-SpiceGuestToolsInstallationState -State $state
      Remove-SpiceGuestToolsResume
      return
    }
    throw "SPICE guest tools installation state has invalid reboot semantics"
  }

  # The installer may reboot Windows before its scheduled task reports an exit
  # code, so persist the resume contract before starting it.
  Write-SpiceGuestToolsInstallationState -State @{ schemaVersion = "win10-kvm-spice-guest-tools-installation/v1"; phase = "installing"; installerFile = (Split-Path -Leaf $SpiceGuestToolsInstallerPath); exitCode = $null; rebootRequired = $false; rebootApplied = $false; installBootIdentity = $currentBootIdentity }
  Register-SpiceGuestToolsResume
  $exitCode = Invoke-SpiceGuestToolsInstallerAsSystem -InstallerPath $SpiceGuestToolsInstallerPath
  if ($exitCode -eq 0) {
    Write-SpiceGuestToolsInstallationState -State @{ schemaVersion = "win10-kvm-spice-guest-tools-installation/v1"; phase = "complete"; installerFile = (Split-Path -Leaf $SpiceGuestToolsInstallerPath); exitCode = 0; rebootRequired = $false; rebootApplied = $false; installBootIdentity = $currentBootIdentity }
    Remove-SpiceGuestToolsResume
    return
  }
  if ($exitCode -eq 3010 -or $exitCode -eq 1641) {
    Write-SpiceGuestToolsInstallationState -State @{ schemaVersion = "win10-kvm-spice-guest-tools-installation/v1"; phase = "complete"; installerFile = (Split-Path -Leaf $SpiceGuestToolsInstallerPath); exitCode = 3010; rebootRequired = $true; rebootApplied = $false; installBootIdentity = $currentBootIdentity }
    Restart-Computer -Force
    throw "SPICE guest tools requested a reboot but Windows did not restart"
  }
  Remove-SpiceGuestToolsResume
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

function Prepare-KvmGuest {
  Install-SpiceGuestTools
  $qxlDisplayAdapter = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match "QXL" } |
    Select-Object -First 1
  if ($null -eq $qxlDisplayAdapter) { throw "QXL display adapter is unavailable after SPICE preparation" }
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
  @{
    schemaVersion = "win10-kvm-interactive-display/v1"
    capturedAt = (Get-Date).ToUniversalTime().ToString("o")
    interactiveUser = $interactiveUser
    interactiveSessionId = $interactiveSessionId
    desktop = @{ width = $primary.Width; height = $primary.Height; scalePercent = $scalePercent }
    qxlDisplayAdapter = $qxlDisplayAdapter.Name
  } | ConvertTo-Json -Depth 4 | Set-Content -Encoding utf8 "C:\ProgramData\WindowsRuntimeBaseline\interactive-display-report.json"
}

if ($Mode -eq "PrepareKvmGuest") {
  Prepare-KvmGuest
  exit 0
}

if ($Mode -eq "PrepareToolchain") {
  Initialize-CacheDisk
  Set-CacheEnvironment
  Install-Toolchain
  exit 0
}

Register-Runner
