param(
  [Parameter(Mandatory = $true)][ValidateSet("fast", "full", "clear_cache")][string]$Mode,
  [string]$GuestInputPath = "C:\ProgramData\VEM\testbed\guest-input.json"
)

$ErrorActionPreference = "Stop"
$cacheRoot = "D:\runtime-cache\v1"
$runtimeRoot = "C:\ProgramData\VEM"
$daemonDataRoot = Join-Path $runtimeRoot "vending-daemon"
$deploymentRoot = "C:\VEM\bringup"
$handoffRoot = Join-Path $runtimeRoot "testbed"
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

function Wait-RuntimeReady {
  $readyPath = Join-Path $daemonDataRoot "daemon-ready.json"
  $healthStatuses = @("healthy", "degraded", "offline", "maintenance", "starting")
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  do {
    if (Test-Path -LiteralPath $readyPath) {
      $ready = Get-Content -Raw -LiteralPath $readyPath | ConvertFrom-Json
      try {
        $health = Invoke-RestMethod -Uri $ready.healthzUrl -Headers @{ Authorization = "Bearer $($ready.ipcToken)" } -TimeoutSec 5
        $readiness = Invoke-RestMethod -Uri $ready.readyzUrl -Headers @{ Authorization = "Bearer $($ready.ipcToken)" } -TimeoutSec 5
        if ($healthStatuses -contains [string]$health.status -and $null -ne $health.process -and $null -ne $health.components -and [bool]$readiness.ready) {
          return @{ ready = $ready; health = $health; readiness = $readiness }
        }
      } catch { $lastError = $_ }
    }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "deployed production daemon did not become ready after claim: $lastError"
}

function Wait-InstalledTauriTarget {
  $deadline = [DateTime]::UtcNow.AddMinutes(1)
  do {
    try {
      $targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:9222/json" -TimeoutSec 3)
      $tauriTargets = @($targets | Where-Object { [string]$_.url -match '^http://tauri\.localhost/#/' })
      if ($tauriTargets.Count -eq 1) { return $tauriTargets[0] }
    } catch { $lastError = $_ }
    Start-Sleep -Seconds 1
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "installed Tauri CDP target did not become observable: $lastError"
}

function Get-CanonicalProcessEvidence([string]$Name, [string]$ExpectedPath) {
  $matches = @(Get-CimInstance Win32_Process -Filter "Name = '$Name'" | Where-Object {
    $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $ExpectedPath)
  })
  if ($matches.Count -ne 1) { throw "expected one canonical $Name process, found $($matches.Count)" }
  $cim = $matches[0]
  $process = Get-Process -Id ([int]$cim.ProcessId) -ErrorAction Stop
  $owner = Invoke-CimMethod -InputObject $cim -MethodName GetOwner -ErrorAction Stop
  return [ordered]@{
    executablePath = [IO.Path]::GetFullPath($cim.ExecutablePath)
    processId = [int]$process.Id
    sessionId = [int]$process.SessionId
    principal = "{0}\{1}" -f [string]$owner.Domain, [string]$owner.User
    commandLine = [string]$cim.CommandLine
  }
}

function Get-CdpProcessBinding([int]$MachineProcessId) {
  $listeners = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 9222 -State Listen -ErrorAction Stop)
  if ($listeners.Count -ne 1) { throw "expected one installed Tauri CDP listener, found $($listeners.Count)" }
  $listenerProcessId = [int]$listeners[0].OwningProcess
  $cursor = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerProcessId" -ErrorAction Stop
  $ancestor = $null
  for ($depth = 0; $depth -lt 32 -and $null -ne $cursor; $depth += 1) {
    if ([int]$cursor.ProcessId -eq $MachineProcessId) { $ancestor = $MachineProcessId; break }
    $parentId = [int]$cursor.ParentProcessId
    if ($parentId -le 0 -or $parentId -eq [int]$cursor.ProcessId) { break }
    $cursor = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -ErrorAction SilentlyContinue
  }
  if ($null -eq $ancestor) { throw "CDP listener is not descended from canonical machine.exe" }
  return [ordered]@{ listenerProcessId = $listenerProcessId; machineAncestorProcessId = $ancestor }
}

if ($Mode -eq "clear_cache") {
  Clear-DeclaredCaches
  [Console]::Out.WriteLine('{"ok":true,"mode":"clear_cache","cacheCleared":true}')
  exit 0
}

Require-Path $GuestInputPath
$input = Get-Content -Raw -LiteralPath $GuestInputPath | ConvertFrom-Json
if ($input.schemaVersion -ne "vem-local-testbed-guest-input/v1") { throw "invalid local testbed guest input" }

New-Item -ItemType Directory -Force -Path $deploymentRoot, $daemonDataRoot, $handoffRoot | Out-Null
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

$daemonSource = Join-Path $env:CARGO_TARGET_DIR "release\vending-daemon.exe"
$machineSource = Join-Path $env:CARGO_TARGET_DIR "release\machine.exe"
$webViewLoaderSource = Join-Path $env:CARGO_TARGET_DIR "release\WebView2Loader.dll"
Require-Path $daemonSource
Require-Path $machineSource
Require-Path $webViewLoaderSource
$daemonPath = Join-Path $deploymentRoot "vending-daemon.exe"
$machinePath = Join-Path $deploymentRoot "machine.exe"
Copy-Item -LiteralPath $daemonSource -Destination $daemonPath -Force
Copy-Item -LiteralPath $machineSource -Destination $machinePath -Force
Copy-Item -LiteralPath $webViewLoaderSource -Destination (Join-Path $deploymentRoot "WebView2Loader.dll") -Force
$input.runtimeBootstrap | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runtimeRoot "runtime-bootstrap.json") -Encoding utf8
Get-Process vending-daemon -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process machine -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -LiteralPath (Join-Path $daemonDataRoot "daemon-ready.json") -Force -ErrorAction SilentlyContinue
$daemonStdout = Join-Path $handoffRoot "vending-daemon.stdout.log"
$daemonStderr = Join-Path $handoffRoot "vending-daemon.stderr.log"
$daemonProcess = Start-Process -FilePath $daemonPath -ArgumentList @("--console", "--data-dir", $daemonDataRoot) -WorkingDirectory $deploymentRoot -RedirectStandardOutput $daemonStdout -RedirectStandardError $daemonStderr -PassThru
$claim = Invoke-Claim $input
$runtimeReady = Wait-RuntimeReady
$daemonEvidence = Get-CanonicalProcessEvidence "vending-daemon.exe" $daemonPath
if ($daemonEvidence.processId -ne $daemonProcess.Id -or $daemonEvidence.commandLine -notmatch '(?i)(?:^|\s)--console(?:\s|$)') {
  throw "deployed daemon process is not the claimed production --console process"
}

$machineTaskName = "VEMLocalTestbedInstalledRuntime"
$machineLauncher = Join-Path $handoffRoot "launch-installed-machine.cmd"
Stop-ScheduledTask -TaskName $machineTaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $machineTaskName -Confirm:$false -ErrorAction SilentlyContinue
@(
  "@echo off",
  "set `"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`"",
  "cd /d `"$deploymentRoot`"",
  "`"$machinePath`""
) | Set-Content -LiteralPath $machineLauncher -Encoding ascii
$machineAction = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/d /c `"$machineLauncher`"" -WorkingDirectory $deploymentRoot
$machinePrincipal = New-ScheduledTaskPrincipal -UserId ([string]$input.interactiveUser) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $machineTaskName -Action $machineAction -Principal $machinePrincipal -Force | Out-Null
Start-ScheduledTask -TaskName $machineTaskName
$target = Wait-InstalledTauriTarget
$machineEvidence = Get-CanonicalProcessEvidence "machine.exe" $machinePath
$expectedInteractiveUser = ([string]$input.interactiveUser -split '\\')[-1]
$observedInteractiveUser = ([string]$machineEvidence.principal -split '\\')[-1]
if ($observedInteractiveUser -ine $expectedInteractiveUser) {
  throw "installed Tauri process is not owned by the baseline interactive user"
}
$cdpBinding = Get-CdpProcessBinding $machineEvidence.processId
$handoffPath = Join-Path $handoffRoot "installed-runtime-handoff.json"
$smokeOutPath = Join-Path $handoffRoot "installed-runtime-smoke.json"
[string]$fastRouteOutPath = Join-Path $handoffRoot "fast-route-stress-sale.json"
[ordered]@{
  schemaVersion = "vem-installed-runtime-handoff/v1"
  machineCode = [string]$input.machineCode
  claim = [ordered]@{ status = [string]$claim.status; machineCode = [string]$claim.machineCode }
  daemon = [ordered]@{
    executablePath = $daemonEvidence.executablePath
    processId = $daemonEvidence.processId
    console = $true
    ready = [ordered]@{
      healthzUrl = [string]$runtimeReady.ready.healthzUrl
      readyzUrl = [string]$runtimeReady.ready.readyzUrl
      ipcToken = [string]$runtimeReady.ready.ipcToken
    }
  }
  machine = [ordered]@{
    executablePath = $machineEvidence.executablePath
    processId = $machineEvidence.processId
    sessionId = $machineEvidence.sessionId
    principal = $machineEvidence.principal
  }
  cdp = [ordered]@{
    endpoint = "http://127.0.0.1:9222"
    targetId = [string]$target.id
    listenerProcessId = $cdpBinding.listenerProcessId
    machineAncestorProcessId = $cdpBinding.machineAncestorProcessId
  }
} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $handoffPath -Encoding utf8

node scripts/testbed/installed-runtime-smoke.mjs --mode $Mode --evidence $handoffPath --out $smokeOutPath
if ($LASTEXITCODE -ne 0) { throw "installed production runtime smoke failed" }
node scripts/testbed/fast-route-stress-sale.mjs --mode $Mode --guest-input $GuestInputPath --handoff $handoffPath --out $fastRouteOutPath
if ($LASTEXITCODE -ne 0) { throw "fast route stress sale failed" }
Get-Content -Raw -LiteralPath $smokeOutPath | Write-Output
Get-Content -Raw -LiteralPath $fastRouteOutPath | Write-Output
