param(
  [Parameter(Mandatory = $true)][string]$GuestInputPath,
  [Parameter(Mandatory = $true)][string]$HandoffPath,
  [Parameter(Mandatory = $true)][string]$OutPath,
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
      "https://tauri.localhost",
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

$visionModulePath = Join-Path $PSScriptRoot "..\windows\vision-main-artifacts.psm1"
Import-Module $visionModulePath -Force
$visionCacheRoot = Join-Path $CacheRoot "vision-main"
$visionSiteConfigurationSourcePath = Join-Path $RuntimeRoot "vision-recorded-site-config.json"
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
