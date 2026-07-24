$ErrorActionPreference = "Stop"

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-RequireHealthyFailure([string]$ExpectedMessage, [string]$Label) {
  $rejected = $false
  try {
    & $global:ProbeHarnessScript -DaemonDataDirectory $global:ProbeHarnessDaemonData -OwnerManifestPath $global:ProbeHarnessManifest -RequireHealthy | Out-Null
  } catch {
    $rejected = $_.Exception.Message -match $ExpectedMessage
  }
  Assert-True $rejected "$Label did not fail RequireHealthy"
}

$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-runtime-probe-harness-" + [guid]::NewGuid().ToString("N"))
$global:ProbeHarnessScript = Join-Path $PSScriptRoot "probe-vem-runtime.ps1"
$global:ProbeHarnessDaemonData = Join-Path $root "daemon-data"
$global:ProbeHarnessManifest = Join-Path $root "runtime-owners\owner-manifest.json"
$global:ProbeHarnessPassword = "prototype-password"
$global:ProbeHarnessLegacyTask = $false
$global:ProbeHarnessInvalidTrigger = $false
$global:ProbeHarnessInvalidAction = $false
$global:ProbeHarnessRestartPolicy = $false
$global:ProbeHarnessLegacyRuntimeTask = $false
$global:ProbeHarnessLegacyRuntimeService = $false
$global:ProbeHarnessServiceAccount = "LocalSystem"
$global:ProbeHarnessServiceStartMode = "Auto"
$global:ProbeHarnessServicePath = ""
$global:ProbeHarnessProcessUser = "VEMKiosk"

function global:Get-ItemProperty {
  param([string]$Path, $ErrorAction)
  return [pscustomobject]@{ AutoAdminLogon = "1"; DefaultUserName = "VEMKiosk"; DefaultDomainName = "."; DefaultPassword = $global:ProbeHarnessPassword }
}
function global:Get-Service {
  param([string]$Name, $ErrorAction)
  return [pscustomobject]@{ Name = $Name; Status = "Running" }
}
function global:Get-ScheduledTask {
  param([string]$TaskName, [string]$TaskPath, $ErrorAction)
  $tasks = @($global:ProbeHarnessTasks)
  if ($global:ProbeHarnessLegacyTask) {
    $tasks += [pscustomobject]@{ TaskName = "StartVisionServer"; TaskPath = "\VEM\"; Actions = @() }
  }
  if ($global:ProbeHarnessLegacyRuntimeTask) {
    $tasks += [pscustomobject]@{ TaskName = "LegacyMachineUI"; TaskPath = "\"; Actions = @([pscustomobject]@{ Execute = "C:\OldVEM\machine.exe"; Arguments = "" }) }
  }
  if ([string]::IsNullOrWhiteSpace($TaskName)) { return $tasks }
  return @($tasks | Where-Object { $_.TaskName -eq $TaskName -and $_.TaskPath -eq $TaskPath })
}
function global:Get-CimInstance {
  param([string]$ClassName, [string]$Filter, $ErrorAction)
  if ($ClassName -eq "Win32_Service") {
    $pathName = if ([string]::IsNullOrWhiteSpace($global:ProbeHarnessServicePath)) { '"' + $global:ProbeHarnessDaemon + '" --console --data-dir "' + $global:ProbeHarnessDaemonData + '"' } else { $global:ProbeHarnessServicePath }
    $services = @([pscustomobject]@{ Name = "VemVendingDaemon"; StartName = $global:ProbeHarnessServiceAccount; StartMode = $global:ProbeHarnessServiceStartMode; PathName = $pathName })
    if ($global:ProbeHarnessLegacyRuntimeService) {
      $services += [pscustomobject]@{ Name = "LegacyDaemon"; StartName = "LocalSystem"; StartMode = "Auto"; PathName = '"C:\OldVEM\vending-daemon.exe" --console' }
    }
    return $services
  }
  if ($ClassName -ne "Win32_Process") { return @() }
  if ($Filter -match "Name = '([^']+)'") { return @($global:ProbeHarnessProcesses | Where-Object { $_.Name -eq $Matches[1] }) }
  return @($global:ProbeHarnessProcesses)
}
function global:Invoke-CimMethod {
  param($InputObject, [string]$MethodName, $ErrorAction)
  return [pscustomobject]@{ ReturnValue = 0; Domain = "."; User = $global:ProbeHarnessProcessUser }
}
function global:Invoke-RestMethod {
  param($Method, $Uri, $Headers, $TimeoutSec)
  return [pscustomobject]@{ ok = $true }
}

try {
  New-Item -ItemType Directory -Force -Path $root, $global:ProbeHarnessDaemonData, (Split-Path -Parent $global:ProbeHarnessManifest) | Out-Null
  $global:ProbeHarnessDaemon = Join-Path $root "bringup\vending-daemon.exe"
  $machine = Join-Path $root "bringup\machine.exe"
  $vision = Join-Path $root "vision\app\vending-vision.exe"
  $machineLauncher = Join-Path $root "bringup\launch-vem-machine-ui.ps1"
  $visionLauncher = Join-Path $root "bringup\launch-vem-vision.ps1"
  $manifest = [ordered]@{
    schemaVersion = "vem-runtime-owners/v1"
    kiosk = [ordered]@{ user = "VEMKiosk" }
    owners = [ordered]@{
      daemon = [ordered]@{ name = "VemVendingDaemon"; executablePath = $global:ProbeHarnessDaemon }
      machineUi = [ordered]@{ name = "VEMMachineUI"; taskPath = "\"; user = "VEMKiosk"; executablePath = $machine; launcherPath = $machineLauncher; workingDirectory = (Split-Path -Parent $machine) }
      vision = [ordered]@{ name = "VEMVisionRuntime"; taskPath = "\"; user = "VEMKiosk"; executablePath = $vision; launcherPath = $visionLauncher; workingDirectory = (Split-Path -Parent $vision) }
    }
  }
  [IO.File]::WriteAllText($global:ProbeHarnessManifest, ($manifest | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $global:ProbeHarnessDaemonData "daemon-ready.json"), '{"readyzUrl":"http://127.0.0.1:17890/readyz","ipcToken":"harness"}', [Text.UTF8Encoding]::new($false))

  $newTask = {
    param($Name, $Launcher, $WorkingDirectory)
    $triggerClass = if ($global:ProbeHarnessInvalidTrigger -and $Name -eq "VEMVisionRuntime") { "MSFT_TaskBootTrigger" } else { "MSFT_TaskLogonTrigger" }
    $restartCount = if ($global:ProbeHarnessRestartPolicy -and $Name -eq "VEMVisionRuntime") { 1 } else { 0 }
    $actionExecutable = if ($global:ProbeHarnessInvalidAction -and $Name -eq "VEMVisionRuntime") { "C:\Windows\System32\cmd.exe" } else { "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" }
    [pscustomobject]@{
      TaskName = $Name
      TaskPath = "\"
      State = "Ready"
      Principal = [pscustomobject]@{ UserId = "VEMKiosk" }
      Triggers = @([pscustomobject]@{ CimClass = [pscustomobject]@{ CimClassName = $triggerClass }; UserId = "VEMKiosk" })
      Settings = [pscustomobject]@{ RestartCount = $restartCount; RestartInterval = "PT0S" }
      Actions = @([pscustomobject]@{ Execute = $actionExecutable; Arguments = ('-NoProfile -File "' + $Launcher + '"'); WorkingDirectory = $WorkingDirectory })
    }
  }
  $resetTasks = {
    $global:ProbeHarnessTasks = @(
      & $newTask "VEMMachineUI" $machineLauncher (Split-Path -Parent $machine)
      & $newTask "VEMVisionRuntime" $visionLauncher (Split-Path -Parent $vision)
    )
  }
  & $resetTasks
  $global:ProbeHarnessProcesses = @(
    [pscustomobject]@{ Name = "vending-daemon.exe"; ProcessId = 101; ExecutablePath = $global:ProbeHarnessDaemon; CommandLine = "daemon"; SessionId = 0 },
    [pscustomobject]@{ Name = "machine.exe"; ProcessId = 102; ExecutablePath = $machine; CommandLine = "machine"; SessionId = 1 },
    [pscustomobject]@{ Name = "vending-vision.exe"; ProcessId = 103; ExecutablePath = $vision; CommandLine = "vision"; SessionId = 1 }
  )

  & $global:ProbeHarnessScript -DaemonDataDirectory $global:ProbeHarnessDaemonData -OwnerManifestPath $global:ProbeHarnessManifest -RequireHealthy | Out-Null

  $global:ProbeHarnessServiceAccount = "LocalService"
  Assert-RequireHealthyFailure "daemon service account is not LocalSystem" "non-LocalSystem daemon service"
  $global:ProbeHarnessServiceAccount = "LocalSystem"
  $global:ProbeHarnessServicePath = "C:\unrelated\vending-daemon.exe"
  Assert-RequireHealthyFailure "daemon service path does not use the owner manifest executable" "unexpected daemon service path"
  $global:ProbeHarnessServicePath = ""

  $global:ProbeHarnessPassword = ""
  Assert-RequireHealthyFailure "automatic logon prerequisites are incomplete" "missing DefaultPassword"
  $global:ProbeHarnessPassword = "prototype-password"

  $global:ProbeHarnessInvalidTrigger = $true
  & $resetTasks
  Assert-RequireHealthyFailure "does not have a VEMKiosk AtLogon trigger" "non-logon Vision trigger"
  $global:ProbeHarnessInvalidTrigger = $false
  $global:ProbeHarnessInvalidAction = $true
  & $resetTasks
  Assert-RequireHealthyFailure "task action does not use the installed owner launcher and working directory" "unexpected Vision owner action"
  $global:ProbeHarnessInvalidAction = $false
  $global:ProbeHarnessRestartPolicy = $true
  & $resetTasks
  Assert-RequireHealthyFailure "task has a restart policy" "Vision restart policy"
  $global:ProbeHarnessRestartPolicy = $false
  & $resetTasks

  $global:ProbeHarnessLegacyTask = $true
  Assert-RequireHealthyFailure "competing runtime owners" "legacy StartVisionServer task"
  $global:ProbeHarnessLegacyTask = $false
  $global:ProbeHarnessLegacyRuntimeTask = $true
  Assert-RequireHealthyFailure "competing runtime owners" "legacy runtime executable task"
  $global:ProbeHarnessLegacyRuntimeTask = $false
  $global:ProbeHarnessLegacyRuntimeService = $true
  Assert-RequireHealthyFailure "competing runtime owners" "legacy runtime executable service"
  $global:ProbeHarnessLegacyRuntimeService = $false

  $global:ProbeHarnessProcesses | Where-Object { $_.Name -eq "machine.exe" } | ForEach-Object { $_.SessionId = 0 }
  Assert-RequireHealthyFailure "interactive runtime process ownership is invalid" "non-interactive Machine UI session"
  $global:ProbeHarnessProcesses | Where-Object { $_.Name -eq "machine.exe" } | ForEach-Object { $_.SessionId = 1 }
  $global:ProbeHarnessProcessUser = "OtherUser"
  Assert-RequireHealthyFailure "is not owned by VEMKiosk" "unexpected interactive process user"

  [ordered]@{ schemaVersion = "vem-runtime-probe-harness/v1"; requireHealthyFailures = @("non-localsystem-service", "unexpected-service-path", "missing-password", "missing-logon-trigger", "unexpected-task-action", "task-restart-policy", "legacy-vision-owner", "legacy-runtime-task-owner", "legacy-runtime-service-owner", "non-interactive-session", "unexpected-process-user") } | ConvertTo-Json -Compress
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
