[CmdletBinding()]
param(
  [string]$RuntimeDirectory = "C:\VEM\bringup",
  [string]$DaemonDataDirectory = "C:\ProgramData\VEM\vending-daemon",
  [string]$VisionAppDirectory = "C:\VEM\vision\app",
  [string]$VisionDataDirectory = "C:\ProgramData\VEM\vision",
  [string]$KioskUser = "VEMKiosk",
  [string]$KioskPassword,
  [ValidateRange(1, 65535)][int]$MachineUiWebViewDebugPort = 0,
  [string]$OwnerManifestPath = "C:\ProgramData\VEM\runtime-owners\owner-manifest.json"
)

$ErrorActionPreference = "Stop"
$script:OwnerDirectoryLeases = [Collections.Generic.List[object]]::new()

function Initialize-OwnerDirectoryLeaseApi {
  if ($env:OS -cne "Windows_NT" -or ("VemOwnerDirectoryLease" -as [type])) { return }
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class VemOwnerDirectoryLease {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, System.Text.StringBuilder path, uint length, uint flags);
  public static SafeFileHandle Open(string path) {
    var handle = CreateFileW(path, 0x80, 1, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error(), "failed to lease owner directory: " + path);
    return handle;
  }
  public static string FinalPath(SafeFileHandle handle) {
    var buffer = new System.Text.StringBuilder(32768);
    var length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
    if (length == 0 || length >= buffer.Capacity) throw new Win32Exception(Marshal.GetLastWin32Error(), "failed to resolve leased owner directory");
    var value = buffer.ToString();
    return value.StartsWith(@"\\?\") ? value.Substring(4) : value;
  }
}
'@
}

function Assert-OwnerPath([string]$Path, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
}

function Get-NormalizedOwnerDirectory([string]$Path, [string]$Label) {
  if ([string]::IsNullOrWhiteSpace($Path) -or -not [IO.Path]::IsPathRooted($Path)) {
    throw "$Label must be an absolute directory: $Path"
  }
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Label must be a regular non-reparse directory: $Path"
  }
  return [IO.Path]::GetFullPath($item.FullName).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Add-OwnerDirectoryLease([string]$Path, [string]$Label) {
  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
    throw "$Label contains a reparse or non-directory component: $Path"
  }
  if ($env:OS -ceq "Windows_NT") {
    Initialize-OwnerDirectoryLeaseApi
    $handle = [VemOwnerDirectoryLease]::Open($item.FullName)
    try {
      $finalPath = [IO.Path]::GetFullPath([VemOwnerDirectoryLease]::FinalPath($handle))
      if ($finalPath -ine [IO.Path]::GetFullPath($item.FullName)) {
        throw "$Label component resolved to a different final path: $Path"
      }
      $script:OwnerDirectoryLeases.Add([pscustomobject]@{ path = $finalPath; handle = $handle; label = $Label })
      $handle = $null
    } finally {
      if ($null -ne $handle) { $handle.Dispose() }
    }
  } else {
    $script:OwnerDirectoryLeases.Add([pscustomobject]@{
      path = [IO.Path]::GetFullPath($item.FullName)
      handle = $null
      label = $Label
      creationTimeUtc = $item.CreationTimeUtc.Ticks
      lastWriteTimeUtc = $item.LastWriteTimeUtc.Ticks
    })
  }
}

function Assert-OwnerDirectoryLeases {
  foreach ($lease in $script:OwnerDirectoryLeases) {
    $item = Get-Item -LiteralPath $lease.path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
      throw "$($lease.label) directory identity changed: $($lease.path)"
    }
    if ($null -ne $lease.handle) {
      $finalPath = [IO.Path]::GetFullPath([VemOwnerDirectoryLease]::FinalPath($lease.handle))
      if ($finalPath -ine [IO.Path]::GetFullPath($item.FullName)) { throw "$($lease.label) directory identity changed: $($lease.path)" }
    } elseif ($lease.creationTimeUtc -ne $item.CreationTimeUtc.Ticks -or $lease.lastWriteTimeUtc -ne $item.LastWriteTimeUtc.Ticks) {
      throw "$($lease.label) directory identity changed: $($lease.path)"
    }
  }
}

function Close-OwnerDirectoryLeases {
  foreach ($lease in $script:OwnerDirectoryLeases) {
    if ($null -ne $lease.handle) { $lease.handle.Dispose() }
  }
  $script:OwnerDirectoryLeases.Clear()
}

trap {
  Close-OwnerDirectoryLeases
  throw $_
}

function Assert-OwnerChildPath([string]$Path, [string]$Parent, [string]$Label) {
  $normalizedPath = Get-NormalizedOwnerDirectory $Path $Label
  $normalizedParent = Get-NormalizedOwnerDirectory $Parent "$Label authority root"
  $prefix = $normalizedParent + [IO.Path]::DirectorySeparatorChar
  if (-not $normalizedPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label must be contained by $normalizedParent"
  }
  $cursor = $normalizedParent
  Add-OwnerDirectoryLease $cursor $Label
  foreach ($component in $normalizedPath.Substring($prefix.Length).Split([IO.Path]::DirectorySeparatorChar)) {
    $cursor = Join-Path $cursor $component
    Add-OwnerDirectoryLease $cursor $Label
  }
  return $normalizedPath
}

function Invoke-Sc([string[]]$Arguments, [string]$Operation) {
  $output = & sc.exe @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "failed to $Operation ($LASTEXITCODE): $($output -join "`n")"
  }
}

function Grant-OwnerAccess([string]$Path, [string]$Rights) {
  New-Item -ItemType Directory -Force -Path $Path | Out-Null
  & icacls.exe $Path /grant:r "${KioskUser}:(OI)(CI)$Rights" /T /C /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "failed to grant $KioskUser access: $Path" }
}

function Write-InteractiveLauncher(
  [string]$LauncherPath,
  [string]$Role,
  [string]$ProcessName,
  [string]$ExecutablePath,
  [string[]]$ArgumentList,
  [string]$ResultPath,
  [int]$ReadinessPort = 0,
  [ValidateSet("process", "direct_listener", "descendant_listener")][string]$ReadinessBinding = "process",
  [string[]]$InheritedEnvironmentVariableNames = @(),
  [hashtable]$ExplicitEnvironmentVariables = @{}
) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LauncherPath) | Out-Null
  $argumentString = ($ArgumentList | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join " "
  $argumentStringLiteral = "'" + $argumentString.Replace("'", "''") + "'"
  $expectedArgumentsLiteral = if ($ArgumentList.Count -eq 0) {
    "@()"
  } else {
    "@(" + (($ArgumentList | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ", ") + ")"
  }
  $environmentNamesLiteral = if ($InheritedEnvironmentVariableNames.Count -eq 0) {
    "@()"
  } else {
    "@(" + (($InheritedEnvironmentVariableNames | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ", ") + ")"
  }
  $explicitEnvironmentLiteral = if ($ExplicitEnvironmentVariables.Count -eq 0) {
    "@{}"
  } else {
    "@{" + (($ExplicitEnvironmentVariables.GetEnumerator() | Sort-Object Name | ForEach-Object {
      "'" + ([string]$_.Key).Replace("'", "''") + "' = '" + ([string]$_.Value).Replace("'", "''") + "'"
    }) -join "; ") + "}"
  }
  $content = @"
[CmdletBinding()]
param(
  [ValidateSet("scheduled_task", "manual")][string]`$Adapter = "scheduled_task"
)

`$ErrorActionPreference = "Stop"
`$role = '$Role'
`$processName = '$ProcessName'
`$executablePath = '$ExecutablePath'
`$expectedArguments = $expectedArgumentsLiteral
`$resultPath = '$ResultPath'
`$readinessPort = $ReadinessPort
`$readinessBinding = '$ReadinessBinding'
`$invocationId = [Guid]::NewGuid().ToString("N")
`$startedAt = [DateTime]::UtcNow
`$ownerMutex = [Threading.Mutex]::new(`$false, "Local\VEM.RuntimeOwner.`$role")
`$ownsMutex = `$false
`$terminalResult = `$null
`$failureMessage = `$null

function New-OwnerLaunchResult(
  [string]`$Status,
  [string]`$FailedStage,
  [string]`$ReasonCode,
  [Nullable[int]]`$ProcessId,
  [bool]`$ProcessStable
) {
  return [ordered]@{
    schemaVersion = "vem-runtime-owner-launch-result/v1"
    role = `$role
    invocationId = `$invocationId
    adapter = `$Adapter
    startedAt = `$startedAt.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    finishedAt = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fff'Z'", [Globalization.CultureInfo]::InvariantCulture)
    status = `$Status
    failedStage = if ([string]::IsNullOrWhiteSpace(`$FailedStage)) { `$null } else { `$FailedStage }
    reasonCode = `$ReasonCode
    processId = `$ProcessId
    readiness = [ordered]@{
      processStable = `$ProcessStable
      listenerPort = if (`$readinessPort -gt 0) { `$readinessPort } else { `$null }
    }
  }
}

function Write-OwnerLaunchResult([object]`$Result) {
  `$resultDirectory = Split-Path -Parent `$resultPath
  New-Item -ItemType Directory -Force -Path `$resultDirectory | Out-Null
  `$temporaryResultPath = "`$resultPath.`$invocationId.tmp"
  try {
    [IO.File]::WriteAllText(
      `$temporaryResultPath,
      ((`$Result | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
      [Text.UTF8Encoding]::new(`$false)
    )
    Move-Item -LiteralPath `$temporaryResultPath -Destination `$resultPath -Force -ErrorAction Stop
  } finally {
    Remove-Item -LiteralPath `$temporaryResultPath -Force -ErrorAction SilentlyContinue
  }
}

function Stop-OwnerLaunch(
  [string]`$FailedStage,
  [string]`$ReasonCode,
  [string]`$Message
) {
  `$exception = [InvalidOperationException]::new(`$Message)
  `$exception.Data["failedStage"] = `$FailedStage
  `$exception.Data["reasonCode"] = `$ReasonCode
  throw `$exception
}

function Get-ObservedOwnerProcesses {
  return @(
    Get-CimInstance Win32_Process -Filter "Name = '`$processName'" -ErrorAction SilentlyContinue
  )
}

function Test-ExpectedExecutable([object]`$Process) {
  if ([string]::IsNullOrWhiteSpace([string]`$Process.ExecutablePath)) { return `$false }
  try {
    return [IO.Path]::GetFullPath([string]`$Process.ExecutablePath) -ieq [IO.Path]::GetFullPath(`$executablePath)
  } catch {
    return `$false
  }
}

function Test-ExpectedArguments([object]`$Process) {
  `$commandLine = [string]`$Process.CommandLine
  foreach (`$argument in `$expectedArguments) {
    if (`$commandLine -notmatch [regex]::Escape([string]`$argument)) { return `$false }
  }
  return `$true
}

function Test-ListenerOwnership([int]`$ListenerProcessId, [int]`$OwnerProcessId) {
  if (`$ListenerProcessId -eq `$OwnerProcessId) { return `$true }
  if (`$readinessBinding -ne "descendant_listener") { return `$false }
  `$cursorId = `$ListenerProcessId
  for (`$depth = 0; `$depth -lt 32 -and `$cursorId -gt 0; `$depth += 1) {
    `$cursor = Get-CimInstance Win32_Process -Filter "ProcessId = `$cursorId" -ErrorAction SilentlyContinue
    if (`$null -eq `$cursor) { return `$false }
    `$parentId = [int]`$cursor.ParentProcessId
    if (`$parentId -eq `$OwnerProcessId) { return `$true }
    if (`$parentId -le 0 -or `$parentId -eq `$cursorId) { return `$false }
    `$cursorId = `$parentId
  }
  return `$false
}

function Get-ReadyOwnerProcess([object[]]`$Processes) {
  `$currentSessionId = [Diagnostics.Process]::GetCurrentProcess().SessionId
  `$canonical = @(`$Processes | Where-Object {
    (Test-ExpectedExecutable `$_) -and [int]`$_.SessionId -eq `$currentSessionId -and (Test-ExpectedArguments `$_)
  })
  if (`$readinessPort -gt 0) {
    `$listeners = @(Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort `$readinessPort -State Listen -ErrorAction SilentlyContinue)
    if (`$listeners.Count -ne 1) { return `$null }
    `$listenerProcessId = [int]`$listeners[0].OwningProcess
    `$listenerOwner = @(`$canonical | Where-Object { Test-ListenerOwnership `$listenerProcessId ([int]`$_.ProcessId) })
    if (`$listenerOwner.Count -ne 1) { return `$null }
    return `$listenerOwner[0]
  }
  if (`$canonical.Count -ne 1 -or `$Processes.Count -ne 1) { return `$null }
  return `$canonical[0]
}

try {
  try {
    `$ownsMutex = `$ownerMutex.WaitOne([TimeSpan]::FromSeconds(90))
  } catch [Threading.AbandonedMutexException] {
    `$ownsMutex = `$true
  }
  if (-not `$ownsMutex) {
    Stop-OwnerLaunch "serialize_reentry" "reentry_timeout" "timed out waiting for the canonical owner launch lease"
  }
  if (-not (Test-Path -LiteralPath `$executablePath -PathType Leaf)) {
    Stop-OwnerLaunch "validate_artifact" "artifact_missing" "canonical owner executable is missing"
  }

  `$observed = @(Get-ObservedOwnerProcesses)
  `$unexpected = @(`$observed | Where-Object { -not (Test-ExpectedExecutable `$_) })
  if (`$unexpected.Count -gt 0) {
    Stop-OwnerLaunch "validate_owner" "owner_identity_conflict" "a competing same-name process does not use the canonical executable"
  }
  `$readyOwner = Get-ReadyOwnerProcess `$observed
  if (`$null -ne `$readyOwner) {
    `$terminalResult = New-OwnerLaunchResult "ready" `$null "owner_already_ready" ([int]`$readyOwner.ProcessId) `$true
  } else {
    if (`$readinessPort -eq 0 -and `$observed.Count -gt 0) {
      Stop-OwnerLaunch "validate_owner" "owner_process_conflict" "the canonical owner process set is not unique"
    }
    `$startedProcess = `$null
    if (`$observed.Count -eq 0) {
      `$startInfo = [Diagnostics.ProcessStartInfo]::new()
      `$startInfo.FileName = `$executablePath
      `$startInfo.WorkingDirectory = '$(Split-Path -Parent $ExecutablePath)'
      `$startInfo.UseShellExecute = `$false
      `$startInfo.Arguments = $argumentStringLiteral
      foreach (`$name in $environmentNamesLiteral) {
        `$userValue = [Environment]::GetEnvironmentVariable(`$name, "User")
        `$machineValue = [Environment]::GetEnvironmentVariable(`$name, "Machine")
        `$value = if (-not [string]::IsNullOrWhiteSpace(`$userValue)) { `$userValue } else { `$machineValue }
        if (-not [string]::IsNullOrWhiteSpace(`$value)) {
          Set-Item -LiteralPath "Env:`$name" -Value `$value
          `$startInfo.EnvironmentVariables[`$name] = `$value
        }
      }
      `$explicitEnvironment = $explicitEnvironmentLiteral
      foreach (`$entry in `$explicitEnvironment.GetEnumerator()) {
        `$value = [string]`$entry.Value
        if (-not [string]::IsNullOrWhiteSpace(`$value)) {
          Set-Item -LiteralPath "Env:`$(`$entry.Key)" -Value `$value
          `$startInfo.EnvironmentVariables[[string]`$entry.Key] = `$value
        }
      }
      `$startedProcess = [Diagnostics.Process]::Start(`$startInfo)
      if (`$null -eq `$startedProcess) {
        Stop-OwnerLaunch "start_process" "process_start_failed" "canonical owner process start returned no process"
      }
    }

    `$deadline = [DateTime]::UtcNow.AddSeconds(90)
    `$stableSince = `$null
    do {
      if (`$null -ne `$startedProcess) { `$startedProcess.Refresh() }
      if (`$null -ne `$startedProcess -and `$startedProcess.HasExited) {
        Stop-OwnerLaunch "wait_process" "process_exited_early" "canonical owner process exited before readiness"
      }
      `$observed = @(Get-ObservedOwnerProcesses)
      if (`$null -eq `$startedProcess -and `$observed.Count -eq 0) {
        Stop-OwnerLaunch "wait_process" "process_exited_early" "existing canonical owner process exited before readiness"
      }
      `$unexpected = @(`$observed | Where-Object { -not (Test-ExpectedExecutable `$_) })
      if (`$unexpected.Count -gt 0) {
        Stop-OwnerLaunch "wait_process" "owner_identity_conflict" "a competing same-name process appeared during startup"
      }
      `$readyOwner = Get-ReadyOwnerProcess `$observed
      if (`$null -ne `$readyOwner) {
        if (`$null -eq `$stableSince) { `$stableSince = [DateTime]::UtcNow }
        if (([DateTime]::UtcNow - `$stableSince).TotalSeconds -ge 2) { break }
      } else {
        `$stableSince = `$null
      }
      Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt `$deadline)
    if (`$null -eq `$readyOwner -or `$null -eq `$stableSince -or ([DateTime]::UtcNow - `$stableSince).TotalSeconds -lt 2) {
      Stop-OwnerLaunch "wait_readiness" "readiness_timeout" "canonical owner did not reach stable process readiness within the launch deadline"
    }
    `$terminalResult = New-OwnerLaunchResult "ready" `$null "owner_started" ([int]`$readyOwner.ProcessId) `$true
  }
} catch {
  `$failedStage = if (`$_.Exception.Data.Contains("failedStage")) { [string]`$_.Exception.Data["failedStage"] } else { "unexpected" }
  `$reasonCode = if (`$_.Exception.Data.Contains("reasonCode")) { [string]`$_.Exception.Data["reasonCode"] } else { "unexpected_error" }
  `$failureMessage = `$_.Exception.Message
  `$terminalResult = New-OwnerLaunchResult "failed" `$failedStage `$reasonCode `$null `$false
} finally {
  if (`$null -ne `$terminalResult) { Write-OwnerLaunchResult `$terminalResult }
  if (`$ownsMutex) { `$ownerMutex.ReleaseMutex() }
  `$ownerMutex.Dispose()
}

if (`$terminalResult.status -ne "ready") {
  [Console]::Error.WriteLine(`$failureMessage)
  exit 1
}
`$terminalResult | ConvertTo-Json -Compress -Depth 8 | Write-Output
"@
  $temporaryLauncher = "$LauncherPath.$PID.tmp"
  $backupLauncher = "$LauncherPath.$PID.backup"
  try {
    [IO.File]::WriteAllText($temporaryLauncher, $content, [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $LauncherPath -PathType Leaf) {
      [IO.File]::Replace($temporaryLauncher, $LauncherPath, $backupLauncher, $true)
      Remove-Item -LiteralPath $backupLauncher -Force -ErrorAction Stop
    } else {
      Move-Item -LiteralPath $temporaryLauncher -Destination $LauncherPath -ErrorAction Stop
    }
  } finally {
    Remove-Item -LiteralPath $temporaryLauncher -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $backupLauncher -Force -ErrorAction SilentlyContinue
  }
}

function Register-InteractiveOwnerTask(
  [string]$TaskName,
  [string]$LauncherPath,
  [string]$WorkingDirectory
) {
  $action = New-ScheduledTaskAction `
    -Execute "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$LauncherPath`"" `
    -WorkingDirectory $WorkingDirectory
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $KioskUser
  $principal = New-ScheduledTaskPrincipal -UserId $KioskUser -LogonType Interactive -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "VEM installed runtime owner: $TaskName" `
    -Force | Out-Null
}

function Assert-NoDuplicateRuntimeProcesses {
  foreach ($processName in @("vending-daemon.exe", "machine.exe", "vending-vision.exe")) {
    $instances = @(Get-CimInstance Win32_Process -Filter "Name = '$processName'" -ErrorAction SilentlyContinue)
    if ($instances.Count -gt 1) {
      throw "duplicate runtime process detected: $processName ($($instances.Count))"
    }
  }
}

function Write-OwnerManifest(
  [string]$DaemonExecutable,
  [string]$MachineExecutable,
  [string]$VisionExecutable,
  [string]$MachineLauncher,
  [string]$VisionLauncher
) {
  $visionOwner = [ordered]@{
    kind = "scheduledTask"
    name = "VEMVisionRuntime"
    taskPath = "\"
    trigger = "AtLogon"
    user = $KioskUser
    executablePath = $VisionExecutable
    arguments = @("--config", (Join-Path $VisionDataDirectory "site.json"))
    launcherPath = $VisionLauncher
    launchResultPath = Join-Path $ownerResultDirectory "vision.json"
    workingDirectory = $VisionAppDirectory
  }
  $acl = [Collections.Generic.List[object]]::new()
  @(
    [ordered]@{ path = $RuntimeDirectory; user = $KioskUser; rights = "RX" },
    [ordered]@{ path = $DaemonDataDirectory; user = $KioskUser; rights = "M" },
    [ordered]@{ path = $VisionAppDirectory; user = $KioskUser; rights = "RX" },
    [ordered]@{ path = $VisionDataDirectory; user = $KioskUser; rights = "M" },
    [ordered]@{ path = $ownerResultDirectory; user = $KioskUser; rights = "M" }
  ) | ForEach-Object { $acl.Add($_) }
  $manifest = [ordered]@{
    schemaVersion = "vem-runtime-owners/v1"
    installedAt = [DateTime]::UtcNow.ToString("o")
    kiosk = [ordered]@{
      user = $KioskUser
      autoAdminLogon = [ordered]@{
        registryPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
        userName = $KioskUser
        domainName = "."
      }
    }
    owners = [ordered]@{
      daemon = [ordered]@{
        kind = "service"
        name = "VemVendingDaemon"
        account = "LocalSystem"
        startType = "Automatic"
        executablePath = $DaemonExecutable
        arguments = @("--data-dir", $DaemonDataDirectory)
        crashRecovery = [ordered]@{ firstFailure = "restart"; delayMilliseconds = 5000 }
      }
      machineUi = [ordered]@{
        kind = "scheduledTask"
        name = "VEMMachineUI"
        taskPath = "\"
        trigger = "AtLogon"
        user = $KioskUser
        executablePath = $MachineExecutable
        launcherPath = $MachineLauncher
        launchResultPath = Join-Path $ownerResultDirectory "machine-ui.json"
        workingDirectory = $RuntimeDirectory
      }
      vision = $visionOwner
    }
    acl = @($acl)
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OwnerManifestPath) | Out-Null
  $temporaryPath = "$OwnerManifestPath.$PID.tmp"
  try {
    [IO.File]::WriteAllText($temporaryPath, ($manifest | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporaryPath -Destination $OwnerManifestPath -Force
  } finally {
    Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
  }
  return $manifest
}

$daemonExecutable = Join-Path $RuntimeDirectory "vending-daemon.exe"
$machineExecutable = Join-Path $RuntimeDirectory "machine.exe"
$visionExecutable = Join-Path $VisionAppDirectory "vending-vision.exe"
$machineLauncher = Join-Path $RuntimeDirectory "launch-vem-machine-ui.ps1"
$visionLauncher = Join-Path $RuntimeDirectory "launch-vem-vision.ps1"
$ownerResultDirectory = Join-Path (Split-Path -Parent $OwnerManifestPath) "results"

Assert-OwnerPath $daemonExecutable "daemon executable"
Assert-OwnerPath $machineExecutable "Machine UI executable"
Assert-OwnerPath $visionExecutable "Vision executable"
if ($null -eq (Get-LocalUser -Name $KioskUser -ErrorAction SilentlyContinue)) {
  throw "required interactive user is missing: $KioskUser"
}
if ([string]::IsNullOrWhiteSpace($KioskPassword)) {
  throw "KioskPassword is required to configure VEMKiosk automatic logon"
}

Assert-NoDuplicateRuntimeProcesses
Assert-OwnerDirectoryLeases

$daemonArguments = "`"$daemonExecutable`" --data-dir `"$DaemonDataDirectory`""
$daemonService = Get-Service -Name "VemVendingDaemon" -ErrorAction SilentlyContinue
if ($null -eq $daemonService) {
  New-Service -Name "VemVendingDaemon" -BinaryPathName $daemonArguments -DisplayName "VEM Vending Daemon" -StartupType Automatic | Out-Null
} else {
  Invoke-Sc @("config", "VemVendingDaemon", "binPath=", $daemonArguments) "update daemon service binary path"
}
Invoke-Sc @("config", "VemVendingDaemon", "obj=", "LocalSystem", "start=", "auto") "configure daemon service account and startup"
Set-Service -Name "VemVendingDaemon" -StartupType Automatic
Invoke-Sc @("failure", "VemVendingDaemon", "reset=", "86400", "actions=", 'restart/5000/""/0/""/0') "configure daemon crash recovery"
Invoke-Sc @("failureflag", "VemVendingDaemon", "1") "enable daemon crash recovery"

$winlogon = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
Set-ItemProperty -Path $winlogon -Name "DefaultUserName" -Value $KioskUser
Set-ItemProperty -Path $winlogon -Name "DefaultDomainName" -Value "."
Set-ItemProperty -Path $winlogon -Name "DefaultPassword" -Value $KioskPassword
Set-ItemProperty -Path $winlogon -Name "AutoAdminLogon" -Value "1"
Remove-ItemProperty -Path $winlogon -Name "AutoLogonCount" -ErrorAction SilentlyContinue

Assert-OwnerDirectoryLeases
Grant-OwnerAccess $RuntimeDirectory "(RX)"
Grant-OwnerAccess $DaemonDataDirectory "(M)"
Grant-OwnerAccess $VisionAppDirectory "(RX)"
Grant-OwnerAccess $VisionDataDirectory "(M)"
Grant-OwnerAccess $ownerResultDirectory "(M)"
foreach ($launchResultPath in @(
  (Join-Path $ownerResultDirectory "machine-ui.json"),
  (Join-Path $ownerResultDirectory "vision.json")
)) {
  if (Test-Path -LiteralPath $launchResultPath -PathType Leaf) {
    Remove-Item -LiteralPath $launchResultPath -Force -ErrorAction Stop
  }
}

Assert-OwnerDirectoryLeases
$machineUiEnvironment = @{}
if ($MachineUiWebViewDebugPort -gt 0) {
  $machineUiEnvironment["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=$MachineUiWebViewDebugPort"
}
Write-InteractiveLauncher `
  -LauncherPath $machineLauncher `
  -Role "machine-ui" `
  -ProcessName "machine.exe" `
  -ExecutablePath $machineExecutable `
  -ArgumentList @() `
  -ResultPath (Join-Path $ownerResultDirectory "machine-ui.json") `
  -ReadinessPort $MachineUiWebViewDebugPort `
  -ReadinessBinding $(if ($MachineUiWebViewDebugPort -gt 0) { "descendant_listener" } else { "process" }) `
  -InheritedEnvironmentVariableNames @() `
  -ExplicitEnvironmentVariables $machineUiEnvironment
$visionEnvironment = @{}
Write-InteractiveLauncher `
  -LauncherPath $visionLauncher `
  -Role "vision" `
  -ProcessName "vending-vision.exe" `
  -ExecutablePath $visionExecutable `
  -ArgumentList @("--config", (Join-Path $VisionDataDirectory "site.json")) `
  -ResultPath (Join-Path $ownerResultDirectory "vision.json") `
  -ReadinessPort 7892 `
  -ReadinessBinding "direct_listener" `
  -InheritedEnvironmentVariableNames @() `
  -ExplicitEnvironmentVariables $visionEnvironment
Assert-OwnerDirectoryLeases
Register-InteractiveOwnerTask "VEMMachineUI" $machineLauncher $RuntimeDirectory
Register-InteractiveOwnerTask "VEMVisionRuntime" $visionLauncher $VisionAppDirectory

Assert-OwnerDirectoryLeases
$ownerManifest = Write-OwnerManifest $daemonExecutable $machineExecutable $visionExecutable $machineLauncher $visionLauncher
Assert-OwnerDirectoryLeases
Close-OwnerDirectoryLeases
$ownerManifest | ConvertTo-Json -Depth 12
