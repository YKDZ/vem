[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RuntimeArchive,
  [Parameter(Mandatory = $true)][string]$Commit,
  [Parameter(Mandatory = $true)][string]$SiteConfigurationPath,
  [string]$FixtureArchive,
  [string]$AppDirectory = "C:\VEM\vision\app",
  [string]$SiteConfigurationDestination = "C:\ProgramData\VEM\vision\site.json",
  [string]$FixtureDirectory = "C:\ProgramData\VEM\vision\fixtures",
  [string]$LauncherPath = "C:\VEM\bringup\start_vision.bat",
  [string]$TaskName = "StartVisionServer",
  [string]$TaskPath = "\VEM\",
  [string]$TaskUser = "VEMKiosk",
  [int]$ProbeTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
Import-Module (Join-Path $PSScriptRoot "vision-main-artifacts.psm1") -Force
Install-VisionMainArtifact @PSBoundParameters
