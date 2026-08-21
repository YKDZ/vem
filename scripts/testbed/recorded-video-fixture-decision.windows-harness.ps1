$ErrorActionPreference = 'Stop'

$module = Join-Path $PSScriptRoot 'recorded-video-fixture-decision.psm1'
Import-Module $module -Force

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-Throws([scriptblock]$Action, [string]$Message) {
  try {
    & $Action
  } catch {
    return
  }
  throw $Message
}

function Assert-ThrowsMessage([scriptblock]$Action, [string]$ExpectedMessage, [string]$Message) {
  try {
    & $Action
  } catch {
    if ($_.Exception.Message -like "*$ExpectedMessage*") { return }
    throw "${Message}: $($_.Exception.Message)"
  }
  throw $Message
}

Assert-True (Test-VemRecordedFixtureLocalPath 'C:\fixtures\front.mp4') 'strict local absolute path was rejected'
foreach ($path in @('front.mp4', 'C:relative\front.mp4', '\\server\share\front.mp4', 'file:///C:/fixtures/front.mp4', 'http://example.test/front.mp4', 'C:\fixtures\x:stream.mp4', 'C:\fixtures\..\front.mp4')) {
  Assert-True (-not (Test-VemRecordedFixtureLocalPath $path)) "invalid recorded fixture path was accepted: $path"
}

$digest = 'a' * 64
$manifest = [pscustomobject]@{
  recordings = [pscustomobject]@{
    top = [pscustomobject]@{ file = 'top.mp4'; sha256 = $digest; loop = $false }
    frontVertical = [pscustomobject]@{ file = 'front-vertical.mp4'; sha256 = ('b' * 64); loop = $true }
    manFront = [pscustomobject]@{ file = 'man-front.mp4'; sha256 = ('c' * 64); loop = $true }
    geometryFar = [pscustomobject]@{ file = 'far.mp4'; sha256 = ('d' * 64); loop = $true; source = 'person.png'; sourceSha256 = ('e' * 64); generator = 'fixture.py' }
    geometryMid = [pscustomobject]@{ file = 'mid.mp4'; sha256 = ('f' * 64); loop = $true; source = 'person.png'; sourceSha256 = ('e' * 64); generator = 'fixture.py' }
    geometryNear = [pscustomobject]@{ file = 'near.mp4'; sha256 = ('1' * 64); loop = $true; source = 'person.png'; sourceSha256 = ('e' * 64); generator = 'fixture.py' }
  }
}
$select = Resolve-VemRecordedFixtureCameraDecision $manifest 'manFront' $true 'geometryMid' $true $true
Assert-True ($select.top.entry -eq 'manFront' -and $select.top.loop -eq $true -and $select.top.role -eq 'presence') 'select did not configure manFront presence loop'
Assert-True ($select.front.entry -eq 'geometryMid' -and $select.front.loop -eq $true -and $select.front.role -eq 'profile_try_on') 'select did not configure geometry front loop'
$restore = Resolve-VemRecordedFixtureCameraDecision $manifest 'top' $false 'frontVertical' $true $false
Assert-True ($restore.top.entry -eq 'top' -and $restore.top.loop -eq $false) 'restore did not configure top non-loop'
Assert-True ($restore.front.entry -eq 'frontVertical' -and $restore.front.loop -eq $true) 'restore did not configure frontVertical loop'

$duplicateGeometryDigest = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$duplicateGeometryDigest.recordings.geometryMid.sha256 = $duplicateGeometryDigest.recordings.geometryFar.sha256
Assert-Throws {
  Resolve-VemRecordedFixtureCameraDecision $duplicateGeometryDigest 'manFront' $true 'geometryMid' $true $true
} 'geometry segments accepted a duplicated SHA-256 under different file names'

$missingRestoreLoop = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$missingRestoreLoop.recordings.top.PSObject.Properties.Remove('loop')
Assert-Throws {
  Resolve-VemRecordedFixtureCameraDecision $missingRestoreLoop 'top' $false 'frontVertical' $true $false
} 'restore accepted a top entry without an explicit loop property'

$driftedSourceDigest = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json
$driftedSourceDigest.recordings.geometryNear.sourceSha256 = '2' * 64
Assert-Throws {
  Resolve-VemRecordedFixtureCameraDecision $driftedSourceDigest 'manFront' $true 'geometryMid' $true $true
} 'geometry segments accepted a drifting source digest'

# 安装锚摘要漂移时，完整切换不得写配置或触碰运行时 owner。
function Get-TextSha256([string]$Text) {
  $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Text)
  try {
    return -join ([Security.Cryptography.SHA256]::Create().ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') })
  } finally {
    $bytes = $null
  }
}

$installedPath = 'C:\ProgramData\VEM\vision\installed.json'
$sitePath = 'C:\ProgramData\VEM\vision\site.json'
$fixtureRoot = 'C:\ProgramData\VEM\vision\fixtures\commit-a'
$recordedRoot = "$fixtureRoot\recorded-video"
$fixtureManifestPath = "$recordedRoot\fixture-manifest.json"
$expectedResultsPath = "$recordedRoot\expected-results.json"
$fixtureManifest = [ordered]@{
  schemaVersion = 'vem-vision-recorded-fixture/v1'
  root = $fixtureRoot
  recordedVideo = [ordered]@{
    expectedResults = [ordered]@{ path = $expectedResultsPath; sha256 = '0' * 64 }
  }
} | ConvertTo-Json -Depth 8
$expectedResults = [ordered]@{ recordings = $manifest.recordings } | ConvertTo-Json -Depth 8
$fixtureManifest = $fixtureManifest | ConvertFrom-Json
$fixtureManifest.recordedVideo.expectedResults.sha256 = Get-TextSha256 $expectedResults
$fixtureManifest = $fixtureManifest | ConvertTo-Json -Depth 8
$files = @{
  $sitePath = (@{ schemaVersion = 'vem-vision-site/v1'; cameras = @() } | ConvertTo-Json -Depth 8)
  $fixtureManifestPath = $fixtureManifest
  $expectedResultsPath = $expectedResults
}
$installed = [ordered]@{
  schemaVersion = 'vem-vision-installed/v1'
  siteConfiguration = [ordered]@{ path = $sitePath }
  fixtureSet = [ordered]@{
    root = $fixtureRoot
    manifestPath = $fixtureManifestPath
    # 故意与实际 fixture-manifest 摘要不同。
    manifestSha256 = 'f' * 64
    expectedResults = [ordered]@{ path = $expectedResultsPath; sha256 = Get-TextSha256 $expectedResults }
  }
}
$files[$installedPath] = $installed | ConvertTo-Json -Depth 8
$unexpectedSideEffect = { throw 'installed anchor failure reached a configuration or owner side effect' }
$dependencies = @{
  ReadText = { param($Path) $files[$Path] }
  FileExists = { param($Path) $files.ContainsKey($Path) }
  GetSha256 = { param($Path) Get-TextSha256 $files[$Path] }
  WriteTextAtomically = $unexpectedSideEffect
  GetRoles = $unexpectedSideEffect
  GetCanonicalOwner = $unexpectedSideEffect
  StopCanonicalOwner = $unexpectedSideEffect
  StartOwner = $unexpectedSideEffect
  ProcessExists = $unexpectedSideEffect
  GetScheduledOwner = $unexpectedSideEffect
  Now = $unexpectedSideEffect
  Sleep = $unexpectedSideEffect
}
Assert-True ($null -ne (Get-Command Invoke-VemRecordedFixtureSwitch -ErrorAction SilentlyContinue)) '完整录播夹具切换公开 seam 尚未提供'
Assert-ThrowsMessage {
  Invoke-VemRecordedFixtureSwitch -Mode select -Segment mid -Dependencies $dependencies
} 'fixture-manifest SHA-256 不匹配' 'installed.json manifest SHA drift did not fail closed with the manifest digest reason'

function New-FixtureSwitchHarnessState([bool]$NewRolesOutsideOwner = $false) {
  $fixtureRoot = 'C:\ProgramData\VEM\vision\fixtures\commit-b'
  $recordedRoot = "$fixtureRoot\recorded-video"
  $installedPath = 'C:\ProgramData\VEM\vision\installed.json'
  $sitePath = 'C:\ProgramData\VEM\vision\site.json'
  $fixtureManifestPath = "$recordedRoot\fixture-manifest.json"
  $expectedResultsPath = "$recordedRoot\expected-results.json"
  $clipByEntry = [ordered]@{
    top = 'top.mp4'
    frontVertical = 'front-vertical.mp4'
    manFront = 'man-front.mp4'
    geometryFar = 'geometry-far.mp4'
    geometryMid = 'geometry-mid.mp4'
    geometryNear = 'geometry-near.mp4'
  }
  $loopByEntry = @{ top = $false; frontVertical = $true; manFront = $true; geometryFar = $true; geometryMid = $true; geometryNear = $true }
  $files = @{}
  $recordings = [ordered]@{}
  foreach ($entry in $clipByEntry.Keys) {
    $file = $clipByEntry[$entry]
    $content = "fixture-$entry"
    $files["$recordedRoot\$file"] = $content
    $recordings[$entry] = [ordered]@{
      file = $file
      sha256 = Get-TextSha256 $content
      loop = $loopByEntry[$entry]
    }
    if ($entry -like 'geometry*') {
      $recordings[$entry].source = 'fictional-person.png'
      $recordings[$entry].sourceSha256 = '9' * 64
      $recordings[$entry].generator = 'opencv-recorded-fixture'
    }
  }
  $expectedResults = [ordered]@{ recordings = $recordings } | ConvertTo-Json -Depth 8
  $fixtureManifest = [ordered]@{
    schemaVersion = 'vem-vision-recorded-fixture/v1'
    root = $fixtureRoot
    recordedVideo = [ordered]@{
      expectedResults = [ordered]@{ path = $expectedResultsPath; sha256 = Get-TextSha256 $expectedResults }
    }
  } | ConvertTo-Json -Depth 8
  $site = [ordered]@{
    schemaVersion = 'vem-vision-site/v1'
    cameras = [ordered]@{
      top = [ordered]@{ source = 'recorded_video'; role = 'presence'; video_path = "$recordedRoot\top.mp4"; loop = $false }
      front = [ordered]@{ source = 'recorded_video'; role = 'profile_try_on'; video_path = "$recordedRoot\front-vertical.mp4"; loop = $true }
    }
  } | ConvertTo-Json -Depth 8
  $files[$fixtureManifestPath] = $fixtureManifest
  $files[$expectedResultsPath] = $expectedResults
  $files[$sitePath] = $site
  $files[$installedPath] = ([ordered]@{
    schemaVersion = 'vem-vision-installed/v1'
    siteConfiguration = [ordered]@{ path = $sitePath }
    fixtureSet = [ordered]@{
      root = $fixtureRoot
      manifestPath = $fixtureManifestPath
      manifestSha256 = Get-TextSha256 $fixtureManifest
      expectedResults = [ordered]@{ path = $expectedResultsPath; sha256 = Get-TextSha256 $expectedResults }
    }
  } | ConvertTo-Json -Depth 8)
  $state = [pscustomobject]@{
    files = $files
    writeCount = 0
    ownerCallCount = 0
    events = [Collections.Generic.List[string]]::new()
    phase = 'old'
    now = [DateTime]::UtcNow
  }
  $oldOwner = [pscustomobject]@{
    mainProcess = [pscustomobject]@{ ProcessId = 1101 }
    canonicalProcesses = @([pscustomobject]@{ ProcessId = 1101 }, [pscustomobject]@{ ProcessId = 1102 })
  }
  $newOwner = [pscustomobject]@{
    mainProcess = [pscustomobject]@{ ProcessId = 1201 }
    canonicalProcesses = @([pscustomobject]@{ ProcessId = 1201 }, [pscustomobject]@{ ProcessId = 1202 })
  }
  $oldRoles = [pscustomobject]@{ roles = @([pscustomobject]@{ name = 'capture'; pid = 1101; ready = $true }, [pscustomobject]@{ name = 'worker'; pid = 1102; ready = $true }) }
  $newWorkerPid = if ($NewRolesOutsideOwner) { 1299 } else { 1202 }
  $newRoles = [pscustomobject]@{ roles = @([pscustomobject]@{ name = 'capture'; pid = 1201; ready = $true }, [pscustomobject]@{ name = 'worker'; pid = $newWorkerPid; ready = $true }) }
  $dependencies = @{
    ReadText = { param($Path) $state.files[$Path] }.GetNewClosure()
    FileExists = { param($Path) $state.files.ContainsKey($Path) }.GetNewClosure()
    GetSha256 = { param($Path) Get-TextSha256 $state.files[$Path] }.GetNewClosure()
    WriteTextAtomically = { param($Path, $Content) $state.writeCount += 1; $state.files[$Path] = $Content; [void]$state.events.Add('write-site') }.GetNewClosure()
    GetRoles = {
      if ($state.phase -eq 'stopped') { throw 'roles offline' }
      if ($state.phase -eq 'old') { return $oldRoles }
      return $newRoles
    }.GetNewClosure()
    GetCanonicalOwner = {
      if ($state.phase -eq 'stopped') { return $null }
      if ($state.phase -eq 'old') { return $oldOwner }
      return $newOwner
    }.GetNewClosure()
    StopCanonicalOwner = { $state.ownerCallCount += 1; $state.phase = 'stopped'; [void]$state.events.Add('stop-owner') }.GetNewClosure()
    StartOwner = { $state.ownerCallCount += 1; $state.phase = 'new'; [void]$state.events.Add('start-owner') }.GetNewClosure()
    ProcessExists = { param($ProcessId) $false }.GetNewClosure()
    # 交互 owner launcher 在 Process.Start 后退出；真实任务此时回到 Ready，进程继续运行。
    GetScheduledOwner = { [pscustomobject]@{ TaskName = 'VEMVisionRuntime'; State = 'Ready' } }.GetNewClosure()
    Now = { $state.now }.GetNewClosure()
    Sleep = { param($Milliseconds) $state.now = $state.now.AddMilliseconds($Milliseconds) }.GetNewClosure()
  }
  return [pscustomobject]@{
    state = $state
    dependencies = $dependencies
    sitePath = $sitePath
    recordedRoot = $recordedRoot
    oldMainPid = 1101
    newMainPid = 1201
  }
}

# 生产默认摘要路径必须读取真实文件字节，不能依赖现场缺失的 Get-FileHash。
$defaultHash = New-FixtureSwitchHarnessState
$defaultHashFiles = $defaultHash.state.files
$defaultExpectedResultsPath = "$($defaultHash.recordedRoot)\expected-results.json"
$defaultFixtureManifestPath = "$($defaultHash.recordedRoot)\fixture-manifest.json"
$defaultTopPath = "$($defaultHash.recordedRoot)\top.mp4"
$defaultInstalledPath = 'C:\ProgramData\VEM\vision\installed.json'
$defaultExpectedResults = $defaultHashFiles[$defaultExpectedResultsPath] | ConvertFrom-Json
$defaultExpectedResults.recordings.top.sha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
$defaultExpectedResultsText = $defaultExpectedResults | ConvertTo-Json -Depth 8
$defaultHashFiles[$defaultExpectedResultsPath] = $defaultExpectedResultsText
$defaultFixtureManifest = $defaultHashFiles[$defaultFixtureManifestPath] | ConvertFrom-Json
$defaultFixtureManifest.recordedVideo.expectedResults.sha256 = Get-TextSha256 $defaultExpectedResultsText
$defaultFixtureManifestText = $defaultFixtureManifest | ConvertTo-Json -Depth 8
$defaultHashFiles[$defaultFixtureManifestPath] = $defaultFixtureManifestText
$defaultInstalled = $defaultHashFiles[$defaultInstalledPath] | ConvertFrom-Json
$defaultInstalled.fixtureSet.manifestSha256 = Get-TextSha256 $defaultFixtureManifestText
$defaultInstalled.fixtureSet.expectedResults.sha256 = Get-TextSha256 $defaultExpectedResultsText
$defaultHashFiles[$defaultInstalledPath] = $defaultInstalled | ConvertTo-Json -Depth 8
$defaultHashFiles[$defaultTopPath] = 'abc'
$defaultHash.dependencies.Remove('GetSha256') | Out-Null
$defaultSiteText = $defaultHashFiles[$defaultHash.sitePath]
$defaultHashRoot = Join-Path ([IO.Path]::GetTempPath()) "vem-recorded-fixture-hash-$([Guid]::NewGuid())"
$previousGetFileHash = Get-Item -LiteralPath Function:\global:Get-FileHash -ErrorAction SilentlyContinue
try {
  [void][IO.Directory]::CreateDirectory($defaultHashRoot)
  $defaultHashFilePaths = @{}
  $defaultHashFileIndex = 0
  foreach ($file in $defaultHashFiles.GetEnumerator()) {
    $resolvedPath = Join-Path $defaultHashRoot "file-$defaultHashFileIndex"
    [IO.File]::WriteAllText($resolvedPath, [string]$file.Value, [Text.UTF8Encoding]::new($false))
    $defaultHashFilePaths[[string]$file.Key] = $resolvedPath
    $defaultHashFileIndex += 1
  }
  $defaultHash.dependencies['ResolveHashFilePath'] = {
    param([string]$Path)
    $resolvedPath = $defaultHashFilePaths[$Path]
    if ([string]::IsNullOrWhiteSpace([string]$resolvedPath)) { throw "unmapped default hash path: $Path" }
    return $resolvedPath
  }.GetNewClosure()
  $defaultTopFilePath = $defaultHashFilePaths[$defaultTopPath]
  function global:Get-FileHash { throw 'Get-FileHash command is unavailable' }

  # 单字节变化必须在写 site.json 或触碰 owner 之前 fail closed。
  [IO.File]::WriteAllBytes($defaultTopFilePath, [byte[]](0x61, 0x62, 0x64))
  Assert-ThrowsMessage {
    Invoke-VemRecordedFixtureSwitch -Mode restore -Dependencies $defaultHash.dependencies -ReadyStabilityMs 0
  } '安装录播文件摘要不匹配: top' 'default file-byte hash accepted a one-byte mutation'
  Assert-True ($defaultHash.state.ownerCallCount -eq 0) 'default hash mismatch touched the runtime owner'
  Assert-True ($defaultHash.state.files[$defaultHash.sitePath] -ceq $defaultSiteText) 'default hash mismatch wrote site.json'

  # 已知 SHA-256 的 abc 恢复后，完整 switch 必须走到 fake owner success。
  [IO.File]::WriteAllBytes($defaultTopFilePath, [byte[]](0x61, 0x62, 0x63))
  Invoke-VemRecordedFixtureSwitch -Mode restore -Dependencies $defaultHash.dependencies -ReadyStabilityMs 0 | Out-Null
  $defaultRestoredConfig = $defaultHash.state.files[$defaultHash.sitePath] | ConvertFrom-Json
  Assert-True ($defaultRestoredConfig.cameras.top.video_path -eq $defaultTopPath -and $defaultRestoredConfig.cameras.top.loop -eq $false) 'default file-byte hash did not complete restore configuration'
  Assert-True ($defaultHash.state.ownerCallCount -eq 2 -and $defaultHash.state.phase -eq 'new') 'default file-byte hash did not reach fake owner success'
} finally {
  if ($null -eq $previousGetFileHash) {
    Remove-Item -LiteralPath Function:\global:Get-FileHash -ErrorAction SilentlyContinue
  } else {
    Set-Item -LiteralPath Function:\global:Get-FileHash -Value $previousGetFileHash.ScriptBlock
  }
  if ([IO.Directory]::Exists($defaultHashRoot)) {
    Remove-Item -LiteralPath $defaultHashRoot -Recurse -Force
  }
}

$selectState = New-FixtureSwitchHarnessState
Invoke-VemRecordedFixtureSwitch -Mode select -Segment mid -Dependencies $selectState.dependencies -ReadyStabilityMs 0 | Out-Null
$selectedConfig = $selectState.state.files[$selectState.sitePath] | ConvertFrom-Json
Assert-True ($selectedConfig.cameras.top.role -eq 'presence' -and $selectedConfig.cameras.top.video_path -eq "$($selectState.recordedRoot)\man-front.mp4" -and $selectedConfig.cameras.top.loop -eq $true) 'select mid did not write manFront as looping top presence camera'
Assert-True ($selectedConfig.cameras.front.role -eq 'profile_try_on' -and $selectedConfig.cameras.front.video_path -eq "$($selectState.recordedRoot)\geometry-mid.mp4" -and $selectedConfig.cameras.front.loop -eq $true) 'select mid did not write geometryMid as looping front profile camera'
Assert-True ($selectState.oldMainPid -ne $selectState.newMainPid) 'harness did not model a replacement canonical owner PID'
Assert-True (($selectState.state.events -join '|') -eq 'write-site|stop-owner|start-owner') 'select mid did not atomically write before restarting the canonical owner'

$restoreState = New-FixtureSwitchHarnessState
Invoke-VemRecordedFixtureSwitch -Mode restore -Dependencies $restoreState.dependencies -ReadyStabilityMs 0 | Out-Null
$restoredConfig = $restoreState.state.files[$restoreState.sitePath] | ConvertFrom-Json
Assert-True ($restoredConfig.cameras.top.role -eq 'presence' -and $restoredConfig.cameras.top.video_path -eq "$($restoreState.recordedRoot)\top.mp4" -and $restoredConfig.cameras.top.loop -eq $false) 'restore did not write non-looping top presence camera'
Assert-True ($restoredConfig.cameras.front.role -eq 'profile_try_on' -and $restoredConfig.cameras.front.video_path -eq "$($restoreState.recordedRoot)\front-vertical.mp4" -and $restoredConfig.cameras.front.loop -eq $true) 'restore did not write looping frontVertical profile camera'
Assert-True (($restoreState.state.events -join '|') -eq 'write-site|stop-owner|start-owner') 'restore did not atomically write before restarting the canonical owner'

$wrongOwnerRoles = New-FixtureSwitchHarnessState $true
Assert-ThrowsMessage {
  Invoke-VemRecordedFixtureSwitch -Mode select -Segment mid -Dependencies $wrongOwnerRoles.dependencies -ReadyStabilityMs 0
} '新 VEMVisionRuntime owner 未以唯一稳定 roles/PID ready 状态启动' 'roles outside the replacement canonical owner were accepted'
Assert-True (($wrongOwnerRoles.state.events -join '|') -eq 'write-site|stop-owner|start-owner') 'wrong replacement roles did not exercise the post-write owner lifecycle'

$detachedOwner = New-FixtureSwitchHarnessState
$detachedState = $detachedOwner.state
# 模拟只停止短生命周期 launcher、却未结束已脱离 task 的 Vision 进程；完整 switch 必须拒绝启动替换 owner。
$detachedOwner.dependencies.StopCanonicalOwner = {
  $detachedState.ownerCallCount += 1
  [void]$detachedState.events.Add('stop-owner')
}.GetNewClosure()
$detachedOwner.dependencies.ProcessExists = {
  param($ProcessId)
  $ProcessId -in @(1101, 1102)
}.GetNewClosure()
Assert-ThrowsMessage {
  Invoke-VemRecordedFixtureSwitch -Mode select -Segment mid -Dependencies $detachedOwner.dependencies -ReadyStabilityMs 0
} '停止后旧 Vision owner 仍提供 runtime 角色端点' 'task-only stop was allowed to leave detached Vision owner running'
Assert-True (($detachedOwner.state.events -join '|') -eq 'write-site|stop-owner') 'detached owner failure incorrectly started a replacement owner'

$missingNear = New-FixtureSwitchHarnessState
$missingNear.state.files.Remove("$($missingNear.recordedRoot)\geometry-near.mp4")
Assert-ThrowsMessage {
  Invoke-VemRecordedFixtureSwitch -Mode select -Segment mid -Dependencies $missingNear.dependencies -ReadyStabilityMs 0
} '安装录播文件缺失或不是本地绝对路径: geometryNear' 'select accepted a missing near geometry clip after earlier segment checks'
Assert-True ($missingNear.state.writeCount -eq 0 -and $missingNear.state.ownerCallCount -eq 0) 'missing near geometry clip wrote configuration or restarted owner'

$driftedExpectedResults = New-FixtureSwitchHarnessState
$driftedInstalled = $driftedExpectedResults.state.files['C:\ProgramData\VEM\vision\installed.json'] | ConvertFrom-Json
$driftedInstalled.fixtureSet.expectedResults.sha256 = '8' * 64
$driftedExpectedResults.state.files['C:\ProgramData\VEM\vision\installed.json'] = $driftedInstalled | ConvertTo-Json -Depth 8
Assert-ThrowsMessage {
  Invoke-VemRecordedFixtureSwitch -Mode select -Segment mid -Dependencies $driftedExpectedResults.dependencies -ReadyStabilityMs 0
} '安装 Vision expected-results SHA-256 不匹配' 'installed expected-results digest drift was accepted'
Assert-True ($driftedExpectedResults.state.writeCount -eq 0 -and $driftedExpectedResults.state.ownerCallCount -eq 0) 'expected-results digest drift wrote configuration or restarted owner'

# 行为 harness 直接执行生产函数；该静态护栏只补充确认未意外引入 PS5.1 不存在的 API。
$moduleSource = Get-Content -LiteralPath $module -Raw
Assert-True ($moduleSource -notmatch 'IsPathFullyQualified') 'production module reintroduced the PowerShell 5.1-incompatible IsPathFullyQualified API'
Assert-True ($moduleSource -match 'Stop-VisionMainTask') 'production module did not use canonical process-aware Vision stop'
Assert-True ($moduleSource -notmatch "Stop-ScheduledTask -TaskName 'VEMVisionRuntime'") 'production module only stopped the launcher task instead of detached Vision processes'

[Console]::Out.WriteLine('{"ok":true}')
