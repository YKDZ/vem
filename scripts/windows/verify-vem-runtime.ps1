param(
  [string]$ReadyFile = "C:\ProgramData\VEM\vending-daemon\daemon-ready.json",
  [string]$DaemonConfig = "C:\ProgramData\VEM\vending-daemon\machine-config.json",
  [string]$ServiceName = "VemVendingDaemon",
  [switch]$ExpectSimulator,
  [switch]$RequireScannerOnline,
  [switch]$RequireHardwareOnline,
  [switch]$RequireVisionOnline,
  [switch]$VisionOnly,
  [switch]$RequireBackendOnline,
  [switch]$RequireMqttConnected,
  [switch]$RequireCanSell,
  [string]$VisionTaskName = "VEM\StartVisionServer",
  [string]$VisionDirectory = "C:\VEM\vision",
  [string]$VisionLauncher = "C:\VEM\bringup\start_vision.bat",
  [string]$VisionActiveProcessFile = "C:\ProgramData\VEM\vision\process-state\active-process.json",
  [string]$VisionSelectionFile = "C:\ProgramData\VEM\vision\current.json",
  [string]$VisionStateRoot = "C:\ProgramData\VEM\vision",
  [string]$StartupBringupEvidenceFile = "C:\ProgramData\VEM\vending-daemon\startup-bringup-evidence.json",
  [switch]$RequireProductionBringup,
  [string]$ExpectedAutoLogonUser = "VEMKiosk",
  [string]$MachineUiTaskName = "VEMMachineUI",
  [string]$ExpectedMachineUiCommand = "C:\Windows\System32\wscript.exe",
  [string]$ExpectedMachineUiLauncher = "C:\VEM\bringup\launch-machine-ui.vbs",
  [string]$ExpectedMachineUiWorkingDirectory = "C:\VEM\bringup",
  [string]$ExpectedMachineUiExe = "C:\VEM\bringup\machine.exe"
)

$ErrorActionPreference = "Stop"
trap {
  Write-Error $_
  exit 1
}

function Add-Failure([System.Collections.Generic.List[string]]$Failures, [string]$Message) {
  $Failures.Add($Message) | Out-Null
}

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path $Path)) {
    throw "file not found: $Path"
  }
  return [System.IO.File]::ReadAllText(
    $Path,
    [System.Text.Encoding]::UTF8
  ) | ConvertFrom-Json
}

function Get-IpcBaseUrl($Ready) {
  $healthz = [string]$Ready.healthzUrl
  if ([string]::IsNullOrWhiteSpace($healthz)) {
    throw "healthzUrl missing from ready file"
  }
  $lastSlash = $healthz.LastIndexOf("/")
  if ($lastSlash -le 0) {
    throw "invalid healthzUrl: $healthz"
  }
  return $healthz.Substring(0, $lastSlash)
}

function Invoke-IpcJson([string]$Method, [string]$Uri, $Headers) {
  if ($Method -eq "POST") {
    return Invoke-RestMethod -Method Post -Uri $Uri -Headers $Headers -TimeoutSec 10
  }
  return Invoke-RestMethod -Method Get -Uri $Uri -Headers $Headers -TimeoutSec 10
}

function Add-VisionFailure($Failures, [string]$Message) {
  Add-Failure $Failures $Message
}

function Test-VisionRuntimeBinding {
  param([System.Collections.Generic.List[string]]$Failures)
  $result = [ordered]@{ selectionValid=$false; metadataValid=$false; processValid=$false; healthValid=$false; protocolValid=$false }
  try {
    $selection = Read-JsonFile $VisionSelectionFile
    $selectionKeys = @($selection.PSObject.Properties.Name | Sort-Object)
    $expectedSelectionKeys = @("approvalDigest","arguments","bundleDigest","configurationArgument","configurationPath","descriptorDigest","entrypoint","installDirectory","metadataPath","revision","schemaVersion" | Sort-Object)
    if (($selectionKeys -join "|") -cne ($expectedSelectionKeys -join "|") -or $selection.schemaVersion -cne "vem-vision-selection/v1" -or $selection.bundleDigest -notmatch '^sha256:[a-f0-9]{64}$' -or $selection.descriptorDigest -notmatch '^sha256:[a-f0-9]{64}$' -or $selection.approvalDigest -notmatch '^sha256:[a-f0-9]{64}$' -or [string]::IsNullOrWhiteSpace([string]$selection.revision)) { throw "current selection schema is invalid" }
    $metadataRoot = Join-Path $VisionStateRoot "release-metadata"
    $metadataPath = [IO.Path]::GetFullPath([string]$selection.metadataPath)
    if (-not $metadataPath.StartsWith(([IO.Path]::GetFullPath($metadataRoot) + [IO.Path]::DirectorySeparatorChar), [StringComparison]::OrdinalIgnoreCase)) { throw "current selection metadata path escapes state root" }
    $metadata = Read-JsonFile $metadataPath
    $metadataKeys = @($metadata.PSObject.Properties.Name | Sort-Object)
    $expectedMetadataKeys = @("approval","approvalDigest","attestation","bundleDigest","descriptor","descriptorDigest","documents","entrypoint","entrypointDigest","files","installDirectory","schemaVersion" | Sort-Object)
    if (($metadataKeys -join "|") -cne ($expectedMetadataKeys -join "|") -or $metadata.schemaVersion -cne "vem-vision-release-record/v2" -or $metadata.bundleDigest -cne $selection.bundleDigest -or $metadata.descriptorDigest -cne $selection.descriptorDigest -or $metadata.approvalDigest -cne $selection.approvalDigest -or $metadata.installDirectory -cne $selection.installDirectory -or $metadata.entrypoint -cne $selection.entrypoint) { throw "approved release metadata does not bind current selection" }
    $entrypoint = Join-Path $selection.installDirectory $selection.entrypoint
    if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf) -or ("sha256:" + (Get-FileHash -LiteralPath $entrypoint -Algorithm SHA256).Hash.ToLowerInvariant()) -cne $metadata.entrypointDigest) { throw "selected entrypoint digest mismatch" }
    $actualFiles = @(Get-ChildItem -LiteralPath $selection.installDirectory -File -Recurse -Force | Sort-Object FullName | ForEach-Object { [ordered]@{ path=$_.FullName.Substring($selection.installDirectory.Length).TrimStart('\\').Replace('\\','/'); bytes=[Int64]$_.Length; digest=("sha256:" + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()) } })
    if (($actualFiles | ConvertTo-Json -Depth 8 -Compress) -cne (@($metadata.files) | ConvertTo-Json -Depth 8 -Compress)) { throw "selected extracted file manifest mismatch" }
    $result.selectionValid=$true; $result.metadataValid=$true
    $active = Read-JsonFile $VisionActiveProcessFile
    $activeKeys = @($active.PSObject.Properties.Name | Sort-Object)
    $expectedActiveKeys = @("bundleDigest","creationTimeUtcTicks","executableDigest","executablePath","processId","selectionRevision" | Sort-Object)
    if (($activeKeys -join "|") -cne ($expectedActiveKeys -join "|") -or $active.bundleDigest -cne $selection.bundleDigest -or $active.selectionRevision -cne $selection.revision -or $active.executablePath -cne $entrypoint -or $active.executableDigest -cne $metadata.entrypointDigest) { throw "active Vision process record does not bind selection" }
    $process = Get-Process -Id ([int]$active.processId) -ErrorAction Stop
    if ($active.creationTimeUtcTicks -isnot [Int64] -or $process.StartTime.ToUniversalTime().Ticks -ne $active.creationTimeUtcTicks -or $process.Path -cne $entrypoint -or ("sha256:" + (Get-FileHash -LiteralPath $process.Path -Algorithm SHA256).Hash.ToLowerInvariant()) -cne $metadata.entrypointDigest) { throw "active Vision PID, creation time, path, or hash mismatch" }
    $result.processValid=$true
    $descriptor=$metadata.descriptor
    $health = Invoke-RestMethod -Uri ("http://127.0.0.1:{0}{1}" -f $descriptor.health.port,$descriptor.health.path) -TimeoutSec ([Math]::Max(1,[int]($descriptor.health.timeoutMs / 1000)))
    if ($health.pid -ne $process.Id -or $health.bundleDigest -cne $selection.bundleDigest -or $health.executableDigest -cne $metadata.entrypointDigest -or $health.protocolVersion -cne "vem.vision.v1" -or $health.schemaVersion -cne "vem-machine-vision-health/v1") { throw "Vision health does not bind current selected process" }
    $result.healthValid=$true
    $socket=[Net.WebSockets.ClientWebSocket]::new(); $cancel=[Threading.CancellationTokenSource]::new([TimeSpan]::FromMilliseconds([int]$descriptor.health.timeoutMs))
    try { $socket.ConnectAsync([Uri]("ws://127.0.0.1:{0}{1}" -f $descriptor.health.port,$descriptor.protocol.webSocketPath),$cancel.Token).GetAwaiter().GetResult(); $hello=[ordered]@{protocol="vem.vision.v1";type="vision.hello";messageId="runtime-verifier";timestamp=[DateTime]::UtcNow.ToString("o");payload=[ordered]@{clientRole="machine";machineCode=$null;protocolVersion=1;capabilities=@("profile_push","presence_status","person_departed","ambient_light")}}; $bytes=[Text.Encoding]::UTF8.GetBytes(($hello|ConvertTo-Json -Compress -Depth 8)); $socket.SendAsync([ArraySegment[byte]]::new($bytes),[Net.WebSockets.WebSocketMessageType]::Text,$true,$cancel.Token).GetAwaiter().GetResult(); $buffer=[byte[]]::new(8192); $message=$socket.ReceiveAsync([ArraySegment[byte]]::new($buffer),$cancel.Token).GetAwaiter().GetResult(); $ready=[Text.Encoding]::UTF8.GetString($buffer,0,$message.Count)|ConvertFrom-Json -Depth 16; if($ready.protocol -cne "vem.vision.v1" -or $ready.type -cne "vision.ready" -or [string]::IsNullOrWhiteSpace([string]$ready.messageId) -or [string]::IsNullOrWhiteSpace([string]$ready.timestamp) -or [string]::IsNullOrWhiteSpace([string]$ready.payload.serverName) -or [string]::IsNullOrWhiteSpace([string]$ready.payload.serverVersion) -or $ready.payload.cameraReady -isnot [bool] -or $ready.payload.modelReady -isnot [bool] -or $ready.payload.capabilities -isnot [array]) { throw "Vision WebSocket does not satisfy vem.vision.v1 ready contract" }; $result.protocolValid=$true } finally { $socket.Dispose(); $cancel.Dispose() }
  } catch { Add-VisionFailure $Failures $_.Exception.Message }
  return [pscustomobject]$result
}

function Get-WinlogonAutoLogonEvidence {
  $winlogon = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon" -ErrorAction SilentlyContinue
  if ($null -eq $winlogon) {
    return [pscustomobject]@{
      configured = $false
      user = $null
      domain = $null
      force = $false
    }
  }

  return [pscustomobject]@{
    configured = [string]$winlogon.AutoAdminLogon -eq "1"
    user = if ([string]::IsNullOrWhiteSpace($winlogon.DefaultUserName)) { $null } else { [string]$winlogon.DefaultUserName }
    domain = if ([string]::IsNullOrWhiteSpace($winlogon.DefaultDomainName)) { $null } else { [string]$winlogon.DefaultDomainName }
    force = [string]$winlogon.ForceAutoLogon -eq "1"
  }
}

function Get-ScheduledTaskStartupEvidence {
  param(
    [string]$TaskName,
    [string]$TaskPath = "\"
  )

  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    return [pscustomobject]@{
      name = "$TaskPath$TaskName"
      exists = $false
      enabled = $false
      runAsUser = $null
      command = $null
      arguments = $null
      workingDirectory = $null
    }
  }

  $action = @($task.Actions | Select-Object -First 1)
  return [pscustomobject]@{
    name = "$TaskPath$TaskName"
    exists = $true
    enabled = [string]$task.State -ne "Disabled"
    runAsUser = if ($null -ne $task.Principal) { [string]$task.Principal.UserId } else { $null }
    command = if ($action.Count -gt 0) { [string]$action[0].Execute } else { $null }
    arguments = if ($action.Count -gt 0) { [string]$action[0].Arguments } else { $null }
    workingDirectory = if ($action.Count -gt 0) { [string]$action[0].WorkingDirectory } else { $null }
  }
}

$failures = [System.Collections.Generic.List[string]]::new()
$checks = [ordered]@{}

$service = if ($VisionOnly) { $null } else { Get-Service -Name $ServiceName -ErrorAction SilentlyContinue }
if ($null -eq $service) {
  if (-not $VisionOnly) { Add-Failure $failures "service not found: $ServiceName" }
} else {
  $checks.service = [pscustomobject]@{
    name = $service.Name
    status = [string]$service.Status
    startType = [string]$service.StartType
  }
  if ($service.Status -ne "Running") {
    Add-Failure $failures "daemon service is not running: $($service.Status)"
  }
}

$config = $null
if (-not $VisionOnly -and (Test-Path $DaemonConfig)) {
  $config = Read-JsonFile $DaemonConfig
  $checks.config = [pscustomobject]@{
    machineCode = $config.machineCode
    hardwareAdapter = $config.hardwareAdapter
    serialPortPath = $config.serialPortPath
    scannerAdapter = $config.scannerAdapter
    scannerSerialPortPath = $config.scannerSerialPortPath
    apiBaseUrl = $config.apiBaseUrl
    mqttUrl = $config.mqttUrl
  }
} elseif (-not $VisionOnly) {
  Add-Failure $failures "daemon config not found: $DaemonConfig"
}

if ($ExpectSimulator) {
  $simProcess = Get-Process lower-controller-sim -ErrorAction SilentlyContinue | Select-Object -First 1
  $checks.simulator = [pscustomobject]@{
    running = $null -ne $simProcess
    pid = if ($null -ne $simProcess) { $simProcess.Id } else { $null }
  }
  if ($null -eq $simProcess) {
    Add-Failure $failures "lower-controller-sim process is not running"
  }
  if ($null -eq $config -or -not ([string]$config.serialPortPath).StartsWith("tcp://")) {
    Add-Failure $failures "ExpectSimulator requires serialPortPath=tcp://..., got: $($config.serialPortPath)"
  }
}

$visionTask = Get-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\VEM\" -ErrorAction SilentlyContinue
$visionLauncherExists = Test-Path -LiteralPath $VisionLauncher
$visionDirectoryExists = Test-Path -LiteralPath $VisionDirectory
$visionSelectionExists = Test-Path -LiteralPath $VisionSelectionFile
$visionActiveProcess = if (Test-Path -LiteralPath $VisionActiveProcessFile) {
  Read-JsonFile $VisionActiveProcessFile
} else {
  $null
}
$visionProcess = if ($null -ne $visionActiveProcess -and $null -ne $visionActiveProcess.processId) {
  Get-Process -Id ([int]$visionActiveProcess.processId) -ErrorAction SilentlyContinue
} else {
  $null
}
$checks.vision = [pscustomobject]@{
  taskName = $VisionTaskName
  taskReady = $null -ne $visionTask -and [string]$visionTask.State -ne "Disabled"
  taskState = if ($null -ne $visionTask) { [string]$visionTask.State } else { $null }
  launcher = $VisionLauncher
  launcherExists = $visionLauncherExists
  directory = $VisionDirectory
  directoryExists = $visionDirectoryExists
  selectionExists = $visionSelectionExists
  activeProcessRecordExists = $null -ne $visionActiveProcess
  activeProcessDigest = if ($null -ne $visionActiveProcess) { [string]$visionActiveProcess.bundleDigest } else { $null }
  processRunning = $null -ne $visionProcess
  processId = if ($null -ne $visionProcess) { $visionProcess.ProcessId } else { $null }
  binding = $null
}
if ($RequireVisionOnline) {
  if ($null -eq $visionTask -or [string]$visionTask.State -eq "Disabled") {
    Add-Failure $failures "vision task is not ready: $VisionTaskName"
  }
  if (-not $visionLauncherExists) {
    Add-Failure $failures "vision launcher not found: $VisionLauncher"
  }
  if (-not $visionDirectoryExists) {
    Add-Failure $failures "vision directory not found: $VisionDirectory"
  }
  if (-not $visionSelectionExists) {
    Add-Failure $failures "vision current selection not found: $VisionSelectionFile"
  }
  if ($null -eq $visionProcess) {
    Add-Failure $failures "vision process is not running from $VisionDirectory"
  }
  $checks.vision.binding = @(Test-VisionRuntimeBinding $failures)[-1]
}

$startupEvidenceExists = Test-Path -LiteralPath $StartupBringupEvidenceFile
$startupEvidence = if ($startupEvidenceExists) {
  Read-JsonFile $StartupBringupEvidenceFile
} else {
  $null
}
$liveAutoLogon = Get-WinlogonAutoLogonEvidence
$liveMachineUiTask = Get-ScheduledTaskStartupEvidence -TaskName $MachineUiTaskName
$machineUiStartupMode = if (
  $null -ne $startupEvidence -and
  [string]$startupEvidence.machineUiStartup.mode -eq "shell_launcher"
) {
  "shell_launcher"
} else {
  "scheduled_task"
}
$checks.startupBringup = [pscustomobject]@{
  evidenceFile = $StartupBringupEvidenceFile
  evidenceFileExists = $startupEvidenceExists
  evidence = $startupEvidence
  liveAutoLogon = $liveAutoLogon
  liveStartupCommands = @($liveMachineUiTask)
  expectedMachineUi = [pscustomobject]@{
    mode = $machineUiStartupMode
    taskName = $MachineUiTaskName
    runAsUser = $ExpectedAutoLogonUser
    command = $ExpectedMachineUiCommand
    argumentsContain = $ExpectedMachineUiLauncher
    workingDirectory = $ExpectedMachineUiWorkingDirectory
    shellCommand = $ExpectedMachineUiExe
  }
}

if ($RequireProductionBringup) {
  if (-not $startupEvidenceExists) {
    Add-Failure $failures "production bring-up evidence not found: $StartupBringupEvidenceFile"
  } else {
    if ([string]$startupEvidence.configuredBy -ne "scripts/windows/setup-scheduled-tasks.ps1") {
      Add-Failure $failures "startup was not configured by production bring-up: $($startupEvidence.configuredBy)"
    }
    if (-not [bool]$startupEvidence.productionBringup) {
      Add-Failure $failures "startup evidence does not assert productionBringup"
    }
    if ([bool]$startupEvidence.daemonOwnedInitialization) {
      Add-Failure $failures "startup evidence reports daemon-owned initialization"
    }
    if (-not [bool]$startupEvidence.autoLogon.configured) {
      Add-Failure $failures "Winlogon auto-logon is not configured in production bring-up evidence"
    }
    if ([string]$startupEvidence.autoLogon.user -ne $ExpectedAutoLogonUser) {
      Add-Failure $failures "Winlogon auto-logon target mismatch: expected $ExpectedAutoLogonUser, got $($startupEvidence.autoLogon.user)"
    }
    if (-not [bool]$startupEvidence.autoLogon.force) {
      Add-Failure $failures "Winlogon ForceAutoLogon is not enabled in production bring-up evidence"
    }
    if (-not [bool]$startupEvidence.machineUiStartup.configured) {
      Add-Failure $failures "machine UI startup is not configured in production bring-up evidence"
    }
    if ([string]$startupEvidence.machineUiStartup.runAsUser -ne $ExpectedAutoLogonUser) {
      Add-Failure $failures "machine UI startup user mismatch: expected $ExpectedAutoLogonUser, got $($startupEvidence.machineUiStartup.runAsUser)"
    }
    if (@($startupEvidence.startupCommands).Count -eq 0) {
      Add-Failure $failures "startup commands evidence is empty"
    }
  }

  if (-not [bool]$liveAutoLogon.configured) {
    Add-Failure $failures "live Winlogon auto-logon is not configured"
  }
  if ([string]$liveAutoLogon.user -ne $ExpectedAutoLogonUser) {
    Add-Failure $failures "live Winlogon auto-logon target mismatch: expected $ExpectedAutoLogonUser, got $($liveAutoLogon.user)"
  }
  if (-not [bool]$liveAutoLogon.force) {
    Add-Failure $failures "live Winlogon ForceAutoLogon is not enabled"
  }

  if ($machineUiStartupMode -eq "scheduled_task") {
    if (-not [bool]$liveMachineUiTask.exists) {
      Add-Failure $failures "live VEMMachineUI scheduled task not found: $MachineUiTaskName"
    } else {
      if (-not [bool]$liveMachineUiTask.enabled) {
        Add-Failure $failures "live VEMMachineUI scheduled task is disabled: $MachineUiTaskName"
      }
      if ([string]$liveMachineUiTask.runAsUser -ne $ExpectedAutoLogonUser) {
        Add-Failure $failures "live VEMMachineUI runAsUser mismatch: expected $ExpectedAutoLogonUser, got $($liveMachineUiTask.runAsUser)"
      }
      if ([string]$liveMachineUiTask.command -ne $ExpectedMachineUiCommand) {
        Add-Failure $failures "live VEMMachineUI command mismatch: expected $ExpectedMachineUiCommand, got $($liveMachineUiTask.command)"
      }
      if (-not ([string]$liveMachineUiTask.arguments).Contains($ExpectedMachineUiLauncher)) {
        Add-Failure $failures "live VEMMachineUI arguments do not reference $ExpectedMachineUiLauncher`: $($liveMachineUiTask.arguments)"
      }
      if ([string]$liveMachineUiTask.workingDirectory -ne $ExpectedMachineUiWorkingDirectory) {
        Add-Failure $failures "live VEMMachineUI working directory mismatch: expected $ExpectedMachineUiWorkingDirectory, got $($liveMachineUiTask.workingDirectory)"
      }
    }
  } elseif ($machineUiStartupMode -eq "shell_launcher") {
    if (-not (Test-Path -LiteralPath $ExpectedMachineUiExe)) {
      Add-Failure $failures "shell launcher machine UI executable not found: $ExpectedMachineUiExe"
    }
    if ([bool]$liveMachineUiTask.exists -and [bool]$liveMachineUiTask.enabled) {
      Add-Failure $failures "VEMMachineUI scheduled task should be removed or disabled when Shell Launcher owns startup"
    }
  }
}

if (-not $VisionOnly -and (Test-Path $ReadyFile)) {
  $ready = Read-JsonFile $ReadyFile
  $base = Get-IpcBaseUrl $ready
  $headers = @{ Authorization = ("Bearer " + $ready.ipcToken) }
  $checks.readyFile = [pscustomobject]@{
    path = $ReadyFile
    healthzUrl = $ready.healthzUrl
    readyzUrl = $ready.readyzUrl
  }

  $healthz = Invoke-IpcJson "GET" "$base/healthz" $headers
  $readyz = Invoke-IpcJson "GET" "$base/readyz" $headers
  $readiness = Invoke-IpcJson "GET" "$base/v1/sale-readiness" $headers
  $scanner = Invoke-IpcJson "GET" "$base/v1/scanner/status" $headers
  $hardware = Invoke-IpcJson "POST" "$base/v1/hardware/self-check" $headers
  $sync = Invoke-IpcJson "GET" "$base/v1/sync/status" $headers

  $checks.ipc = [pscustomobject]@{
    baseUrl = $base
    healthz = $healthz
    readyz = $readyz
    saleReadiness = $readiness
    scanner = $scanner
    hardware = $hardware
    sync = $sync
  }

  if ($RequireBackendOnline -and -not [bool]$healthz.backendOnline) {
    Add-Failure $failures "backend is not online"
  }
  if ($RequireMqttConnected -and -not [bool]$healthz.mqttConnected) {
    Add-Failure $failures "mqtt is not connected"
  }
  if ($RequireScannerOnline -and -not [bool]$scanner.online) {
    Add-Failure $failures "scanner is not online: $($scanner.code) $($scanner.message)"
  }
  if ($RequireHardwareOnline -and -not [bool]$hardware.online) {
    Add-Failure $failures "lower controller is not online: $($hardware.message)"
  }
  if ($RequireCanSell -and -not [bool]$readyz.canSell) {
    $blocking = @($readyz.blockingCodes) -join ","
    Add-Failure $failures "machine cannot sell: mode=$($readyz.mode) route=$($readyz.suggestedRoute) blockers=$blocking"
  }
} elseif (-not $VisionOnly) {
  Add-Failure $failures "daemon ready file not found: $ReadyFile"
}

$result = [pscustomobject]@{
  ok = $failures.Count -eq 0
  checkedAt = (Get-Date).ToUniversalTime().ToString("o")
  failures = @($failures)
  checks = $checks
}

$result | ConvertTo-Json -Depth 30
if ($failures.Count -gt 0) {
  exit 1
}
