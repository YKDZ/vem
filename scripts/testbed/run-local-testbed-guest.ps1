param(
  [Parameter(Mandatory = $true)][ValidateSet("fast", "full", "clear_cache")][string]$Mode,
  [string]$GuestInputPath = "C:\ProgramData\VEM\testbed\guest-input.json"
)

$ErrorActionPreference = "Stop"
$cacheRoot = "D:\runtime-cache\v1"
$runtimeRoot = "C:\ProgramData\VEM"
$daemonDataRoot = Join-Path $runtimeRoot "vending-daemon"
$deploymentRoot = "C:\VEM\local-testbed"
$declaredCachePaths = @(
  (Join-Path $cacheRoot "pnpm-store"),
  (Join-Path $cacheRoot "cargo-home"),
  (Join-Path $cacheRoot "target"),
  (Join-Path $cacheRoot "sccache"),
  (Join-Path $cacheRoot "turbo")
)

function Require-Path([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "missing required testbed input: $Path" }
}

function Clear-DeclaredCaches {
  foreach ($path in $declaredCachePaths) {
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  }
  foreach ($path in $declaredCachePaths) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
  }
}

function Assert-DeclaredCachePath([string]$Path, [string]$Name) {
  $resolvedRoot = [IO.Path]::GetFullPath($cacheRoot)
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Name must be on D: runtime cache"
  }
}

function Invoke-Claim([object]$Input) {
  $readyPath = Join-Path $daemonDataRoot "daemon-ready.json"
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  do {
    if (Test-Path -LiteralPath $readyPath) {
      $ready = Get-Content -Raw -LiteralPath $readyPath | ConvertFrom-Json
      try {
        $response = Invoke-RestMethod -Method Post -Uri "$($ready.healthzUrl -replace '/healthz$', '')/v1/provisioning/claim" -Headers @{ Authorization = "Bearer $($ready.ipcToken)" } -ContentType "application/json" -Body (@{ claimCode = [string]$Input.claimCode } | ConvertTo-Json -Compress) -TimeoutSec 10
        if ($response.machineCode -ne $Input.machineCode) { throw "claim returned an unexpected machine" }
        return $response
      } catch { $lastError = $_ }
    }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "clean Runtime Bootstrap claim did not complete: $lastError"
}

Require-Path $GuestInputPath
$input = Get-Content -Raw -LiteralPath $GuestInputPath | ConvertFrom-Json
if ($input.schemaVersion -ne "vem-local-testbed-guest-input/v1") { throw "invalid local testbed guest input" }

if ($Mode -eq "clear_cache") {
  Clear-DeclaredCaches
  [Console]::Out.WriteLine('{"ok":true,"mode":"clear_cache","cacheCleared":true}')
  exit 0
}

New-Item -ItemType Directory -Force -Path $deploymentRoot, $daemonDataRoot | Out-Null
$env:CARGO_TARGET_DIR = Join-Path $cacheRoot "target"
$env:SCCACHE_DIR = Join-Path $cacheRoot "sccache"
$env:TURBO_CACHE_DIR = Join-Path $cacheRoot "turbo"
$env:PNPM_STORE_PATH = Join-Path $cacheRoot "pnpm-store"
$env:CARGO_HOME = Join-Path $cacheRoot "cargo-home"
$sccache = (Get-Command sccache -ErrorAction Stop).Source
$env:RUSTC_WRAPPER = $sccache
foreach ($path in $declaredCachePaths) { New-Item -ItemType Directory -Force -Path $path | Out-Null }
foreach ($pair in @{
  CARGO_TARGET_DIR = $env:CARGO_TARGET_DIR
  SCCACHE_DIR = $env:SCCACHE_DIR
  TURBO_CACHE_DIR = $env:TURBO_CACHE_DIR
  PNPM_STORE_PATH = $env:PNPM_STORE_PATH
  CARGO_HOME = $env:CARGO_HOME
}.GetEnumerator()) { Assert-DeclaredCachePath $pair.Value $pair.Key }
pnpm config set store-dir $env:PNPM_STORE_PATH --location global
if ($LASTEXITCODE -ne 0) { throw "pnpm store configuration failed" }
if ((pnpm config get store-dir).Trim() -ne $env:PNPM_STORE_PATH) { throw "pnpm store-dir did not resolve to D: cache" }
pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
pnpm turbo run build --filter @vem/shared --cache-dir $env:TURBO_CACHE_DIR
if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $env:TURBO_CACHE_DIR)) { throw "Turbo cache was not created on D:" }
pnpm --filter machine tauri:build:kiosk:windows
if ($LASTEXITCODE -ne 0) { throw "Machine Runtime Console build failed" }
$null = & $sccache --zero-stats
cargo build -p vending-daemon --release
if ($LASTEXITCODE -ne 0) { throw "vending daemon build failed" }
$sccacheStats = (& $sccache --show-stats | Out-String)
if ($sccacheStats -notmatch "Compile requests\\s+[1-9]") { throw "sccache was not invoked by Cargo" }

$daemon = Get-ChildItem -LiteralPath $env:CARGO_TARGET_DIR -Filter "vending-daemon.exe" -Recurse | Select-Object -First 1
$machine = Get-ChildItem -LiteralPath $env:CARGO_TARGET_DIR -Filter "machine.exe" -Recurse | Select-Object -First 1
if ($null -eq $daemon -or $null -eq $machine) { throw "Windows build did not produce daemon and Machine Runtime Console" }
Copy-Item -LiteralPath $daemon.FullName -Destination (Join-Path $deploymentRoot "vending-daemon.exe") -Force
Copy-Item -LiteralPath $machine.FullName -Destination (Join-Path $deploymentRoot "machine.exe") -Force
$input.runtimeBootstrap | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runtimeRoot "runtime-bootstrap.json") -Encoding utf8
Get-Process vending-daemon -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process -FilePath (Join-Path $deploymentRoot "vending-daemon.exe") -ArgumentList @("--data-dir", $daemonDataRoot) -WorkingDirectory $deploymentRoot
$claim = Invoke-Claim $input

$testCommand = @("--filter", "machine", "test:e2e:real-daemon")
& pnpm @testCommand
if ($LASTEXITCODE -ne 0) { throw "installed Windows runtime tests failed" }
[Console]::Out.WriteLine((@{ ok = $true; mode = $Mode; machineCode = $claim.machineCode; deploymentRoot = $deploymentRoot; cacheRoot = $cacheRoot } | ConvertTo-Json -Compress))
