# 已安装录播夹具完整切换深模块：锚验证、决策、配置写入与唯一 Vision owner 生命周期共用一个生产 seam。
function Test-VemRecordedFixtureLocalPath {
  param([string]$Path)

  if ([string]::IsNullOrWhiteSpace($Path) -or $Path -notmatch '^[A-Za-z]:\\') {
    return $false
  }
  if ($Path -match '^[\\/]{2}' -or $Path.Substring(2) -match '[:\x00-\x1f<>"|?*]' -or $Path -match '(?:^|\\)\.\.(?:\\|$)') {
    return $false
  }
  # 生产 Windows 上再以 .NET 规范化阻止隐含相对路径；Linux harness 只验证 Windows 词法契约。
  if ($env:OS -eq 'Windows_NT') {
    try {
      return [IO.Path]::GetFullPath($Path) -ceq $Path
    } catch {
      return $false
    }
  }
  return $true
}

function Resolve-VemRecordedFixtureCameraDecision {
  param(
    [object]$Manifest,
    [string]$TopEntry,
    [bool]$TopLoop,
    [string]$FrontEntry,
    [bool]$FrontLoop,
    [bool]$VerifyGeometrySet
  )

  if ($null -eq $Manifest -or $null -eq $Manifest.recordings) {
    throw '安装 recorded-video manifest 缺少 recordings'
  }
  function Get-DecisionEntry([string]$Entry, [bool]$ExpectedLoop) {
    $recording = $Manifest.recordings.$Entry
    if ($null -eq $recording -or -not ($recording.PSObject.Properties.Name -contains 'loop') -or -not ($recording.loop -is [bool]) -or [string]$recording.file -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\.mp4$' -or [string]$recording.sha256 -notmatch '^[a-f0-9]{64}$' -or $recording.loop -ne $ExpectedLoop) {
      throw "安装 manifest 缺少或错误的 $Entry entry"
    }
    return [pscustomobject]@{
      entry = $Entry
      file = [string]$recording.file
      sha256 = [string]$recording.sha256
      loop = $ExpectedLoop
    }
  }

  if ($VerifyGeometrySet) {
    $geometry = @(
      (Get-DecisionEntry 'geometryFar' $true),
      (Get-DecisionEntry 'geometryMid' $true),
      (Get-DecisionEntry 'geometryNear' $true)
    )
    $geometryRecords = @($Manifest.recordings.geometryFar, $Manifest.recordings.geometryMid, $Manifest.recordings.geometryNear)
    if (@($geometry.file | Select-Object -Unique).Count -ne 3 -or @($geometry.sha256 | Select-Object -Unique).Count -ne 3 -or @($geometryRecords | Where-Object { [string]$_.sourceSha256 -notmatch '^[a-f0-9]{64}$' -or [string]::IsNullOrWhiteSpace([string]$_.source) -or [string]::IsNullOrWhiteSpace([string]$_.generator) }).Count -ne 0 -or @($geometryRecords.source | Select-Object -Unique).Count -ne 1 -or @($geometryRecords.sourceSha256 | Select-Object -Unique).Count -ne 1 -or @($geometryRecords.generator | Select-Object -Unique).Count -ne 1) {
      throw '安装 expected-results geometry 三段必须同源且各自使用不同文件与 SHA-256'
    }
  }

  $top = Get-DecisionEntry $TopEntry $TopLoop
  $front = Get-DecisionEntry $FrontEntry $FrontLoop
  $entries = @($top, $front)
  if ($VerifyGeometrySet) { $entries += $geometry }
  return [pscustomobject]@{
    top = [pscustomobject]@{ entry = $top.entry; file = $top.file; sha256 = $top.sha256; loop = $top.loop; role = 'presence' }
    front = [pscustomobject]@{ entry = $front.entry; file = $front.file; sha256 = $front.sha256; loop = $front.loop; role = 'profile_try_on' }
    entries = @($entries | Group-Object entry | ForEach-Object { $_.Group[0] })
  }
}

function Join-VemRecordedFixturePath {
  param(
    [string]$Parent,
    [string]$Child
  )
  if ($Parent.EndsWith('\')) { return "$Parent$Child" }
  return "$Parent\$Child"
}

function Get-VemRecordedFixtureDependency {
  param(
    [hashtable]$Dependencies,
    [string]$Name,
    [scriptblock]$Default
  )
  if ($Dependencies.ContainsKey($Name) -and $null -ne $Dependencies[$Name]) {
    return $Dependencies[$Name]
  }
  return $Default
}

function Test-VemRecordedFixtureRolesReady {
  param([object]$Roles)
  return $null -ne $Roles -and $null -ne $Roles.PSObject.Properties['roles'] -and @($Roles.roles).Count -gt 0 -and @($Roles.roles | Where-Object { $_.ready -ne $true -or $null -eq $_.pid }).Count -eq 0
}

function Get-VemRecordedFixtureOwnerPids {
  param([object]$Owner)
  if ($null -eq $Owner -or $null -eq $Owner.PSObject.Properties['canonicalProcesses']) {
    return @()
  }
  return @($Owner.canonicalProcesses | ForEach-Object { [int]$_.ProcessId })
}

function Get-VemRecordedFixtureOwnerWorkerPids {
  param([object]$Owner)
  if ($null -eq $Owner -or $null -eq $Owner.PSObject.Properties['workerProcesses']) {
    return @()
  }
  return @($Owner.workerProcesses | ForEach-Object { [int]$_.ProcessId })
}

function Get-VemRecordedFixtureOwnerMainPid {
  param([object]$Owner)
  if ($null -eq $Owner -or $null -eq $Owner.PSObject.Properties['mainProcess'] -or $null -eq $Owner.mainProcess -or $null -eq $Owner.mainProcess.PSObject.Properties['ProcessId']) {
    throw 'Vision canonical owner 缺少 main PID'
  }
  return [int]$Owner.mainProcess.ProcessId
}

function Format-VemRecordedFixtureBoundedPidList {
  param([int[]]$ProcessIds)

  $pidList = @($ProcessIds | Select-Object -Unique)
  if ($pidList.Count -eq 0) { return 'none' }
  $visiblePids = @($pidList | Select-Object -First 8)
  $suffix = if ($pidList.Count -gt $visiblePids.Count) { ",+$($pidList.Count - $visiblePids.Count)" } else { '' }
  return (($visiblePids -join ',') + $suffix)
}

function Get-VemRecordedFixtureOwnerBindingSummary {
  param([object]$Owner)

  if ($null -eq $Owner) { return 'none' }
  try {
    $mainPid = Get-VemRecordedFixtureOwnerMainPid $Owner
    $canonicalPids = Get-VemRecordedFixtureOwnerPids $Owner
    return "mainPid:$mainPid,pids:$(Format-VemRecordedFixtureBoundedPidList $canonicalPids)"
  } catch {
    return 'invalid'
  }
}

function Invoke-VemRecordedFixtureOwnerRestart {
  param(
    [hashtable]$Dependencies,
    [int]$ReadyStabilityMs,
    [switch]$AllowDegradedOwner
  )

  $getRoles = Get-VemRecordedFixtureDependency $Dependencies 'GetRoles' {
    Invoke-RestMethod -Uri 'http://127.0.0.1:7892/v2/runtime/roles' -TimeoutSec 2 -ErrorAction Stop
  }
  $getCanonicalOwner = Get-VemRecordedFixtureDependency $Dependencies 'GetCanonicalOwner' {
    $visionMainModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'windows\vision-main-artifacts.psm1'
    $visionMainModule = Import-Module $visionMainModulePath -Force -PassThru -ErrorAction Stop
    & $visionMainModule {
      Get-VisionMainCanonicalProcessBinding 'C:\VEM\vision\app' 'C:\ProgramData\VEM\vision\site.json'
    }
  }
  $stopCanonicalOwner = Get-VemRecordedFixtureDependency $Dependencies 'StopCanonicalOwner' {
    $visionMainModulePath = Join-Path (Split-Path -Parent $PSScriptRoot) 'windows\vision-main-artifacts.psm1'
    $visionMainModule = Import-Module $visionMainModulePath -Force -PassThru -ErrorAction Stop
    & $visionMainModule {
      Stop-VisionMainTask `
        -AppDirectory 'C:\VEM\vision\app' `
        -ConfigurationPath 'C:\ProgramData\VEM\vision\site.json' `
        -TaskName 'VEMVisionRuntime' `
        -TaskPath '\'
    }
  }
  $startOwner = Get-VemRecordedFixtureDependency $Dependencies 'StartOwner' {
    Start-ScheduledTask -TaskName 'VEMVisionRuntime' -ErrorAction Stop
  }
  $processExists = Get-VemRecordedFixtureDependency $Dependencies 'ProcessExists' {
    param([int]$ProcessId)
    $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
  }
  $stopProcess = Get-VemRecordedFixtureDependency $Dependencies 'StopProcess' {
    param([int]$ProcessId)
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
  }
  $getScheduledOwner = Get-VemRecordedFixtureDependency $Dependencies 'GetScheduledOwner' {
    Get-ScheduledTask -TaskName 'VEMVisionRuntime' -ErrorAction SilentlyContinue
  }
  $now = Get-VemRecordedFixtureDependency $Dependencies 'Now' { [DateTime]::UtcNow }
  $sleep = Get-VemRecordedFixtureDependency $Dependencies 'Sleep' {
    param([int]$Milliseconds)
    Start-Sleep -Milliseconds $Milliseconds
  }

  $before = $null
  $rolesReachableBeforeStop = $false
  try {
    $before = & $getRoles
    $rolesReachableBeforeStop = $true
  } catch {
    # 已停止 owner 的 roles 端点预期不可达；由 canonical binding 共同判定是否可直接启动。
  }
  $oldOwner = & $getCanonicalOwner
  $ownerPresentBeforeStop = $null -ne $oldOwner
  $normalRunningOwner = $rolesReachableBeforeStop -and (Test-VemRecordedFixtureRolesReady $before) -and $ownerPresentBeforeStop
  $fullyStoppedOwner = -not $rolesReachableBeforeStop -and -not $ownerPresentBeforeStop
  $initialOwnerState = if ($fullyStoppedOwner) { 'stopped' } elseif ($normalRunningOwner) { 'running' } else { 'partial' }
  if ($initialOwnerState -eq 'stopped') {
    # select 曾成功停止但尚未重新拉起 owner 时，restore 必须可幂等恢复默认 site。
    & $startOwner
  } else {
    if ($rolesReachableBeforeStop -and -not (Test-VemRecordedFixtureRolesReady $before) -and -not $AllowDegradedOwner) {
      throw '切换前 Vision runtime 角色未全部 ready'
    }
    if ($null -eq $oldOwner) {
      throw '切换前 Vision runtime roles 可达但缺少唯一 canonical Vision owner'
    }
    if ((Get-VemRecordedFixtureOwnerPids $oldOwner).Count -eq 0) {
      throw '切换前 canonical Vision owner 没有进程集合'
    }
    # 只有预先验证 roles ready 与唯一 canonical owner 的状态是 running；其余
    # owner 可识别状态属于部分停止，仍只按 canonical 进程完成安全收敛。

    $oldMainPid = Get-VemRecordedFixtureOwnerMainPid $oldOwner
    $oldCanonicalPids = Get-VemRecordedFixtureOwnerPids $oldOwner

    # VEMVisionRuntime 的 launcher 拉起进程后即退出，任务通常为 Ready；必须按
    # executable+config 停掉已脱离 task 的 canonical 进程，不能只 Stop-ScheduledTask。
    & $stopCanonicalOwner
    # Stop-VisionMainTask 可能先令 roles/binding 消失，再留下已脱离 task 的 worker；
    # 只终止切换前由 canonical binding 证明属于旧 owner 的仍存活 PID。
    $oldWorkerPids = Get-VemRecordedFixtureOwnerWorkerPids $oldOwner
    foreach ($oldWorkerPid in @($oldWorkerPids | Where-Object { & $processExists $_ })) {
      & $stopProcess $oldWorkerPid
    }
    $stopDeadline = (& $now).AddSeconds(30)
    $oldOwnerExited = $false
    $lastStopObservation = 'roles=reachable; remainingOldPids=none; canonicalBinding=unknown'
    do {
      $rolesStopped = $false
      try {
        $ignoredRoles = & $getRoles
      } catch {
        $rolesStopped = $true
      }
      $remainingOldPids = @($oldCanonicalPids | Where-Object { & $processExists $_ })
      $currentCanonicalOwner = $null
      $canonicalBindingReadable = $true
      try {
        $currentCanonicalOwner = & $getCanonicalOwner
      } catch {
        $canonicalBindingReadable = $false
      }
      $rolesState = if ($rolesStopped) { 'stopped' } else { 'reachable' }
      $lastStopObservation = "roles=$rolesState; remainingOldPids=$(Format-VemRecordedFixtureBoundedPidList $remainingOldPids); canonicalBinding=$(if ($canonicalBindingReadable) { Get-VemRecordedFixtureOwnerBindingSummary $currentCanonicalOwner } else { 'unavailable' })"
      $oldOwnerExited = $rolesStopped -and $remainingOldPids.Count -eq 0 -and $canonicalBindingReadable -and $null -eq $currentCanonicalOwner
      if ($oldOwnerExited) { break }
      & $sleep 100
    } while ((& $now) -lt $stopDeadline)
    if (-not $oldOwnerExited) {
      throw "停止后旧 Vision owner 未收敛（$lastStopObservation）"
    }

    & $startOwner
  }
  $oldMainPid = if ($null -ne $oldOwner) { Get-VemRecordedFixtureOwnerMainPid $oldOwner } else { $null }
  $oldCanonicalPids = if ($null -ne $oldOwner) { Get-VemRecordedFixtureOwnerPids $oldOwner } else { @() }
  $readyDeadline = (& $now).AddSeconds(60)
  $stableRoleSignature = $null
  $stableSince = $null
  do {
    try {
      $roles = & $getRoles
    } catch {
      $roles = $null
    }
    $ready = Test-VemRecordedFixtureRolesReady $roles
    $task = & $getScheduledOwner
    $owner = & $getCanonicalOwner
    $taskState = if ($null -ne $task) { [string]$task.State } else { $null }
    $singleOwner = $null -ne $task -and [string]$task.TaskName -eq 'VEMVisionRuntime' -and @('Ready', 'Running') -contains $taskState -and $null -ne $owner
    $newCanonicalPids = Get-VemRecordedFixtureOwnerPids $owner
    $newRolePids = if ($ready) { @($roles.roles | ForEach-Object { [int]$_.pid }) } else { @() }
    $rolesBelongToNewOwner = $ready -and $null -ne $owner -and (Get-VemRecordedFixtureOwnerMainPid $owner) -ne $oldMainPid -and @($newRolePids | Where-Object { $newCanonicalPids -notcontains $_ -or $oldCanonicalPids -contains $_ }).Count -eq 0
    $newCanonicalOwnerDisjoint = @($newCanonicalPids | Where-Object { $oldCanonicalPids -contains $_ }).Count -eq 0
    $completeOwnerReady = $singleOwner -and $rolesBelongToNewOwner -and $newCanonicalOwnerDisjoint
    $signature = if ($completeOwnerReady) {
      "task:$taskState;owner:$(@($newCanonicalPids | Sort-Object) -join ',');roles:$(@($roles.roles | Sort-Object name | ForEach-Object { "$($_.name):$($_.pid)" }) -join '|')"
    } else {
      $null
    }
    $currentTime = & $now
    if ($signature -ne $stableRoleSignature) {
      $stableRoleSignature = $signature
      $stableSince = if ($null -ne $signature) { $currentTime } else { $null }
    }
    if ($completeOwnerReady -and $null -ne $stableSince -and ($currentTime - $stableSince).TotalMilliseconds -ge $ReadyStabilityMs) {
      return
    }
    & $sleep 250
  } while ((& $now) -lt $readyDeadline)
  throw '新 VEMVisionRuntime owner 未以唯一稳定 roles/PID ready 状态启动'
}

function Set-VemRecordedFixtureObjectProperty {
  param(
    [object]$Object,
    [string]$Name,
    [object]$Value
  )
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
  } else {
    $property.Value = $Value
  }
}

function Invoke-VemRecordedFixtureSwitch {
  [CmdletBinding()]
  param(
    [ValidateSet('select', 'restore', 'recommendation', 'departure')]
    [string]$Mode,
    [ValidateSet('far', 'mid', 'near')]
    [string]$Segment = 'mid',
    [hashtable]$Dependencies = @{},
    [int]$ReadyStabilityMs = 1000
  )

  # 任何写配置或重启都只能发生在已安装产物锚、expected-results 与 clip 摘要验证之后。
  $installedPath = 'C:\ProgramData\VEM\vision\installed.json'
  $sitePath = 'C:\ProgramData\VEM\vision\site.json'
  $readText = if ($null -ne $Dependencies['ReadText']) {
    $Dependencies['ReadText']
  } else {
    { param([string]$Path) Get-Content -LiteralPath $Path -Raw -ErrorAction Stop }
  }
  $fileExists = if ($null -ne $Dependencies['FileExists']) {
    $Dependencies['FileExists']
  } else {
    { param([string]$Path) Test-Path -LiteralPath $Path -PathType Leaf }
  }
  $resolveHashFilePath = Get-VemRecordedFixtureDependency $Dependencies 'ResolveHashFilePath' {
    param([string]$Path)
    return $Path
  }
  $getSha256 = if ($null -ne $Dependencies['GetSha256']) {
    $Dependencies['GetSha256']
  } else {
    {
      param([string]$Path)
      $stream = $null
      $sha256 = $null
      try {
        $stream = [IO.File]::OpenRead((& $resolveHashFilePath $Path))
        $sha256 = [Security.Cryptography.SHA256]::Create()
        return -join ($sha256.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') })
      } finally {
        if ($null -ne $sha256) { $sha256.Dispose() }
        if ($null -ne $stream) { $stream.Dispose() }
      }
    }
  }
  $joinPath = Get-VemRecordedFixtureDependency $Dependencies 'JoinPath' {
    param([string]$Parent, [string]$Child)
    if ($env:OS -eq 'Windows_NT') { return Join-Path $Parent $Child }
    return Join-VemRecordedFixturePath $Parent $Child
  }
  $writeTextAtomically = Get-VemRecordedFixtureDependency $Dependencies 'WriteTextAtomically' {
    param([string]$Path, [string]$Content)
    $temporaryPath = "$Path.$PID.tmp"
    [IO.File]::WriteAllText($temporaryPath, $Content, (New-Object Text.UTF8Encoding($false)))
    Move-Item -LiteralPath $temporaryPath -Destination $Path -Force -ErrorAction Stop
  }

  if (-not (& $fileExists $installedPath)) {
    throw '安装 Vision installed.json 缺失'
  }
  try {
    $installed = (& $readText $installedPath) | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw '安装 Vision installed.json 不是有效 JSON'
  }
  if ($null -eq $installed -or [string]$installed.schemaVersion -cne 'vem-vision-installed/v1') {
    throw '安装 Vision installed.json schema 错误'
  }
  if ($null -eq $installed.siteConfiguration -or [string]$installed.siteConfiguration.path -cne $sitePath) {
    throw '安装 Vision site configuration 路径错误'
  }
  if ($null -eq $installed.fixtureSet -or -not (Test-VemRecordedFixtureLocalPath ([string]$installed.fixtureSet.root))) {
    throw '安装 Vision fixtureSet.root 不是严格本地绝对路径'
  }
  $recordedRoot = & $joinPath ([string]$installed.fixtureSet.root) 'recorded-video'
  if (-not (Test-VemRecordedFixtureLocalPath $recordedRoot)) {
    throw '安装 Vision recorded-video 根目录不是严格本地绝对路径'
  }
  $fixtureManifestPath = & $joinPath $recordedRoot 'fixture-manifest.json'
  $expectedResultsPath = & $joinPath $recordedRoot 'expected-results.json'
  if ([string]$installed.fixtureSet.manifestPath -cne $fixtureManifestPath -or [string]$installed.fixtureSet.expectedResults.path -cne $expectedResultsPath) {
    throw '安装 Vision fixtureSet 路径没有绑定到 recorded-video 根目录'
  }
  $manifestSha256 = [string]$installed.fixtureSet.manifestSha256
  $expectedResultsSha256 = [string]$installed.fixtureSet.expectedResults.sha256
  if ($manifestSha256 -notmatch '^[a-f0-9]{64}$' -or $expectedResultsSha256 -notmatch '^[a-f0-9]{64}$') {
    throw '安装 Vision fixtureSet 缺少规范 SHA-256'
  }
  if (-not (& $fileExists $fixtureManifestPath) -or -not (& $fileExists $expectedResultsPath)) {
    throw '安装 Vision fixture manifest 或 expected-results 缺失'
  }
  if ((& $getSha256 $fixtureManifestPath) -cne $manifestSha256) {
    throw '安装 Vision fixture-manifest SHA-256 不匹配'
  }
  if ((& $getSha256 $expectedResultsPath) -cne $expectedResultsSha256) {
    throw '安装 Vision expected-results SHA-256 不匹配'
  }
  try {
    $expectedResults = (& $readText $expectedResultsPath) | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw '安装 Vision expected-results 不是有效 JSON'
  }

  if ($Mode -eq 'select') {
    $geometryEntryBySegment = @{ far = 'geometryFar'; mid = 'geometryMid'; near = 'geometryNear' }
    $decision = Resolve-VemRecordedFixtureCameraDecision $expectedResults 'manFront' $true $geometryEntryBySegment[$Segment] $true $true
  } elseif ($Mode -eq 'recommendation') {
    if ($Segment -eq 'mid') {
      throw '现场推荐录播只支持 near 或 far'
    }
    $recommendationEntryBySegment = @{
      near = [pscustomobject]@{ top = 'fieldRecommendationNearTop'; front = 'fieldRecommendationNearFront' }
      far = [pscustomobject]@{ top = 'fieldRecommendationFarTop'; front = 'fieldRecommendationFarFront' }
    }
    $recommendation = $recommendationEntryBySegment[$Segment]
    $decision = Resolve-VemRecordedFixtureCameraDecision $expectedResults $recommendation.top $true $recommendation.front $true $false
  } elseif ($Mode -eq 'departure') {
    $decision = Resolve-VemRecordedFixtureCameraDecision $expectedResults 'top' $false 'frontVerticalUnstable' $true $false
  } else {
    $decision = Resolve-VemRecordedFixtureCameraDecision $expectedResults 'top' $false 'frontVertical' $true $false
  }
  $pathsByEntry = @{}
  # 选择任一 geometry 子场景前同时检查 manFront 和 far/mid/near，避免慢失败。
  foreach ($recording in @($decision.entries)) {
    $path = & $joinPath $recordedRoot ([string]$recording.file)
    if (-not (Test-VemRecordedFixtureLocalPath $path) -or -not (& $fileExists $path)) {
      throw "安装录播文件缺失或不是本地绝对路径: $([string]$recording.entry)"
    }
    if ((& $getSha256 $path) -cne [string]$recording.sha256) {
      throw "安装录播文件摘要不匹配: $([string]$recording.entry)"
    }
    $pathsByEntry[[string]$recording.entry] = $path
  }
  try {
    $configuration = (& $readText $sitePath) | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw '安装 Vision site.json 不是有效 JSON'
  }
  if ($null -eq $configuration.cameras -or $null -eq $configuration.cameras.top -or $null -eq $configuration.cameras.front) {
    throw '安装 Vision site.json 缺少 top/front camera'
  }
  foreach ($cameraName in @('top', 'front')) {
    $cameraDecision = $decision.$cameraName
    $camera = $configuration.cameras.$cameraName
    Set-VemRecordedFixtureObjectProperty $camera 'source' 'recorded_video'
    Set-VemRecordedFixtureObjectProperty $camera 'role' ([string]$cameraDecision.role)
    Set-VemRecordedFixtureObjectProperty $camera 'video_path' ([string]$pathsByEntry[[string]$cameraDecision.entry])
    Set-VemRecordedFixtureObjectProperty $camera 'loop' $cameraDecision.loop
  }
  $ignoredWrite = & $writeTextAtomically $sitePath ($configuration | ConvertTo-Json -Depth 16)
  Invoke-VemRecordedFixtureOwnerRestart $Dependencies $ReadyStabilityMs -AllowDegradedOwner:($Mode -eq 'restore')
  return [pscustomobject]@{
    mode = $Mode
    top = $decision.top
    front = $decision.front
  }
}

Export-ModuleMember -Function Test-VemRecordedFixtureLocalPath, Resolve-VemRecordedFixtureCameraDecision, Invoke-VemRecordedFixtureSwitch
