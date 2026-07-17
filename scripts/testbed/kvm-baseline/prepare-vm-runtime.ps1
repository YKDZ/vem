[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)] [string] $RunnerArchiveUri,
  [Parameter(Mandatory = $true)] [string] $RunnerUrl,
  [Parameter(Mandatory = $true)] [string] $RunnerRegistrationToken,
  [Parameter(Mandatory = $true)] [string] $RunnerName
)

$ErrorActionPreference = "Stop"
$cacheRoot = "D:\runtime-cache"
$runnerRoot = "C:\actions-runner"
$systemDisk = (Get-Partition -DriveLetter C | Select-Object -First 1).DiskNumber
$cacheDisk = @(Get-Disk | Where-Object { $_.Number -ne $systemDisk })
if ($cacheDisk.Count -ne 1) { throw "expected exactly one non-system cache disk" }
$cacheDisk = $cacheDisk[0]
Set-Disk -Number $cacheDisk.Number -IsOffline $false -IsReadOnly $false
$cacheVolume = Get-Partition -DiskNumber $cacheDisk.Number -ErrorAction SilentlyContinue | Get-Volume -ErrorAction SilentlyContinue | Where-Object { $_.DriveLetter -eq "D" } | Select-Object -First 1
if ($null -eq $cacheVolume) {
  if ($cacheDisk.PartitionStyle -eq "RAW") { Initialize-Disk -Number $cacheDisk.Number -PartitionStyle GPT | Out-Null }
  New-Partition -DiskNumber $cacheDisk.Number -UseMaximumSize -DriveLetter D | Format-Volume -FileSystem NTFS -NewFileSystemLabel "VEMCACHE" -Confirm:$false | Out-Null
} elseif ($cacheVolume.FileSystem -ne "NTFS") {
  throw "D: cache disk must use NTFS"
}
Set-Volume -DriveLetter D -NewFileSystemLabel "VEMCACHE"
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

$archive = Join-Path $env:TEMP "actions-runner.zip"
Invoke-WebRequest -UseBasicParsing -Uri $RunnerArchiveUri -OutFile $archive
Expand-Archive -Force -Path $archive -DestinationPath $runnerRoot
Push-Location $runnerRoot
try {
  & .\config.cmd --unattended --url $RunnerUrl --token $RunnerRegistrationToken --name $RunnerName --work "$cacheRoot\actions-work" --runasservice
  if ($LASTEXITCODE -ne 0) { throw "actions runner registration failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-ExecutionPolicy Bypass -Scope Process -Force
Invoke-Expression ((New-Object Net.WebClient).DownloadString("https://community.chocolatey.org/install.ps1"))
choco install -y git nodejs-lts rustup.install visualstudio2022buildtools visualstudio2022-workload-vctools
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\ProgramData\chocolatey\bin"
corepack enable
& rustup default stable
if ($LASTEXITCODE -ne 0) { throw "rustup stable toolchain installation failed" }

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
}
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") + ";C:\ProgramData\chocolatey\bin"
pnpm config set store-dir "$cacheRoot\pnpm-store" --global
