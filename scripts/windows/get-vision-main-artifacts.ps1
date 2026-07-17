[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$CacheRoot,
  [string]$CommitSha,
  [string]$Repository = "hbhjt/vending-vision",
  [string]$ApiBaseUrl = "https://api.github.com",
  [string]$GitHubToken = $env:VISION_GITHUB_TOKEN
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "vision-main-artifacts.psm1") -Force
Get-VisionMainArtifactCache @PSBoundParameters | ConvertTo-Json -Depth 8
