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
New-Item -ItemType Directory -Force -Path $cacheRoot, $runnerRoot | Out-Null

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-ExecutionPolicy Bypass -Scope Process -Force
Invoke-Expression ((New-Object Net.WebClient).DownloadString("https://community.chocolatey.org/install.ps1"))
choco install -y git nodejs-lts rustup.install visualstudio2022buildtools visualstudio2022-workload-vctools
corepack enable

foreach ($entry in @{
  PNPM_HOME = "$cacheRoot\pnpm"
  CARGO_HOME = "$cacheRoot\cargo"
  RUSTUP_HOME = "$cacheRoot\rustup"
  CARGO_TARGET_DIR = "$cacheRoot\target"
  SCCACHE_DIR = "$cacheRoot\sccache"
  TURBO_CACHE_DIR = "$cacheRoot\turbo"
}.GetEnumerator()) {
  New-Item -ItemType Directory -Force -Path $entry.Value | Out-Null
  [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, "Machine")
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
