param(
  [Parameter(Mandatory = $true)][string]$GuestInputPath,
  [Parameter(Mandatory = $true)][string]$HandoffPath,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [Parameter(Mandatory = $true)][string]$FixtureKey,
  [string]$RuntimeRoot = "C:\ProgramData\VEM\runtime\testbed"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Require-AbsoluteLeaf([string]$Path, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathFullyQualified($Path)) {
    throw "$Label is required as an absolute path"
  }
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing" }
}

function Get-ProvisionedVisionCoreArtifact([object]$GuestInput) {
  $inputsProperty = $GuestInput.PSObject.Properties["visionCore"]
  if ($null -eq $inputsProperty) { throw "guest input Vision core artifact is missing" }
  $inputs = $inputsProperty.Value
  if ($null -eq $inputs -or [string]$inputs.schemaVersion -ne "vem-local-testbed-vision-core-input/v1") {
    throw "guest input Vision core artifact is invalid"
  }
  $identity = $inputs.identity
  if ($null -eq $identity -or [string]$identity.sha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw "guest input Vision core identity is invalid"
  }
  $expectedCacheRoot = "D:\runtime-cache\v1\acceptance-inputs"
  $expectedRoot = Join-Path $expectedCacheRoot "vision-core\$([string]$identity.sha256)"
  if ([string]$inputs.inputRoot -cne $expectedRoot) { throw "guest input Vision core root is not canonical" }
  $runtimeArchive = [string]$inputs.runtimeArchive
  $fixtureArchive = [string]$inputs.fixtureArchive
  if ($runtimeArchive -cne (Join-Path $expectedCacheRoot "files\$([string]$identity.runtimeArchive.sha256)\vision-runtime.zip") -or
    $fixtureArchive -cne (Join-Path $expectedCacheRoot "files\$([string]$identity.recordedFixtureArchive.sha256)\recorded-fixtures.zip")) {
    throw "guest input Vision core archive paths are not canonical"
  }
  $runtimeIdentity = $identity.runtimeArchive
  $fixtureIdentity = $identity.recordedFixtureArchive
  foreach ($item in @(
    @{ path = $runtimeArchive; identity = $runtimeIdentity; label = "provisioned Vision runtime archive" },
    @{ path = $fixtureArchive; identity = $fixtureIdentity; label = "provisioned recorded fixture archive" }
  )) {
    Require-AbsoluteLeaf ([string]$item.path) ([string]$item.label)
    if ([string]$item.identity.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
      [long]$item.identity.byteSize -le 0 -or
      [string]$item.identity.sourceCommit -cnotmatch '^[a-f0-9]{40}$') {
      throw "$($item.label) identity is invalid"
    }
    $actual = (Get-FileHash -LiteralPath ([string]$item.path) -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -cne [string]$item.identity.sha256 -or (Get-Item -LiteralPath ([string]$item.path)).Length -ne [long]$item.identity.byteSize) {
      throw "$($item.label) identity is invalid"
    }
  }
  $commit = [string]$runtimeIdentity.sourceCommit
  if ([string]$fixtureIdentity.sourceCommit -cne $commit) { throw "provisioned Vision fixture source commit is invalid" }
  return [ordered]@{
    runtimeArchive = $runtimeArchive
    fixtureArchive = $fixtureArchive
    commit = $commit
    identity = $identity
  }
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
    cameras = @{
      top = @{
        source = "recorded_video"
        role = "presence"
        video_path = "recorded-video/top.mp4"
        loop = $true
      }
      front = @{
        source = "recorded_video"
        role = "profile_fast_try_on"
        video_path = "recorded-video/front.mp4"
        loop = $true
      }
    }
  } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $Path -Encoding utf8
}

function Rebuild-ProvisionedVisionCoreDelivery([object]$VisionCore) {
  $candidateDelivery = Join-Path ([IO.Path]::GetDirectoryName([string]$VisionCore.runtimeArchive)) "installable-main"
  if (Test-Path -LiteralPath $candidateDelivery) {
    Remove-Item -LiteralPath $candidateDelivery -Recurse -Force -ErrorAction Stop
  }
  Convert-VisionCandidateToMainDelivery `
    -CandidateArchive ([string]$VisionCore.runtimeArchive) `
    -FixtureArchive ([string]$VisionCore.fixtureArchive) `
    -Commit ([string]$VisionCore.commit) `
    -Destination $candidateDelivery | Out-Null
  return Assert-VisionCachedArtifacts $candidateDelivery ([string]$VisionCore.commit)
}

function Get-ManagedVisionProcessIds() {
  $canonicalExecutablePath = [IO.Path]::GetFullPath("C:\VEM\vision\app\vending-vision.exe")
  $canonicalConfigPath = [IO.Path]::GetFullPath("C:\ProgramData\VEM\vision\site.json")
  return @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ExecutablePath -and $_.CommandLine -and
        [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $canonicalExecutablePath -and
        ([string]$_.CommandLine).Replace('"', '').ToLowerInvariant().Contains('--config') -and
        ([string]$_.CommandLine).Replace('"', '').ToLowerInvariant().Contains($canonicalConfigPath.ToLowerInvariant())
      } |
      ForEach-Object { [int]$_.ProcessId }
  )
}

function Get-ManagedVisionTasks() {
  return @(Get-ScheduledTask -ErrorAction SilentlyContinue |
    Where-Object { [string]$_.TaskName -in @("VEMVisionRuntime", "StartVisionServer") })
}

function Stop-ManagedVision() {
  foreach ($task in @(Get-ManagedVisionTasks)) {
    if ([string]$task.State -eq "Running") { Stop-ScheduledTask -InputObject $task -ErrorAction SilentlyContinue }
  }
  foreach ($processId in @(Get-ManagedVisionProcessIds)) {
    if ($null -eq $processId -or [int]$processId -le 0) { continue }
    try { & taskkill.exe /PID ([int]$processId) /T /F *> $null } catch { }
    $global:LASTEXITCODE = 0
    Stop-Process -Id ([int]$processId) -Force -ErrorAction SilentlyContinue
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  do {
    if (@(Get-ManagedVisionProcessIds).Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Vision test isolation: canonical Vision process did not stop"
}

function Wait-ForVisionPortRebind([int]$TimeoutSeconds = 30) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastError = $null
  do {
    $listener = $null
    try {
      $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 7892)
      $listener.Start()
      return
    } catch {
      $lastError = $_
      Start-Sleep -Milliseconds 250
    } finally {
      if ($null -ne $listener) { $listener.Stop() }
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Vision test isolation: port 7892 could not be rebound within $TimeoutSeconds seconds: $($lastError.Exception.Message)"
}

function Get-DefaultManagedVisionDiagnostic() {
  $sitePath = "C:\ProgramData\VEM\vision\site.json"
  $task = Get-ScheduledTask -TaskName "VEMVisionRuntime" -TaskPath "\" -ErrorAction SilentlyContinue
  $action = if ($null -eq $task) { $null } else { @($task.Actions | Select-Object -First 1 | ForEach-Object {
    [ordered]@{ execute = [string]$_.Execute; arguments = [string]$_.Arguments; workingDirectory = [string]$_.WorkingDirectory }
  }) }
  $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq [IO.Path]::GetFullPath("C:\VEM\vision\app\vending-vision.exe")
  } | ForEach-Object {
    [ordered]@{ processId = [int]$_.ProcessId; parentProcessId = [int]$_.ParentProcessId; commandLine = [string]$_.CommandLine }
  })
  $listener = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 7892 -State Listen -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, OwningProcess)
  return [ordered]@{
    processId = @($processes | ForEach-Object { $_.processId })
    task = if ($null -eq $task) { $null } else { [ordered]@{ state = [string]$task.State; name = [string]$task.TaskName; path = [string]$task.TaskPath } }
    action = $action
    siteConfigurationSha256 = if (Test-Path -LiteralPath $sitePath -PathType Leaf) { (Get-FileHash -LiteralPath $sitePath -Algorithm SHA256).Hash.ToLowerInvariant() } else { $null }
    listener = $listener
  }
}

function Start-DefaultManagedVision() {
  $task = Get-ScheduledTask -TaskName "VEMVisionRuntime" -TaskPath "\" -ErrorAction Stop
  if ([string]$task.State -eq "Running") { Stop-ScheduledTask -InputObject $task -ErrorAction Stop }
  Start-ScheduledTask -TaskName "VEMVisionRuntime" -TaskPath "\" -ErrorAction Stop
}

function Wait-ForDefaultManagedVisionReady([string]$FixtureRoot, [int]$TimeoutSeconds = 60) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $childExitDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $hasCanonicalChild = @(Get-ManagedVisionProcessIds).Count -gt 0
    $hasListener = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 7892 -State Listen -ErrorAction SilentlyContinue).Count -gt 0
    if ($hasCanonicalChild -and $hasListener) {
      return Invoke-VisionMainProbe "C:\ProgramData\VEM\vision\site.json" $TimeoutSeconds $FixtureRoot "C:\VEM\vision\app"
    }
    if (-not $hasCanonicalChild -and -not $hasListener -and [DateTime]::UtcNow -ge $childExitDeadline) {
      throw "launcher child exited before Vision became ready: $(Get-DefaultManagedVisionDiagnostic | ConvertTo-Json -Compress -Depth 8)"
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "default VEMVisionRuntime did not become ready: $(Get-DefaultManagedVisionDiagnostic | ConvertTo-Json -Compress -Depth 8)"
}

$guestInput = Get-Content -Raw -LiteralPath $GuestInputPath -Encoding utf8 | ConvertFrom-Json -ErrorAction Stop
$visionCore = Get-ProvisionedVisionCoreArtifact $guestInput
$visionModulePath = Join-Path $PSScriptRoot "..\windows\vision-main-artifacts.psm1"
Import-Module $visionModulePath -Force
$primaryFailure = $null
$managedVisionTakenOver = $false
$fixtureRoot = "C:\ProgramData\VEM\vision\fixtures\$([string]$visionCore.commit)"
try {
  $visionSiteConfigurationSourcePath = Join-Path $RuntimeRoot "vision-recorded-site-config.json"
  $installable = Rebuild-ProvisionedVisionCoreDelivery $visionCore
  Write-RecordedVisionSiteConfiguration $visionSiteConfigurationSourcePath
  $managedVisionTakenOver = $true
  Stop-ManagedVision
  Wait-ForVisionPortRebind
  $visionInstallation = Install-VisionMainArtifact `
    -RuntimeArchive ([string]$installable.runtimeArchive) `
    -FixtureArchive ([string]$installable.fixtureArchive) `
    -Commit ([string]$visionCore.commit) `
    -SiteConfigurationPath $visionSiteConfigurationSourcePath `
    -SkipRuntimeOwnerTask
  if ([string]$visionInstallation.commit -ne [string]$visionCore.commit) {
    throw "installed Vision commit does not match the provisioned guest input"
  }
  Start-DefaultManagedVision
  Wait-ForDefaultManagedVisionReady $fixtureRoot | Out-Null
  node scripts/testbed/vision-try-on-acceptance.mjs --mode full --guest-input $GuestInputPath --handoff $HandoffPath --out $OutPath --fixture-key $FixtureKey
  if ($LASTEXITCODE -ne 0) { throw "vision try-on acceptance failed" }
} catch {
  $primaryFailure = $_
  throw
} finally {
  $cleanupFailures = @()
  if ($managedVisionTakenOver) {
    try { Stop-ManagedVision } catch { $cleanupFailures += $_ }
    try { Wait-ForVisionPortRebind } catch { $cleanupFailures += $_ }
    try { Start-DefaultManagedVision } catch { $cleanupFailures += $_ }
    try { Wait-ForDefaultManagedVisionReady $fixtureRoot | Out-Null } catch { $cleanupFailures += $_ }
  }
  if ($cleanupFailures.Count -gt 0) {
    $cleanupMessage = ($cleanupFailures | ForEach-Object { $_.Exception.Message }) -join "; "
    if ($null -ne $primaryFailure) {
      Write-Warning "Vision runtime restoration failed after the business failure: $cleanupMessage"
    } else {
      throw "Vision runtime restoration failed: $cleanupMessage"
    }
  }
}
