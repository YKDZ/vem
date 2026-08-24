[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$StagingDirectory,
  [Parameter(Mandatory = $true)][string]$KioskPassword,
  [string]$RuntimeDirectory = "C:\VEM\bringup",
  [string]$DaemonDataDirectory = "C:\ProgramData\VEM\vending-daemon",
  [string]$VisionSiteSource = "C:\ProgramData\VEM\vision\site.json",
  [string]$OwnerManifestPath = "C:\ProgramData\VEM\runtime-owners\owner-manifest.json"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

function Assert-Hash([string]$Path, [string]$Expected, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "missing $Label : $Path" }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne $Expected) { throw "$Label digest mismatch: $Path" }
  Write-Output ("OK  {0}" -f $Label)
}

function Stop-Owners {
  $service = Get-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue
  if ($null -ne $service) { Stop-Service -Name $service.Name -Force -ErrorAction SilentlyContinue }
  foreach ($taskName in @("VEMMachineUI", "VEMVisionRuntime")) {
    $task = Get-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction SilentlyContinue
    if ($null -ne $task) { Stop-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction SilentlyContinue }
  }
  foreach ($processName in @("vending-daemon.exe", "machine.exe", "vending-vision.exe")) {
    Get-Process -Name $processName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  }
}

function Start-Owners([int]$ReadyTimeoutSeconds = 90) {
  Start-Service -Name "VemVendingDaemon" -ErrorAction Stop
  foreach ($taskName in @("VEMMachineUI", "VEMVisionRuntime")) {
    Start-ScheduledTask -TaskName $taskName -TaskPath "\" -ErrorAction SilentlyContinue
  }
  $readyPath = Join-Path $DaemonDataDirectory "daemon-ready.json"
  $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
  $daemonReady = $false
  do {
    if (Test-Path -LiteralPath $readyPath -PathType Leaf) {
      try {
        $ready = Get-Content -LiteralPath $readyPath -Raw -Encoding UTF8 | ConvertFrom-Json
        $origin = ([uri]$ready.readyzUrl).GetLeftPart([UriPartial]::Authority)
        $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
        $readiness = Invoke-RestMethod -Uri $ready.readyzUrl -Headers $headers -TimeoutSec 5
        if ($readiness.ready -eq $true) { $daemonReady = $true; break }
      } catch {
        Start-Sleep -Seconds 2
      }
    }
    Start-Sleep -Seconds 2
  } while ([DateTime]::UtcNow -lt $deadline)
  if (-not $daemonReady) { throw "daemon did not become ready within ${ReadyTimeoutSeconds}s" }
  $deadline = [DateTime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
  do {
    $machineUp = $null -ne (Get-Process -Name "machine" -ErrorAction SilentlyContinue)
    $visionUp = $null -ne (Get-Process -Name "vending-vision" -ErrorAction SilentlyContinue)
    if ($machineUp -and $visionUp) { return }
    Start-Sleep -Seconds 3
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Machine UI or Vision did not start within ${ReadyTimeoutSeconds}s"
}

Write-Output "== Step 1/5: verify kit manifest and members =="
$kitManifestPath = Join-Path $StagingDirectory "vem-field-kit-manifest.json"
$kit = Get-Content -Raw -LiteralPath $kitManifestPath -Encoding UTF8 | ConvertFrom-Json
if ($kit.schemaVersion -cne "vem-field-kit/v1") { throw "invalid field kit manifest" }
foreach ($member in @($kit.members)) {
  Assert-Hash (Join-Path $StagingDirectory $member.name) ([string]$member.sha256) ([string]$member.name)
}
$runtimeCommit = [string]$kit.vemCommit

Write-Output "== Step 2/5: preserve physical DirectShow site.json =="
if (-not (Test-Path -LiteralPath $VisionSiteSource -PathType Leaf)) {
  throw "physical Vision site.json is missing: $VisionSiteSource"
}
Copy-Item -LiteralPath $VisionSiteSource -Destination (Join-Path $StagingDirectory "site.json") -Force

Write-Output "== Step 3/5: stop owners and deploy runtime binaries =="
Stop-Owners
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$backupDirectory = Join-Path $StagingDirectory ("bringup-backup-" + $stamp)
New-Item -ItemType Directory -Force -Path $backupDirectory | Out-Null
foreach ($file in @("vending-daemon.exe", "machine.exe", "WebView2Loader.dll")) {
  $existing = Join-Path $RuntimeDirectory $file
  if (Test-Path -LiteralPath $existing -PathType Leaf) {
    Copy-Item -LiteralPath $existing -Destination (Join-Path $backupDirectory $file) -Force
  }
  Copy-Item -LiteralPath (Join-Path $StagingDirectory $file) -Destination $existing -Force
  $member = $kit.members | Where-Object { $_.name -eq $file }
  Assert-Hash $existing ([string]$member.sha256) ("installed " + $file)
}
Write-Output ("OK  bringup backed up to {0}" -f $backupDirectory)

Write-Output "== Step 4/5: deploy Vision and runtime owners =="
& (Join-Path $StagingDirectory "install-vision-main-artifact.ps1") `
  -RuntimeArchive (Join-Path $StagingDirectory "vending-vision-windows-x86_64.zip") `
  -Commit ([string]$kit.visionCommit) `
  -SiteConfigurationPath (Join-Path $StagingDirectory "site.json") `
  -SkipRuntimeOwnerTask | Out-Null
& (Join-Path $StagingDirectory "install-vem-runtime-owners.ps1") `
  -RuntimeDirectory $RuntimeDirectory `
  -DaemonDataDirectory $DaemonDataDirectory `
  -KioskPassword $KioskPassword `
  -OwnerManifestPath $OwnerManifestPath | Out-Null

Write-Output "== Step 5/5: start owners and probe =="
Start-Owners
& (Join-Path $StagingDirectory "probe-vem-runtime.ps1") `
  -DaemonDataDirectory $DaemonDataDirectory `
  -OwnerManifestPath $OwnerManifestPath `
  -RequireHealthy | Out-Null

[ordered]@{
  schemaVersion = "vem-field-kit-install/v1"
  vemCommit = $runtimeCommit
  visionCommit = [string]$kit.visionCommit
  ownerManifest = $OwnerManifestPath
  bringupBackup = $backupDirectory
} | ConvertTo-Json -Depth 8
