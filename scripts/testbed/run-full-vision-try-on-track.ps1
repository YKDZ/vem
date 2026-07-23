param(
  [Parameter(Mandatory = $true)][string]$GuestInputPath,
  [Parameter(Mandatory = $true)][string]$HandoffPath,
  [Parameter(Mandatory = $true)][string]$OutPath,
  [Parameter(Mandatory = $true)][string]$FixtureKey,
  [string]$CacheRoot = "D:\runtime-cache\v1",
  [string]$RuntimeRoot = "C:\ProgramData\VEM\runtime\testbed"
)

$ErrorActionPreference = "Stop"

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

function Get-ManagedVisionProcessIds() {
  $canonicalExecutablePath = [IO.Path]::GetFullPath("C:\VEM\vision\app\vending-vision.exe")
  $canonicalConfigPath = [IO.Path]::GetFullPath("C:\ProgramData\VEM\vision\site.json")
  return @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ExecutablePath -and
        $_.CommandLine -and
        [IO.Path]::GetFullPath([string]$_.ExecutablePath) -ieq $canonicalExecutablePath -and
        ([string]$_.CommandLine).Replace('"', '').ToLowerInvariant().Contains('--config') -and
        ([string]$_.CommandLine).Replace('"', '').ToLowerInvariant().Contains($canonicalConfigPath.ToLowerInvariant())
      } |
      ForEach-Object { [int]$_.ProcessId }
  )
}

function Stop-ManagedVision([int[]]$OwnedProcessIds) {
  $task = Get-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
  if ($null -ne $task -and [string]$task.State -eq "Running") {
    Stop-ScheduledTask -InputObject $task -ErrorAction Stop
  }
  foreach ($processId in @($OwnedProcessIds)) {
    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    if (@(Get-ManagedVisionProcessIds).Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if (@(Get-ManagedVisionProcessIds).Count -ne 0) {
    throw "Vision test isolation: canonical Vision process did not stop"
  }
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

$visionModulePath = Join-Path $PSScriptRoot "..\windows\vision-main-artifacts.psm1"
Import-Module $visionModulePath -Force
$primaryFailure = $null
$managedVisionProcessIds = @()
try {
  $visionCacheRoot = Join-Path $CacheRoot "vision-main"
  $visionSiteConfigurationSourcePath = Join-Path $RuntimeRoot "vision-recorded-site-config.json"
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
  Write-RecordedVisionSiteConfiguration $visionSiteConfigurationSourcePath
  $visionInstallation = Install-VisionMainArtifact `
    -RuntimeArchive ([string]$visionCache.runtimeArchive) `
    -FixtureArchive ([string]$visionCache.fixtureArchive) `
    -Commit ([string]$visionCache.commit) `
    -SiteConfigurationPath $visionSiteConfigurationSourcePath `
    -TaskUser "VEMKiosk" `
    -ProbeTimeoutSeconds 60
  if ([string]$visionInstallation.commit -ne [string]$visionCache.commit) {
    throw "installed Vision commit does not match the resolved cached commit"
  }
  node scripts/testbed/vision-try-on-acceptance.mjs --mode full --guest-input $GuestInputPath --handoff $HandoffPath --out $OutPath --fixture-key $FixtureKey
  if ($LASTEXITCODE -ne 0) { throw "vision try-on acceptance failed" }
} catch {
  $primaryFailure = $_
  throw
} finally {
  $cleanupFailures = @()
  try {
    Stop-ManagedVision -OwnedProcessIds (Get-ManagedVisionProcessIds)
  } catch {
    $cleanupFailures += $_
  }
  try {
    Wait-ForVisionPortRebind
  } catch {
    $cleanupFailures += $_
  }
  if ($cleanupFailures.Count -gt 0) {
    $cleanupMessage = ($cleanupFailures | ForEach-Object { $_.Exception.Message }) -join "; "
    if ($null -ne $primaryFailure) {
      Write-Warning "Vision test isolation cleanup failed after the business failure: $cleanupMessage"
    } else {
      throw "Vision test isolation cleanup failed: $cleanupMessage"
    }
  }
}
