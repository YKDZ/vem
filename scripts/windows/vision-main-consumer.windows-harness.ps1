[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$modulePath = Join-Path $PSScriptRoot "vision-main-artifacts.psm1"
Import-Module $modulePath -Force

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Get-Sha256([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function New-Zip([string]$Source, [string]$Destination) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [IO.Compression.ZipFile]::CreateFromDirectory($Source, $Destination)
}

function New-VisionArchiveFixture([string]$Root, [string]$Commit) {
  $runtimeSource = Join-Path $Root "runtime-source"
  $fixtureSource = Join-Path $Root "fixture-source"
  $artifactSource = Join-Path $Root "artifact-source"
  New-Item -ItemType Directory -Force -Path $runtimeSource, (Join-Path $fixtureSource "recorded-video"), $artifactSource | Out-Null
  $manifest = @{ schemaVersion = "vending-vision-main-artifacts/v1"; commit = $Commit; runtimeArchive = "vending-vision-windows-x86_64.zip"; fixtureArchive = "vending-vision-test-fixtures.zip" } | ConvertTo-Json
  [IO.File]::WriteAllText((Join-Path $runtimeSource "vending-vision.exe"), "fixture", [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText((Join-Path $runtimeSource "vision-artifact.json"), $manifest, [Text.Encoding]::UTF8)
  foreach ($name in @("top.mp4", "front.mp4", "expected-results.json")) { [IO.File]::WriteAllText((Join-Path $fixtureSource "recorded-video\$name"), "fixture", [Text.Encoding]::UTF8) }
  [IO.File]::WriteAllText((Join-Path $fixtureSource "vision-artifact.json"), $manifest, [Text.Encoding]::UTF8)
  $runtime = Join-Path $artifactSource "vending-vision-windows-x86_64.zip"
  $fixtures = Join-Path $artifactSource "vending-vision-test-fixtures.zip"
  New-Zip $runtimeSource $runtime
  New-Zip $fixtureSource $fixtures
  $delivery = @{ schemaVersion = "vending-vision-main-artifacts/v1"; commit = $Commit; runtime = @{ file = "vending-vision-windows-x86_64.zip"; sha256 = (Get-FileHash $runtime -Algorithm SHA256).Hash.ToLowerInvariant() }; fixtures = @{ file = "vending-vision-test-fixtures.zip"; sha256 = (Get-FileHash $fixtures -Algorithm SHA256).Hash.ToLowerInvariant() } } | ConvertTo-Json -Depth 5
  [IO.File]::WriteAllText((Join-Path $artifactSource "vending-vision-main-artifacts.json"), $delivery, [Text.Encoding]::UTF8)
  $actionZip = Join-Path $Root "actions-artifact.zip"
  New-Zip $artifactSource $actionZip
  return [pscustomobject]@{ runtime = $runtime; fixtures = $fixtures; actionZip = $actionZip }
}

function Start-VisionProbeServer([int]$Port, [string]$Status = "ok", [bool]$CameraReady = $true, [string]$Version = "9.8.7", [bool]$ExpectWebSocket = $true, [string]$ReadyJson = "", [int]$FragmentBytes = 0) {
  return Start-Job -ArgumentList $Port, $Status, $CameraReady, $Version, $ExpectWebSocket, $ReadyJson, $FragmentBytes -ScriptBlock {
    param($Port, $Status, $CameraReady, $Version, $ExpectWebSocket, $ReadyJson, $FragmentBytes)
    function Write-WebSocketFrame($Stream, [byte[]]$Payload, [int]$Opcode, [bool]$Final) {
      $header = [Collections.Generic.List[byte]]::new()
      $firstByte = [byte]$Opcode
      if ($Final) { $firstByte = $firstByte -bor 0x80 }
      $header.Add($firstByte)
      if ($Payload.Length -lt 126) {
        $header.Add([byte]$Payload.Length)
      } elseif ($Payload.Length -le 65535) {
        $header.Add(126)
        $header.Add([byte](($Payload.Length -shr 8) -band 0xff))
        $header.Add([byte]($Payload.Length -band 0xff))
      } else {
        throw "harness WebSocket payload is too large"
      }
      $headerBytes = $header.ToArray()
      $Stream.Write($headerBytes, 0, $headerBytes.Length)
      $Stream.Write($Payload, 0, $Payload.Length)
    }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    try {
      $client = $listener.AcceptTcpClient(); $stream = $client.GetStream(); $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 4096, $true)
      try { while (($line = $reader.ReadLine()) -ne "") {} } finally { $reader.Dispose() }
      $cameraReadyJson = if ($CameraReady) { "true" } else { "false" }
      $body = "{`"status`":`"$Status`",`"protocol`":`"vem.vision.v1`",`"version`":`"$Version`",`"cameraReady`":$cameraReadyJson,`"modelReady`":true}"
      $response = "HTTP/1.1 200 OK`r`nContent-Type: application/json`r`nContent-Length: $($body.Length)`r`nConnection: close`r`n`r`n$body"
      $bytes = [Text.Encoding]::ASCII.GetBytes($response); $stream.Write($bytes, 0, $bytes.Length); $client.Dispose()
      if (-not $ExpectWebSocket) { return }

      $client = $listener.AcceptTcpClient(); $stream = $client.GetStream(); $reader = [IO.StreamReader]::new($stream, [Text.Encoding]::ASCII, $false, 4096, $true); $key = $null
      try { while (($line = $reader.ReadLine()) -ne "") { if ($line -match '^Sec-WebSocket-Key:\s*(.+)$') { $key = $Matches[1].Trim() } } } finally { $reader.Dispose() }
      $acceptBytes = [Security.Cryptography.SHA1]::Create().ComputeHash([Text.Encoding]::ASCII.GetBytes($key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")); $accept = [Convert]::ToBase64String($acceptBytes)
      $response = "HTTP/1.1 101 Switching Protocols`r`nUpgrade: websocket`r`nConnection: Upgrade`r`nSec-WebSocket-Accept: $accept`r`n`r`n"; $bytes = [Text.Encoding]::ASCII.GetBytes($response); $stream.Write($bytes, 0, $bytes.Length)
      $header = [byte[]]::new(2); [void]$stream.Read($header, 0, 2); $length = $header[1] -band 0x7f; if ($length -eq 126) { $extended = [byte[]]::new(2); [void]$stream.Read($extended, 0, 2); $length = ($extended[0] -shl 8) + $extended[1] }; $mask = [byte[]]::new(4); [void]$stream.Read($mask, 0, 4); $payload = [byte[]]::new($length); [void]$stream.Read($payload, 0, $length)
      if ([string]::IsNullOrWhiteSpace($ReadyJson)) {
        $ReadyJson = [ordered]@{
          protocol = "vem.vision.v1"
          type = "vision.ready"
          messageId = "ready-harness"
          timestamp = "2026-07-17T00:00:00.000Z"
          payload = [ordered]@{
            serverName = "vision-harness"
            serverVersion = $Version
            cameraReady = $CameraReady
            modelReady = $true
            capabilities = @("profile_push", "presence_status", "person_departed", "try_on_session")
          }
        } | ConvertTo-Json -Compress -Depth 8
      }
      $ready = [Text.Encoding]::UTF8.GetBytes($ReadyJson)
      if ($FragmentBytes -gt 0 -and $FragmentBytes -lt $ready.Length) {
        Write-WebSocketFrame $stream ([byte[]]$ready[0..($FragmentBytes - 1)]) 1 $false
        Write-WebSocketFrame $stream ([byte[]]$ready[$FragmentBytes..($ready.Length - 1)]) 0 $true
      } else {
        Write-WebSocketFrame $stream $ready 1 $true
      }
      $client.Dispose()
    } finally { $listener.Stop() }
  }
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-harness-" + [guid]::NewGuid().ToString("N"))
try {
  $commit = "0123456789abcdef0123456789abcdef01234567"
  $unrelatedCommit = "fedcba9876543210fedcba9876543210fedcba98"
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $archives = New-VisionArchiveFixture $root $commit
  $apiCalls = [Collections.Generic.List[string]]::new(); $downloads = [Collections.Generic.List[string]]::new()
  $api = {
    param($Uri)
    $apiCalls.Add($Uri) | Out-Null
    if ($Uri -match '/actions/runs\?') {
      return @{ workflow_runs = @(
        @{ id = 9; head_sha = $unrelatedCommit; head_branch = "main"; conclusion = "success" },
        @{ id = 5; head_sha = $commit; head_branch = "main"; conclusion = "success" }
      ) }
    }
    if ($Uri -match '/actions/runs/9/artifacts') {
      return @{ artifacts = @(@{ name = "unrelated-success-output"; expired = $false; archive_download_url = "fixture://unrelated" }) }
    }
    return @{ artifacts = @(@{ name = "vending-vision-main-$commit"; expired = $false; archive_download_url = "fixture://artifact" }) }
  }.GetNewClosure()
  $download = { param($Uri, $Destination) $downloads.Add($Uri) | Out-Null; Copy-Item -LiteralPath $archives.actionZip -Destination $Destination }.GetNewClosure()
  $cache = Get-VisionMainArtifactCache -CacheRoot (Join-Path $root "cache") -ApiRequest $api -DownloadArtifact $download
  Assert-True ($cache.commit -eq $commit) "resolver did not select the newest main run containing the expected artifact"
  Assert-True (($apiCalls -join "`n") -match '/actions/runs/9/artifacts') "resolver did not inspect the newest successful run"
  Assert-True (($apiCalls -join "`n") -match '/actions/runs/5/artifacts') "resolver did not continue past an unrelated successful run"
  Assert-True ($cache.cacheDirectory -eq (Join-Path (Join-Path $root "cache") $commit)) "cache was not keyed only by commit SHA"
  Assert-True ($downloads.Count -eq 1) "resolver did not download exactly one Actions artifact"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $cache.cacheDirectory "recorded-video"))) "fixtures leaked into the runtime cache root"

  $global:VisionHarnessTaskRegistered = $false
  $global:VisionHarnessTaskCreateArguments = @()
  $global:VisionHarnessTaskXml = ""
  $global:VisionHarnessTaskStarts = 0
  $global:VisionHarnessTaskRegistrations = 0
  $global:VisionHarnessAclArguments = @()
  $global:VisionHarnessEvents = [Collections.Generic.List[string]]::new()
  $global:VisionHarnessStoppedProcessIds = [Collections.Generic.List[int]]::new()
  $global:VisionHarnessOwnedVisionPath = Join-Path $root "vision\app\vending-vision.exe"
  $global:VisionHarnessSiteConfigurationPath = Join-Path $root "program-data\vision\site.json"
  function global:Get-ScheduledTask { param($TaskName, $TaskPath) if ($global:VisionHarnessTaskRegistered) { return [pscustomobject]@{ State = "Ready" } } return $null }
  function global:Stop-ScheduledTask { param($InputObject) }
  function global:Start-ScheduledTask { param($InputObject) $global:VisionHarnessTaskStarts++; $global:VisionHarnessEvents.Add("task-start") | Out-Null }
  function global:Get-Process {
    param($ErrorAction)
    return @(
      [pscustomobject]@{ Id = 4101; Path = $global:VisionHarnessOwnedVisionPath },
      [pscustomobject]@{ Id = 4102; Path = (Join-Path $root "unrelated\vending-vision.exe") }
    )
  }
  function global:Get-CimInstance {
    param($ClassName, $Filter, $ErrorAction)
    return @(
      [pscustomobject]@{ ProcessId = 4101; ExecutablePath = $global:VisionHarnessOwnedVisionPath; CommandLine = ('"' + $global:VisionHarnessOwnedVisionPath + '" --config "' + $global:VisionHarnessSiteConfigurationPath + '"') },
      [pscustomobject]@{ ProcessId = 4102; ExecutablePath = (Join-Path $root "unrelated\vending-vision.exe"); CommandLine = '"C:\\unrelated\\vending-vision.exe" --config "C:\\unrelated\\site.json"' }
    ) | Where-Object { -not $global:VisionHarnessStoppedProcessIds.Contains([int]$_.ProcessId) }
  }
  function global:Stop-Process {
    param([int]$Id, [switch]$Force, $ErrorAction)
    $global:VisionHarnessStoppedProcessIds.Add($Id) | Out-Null
  }
  function global:icacls.exe {
    $global:VisionHarnessAclArguments = @($args)
    $global:VisionHarnessEvents.Add("runtime-acl") | Out-Null
    $global:LASTEXITCODE = 0
  }
  function global:schtasks.exe {
    $global:VisionHarnessTaskCreateArguments = @($args)
    $xmlIndex = [Array]::IndexOf([object[]]$args, "/XML")
    if ($xmlIndex -ge 0) { $global:VisionHarnessTaskXml = Get-Content -LiteralPath $args[$xmlIndex + 1] -Raw }
    $global:VisionHarnessTaskRegistered = $true
    $global:VisionHarnessTaskRegistrations++
    $global:VisionHarnessEvents.Add("task-register") | Out-Null
    $global:LASTEXITCODE = 0
  }

  $ipv4Uris = Get-VisionMainUris -HostName "127.0.0.1" -Port 7892
  $ipv6Uris = Get-VisionMainUris -HostName "::1" -Port 7892
  Assert-True ($ipv4Uris.httpBaseUrl -eq "http://127.0.0.1:7892") "IPv4 URI authority changed unexpectedly"
  Assert-True ($ipv6Uris.httpBaseUrl -eq "http://[::1]:7892") "IPv6 HTTP URI authority was not bracketed"
  Assert-True ($ipv6Uris.webSocketUrl -eq "ws://[::1]:7892/ws") "IPv6 WebSocket URI authority was not bracketed"
  $config = Join-Path $root "site-input.json"
  @{ schemaVersion = "vending-vision-site-config/v1"; host = "127.0.0.1"; port = 17892; allowed_origins = @("http://127.0.0.1:17892"); cameras = @{ top = @{ source = "dshow"; role = "presence" }; front = @{ source = "dshow"; role = "profile_tryon" } } } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $config -Encoding utf8
  $runtimeWorkDirectory = Join-Path $root "program-data\vision\runtime"
  $server = Start-VisionProbeServer 17892 "degraded" $false "9.8.7"
  Start-Sleep -Milliseconds 200
  try {
    $install = Install-VisionMainArtifact -RuntimeArchive $cache.runtimeArchive -Commit $commit -SiteConfigurationPath $config -AppDirectory (Join-Path $root "vision\app") -SiteConfigurationDestination (Join-Path $root "program-data\vision\site.json") -RuntimeWorkDirectory $runtimeWorkDirectory -LauncherPath (Join-Path $root "bringup\start_vision.bat") -ProbeTimeoutSeconds 5
  } catch {
    $serverDiagnostic = @(Receive-Job $server -Keep -ErrorAction SilentlyContinue) -join "`n"
    throw "dshow install failed; probe server state=$($server.State), diagnostic=$serverDiagnostic, error=$($_.Exception.Message)"
  }
  Wait-Job $server | Out-Null; Receive-Job $server | Out-Null; Remove-Job $server
  Assert-True (Test-Path -LiteralPath (Join-Path $install.appDirectory "vending-vision.exe")) "installer did not replace the fixed app directory"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $install.appDirectory "recorded-video"))) "installer put fixture files into the production app"
  Assert-True (Test-Path -LiteralPath $install.siteConfiguration) "installer did not write external site configuration"
  Assert-True (Test-Path -LiteralPath (Join-Path $root "bringup\start_vision.bat")) "installer did not write the scheduled-task launcher"
  Assert-True $global:VisionHarnessTaskRegistered "clean install did not create StartVisionServer"
  Assert-True ($global:VisionHarnessTaskStarts -eq 1) "clean install did not start the created Vision task"
  Assert-True ($global:VisionHarnessStoppedProcessIds -contains 4101) "installer did not stop the canonical app-directory Vision process"
  Assert-True (-not ($global:VisionHarnessStoppedProcessIds -contains 4102)) "installer stopped an unrelated same-name Vision process"
  Assert-True (($global:VisionHarnessTaskCreateArguments -join " ") -match 'VEM\\StartVisionServer') "created task did not use the fixed Vision task name"
  $taskDocument = [xml]$global:VisionHarnessTaskXml
  Assert-True ($taskDocument.Task.Actions.Exec.Command -eq "C:\Windows\System32\cmd.exe") "created task XML has an invalid executable"
  Assert-True ($global:VisionHarnessTaskXml -match [regex]::Escape((Join-Path $root "bringup\start_vision.bat"))) "created task did not own the fixed launcher"
  Assert-True ($global:VisionHarnessTaskXml -match [regex]::Escape((Join-Path $root "vision\app"))) "created task did not use the fixed app working directory"
  Assert-True ($taskDocument.Task.Actions.Exec.WorkingDirectory -eq (Join-Path $root "vision\app")) "created task did not preserve the fixed app working directory"
  Assert-True (Test-Path -LiteralPath $runtimeWorkDirectory) "clean install did not create a Vision runtime work directory"
  Assert-True (($global:VisionHarnessAclArguments -join " ") -match [regex]::Escape($runtimeWorkDirectory)) "clean install did not grant the runtime work directory"
  Assert-True (($global:VisionHarnessAclArguments -join " ") -match "VEMKiosk:\(OI\)\(CI\)\(M\)") "clean install did not grant VEMKiosk modify access to the runtime work directory"
  Assert-True ($global:VisionHarnessEvents.IndexOf("runtime-acl") -lt $global:VisionHarnessEvents.IndexOf("task-register")) "runtime work-directory access was not established before task registration"
  Assert-True ($global:VisionHarnessEvents.IndexOf("task-register") -lt $global:VisionHarnessEvents.IndexOf("task-start")) "Vision task started before it was registered"
  $launcher = Get-Content -LiteralPath (Join-Path $root "bringup\start_vision.bat") -Raw
  Assert-True ($launcher -match [regex]::Escape("VISION_WORKDIR=$runtimeWorkDirectory")) "launcher did not set the explicit runtime work directory"
  $installedRecord = Get-Content -LiteralPath (Join-Path $root "program-data\vision\installed.json") -Raw | ConvertFrom-Json
  Assert-True ($installedRecord.schemaVersion -eq "vem-vision-installed/v1") "install record omitted the fixed-app schema"
  Assert-True ($installedRecord.appDirectory -eq (Join-Path $root "vision\app")) "install record omitted the fixed app directory"
  Assert-True ($installedRecord.runtimeWorkDirectory -eq $runtimeWorkDirectory) "install record omitted the runtime work directory"
  Assert-True ($installedRecord.health.version -eq "9.8.7") "install record omitted the runtime health version diagnostic"

  function Assert-VisionProbeRejected([string]$Name, [int]$Port, [string]$ReadyJson) {
    $server = Start-VisionProbeServer $Port "ok" $true "9.8.7" $true $ReadyJson
    Start-Sleep -Milliseconds 200
    $rejected = $false
    try {
      Invoke-VisionMainProbe -ConfigurationPath $install.siteConfiguration -TimeoutSeconds 1 | Out-Null
    } catch {
      $rejected = $true
    }
    Wait-Job $server | Out-Null
    Receive-Job $server | Out-Null
    Remove-Job $server
    Assert-True $rejected "$Name was accepted by the strict Vision WebSocket probe"
  }

  $fragmentedServer = Start-VisionProbeServer 17892 "ok" $true "9.8.7" $true "" 32
  Start-Sleep -Milliseconds 200
  $fragmentedProbe = Invoke-VisionMainProbe -ConfigurationPath $install.siteConfiguration -TimeoutSeconds 5
  Wait-Job $fragmentedServer | Out-Null; Receive-Job $fragmentedServer | Out-Null; Remove-Job $fragmentedServer
  Assert-True ($fragmentedProbe.ready.type -eq "vision.ready") "fragmented Vision ready envelope was not assembled"

  $independentVersionReady = '{"protocol":"vem.vision.v1","type":"vision.ready","messageId":"ready-version-diagnostic","timestamp":"2026-07-17T00:00:00.000Z","payload":{"serverName":"vision-harness","serverVersion":"independent-version","cameraReady":true,"modelReady":true,"capabilities":["profile_push","presence_status","person_departed","try_on_session"]}}'
  $versionDiagnosticServer = Start-VisionProbeServer 17892 "ok" $true "9.8.7" $true $independentVersionReady
  Start-Sleep -Milliseconds 200
  $versionDiagnosticProbe = Invoke-VisionMainProbe -ConfigurationPath $install.siteConfiguration -TimeoutSeconds 5
  Wait-Job $versionDiagnosticServer | Out-Null; Receive-Job $versionDiagnosticServer | Out-Null; Remove-Job $versionDiagnosticServer
  Assert-True ($versionDiagnosticProbe.ready.payload.serverVersion -eq "independent-version") "probe unexpectedly gated readiness on server version"

  Assert-VisionProbeRejected "malformed ready envelope" 17892 '{"protocol":"vem.vision.v2","type":"vision.ready","messageId":"ready-malformed","timestamp":"2026-07-17T00:00:00.000Z","payload":{"serverName":"vision-harness","cameraReady":true,"modelReady":true,"capabilities":["profile_push","presence_status","person_departed","try_on_session"]}}'
  Assert-VisionProbeRejected "string cameraReady" 17892 '{"protocol":"vem.vision.v1","type":"vision.ready","messageId":"ready-camera-string","timestamp":"2026-07-17T00:00:00.000Z","payload":{"serverName":"vision-harness","cameraReady":"true","modelReady":true,"capabilities":["profile_push","presence_status","person_departed","try_on_session"]}}'
  Assert-VisionProbeRejected "string modelReady" 17892 '{"protocol":"vem.vision.v1","type":"vision.ready","messageId":"ready-model-string","timestamp":"2026-07-17T00:00:00.000Z","payload":{"serverName":"vision-harness","cameraReady":true,"modelReady":"true","capabilities":["profile_push","presence_status","person_departed","try_on_session"]}}'
  Assert-VisionProbeRejected "missing try-on capability" 17892 '{"protocol":"vem.vision.v1","type":"vision.ready","messageId":"ready-missing-tryon","timestamp":"2026-07-17T00:00:00.000Z","payload":{"serverName":"vision-harness","cameraReady":true,"modelReady":true,"capabilities":["profile_push","presence_status","person_departed"]}}'

  $recordedConfig = Join-Path $root "recorded-site-input.json"
  @{ schemaVersion = "vending-vision-site-config/v1"; host = "127.0.0.1"; port = 17893; allowed_origins = @("http://127.0.0.1:17893"); cameras = @{ top = @{ source = "recorded_video"; role = "presence"; video_path = "source-relative/top.mp4" }; front = @{ source = "recorded_video"; role = "profile_tryon"; video_path = "source-relative/front.mp4" } } } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $recordedConfig -Encoding utf8
  $missingFixtureRejected = $false
  try { Install-VisionMainArtifact -RuntimeArchive $cache.runtimeArchive -Commit $commit -SiteConfigurationPath $recordedConfig -AppDirectory (Join-Path $root "vision\app") -SiteConfigurationDestination (Join-Path $root "program-data\vision\site.json") -LauncherPath (Join-Path $root "bringup\start_vision.bat") -ProbeTimeoutSeconds 1 | Out-Null } catch { $missingFixtureRejected = $true }
  Assert-True $missingFixtureRejected "recorded-video configuration did not require the separate fixture archive"
  $server = Start-VisionProbeServer 17893 "degraded" $false "9.8.8" $false
  Start-Sleep -Milliseconds 200
  $recordedCameraRejected = $false
  try { Install-VisionMainArtifact -RuntimeArchive $cache.runtimeArchive -Commit $commit -SiteConfigurationPath $recordedConfig -FixtureArchive $cache.fixtureArchive -AppDirectory (Join-Path $root "vision\app") -SiteConfigurationDestination (Join-Path $root "program-data\vision\site.json") -FixtureDirectory (Join-Path $root "program-data\vision\fixtures") -RuntimeWorkDirectory $runtimeWorkDirectory -LauncherPath (Join-Path $root "bringup\start_vision.bat") -ProbeTimeoutSeconds 1 | Out-Null } catch { $recordedCameraRejected = $true }
  Wait-Job $server | Out-Null; Receive-Job $server | Out-Null; Remove-Job $server
  Assert-True $recordedCameraRejected "recorded-video install accepted degraded camera readiness"
  $server = Start-VisionProbeServer 17893 "ok" $true "9.8.9"
  Start-Sleep -Milliseconds 200
  $fixtureCommitRoot = Join-Path $root "program-data\vision\fixtures\$commit"
  New-Item -ItemType Directory -Force -Path (Join-Path $fixtureCommitRoot "recorded-video") | Out-Null
  [IO.File]::WriteAllText((Join-Path $fixtureCommitRoot "recorded-video\top.mp4"), "stale", [Text.Encoding]::UTF8)
  $recordedInstall = Install-VisionMainArtifact -RuntimeArchive $cache.runtimeArchive -Commit $commit -SiteConfigurationPath $recordedConfig -FixtureArchive $cache.fixtureArchive -AppDirectory (Join-Path $root "vision\app") -SiteConfigurationDestination (Join-Path $root "program-data\vision\site.json") -FixtureDirectory (Join-Path $root "program-data\vision\fixtures") -RuntimeWorkDirectory $runtimeWorkDirectory -LauncherPath (Join-Path $root "bringup\start_vision.bat") -ProbeTimeoutSeconds 5
  Wait-Job $server | Out-Null; Receive-Job $server | Out-Null; Remove-Job $server
  Assert-True (Test-Path -LiteralPath (Join-Path $root "program-data\vision\fixtures\$commit\recorded-video\top.mp4")) "recorded-video fixture was not extracted outside the app"
  Assert-True (-not (Test-Path -LiteralPath (Join-Path $recordedInstall.appDirectory "recorded-video"))) "recorded-video fixture entered the production app"
  Assert-True ((Get-Content -LiteralPath (Join-Path $root "program-data\vision\fixtures\$commit\recorded-video\top.mp4") -Raw) -eq "fixture") "stale fixture directory was trusted instead of atomically replaced"
  $installedRecordedConfig = Get-Content -LiteralPath $recordedInstall.siteConfiguration -Raw | ConvertFrom-Json
  $expectedTopVideo = [IO.Path]::GetFullPath((Join-Path $root "program-data\vision\fixtures\$commit\recorded-video\top.mp4"))
  $expectedFrontVideo = [IO.Path]::GetFullPath((Join-Path $root "program-data\vision\fixtures\$commit\recorded-video\front.mp4"))
  Assert-True ($installedRecordedConfig.cameras.top.video_path -eq $expectedTopVideo) "top video_path was not normalized to the extracted fixture"
  Assert-True ($installedRecordedConfig.cameras.front.video_path -eq $expectedFrontVideo) "front video_path was not normalized to the extracted fixture"
  $fixtureManifestPath = Join-Path $root "program-data\vision\fixtures\$commit\recorded-video\fixture-manifest.json"
  Assert-True (Test-Path -LiteralPath $fixtureManifestPath) "recorded-video fixture manifest was not written"
  $recordedInstallRecord = Get-Content -LiteralPath (Join-Path $root "program-data\vision\installed.json") -Raw | ConvertFrom-Json
  Assert-True ($recordedInstallRecord.executablePath -eq (Join-Path $root "vision\app\vending-vision.exe")) "installed record omitted the fixed executablePath"
  Assert-True ($recordedInstallRecord.siteConfiguration.path -eq (Join-Path $root "program-data\vision\site.json")) "installed record omitted the fixed site configuration path"
  Assert-True ($recordedInstallRecord.siteConfiguration.sha256 -eq (Get-Sha256 (Join-Path $root "program-data\vision\site.json"))) "installed record omitted the site configuration digest"
  Assert-True ($recordedInstallRecord.downloadManifest.sha256 -eq (Get-Sha256 (Join-Path $root "artifact-source\vending-vision-main-artifacts.json"))) "installed record omitted the download manifest digest"
  Assert-True ($recordedInstallRecord.fixtureSet.manifestPath -eq $fixtureManifestPath) "installed record omitted the fixture manifest path"
  Assert-True ($recordedInstallRecord.fixtureSet.manifestSha256 -eq (Get-Sha256 $fixtureManifestPath)) "installed record omitted the fixture manifest digest"
  Assert-True ($recordedInstallRecord.fixtureSet.top.sha256 -eq (Get-Sha256 $expectedTopVideo)) "installed record omitted the top fixture digest"
  Assert-True ($recordedInstallRecord.fixtureSet.front.sha256 -eq (Get-Sha256 $expectedFrontVideo)) "installed record omitted the front fixture digest"
  Assert-True ($recordedInstallRecord.fixtureSet.expectedResults.sha256 -eq (Get-Sha256 (Join-Path $root "program-data\vision\fixtures\$commit\recorded-video\expected-results.json"))) "installed record omitted the expected-results digest"
  $installedRecordedConfig.cameras.top.video_path = "fixtures/$commit/recorded-video/top.mp4"
  $installedRecordedConfig.cameras.front.video_path = "fixtures/$commit/recorded-video/front.mp4"
  $relativeConfigPath = Join-Path $root "program-data\vision\relative-site.json"
  [IO.File]::WriteAllText($relativeConfigPath, ($installedRecordedConfig | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  Assert-VisionSiteConfiguration -ConfigurationPath $relativeConfigPath -FixtureRoot (Join-Path $root "program-data\vision\fixtures\$commit") | Out-Null
  Assert-True ($global:VisionHarnessTaskRegistrations -eq 3) "reinstall did not update the existing StartVisionServer task"

  $guestScriptPath = Join-Path $PSScriptRoot "..\testbed\run-local-testbed-guest.ps1"
  $guestScript = Get-Content -LiteralPath $guestScriptPath -Raw
  $clearFunction = [regex]::Match($guestScript, '(?s)function Clear-TestbedVisionProcesses\(\[object\]\$GuestInput\) \{.*?\r?\n\}\r?\n\r?\nif \(\$Mode -eq "clear_cache"\)').Value
  Assert-True (-not [string]::IsNullOrWhiteSpace($clearFunction)) "could not extract testbed Vision cleanup function"
  Invoke-Expression ($clearFunction -replace '\r?\n\r?\nif \(\$Mode -eq "clear_cache"\)$', '')

  function Get-NetTCPConnection {
    [CmdletBinding()]
    param([string]$State)
    return @($global:TestbedVisionListeners)
  }

  function Get-CimInstance {
    [CmdletBinding()]
    param([string]$ClassName, [string]$Filter)
    if ($ClassName -ne "Win32_Process" -or $Filter -notmatch 'ProcessId = (\d+)') { return $null }
    return $global:TestbedVisionProcesses[[int]$Matches[1]]
  }

  function Stop-Process {
    [CmdletBinding()]
    param([int]$Id, [switch]$Force)
    $global:TestbedVisionStoppedProcessIds += $Id
    $global:TestbedVisionListeners = @($global:TestbedVisionListeners | Where-Object { [int]$_.OwningProcess -ne $Id })
  }

  function Start-Sleep {
    [CmdletBinding()]
    param([int]$Milliseconds)
  }

  function Stop-TestbedCanonicalVision {
    param([string]$AppDirectory, [string]$ConfigurationPath)
    $global:TestbedCanonicalVisionStops += [pscustomobject]@{ appDirectory = $AppDirectory; configurationPath = $ConfigurationPath }
    $global:TestbedVisionListeners = @($global:TestbedVisionListeners | Where-Object { [int]$_.OwningProcess -ne 4101 })
  }

  function Set-TestbedVisionCleanupFixture([object[]]$Listeners, [hashtable]$Processes) {
    $global:TestbedVisionListeners = @($Listeners)
    $global:TestbedVisionProcesses = $Processes
    $global:TestbedVisionStoppedProcessIds = @()
    $global:TestbedCanonicalVisionStops = @()
  }

  $testbedGuestInput = [pscustomobject]@{ hostControlPlane = [pscustomobject]@{ visionMockControlPort = 7893 } }
  $canonicalProcess = [pscustomobject]@{
    ProcessId = 4101
    ExecutablePath = "C:\VEM\vision\app\vending-vision.exe"
    CommandLine = '"C:\VEM\vision\app\vending-vision.exe" --config "C:\ProgramData\VEM\vision\site.json"'
  }
  Set-TestbedVisionCleanupFixture @([pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = 7892; OwningProcess = 4101 }) @{ 4101 = $canonicalProcess }
  Clear-TestbedVisionProcesses $testbedGuestInput
  Assert-True ($global:TestbedCanonicalVisionStops.Count -eq 1) "canonical listener was not stopped"
  Assert-True ($global:TestbedVisionListeners.Count -eq 0) "canonical listener remained bound"

  $mockProcess = [pscustomobject]@{
    ProcessId = 4102
    ExecutablePath = "C:\Program Files\nodejs\node.exe"
    CommandLine = 'node apps\vision-mock\src\server.ts'
  }
  Set-TestbedVisionCleanupFixture @(
    [pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = 7892; OwningProcess = 4102 },
    [pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = 7893; OwningProcess = 4102 }
  ) @{ 4102 = $mockProcess }
  Clear-TestbedVisionProcesses $testbedGuestInput
  Assert-True ($global:TestbedVisionStoppedProcessIds -contains 4102) "mock listener was not stopped"
  Assert-True ($global:TestbedCanonicalVisionStops.Count -eq 0) "mock listener was misclassified as canonical Vision"

  $unknownProcess = [pscustomobject]@{ ProcessId = 4103; ExecutablePath = "C:\unknown.exe"; CommandLine = "unknown" }
  Set-TestbedVisionCleanupFixture @([pscustomobject]@{ LocalAddress = "127.0.0.1"; LocalPort = 7892; OwningProcess = 4103 }) @{ 4103 = $unknownProcess }
  $unknownRejected = $false
  try { Clear-TestbedVisionProcesses $testbedGuestInput } catch { $unknownRejected = $_.Exception.Message -match "unknown listener owners" }
  Assert-True $unknownRejected "unknown listener owner did not fail closed"
  Assert-True ($global:TestbedVisionStoppedProcessIds.Count -eq 0 -and $global:TestbedCanonicalVisionStops.Count -eq 0) "unknown listener owner was stopped"
  [Console]::WriteLine("Vision main consumer harness passed")
} finally {
  $remainingJobs = @(Get-Job -ErrorAction SilentlyContinue)
  $remainingJobs | Stop-Job -ErrorAction SilentlyContinue
  $remainingJobs | Remove-Job -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
