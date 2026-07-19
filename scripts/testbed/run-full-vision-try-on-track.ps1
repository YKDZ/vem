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
      }
      front = @{
        source = "recorded_video"
        role = "profile_tryon"
        video_path = "recorded-video/front.mp4"
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

$visionModulePath = Join-Path $PSScriptRoot "..\windows\vision-main-artifacts.psm1"
Import-Module $visionModulePath -Force
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
