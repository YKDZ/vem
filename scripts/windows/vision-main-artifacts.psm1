Set-StrictMode -Version Latest

$script:VisionRuntimeArchive = "vending-vision-windows-x86_64.zip"
$script:VisionFixtureArchive = "vending-vision-test-fixtures.zip"
$script:VisionDeliveryManifest = "vending-vision-main-artifacts.json"
$script:VisionArtifactSchema = "vending-vision-main-artifacts/v1"

function Assert-VisionMainCondition {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw "Vision main artifact: $Message" }
}

function Assert-VisionCommit([string]$Commit) {
  Assert-VisionMainCondition ($Commit -match '^[a-f0-9]{40}$') "commit must be a lowercase 40-character SHA"
  return $Commit
}

function Get-VisionSha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
}

function Read-VisionJson([string]$Path, [string]$Label) {
  try { return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop }
  catch { throw "Vision main artifact: $Label is not valid JSON" }
}

function Get-VisionArchiveManifest([string]$ArchivePath) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $entry = $archive.GetEntry("vision-artifact.json")
    Assert-VisionMainCondition ($null -ne $entry) "archive is missing vision-artifact.json"
    $reader = [IO.StreamReader]::new($entry.Open(), [Text.Encoding]::UTF8, $true)
    try { return $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop }
    finally { $reader.Dispose() }
  } catch { throw "Vision main artifact: archive manifest is invalid: $($_.Exception.Message)" }
  finally { $archive.Dispose() }
}

function Assert-VisionArchive([string]$ArchivePath, [string]$Commit, [ValidateSet("runtime", "fixtures")][string]$Kind) {
  Assert-VisionMainCondition (Test-Path -LiteralPath $ArchivePath -PathType Leaf) "$Kind archive is missing"
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
  try {
    $entries = @($archive.Entries | ForEach-Object { $_.FullName })
    if ($Kind -eq "runtime") {
      Assert-VisionMainCondition ($entries -contains "vending-vision.exe") "runtime archive must contain vending-vision.exe at its root"
      Assert-VisionMainCondition (@($entries | Where-Object { $_ -match '(^|/)(recorded-video|fixtures)(/|$)|\.mp4$' }).Count -eq 0) "runtime archive must not contain recorded-video fixtures"
    } else {
      foreach ($required in @("recorded-video/top.mp4", "recorded-video/front.mp4", "recorded-video/expected-results.json")) {
        Assert-VisionMainCondition ($entries -contains $required) "fixture archive is missing $required"
      }
    }
  } finally { $archive.Dispose() }
  $manifest = Get-VisionArchiveManifest $ArchivePath
  Assert-VisionMainCondition ($manifest.schemaVersion -ceq $script:VisionArtifactSchema) "$Kind archive has an unsupported manifest"
  Assert-VisionMainCondition ($manifest.commit -ceq $Commit) "$Kind archive is not from commit $Commit"
  Assert-VisionMainCondition ($manifest.runtimeArchive -ceq $script:VisionRuntimeArchive -and $manifest.fixtureArchive -ceq $script:VisionFixtureArchive) "$Kind archive manifest names unexpected artifacts"
}

function Assert-VisionCachedArtifacts([string]$CacheDirectory, [string]$Commit) {
  $Commit = Assert-VisionCommit $Commit
  $runtime = Join-Path $CacheDirectory $script:VisionRuntimeArchive
  $fixtures = Join-Path $CacheDirectory $script:VisionFixtureArchive
  $manifestPath = Join-Path $CacheDirectory $script:VisionDeliveryManifest
  Assert-VisionMainCondition (Test-Path -LiteralPath $manifestPath -PathType Leaf) "cache manifest is missing for $Commit"
  $manifest = Read-VisionJson $manifestPath "cache manifest"
  Assert-VisionMainCondition ($manifest.schemaVersion -ceq $script:VisionArtifactSchema -and $manifest.commit -ceq $Commit) "cache manifest does not bind commit $Commit"
  Assert-VisionMainCondition ($manifest.runtime.file -ceq $script:VisionRuntimeArchive -and $manifest.fixtures.file -ceq $script:VisionFixtureArchive) "cache manifest names unexpected archives"
  Assert-VisionMainCondition ($manifest.runtime.sha256 -ceq (Get-VisionSha256 $runtime)) "runtime cache hash does not match its delivery manifest"
  Assert-VisionMainCondition ($manifest.fixtures.sha256 -ceq (Get-VisionSha256 $fixtures)) "fixture cache hash does not match its delivery manifest"
  Assert-VisionArchive $runtime $Commit runtime
  Assert-VisionArchive $fixtures $Commit fixtures
  return [pscustomobject]@{ commit = $Commit; cacheDirectory = $CacheDirectory; runtimeArchive = $runtime; fixtureArchive = $fixtures; manifest = $manifestPath }
}

function Expand-VisionActionArtifact([string]$ArtifactZip, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [IO.Compression.ZipFile]::OpenRead($ArtifactZip)
  try {
    foreach ($entry in $archive.Entries) {
      if ($entry.FullName.EndsWith("/")) { continue }
      Assert-VisionMainCondition ($entry.FullName -notmatch '^[\\/]|^[A-Za-z]:|(^|[\\/])\.\.([\\/]|$)') "download contains an unsafe archive path"
      $target = [IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
      $root = [IO.Path]::GetFullPath($Destination).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
      Assert-VisionMainCondition ($target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) "download escapes its staging directory"
      $parent = Split-Path -Parent $target
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
      $input = $entry.Open(); $output = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
      try { $input.CopyTo($output) } finally { $output.Dispose(); $input.Dispose() }
    }
  } finally { $archive.Dispose() }
}

function Get-VisionEligibleMainRuns([object[]]$Runs, [string]$Commit) {
  $eligible = @($Runs | Where-Object { $_.conclusion -ceq "success" -and $_.head_branch -ceq "main" })
  if ($Commit) {
    $Commit = Assert-VisionCommit $Commit
    $eligible = @($eligible | Where-Object { $_.head_sha -ceq $Commit })
  }
  Assert-VisionMainCondition ($eligible.Count -gt 0) "no successful main workflow run was found"
  return @($eligible | Sort-Object { [int64]$_.id } -Descending)
}

function Resolve-VisionMainArtifact([object[]]$Artifacts, [string]$Commit) {
  $matches = @($Artifacts | Where-Object { $_.name -ceq ("vending-vision-main-" + $Commit) -and $_.expired -ne $true })
  Assert-VisionMainCondition ($matches.Count -eq 1) "successful main run must expose exactly one non-expired artifact for $Commit"
  Assert-VisionMainCondition (-not [string]::IsNullOrWhiteSpace([string]$matches[0].archive_download_url)) "main artifact has no download URL"
  return $matches[0]
}

function Find-VisionMainRunArtifact {
  param(
    [object[]]$Runs,
    [string]$Commit,
    [string]$Repository,
    [string]$ApiBaseUrl,
    [scriptblock]$ApiRequest
  )
  foreach ($run in @(Get-VisionEligibleMainRuns $Runs $Commit)) {
    $runCommit = Assert-VisionCommit ([string]$run.head_sha)
    $artifactResponse = & $ApiRequest "$ApiBaseUrl/repos/$Repository/actions/runs/$($run.id)/artifacts?per_page=100"
    $matches = @($artifactResponse.artifacts | Where-Object {
      $_.name -ceq ("vending-vision-main-" + $runCommit) -and $_.expired -ne $true
    })
    if ($matches.Count -eq 0) { continue }
    $artifact = Resolve-VisionMainArtifact @($artifactResponse.artifacts) $runCommit
    return [pscustomobject]@{ run = $run; commit = $runCommit; artifact = $artifact }
  }
  throw "Vision main artifact: no successful main workflow run contains the expected non-expired publishing artifact"
}

function Get-VisionMainArtifactCache {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$CacheRoot,
    [string]$CommitSha,
    [string]$Repository = "hbhjt/vending-vision",
    [string]$ApiBaseUrl = "https://api.github.com",
    [string]$GitHubToken = $env:VISION_GITHUB_TOKEN,
    [scriptblock]$ApiRequest,
    [scriptblock]$DownloadArtifact
  )
  if ([string]::IsNullOrWhiteSpace($GitHubToken)) { $GitHubToken = $env:GH_TOKEN }
  if ([string]::IsNullOrWhiteSpace($GitHubToken)) { $GitHubToken = $env:GITHUB_TOKEN }
  if ($null -eq $ApiRequest) {
    $headers = @{ Accept = "application/vnd.github+json"; "X-GitHub-Api-Version" = "2022-11-28" }
    if (-not [string]::IsNullOrWhiteSpace($GitHubToken)) { $headers.Authorization = "Bearer $GitHubToken" }
    $ApiRequest = { param($Uri) Invoke-RestMethod -Method Get -Uri $Uri -Headers $headers -ErrorAction Stop }
  }
  if ($null -eq $DownloadArtifact) {
    $headers = @{ Accept = "application/vnd.github+json" }
    if (-not [string]::IsNullOrWhiteSpace($GitHubToken)) { $headers.Authorization = "Bearer $GitHubToken" }
    $DownloadArtifact = { param($Uri, $OutFile) Invoke-WebRequest -Uri $Uri -Headers $headers -OutFile $OutFile -ErrorAction Stop }
  }
  $runsUri = "$ApiBaseUrl/repos/$Repository/actions/runs?branch=main&status=success&per_page=100"
  if (-not [string]::IsNullOrWhiteSpace($CommitSha)) { $runsUri += "&head_sha=" + (Assert-VisionCommit $CommitSha) }
  $runResponse = & $ApiRequest $runsUri
  $resolved = Find-VisionMainRunArtifact @($runResponse.workflow_runs) $CommitSha $Repository $ApiBaseUrl $ApiRequest
  $commit = $resolved.commit
  $cacheDirectory = Join-Path $CacheRoot $commit
  if (Test-Path -LiteralPath $cacheDirectory) {
    return Assert-VisionCachedArtifacts $cacheDirectory $commit
  }
  $artifact = $resolved.artifact
  $staging = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-" + [guid]::NewGuid().ToString("N"))
  try {
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    $download = Join-Path $staging "actions-artifact.zip"
    & $DownloadArtifact ([string]$artifact.archive_download_url) $download
    $expanded = Join-Path $staging "expanded"
    New-Item -ItemType Directory -Force -Path $expanded | Out-Null
    Expand-VisionActionArtifact $download $expanded
    foreach ($name in @($script:VisionRuntimeArchive, $script:VisionFixtureArchive, $script:VisionDeliveryManifest)) {
      Assert-VisionMainCondition (Test-Path -LiteralPath (Join-Path $expanded $name) -PathType Leaf) "download is missing $name"
    }
    $manifest = Read-VisionJson (Join-Path $expanded $script:VisionDeliveryManifest) "download manifest"
    Assert-VisionMainCondition ($manifest.schemaVersion -ceq $script:VisionArtifactSchema -and $manifest.commit -ceq $commit) "download manifest does not bind resolved commit $commit"
    New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null
    Move-Item -LiteralPath $expanded -Destination $cacheDirectory -ErrorAction Stop
    return Assert-VisionCachedArtifacts $cacheDirectory $commit
  } finally { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
}

function Expand-VisionRuntimeArchive([string]$ArchivePath, [string]$Destination, [string]$Commit) {
  Assert-VisionArchive $ArchivePath $Commit runtime
  Assert-VisionMainCondition (-not (Test-Path -LiteralPath $Destination)) "runtime destination already exists"
  Expand-VisionActionArtifact $ArchivePath $Destination
  Assert-VisionMainCondition (Test-Path -LiteralPath (Join-Path $Destination "vending-vision.exe") -PathType Leaf) "runtime extraction did not produce vending-vision.exe"
}

function Get-VisionRecordedCameras([object]$Configuration) {
  $cameras = @($Configuration.cameras.top, $Configuration.cameras.front)
  return @($cameras | Where-Object { $_.source -ceq "recorded_video" })
}

function Set-VisionRecordedVideoPaths([object]$Configuration, [string]$FixtureRoot) {
  $recorded = @(Get-VisionRecordedCameras $Configuration)
  if ($recorded.Count -eq 0) { return $Configuration }
  Assert-VisionMainCondition ($recorded.Count -eq 2) "recorded-video configuration must configure both cameras"
  $recordedRoot = Join-Path ([IO.Path]::GetFullPath($FixtureRoot)) "recorded-video"
  foreach ($binding in @(@($Configuration.cameras.top, "top.mp4"), @($Configuration.cameras.front, "front.mp4"))) {
    $binding[0] | Add-Member -NotePropertyName video_path -NotePropertyValue ([IO.Path]::GetFullPath((Join-Path $recordedRoot $binding[1]))) -Force
  }
  return $Configuration
}

function Assert-VisionSiteConfiguration([string]$ConfigurationPath, [string]$FixtureRoot) {
  $configuration = Read-VisionJson $ConfigurationPath "site configuration"
  Assert-VisionMainCondition ($configuration.schemaVersion -ceq "vending-vision-site-config/v1") "site configuration schema is invalid"
  foreach ($name in @("host", "port", "allowed_origins", "cameras")) { Assert-VisionMainCondition ($null -ne $configuration.PSObject.Properties[$name]) "site configuration is missing $name" }
  foreach ($role in @("top", "front")) { Assert-VisionMainCondition ($null -ne $configuration.cameras.PSObject.Properties[$role]) "site configuration is missing $role camera" }
  $recorded = @(Get-VisionRecordedCameras $configuration)
  if ($recorded.Count -gt 0) {
    Assert-VisionMainCondition ($recorded.Count -eq 2) "recorded-video configuration must configure both cameras"
    Assert-VisionMainCondition (-not [string]::IsNullOrWhiteSpace($FixtureRoot)) "recorded-video configuration requires a fixture root"
    foreach ($camera in $recorded) {
      Assert-VisionMainCondition (-not [string]::IsNullOrWhiteSpace([string]$camera.video_path)) "recorded-video configuration is missing video_path"
      $configuredVideo = [string]$camera.video_path
      $video = if ([IO.Path]::IsPathRooted($configuredVideo)) {
        [IO.Path]::GetFullPath($configuredVideo)
      } else {
        [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ConfigurationPath) $configuredVideo))
      }
      $root = [IO.Path]::GetFullPath($FixtureRoot).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
      Assert-VisionMainCondition ($video.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $video -PathType Leaf)) "recorded-video path must be an extracted fixture"
    }
  }
  return $configuration
}

function Get-VisionMainUris([string]$HostName, [int]$Port) {
  $authority = if ($HostName.Contains(":")) { "[$HostName]" } else { $HostName }
  return [pscustomobject]@{
    httpBaseUrl = "http://${authority}:$Port"
    webSocketUrl = "ws://${authority}:$Port/ws"
  }
}

function Test-VisionMainProtocolTimestamp($Value) {
  if ($Value -is [DateTime]) {
    return $Value.Kind -eq [DateTimeKind]::Utc
  }
  if ($Value -isnot [string] -or $Value -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$') {
    return $false
  }
  $timestampWithoutFraction = [regex]::Replace($Value, '\.\d+(?=Z$)', '')
  [DateTime]$parsed = [DateTime]::MinValue
  return [DateTime]::TryParseExact(
    $timestampWithoutFraction,
    "yyyy-MM-dd'T'HH:mm:ss'Z'",
    [Globalization.CultureInfo]::InvariantCulture,
    ([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal),
    [ref]$parsed
  )
}

function Receive-VisionMainTextMessage($Socket, $CancellationToken, [int]$MaxMessageBytes = 65536) {
  $messageStream = New-Object IO.MemoryStream
  try {
    do {
      $buffer = New-Object byte[] 4096
      $received = $Socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $CancellationToken).GetAwaiter().GetResult()
      Assert-VisionMainCondition ($received.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Text) "machine WebSocket handshake must return a text message"
      Assert-VisionMainCondition (($messageStream.Length + $received.Count) -le $MaxMessageBytes) "machine WebSocket handshake exceeds $MaxMessageBytes bytes"
      if ($received.Count -gt 0) { $messageStream.Write($buffer, 0, $received.Count) }
    } while (-not $received.EndOfMessage)
    return [Text.Encoding]::UTF8.GetString($messageStream.ToArray())
  } finally {
    $messageStream.Dispose()
  }
}

function Invoke-VisionMainProbe([string]$ConfigurationPath, [int]$TimeoutSeconds = 30, [string]$FixtureRoot) {
  $configuration = Assert-VisionSiteConfiguration $ConfigurationPath $FixtureRoot
  $recordedCameras = @(Get-VisionRecordedCameras $configuration)
  $uris = Get-VisionMainUris -HostName ([string]$configuration.host) -Port ([int]$configuration.port)
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastError = $null
  do {
    try {
      $health = Invoke-RestMethod -Uri "$($uris.httpBaseUrl)/health" -TimeoutSec 5 -ErrorAction Stop
      Assert-VisionMainCondition ($health.status -in @("ok", "degraded")) "health status is not ok or degraded"
      Assert-VisionMainCondition ($health.protocol -ceq "vem.vision.v1" -and $health.modelReady -is [bool] -and $health.modelReady -eq $true -and $health.cameraReady -is [bool]) "health does not report the Vision protocol and loaded models"
      if ($recordedCameras.Count -gt 0) {
        Assert-VisionMainCondition ($health.status -ceq "ok" -and $health.cameraReady -eq $true) "recorded-video cameras are not ready"
      }
      $socket = [Net.WebSockets.ClientWebSocket]::new(); $cancellation = [Threading.CancellationTokenSource]::new(); $cancellation.CancelAfter(5000)
      try {
        [void]$socket.ConnectAsync([Uri]$uris.webSocketUrl, $cancellation.Token).GetAwaiter().GetResult()
        $hello = @{ protocol = "vem.vision.v1"; type = "vision.hello"; messageId = "vem-installer-probe"; timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"); payload = @{ clientRole = "machine"; protocolVersion = 1; capabilities = @("profile_push", "presence_status", "person_departed", "try_on_session") } } | ConvertTo-Json -Compress -Depth 8
        $bytes = [Text.Encoding]::UTF8.GetBytes($hello); [void]$socket.SendAsync([ArraySegment[byte]]::new($bytes), [Net.WebSockets.WebSocketMessageType]::Text, $true, $cancellation.Token).GetAwaiter().GetResult()
        $ready = Receive-VisionMainTextMessage $socket $cancellation.Token | ConvertFrom-Json -ErrorAction Stop
        $requiredCapabilities = @("profile_push", "presence_status", "person_departed", "try_on_session")
        $readyValid = (
          $null -ne $ready -and
          $ready.protocol -is [string] -and $ready.protocol -ceq "vem.vision.v1" -and
          $ready.type -is [string] -and $ready.type -ceq "vision.ready" -and
          $ready.messageId -is [string] -and -not [string]::IsNullOrWhiteSpace($ready.messageId) -and $ready.messageId.Length -le 128 -and
          (Test-VisionMainProtocolTimestamp $ready.timestamp) -and
          $ready.payload -is [System.Management.Automation.PSCustomObject] -and
          $ready.payload.serverName -is [string] -and -not [string]::IsNullOrWhiteSpace($ready.payload.serverName) -and $ready.payload.serverName.Length -le 128 -and
          $ready.payload.cameraReady -is [bool] -and
          $ready.payload.modelReady -is [bool] -and $ready.payload.modelReady -eq $true -and
          $ready.payload.capabilities -is [array] -and
          (@($ready.payload.capabilities | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) -or $_.Length -gt 64 }).Count -eq 0) -and
          (@($requiredCapabilities | Where-Object { $ready.payload.capabilities -cnotcontains $_ }).Count -eq 0)
        )
        if (-not $readyValid) {
          throw "machine WebSocket handshake is invalid"
        }
        if ($recordedCameras.Count -gt 0) { Assert-VisionMainCondition ($ready.payload.cameraReady -eq $true) "recorded-video camera readiness is absent from the machine handshake" }
        return [pscustomobject]@{ health = $health; ready = $ready }
      } finally { $socket.Dispose(); $cancellation.Dispose() }
    } catch {
      if ($null -eq $lastError -or $_.Exception.Message -notmatch "Connection refused") {
        $lastError = $_
      }
      Start-Sleep -Milliseconds 500
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Vision main artifact: health and protocol probe failed: $($lastError.Exception.Message)"
}

function Stop-VisionMainTask([string]$TaskName = "StartVisionServer", [string]$TaskPath = "\VEM\") {
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if ($null -ne $task -and [string]$task.State -eq "Running") { Stop-ScheduledTask -InputObject $task -ErrorAction Stop }
  Get-Process -Name "vending-vision" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction Stop
}

function Ensure-VisionMainTask([string]$LauncherPath, [string]$WorkingDirectory, [string]$TaskUser, [string]$TaskName = "StartVisionServer", [string]$TaskPath = "\VEM\") {
  Assert-VisionMainCondition (-not [string]::IsNullOrWhiteSpace($TaskUser)) "scheduled task user is required"
  $taskIdentity = (($TaskPath.Trim("\") + "\" + $TaskName).Trim("\"))
  $userXml = [Security.SecurityElement]::Escape($TaskUser)
  $launcherXml = [Security.SecurityElement]::Escape($LauncherPath)
  $workingDirectoryXml = [Security.SecurityElement]::Escape($WorkingDirectory)
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Author>VEM Runtime</Author><Description>$TaskName</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>$userXml</UserId><Delay>PT10S</Delay></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>$userXml</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
    <Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
  </Settings>
  <Actions Context="Author"><Exec><Command>C:\Windows\System32\cmd.exe</Command><Arguments>/c &quot;&quot;$launcherXml&quot;&quot;</Arguments><WorkingDirectory>$workingDirectoryXml</WorkingDirectory></Exec></Actions>
</Task>
"@
  $taskXml = [IO.Path]::GetTempFileName() + ".xml"
  try {
    [IO.File]::WriteAllText($taskXml, $xml, [Text.Encoding]::Unicode)
    & schtasks.exe /Create /TN $taskIdentity /XML $taskXml /F | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Vision main artifact: failed to create scheduled task $taskIdentity" }
  } finally { Remove-Item -LiteralPath $taskXml -Force -ErrorAction SilentlyContinue }
}

function Start-VisionMainTask([string]$TaskName = "StartVisionServer", [string]$TaskPath = "\VEM\") {
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction Stop
  Start-ScheduledTask -InputObject $task -ErrorAction Stop
}

function Ensure-VisionMainRuntimeWorkDirectory([string]$RuntimeWorkDirectory, [string]$TaskUser) {
  Assert-VisionMainCondition (-not [string]::IsNullOrWhiteSpace($TaskUser)) "scheduled task user is required"
  New-Item -ItemType Directory -Force -Path $RuntimeWorkDirectory | Out-Null
  & icacls.exe $RuntimeWorkDirectory /grant:r "${TaskUser}:(OI)(CI)(M)" /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "Vision main artifact: failed to grant runtime work-directory access to $TaskUser"
  }
}

function Write-VisionMainLauncher([string]$AppDirectory, [string]$ConfigurationPath, [string]$RuntimeWorkDirectory, [string]$LauncherPath) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LauncherPath) | Out-Null
  $content = "@echo off`r`nsetlocal`r`nset `"VISION_WORKDIR=$RuntimeWorkDirectory`"`r`ncd /d `"$AppDirectory`"`r`n`"$AppDirectory\vending-vision.exe`" --config `"$ConfigurationPath`"`r`n"
  [IO.File]::WriteAllText($LauncherPath, $content, [Text.Encoding]::ASCII)
}

function Install-VisionMainArtifact {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$RuntimeArchive,
    [Parameter(Mandatory = $true)][string]$Commit,
    [Parameter(Mandatory = $true)][string]$SiteConfigurationPath,
    [string]$FixtureArchive,
    [string]$AppDirectory = "C:\VEM\vision\app",
    [string]$SiteConfigurationDestination = "C:\ProgramData\VEM\vision\site.json",
    [string]$FixtureDirectory = "C:\ProgramData\VEM\vision\fixtures",
    [string]$RuntimeWorkDirectory = "C:\ProgramData\VEM\vision\runtime",
    [string]$LauncherPath = "C:\VEM\bringup\start_vision.bat",
    [string]$TaskName = "StartVisionServer",
    [string]$TaskPath = "\VEM\",
    [string]$TaskUser = "VEMKiosk",
    [int]$ProbeTimeoutSeconds = 30
  )
  $Commit = Assert-VisionCommit $Commit
  Assert-VisionArchive $RuntimeArchive $Commit runtime
  $staging = "$AppDirectory.staging-$([guid]::NewGuid().ToString('N'))"
  Stop-VisionMainTask $TaskName $TaskPath
  try {
    Expand-VisionRuntimeArchive $RuntimeArchive $staging $Commit
    $sourceConfiguration = Read-VisionJson $SiteConfigurationPath "site configuration"
    Assert-VisionMainCondition ($sourceConfiguration.schemaVersion -ceq "vending-vision-site-config/v1") "site configuration schema is invalid"
    $recordedSourceCameras = @(Get-VisionRecordedCameras $sourceConfiguration)
    $usesFixtures = $recordedSourceCameras.Count -gt 0
    $resolvedFixtureRoot = $null
    if ($usesFixtures) {
      Assert-VisionMainCondition (-not [string]::IsNullOrWhiteSpace($FixtureArchive)) "recorded-video configuration requires the separate fixture archive"
      $resolvedFixtureRoot = Join-Path $FixtureDirectory $Commit
      Assert-VisionArchive $FixtureArchive $Commit fixtures
      if (-not (Test-Path -LiteralPath $resolvedFixtureRoot)) { Expand-VisionActionArtifact $FixtureArchive $resolvedFixtureRoot }
    }
    if (Test-Path -LiteralPath $AppDirectory) { Remove-Item -LiteralPath $AppDirectory -Recurse -Force -ErrorAction Stop }
    Move-Item -LiteralPath $staging -Destination $AppDirectory -ErrorAction Stop
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $SiteConfigurationDestination) | Out-Null
    if ($usesFixtures) {
      $sourceConfiguration = Set-VisionRecordedVideoPaths $sourceConfiguration $resolvedFixtureRoot
      [IO.File]::WriteAllText($SiteConfigurationDestination, ($sourceConfiguration | ConvertTo-Json -Depth 32), [Text.UTF8Encoding]::new($false))
    } else {
      Copy-Item -LiteralPath $SiteConfigurationPath -Destination $SiteConfigurationDestination -Force -ErrorAction Stop
    }
    Assert-VisionSiteConfiguration $SiteConfigurationDestination $resolvedFixtureRoot | Out-Null
    Ensure-VisionMainRuntimeWorkDirectory $RuntimeWorkDirectory $TaskUser
    Write-VisionMainLauncher $AppDirectory $SiteConfigurationDestination $RuntimeWorkDirectory $LauncherPath
    Ensure-VisionMainTask -LauncherPath $LauncherPath -WorkingDirectory $AppDirectory -TaskUser $TaskUser -TaskName $TaskName -TaskPath $TaskPath
    Start-VisionMainTask $TaskName $TaskPath
    $probe = Invoke-VisionMainProbe $SiteConfigurationDestination $ProbeTimeoutSeconds $resolvedFixtureRoot
    $healthVersion = if ($null -ne $probe.health.PSObject.Properties["version"]) { [string]$probe.health.version } else { $null }
    [IO.File]::WriteAllText((Join-Path (Split-Path -Parent $SiteConfigurationDestination) "installed.json"), (@{ schemaVersion = "vem-vision-installed/v1"; commit = $Commit; installedAt = [DateTime]::UtcNow.ToString("o"); appDirectory = $AppDirectory; runtime = "vending-vision.exe"; runtimeWorkDirectory = $RuntimeWorkDirectory; health = @{ version = $healthVersion } } | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    return [pscustomobject]@{ commit = $Commit; appDirectory = $AppDirectory; siteConfiguration = $SiteConfigurationDestination; probe = $probe }
  } finally {
    if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
  }
}

Export-ModuleMember -Function Get-VisionMainArtifactCache, Resolve-VisionMainRun, Resolve-VisionMainArtifact, Assert-VisionCachedArtifacts, Assert-VisionArchive, Assert-VisionSiteConfiguration, Get-VisionMainUris, Invoke-VisionMainProbe, Install-VisionMainArtifact
