[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$BundlePath,
  [Parameter(Mandatory = $true)][string]$ExpectedDigest,
  [Parameter(Mandatory = $true)][string]$DescriptorPath,
  [Parameter(Mandatory = $true)][string]$ConformanceEvidencePath,
  [Parameter(Mandatory = $true)][string]$ReportPath,
  [string]$PreapprovalManifestPath,
  [string]$WorkRoot = "C:\ProgramData\VEM\testbed\vision-candidate"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot "vision-release-materialization.psm1") -Force -ErrorAction Stop
Import-Module (Join-Path $PSScriptRoot "vision-diagnostic-redaction.psm1") -Force -ErrorAction Stop

function Assert-CandidateNonReparsePath([string]$Path, [string]$Label) {
  $cursor = [IO.Path]::GetFullPath($Path)
  while (-not [string]::IsNullOrWhiteSpace($cursor)) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "$Label must not traverse a reparse point"
      }
    }
    $parent = [IO.Directory]::GetParent($cursor)
    if ($null -eq $parent -or $parent.FullName -ceq $cursor) { break }
    $cursor = $parent.FullName
  }
  return [IO.Path]::GetFullPath($Path)
}

function Read-StrictJson([string]$Path, [string]$Label) {
  Assert-CandidateNonReparsePath $Path $Label | Out-Null
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "$Label must be a regular file" }
  $bytes = [IO.File]::ReadAllBytes($item.FullName)
  return [pscustomobject]@{ value=([Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json); digest=("sha256:" + ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes))).ToLowerInvariant()) }
}
function Write-AtomicJson([string]$Path, [object]$Value) {
  $parent = Split-Path -Parent $Path
  Assert-CandidateNonReparsePath $parent "candidate evidence directory" | Out-Null
  New-Item -ItemType Directory -Path $parent -Force | Out-Null
  Assert-CandidateNonReparsePath $parent "candidate evidence directory" | Out-Null
  $temporary = Join-Path $parent ("." + [guid]::NewGuid().ToString("N") + ".tmp")
  try { [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 64 -Compress), [Text.UTF8Encoding]::new($false)); Move-Item -LiteralPath $temporary -Destination $Path -Force } finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}
function Sanitize([string]$Message) { $null = $Message; return Get-VisionRedactedDiagnostic "candidate preapproval" }
function Resolve-CandidateEntrypoint([string]$Root, [string]$Relative) {
  if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative -match '^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)') { throw "Vision Candidate entrypoint is unsafe" }
  $trustedRoot = Assert-CandidateNonReparsePath $Root "Vision Candidate staging root"
  $path = [IO.Path]::GetFullPath((Join-Path $trustedRoot $Relative)); $prefix = $trustedRoot.TrimEnd([char]92,[char]47) + [IO.Path]::DirectorySeparatorChar
  if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Vision Candidate entrypoint escapes staging" }
  Assert-CandidateNonReparsePath $path "Vision Candidate entrypoint" | Out-Null
  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "Vision Candidate entrypoint must be a regular file" }
  }
  return $path
}

function Get-VerifiedPreviousVisionRuntime([string]$SelectionPath, [string]$ProcessPath) {
  if (-not (Test-Path -LiteralPath $SelectionPath -PathType Leaf) -or -not (Test-Path -LiteralPath $ProcessPath -PathType Leaf)) { return $null }
  $selection = (Read-StrictJson $SelectionPath "previous Vision selection").value
  $record = (Read-StrictJson $ProcessPath "previous Vision process record").value
  foreach ($name in @("revision", "bundleDigest", "installDirectory", "entrypoint")) {
    if ([string]::IsNullOrWhiteSpace([string]$selection.$name)) { throw "previous Vision selection is incomplete" }
  }
  foreach ($name in @("selectionRevision", "bundleDigest", "processId", "creationTimeUtcTicks", "executablePath", "executableDigest")) {
    if ($null -eq $record.PSObject.Properties[$name] -or [string]::IsNullOrWhiteSpace([string]$record.$name)) { throw "previous Vision process record is incomplete" }
  }
  if ($record.selectionRevision -cne $selection.revision -or $record.bundleDigest -cne $selection.bundleDigest) { throw "previous Vision process record does not bind the selected release" }
  [int]$processId = 0; [Int64]$creationTimeUtcTicks = 0
  if (-not [int]::TryParse([string]$record.processId, [ref]$processId) -or $processId -lt 1 -or -not [Int64]::TryParse([string]$record.creationTimeUtcTicks, [ref]$creationTimeUtcTicks) -or $creationTimeUtcTicks -lt 1) { throw "previous Vision process record identity is invalid" }
  $entrypoint = Resolve-CandidateEntrypoint ([string]$selection.installDirectory) ([string]$selection.entrypoint)
  $recordPath = Assert-CandidateNonReparsePath ([string]$record.executablePath) "previous Vision executable"
  if ($recordPath -cne $entrypoint) { throw "previous Vision process record executable does not bind the selected release" }
  if ([string]$record.executableDigest -notmatch '^sha256:[a-f0-9]{64}$') { throw "previous Vision process record digest is invalid" }
  if (("sha256:" + (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash.ToLowerInvariant()) -cne $record.executableDigest) { throw "previous Vision executable digest no longer matches its record" }
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return [pscustomobject]@{ selection=$selection; record=$record; active=$false; processId=$processId; creationTimeUtcTicks=$creationTimeUtcTicks; executablePath=$entrypoint; executableDigest=$record.executableDigest }
  }
  try {
    if ($process.StartTime.ToUniversalTime().Ticks -ne $creationTimeUtcTicks -or $process.Path -cne $entrypoint) { throw "previous Vision process identity no longer matches its record" }
    return [pscustomobject]@{ selection=$selection; record=$record; active=$true; processId=$processId; creationTimeUtcTicks=$creationTimeUtcTicks; executablePath=$entrypoint; executableDigest=$record.executableDigest }
  } finally { $process.Dispose() }
}

function Stop-VerifiedPreviousVisionRuntime([object]$Runtime) {
  if ($null -eq $Runtime -or -not [bool]$Runtime.active) { return }
  Stop-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
  & "$env:WINDIR\System32\taskkill.exe" /PID ([string]$Runtime.processId) /T /F | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "previous Vision process tree cleanup failed" }
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    $process = Get-Process -Id ([int]$Runtime.processId) -ErrorAction SilentlyContinue
    if ($null -eq $process) { return }
    try {
      if ($process.StartTime.ToUniversalTime().Ticks -ne [Int64]$Runtime.creationTimeUtcTicks) { return }
    } finally { $process.Dispose() }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "previous Vision process did not stop"
}

function Restore-VerifiedPreviousVisionRuntime([object]$Runtime, [string]$SelectionPath, [string]$ProcessPath) {
  if ($null -eq $Runtime) { return $false }
  Start-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction Stop
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  do {
    try {
      $restored = Get-VerifiedPreviousVisionRuntime $SelectionPath $ProcessPath
      if ($null -ne $restored -and $restored.selection.revision -ceq $Runtime.selection.revision -and $restored.selection.bundleDigest -ceq $Runtime.selection.bundleDigest -and $restored.executablePath -ceq $Runtime.executablePath -and $restored.executableDigest -ceq $Runtime.executableDigest) { return $true }
    } catch {}
    Start-Sleep -Milliseconds 150
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "previous Vision release did not restore with its verified identity"
}

function ConvertTo-CanonicalVisionJson([object]$Value) {
  if ($null -eq $Value) { return "null" }
  if ($Value -is [string] -or $Value -is [char] -or $Value -is [bool] -or $Value -is [ValueType]) { return (ConvertTo-Json -InputObject $Value -Compress) }
  if ($Value -is [Array]) {
    return "[" + ((@($Value) | ForEach-Object { ConvertTo-CanonicalVisionJson $_ }) -join ",") + "]"
  }
  if ($Value -is [Collections.IDictionary]) {
    return "{" + ((@($Value.Keys | Sort-Object) | ForEach-Object { (ConvertTo-Json -InputObject ([string]$_) -Compress) + ":" + (ConvertTo-CanonicalVisionJson $Value[$_]) }) -join ",") + "}"
  }
  $properties = @($Value.PSObject.Properties | Where-Object { $_.MemberType -in @("NoteProperty", "Property") } | Sort-Object Name)
  return "{" + (($properties | ForEach-Object { (ConvertTo-Json -InputObject $_.Name -Compress) + ":" + (ConvertTo-CanonicalVisionJson $_.Value) }) -join ",") + "}"
}

function Assert-PreapprovalDeliveryManifest([string]$Path, [string]$Expected, [string]$Bundle, [string]$Descriptor, [string]$EntryScriptPath = $PSCommandPath, [string]$MaterializerPath = (Join-Path $PSScriptRoot "vision-release-materialization.psm1"), [string]$RedactorPath = (Join-Path $PSScriptRoot "vision-diagnostic-redaction.psm1")) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return }
  $read = Read-StrictJson $Path "Vision preapproval delivery manifest"
  $manifest = $read.value
  $expectedKeys = @("schemaVersion", "kind", "expectedDigest", "descriptorDigest", "files", "identity")
  $actualManifestKeys = @($manifest.PSObject.Properties.Name | Sort-Object) -join ","
  $requiredManifestKeys = @($expectedKeys | Sort-Object) -join ","
  if ($actualManifestKeys -cne $requiredManifestKeys -or $manifest.schemaVersion -cne "vem-vision-preapproval-delivery/v1" -or $manifest.kind -cne "vision-preapproval-delivery") { throw "Vision preapproval delivery manifest is invalid" }
  $unsigned = [ordered]@{ schemaVersion=$manifest.schemaVersion; kind=$manifest.kind; expectedDigest=$manifest.expectedDigest; descriptorDigest=$manifest.descriptorDigest; files=$manifest.files }
  $unsignedBytes = [Text.UTF8Encoding]::new($false).GetBytes(((ConvertTo-CanonicalVisionJson $unsigned) + [char]10))
  $unsignedIdentity = "sha256:" + ([Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($unsignedBytes))).ToLowerInvariant()
  if ($manifest.identity -cne $unsignedIdentity -or $manifest.expectedDigest -cne $Expected -or $manifest.files.'bundle.bin' -cne $Expected) { throw "Vision preapproval delivery manifest does not preserve ExpectedDigest" }
  $root = Assert-CandidateNonReparsePath (Split-Path -Parent $Path) "Vision preapproval delivery root"
  $required = [ordered]@{
    "bundle.bin" = $Bundle
    "vision-release-descriptor.json" = $Descriptor
    "test-vision-candidate.ps1" = $EntryScriptPath
    "vision-release-materialization.psm1" = $MaterializerPath
    "vision-diagnostic-redaction.psm1" = $RedactorPath
  }
  $actualFileKeys = @($manifest.files.PSObject.Properties.Name | Sort-Object) -join ","
  $requiredFileKeys = @($required.Keys | Sort-Object) -join ","
  if ($actualFileKeys -cne $requiredFileKeys) { throw "Vision preapproval delivery manifest file set is invalid" }
  foreach ($name in $required.Keys) {
    $expectedPath = [IO.Path]::GetFullPath((Join-Path $root $name))
    $actualPath = Assert-CandidateNonReparsePath $required[$name] "Vision preapproval delivery file"
    if ($actualPath -cne $expectedPath) { throw "Vision preapproval delivery file is not from the self-contained unit" }
    $item = Get-Item -LiteralPath $actualPath -Force -ErrorAction Stop
    if ($item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw "Vision preapproval delivery file must be regular" }
    $digest = "sha256:" + (Get-FileHash -LiteralPath $actualPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($digest -cne [string]$manifest.files.$name) { throw "Vision preapproval delivery file digest is invalid" }
  }
  $descriptorDigest = "sha256:" + (Get-FileHash -LiteralPath $Descriptor -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($descriptorDigest -cne [string]$manifest.descriptorDigest) { throw "Vision preapproval delivery descriptor digest is invalid" }
}

$candidateProcess = $null
$staging = Join-Path $WorkRoot ([guid]::NewGuid().ToString("N"))
$previousRuntime = $null
$previousRuntimeStopped = $false
$previousTaskWasRunning = $false
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
  previousRuntimeStopped = $false
  previousRuntimeRestored = $false
  cleanupOk = $false
  failure = ""
}

try {
  $descriptorRead = Read-StrictJson $DescriptorPath "Vision Candidate descriptor"
  $descriptor = $descriptorRead.value
  if ($ExpectedDigest -notmatch '^sha256:[a-f0-9]{64}$' -or $ExpectedDigest -cne [string]$descriptor.bundle.digest) {
    throw "Vision Candidate expected digest does not match the descriptor"
  }
  $report.bundleDigest = [string]$descriptor.bundle.digest
  $report.descriptorDigest = [string]$descriptor.identity
  $report.releaseVersion = [string]$descriptor.releaseVersion
  if (
    $descriptor.bundle.extractor.handler -cne "zip-safe-v1" -or
    $descriptor.protocol.version -cne "vem.vision.v1" -or
    $descriptor.configuration.schemaVersion -cne "vending-vision-site-config/v1"
  ) { throw "Vision Candidate does not use the supported install and runtime contracts" }
  Assert-PreapprovalDeliveryManifest $PreapprovalManifestPath $ExpectedDigest $BundlePath $DescriptorPath

  $selectionPathForPrevious = "C:\ProgramData\VEM\vision\current.json"
  $processPathForPrevious = "C:\ProgramData\VEM\vision\process-state\active-process.json"
  $previousRuntime = Get-VerifiedPreviousVisionRuntime $selectionPathForPrevious $processPathForPrevious
  try { $previousTaskWasRunning = ((Get-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction Stop).State -eq "Running") } catch {}
  Stop-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
  if ($null -ne $previousRuntime -and [bool]$previousRuntime.active) {
    Stop-VerifiedPreviousVisionRuntime $previousRuntime
    $previousRuntimeStopped = $true
    $report.previousRuntimeStopped = $true
  }

  if (Get-NetTCPConnection -LocalPort ([int]$descriptor.health.port) -State Listen -ErrorAction SilentlyContinue) {
    throw "Vision Candidate health port is owned by another process"
  }

  # The shared materializer exclusively creates its fresh destination.  Creating
  # it here changes the security contract from create-new to overwrite-prone.
  Invoke-VisionReleaseMaterialization -CandidatePath $BundlePath -ExpectedDigest $ExpectedDigest -Descriptor $descriptor -Destination $staging -ExtractionPolicy @{ MaxArchiveEntries=4096; MaxExpandedBytes=4GB; MaxExpansionRatio=200 } | Out-Null
  $entrypoint = Resolve-CandidateEntrypoint $staging ([string]$descriptor.entrypoint.command)
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
  if (($previousRuntimeStopped -or $previousTaskWasRunning) -and $null -ne $previousRuntime) {
    try { $report.previousRuntimeRestored = Restore-VerifiedPreviousVisionRuntime $previousRuntime $selectionPathForPrevious $processPathForPrevious } catch { $cleanupOk = $false }
  }
  $report.cleanupOk = $cleanupOk
  if (-not $cleanupOk -and [string]::IsNullOrWhiteSpace($report.failure)) { $report.failure = "Vision Candidate cleanup failed" }
  Write-AtomicJson $ReportPath $report
}
