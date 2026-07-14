[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BundlePath,
  [Parameter(Mandatory = $true)][string]$DescriptorPath,
  [Parameter(Mandatory = $true)][string]$InstallerLibraryPath,
  [Parameter(Mandatory = $true)][string]$ConformanceEvidencePath,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [string]$WorkRoot = "C:\ProgramData\VEM\testbed\vision-candidate"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. $InstallerLibraryPath -BundlePath $BundlePath -Library

$candidateProcess = $null
$staging = Join-Path $WorkRoot ([guid]::NewGuid().ToString("N"))
$previousSelection = $null
$previousWasRunning = $false
$report = [ordered]@{
  schemaVersion = "vem-vision-experimental-conformance-report/v1"
  kind = "vision-experimental-conformance-report"
  ok = $false
  bundleDigest = $null
  descriptorDigest = $null
  releaseVersion = $null
  processPathBound = $false
  processHashBound = $false
  healthStatus = $null
  cameraReady = $null
  modelReady = $null
  webSocketReady = $false
  cleanupOk = $false
  failure = ""
}

try {
  $descriptor = (Read-StrictJson $DescriptorPath "Vision Candidate descriptor").value
  $report.bundleDigest = [string]$descriptor.bundle.digest
  $report.descriptorDigest = [string]$descriptor.identity
  $report.releaseVersion = [string]$descriptor.releaseVersion
  if (
    $descriptor.bundle.extractor.handler -cne "zip-safe-v1" -or
    $descriptor.protocol.version -cne "vem.vision.v1" -or
    $descriptor.configuration.schemaVersion -cne "vending-vision-site-config/v1"
  ) { throw "Vision Candidate does not use the supported install and runtime contracts" }

  $selectionPathForPrevious = "C:\ProgramData\VEM\vision\current.json"
  $processPathForPrevious = "C:\ProgramData\VEM\vision\process-state\active-process.json"
  if (
    (Test-Path -LiteralPath $selectionPathForPrevious -PathType Leaf) -and
    (Test-Path -LiteralPath $processPathForPrevious -PathType Leaf)
  ) {
    $previousSelection = (Read-StrictJson $selectionPathForPrevious "previous Vision selection").value
    $previousRecord = (Read-StrictJson $processPathForPrevious "previous Vision process record").value
    $previousWasRunning = $null -ne (Get-Process -Id ([int]$previousRecord.processId) -ErrorAction SilentlyContinue)
    if ($previousWasRunning) { Stop-RecordedVision $previousSelection }
  }
  Stop-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue

  if (Get-NetTCPConnection -LocalPort ([int]$descriptor.health.port) -State Listen -ErrorAction SilentlyContinue) {
    throw "Vision Candidate health port is owned by another process"
  }

  New-Item -ItemType Directory -Path $staging -Force | Out-Null
  $bundleStream = Get-VerifiedBundleStream $descriptor
  try {
    Expand-ZipSafely $bundleStream $staging $descriptor
  } finally {
    $bundleStream.Dispose()
  }
  $entrypoint = Join-TrustedRelativePath $staging ([string]$descriptor.entrypoint.command) "Vision Candidate entrypoint"
  if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    throw "Vision Candidate entrypoint was not extracted"
  }
  $entrypointDigest = "sha256:" + (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash.ToLowerInvariant()

  $configurationPath = Join-Path $staging "vem-testbed-site.json"
  $configuration = [ordered]@{
    schemaVersion = "vending-vision-site-config/v1"
    host = "127.0.0.1"
    port = [int]$descriptor.health.port
    allowed_origins = @("http://tauri.localhost")
    cameras = [ordered]@{
      top = [ordered]@{ index=0; role="presence"; rotate=0 }
      front = [ordered]@{ index=1; role="profile_tryon"; rotate=0 }
    }
  }
  [IO.File]::WriteAllText(
    $configurationPath,
    ($configuration | ConvertTo-Json -Depth 12 -Compress),
    [Text.UTF8Encoding]::new($false)
  )
  $arguments = @($descriptor.entrypoint.arguments) + @([string]$descriptor.configuration.argument, $configurationPath)
  $candidateProcess = Start-Process -FilePath $entrypoint -ArgumentList $arguments -WorkingDirectory $staging -PassThru
  Start-Sleep -Milliseconds 200
  $candidateProcess.Refresh()
  if ($candidateProcess.HasExited -or $candidateProcess.Path -cne $entrypoint) {
    throw "Vision Candidate did not remain at the exact extracted entrypoint"
  }
  $report.processPathBound = $true
  if (("sha256:" + (Get-FileHash -LiteralPath $candidateProcess.Path -Algorithm SHA256).Hash.ToLowerInvariant()) -cne $entrypointDigest) {
    throw "Vision Candidate executable changed after launch"
  }
  $report.processHashBound = $true

  $deadline = [DateTime]::UtcNow.AddMilliseconds([int]$descriptor.health.timeoutMs)
  $health = $null
  do {
    try {
      $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}{1}" -f $descriptor.health.port, $descriptor.health.path) -TimeoutSec 2
      if (
        $health.status -in @("ok", "degraded") -and
        $health.protocol -ceq $descriptor.protocol.version -and
        $health.version -ceq $descriptor.releaseVersion -and
        $health.mockScenario -ceq "off" -and
        $health.cameraReady -is [bool] -and
        $health.modelReady -is [bool] -and
        $health.modelReady -eq $true
      ) { break }
    } catch {}
    Start-Sleep -Milliseconds 200
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($null -eq $health -or [DateTime]::UtcNow -ge $deadline) {
    throw "Vision Candidate health contract did not become ready"
  }
  $report.healthStatus = [string]$health.status
  $report.cameraReady = [bool]$health.cameraReady
  $report.modelReady = [bool]$health.modelReady

  $socket = [Net.WebSockets.ClientWebSocket]::new()
  $cancel = [Threading.CancellationTokenSource]::new([TimeSpan]::FromMilliseconds([int]$descriptor.health.timeoutMs))
  try {
    $socket.ConnectAsync([Uri]("ws://127.0.0.1:{0}{1}" -f $descriptor.health.port, $descriptor.protocol.webSocketPath), $cancel.Token).GetAwaiter().GetResult()
    $hello = [ordered]@{
      protocol="vem.vision.v1"; type="vision.hello"; messageId=("testbed-" + [guid]::NewGuid().ToString("N")); timestamp=[DateTime]::UtcNow.ToString("o")
      payload=[ordered]@{ clientRole="machine"; machineCode=$null; protocolVersion=1; capabilities=@("profile_push","presence_status","person_departed","ambient_light") }
    }
    $helloBytes = [Text.Encoding]::UTF8.GetBytes(($hello | ConvertTo-Json -Depth 8 -Compress))
    $socket.SendAsync([ArraySegment[byte]]::new($helloBytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $cancel.Token).GetAwaiter().GetResult()
    $buffer = [byte[]]::new(8192)
    $received = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $cancel.Token).GetAwaiter().GetResult()
    $ready = [Text.Encoding]::UTF8.GetString($buffer, 0, $received.Count) | ConvertFrom-Json
    if (
      $ready.protocol -cne "vem.vision.v1" -or
      $ready.type -cne "vision.ready" -or
      [string]::IsNullOrWhiteSpace([string]$ready.messageId) -or
      [string]::IsNullOrWhiteSpace([string]$ready.timestamp) -or
      [string]::IsNullOrWhiteSpace([string]$ready.payload.serverName) -or
      $ready.payload.serverVersion -cne $descriptor.releaseVersion -or
      $ready.payload.cameraReady -isnot [bool] -or
      $ready.payload.modelReady -isnot [bool] -or
      $ready.payload.modelReady -ne $true -or
      $ready.payload.capabilities -isnot [array]
    ) { throw "Vision Candidate WebSocket ready contract failed" }
    $report.webSocketReady = $true
  } finally {
    $socket.Dispose()
    $cancel.Dispose()
  }

  $conformance = [ordered]@{
    schemaVersion = "vem-vision-conformance/v1"
    kind = "vision-release-conformance"
    bundleDigest = [string]$descriptor.bundle.digest
    descriptorDigest = [string]$descriptor.identity
    protocolVersion = "vem.vision.v1"
  }
  Write-AtomicJson $ConformanceEvidencePath $conformance
  $report.ok = $true
} catch {
  $report.failure = Sanitize $_.Exception.Message
  throw
} finally {
  $cleanupOk = $true
  if ($null -ne $candidateProcess) {
    try {
      if (-not $candidateProcess.HasExited) { $candidateProcess.Kill(); $candidateProcess.WaitForExit(10000) | Out-Null }
    } catch { $cleanupOk = $false }
    $candidateProcess.Dispose()
  }
  try { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction Stop } catch { $cleanupOk = $false }
  if ($previousWasRunning -and $null -ne $previousSelection) {
    try { Start-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction Stop } catch { $cleanupOk = $false }
  }
  $report.cleanupOk = $cleanupOk
  if (-not $cleanupOk -and [string]::IsNullOrWhiteSpace($report.failure)) { $report.failure = "Vision Candidate cleanup failed" }
  Write-AtomicJson $ReportPath $report
}
