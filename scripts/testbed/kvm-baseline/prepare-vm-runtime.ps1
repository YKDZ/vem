[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [ValidateSet("GetInteractiveDisplayPreparationStatus", "PrepareInteractiveDisplay", "PrepareKvmGuest", "PrepareToolchain", "RearmInteractiveDisplay", "RegisterRunner")] [string] $Mode,
  [string] $RunnerArchivePath,
  [string] $RunnerUrl,
  [string] $RunnerRegistrationToken,
  [string] $RunnerName,
  [string] $VirtioGpuDriverPath,
  [string] $VirtioGpuDriverIdentityPath,
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
$virtioGpuDriverBindingPath = Join-Path $baselineRoot "virtio-gpu-driver-binding.json"
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

function Get-Sha256 {
  param([string] $Path)
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Get-VirtioGpuPackageIdentity {
  param([string] $DriverRoot, [string] $IdentityPath)
  if (-not (Test-Path -LiteralPath $IdentityPath -PathType Leaf)) { throw "VirtIO GPU driver identity is unavailable" }
  $identity = Get-Content -Raw -LiteralPath $IdentityPath | ConvertFrom-Json
  if ($identity.schemaVersion -ne "win10-kvm-virtio-gpu-driver-package/v1" -or $identity.sourceDirectory -cne "viogpudo/w10/amd64" -or [string]$identity.packageSha256 -notmatch "^[0-9a-f]{64}$") {
    throw "VirtIO GPU driver package identity is invalid"
  }
  $root = (Resolve-Path -LiteralPath $DriverRoot -ErrorAction Stop).Path.TrimEnd("\")
  $expectedFiles = @($identity.files | Sort-Object path)
  if ($expectedFiles.Count -lt 3 -or @($expectedFiles.path | Select-Object -Unique).Count -ne $expectedFiles.Count) {
    throw "VirtIO GPU driver package file identity is invalid"
  }
  $actualFiles = @(Get-ChildItem -LiteralPath $root -Recurse -File -ErrorAction Stop | ForEach-Object {
    $_.FullName.Substring($root.Length + 1).Replace("\", "/")
  } | Sort-Object)
  if ($actualFiles.Count -ne $expectedFiles.Count -or (Compare-Object -CaseSensitive $actualFiles @($expectedFiles.path)).Count -ne 0) {
    throw "VirtIO GPU driver payload files do not match package identity"
  }
  $identityText = New-Object Text.StringBuilder
  foreach ($file in $expectedFiles) {
    if ([string]$file.path -notmatch "^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$" -or [string]$file.sha256 -notmatch "^[0-9a-f]{64}$") {
      throw "VirtIO GPU driver package file identity is invalid"
    }
    $path = Join-Path $root ([string]$file.path).Replace("/", "\")
    if ((Get-Sha256 -Path $path) -cne [string]$file.sha256) { throw "VirtIO GPU driver payload hash does not match package identity" }
    [void]$identityText.Append([string]$file.path).Append([char]0).Append([string]$file.sha256).Append("`n")
  }
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $packageHash = -join ($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($identityText.ToString())) | ForEach-Object { $_.ToString("x2") })
  } finally {
    $sha256.Dispose()
  }
  if ($packageHash -cne [string]$identity.packageSha256) { throw "VirtIO GPU driver aggregate identity does not match package files" }
  return $identity
}

function Install-VirtioGpuDisplayDriver {
  param([string] $DriverRoot, [string] $IdentityPath)
  if ([string]::IsNullOrWhiteSpace($DriverRoot) -or -not (Test-Path -LiteralPath $DriverRoot -PathType Container)) {
    throw "VirtIO GPU driver payload is unavailable"
  }
  $identity = Get-VirtioGpuPackageIdentity -DriverRoot $DriverRoot -IdentityPath $IdentityPath
  $driverInfFiles = @(Get-ChildItem -LiteralPath $DriverRoot -File -Filter "*.inf" -ErrorAction Stop)
  if ($driverInfFiles.Count -ne 1) { throw "VirtIO GPU driver payload must contain exactly one INF" }
  $driverInf = $driverInfFiles[0]
  $driverCatalogFiles = @(Get-ChildItem -LiteralPath $DriverRoot -File -Filter "*.cat" -ErrorAction Stop)
  if ($driverCatalogFiles.Count -lt 1) { throw "VirtIO GPU driver payload must contain a signed catalog" }
  foreach ($catalog in $driverCatalogFiles) {
    if ((Get-AuthenticodeSignature -LiteralPath $catalog.FullName).Status -ne "Valid") {
      throw "VirtIO GPU driver catalog signature is invalid"
    }
  }
  Invoke-Native -FilePath "pnputil.exe" -ArgumentList @("/add-driver", $driverInf.FullName, "/install") -Description "signed VirtIO GPU driver installation"

  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  do {
    $adapter = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
      Where-Object {
        $_.Status -eq "OK" -and
        $_.ConfigManagerErrorCode -eq 0 -and
        $_.PNPDeviceID -match "^PCI\\VEN_1AF4&"
      } |
      Select-Object -First 1
    if ($null -ne $adapter) {
      $signedDriver = Get-CimInstance Win32_PnPSignedDriver -ErrorAction SilentlyContinue |
        Where-Object { $_.DeviceID -eq $adapter.PNPDeviceID -and $_.IsSigned -eq $true } |
        Select-Object -First 1
      if ($null -ne $signedDriver -and -not [string]::IsNullOrWhiteSpace([string]$signedDriver.InfName)) {
        $driverPackage = Get-WindowsDriver -Online -Driver $signedDriver.InfName -ErrorAction SilentlyContinue
        if ($null -ne $driverPackage -and (Split-Path -Leaf ([string]$driverPackage.OriginalFileName)) -ieq $driverInf.Name) {
          $driverStoreRoot = Split-Path -Parent ([string]$driverPackage.OriginalFileName)
          $storeMatches = $true
          foreach ($file in @($identity.files)) {
            $storePath = Join-Path $driverStoreRoot ([string]$file.path).Replace("/", "\")
            if (-not (Test-Path -LiteralPath $storePath -PathType Leaf) -or (Get-Sha256 -Path $storePath) -cne [string]$file.sha256) {
              $storeMatches = $false
              break
            }
          }
          if ($storeMatches) {
            Write-AtomicJson -Path $virtioGpuDriverBindingPath -Value @{
              schemaVersion = "win10-kvm-virtio-gpu-driver-binding/v1"
              packageSha256 = [string]$identity.packageSha256
              files = @($identity.files)
              pnpDeviceId = [string]$adapter.PNPDeviceID
              infName = [string]$signedDriver.InfName
              provider = [string]$signedDriver.DriverProviderName
              version = [string]$signedDriver.DriverVersion
              signer = [string]$signedDriver.Signer
            }
            return
          }
        }
      }
    }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "signed VirtIO GPU driver did not bind to a healthy display adapter"
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
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct DISPLAY_DEVICE { public int cb; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString; public int StateFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct DEVMODE { [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName; public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput; public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName; public short dmLogPixels; public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency, dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplayDevices(string deviceName, uint deviceNumber, ref DISPLAY_DEVICE displayDevice, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplaySettingsEx(string deviceName, int modeNumber, ref DEVMODE mode, int flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int ChangeDisplaySettingsEx(string deviceName, ref DEVMODE mode, IntPtr hwnd, int flags, IntPtr lParam);
  public const int CDS_UPDATEREGISTRY = 0x00000001;
  public const int CDS_GLOBAL = 0x00000008;
  public const int DISP_CHANGE_SUCCESSFUL = 0;
  public const int DISP_CHANGE_RESTART = 1;
  public const int DISPLAY_DEVICE_ATTACHED_TO_DESKTOP = 0x00000001;
  public const int DISPLAY_DEVICE_NOT_FOUND = -1001;
  public const int MODE_UNAVAILABLE = -1002;
  public static string FindAttachedDisplayDevice() { for (uint index = 0; ; index++) { var device = new DISPLAY_DEVICE(); device.cb = Marshal.SizeOf(device); if (!EnumDisplayDevices(null, index, ref device, 0)) break; if ((device.StateFlags & DISPLAY_DEVICE_ATTACHED_TO_DESKTOP) != 0) return device.DeviceName; } return null; }
  public static bool TryGetExactMode(string deviceName, int width, int height, out DEVMODE exactMode) { exactMode = new DEVMODE(); for (int index = 0; ; index++) { var candidate = new DEVMODE(); candidate.dmSize = (short)Marshal.SizeOf(candidate); if (!EnumDisplaySettingsEx(deviceName, index, ref candidate, 0)) break; if (candidate.dmPelsWidth == width && candidate.dmPelsHeight == height) { exactMode = candidate; return true; } } return false; }
  public static int SetExactDisplayMode(int width, int height) { var deviceName = FindAttachedDisplayDevice(); if (String.IsNullOrWhiteSpace(deviceName)) return DISPLAY_DEVICE_NOT_FOUND; DEVMODE mode; if (!TryGetExactMode(deviceName, width, height, out mode)) return MODE_UNAVAILABLE; return ChangeDisplaySettingsEx(deviceName, ref mode, IntPtr.Zero, CDS_UPDATEREGISTRY | CDS_GLOBAL, IntPtr.Zero); }
}
'@ -ErrorAction SilentlyContinue
  $result = [Win10Display]::SetExactDisplayMode($Width, $Height)
  if ($result -eq [Win10Display]::DISP_CHANGE_SUCCESSFUL) { return }
  if ($result -eq [Win10Display]::MODE_UNAVAILABLE) { throw "display mode $Width x $Height is not advertised by the active virtual adapter" }
  if ($result -eq [Win10Display]::DISPLAY_DEVICE_NOT_FOUND) { throw "an active virtual display adapter is unavailable" }
  if ($result -eq [Win10Display]::DISP_CHANGE_RESTART) { throw "display mode $Width x $Height requires a reboot" }
  throw "display mode $Width x $Height failed with ChangeDisplaySettingsEx result $result"
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

function Test-RemainingAutomaticLogonDisabled {
  $winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
  return [string](Get-ItemPropertyValue -Path $winlogon -Name "AutoAdminLogon" -ErrorAction SilentlyContinue) -eq "0"
}

function Get-InteractiveDisplayCleanupStatus {
  param([object] $Task)
  if ($null -eq $Task) { $Task = Get-InteractiveDisplayTaskStatus }
  return @{
    taskRemoved = $null -eq $Task
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
  return $Report.desktop.width -eq $DesktopWidth -and $Report.desktop.height -eq $DesktopHeight -and $Report.desktop.scalePercent -eq $DesktopScalePercent -and -not [string]::IsNullOrWhiteSpace([string]$Report.displayAdapter)
}

function Complete-InteractiveDisplayPreparation {
  param([Parameter(Mandatory = $true)] [object] $Report)
  $state = Read-InteractiveDisplayPreparationState
  $attempt = if ($null -eq $state) { 1 } else { [int]$state.attempt }
  Remove-InteractiveDisplayPreparationTask
  Disable-RemainingAutomaticLogon
  $cleanup = Get-InteractiveDisplayCleanupStatus
  if (-not $cleanup.taskRemoved -or -not $cleanup.automaticLogonDisabled) {
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
    $displayAdapter = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue |
      Where-Object { $_.Status -eq "OK" -and -not [string]::IsNullOrWhiteSpace($_.Name) } |
      Select-Object -First 1
    if ($null -eq $displayAdapter) { throw "an active virtual display adapter is unavailable" }
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
      displayAdapter = $displayAdapter.Name
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
  if (Test-Path -LiteralPath $interactiveDisplayReportPath -PathType Leaf) {
    try { $report = Get-Content -Raw -LiteralPath $interactiveDisplayReportPath | ConvertFrom-Json } catch { $reportError = $_.Exception.Message }
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
    completionValid = (Test-InteractiveDisplayReport -Report $report) -and $state.phase -eq "complete" -and $cleanup.taskRemoved -and $cleanup.automaticLogonDisabled
    taskLogTail = $taskLogTail
    currentBootIdentity = Get-BootIdentity
  } | ConvertTo-Json -Depth 6
}

function Rearm-InteractiveDisplay {
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
  Install-VirtioGpuDisplayDriver -DriverRoot $VirtioGpuDriverPath -IdentityPath $VirtioGpuDriverIdentityPath
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
