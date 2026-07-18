[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [ValidateSet("GetInteractiveDisplayPreparationStatus", "PrepareInteractiveDisplay", "PrepareKvmGuest", "PrepareToolchain", "RearmInteractiveDisplay", "RegisterRunner")] [string] $Mode,
  [string] $RunnerArchivePath,
  [string] $RunnerUrl,
  [string] $RunnerRegistrationToken,
  [string] $RunnerName,
  [string] $SpiceGuestToolsInstallerPath,
  [string] $InteractiveUser,
  [int] $DesktopWidth = 1080,
  [int] $DesktopHeight = 1920,
  [int] $DesktopScalePercent = 100
)

$ErrorActionPreference = "Stop"
$cacheRoot = "D:\runtime-cache\v1"
$toolchainRoot = "C:\ProgramData\VEM\Toolchains"
$runnerRoot = "C:\actions-runner"
$runnerWorkRoot = "C:\actions-runner\_work"
$baselineRoot = "C:\ProgramData\WindowsRuntimeBaseline"
$interactiveDisplayTaskName = "VemPrepareInteractiveDisplay"
$interactiveDisplayReportPath = Join-Path $baselineRoot "interactive-display-report.json"
$interactiveDisplayStatePath = Join-Path $baselineRoot "interactive-display-preparation.json"
$interactiveDisplayLogPath = Join-Path $baselineRoot "interactive-display-preparation.log"
$nodeVersion = "24.16.0"
$pnpmVersion = "11.9.0"
$turboVersion = "2.10.0"
$rustToolchain = "1.96.0-x86_64-pc-windows-msvc"
$nodeNamespace = "node-$nodeVersion"
$pnpmNamespace = "pnpm-$pnpmVersion"
$turboNamespace = "turbo-$turboVersion"
$rustNamespace = "rust-1.96.0"

function Get-CachePaths {
  return @{
    PNPM_HOME = "$toolchainRoot\pnpm\$pnpmNamespace"
    COREPACK_HOME = "$toolchainRoot\corepack\$nodeNamespace"
    CARGO_HOME = "$toolchainRoot\cargo\$rustNamespace"
    RUSTUP_HOME = "$toolchainRoot\rustup\$rustNamespace"
    CARGO_TARGET_DIR = "$cacheRoot\target\$rustNamespace"
    SCCACHE_DIR = "$cacheRoot\sccache\$rustNamespace"
    TURBO_CACHE_DIR = "$cacheRoot\turbo\$turboNamespace"
    npm_config_cache = "$cacheRoot\npm\$nodeNamespace"
    PNPM_STORE_PATH = "$cacheRoot\pnpm-store\$pnpmNamespace"
    CARGO_REGISTRY_CACHE = "$cacheRoot\cargo-registry\$rustNamespace"
    CARGO_GIT_CACHE = "$cacheRoot\cargo-git\$rustNamespace"
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

function Set-CargoDownloadCacheLinks {
  $cachePaths = Get-CachePaths
  foreach ($entry in @(
    @{ Name = "registry"; Target = $cachePaths.CARGO_REGISTRY_CACHE },
    @{ Name = "git"; Target = $cachePaths.CARGO_GIT_CACHE }
  )) {
    $link = Join-Path $cachePaths.CARGO_HOME $entry.Name
    New-Item -ItemType Directory -Force -Path $entry.Target | Out-Null
    if (Test-Path -LiteralPath $link) {
      $existing = Get-Item -LiteralPath $link -Force
      if ($existing.LinkType -ne "Junction") {
        throw "Cargo $($entry.Name) cache must be a C: junction to the cache disk"
      }
      continue
    }
    New-Item -ItemType Junction -Path $link -Target $entry.Target | Out-Null
  }
}

function Set-CacheEnvironment {
  New-Item -ItemType Directory -Force -Path $cacheRoot, $toolchainRoot, $runnerRoot, $runnerWorkRoot | Out-Null
  Set-Content -Encoding ascii -Path "$cacheRoot\.write-test" -Value "runtime-cache"
  Remove-Item -Force "$cacheRoot\.write-test"
  foreach ($entry in (Get-CachePaths).GetEnumerator()) {
    New-Item -ItemType Directory -Force -Path $entry.Value | Out-Null
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Machine")
    Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value
  }
  Set-CargoDownloadCacheLinks
}

function Refresh-ProcessPath {
  $cachePaths = Get-CachePaths
  $env:Path = $cachePaths.CARGO_HOME + "\bin;" + $cachePaths.PNPM_HOME + ";C:\Program Files\nodejs;" + [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\ProgramData\chocolatey\bin"
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
  Invoke-Native -FilePath "corepack.cmd" -ArgumentList @("prepare", "pnpm@11.9.0", "--activate") -Description "pinned pnpm activation"
  Invoke-Native -FilePath "rustup.exe" -ArgumentList @("toolchain", "install", "1.96.0-x86_64-pc-windows-msvc", "--profile", "minimal") -Description "pinned Rust toolchain installation"
  Invoke-Native -FilePath "rustup.exe" -ArgumentList @("default", "1.96.0-x86_64-pc-windows-msvc") -Description "pinned Rust toolchain activation"
  $cachePaths = Get-CachePaths
  New-Item -ItemType Directory -Force -Path $cachePaths.PNPM_STORE_PATH | Out-Null
  Invoke-Native -FilePath "pnpm.cmd" -ArgumentList @("config", "set", "store-dir", $cachePaths.PNPM_STORE_PATH, "--global") -Description "pnpm cache configuration"
  Invoke-Native -FilePath "pnpm.cmd" -ArgumentList @("add", "--global", "turbo@2.10.0") -Description "pinned Turbo installation"
  foreach ($tool in @("git.exe", "node.exe", "corepack.cmd", "pnpm.cmd", "turbo.cmd", "cargo.exe", "rustc.exe", "rustup.exe")) {
    Invoke-Native -FilePath $tool -ArgumentList @("--version") -Description "$tool version probe"
  }
  if ((& node.exe --version).Trim().TrimStart("v") -ne $nodeVersion) { throw "Node.js version does not match $nodeVersion" }
  if ((& pnpm.cmd --version).Trim() -ne $pnpmVersion) { throw "pnpm version does not match $pnpmVersion" }
  if ((& turbo.cmd --version).Trim() -ne $turboVersion) { throw "Turbo version does not match $turboVersion" }
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
    "-InteractiveUser", ('"' + $InteractiveUser + '"'),
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

function Enable-InteractiveAutomaticLogon {
  $winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
  $configuredUser = [string](Get-ItemPropertyValue -Path $winlogon -Name "DefaultUserName" -ErrorAction SilentlyContinue)
  if ([string]::IsNullOrWhiteSpace($configuredUser)) { throw "Windows autologon does not have a configured user" }
  if ($configuredUser -notmatch ("(^|\\)" + [regex]::Escape($InteractiveUser) + "$")) {
    throw "Windows autologon user does not match interactive display user"
  }
  Set-ItemProperty -Path $winlogon -Name "AutoAdminLogon" -Value "1"
  Set-ItemProperty -Path $winlogon -Name "AutoLogonCount" -Type DWord -Value 1
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

function Write-AtomicJson {
  param([string] $Path, [object] $Value)
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  $temporaryPath = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    $Value | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8 -LiteralPath $temporaryPath
    Move-Item -Force -LiteralPath $temporaryPath -Destination $Path
  } finally {
    Remove-Item -Force -LiteralPath $temporaryPath -ErrorAction SilentlyContinue
  }
}

function Read-InteractiveDisplayPreparationState {
  if (-not (Test-Path -LiteralPath $interactiveDisplayStatePath -PathType Leaf)) { return $null }
  return Get-Content -Raw -LiteralPath $interactiveDisplayStatePath | ConvertFrom-Json
}

function Write-InteractiveDisplayPreparationState {
  param([string] $Phase, [string] $ErrorMessage, [int] $Attempt)
  $state = @{
    schemaVersion = "win10-kvm-interactive-display-preparation/v1"
    updatedAt = (Get-Date).ToUniversalTime().ToString("o")
    phase = $Phase
    interactiveUser = $InteractiveUser
    attempt = $Attempt
  }
  if (-not [string]::IsNullOrWhiteSpace($ErrorMessage)) { $state.error = $ErrorMessage }
  Write-AtomicJson -Path $interactiveDisplayStatePath -Value $state
}

function Get-QualifiedInteractiveUser {
  if ([string]::IsNullOrWhiteSpace($InteractiveUser)) { throw "InteractiveUser is required for interactive display preparation" }
  if ($InteractiveUser.Contains('\')) { return $InteractiveUser }
  return "$env:COMPUTERNAME\$InteractiveUser"
}

function Test-ExpectedInteractiveSession {
  $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  $sessionId = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
  return $sessionId -ge 1 -and $identity -ieq (Get-QualifiedInteractiveUser)
}

function Get-InteractiveDisplayTaskStatus {
  $task = Get-ScheduledTask -TaskName $interactiveDisplayTaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) { return $null }
  $info = Get-ScheduledTaskInfo -TaskName $interactiveDisplayTaskName -ErrorAction SilentlyContinue
  return @{
    name = $interactiveDisplayTaskName
    state = [string]$task.State
    lastRunTime = if ($null -eq $info) { $null } else { $info.LastRunTime.ToUniversalTime().ToString("o") }
    lastTaskResult = if ($null -eq $info) { $null } else { [int]$info.LastTaskResult }
  }
}

function Remove-InteractiveDisplayPreparationTask {
  Unregister-ScheduledTask -TaskName $interactiveDisplayTaskName -Confirm:$false -ErrorAction SilentlyContinue
}

function Test-SpiceGuestToolsResumeRemoved {
  $runOnce = "HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce"
  $resume = Get-ItemPropertyValue -Path $runOnce -Name "VemResumeSpiceGuestToolsPreparation" -ErrorAction SilentlyContinue
  return $null -eq $resume
}

function Test-RemainingAutomaticLogonDisabled {
  $winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
  return [string](Get-ItemPropertyValue -Path $winlogon -Name "AutoAdminLogon" -ErrorAction SilentlyContinue) -eq "0"
}

function Get-InteractiveDisplayCleanupStatus {
  param([object] $Task)
  if ($null -eq $Task) { $Task = Get-InteractiveDisplayTaskStatus }
  return @{
    taskRemoved = $null -eq $Task
    spiceGuestToolsResumeRemoved = Test-SpiceGuestToolsResumeRemoved
    automaticLogonDisabled = Test-RemainingAutomaticLogonDisabled
  }
}

function Register-InteractiveDisplayPreparationTask {
  $scriptPath = "C:\ProgramData\WindowsRuntimeBaseline\scripts\prepare-vm-runtime.ps1"
  if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) { throw "VM preparation script is unavailable for interactive display preparation" }
  New-Item -ItemType Directory -Force -Path $baselineRoot | Out-Null
  $arguments = @(
    "/d", "/c", "powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $scriptPath + '"'),
    "-Mode", "PrepareInteractiveDisplay", "-InteractiveUser", ('"' + $InteractiveUser + '"'),
    "-DesktopWidth", $DesktopWidth, "-DesktopHeight", $DesktopHeight, "-DesktopScalePercent", $DesktopScalePercent,
    ">>", ('"' + $interactiveDisplayLogPath + '"'), "2>&1"
  ) -join " "
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $arguments
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User (Get-QualifiedInteractiveUser)
  $principal = New-ScheduledTaskPrincipal -UserId (Get-QualifiedInteractiveUser) -LogonType Interactive -RunLevel Highest
  Register-ScheduledTask -TaskName $interactiveDisplayTaskName -Action $action -Trigger $trigger -Principal $principal -Description "Apply and verify the VEM interactive KVM display" -Force | Out-Null
}

function Test-InteractiveDisplayReport {
  param([object] $Report)
  if ($null -eq $Report -or $Report.schemaVersion -ne "win10-kvm-interactive-display/v1") { return $false }
  if ([string]$Report.interactiveUser -notmatch ("\\" + [regex]::Escape($InteractiveUser) + "$")) { return $false }
  $sessionId = 0
  if (-not [int]::TryParse([string]$Report.interactiveSessionId, [ref]$sessionId) -or $sessionId -lt 1) { return $false }
  return $Report.desktop.width -eq $DesktopWidth -and $Report.desktop.height -eq $DesktopHeight -and $Report.desktop.scalePercent -eq $DesktopScalePercent -and $Report.qxlDisplayAdapter -match "QXL"
}

function Complete-InteractiveDisplayPreparation {
  param([Parameter(Mandatory = $true)] [object] $Report)
  $state = Read-InteractiveDisplayPreparationState
  $attempt = if ($null -eq $state) { 1 } else { [int]$state.attempt }
  Remove-InteractiveDisplayPreparationTask
  Remove-SpiceGuestToolsResume
  Disable-RemainingAutomaticLogon
  $cleanup = Get-InteractiveDisplayCleanupStatus
  if (-not $cleanup.taskRemoved -or -not $cleanup.spiceGuestToolsResumeRemoved -or -not $cleanup.automaticLogonDisabled) {
    throw "interactive display completion cleanup is incomplete"
  }
  # The report is durable before the complete state commits it. A crash between
  # these writes is intentionally non-accepting and will be re-armed by host.
  Write-AtomicJson -Path $interactiveDisplayReportPath -Value $Report
  Write-InteractiveDisplayPreparationState -Phase "complete" -Attempt $attempt
}

function Complete-InteractiveDisplayPreparationFromValidReport {
  $existingReport = $null
  if (Test-Path -LiteralPath $interactiveDisplayReportPath -PathType Leaf) {
    try { $existingReport = Get-Content -Raw -LiteralPath $interactiveDisplayReportPath | ConvertFrom-Json } catch { $existingReport = $null }
  }
  if (-not (Test-InteractiveDisplayReport -Report $existingReport)) { return $false }
  Complete-InteractiveDisplayPreparation -Report $existingReport
  return $true
}

function Initialize-InteractiveDisplayPreparation {
  if (Complete-InteractiveDisplayPreparationFromValidReport) { return }
  $state = Read-InteractiveDisplayPreparationState
  $attempt = if ($null -eq $state) { 1 } else { [int]$state.attempt + 1 }
  Write-InteractiveDisplayPreparationState -Phase "waiting-for-logon" -Attempt $attempt
  Register-InteractiveDisplayPreparationTask
  if (Test-ExpectedInteractiveSession) {
    Start-ScheduledTask -TaskName $interactiveDisplayTaskName
  }
}

function Prepare-InteractiveDisplay {
  if (-not (Test-ExpectedInteractiveSession)) {
    throw "interactive display preparation must run in the configured user's interactive session"
  }
  $state = Read-InteractiveDisplayPreparationState
  $attempt = if ($null -eq $state) { 1 } else { [int]$state.attempt }
  Write-InteractiveDisplayPreparationState -Phase "running" -Attempt $attempt
  try {
    $qxlDisplayAdapter = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match "QXL" } |
      Select-Object -First 1
    if ($null -eq $qxlDisplayAdapter) { throw "QXL display adapter is unavailable after SPICE preparation" }
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
    $report = @{
      schemaVersion = "win10-kvm-interactive-display/v1"
      capturedAt = (Get-Date).ToUniversalTime().ToString("o")
      interactiveUser = $interactiveUser
      interactiveSessionId = $interactiveSessionId
      desktop = @{ width = $primary.Width; height = $primary.Height; scalePercent = $scalePercent }
      qxlDisplayAdapter = $qxlDisplayAdapter.Name
    }
    Complete-InteractiveDisplayPreparation -Report $report
  } catch {
    Write-InteractiveDisplayPreparationState -Phase "failed" -ErrorMessage $_.Exception.Message -Attempt $attempt
    throw
  }
}

function Get-InteractiveDisplayPreparationStatus {
  $report = $null
  $reportError = $null
  $spiceGuestToolsInstallation = $null
  if (Test-Path -LiteralPath $interactiveDisplayReportPath -PathType Leaf) {
    try { $report = Get-Content -Raw -LiteralPath $interactiveDisplayReportPath | ConvertFrom-Json } catch { $reportError = $_.Exception.Message }
  }
  $spiceGuestToolsInstallationPath = Join-Path $baselineRoot "spice-guest-tools-installation.json"
  if (Test-Path -LiteralPath $spiceGuestToolsInstallationPath -PathType Leaf) {
    try { $spiceGuestToolsInstallation = Get-Content -Raw -LiteralPath $spiceGuestToolsInstallationPath | ConvertFrom-Json } catch { $spiceGuestToolsInstallation = $null }
  }
  $taskLogTail = if (Test-Path -LiteralPath $interactiveDisplayLogPath -PathType Leaf) {
    ((Get-Content -LiteralPath $interactiveDisplayLogPath -Tail 30 -ErrorAction SilentlyContinue) -join "`n")
  } else { $null }
  $state = Read-InteractiveDisplayPreparationState
  $task = Get-InteractiveDisplayTaskStatus
  $cleanup = Get-InteractiveDisplayCleanupStatus -Task $task
  @{
    schemaVersion = "win10-kvm-interactive-display-status/v1"
    reportPresent = $null -ne $report
    reportValid = Test-InteractiveDisplayReport -Report $report
    reportError = $reportError
    state = $state
    task = $task
    cleanup = $cleanup
    completionValid = (Test-InteractiveDisplayReport -Report $report) -and $state.phase -eq "complete" -and $cleanup.taskRemoved -and $cleanup.spiceGuestToolsResumeRemoved -and $cleanup.automaticLogonDisabled
    taskLogTail = $taskLogTail
    currentBootIdentity = Get-BootIdentity
    spiceGuestToolsInstallation = $spiceGuestToolsInstallation
  } | ConvertTo-Json -Depth 6
}

function Rearm-InteractiveDisplay {
  Install-SpiceGuestTools
  if (Complete-InteractiveDisplayPreparationFromValidReport) {
    Get-InteractiveDisplayPreparationStatus
    return
  }
  Initialize-InteractiveDisplayPreparation
  if (Complete-InteractiveDisplayPreparationFromValidReport) {
    Get-InteractiveDisplayPreparationStatus
    return
  }
  Enable-InteractiveAutomaticLogon
  if (Complete-InteractiveDisplayPreparationFromValidReport) {
    Get-InteractiveDisplayPreparationStatus
    return
  }
  Restart-Computer -Force
  throw "interactive display preparation re-arm did not restart Windows"
}

function Prepare-KvmGuest {
  Install-SpiceGuestTools
  Initialize-InteractiveDisplayPreparation
}

if ($Mode -eq "GetInteractiveDisplayPreparationStatus") {
  Get-InteractiveDisplayPreparationStatus
  exit 0
}

if ($Mode -eq "PrepareInteractiveDisplay") {
  Prepare-InteractiveDisplay
  exit 0
}

if ($Mode -eq "PrepareKvmGuest") {
  Prepare-KvmGuest
  exit 0
}

if ($Mode -eq "RearmInteractiveDisplay") {
  Rearm-InteractiveDisplay
  exit 0
}

if ($Mode -eq "PrepareToolchain") {
  Initialize-CacheDisk
  Set-CacheEnvironment
  Install-Toolchain
  exit 0
}

Register-Runner
