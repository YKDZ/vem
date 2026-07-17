[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [ValidateSet("PrepareToolchain", "RegisterRunner")] [string] $Mode,
  [string] $RunnerArchiveUri,
  [string] $RunnerUrl,
  [string] $RunnerRegistrationToken,
  [string] $RunnerName
)

$ErrorActionPreference = "Stop"
$cacheRoot = "D:\runtime-cache"
$runnerRoot = "C:\actions-runner"

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
  New-Item -ItemType Directory -Force -Path $cacheRoot, $runnerRoot | Out-Null
  Set-Content -Encoding ascii -Path "$cacheRoot\.write-test" -Value "runtime-cache"
  Remove-Item -Force "$cacheRoot\.write-test"
  foreach ($entry in @{
    PNPM_HOME = "$cacheRoot\pnpm"
    CARGO_HOME = "$cacheRoot\cargo"
    RUSTUP_HOME = "$cacheRoot\rustup"
    CARGO_TARGET_DIR = "$cacheRoot\target"
    SCCACHE_DIR = "$cacheRoot\sccache"
    TURBO_CACHE_DIR = "$cacheRoot\turbo"
    npm_config_cache = "$cacheRoot\npm"
  }.GetEnumerator()) {
    New-Item -ItemType Directory -Force -Path $entry.Value | Out-Null
    [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Machine")
    Set-Item -Path "Env:$($entry.Key)" -Value $entry.Value
  }
}

function Refresh-ProcessPath {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\ProgramData\chocolatey\bin"
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
  Invoke-Native -FilePath "choco.exe" -ArgumentList @("install", "-y", "git", "nodejs-lts", "rustup.install", "visualstudio2022buildtools", "visualstudio2022-workload-vctools") -Description "Windows build toolchain installation"
  Refresh-ProcessPath
  Invoke-Native -FilePath "corepack.cmd" -ArgumentList @("enable") -Description "Corepack enable"
  Invoke-Native -FilePath "rustup.exe" -ArgumentList @("default", "stable") -Description "Rust stable toolchain installation"
  Invoke-Native -FilePath "pnpm.cmd" -ArgumentList @("config", "set", "store-dir", "$cacheRoot\pnpm-store", "--global") -Description "pnpm cache configuration"
  foreach ($tool in @("git.exe", "node.exe", "pnpm.cmd", "cargo.exe", "rustc.exe")) {
    Invoke-Native -FilePath $tool -ArgumentList @("--version") -Description "$tool version probe"
  }
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
  foreach ($required in @("RunnerArchiveUri", "RunnerUrl", "RunnerRegistrationToken", "RunnerName")) {
    if ([string]::IsNullOrWhiteSpace((Get-Variable -Name $required -ValueOnly))) { throw "$required is required for runner registration" }
  }
  $archive = Join-Path $env:TEMP "actions-runner-$RunnerName.zip"
  Invoke-WebRequest -UseBasicParsing -Uri $RunnerArchiveUri -OutFile $archive
  Expand-Archive -Force -Path $archive -DestinationPath $runnerRoot
  Push-Location $runnerRoot
  try {
    Invoke-Native -FilePath ".\config.cmd" -ArgumentList @("--unattended", "--url", $RunnerUrl, "--token", $RunnerRegistrationToken, "--name", $RunnerName, "--work", "$cacheRoot\actions-work", "--runasservice") -Description "actions runner registration"
  } finally {
    Pop-Location
    Remove-Item -Force $archive -ErrorAction SilentlyContinue
  }
}

if ($Mode -eq "PrepareToolchain") {
  Initialize-CacheDisk
  Set-CacheEnvironment
  Install-Toolchain
  exit 0
}

Register-Runner
