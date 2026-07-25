param(
  [Parameter(Mandatory = $true)][ValidateSet("fast", "full", "clear_cache")][string]$Mode,
  [string]$Commit,
  [ValidateRange(1, 2)][int]$Pass = 1,
  [string[]]$Focus = @(),
  [string]$GuestInputPath = "C:\ProgramData\VEM\testbed\guest-input.json"
)

$ErrorActionPreference = "Stop"
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
Set-Location -LiteralPath $repoRoot
$cacheRoot = "D:\runtime-cache\v1"
$runtimeRoot = "C:\ProgramData\VEM"
$daemonDataRoot = Join-Path $runtimeRoot "vending-daemon"
$deploymentRoot = "C:\VEM\bringup"
$handoffRoot = Join-Path $runtimeRoot "testbed"
$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
$env:Path = @($machinePath, $userPath, $env:Path) |
  Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
  Select-Object -Unique |
  Join-String -Separator ";"
$proxyBypass = @("localhost", "127.0.0.1", "::1") + @(
  ([string]$env:NO_PROXY -split ",")
) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique
$env:NO_PROXY = $proxyBypass -join ","
$env:no_proxy = $env:NO_PROXY
$declaredCachePaths = @(
  (Join-Path $cacheRoot "pnpm-store"),
  (Join-Path $cacheRoot "pnpm-virtual-store"),
  (Join-Path $cacheRoot "cargo-home"),
  (Join-Path $cacheRoot "target"),
  (Join-Path $cacheRoot "sccache"),
  (Join-Path $cacheRoot "turbo"),
  (Join-Path $cacheRoot "vision-main")
)
$retainedToolPaths = @(
  (Join-Path $cacheRoot "powershell")
)
$allowedRetainedPaths = @($declaredCachePaths) + @($retainedToolPaths)

function Require-Path([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "missing required testbed input: $Path" }
}

function Write-TestbedPhase([string]$Name) {
  New-Item -ItemType Directory -Force -Path $handoffRoot | Out-Null
  Add-Content -LiteralPath (Join-Path $handoffRoot "guest-phases.log") -Encoding utf8 -Value "$(Get-Date -Format o) $Name"
  Write-Output "::vem-testbed-phase::$Name"
}

function Get-LocalRustSourceDigest {
  $paths = @(
    "Cargo.toml",
    "Cargo.lock",
    "apps\machine\src-tauri",
    "apps\vending-daemon",
    "crates\vending-core",
    "crates\daemon-ipc-contracts"
  ) | ForEach-Object { Join-Path $repoRoot $_ }
  $files = @($paths | ForEach-Object {
    if (Test-Path -LiteralPath $_ -PathType Leaf) { Get-Item -LiteralPath $_ }
    else {
      Get-ChildItem -LiteralPath $_ -Recurse -File | Where-Object {
        $_.Extension -in @(".rs", ".toml", ".json")
      }
    }
  } | Sort-Object FullName -Unique)
  $entries = @($files | ForEach-Object {
    $relative = [IO.Path]::GetRelativePath($repoRoot, $_.FullName)
    $digest = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    "$relative`0$digest"
  })
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($entries -join "`n")
    return [Convert]::ToHexString($hasher.ComputeHash($bytes)).ToLowerInvariant()
  } finally {
    $hasher.Dispose()
  }
}

function Get-RuntimeArtifactSourceDigest {
  $paths = @(
    "Cargo.toml",
    "Cargo.lock",
    "package.json",
    "pnpm-lock.yaml",
    "turbo.json",
    "tsconfig.json",
    "apps\machine\package.json",
    "apps\machine\index.html",
    "apps\machine\vite.config.ts",
    "apps\machine\src",
    "apps\machine\src-tauri",
    "apps\vending-daemon",
    "crates\vending-core",
    "crates\daemon-ipc-contracts",
    "packages\shared\package.json",
    "packages\shared\src"
  ) | ForEach-Object { Join-Path $repoRoot $_ }
  $files = @($paths | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object {
    if (Test-Path -LiteralPath $_ -PathType Leaf) { Get-Item -LiteralPath $_ }
    else {
      Get-ChildItem -LiteralPath $_ -Recurse -File | Where-Object {
        $_.FullName -notmatch '\\node_modules\\|\\target\\|\\dist\\' -and
        $_.Name -notmatch '\.(spec|test)\.[^.]+$'
      }
    }
  } | Sort-Object FullName -Unique)
  $entries = @($files | ForEach-Object {
    $relative = [IO.Path]::GetRelativePath($repoRoot, $_.FullName)
    $digest = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash
    "$relative`0$digest"
  })
  $hasher = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($entries -join "`n")
    return [Convert]::ToHexString($hasher.ComputeHash($bytes)).ToLowerInvariant()
  } finally {
    $hasher.Dispose()
  }
}

function Get-TestbedSccache {
  $version = "0.16.0"
  $toolRoot = Join-Path $cacheRoot "sccache\bin\$version"
  $executable = Join-Path $toolRoot "sccache.exe"
  if (Test-Path -LiteralPath $executable -PathType Leaf) {
    return $executable
  }

  $archive = Join-Path $env:TEMP "sccache-v$version-x86_64-pc-windows-msvc.zip"
  $pending = "$toolRoot.pending"
  Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $pending -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $pending | Out-Null
  try {
    $url = "https://github.com/mozilla/sccache/releases/download/v$version/sccache-v$version-x86_64-pc-windows-msvc.zip"
    & curl.exe --fail --location --retry 3 --output $archive $url
    if ($LASTEXITCODE -ne 0) { throw "sccache download failed with curl exit code $LASTEXITCODE" }
    Expand-Archive -LiteralPath $archive -DestinationPath $pending -Force
    $downloaded = Get-ChildItem -LiteralPath $pending -Filter "sccache.exe" -Recurse | Select-Object -First 1
    if ($null -eq $downloaded) { throw "sccache archive did not contain sccache.exe" }
    New-Item -ItemType Directory -Force -Path $toolRoot | Out-Null
    Copy-Item -LiteralPath $downloaded.FullName -Destination $executable -Force
  } finally {
    Remove-Item -LiteralPath $archive -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $pending -Recurse -Force -ErrorAction SilentlyContinue
  }
  return $executable
}

function Clear-DeclaredCaches {
  foreach ($path in $declaredCachePaths) {
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  }
  foreach ($path in $declaredCachePaths) {
    New-Item -ItemType Directory -Force -Path $path | Out-Null
  }
}

function Get-ObservedCacheDirectories {
  $resolvedRoot = [IO.Path]::GetFullPath($cacheRoot)
  if (-not (Test-Path -LiteralPath $resolvedRoot -PathType Container)) {
    return @()
  }
  return @(
    Get-ChildItem -LiteralPath $resolvedRoot -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.PSIsContainer } |
      ForEach-Object { [IO.Path]::GetFullPath($_.FullName) } |
      Sort-Object
  )
}

function Remove-UndeclaredCacheDirectories {
  $declared = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($path in $allowedRetainedPaths) {
    [void]$declared.Add([IO.Path]::GetFullPath($path))
  }
  $removed = @()
  foreach ($path in Get-ObservedCacheDirectories) {
    if (-not $declared.Contains($path)) {
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
      $removed += $path
    }
  }
  return @($removed | Sort-Object)
}

function Get-DeclaredCacheObservation {
  return [ordered]@{
    declaredRetainedCaches = @($allowedRetainedPaths | ForEach-Object { [IO.Path]::GetFullPath($_) } | Sort-Object)
    observedRetainedCaches = @(Get-ObservedCacheDirectories)
  }
}

function Assert-ObservedCachesMatchAllowlist([object]$Observation) {
  $declared = @($Observation.declaredRetainedCaches)
  $observed = @($Observation.observedRetainedCaches)
  if ((Compare-Object -ReferenceObject $declared -DifferenceObject $observed -SyncWindow 0).Count -ne 0) {
    throw "observed D: runtime cache directories drifted from the declared allowlist"
  }
}

function Update-WorkflowIdentityCacheObservation(
  [string]$Path,
  [string[]]$ObservedRetainedCaches,
  [string[]]$RemovedUndeclaredCaches
) {
  Require-Path $Path
  $guestInput = Get-Content -Raw -LiteralPath $Path -Encoding UTF8 | ConvertFrom-Json
  if ($guestInput.schemaVersion -ne "vem-local-testbed-guest-input/v1") {
    throw "invalid local testbed guest input"
  }
  if ($null -eq $guestInput.workflowIdentity) {
    throw "workflow identity is missing from local testbed guest input"
  }
  $guestInput.workflowIdentity.observedRetainedCaches = @(
    $ObservedRetainedCaches | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
  )
  $guestInput.workflowIdentity.removedUndeclaredCaches = @(
    $RemovedUndeclaredCaches | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
  )
  $guestInput | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $Path -Encoding utf8
}

function New-BoundedEvidenceBundle([string]$ManifestPath, [string]$BundleRoot) {
  Require-Path $ManifestPath
  if (Test-Path -LiteralPath $BundleRoot) {
    Remove-Item -LiteralPath $BundleRoot -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $BundleRoot | Out-Null
  $manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
  foreach ($path in @(
    (Join-Path $handoffRoot "installed-runtime-smoke.json"),
    (Join-Path $handoffRoot "full-workflow-tracks.json"),
    $ManifestPath
  )) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      Copy-Item -LiteralPath $path -Destination (Join-Path $BundleRoot ([IO.Path]::GetFileName($path))) -Force
    }
  }
  foreach ($file in @($manifest.files)) {
    $sourcePath = [string]$file.path
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
      throw "manifest file listed for evidence bundle is missing: $sourcePath"
    }
    $extension = [IO.Path]::GetExtension($sourcePath).ToLowerInvariant()
    if ($extension -notin @(".json", ".log", ".txt", ".png")) {
      throw "manifest file listed for evidence bundle has a forbidden extension: $sourcePath"
    }
    $targetPath = Join-Path $BundleRoot ([IO.Path]::GetFileName($sourcePath))
    if (Test-Path -LiteralPath $targetPath) {
      $targetPath = Join-Path $BundleRoot ("{0}-{1}{2}" -f [IO.Path]::GetFileNameWithoutExtension($sourcePath), ([Math]::Abs($sourcePath.GetHashCode())), $extension)
    }
    Copy-Item -LiteralPath $sourcePath -Destination $targetPath -Force
  }
}

function Clear-TestbedRunReports {
  foreach ($path in @(
    (Join-Path $handoffRoot "installed-runtime-smoke.json"),
    (Join-Path $handoffRoot "fast-route-stress-sale.json"),
    (Join-Path $handoffRoot "installed-ipc-recovery.json"),
    (Join-Path $handoffRoot "serial-fulfillment-error.json"),
    (Join-Path $handoffRoot "scanner-payment-code.json"),
    (Join-Path $handoffRoot "delayed-pickup-native-audio.json"),
    (Join-Path $handoffRoot "vision-try-on-acceptance.json"),
    (Join-Path $handoffRoot "full-workflow-tracks.json"),
    (Join-Path $handoffRoot "full-workflow-evidence-manifest.json"),
    (Join-Path $handoffRoot "payment-provider.json"),
    (Join-Path $handoffRoot "payment-recovery.json"),
    (Join-Path $handoffRoot "hardware-lifecycle.json"),
    (Join-Path $handoffRoot "environment-control.json"),
    (Join-Path $handoffRoot "local-operations.json"),
    (Join-Path $handoffRoot "presence-and-audio.json"),
    (Join-Path $handoffRoot "stock-maintenance.json")
  )) {
    Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath (Join-Path $handoffRoot "full-workflow-evidence-bundle") -Recurse -Force -ErrorAction SilentlyContinue
}

function Assert-DeclaredCachePath([string]$Path, [string]$Name) {
  $resolvedRoot = [IO.Path]::GetFullPath($cacheRoot)
  $resolvedPath = [IO.Path]::GetFullPath($Path)
  if (-not $resolvedPath.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Name must be on D: runtime cache"
  }
}

function Invoke-Claim([object]$GuestInput) {
  $claimCode = [string]$GuestInput.claimCode
  if ($claimCode -notmatch '^[A-Z0-9]{4}-[A-Z0-9]{4}$') {
    throw "testbed claim code is invalid: $claimCode"
  }
  $readyPath = Join-Path $daemonDataRoot "daemon-ready.json"
  $deadline = [DateTime]::UtcNow.AddMinutes(2)
  do {
    if (Test-Path -LiteralPath $readyPath) {
      $ready = Get-Content -Raw -LiteralPath $readyPath | ConvertFrom-Json
      try {
        $response = Invoke-RestMethod -Method Post -Uri "$($ready.healthzUrl -replace '/healthz$', '')/v1/provisioning/claim" -Headers @{ Authorization = "Bearer $($ready.ipcToken)" } -ContentType "application/json" -Body (@{ claimCode = $claimCode } | ConvertTo-Json -Compress) -TimeoutSec 10
        if ($response.machineCode -ne $GuestInput.machineCode) { throw "claim returned an unexpected machine" }
        return $response
      } catch {
        $lastError = $_
        $statusCode = [int]$_.Exception.Response.StatusCode
        if ($statusCode -in @(401, 422)) { throw }
      }
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

function Start-TestbedCommissioningSerialSession([object]$GuestInput) {
  $controlPlane = $GuestInput.hostControlPlane
  if ([string]::IsNullOrWhiteSpace([string]$controlPlane.endpoint) -or [string]::IsNullOrWhiteSpace([string]$controlPlane.token)) {
    throw "guest input is missing host control plane credentials"
  }
  $body = [ordered]@{
    runId = [string]$GuestInput.runId
    machineCode = [string]$GuestInput.machineCode
    saleCorrelationId = "sale-correlation://commissioning-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    targetIdentity = [string]$controlPlane.targetIdentity
    runtimeBase = [string]$controlPlane.runtimeBaseIdentity
  } | ConvertTo-Json -Compress
  return Invoke-RestMethod -Method Post -Uri "$($controlPlane.endpoint)/v1/serial-sessions/start" `
    -Headers @{ Authorization = "Bearer $($controlPlane.token)" } `
    -ContentType "application/json" -Body $body -TimeoutSec 30
}

function Stop-TestbedScannerBindingProbe([object]$GuestInput, [object]$Session) {
  $controlPlane = $GuestInput.hostControlPlane
  Invoke-RestMethod -Method Post `
    -Uri "$($controlPlane.endpoint)/v1/serial-sessions/$($Session.sessionId)/stop-scanner-probe" `
    -Headers @{ Authorization = "Bearer $($controlPlane.token)" } `
    -ContentType "application/json" -Body "{}" -TimeoutSec 15 | Out-Null
}

function Initialize-TestbedHardwareBindings {
  $readyPath = Join-Path $daemonDataRoot "daemon-ready.json"
  $ready = Get-Content -Raw -LiteralPath $readyPath | ConvertFrom-Json
  $baseUrl = $ready.healthzUrl -replace '/healthz$', ''
  $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
  foreach ($role in @("lower_controller", "scanner")) {
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    $binding = $null
    $lastBindingError = $null
    do {
      try {
        $snapshot = Invoke-RestMethod -Uri "$baseUrl/v1/hardware-bindings" -Headers $headers -TimeoutSec 10
        $binding = @($snapshot.roles | Where-Object { $_.role -eq $role })[0]
        if ($binding.ready) { break }
      } catch {
        $lastBindingError = $_.Exception.Message
      }
      Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($null -eq $binding -or -not $binding.ready) {
      try {
        $snapshot = Invoke-RestMethod -Uri "$baseUrl/v1/hardware-bindings" -Headers $headers -TimeoutSec 10
        $binding = @($snapshot.roles | Where-Object { $_.role -eq $role })[0]
      } catch {
        $lastBindingError = $_.Exception.Message
      }
    }
    if ($null -eq $binding -or -not $binding.ready) {
      throw "testbed $role production auto-binding did not become ready: $($binding.code): $($binding.message); last query error: $lastBindingError"
    }
  }
}

function Write-TestbedSerialDiscoveryAdapter {
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  $devices = @()
  do {
    $devices = @(Get-PnpDevice -Class Ports -PresentOnly -ErrorAction SilentlyContinue | ForEach-Object {
      $portInstanceId = [string]$_.InstanceId
      $parent = [string](Get-PnpDeviceProperty -InstanceId $portInstanceId -KeyName "DEVPKEY_Device_Parent" -ErrorAction SilentlyContinue).Data
      $usbPortMatch = [regex]::Match($parent, '-([12])$')
      $comPortMatch = [regex]::Match([string]$_.FriendlyName, '\((COM[0-9]+)\)\s*$')
      if (-not $usbPortMatch.Success -or -not $comPortMatch.Success) { return }
      $usbPort = [int]$usbPortMatch.Groups[1].Value
      $currentPort = [string]$comPortMatch.Groups[1].Value
      $role = if ($usbPort -eq 1) { "lower-controller" } else { "scanner" }
      $hardwareId = if ($usbPort -eq 1) { "USB\VID_1A86&PID_7523" } else { "USB\VID_1A86&PID_55D3" }
      $serialNumber = if ($usbPort -eq 1) { "VEMVMLOWER" } else { "VEMVMSCANNER" }
      [pscustomobject]@{
        currentPort = $currentPort
        instanceId = "$hardwareId\$serialNumber"
        containerId = [string](Get-PnpDeviceProperty -InstanceId $parent -KeyName "DEVPKEY_Device_ContainerId" -ErrorAction Stop).Data
        hardwareIds = @($hardwareId)
        serialNumber = $serialNumber
        friendlyName = "VEM VM $role serial boundary"
      }
    })
    if ($devices.Count -eq 2 -and @($devices.currentPort | Select-Object -Unique).Count -eq 2) { break }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($devices.Count -ne 2 -or @($devices.currentPort | Select-Object -Unique).Count -ne 2) {
    throw "testbed serial discovery adapter requires exactly two distinct QEMU USB serial ports"
  }
  $path = Join-Path $handoffRoot "serial-device-observations.json"
  ConvertTo-Json -InputObject $devices -Depth 4 | Set-Content -LiteralPath $path -Encoding utf8
  $env:VEM_TESTBED_SERIAL_DISCOVERY_FILE = $path
}

function Get-InstalledTauriTargetOnce {
  $targets = @(Invoke-RestMethod -Uri "http://127.0.0.1:9222/json" -TimeoutSec 2)
  $tauriTargets = @($targets | Where-Object { [string]$_.url -match '^http://tauri\.localhost/#/' })
  if ($tauriTargets.Count -eq 1) { return $tauriTargets[0] }
  return $null
}

function Wait-InstalledTauriTarget([datetime]$Deadline) {
  do {
    try {
      $target = Get-InstalledTauriTargetOnce
      if ($null -ne $target) { return $target }
      $lastError = "no strict tauri target was exposed"
    } catch { $lastError = $_ }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $Deadline)
  throw "installed Tauri CDP target did not become observable: $lastError"
}

function Wait-InstalledTauriRoute([string]$ExpectedRoute) {
  $deadline = [DateTime]::UtcNow.AddSeconds(90)
  do {
    try {
      $target = Wait-InstalledTauriTarget $deadline
      $route = ([uri][string]$target.url).Fragment
      if ($route -eq $ExpectedRoute) { return $target }
      $lastRoute = $route
    } catch { $lastError = $_ }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($null -ne $lastError) {
    throw "installed Tauri route did not reach ${ExpectedRoute}: $lastError"
  }
  throw "installed Tauri route did not reach ${ExpectedRoute}; last route was $lastRoute"
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

function Wait-CanonicalProcessEvidence([string]$Name, [string]$ExpectedPath, [int]$TimeoutSeconds = 30) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  do {
    try {
      return Get-CanonicalProcessEvidence $Name $ExpectedPath
    } catch { $lastError = $_ }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "canonical $Name process did not become observable: $lastError"
}

function Invoke-InstalledTauriRouteAdmission([string]$Endpoint, [int]$TimeoutSeconds = 120) {
  $stdoutPath = Join-Path $handoffRoot "installed-tauri-route-admission.stdout.log"
  $stderrPath = Join-Path $handoffRoot "installed-tauri-route-admission.stderr.log"
  Remove-Item -LiteralPath $stdoutPath, $stderrPath -Force -ErrorAction SilentlyContinue
  $process = Start-Process `
    -FilePath "node" `
    -ArgumentList @((Join-Path $repoRoot "scripts\testbed\installed-tauri-route-admission.mjs"), "--endpoint", $Endpoint) `
    -WorkingDirectory $repoRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -NoNewWindow `
    -PassThru
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    throw "installed Tauri route admission timed out after $TimeoutSeconds seconds; stdout=$stdoutPath stderr=$stderrPath"
  }
  if ($process.ExitCode -ne 0) {
    $stderr = if (Test-Path -LiteralPath $stderrPath) { Get-Content -LiteralPath $stderrPath -Raw } else { "" }
    throw "installed Tauri route admission failed with exit code $($process.ExitCode): $stderr"
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

function Write-RecordedVisionSiteConfiguration([string]$Path) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  @{
    schemaVersion = "vending-vision-site-config/v1"
    host = "127.0.0.1"
    port = 7892
    allowed_origins = @(
      "http://tauri.localhost",
      "http://127.0.0.1:7892"
    )
    profile_push_interval_ms = 600
    cameras = @{
      top = @{
        source = "recorded_video"
        role = "presence"
        video_path = "recorded-video/top.mp4"
        loop = $false
      }
      front = @{
        source = "recorded_video"
        role = "profile_tryon"
        video_path = "recorded-video/front.mp4"
        loop = $true
      }
    }
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding utf8
}

function Invoke-FullVisionTryOnAcceptance(
  [string]$GuestInputPath,
  [string]$HandoffPath,
  [string]$OutPath
) {
  $visionModulePath = Join-Path $PSScriptRoot "..\windows\vision-main-artifacts.psm1"
  Import-Module $visionModulePath -Force
  $visionCacheRoot = Join-Path $cacheRoot "vision-main"
  $visionSiteConfigurationSourcePath = Join-Path $handoffRoot "vision-recorded-site-config.json"
  Write-RecordedVisionSiteConfiguration $visionSiteConfigurationSourcePath
  $visionCache = Get-VisionMainArtifactCache -CacheRoot $visionCacheRoot
  $visionInstallation = Install-VisionMainArtifact `
    -RuntimeArchive ([string]$visionCache.runtimeArchive) `
    -FixtureArchive ([string]$visionCache.fixtureArchive) `
    -Commit ([string]$visionCache.commit) `
    -SiteConfigurationPath $visionSiteConfigurationSourcePath `
    -ProbeTimeoutSeconds 60
  if ([string]$visionInstallation.commit -ne [string]$visionCache.commit) {
    throw "installed Vision commit does not match the resolved cached commit"
  }
  node scripts/testbed/vision-try-on-acceptance.mjs --mode full --guest-input $GuestInputPath --handoff $HandoffPath --out $OutPath
  if ($LASTEXITCODE -ne 0) { throw "vision try-on acceptance failed" }
}

function Get-TestbedKioskPassword([object]$GuestInput) {
  if (-not [string]::IsNullOrWhiteSpace([string]$GuestInput.interactiveUserPassword)) {
    return [string]$GuestInput.interactiveUserPassword
  }
  $winlogon = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -ErrorAction Stop
  if ([string]$winlogon.DefaultUserName -ine "VEMKiosk" -or [string]$winlogon.DefaultDomainName -ne ".") {
    throw "startup owner acceptance requires the baseline VEMKiosk AutoAdminLogon identity"
  }
  if ([string]::IsNullOrWhiteSpace([string]$winlogon.DefaultPassword)) {
    throw "startup owner acceptance requires the baseline VEMKiosk AutoAdminLogon password"
  }
  return [string]$winlogon.DefaultPassword
}

function Clear-TestbedLegacyRuntimeOwnersForStartup {
  foreach ($scope in @("Process", "User", "Machine")) {
    [Environment]::SetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", $null, $scope)
  }
  Remove-Item -LiteralPath "Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS" -ErrorAction SilentlyContinue
  foreach ($taskSpec in @(
    @{ Name = "VEMLocalTestbedInstalledRuntime"; Path = "\" },
    @{ Name = "StartVisionServer"; Path = "\VEM\" }
  )) {
    Stop-ScheduledTask -TaskName $taskSpec.Name -TaskPath $taskSpec.Path -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskSpec.Name -TaskPath $taskSpec.Path -Confirm:$false -ErrorAction SilentlyContinue
  }
  Stop-Service -Name "VemVendingDaemon" -Force -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName "VEMMachineUI" -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName "VEMVisionRuntime" -ErrorAction SilentlyContinue
  Get-Process vending-daemon, machine, vending-vision -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue |
    Where-Object { [string]$_.CommandLine -match '--remote-debugging-port=9222\b' } |
    ForEach-Object { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue }
}

function Restart-TestbedDaemonServiceOwner([string]$DaemonPath) {
  $canonicalDaemonPath = [IO.Path]::GetFullPath($DaemonPath)
  $service = Get-Service -Name "VemVendingDaemon" -ErrorAction Stop
  if ($service.Status -ne "Stopped") {
    try {
      Stop-Service -Name "VemVendingDaemon" -Force -ErrorAction Stop
      $service.WaitForStatus("Stopped", [TimeSpan]::FromSeconds(15))
    } catch {
      Get-CimInstance Win32_Process -Filter "Name = 'vending-daemon.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $canonicalDaemonPath) } |
        ForEach-Object { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue }
    }
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    $service = Get-Service -Name "VemVendingDaemon" -ErrorAction Stop
    if ($service.Status -eq "Stopped") { break }
    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)
  $service = Get-Service -Name "VemVendingDaemon" -ErrorAction Stop
  if ($service.Status -ne "Stopped") {
    throw "VemVendingDaemon did not stop before service-owner restart; status=$($service.Status)"
  }
  Start-Service -Name "VemVendingDaemon" -ErrorAction Stop
}

function Get-ResolvedVisionMainCommit([string]$CacheRoot) {
  $indexPath = Join-Path $CacheRoot "resolved-vision-main-commit.txt"
  if (-not (Test-Path -LiteralPath $indexPath -PathType Leaf)) {
    $cached = @(Get-ChildItem -LiteralPath $CacheRoot -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^[a-f0-9]{40}$' } |
      Sort-Object LastWriteTimeUtc -Descending |
      Select-Object -First 1)
    if ($cached.Count -eq 1) { return [string]$cached[0].Name }
    return ""
  }
  try {
    $candidate = (Get-Content -Raw -LiteralPath $indexPath).Trim()
  } catch {
    Remove-Item -LiteralPath $indexPath -Force -ErrorAction SilentlyContinue
    return ""
  }
  if ($candidate -match '^[a-f0-9]{40}$') {
    return $candidate
  }
  Remove-Item -LiteralPath $indexPath -Force -ErrorAction SilentlyContinue
  return ""
}

function Set-ResolvedVisionMainCommit([string]$CacheRoot, [string]$Commit) {
  $indexPath = Join-Path $CacheRoot "resolved-vision-main-commit.txt"
  New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
  Set-Content -LiteralPath $indexPath -Value $Commit -NoNewline -Encoding utf8
}

function Install-TestbedStartupVisionArtifact {
  $visionModulePath = Join-Path $PSScriptRoot "..\windows\vision-main-artifacts.psm1"
  Import-Module $visionModulePath -Force
  $visionCacheRoot = Join-Path $cacheRoot "vision-main"
  $visionSiteConfigurationSourcePath = Join-Path $handoffRoot "vision-recorded-site-config.json"
  Write-RecordedVisionSiteConfiguration $visionSiteConfigurationSourcePath
  $visionCommit = Get-ResolvedVisionMainCommit -CacheRoot $visionCacheRoot
  if ([string]::IsNullOrWhiteSpace($visionCommit)) {
    $visionCache = Get-VisionMainArtifactCache -CacheRoot $visionCacheRoot
    Set-ResolvedVisionMainCommit -CacheRoot $visionCacheRoot -Commit ([string]$visionCache.commit)
  } else {
    try {
      $visionCache = Get-VisionMainArtifactCache -CacheRoot $visionCacheRoot -CommitSha $visionCommit
    } catch {
      Remove-Item -LiteralPath (Join-Path $visionCacheRoot "resolved-vision-main-commit.txt") -Force -ErrorAction SilentlyContinue
      $visionCache = Get-VisionMainArtifactCache -CacheRoot $visionCacheRoot
      Set-ResolvedVisionMainCommit -CacheRoot $visionCacheRoot -Commit ([string]$visionCache.commit)
    }
  }
  $visionInstallation = Install-VisionMainArtifact `
    -RuntimeArchive ([string]$visionCache.runtimeArchive) `
    -FixtureArchive ([string]$visionCache.fixtureArchive) `
    -Commit ([string]$visionCache.commit) `
    -SiteConfigurationPath $visionSiteConfigurationSourcePath `
    -SkipRuntimeOwnerTask
  if ([string]$visionInstallation.commit -ne [string]$visionCache.commit) {
    throw "installed startup Vision commit does not match the resolved cached commit"
  }
  return $visionInstallation
}

function Convert-TestbedStartupProbeToReadiness(
  [object]$Probe,
  [object]$OwnerManifest,
  [object]$MachineEvidence,
  [object]$VisionEvidence,
  [string]$Route
) {
  $sessionId = [int]$MachineEvidence.sessionId
  return [ordered]@{
    schemaVersion = "vem-installed-runtime-startup-acceptance/v1"
    ok = $true
    mode = $Mode
    ownerManifest = $OwnerManifest
    observation = [ordered]@{
      source = "windows_service_task_process_session_probe"
      daemon = [ordered]@{
        status = [string]$Probe.service.state
        processCount = @($Probe.processes.daemon).Count
        ready = [bool]$Probe.daemon.readiness.ok
      }
      kioskSession = [ordered]@{
        user = "VEMKiosk"
        sessionId = $sessionId
        active = $true
      }
      machineUi = [ordered]@{
        taskState = [string](@($Probe.tasks | Where-Object { [string]$_.name -eq "VEMMachineUI" })[0].state)
        processCount = @($Probe.processes.machineUi).Count
        sessionId = $sessionId
        route = $Route
      }
      vision = [ordered]@{
        taskState = [string](@($Probe.tasks | Where-Object { [string]$_.name -eq "VEMVisionRuntime" })[0].state)
        processCount = @($Probe.processes.vision).Count
        sessionId = [int]$VisionEvidence.sessionId
      }
    }
    modeEvidence = Get-TestbedStartupModeEvidence $sessionId
  }
}

function New-TestbedCanonicalUtcTimestamp {
  return [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
}

function Convert-TestbedCimDateTimeToUtc($Value) {
  if ($Value -is [DateTime]) {
    return $Value.ToUniversalTime()
  }
  return [Management.ManagementDateTimeConverter]::ToDateTime([string]$Value).ToUniversalTime()
}

function Get-TestbedStartupModeEvidence([int]$SessionId) {
  if ($Mode -ne "full") {
    return [ordered]@{
      mode = $Mode
      source = "installed_owner_stop_start"
      ownerRestartMarker = "owner-restart:${Commit}:$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
    }
  }
  $os = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  $bootTime = Convert-TestbedCimDateTimeToUtc $os.LastBootUpTime
  $observedAt = New-TestbedCanonicalUtcTimestamp
  return [ordered]@{
    mode = $Mode
    source = "windows_reboot_logon_probe"
    boot = [ordered]@{
      marker = "boot:${env:COMPUTERNAME}:$($bootTime.ToString("yyyyMMddHHmmssfff'Z'", [Globalization.CultureInfo]::InvariantCulture))"
      observedAt = $observedAt
    }
    logon = [ordered]@{
      marker = "logon:VEMKiosk:${SessionId}:$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())"
      user = "VEMKiosk"
      sessionId = $SessionId
      observedAt = $observedAt
    }
  }
}

function Start-TestbedInstalledRuntimeOwners {
  param(
    [object]$GuestInput,
    [string]$DaemonPath,
    [string]$MachinePath,
    [switch]$ClaimBeforeInteractiveOwners
  )
  Write-TestbedPhase "install-startup-vision"
  Install-TestbedStartupVisionArtifact | Out-Null
  Write-TestbedPhase "install-runtime-owners"
  Clear-TestbedLegacyRuntimeOwnersForStartup
  [Environment]::SetEnvironmentVariable("VEM_TESTBED_SERIAL_DISCOVERY_FILE", $env:VEM_TESTBED_SERIAL_DISCOVERY_FILE, "Machine")
  $ownerManifestPath = Join-Path $runtimeRoot "runtime-owners\owner-manifest.json"
  $ownerManifest = & (Join-Path $repoRoot "scripts\windows\install-vem-runtime-owners.ps1") `
    -RuntimeDirectory $deploymentRoot `
    -DaemonDataDirectory $daemonDataRoot `
    -VisionAppDirectory "C:\VEM\vision\app" `
    -VisionDataDirectory "C:\ProgramData\VEM\vision" `
    -KioskPassword (Get-TestbedKioskPassword $GuestInput) `
    -MachineUiWebViewDebugPort 9222 `
    -OwnerManifestPath $ownerManifestPath | ConvertFrom-Json

  Remove-Item -LiteralPath (Join-Path $daemonDataRoot "daemon-ready.json") -Force -ErrorAction SilentlyContinue
  Write-TestbedPhase "start-installed-daemon-owner"
  Start-Service -Name "VemVendingDaemon" -ErrorAction Stop
  $runtimeReady = Wait-RuntimeReady
  $ownerClaim = $null
  if ($ClaimBeforeInteractiveOwners) {
    Write-TestbedPhase "claim-installed-runtime-owner"
    $ownerClaim = Invoke-Claim $GuestInput
    if (-not [bool]$ownerClaim.restartRequested) { throw "clean Runtime Bootstrap claim did not request the required daemon owner restart" }
    Write-TestbedPhase "restart-claimed-installed-runtime-owner"
    Restart-TestbedDaemonServiceOwner $DaemonPath
    $runtimeReady = Wait-RuntimeReady
  }
  Write-TestbedPhase "bind-installed-owner-hardware"
  Initialize-TestbedHardwareBindings
  $runtimeReady = Wait-RuntimeReady
  Write-TestbedPhase "start-installed-interactive-owners"
  Start-ScheduledTask -TaskName "VEMVisionRuntime" -ErrorAction Stop
  Start-ScheduledTask -TaskName "VEMMachineUI" -ErrorAction Stop
  Write-TestbedPhase "admit-installed-tauri-catalog"
  Invoke-InstalledTauriRouteAdmission "http://127.0.0.1:9222"
  $target = Wait-InstalledTauriRoute "#/catalog"
  $route = ([uri][string]$target.url).Fragment
  $machineEvidence = Wait-CanonicalProcessEvidence "machine.exe" $MachinePath 30
  $visionEvidence = Wait-CanonicalProcessEvidence "vending-vision.exe" "C:\VEM\vision\app\vending-vision.exe" 30
  $probeRaw = & (Join-Path $repoRoot "scripts\windows\probe-vem-runtime.ps1") -RequireHealthy
  $probe = $probeRaw | ConvertFrom-Json
  $readiness = Convert-TestbedStartupProbeToReadiness $probe $ownerManifest $machineEvidence $visionEvidence $route
  return [ordered]@{
    readiness = $readiness
    ownerManifest = $ownerManifest
    probe = $probe
    claim = $ownerClaim
    runtimeReady = $runtimeReady
    machineEvidence = $machineEvidence
    visionEvidence = $visionEvidence
    target = $target
  }
}

function Stop-TestbedCanonicalVision([string]$AppDirectory, [string]$ConfigurationPath) {
  $visionModule = Import-Module (Join-Path $PSScriptRoot "..\windows\vision-main-artifacts.psm1") -Force -PassThru
  try {
    & $visionModule {
      param($CanonicalAppDirectory, $CanonicalConfigurationPath)
      Stop-VisionMainTask -AppDirectory $CanonicalAppDirectory -ConfigurationPath $CanonicalConfigurationPath
    } $AppDirectory $ConfigurationPath
  } catch {
    if ($_.FullyQualifiedErrorId -notlike "NoProcessFoundForGivenId,*StopProcessCommand") { throw }
  }
}

function Get-TestbedCanonicalVisionProcesses([string]$AppDirectory, [string]$ConfigurationPath) {
  $canonicalVisionExecutablePath = [IO.Path]::GetFullPath((Join-Path $AppDirectory "vending-vision.exe"))
  $canonicalVisionConfigurationPath = [IO.Path]::GetFullPath($ConfigurationPath)
  $visionModule = Import-Module (Join-Path $PSScriptRoot "..\windows\vision-main-artifacts.psm1") -Force -PassThru
  $canonicalVisionProcesses = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ExecutablePath -and
        [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $canonicalVisionExecutablePath
      }
  )
  $managedCanonicalVisionProcesses = @(
    $canonicalVisionProcesses | Where-Object {
      $_.CommandLine -and
      (& $visionModule {
        param($CommandLine, $CanonicalConfigurationPath)
        Test-VisionMainCanonicalConfigurationCommandLine $CommandLine $CanonicalConfigurationPath
      } $_.CommandLine $canonicalVisionConfigurationPath)
    }
  )
  $unknownCanonicalVisionProcesses = @(
    $canonicalVisionProcesses | Where-Object {
      [int]$_.ProcessId -notin @($managedCanonicalVisionProcesses | ForEach-Object { [int]$_.ProcessId })
    }
  )
  return [pscustomobject]@{
    managed = $managedCanonicalVisionProcesses
    unknown = $unknownCanonicalVisionProcesses
  }
}

function Assert-TestbedNoUnknownCanonicalVisionProcesses([object]$VisionProcesses) {
  $unknownCanonicalVisionProcesses = @($VisionProcesses.unknown)
  if ($unknownCanonicalVisionProcesses.Count -gt 0) {
    throw "Vision bootstrap found unknown canonical executable processes: $($unknownCanonicalVisionProcesses | Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress)"
  }
}

function Clear-TestbedVisionProcesses([object]$GuestInput) {
  $visionMockControlPort = [int]$GuestInput.hostControlPlane.visionMockControlPort
  $visionPorts = @(7892, $visionMockControlPort) | Select-Object -Unique
  $canonicalVisionAppDirectory = "C:\VEM\vision\app"
  $canonicalVisionConfigPath = "C:\ProgramData\VEM\vision\site.json"
  $canonicalVisionProcesses = Get-TestbedCanonicalVisionProcesses $canonicalVisionAppDirectory $canonicalVisionConfigPath
  Assert-TestbedNoUnknownCanonicalVisionProcesses $canonicalVisionProcesses
  $managedCanonicalVisionProcesses = @($canonicalVisionProcesses.managed)
  if ($managedCanonicalVisionProcesses.Count -gt 0) {
    Stop-TestbedCanonicalVision $canonicalVisionAppDirectory $canonicalVisionConfigPath
  }
  $canonicalVisionDeadline = (Get-Date).AddSeconds(10)
  do {
    $canonicalVisionProcesses = Get-TestbedCanonicalVisionProcesses $canonicalVisionAppDirectory $canonicalVisionConfigPath
    Assert-TestbedNoUnknownCanonicalVisionProcesses $canonicalVisionProcesses
    $remainingCanonicalVisionProcesses = @($canonicalVisionProcesses.managed)
    foreach ($process in $remainingCanonicalVisionProcesses) {
      Stop-Process -Id ([int]$process.ProcessId) -Force -ErrorAction SilentlyContinue
    }
    if ($remainingCanonicalVisionProcesses.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $canonicalVisionDeadline)
  $canonicalVisionProcesses = Get-TestbedCanonicalVisionProcesses $canonicalVisionAppDirectory $canonicalVisionConfigPath
  Assert-TestbedNoUnknownCanonicalVisionProcesses $canonicalVisionProcesses
  $remainingCanonicalVisionProcesses = @($canonicalVisionProcesses.managed)
  if ($remainingCanonicalVisionProcesses.Count -ne 0) {
    throw "Vision bootstrap canonical Vision process cleanup did not complete: $($remainingCanonicalVisionProcesses | Select-Object ProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress)"
  }
  $visionListeners = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $visionPorts -contains [int]$_.LocalPort } |
      Select-Object LocalAddress, LocalPort, OwningProcess
  )
  $ownerProcesses = @{}
  foreach ($ownerId in @($visionListeners | Select-Object -ExpandProperty OwningProcess -Unique)) {
    $ownerProcesses[[int]$ownerId] = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction SilentlyContinue
  }
  $visionMockOwnerIds = @(
    $visionListeners |
      Where-Object { [int]$_.LocalPort -eq $visionMockControlPort } |
      ForEach-Object { [int]$_.OwningProcess } |
      Where-Object {
        $processWmi = $ownerProcesses[$_]
        $null -ne $processWmi -and
          [string]$processWmi.ExecutablePath -match '\\node(?:\.exe)?$' -and
          [string]$processWmi.CommandLine -match 'apps[\\/]vision-mock[\\/]src[\\/]server\.ts'
      } |
      Select-Object -Unique
  )
  $unknownVisionListeners = @(
    $visionListeners | Where-Object {
      $ownerId = [int]$_.OwningProcess
      $visionMockOwnerIds -notcontains $ownerId
    }
  )
  if ($unknownVisionListeners.Count -gt 0) {
    throw "Vision bootstrap found unknown listener owners: $($unknownVisionListeners | ConvertTo-Json -Compress)"
  }
  foreach ($ownerId in $visionMockOwnerIds) {
    Stop-Process -Id $ownerId -Force -ErrorAction SilentlyContinue
  }
  $visionPortDeadline = (Get-Date).AddSeconds(10)
  while (
    (Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $visionPorts -contains $_.LocalPort }) -and
    (Get-Date) -lt $visionPortDeadline
  ) { Start-Sleep -Milliseconds 100 }
  $remainingListeners = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { $visionPorts -contains $_.LocalPort } |
      Select-Object LocalAddress, LocalPort, OwningProcess
  )
  if ($remainingListeners.Count -gt 0) {
    throw "Vision bootstrap cleanup did not release ports $($visionPorts -join ', '): $($remainingListeners | ConvertTo-Json -Compress)"
  }
}

if ($Mode -eq "clear_cache") {
  $removedUndeclaredCaches = Remove-UndeclaredCacheDirectories
  Clear-DeclaredCaches
  $clearCacheReportPath = Join-Path $handoffRoot "clear-cache-report.json"
  New-Item -ItemType Directory -Force -Path $handoffRoot | Out-Null
  $cacheObservation = Get-DeclaredCacheObservation
  Assert-ObservedCachesMatchAllowlist $cacheObservation
  [ordered]@{
    schemaVersion = "vem-local-testbed-clear-cache/v1"
    ok = $true
    mode = "clear_cache"
    cacheCleared = $true
    removedUndeclaredCaches = @($removedUndeclaredCaches)
    observedRetainedCaches = @($cacheObservation.observedRetainedCaches)
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $clearCacheReportPath -Encoding utf8
  Get-Content -Raw -LiteralPath $clearCacheReportPath | Write-Output
  exit 0
}

Require-Path $GuestInputPath
$guestInput = Get-Content -Raw -LiteralPath $GuestInputPath -Encoding UTF8 | ConvertFrom-Json
if ($guestInput.schemaVersion -ne "vem-local-testbed-guest-input/v1") { throw "invalid local testbed guest input" }
if ($Mode -in @("fast", "full")) {
  Clear-TestbedVisionProcesses $guestInput
}
Write-TestbedPhase "bootstrap"
$handoffPath = Join-Path $handoffRoot "installed-runtime-handoff.json"
$claim = $null
$commissioningSerialSession = $null
$isWarmFastRun = $Mode -eq "fast" -and (Test-Path -LiteralPath $handoffPath -PathType Leaf)
if ($isWarmFastRun) {
  Require-Path $handoffPath
  $existingHandoff = Get-Content -Raw -LiteralPath $handoffPath -Encoding UTF8 | ConvertFrom-Json
  if ($existingHandoff.schemaVersion -ne "vem-installed-runtime-handoff/v1" -or
    $existingHandoff.claim.status -ne "provisioned" -or
    $existingHandoff.claim.machineCode -ne $guestInput.machineCode) {
    throw "warm fast run requires the existing provisioned runtime handoff"
  }
  $claim = $existingHandoff.claim
  Require-Path (Join-Path $runtimeRoot "runtime-bootstrap.json")
  Write-TestbedPhase "warm-baseline-recovery"
} elseif ($Mode -eq "fast") {
  Write-TestbedPhase "cold-fast-bootstrap"
}

$machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
if (-not [string]::IsNullOrWhiteSpace($machinePath)) {
  $env:Path = "$machinePath;$env:Path"
}

New-Item -ItemType Directory -Force -Path $deploymentRoot, $daemonDataRoot, $handoffRoot | Out-Null
Clear-TestbedRunReports
$env:CARGO_TARGET_DIR = Join-Path $cacheRoot "target"
$env:SCCACHE_DIR = Join-Path $cacheRoot "sccache"
$env:TURBO_CACHE_DIR = Join-Path $cacheRoot "turbo"
$env:PNPM_STORE_PATH = Join-Path $cacheRoot "pnpm-store"
$env:PNPM_VIRTUAL_STORE_ROOT = Join-Path $cacheRoot "pnpm-virtual-store"
$env:CARGO_HOME = Join-Path $cacheRoot "cargo-home"
$env:CARGO_BUILD_JOBS = [string]([Math]::Max(2, [Math]::Min([Environment]::ProcessorCount, 16)))
$sccache = Get-TestbedSccache
Write-TestbedPhase "sccache-ready"
$env:RUSTC_WRAPPER = $sccache
$runtimeArtifactSourceDigest = Get-RuntimeArtifactSourceDigest
$runtimeArtifactManifestPath = Join-Path $env:CARGO_TARGET_DIR ".vem-runtime-artifacts-$runtimeArtifactSourceDigest.json"
$removedUndeclaredCaches = Remove-UndeclaredCacheDirectories
Write-TestbedPhase "cache-cleanup"
foreach ($path in $declaredCachePaths) { New-Item -ItemType Directory -Force -Path $path | Out-Null }
foreach ($pair in @{
  CARGO_TARGET_DIR = $env:CARGO_TARGET_DIR
  SCCACHE_DIR = $env:SCCACHE_DIR
  TURBO_CACHE_DIR = $env:TURBO_CACHE_DIR
  PNPM_STORE_PATH = $env:PNPM_STORE_PATH
  PNPM_VIRTUAL_STORE_ROOT = $env:PNPM_VIRTUAL_STORE_ROOT
  CARGO_HOME = $env:CARGO_HOME
}.GetEnumerator()) { Assert-DeclaredCachePath $pair.Value $pair.Key }
$pnpm = "C:\Program Files\nodejs\pnpm.cmd"
Require-Path $pnpm
$pnpmLockPath = Join-Path $repoRoot "pnpm-lock.yaml"
Require-Path $pnpmLockPath
$pnpmLockDigest = (Get-FileHash -LiteralPath $pnpmLockPath -Algorithm SHA256).Hash.ToLowerInvariant()
$pnpmVirtualStorePath = Join-Path $env:PNPM_VIRTUAL_STORE_ROOT $pnpmLockDigest
$pnpmFetchCompletePath = Join-Path $pnpmVirtualStorePath ".fetch-complete"
$pnpmWorkspaceMarker = Join-Path $repoRoot "node_modules\.vem-lock-hash"
Write-TestbedPhase "dependencies"
& $pnpm config set store-dir $env:PNPM_STORE_PATH --location global
if ($LASTEXITCODE -ne 0) { throw "pnpm store configuration failed" }
if ((& $pnpm config get store-dir).Trim() -ne $env:PNPM_STORE_PATH) { throw "pnpm store-dir did not resolve to D: cache" }
& $pnpm config set virtual-store-dir $pnpmVirtualStorePath --location global
if ($LASTEXITCODE -ne 0) { throw "pnpm virtual store configuration failed" }
if ((& $pnpm config get virtual-store-dir).Trim() -ne $pnpmVirtualStorePath) { throw "pnpm virtual-store-dir did not resolve to lock-keyed D: cache" }
if (-not (Test-Path -LiteralPath $pnpmFetchCompletePath -PathType Leaf)) {
  & $pnpm fetch --frozen-lockfile --trust-lockfile
  if ($LASTEXITCODE -ne 0) { throw "pnpm fetch failed" }
  Set-Content -LiteralPath $pnpmFetchCompletePath -Value $pnpmLockDigest -Encoding ascii
}
if (-not (Test-Path -LiteralPath $pnpmWorkspaceMarker -PathType Leaf) -or
  (Get-Content -Raw -LiteralPath $pnpmWorkspaceMarker).Trim() -ne $pnpmLockDigest) {
  & $pnpm install --frozen-lockfile --offline --trust-lockfile
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
  Set-Content -LiteralPath $pnpmWorkspaceMarker -Value $pnpmLockDigest -Encoding ascii
}
$daemonSource = Join-Path $env:CARGO_TARGET_DIR "release\vending-daemon.exe"
$machineSource = Join-Path $env:CARGO_TARGET_DIR "release\machine.exe"
$webViewLoaderSource = Join-Path $env:CARGO_TARGET_DIR "release\vem-WebView2Loader.dll"
$expectedRuntimeArtifactPaths = [ordered]@{
  daemon = $daemonSource
  machine = $machineSource
  webViewLoader = $webViewLoaderSource
}
$requirePass1RuntimeArtifacts = $Mode -eq "full" -and $Pass -eq 2
$reuseRuntimeArtifacts = $false
$runtimeArtifactReuseSource = $null
if (Test-Path -LiteralPath $runtimeArtifactManifestPath -PathType Leaf) {
  try {
    $candidateManifest = Get-Content -Raw -LiteralPath $runtimeArtifactManifestPath -Encoding utf8 | ConvertFrom-Json
    if ($candidateManifest.schemaVersion -ne "vem-runtime-artifacts/v1" -or
      [string]$candidateManifest.sourceDigest -ne $runtimeArtifactSourceDigest) {
      throw "runtime artifact manifest does not match the requested runtime source digest"
    }
    foreach ($artifactName in $expectedRuntimeArtifactPaths.Keys) {
      $artifact = $candidateManifest.artifacts.$artifactName
      $expectedPath = [string]$expectedRuntimeArtifactPaths[$artifactName]
      if ($null -eq $artifact -or [string]$artifact.path -ine $expectedPath) {
        throw "runtime artifact path mismatch: $artifactName"
      }
      Require-Path $expectedPath
      $actualDigest = (Get-FileHash -LiteralPath $expectedPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualDigest -ne [string]$artifact.sha256) {
        throw "runtime artifact digest mismatch: $artifactName"
      }
    }
    $runtimeArtifactManifest = $candidateManifest
    $reuseRuntimeArtifacts = $true
    $runtimeArtifactReuseSource = if ($requirePass1RuntimeArtifacts) { "pass_1" } else { "commit_cache" }
  } catch {
    if ($requirePass1RuntimeArtifacts) { throw }
  }
} elseif ($requirePass1RuntimeArtifacts) {
  throw "pass-1 runtime artifact manifest is missing"
}

if ($reuseRuntimeArtifacts) {
  Write-TestbedPhase $(if ($runtimeArtifactReuseSource -eq "pass_1") { "reuse-pass-1-runtime-artifacts" } else { "reuse-commit-runtime-artifacts" })
} else {
  & $pnpm turbo run build --filter @vem/shared --cache-dir $env:TURBO_CACHE_DIR
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $env:TURBO_CACHE_DIR)) { throw "Turbo cache was not created on D:" }
  $localRustSourceDigest = Get-LocalRustSourceDigest
  $localRustSourceMarker = Join-Path $env:CARGO_TARGET_DIR ".vem-local-rust-source.sha256"
  $cachedLocalRustSourceDigest = if (Test-Path -LiteralPath $localRustSourceMarker -PathType Leaf) {
    (Get-Content -Raw -LiteralPath $localRustSourceMarker).Trim()
  } else { "" }
  if ($cachedLocalRustSourceDigest -ne $localRustSourceDigest) {
    Write-TestbedPhase "clean-local-runtime-artifacts"
    cargo clean --release -p machine -p vending-daemon -p vending-core -p daemon-ipc-contracts
    if ($LASTEXITCODE -ne 0) { throw "local runtime artifact cleanup failed" }
    Remove-Item -LiteralPath $localRustSourceMarker -Force -ErrorAction SilentlyContinue
  }
  Write-TestbedPhase "machine-build"
  & $pnpm --filter machine exec tauri build --config src-tauri/tauri.windows.conf.json --no-bundle
  if ($LASTEXITCODE -ne 0) { throw "Machine Runtime Console build failed" }
  Write-TestbedPhase "daemon-build"
  cargo build -p vending-daemon --release
  if ($LASTEXITCODE -ne 0) { throw "vending daemon build failed" }
  Set-Content -LiteralPath $localRustSourceMarker -Value $localRustSourceDigest -Encoding ascii
  & $sccache --show-stats
  if ($LASTEXITCODE -ne 0) { throw "sccache statistics were unavailable" }
  $cargoMetadata = (& cargo metadata --format-version 1 --locked --offline | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0) { throw "Cargo metadata was unavailable after the Windows build" }
  $webViewPackages = @($cargoMetadata.packages | Where-Object { $_.name -eq "webview2-com-sys" })
  if ($webViewPackages.Count -ne 1) { throw "expected exactly one resolved webview2-com-sys package" }
  $resolvedWebViewLoader = Join-Path (Split-Path -Parent ([string]$webViewPackages[0].manifest_path)) "x64\WebView2Loader.dll"
  Require-Path $resolvedWebViewLoader
  Copy-Item -LiteralPath $resolvedWebViewLoader -Destination $webViewLoaderSource -Force
  Require-Path $daemonSource
  Require-Path $machineSource
	  $runtimeArtifactManifest = [ordered]@{
	    schemaVersion = "vem-runtime-artifacts/v1"
	    commit = $Commit
	    sourceDigest = $runtimeArtifactSourceDigest
	    artifacts = [ordered]@{
      daemon = [ordered]@{ path = $daemonSource; sha256 = (Get-FileHash -LiteralPath $daemonSource -Algorithm SHA256).Hash.ToLowerInvariant() }
      machine = [ordered]@{ path = $machineSource; sha256 = (Get-FileHash -LiteralPath $machineSource -Algorithm SHA256).Hash.ToLowerInvariant() }
      webViewLoader = [ordered]@{ path = $webViewLoaderSource; sha256 = (Get-FileHash -LiteralPath $webViewLoaderSource -Algorithm SHA256).Hash.ToLowerInvariant() }
    }
  }
  $runtimeArtifactManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $runtimeArtifactManifestPath -Encoding utf8
}
Require-Path $daemonSource
Require-Path $machineSource
Require-Path $webViewLoaderSource
$runtimeArtifactEvidence = [ordered]@{
  commit = $Commit
  sourceDigest = $runtimeArtifactSourceDigest
  reusedFromPass1 = $runtimeArtifactReuseSource -eq "pass_1"
  reusedFromCommitCache = $runtimeArtifactReuseSource -eq "commit_cache"
  artifacts = [ordered]@{}
}
foreach ($artifactName in @("daemon", "machine", "webViewLoader")) {
  $artifact = $runtimeArtifactManifest.artifacts.$artifactName
  if ($null -eq $artifact) { throw "runtime artifact manifest is missing: $artifactName" }
  $runtimeArtifactEvidence.artifacts[$artifactName] = [ordered]@{ sha256 = [string]$artifact.sha256 }
}
$guestInput.workflowIdentity | Add-Member -NotePropertyName runtimeArtifacts -NotePropertyValue $runtimeArtifactEvidence -Force
$guestInput | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $GuestInputPath -Encoding utf8
Write-TestbedPhase "deploy-runtime"
$daemonPath = Join-Path $deploymentRoot "vending-daemon.exe"
$machinePath = Join-Path $deploymentRoot "machine.exe"
Clear-TestbedLegacyRuntimeOwnersForStartup
Get-Process vending-daemon -ErrorAction SilentlyContinue | Stop-Process -Force
Get-Process machine, vending-vision -ErrorAction SilentlyContinue | Stop-Process -Force
$processStopDeadline = (Get-Date).AddSeconds(10)
while (
  (Get-Process vending-daemon, machine, vending-vision -ErrorAction SilentlyContinue) -and
  (Get-Date) -lt $processStopDeadline
) { Start-Sleep -Milliseconds 100 }
if (Get-Process vending-daemon, machine, vending-vision -ErrorAction SilentlyContinue) {
  throw "installed runtime processes did not stop before deployment"
}
Copy-Item -LiteralPath $daemonSource -Destination $daemonPath -Force
Copy-Item -LiteralPath $machineSource -Destination $machinePath -Force
Copy-Item -LiteralPath $webViewLoaderSource -Destination (Join-Path $deploymentRoot "WebView2Loader.dll") -Force
Write-TestbedPhase "start-simulated-hardware"
$commissioningSerialSession = Start-TestbedCommissioningSerialSession $guestInput
Write-TestbedSerialDiscoveryAdapter
if ($Mode -eq "full" -or -not $isWarmFastRun) {
  $guestInput.runtimeBootstrap | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runtimeRoot "runtime-bootstrap.json") -Encoding utf8
}
$startupState = Start-TestbedInstalledRuntimeOwners `
  -GuestInput $guestInput `
  -DaemonPath $daemonPath `
  -MachinePath $machinePath `
  -ClaimBeforeInteractiveOwners:($Mode -eq "full" -or -not $isWarmFastRun)
if ($null -ne $startupState.claim) {
  $claim = $startupState.claim
}
Stop-TestbedScannerBindingProbe $guestInput $commissioningSerialSession
Write-TestbedPhase "wait-bound-runtime-ready"
$runtimeReady = Wait-RuntimeReady
$target = $startupState.target
$machineEvidence = $startupState.machineEvidence
$expectedInteractiveUser = ([string]$guestInput.interactiveUser -split '\\')[-1]
$observedInteractiveUser = ([string]$machineEvidence.principal -split '\\')[-1]
if ($observedInteractiveUser -ine $expectedInteractiveUser) {
  throw "installed Tauri process is not owned by the baseline interactive user"
}
$cdpBinding = Get-CdpProcessBinding $machineEvidence.processId
$smokeOutPath = Join-Path $handoffRoot "installed-runtime-smoke.json"
[string]$fastRouteOutPath = Join-Path $handoffRoot "fast-route-stress-sale.json"
[string]$ipcRecoveryOutPath = Join-Path $handoffRoot "installed-ipc-recovery.json"
[string]$fulfillmentFailureOutPath = Join-Path $handoffRoot "serial-fulfillment-error.json"
[string]$scannerPaymentCodeOutPath = Join-Path $handoffRoot "scanner-payment-code.json"
[string]$delayedPickupOutPath = Join-Path $handoffRoot "delayed-pickup-native-audio.json"
[string]$visionTryOnOutPath = Join-Path $handoffRoot "vision-try-on-acceptance.json"
[string]$workflowSummaryOutPath = Join-Path $handoffRoot "full-workflow-tracks.json"
[ordered]@{
  schemaVersion = "vem-installed-runtime-handoff/v1"
  machineCode = [string]$guestInput.machineCode
  claim = [ordered]@{ status = [string]$claim.status; machineCode = [string]$claim.machineCode }
  commissioningSerialSession = $commissioningSerialSession
  startupOwnerReadiness = $startupState.readiness
  daemon = [ordered]@{
    executablePath = $daemonPath
    processId = [int]$startupState.probe.processes.daemon[0].id
    console = $false
    dataDirectory = $daemonDataRoot
    workingDirectory = $deploymentRoot
    service = [ordered]@{ name = "VemVendingDaemon"; status = [string]$startupState.probe.service.state }
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

Write-TestbedPhase "installed-smoke"
node scripts/testbed/installed-runtime-smoke.mjs --mode $Mode --evidence $handoffPath --out $smokeOutPath
if ($LASTEXITCODE -ne 0) { throw "installed production runtime smoke failed" }
if ($Mode -eq "full") {
  Write-RecordedVisionSiteConfiguration (Join-Path $handoffRoot "vision-recorded-site-config.json")
}
if ($Mode -eq "full") {
  $cacheObservation = Get-DeclaredCacheObservation
  Assert-ObservedCachesMatchAllowlist $cacheObservation
  Update-WorkflowIdentityCacheObservation `
    -Path $GuestInputPath `
    -ObservedRetainedCaches $cacheObservation.observedRetainedCaches `
    -RemovedUndeclaredCaches $removedUndeclaredCaches
}
$workflowFailure = $null
$bundleFailure = $null
try {
  Write-TestbedPhase "acceptance-tracks"
  $focusArguments = @()
  foreach ($name in $Focus) {
    if ([string]::IsNullOrWhiteSpace($name)) { throw "--focus requires a business check set name" }
    $focusArguments += @("--focus", $name)
  }
  node scripts/testbed/full-workflow-orchestrator.mjs --mode $Mode --commit $Commit @focusArguments --guest-input $GuestInputPath --handoff $handoffPath --out $workflowSummaryOutPath
  if ($LASTEXITCODE -ne 0) { $workflowFailure = "local testbed workflow aggregate failed" }
} catch {
  $workflowFailure = "local testbed workflow aggregate command failed: $($_.Exception.Message)"
}

if ($Mode -ne "clear_cache") {
  $manifestPath = Join-Path $handoffRoot "full-workflow-evidence-manifest.json"
  if (Test-Path -LiteralPath $manifestPath) {
    try {
      New-BoundedEvidenceBundle `
        -ManifestPath $manifestPath `
        -BundleRoot (Join-Path $handoffRoot "full-workflow-evidence-bundle")
    } catch {
      $bundleFailure = "compact evidence bundle failed: $($_.Exception.Message)"
    }
  }
}
if ($bundleFailure -ne $null) {
  if ($workflowFailure -ne $null) {
    throw "${workflowFailure}; ${bundleFailure}"
  } else {
    throw $bundleFailure
  }
}
if ($workflowFailure -ne $null) {
  throw $workflowFailure
}
