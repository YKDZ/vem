[CmdletBinding()]
param(
  [string]$HarnessPath = (Join-Path $PSScriptRoot "vision-release-install.windows-harness.ps1"),
  [ValidateRange(30, 120)][int]$DeadlineSeconds = 120,
  [ValidateRange(60, 180)][int]$HardDeadlineSeconds = 180,
  [switch]$Library
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-True([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
}

function Assert-BeforeDeadline {
  if ([DateTime]::UtcNow.Ticks -ge $script:deadlineUtc.Ticks) {
    throw "vision installer harness behavior test exceeded its global deadline"
  }
}

function Get-RunningProcess([int]$ProcessId) {
  try {
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    if ($process.HasExited) {
      $process.Dispose()
      return $null
    }
    return $process
  } catch [ArgumentException] {
    return $null
  }
}

function Stop-TrackedProcess([object]$Identity) {
  if ($null -eq $Identity) { return }

  [int]$processId = 0
  [Int64]$creationTimeUtcTicks = 0
  if (-not [int]::TryParse([string]$Identity.processId, [ref]$processId) -or $processId -lt 1 -or -not [Int64]::TryParse([string]$Identity.creationTimeUtcTicks, [ref]$creationTimeUtcTicks) -or $creationTimeUtcTicks -lt 1 -or [string]::IsNullOrWhiteSpace([string]$Identity.executablePath)) {
    throw "tracked descendant identity is invalid"
  }

  $process = Get-RunningProcess -ProcessId $processId
  if ($null -eq $process) { return }
  try {
    if ($process.StartTime.ToUniversalTime().Ticks -ne $creationTimeUtcTicks -or [IO.Path]::GetFullPath($process.Path) -cne [IO.Path]::GetFullPath([string]$Identity.executablePath)) {
      throw "tracked descendant process identity no longer matches process $processId"
    }
    if (-not $process.HasExited) {
      $process.Kill()
      $process.WaitForExit(5000) | Out-Null
    }
  } finally {
    $process.Dispose()
  }
}

function Start-HardWatchdogHost {
  param(
    [Parameter(Mandatory = $true)][string]$PowerShellPath,
    [Parameter(Mandatory = $true)][string]$HostPath,
    [Parameter(Mandatory = $true)][string]$HarnessPath,
    [Parameter(Mandatory = $true)][string]$HarnessRoot,
    [Parameter(Mandatory = $true)][string]$HarnessContextPath,
    [Parameter(Mandatory = $true)][string]$ChildPowerShellPath,
    [Parameter(Mandatory = $true)][string]$IdentityPath,
    [Parameter(Mandatory = $true)][string]$ReadySignalPath,
    [Parameter(Mandatory = $true)][string]$RunSignalPath,
    [Parameter(Mandatory = $true)][string]$RunDeadlineUtcTicks,
    [Parameter(Mandatory = $true)][string]$FaultSignalPath,
    [Parameter(Mandatory = $true)][string]$TelemetryPath,
    [Parameter(Mandatory = $true)][string]$ObservedChildPowerShellPath,
    [Parameter(Mandatory = $true)][DateTime]$LifetimeDeadlineUtc
  )

  $arguments = [string[]]@("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $HostPath, "-HarnessPath", $HarnessPath, "-HarnessRoot", $HarnessRoot, "-HarnessContextPath", $HarnessContextPath, "-ChildPowerShellPath", $ChildPowerShellPath, "-IdentityPath", $IdentityPath, "-ReadySignalPath", $ReadySignalPath, "-RunSignalPath", $RunSignalPath, "-RunDeadlineUtcTicks", $RunDeadlineUtcTicks, "-FaultSignalPath", $FaultSignalPath, "-TelemetryPath", $TelemetryPath, "-ObservedChildPowerShellPath", $ObservedChildPowerShellPath)
  $nativeProcess = [VemVisionHarness.SuspendedProcess]::Create($PowerShellPath, $arguments, $HarnessRoot)
  $lifetimeWatchdog = $null
  try {
    Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $HarnessRoot "hard-watchdog-host-lifetime") -WatchdogPath $script:HarnessSuspendedProcessWatchdogPath -NativeProcess $nativeProcess -DeadlineUtc $LifetimeDeadlineUtc -Watchdog ([ref]$lifetimeWatchdog) | Out-Null
    $nativeProcess.Resume()
    return [pscustomobject]@{ process=$nativeProcess; lifetimeWatchdog=$lifetimeWatchdog; deadlineWatchdog=$null }
  } catch {
    $failures = New-Object 'System.Collections.Generic.List[System.Exception]'
    $failures.Add($_.Exception)
    $nativeCleanupConfirmed = $false
    try {
      if ($nativeProcess.IsResumed) {
        throw "hard watchdog host resumed before setup completed"
      }
      try {
        $nativeProcess.TerminateUnresumed(5000)
        $nativeCleanupConfirmed = $true
      } catch {
        $failures.Add($_.Exception)
      }
      if ($null -ne $lifetimeWatchdog) {
        try {
          $action = if ($nativeCleanupConfirmed) { "disarm" } else { "terminate" }
          Complete-HarnessSuspendedProcessWatchdog -Watchdog $lifetimeWatchdog -Action $action -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(5)) | Out-Null
          if (-not $nativeCleanupConfirmed) {
            if (-not $nativeProcess.WaitForExit(5000)) { throw "hard watchdog host watchdog completion did not signal the original process handle" }
            $nativeCleanupConfirmed = $true
          }
        } catch {
          $failures.Add($_.Exception)
        }
      }
    } finally {
      if ($nativeCleanupConfirmed) { $nativeProcess.Dispose() }
    }
    if (-not $nativeCleanupConfirmed) { $failures.Add([InvalidOperationException]::new("hard watchdog host retained the suspended process handle because termination was not confirmed")) }
    throw [AggregateException]::new("hard watchdog host setup failed", $failures)
  }
}

function Wait-ForSignal([string]$Path, [DateTime]$DeadlineUtc, [string]$FailureMessage) {
  while (-not (Test-Path -LiteralPath $Path -PathType Leaf) -and [DateTime]::UtcNow -lt $DeadlineUtc) {
    $remainingMilliseconds = [Math]::Max(1, [int][Math]::Floor(($DeadlineUtc - [DateTime]::UtcNow).TotalMilliseconds))
    Start-Sleep -Milliseconds ([Math]::Min(25, $remainingMilliseconds))
  }
  Assert-True (Test-Path -LiteralPath $Path -PathType Leaf) $FailureMessage
}

function Stop-HardWatchdogHost([object]$HostProcess, [DateTime]$DeadlineUtc) {
  if ($null -eq $HostProcess) { return }
  $failures = New-Object 'System.Collections.Generic.List[System.Exception]'
  try {
    foreach ($watchdog in @($HostProcess.deadlineWatchdog, $HostProcess.lifetimeWatchdog)) {
      if ($null -ne $watchdog -and -not $watchdog.completed) {
        try {
          Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc $DeadlineUtc | Out-Null
        } catch {
          $failures.Add($_.Exception)
        }
      }
    }
  } finally {
    $HostProcess.process.Dispose()
  }
  if ($failures.Count -gt 0) { throw [AggregateException]::new("hard watchdog host cleanup could not confirm termination", $failures) }
}

if ($Library) { return }

if ($HardDeadlineSeconds -le $DeadlineSeconds) { throw "HardDeadlineSeconds must leave time for cleanup after DeadlineSeconds" }
. $HarnessPath -Library
Initialize-HarnessNativeTypes
$root = Join-Path ([IO.Path]::GetTempPath()) ("vh-" + [guid]::NewGuid().ToString("N"))
$contextPath = Join-Path $root "context.json"
$unrelated = $null
$descendantIdentity = $null
$normalDescendantIdentity = $null
$hardWatchdogDescendantIdentity = $null
$hardWatchdogHost = $null
$watchdog = $null

try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $script:HarnessSuspendedProcessWatchdogPath = Initialize-HarnessSuspendedProcessWatchdog -HarnessRoot $root
  Invoke-HarnessSuspendedProcessWatchdogPreflight -WatchdogPath $script:HarnessSuspendedProcessWatchdogPath -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(35))
  $deadlineStartUtc = [DateTime]::UtcNow
  $script:deadlineUtc = $deadlineStartUtc.AddSeconds($DeadlineSeconds)
  $hardDeadlineUtc = $deadlineStartUtc.AddSeconds($HardDeadlineSeconds)
  $watchdogMessage = "vision installer harness behavior test exceeded its $HardDeadlineSeconds-second hard deadline"
  $watchdog = Arm-HarnessFailFastWatchdog -Message $watchdogMessage -DeadlineUtc $hardDeadlineUtc
  $layoutJob = New-HarnessKillOnCloseJob
  try {
    [VemVisionHarness.KillOnCloseJob]::AssertNativeLayout()
  } finally {
    $layoutJob.Dispose()
  }
  $pwshPath = Get-Command pwsh -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
  $context = [ordered]@{ root=$root; stateRoot=(Join-Path $root "state"); bundleDigest="sha256:behavior" }
  Write-Json $contextPath $context

  $hardWatchdogIdentityPath = Join-Path $root "hard-watchdog-descendant.identity.json"
  $hardWatchdogHostPath = Join-Path $root "hard-watchdog-host.ps1"
  $hardWatchdogReadySignalPath = Join-Path $root "hard-watchdog-host.ready"
  $hardWatchdogRunSignalPath = Join-Path $root "hard-watchdog-host.run"
  $hardWatchdogFaultSignalPath = Join-Path $root "hard-watchdog-host.fault-observed"
  $hardWatchdogTelemetryPath = Join-Path $root "hard-watchdog-host.telemetry.log"
  $observedChildPowerShellPath = Join-Path $root "hard-watchdog-host.child-powershell-path"
  Write-Utf8 $hardWatchdogHostPath @'
param([string]$HarnessPath, [string]$HarnessRoot, [string]$HarnessContextPath, [string]$ChildPowerShellPath, [string]$IdentityPath, [string]$ReadySignalPath, [string]$RunSignalPath, [string]$RunDeadlineUtcTicks, [string]$FaultSignalPath, [string]$TelemetryPath, [string]$ObservedChildPowerShellPath)
$ErrorActionPreference = "Stop"
. $HarnessPath -Library
Initialize-HarnessNativeTypes
$script:HarnessSuspendedProcessWatchdogPath = Initialize-HarnessSuspendedProcessWatchdog -HarnessRoot $HarnessRoot
[IO.File]::WriteAllText($ObservedChildPowerShellPath, $ChildPowerShellPath, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText($ReadySignalPath, "ready", [Text.UTF8Encoding]::new($false))
$runDeadlineUtc = [DateTime]::new([Int64]$RunDeadlineUtcTicks, [DateTimeKind]::Utc)
while (-not (Test-Path -LiteralPath $RunSignalPath -PathType Leaf) -and [DateTime]::UtcNow -lt $runDeadlineUtc) { Start-Sleep -Milliseconds 25 }
if (-not (Test-Path -LiteralPath $RunSignalPath -PathType Leaf)) { throw "hard watchdog host did not receive its run signal before the behavior deadline" }
$env:VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_JOB_FAILURE = "1"
$caughtExpectedFailure = $false
try {
  Start-Transcript -Path $TelemetryPath -Force | Out-Null
  try {
    Invoke-BoundedPowerShell -Stage "behavior.terminate-job-hard-watchdog.inner" -TimeoutSeconds 1 -HarnessRoot $HarnessRoot -HarnessContextPath $HarnessContextPath -ChildPowerShellPath $ChildPowerShellPath -HarnessDeadlineUtc ([DateTime]::UtcNow.AddSeconds(3)) -ScriptBody @"
`$descendant = Start-Process -FilePath `$env:COMSPEC -ArgumentList @('/d', '/c', 'ping -t 127.0.0.1') -PassThru -NoNewWindow
try {
  Write-Json '$IdentityPath' @{ processId=`$descendant.Id; creationTimeUtcTicks=`$descendant.StartTime.ToUniversalTime().Ticks; executablePath=[IO.Path]::GetFullPath(`$descendant.Path) }
  Start-Sleep -Seconds 60
} finally {
  `$descendant.Dispose()
}
"@ | Out-Null
  } catch {
    $caughtExpectedFailure = $true
  } finally {
    Stop-Transcript | Out-Null
  }
  if (-not $caughtExpectedFailure) { throw "hard watchdog fixture unexpectedly completed" }
  $telemetry = Get-Content -LiteralPath $TelemetryPath -Raw
  foreach ($status in @("termination-failed", "cleanup-job-dispose-skipped", "hard-watchdog-required")) {
    if ($telemetry -notmatch "stage=behavior.terminate-job-hard-watchdog.inner status=$status") { throw "hard watchdog telemetry did not record $status before fault signal" }
  }
  [IO.File]::WriteAllText($FaultSignalPath, "fault-observed", [Text.UTF8Encoding]::new($false))
  Start-Sleep -Seconds 30
} finally {
  # The inherited-handle watchdog must terminate this process so Windows closes the unconfirmed Job Object.
}
'@
  $hardWatchdogHost = Start-HardWatchdogHost -PowerShellPath $pwshPath -HostPath $hardWatchdogHostPath -HarnessPath $HarnessPath -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -IdentityPath $hardWatchdogIdentityPath -ReadySignalPath $hardWatchdogReadySignalPath -RunSignalPath $hardWatchdogRunSignalPath -RunDeadlineUtcTicks $deadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture) -FaultSignalPath $hardWatchdogFaultSignalPath -TelemetryPath $hardWatchdogTelemetryPath -ObservedChildPowerShellPath $observedChildPowerShellPath -LifetimeDeadlineUtc $deadlineUtc
  Wait-ForSignal -Path $hardWatchdogReadySignalPath -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(5)) -FailureMessage "hard watchdog host did not become ready"
  Assert-True ((Get-Content -LiteralPath $observedChildPowerShellPath -Raw) -ceq $pwshPath) "hard watchdog host did not receive the exact ChildPowerShellPath"

  Assert-BeforeDeadline
  $unrelated = Start-Process -FilePath $pwshPath -ArgumentList @("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60") -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $root "unrelated.stdout.log") -RedirectStandardError (Join-Path $root "unrelated.stderr.log")
  Assert-True ($unrelated -is [Diagnostics.Process]) "unrelated process did not retain a .NET process handle"

  Assert-BeforeDeadline
  $transcriptPath = Join-Path $root "telemetry.log"
  Start-Transcript -Path $transcriptPath -Force | Out-Null
  try {
    $discarded = Invoke-BoundedPowerShell -Stage "behavior.telemetry" -TimeoutSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc $deadlineUtc -ScriptBody 'Write-Output child-output' | Out-Null
  } finally {
    Stop-Transcript | Out-Null
  }
  Assert-True ($null -eq $discarded) "Out-Null did not suppress the bounded result object"
  $telemetry = Get-Content -LiteralPath $transcriptPath -Raw
  Assert-True ($telemetry -match "stage=behavior.telemetry status=started") "bounded invocation did not emit start telemetry"
  Assert-True ($telemetry -match "stage=behavior.telemetry status=completed") "bounded invocation did not emit completion telemetry"
  $returned = Invoke-BoundedPowerShell -Stage "behavior.object" -TimeoutSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc $deadlineUtc -ScriptBody '& $env:COMSPEC /d /c ''echo child-output & echo child-error 1>&2'''
  Assert-True (@($returned).Count -eq 1) "bounded invocation returned more than one result object"
  Assert-True ($returned.stdout.Trim() -ceq "child-output") "bounded invocation did not retain child stdout"
  Assert-True ($returned.stderr.Trim() -ceq "child-error") "bounded invocation did not retain child stderr"
  Assert-True (Test-Path -LiteralPath (Join-Path $returned.diagnosticsPath "stdout.log") -PathType Leaf) "bounded invocation did not write a stdout log"
  Assert-True (Test-Path -LiteralPath (Join-Path $returned.diagnosticsPath "stderr.log") -PathType Leaf) "bounded invocation did not write a stderr log"
  Assert-True (($returned.PSObject.Properties.Name -join ",") -ceq "stdout,stderr,diagnosticsPath") "bounded invocation result shape changed"

  Assert-BeforeDeadline
  $preflightArgumentCountPath = Join-Path $root "watchdog-preflight-argument-count"
  $preflightProcessIdPath = Join-Path $root "watchdog-preflight-process-id"
  $previousPreflightArgumentCountPath = [Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_ARGUMENT_COUNT_PATH", [EnvironmentVariableTarget]::Process)
  $previousPreflightProcessIdPath = [Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_PROCESS_ID_PATH", [EnvironmentVariableTarget]::Process)
  $previousPreflightDelay = [Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_DELAY_MILLISECONDS", [EnvironmentVariableTarget]::Process)
  $previousPreflightExitCode = [Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_EXIT_CODE", [EnvironmentVariableTarget]::Process)
  $previousPreflightCleanupFailure = [Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_FORCE_CLEANUP_FAILURE", [EnvironmentVariableTarget]::Process)
  try {
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_ARGUMENT_COUNT_PATH", $preflightArgumentCountPath, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_PROCESS_ID_PATH", $preflightProcessIdPath, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_DELAY_MILLISECONDS", "75", [EnvironmentVariableTarget]::Process)
    Invoke-HarnessSuspendedProcessWatchdogPreflight -WatchdogPath $script:HarnessSuspendedProcessWatchdogPath -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2)) -CleanupReserveMilliseconds 250
    Assert-True ((Get-Content -LiteralPath $preflightArgumentCountPath -Raw).Trim() -ceq "0") "watchdog preflight passed arguments to the executable"
    $preflightProcess = Get-RunningProcess -ProcessId ([int](Get-Content -LiteralPath $preflightProcessIdPath -Raw))
    try {
      Assert-True ($null -eq $preflightProcess) "watchdog preflight leaked its completed process"
    } finally {
      if ($null -ne $preflightProcess) { $preflightProcess.Dispose() }
    }
    $watchdogRoot = Split-Path -Parent $script:HarnessSuspendedProcessWatchdogPath
    Assert-True (@(Get-ChildItem -LiteralPath $watchdogRoot -Recurse -File | Where-Object { $_.Name -in @("ready", "command") }).Count -eq 0) "watchdog preflight wrote a runtime signal"

    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_DELAY_MILLISECONDS", $null, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_EXIT_CODE", "23", [EnvironmentVariableTarget]::Process)
    $nonzeroFailure = $null
    try { Invoke-HarnessSuspendedProcessWatchdogPreflight -WatchdogPath $script:HarnessSuspendedProcessWatchdogPath -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2)) -CleanupReserveMilliseconds 250 } catch { $nonzeroFailure = $_.Exception.Message }
    Assert-True ($nonzeroFailure -match "exited with code 23") "watchdog preflight did not diagnose its nonzero exit: $nonzeroFailure"

    Remove-Item -LiteralPath $preflightProcessIdPath -Force -ErrorAction SilentlyContinue
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_EXIT_CODE", $null, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_DELAY_MILLISECONDS", "5000", [EnvironmentVariableTarget]::Process)
    $timeoutFailure = $null
    try { Invoke-HarnessSuspendedProcessWatchdogPreflight -WatchdogPath $script:HarnessSuspendedProcessWatchdogPath -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(3)) -CleanupReserveMilliseconds 1000 } catch { $timeoutFailure = $_.Exception.Message }
    Assert-True ($timeoutFailure -match "timed out") "watchdog preflight timeout did not fail: $timeoutFailure"
    $timedOutPreflightProcess = Get-RunningProcess -ProcessId ([int](Get-Content -LiteralPath $preflightProcessIdPath -Raw))
    try {
      Assert-True ($null -eq $timedOutPreflightProcess) "watchdog preflight timeout leaked its process"
    } finally {
      if ($null -ne $timedOutPreflightProcess) { $timedOutPreflightProcess.Dispose() }
    }

    Remove-Item -LiteralPath $preflightProcessIdPath -Force -ErrorAction SilentlyContinue
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_FORCE_CLEANUP_FAILURE", "1", [EnvironmentVariableTarget]::Process)
    $aggregateFailure = $null
    try { Invoke-HarnessSuspendedProcessWatchdogPreflight -WatchdogPath $script:HarnessSuspendedProcessWatchdogPath -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(3)) -CleanupReserveMilliseconds 1000 } catch { $aggregateFailure = $_.Exception }
    Assert-True ($aggregateFailure -is [AggregateException]) "preflight timeout cleanup failure did not produce AggregateException: $aggregateFailure"
    $aggregateMessages = @($aggregateFailure.InnerExceptions | ForEach-Object { $_.Message }) -join "`n"
    Assert-True ($aggregateMessages -match "timed out") "preflight aggregate omitted its timeout failure: $aggregateMessages"
    Assert-True ($aggregateMessages -match "fixture forced cleanup failure") "preflight aggregate omitted its cleanup failure: $aggregateMessages"
    $aggregatePreflightProcess = Get-RunningProcess -ProcessId ([int](Get-Content -LiteralPath $preflightProcessIdPath -Raw))
    try {
      Assert-True ($null -eq $aggregatePreflightProcess) "preflight aggregate cleanup leaked its process"
    } finally {
      if ($null -ne $aggregatePreflightProcess) { $aggregatePreflightProcess.Dispose() }
    }
  } finally {
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_ARGUMENT_COUNT_PATH", $previousPreflightArgumentCountPath, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_PROCESS_ID_PATH", $previousPreflightProcessIdPath, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_DELAY_MILLISECONDS", $previousPreflightDelay, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_EXIT_CODE", $previousPreflightExitCode, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_WATCHDOG_PREFLIGHT_FORCE_CLEANUP_FAILURE", $previousPreflightCleanupFailure, [EnvironmentVariableTarget]::Process)
  }

  Assert-BeforeDeadline
  $slowWatchdogPath = Join-Path $root "slow-watchdog.exe"
  $slowWatchdogSourcePath = Join-Path $root "SlowWatchdog.cs"
  Write-Utf8 $slowWatchdogSourcePath @'
using System;
using System.IO;
using System.Text;
using System.Threading;

public static class SlowWatchdog {
  private static void Write(string path, string value) {
    var bytes = new UTF8Encoding(false).GetBytes(value);
    using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
      stream.Write(bytes, 0, bytes.Length);
      stream.Flush(true);
    }
  }

  public static int Main(string[] args) {
    if (args == null || args.Length != 6) { return 2; }
    Thread.Sleep(4000);
    Write(args[2], "armed");
    for (;;) {
      try {
        if (File.Exists(args[1])) {
          var command = File.ReadAllText(args[1]).Trim();
          if (String.Equals(command, "disarm", StringComparison.Ordinal)) {
            Write(args[3], "disarmed");
            return 0;
          }
        }
      } catch (IOException) {
      } catch (UnauthorizedAccessException) {
      }
      Thread.Sleep(10);
    }
  }
}
'@
  $csc = Join-Path $env:WINDIR "Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"
  & $csc /nologo /target:exe ("/out:{0}" -f $slowWatchdogPath) $slowWatchdogSourcePath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $slowWatchdogPath -PathType Leaf)) { throw "slow watchdog fixture compilation failed" }
  $originalWatchdogPath = $script:HarnessSuspendedProcessWatchdogPath
  $script:HarnessSuspendedProcessWatchdogPath = $slowWatchdogPath
  try {
    $delayedWatchdogSetup = Invoke-BoundedPowerShell -Stage "behavior.watchdog-setup-budget" -TimeoutSeconds 2 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc ([DateTime]::UtcNow.AddSeconds(15)) -ScriptBody 'Start-Sleep -Milliseconds 500; Write-Output watchdog-setup-budget'
    Assert-True ($delayedWatchdogSetup.stdout.Trim() -ceq "watchdog-setup-budget") "watchdog setup consumed the child execution timeout before resume"
  } finally {
    $script:HarnessSuspendedProcessWatchdogPath = $originalWatchdogPath
  }

  Assert-BeforeDeadline
  $delayedDisarmWatchdogPath = Join-Path $root "delayed-disarm-watchdog.exe"
  $delayedDisarmWatchdogSourcePath = Join-Path $root "DelayedDisarmWatchdog.cs"
  Write-Utf8 $delayedDisarmWatchdogSourcePath @'
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class DelayedDisarmWatchdog {
  private const int DISARM_CONFIRMATION_DELAY_MILLISECONDS = 100;

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool CloseHandle(IntPtr handle);

  private static void Write(string path, string value) {
    var bytes = new UTF8Encoding(false).GetBytes(value);
    using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
      stream.Write(bytes, 0, bytes.Length);
      stream.Flush(true);
    }
  }

  private static bool IsDisarmCommand(string path) {
    try {
      if (!File.Exists(path)) { return false; }
      using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
        if (stream.Length < 1 || stream.Length > 256) { return false; }
        var bytes = new byte[(int)stream.Length];
        var offset = 0;
        while (offset < bytes.Length) {
          var read = stream.Read(bytes, offset, bytes.Length - offset);
          if (read == 0) { return false; }
          offset += read;
        }
        return String.Equals(new UTF8Encoding(false).GetString(bytes, 0, offset).TrimEnd('\r', '\n'), "disarm", StringComparison.Ordinal);
      }
    } catch (IOException) {
      return false;
    } catch (UnauthorizedAccessException) {
      return false;
    }
  }

  public static int Main(string[] args) {
    if (args == null || args.Length != 6) { return 2; }
    long automaticDeadlineTicks;
    if (!Int64.TryParse(args[4], NumberStyles.None, CultureInfo.InvariantCulture, out automaticDeadlineTicks)) { return 2; }
    DateTime automaticDeadlineUtc;
    try {
      automaticDeadlineUtc = new DateTime(automaticDeadlineTicks, DateTimeKind.Utc);
    } catch (ArgumentOutOfRangeException) {
      return 2;
    }
    var process = new IntPtr(unchecked((long)UInt64.Parse(args[0], CultureInfo.InvariantCulture)));
    if (process == IntPtr.Zero) { return 2; }
    try {
      Write(args[2], "armed");
      for (;;) {
        if (IsDisarmCommand(args[1])) {
          Thread.Sleep(DISARM_CONFIRMATION_DELAY_MILLISECONDS);
          if (DateTime.UtcNow >= automaticDeadlineUtc) {
            if (!TerminateProcess(process, 1)) { return 1; }
            Write(args[3], "terminated");
            return 0;
          }
          Write(args[3], "disarmed");
          return 0;
        }
        if (DateTime.UtcNow >= automaticDeadlineUtc) {
          if (!TerminateProcess(process, 1)) { return 1; }
          Write(args[3], "terminated");
          return 0;
        }
        Thread.Sleep(10);
      }
    } finally {
      CloseHandle(process);
    }
  }
}
'@
  & $csc /nologo /target:exe ("/out:{0}" -f $delayedDisarmWatchdogPath) $delayedDisarmWatchdogSourcePath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $delayedDisarmWatchdogPath -PathType Leaf)) { throw "delayed disarm watchdog fixture compilation failed" }
  $originalWatchdogPath = $script:HarnessSuspendedProcessWatchdogPath
  $script:HarnessSuspendedProcessWatchdogPath = $delayedDisarmWatchdogPath
  $delayedDisarmTranscriptPath = Join-Path $root "watchdog-disarm-handoff.telemetry.log"
  try {
    Start-Transcript -Path $delayedDisarmTranscriptPath -Force | Out-Null
    try {
      $delayedDisarmStage = "b.dh"
      $delayedDisarm = Invoke-BoundedPowerShell -Stage $delayedDisarmStage -TimeoutSeconds 2 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc ([DateTime]::UtcNow.AddSeconds(4)) -ScriptBody 'Write-Output watchdog-disarm-handoff'
      Assert-True ($delayedDisarm.stdout.Trim() -ceq "watchdog-disarm-handoff") "delayed disarm handoff did not resume and run the child"
    } finally {
      Stop-Transcript | Out-Null
    }
  } finally {
    $script:HarnessSuspendedProcessWatchdogPath = $originalWatchdogPath
  }
  $delayedDisarmTelemetry = Get-Content -LiteralPath $delayedDisarmTranscriptPath -Raw
  Assert-True ($delayedDisarmTelemetry -match "stage=$delayedDisarmStage status=suspended-process-watchdog-disarmed detail=processId=[0-9]+ completion=disarmed") "delayed disarm handoff did not confirm the watchdog before resume"
  Assert-True ($delayedDisarmTelemetry -match "stage=$delayedDisarmStage status=process-ownership detail=state=resumed-job-assigned processId=[0-9]+") "delayed disarm handoff did not resume the Job-owned child"
  Assert-True ($delayedDisarmTelemetry -notmatch "stage=$delayedDisarmStage status=suspended-process-termination-confirmed") "delayed disarm handoff allowed automatic watchdog termination before disarm"

  Assert-BeforeDeadline
  $missingCompletionWatchdogPath = Join-Path $root "missing-completion-watchdog.exe"
  $missingCompletionWatchdogSourcePath = Join-Path $root "MissingCompletionWatchdog.cs"
  Write-Utf8 $missingCompletionWatchdogSourcePath @'
using System;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;

public static class MissingCompletionWatchdog {
  private static void Write(string path, string value) {
    var bytes = new UTF8Encoding(false).GetBytes(value);
    using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
      stream.Write(bytes, 0, bytes.Length);
      stream.Flush(true);
    }
  }

  public static int Main(string[] args) {
    if (args == null || args.Length != 6) { return 2; }
    Write(args[2], "armed");
    for (;;) {
      try {
        if (File.Exists(args[1])) {
          var command = File.ReadAllText(args[1]).Trim();
          if (String.Equals(command, "disarm", StringComparison.Ordinal)) { return 0; }
          long terminationDeadlineTicks;
          if (command.StartsWith("terminate:", StringComparison.Ordinal) && Int64.TryParse(command.Substring("terminate:".Length), NumberStyles.None, CultureInfo.InvariantCulture, out terminationDeadlineTicks) && terminationDeadlineTicks > 0 && terminationDeadlineTicks <= DateTime.MaxValue.Ticks) { return 0; }
        }
      } catch (IOException) {
      } catch (UnauthorizedAccessException) {
      }
      Thread.Sleep(10);
    }
  }
}
'@
  & $csc /nologo /target:exe ("/out:{0}" -f $missingCompletionWatchdogPath) $missingCompletionWatchdogSourcePath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $missingCompletionWatchdogPath -PathType Leaf)) { throw "missing-completion watchdog fixture compilation failed" }
  $originalWatchdogPath = $script:HarnessSuspendedProcessWatchdogPath
  $previousTerminateUnresumedFailure = [Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_UNRESUMED_FAILURE", [EnvironmentVariableTarget]::Process)
  $script:HarnessSuspendedProcessWatchdogPath = $missingCompletionWatchdogPath
  try {
    foreach ($scenario in @(
      [pscustomobject]@{ stage="behavior.watchdog-missing-completion-native"; forceTerminateFailure=$false; authority="native-process-handle" },
      [pscustomobject]@{ stage="behavior.watchdog-missing-completion-job"; forceTerminateFailure=$true; authority="job-object" }
    )) {
      Assert-BeforeDeadline
      $scenarioTerminateUnresumedFailure = $null
      if ($scenario.forceTerminateFailure) {
        $scenarioTerminateUnresumedFailure = "1"
      }
      [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_UNRESUMED_FAILURE", $scenarioTerminateUnresumedFailure, [EnvironmentVariableTarget]::Process)
      $records = New-Object 'System.Collections.Generic.List[object]'
      $failure = $null
      try {
        Invoke-BoundedPowerShell -Stage $scenario.stage -TimeoutSeconds 2 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc ([DateTime]::UtcNow.AddSeconds(10)) -ScriptBody 'Write-Output must-not-run' 6>&1 | ForEach-Object { [void]$records.Add($_) }
      } catch {
        $failure = $_.Exception
      }
      Assert-True ($null -ne $failure) "$($scenario.stage) accepted a missing watchdog completion"
      Assert-True ($failure -isnot [AggregateException]) "$($scenario.stage) turned a missing watchdog completion into a cleanup AggregateException: $failure"
      Assert-True ($failure.Message -match "could not disarm process [0-9]+: missing-completion") "$($scenario.stage) did not preserve the original missing disarm completion: $failure"
      $telemetry = ($records | ForEach-Object {
        if ($_ -is [Management.Automation.InformationRecord]) { [string]$_.MessageData } else { [string]$_ }
      }) -join [Environment]::NewLine
      Assert-True ($telemetry -match "stage=$($scenario.stage) status=suspended-process-watchdog-completion-ignored detail=action=disarm completion=missing-completion authority=$($scenario.authority)") "$($scenario.stage) did not record its authoritative target termination"
      if ($scenario.forceTerminateFailure) {
        Assert-True ($telemetry -match "stage=$($scenario.stage) status=suspended-process-termination-failed") "$($scenario.stage) did not record its native termination failure before Job fallback"
        Assert-True ($telemetry -match "stage=$($scenario.stage) status=termination-confirmed detail=termination=job-object activeProcesses=0") "$($scenario.stage) did not confirm Job Object termination"
      } else {
        Assert-True ($telemetry -match "stage=$($scenario.stage) status=suspended-process-termination-confirmed detail=processId=[0-9]+") "$($scenario.stage) did not confirm native suspended target termination"
      }
    }
  } finally {
    $script:HarnessSuspendedProcessWatchdogPath = $originalWatchdogPath
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_UNRESUMED_FAILURE", $previousTerminateUnresumedFailure, [EnvironmentVariableTarget]::Process)
  }

  Assert-BeforeDeadline
  $previousPreDisarmOperationFailure = [Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", [EnvironmentVariableTarget]::Process)
  $previousWatchdogDisarmCommandWriteFailure = [Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_WATCHDOG_DISARM_COMMAND_WRITE_FAILURE", [EnvironmentVariableTarget]::Process)
  try {
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", "1", [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_WATCHDOG_DISARM_COMMAND_WRITE_FAILURE", "1", [EnvironmentVariableTarget]::Process)
    $commandWriteFailureStage = "b.wf"
    $commandWriteFailureRecords = New-Object 'System.Collections.Generic.List[object]'
    $commandWriteFailure = $null
    try {
      Invoke-BoundedPowerShell -Stage $commandWriteFailureStage -TimeoutSeconds 2 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc ([DateTime]::UtcNow.AddSeconds(4)) -ScriptBody 'Write-Output must-not-run' 6>&1 | ForEach-Object { [void]$commandWriteFailureRecords.Add($_) }
    } catch {
      $commandWriteFailure = $_.Exception
    }
    Assert-True ($commandWriteFailure -is [AggregateException]) "operation and cleanup failures were not preserved as an AggregateException: $commandWriteFailure"
    $commandWriteFailureMessages = @($commandWriteFailure.InnerExceptions | ForEach-Object { $_.Message }) -join [Environment]::NewLine
    Assert-True ($commandWriteFailureMessages -match "fixture forced pre-disarm operation failure") "pre-disarm operation failure was absent from the aggregate: $commandWriteFailureMessages"
    Assert-True ($commandWriteFailureMessages -match "fixture forced watchdog disarm command write failure") "watchdog command write cleanup failure was absent from the aggregate: $commandWriteFailureMessages"
    $commandWriteFailureTelemetry = ($commandWriteFailureRecords | ForEach-Object {
      if ($_ -is [Management.Automation.InformationRecord]) { [string]$_.MessageData } else { [string]$_ }
    }) -join [Environment]::NewLine
    Assert-True ($commandWriteFailureTelemetry -match "stage=$commandWriteFailureStage status=suspended-process-termination-confirmed detail=processId=[0-9]+") "watchdog command write fixture did not confirm native suspended target termination"
    Assert-True ($commandWriteFailureTelemetry -match "stage=$commandWriteFailureStage status=suspended-process-watchdog-closed detail=reason=completion-failed") "watchdog command write cleanup did not release the retained watchdog wrapper"
    Assert-True ($commandWriteFailureTelemetry -notmatch "stage=$commandWriteFailureStage status=suspended-process-watchdog-completion-ignored") "watchdog command write failure was incorrectly downgraded"
  } finally {
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", $previousPreDisarmOperationFailure, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_WATCHDOG_DISARM_COMMAND_WRITE_FAILURE", $previousWatchdogDisarmCommandWriteFailure, [EnvironmentVariableTarget]::Process)
  }

  Assert-BeforeDeadline
  $previousUnconfirmedPreDisarmOperationFailure = [Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", [EnvironmentVariableTarget]::Process)
  $previousTerminateUnresumedFailure = [Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_UNRESUMED_FAILURE", [EnvironmentVariableTarget]::Process)
  $previousPersistentActiveProcessCountFailure = [Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_ACTIVE_PROCESS_COUNT_PERSISTENT_FAILURE", [EnvironmentVariableTarget]::Process)
  $originalWatchdogPath = $script:HarnessSuspendedProcessWatchdogPath
  $script:HarnessSuspendedProcessWatchdogPath = $missingCompletionWatchdogPath
  try {
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", "1", [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_UNRESUMED_FAILURE", "1", [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_ACTIVE_PROCESS_COUNT_PERSISTENT_FAILURE", "1", [EnvironmentVariableTarget]::Process)
    $unconfirmedStage = "b.wu"
    $unconfirmedRecords = New-Object 'System.Collections.Generic.List[object]'
    $unconfirmedFailure = $null
    try {
      Invoke-BoundedPowerShell -Stage $unconfirmedStage -TimeoutSeconds 2 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc ([DateTime]::UtcNow.AddSeconds(12)) -ScriptBody 'Write-Output must-not-run' 6>&1 | ForEach-Object { [void]$unconfirmedRecords.Add($_) }
    } catch {
      $unconfirmedFailure = $_.Exception
    }
    Assert-True ($unconfirmedFailure -is [AggregateException]) "missing completion without native or Job confirmation did not aggregate: $unconfirmedFailure"
    $unconfirmedMessages = @($unconfirmedFailure.InnerExceptions | ForEach-Object { $_.Message }) -join [Environment]::NewLine
    Assert-True ($unconfirmedMessages -match "fixture forced pre-disarm operation failure") "unconfirmed aggregate omitted the pre-disarm operation failure: $unconfirmedMessages"
    Assert-True ($unconfirmedMessages -match "could not terminate process [0-9]+: missing-completion") "unconfirmed aggregate omitted the original missing termination completion: $unconfirmedMessages"
    Assert-True ($unconfirmedMessages -match "could not confirm its Job Object was empty") "unconfirmed aggregate omitted the Job confirmation failure: $unconfirmedMessages"
    $unconfirmedTelemetry = ($unconfirmedRecords | ForEach-Object {
      if ($_ -is [Management.Automation.InformationRecord]) { [string]$_.MessageData } else { [string]$_ }
    }) -join [Environment]::NewLine
    Assert-True ($unconfirmedTelemetry -match "stage=$unconfirmedStage status=suspended-process-watchdog-armed detail=processId=[0-9]+ identity=original-process-handle") "unconfirmed missing completion did not arm the watchdog"
    Assert-True ($unconfirmedTelemetry -match "stage=$unconfirmedStage status=process-ownership detail=state=job-assigned-suspended processId=[0-9]+") "unconfirmed missing completion did not assign the suspended target to the Job Object"
    Assert-True ($unconfirmedTelemetry -notmatch "stage=$unconfirmedStage status=suspended-process-watchdog-completion-ignored") "unconfirmed missing completion was incorrectly ignored"

    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_UNRESUMED_FAILURE", $null, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", $null, [EnvironmentVariableTarget]::Process)
    $script:HarnessSuspendedProcessWatchdogPath = $originalWatchdogPath
    $primaryFailureStage = "b.pj"
    $primaryFailureRecords = New-Object 'System.Collections.Generic.List[object]'
    $primaryFailure = $null
    try {
      Invoke-BoundedPowerShell -Stage $primaryFailureStage -TimeoutSeconds 2 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc ([DateTime]::UtcNow.AddSeconds(4)) -ScriptBody 'Write-Output primary-nonzero; exit 23' 6>&1 | ForEach-Object { [void]$primaryFailureRecords.Add($_) }
    } catch {
      $primaryFailure = $_.Exception
    }
    Assert-True ($primaryFailure -is [AggregateException]) "primary operation failure with unavailable Job confirmation did not aggregate: $primaryFailure"
    Assert-True ($primaryFailure.InnerExceptions.Count -ge 2) "primary operation aggregate omitted its cleanup failure: $primaryFailure"
    Assert-True ($primaryFailure.InnerExceptions[0].Message -match "failed with exit code 23") "primary operation failure was not retained as the aggregate primary error: $($primaryFailure.InnerExceptions[0])"
    $primaryMessages = @($primaryFailure.InnerExceptions | ForEach-Object { $_.Message }) -join [Environment]::NewLine
    Assert-True ($primaryMessages -match "could not confirm its Job Object was empty") "primary operation aggregate omitted the unavailable Job confirmation: $primaryMessages"
    $primaryFailureTelemetry = ($primaryFailureRecords | ForEach-Object {
      if ($_ -is [Management.Automation.InformationRecord]) { [string]$_.MessageData } else { [string]$_ }
    }) -join [Environment]::NewLine
    Assert-True ($primaryFailureTelemetry -match "stage=$primaryFailureStage status=process-ownership detail=state=resumed-job-assigned processId=[0-9]+") "primary operation failure did not resume the assigned target"
    Assert-True ($primaryFailureTelemetry -match "stage=$primaryFailureStage status=failed detail=exitCode=23") "primary operation failure did not execute the exit 23 child"
  } finally {
    $script:HarnessSuspendedProcessWatchdogPath = $originalWatchdogPath
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", $previousUnconfirmedPreDisarmOperationFailure, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_UNRESUMED_FAILURE", $previousTerminateUnresumedFailure, [EnvironmentVariableTarget]::Process)
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_FIXTURE_FORCE_ACTIVE_PROCESS_COUNT_PERSISTENT_FAILURE", $previousPersistentActiveProcessCountFailure, [EnvironmentVariableTarget]::Process)
  }

  $windowsPowerShell = Join-Path $env:WINDIR "System32\WindowsPowerShell\v1.0\powershell.exe"
  Assert-True (Test-Path -LiteralPath $windowsPowerShell -PathType Leaf) "Windows PowerShell 5.1 is missing"
  $previousPs51Environment = [Environment]::GetEnvironmentVariable("VEM_VISION_HARNESS_PS51_ENV", [EnvironmentVariableTarget]::Process)
  [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_PS51_ENV", "native-wrapper", [EnvironmentVariableTarget]::Process)
  $ps51TranscriptPath = Join-Path $root "ps51-native-wrapper.telemetry.log"
  try {
    Start-Transcript -Path $ps51TranscriptPath -Force | Out-Null
    try {
      $ps51Returned = Invoke-BoundedPowerShell -Stage "behavior.ps51-native-wrapper" -TimeoutSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $windowsPowerShell -HarnessDeadlineUtc $deadlineUtc -ScriptBody '
if ($env:VEM_VISION_HARNESS_PS51_ENV -cne "native-wrapper") { throw "PS5.1 native wrapper did not inherit its environment" }
Write-Output ps51-stdout
Write-Error "VEM_VISION_HARNESS_PS51_STDERR" -ErrorAction Continue
exit 0
'
      Assert-True ($ps51Returned.stdout.Trim() -ceq "ps51-stdout") "PS5.1 native wrapper did not capture stdout"
      Assert-True ($ps51Returned.stderr -match "(?m)(?<!\S)VEM_VISION_HARNESS_PS51_STDERR(?!\S)") "PS5.1 native wrapper did not capture its non-terminating stderr marker"

      $ps51NonzeroFailure = $null
      try {
        Invoke-BoundedPowerShell -Stage "behavior.ps51-native-wrapper-nonzero" -TimeoutSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $windowsPowerShell -HarnessDeadlineUtc $deadlineUtc -ScriptBody '
if ($env:VEM_VISION_HARNESS_PS51_ENV -cne "native-wrapper") { throw "PS5.1 native wrapper nonzero invocation did not inherit its environment" }
Write-Output nonzero-stdout
Write-Error "VEM_VISION_HARNESS_PS51_NONZERO_STDERR" -ErrorAction Continue
exit 23
' | Out-Null
      } catch {
        $ps51NonzeroFailure = $_.Exception.Message
      }
      Assert-True (-not [string]::IsNullOrWhiteSpace($ps51NonzeroFailure)) "PS5.1 native wrapper nonzero invocation did not fail"
      foreach ($expectedDiagnostic in @("exit code 23", "command=", "nonzero-stdout")) {
        Assert-True ($ps51NonzeroFailure -match [regex]::Escape($expectedDiagnostic)) "PS5.1 native wrapper nonzero invocation omitted diagnostic '$expectedDiagnostic': $ps51NonzeroFailure"
      }
      Assert-True ($ps51NonzeroFailure -match "(?m)(?<!\S)VEM_VISION_HARNESS_PS51_NONZERO_STDERR(?!\S)") "PS5.1 native wrapper nonzero invocation omitted its stderr marker: $ps51NonzeroFailure"
    } finally {
      Stop-Transcript | Out-Null
    }
    $ps51Telemetry = Get-Content -LiteralPath $ps51TranscriptPath -Raw
    foreach ($status in @("created-suspended", "job-assigned-suspended", "resumed-job-assigned")) {
      Assert-True ($ps51Telemetry -match "stage=behavior.ps51-native-wrapper status=process-ownership detail=state=$status") "PS5.1 native wrapper did not record $status"
    }
    Assert-True ($ps51Telemetry -match "stage=behavior.ps51-native-wrapper status=completed") "PS5.1 native wrapper did not record normal exit"
    Assert-True ($ps51Telemetry -match "stage=behavior.ps51-native-wrapper status=cleanup-job-dispose-completed") "PS5.1 native wrapper did not complete Job Object cleanup"
    Assert-True ($ps51Telemetry -match "stage=behavior.ps51-native-wrapper-nonzero status=failed detail=exitCode=23") "PS5.1 native wrapper nonzero invocation did not record its exit code"
    Assert-True ($ps51Telemetry -match "stage=behavior.ps51-native-wrapper-nonzero status=cleanup-job-dispose-completed") "PS5.1 native wrapper nonzero invocation did not complete Job Object cleanup"
  } finally {
    [Environment]::SetEnvironmentVariable("VEM_VISION_HARNESS_PS51_ENV", $previousPs51Environment, [EnvironmentVariableTarget]::Process)
  }

  Assert-BeforeDeadline
  $verifiedRuntime = Start-Process -FilePath $pwshPath -ArgumentList @("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60") -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $root "verified-runtime.stdout.log") -RedirectStandardError (Join-Path $root "verified-runtime.stderr.log")
  try {
    Assert-True ($verifiedRuntime -is [Diagnostics.Process]) "verified runtime did not retain a .NET process handle"
    $metadataPath = Join-Path $root "verified-runtime-metadata.json"
    $processStateRoot = Join-Path $context.stateRoot "process-state"
    $expectedPath = [IO.Path]::GetFullPath($verifiedRuntime.Path)
    $expectedDigest = Get-Digest $verifiedRuntime.Path
    Write-Json $metadataPath @{ entrypointDigest=$expectedDigest }
    Write-Json (Join-Path $context.stateRoot "current.json") @{ schemaVersion="vem-vision-selection/v1"; bundleDigest=$context.bundleDigest; revision="verified-runtime"; metadataPath=$metadataPath; installDirectory=(Split-Path -Parent $expectedPath); entrypoint=(Split-Path -Leaf $expectedPath) }
    Write-Json (Join-Path $processStateRoot "active-process.json") @{ bundleDigest=$context.bundleDigest; selectionRevision="verified-runtime"; processId=$verifiedRuntime.Id; creationTimeUtcTicks=$verifiedRuntime.StartTime.ToUniversalTime().Ticks; executablePath=$expectedPath; executableDigest=$expectedDigest }
    Assert-True (Stop-HarnessFixtureRuntime -Context $context) "verified runtime cleanup rejected a valid selection and process record"
    Assert-True ($verifiedRuntime.HasExited) "verified runtime cleanup did not stop the selected process"
    Assert-True (-not (Test-Path -LiteralPath (Join-Path $processStateRoot "active-process.json"))) "verified runtime cleanup left its process record"
  } finally {
    if (-not $verifiedRuntime.HasExited) { $verifiedRuntime.Kill(); $verifiedRuntime.WaitForExit(5000) | Out-Null }
    $verifiedRuntime.Dispose()
  }

  Assert-BeforeDeadline
  $descendantIdentityPath = Join-Path $root "descendant.identity.json"
  $timeoutBody = @'
$pwshPath = Get-Command pwsh -CommandType Application -ErrorAction Stop | Select-Object -First 1 -ExpandProperty Source
$descendant = Start-Process -FilePath $pwshPath -ArgumentList @("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60") -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $context.root "descendant.stdout.log") -RedirectStandardError (Join-Path $context.root "descendant.stderr.log")
try {
  if ($descendant -isnot [Diagnostics.Process]) { throw "descendant did not retain a .NET process handle" }
  Write-Json (Join-Path $context.root "descendant.identity.json") @{ processId=$descendant.Id; creationTimeUtcTicks=$descendant.StartTime.ToUniversalTime().Ticks; executablePath=[IO.Path]::GetFullPath($descendant.Path) }
  Start-Sleep -Milliseconds 2100
} finally {
  $descendant.Dispose()
}
'@
  $timeoutTranscriptPath = Join-Path $root "timeout-telemetry.log"
  Start-Transcript -Path $timeoutTranscriptPath -Force | Out-Null
  try {
    Invoke-BoundedPowerShell -Stage "behavior.parent-exits-near-timeout" -TimeoutSeconds 2 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc $deadlineUtc -ScriptBody $timeoutBody | Out-Null
    throw "timed-out bounded invocation did not throw"
  } catch {
    if ($_.Exception.Message -notmatch "exceeded") { throw }
  } finally {
    Stop-Transcript | Out-Null
  }
  $timeoutTelemetry = Get-Content -LiteralPath $timeoutTranscriptPath -Raw
  Assert-True ($timeoutTelemetry -match "stage=behavior.parent-exits-near-timeout status=timed-out detail=timeoutSeconds=2 termination=job-object") "timed-out bounded invocation did not emit precise Job Object timeout telemetry"
  Assert-True ($timeoutTelemetry -match "stage=behavior.parent-exits-near-timeout status=termination-requested detail=termination=job-object") "timed-out bounded invocation did not record the explicit Job Object termination request"
  Assert-True ($timeoutTelemetry -match "stage=behavior.parent-exits-near-timeout status=termination-signaled detail=termination=job-object") "timed-out bounded invocation did not record the explicit Job Object termination signal"
  Assert-True ($timeoutTelemetry -match "stage=behavior.parent-exits-near-timeout status=termination-waiting detail=remainingMilliseconds=[0-9]+ confirmationReserveMilliseconds=[1-9][0-9]* termination=job-object") "timed-out bounded invocation did not record its bounded termination wait"
  Assert-True ($timeoutTelemetry -match "stage=behavior.parent-exits-near-timeout status=termination-confirmed detail=termination=job-object activeProcesses=0 confirmationReserveMilliseconds=[1-9][0-9]*") "timed-out bounded invocation did not confirm an empty Job Object before cleanup"
  Assert-True ($timeoutTelemetry -match "stage=behavior.parent-exits-near-timeout status=cleanup-job-dispose-started") "timed-out bounded invocation did not record Job Object cleanup start"
  Assert-True ($timeoutTelemetry -match "stage=behavior.parent-exits-near-timeout status=cleanup-job-dispose-completed") "timed-out bounded invocation did not record Job Object cleanup completion"
  Assert-True ($timeoutTelemetry.IndexOf("status=termination-confirmed") -lt $timeoutTelemetry.IndexOf("status=cleanup-job-dispose-started")) "Job Object cleanup started before termination was confirmed"
  Assert-True (Test-Path -LiteralPath $descendantIdentityPath -PathType Leaf) "timed-out child did not record its descendant identity"
  $descendantIdentity = Get-Content -LiteralPath $descendantIdentityPath -Raw | ConvertFrom-Json
  $descendant = Get-RunningProcess -ProcessId ([int]$descendantIdentity.processId)
  try {
    Assert-True ($null -eq $descendant) "timed-out bounded invocation left its descendant alive"
  } finally {
    if ($null -ne $descendant) { $descendant.Dispose() }
  }
  Assert-True (-not $unrelated.HasExited) "timed-out bounded invocation stopped an unrelated retained process"

  Assert-BeforeDeadline
  $normalDescendantIdentityPath = Join-Path $root "normal-parent-exit-descendant.identity.json"
  $normalParentExitTranscriptPath = Join-Path $root "normal-parent-exit.telemetry.log"
  Start-Transcript -Path $normalParentExitTranscriptPath -Force | Out-Null
  try {
    $normalParentExit = Invoke-BoundedPowerShell -Stage "behavior.normal-parent-exit-active-descendant" -TimeoutSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc $deadlineUtc -ScriptBody @'
$descendantStdoutPath = Join-Path $context.root "normal-parent-exit-descendant.stdout.log"
$descendantStderrPath = Join-Path $context.root "normal-parent-exit-descendant.stderr.log"
$descendant = Start-Process -FilePath $env:COMSPEC -ArgumentList @('/d', '/c', 'ping -t 127.0.0.1') -RedirectStandardOutput $descendantStdoutPath -RedirectStandardError $descendantStderrPath -WindowStyle Hidden -PassThru
try {
  Write-Json (Join-Path $context.root "normal-parent-exit-descendant.identity.json") @{ processId=$descendant.Id; creationTimeUtcTicks=$descendant.StartTime.ToUniversalTime().Ticks; executablePath=[IO.Path]::GetFullPath($descendant.Path) }
  Write-Output normal-parent-exit
} finally {
  $descendant.Dispose()
}
'@
    Assert-True ($normalParentExit.stdout.Trim() -ceq "normal-parent-exit") "normal-parent-exit bounded invocation did not preserve stdout"
  } finally {
    Stop-Transcript | Out-Null
  }
  $normalParentExitTelemetry = Get-Content -LiteralPath $normalParentExitTranscriptPath -Raw
  Assert-True ($normalParentExitTelemetry -match "stage=behavior.normal-parent-exit-active-descendant status=completed") "normal-parent-exit bounded parent did not complete naturally"
  Assert-True ($normalParentExitTelemetry -match "stage=behavior.normal-parent-exit-active-descendant status=cleanup-confirmation-waiting detail=remainingMilliseconds=[0-9]+ confirmationReserveMilliseconds=[1-9][0-9]* termination=job-object") "normal-parent-exit active descendant did not begin a bounded natural-exit wait"
  $normalTerminationWait = [regex]::Match($normalParentExitTelemetry, "stage=behavior.normal-parent-exit-active-descendant status=termination-waiting detail=remainingMilliseconds=([0-9]+) confirmationReserveMilliseconds=([0-9]+) termination=job-object")
  Assert-True $normalTerminationWait.Success "normal-parent-exit active descendant did not reserve a termination-confirmation window"
  Assert-True ([int]$normalTerminationWait.Groups[1].Value -gt 0) "normal-parent-exit active descendant did not leave the reserved termination-confirmation window"
  Assert-True ($normalParentExitTelemetry -match "stage=behavior.normal-parent-exit-active-descendant status=termination-confirmed detail=termination=job-object activeProcesses=0 confirmationReserveMilliseconds=[1-9][0-9]*") "normal-parent-exit active descendant did not confirm Job Object termination"
  Assert-True (Test-Path -LiteralPath $normalDescendantIdentityPath -PathType Leaf) "normal-parent-exit child did not record its descendant identity"
  $normalDescendantIdentity = Get-Content -LiteralPath $normalDescendantIdentityPath -Raw | ConvertFrom-Json
  $normalDescendant = Get-RunningProcess -ProcessId ([int]$normalDescendantIdentity.processId)
  try {
    Assert-True ($null -eq $normalDescendant) "normal-parent-exit active descendant remained alive after the Job Object cleanup"
  } finally {
    if ($null -ne $normalDescendant) { $normalDescendant.Dispose() }
  }

  Assert-BeforeDeadline
  Write-HarnessStage "behavior.hard-watchdog" "run-signal-creating"
  New-Item -ItemType File -Path $hardWatchdogRunSignalPath -ErrorAction Stop | Out-Null
  Write-HarnessStage "behavior.hard-watchdog" "run-signal-created"
  Wait-ForSignal -Path $hardWatchdogFaultSignalPath -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(15)) -FailureMessage "hard watchdog host did not validate its unconfirmed cleanup telemetry"
  Write-HarnessStage "behavior.hard-watchdog" "fault-observed"
  Write-HarnessStage "behavior.hard-watchdog" "fault-signal-reading"
  Assert-True ((Get-Content -LiteralPath $hardWatchdogFaultSignalPath -Raw).Trim() -ceq "fault-observed") "hard watchdog host did not acknowledge the expected cleanup fault"
  Write-HarnessStage "behavior.hard-watchdog" "fault-signal-validated"
  Write-HarnessStage "behavior.hard-watchdog" "inherited-watchdog-arming"
  $hardWatchdogDeadlineUtc = [DateTime]::UtcNow.AddSeconds(4)
  $deadlineWatchdog = $null
  try {
    Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "hard-watchdog-host-deadline") -WatchdogPath $script:HarnessSuspendedProcessWatchdogPath -NativeProcess $hardWatchdogHost.process -DeadlineUtc $hardWatchdogDeadlineUtc -Watchdog ([ref]$deadlineWatchdog) | Out-Null
  } finally {
    $hardWatchdogHost.deadlineWatchdog = $deadlineWatchdog
  }
  Write-HarnessStage "behavior.hard-watchdog" "inherited-watchdog-armed" "processId=$($hardWatchdogHost.deadlineWatchdog.processId) identity=original-process-handle"
  Complete-HarnessSuspendedProcessWatchdog -Watchdog $hardWatchdogHost.lifetimeWatchdog -Action "disarm" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(1)) | Out-Null
  $hardWatchdogHost.lifetimeWatchdog = $null
  Write-HarnessStage "behavior.hard-watchdog" "lifetime-watchdog-disarmed"
  Write-HarnessStage "behavior.hard-watchdog" "descendant-identity-reading"
  Assert-True (Test-Path -LiteralPath $hardWatchdogIdentityPath -PathType Leaf) "hard watchdog host did not create a live descendant"
  $hardWatchdogDescendantIdentity = Get-Content -LiteralPath $hardWatchdogIdentityPath -Raw | ConvertFrom-Json
  Write-HarnessStage "behavior.hard-watchdog" "descendant-identity-read"
  Write-HarnessStage "behavior.hard-watchdog" "host-termination-waiting"
  Wait-ForSignal -Path $hardWatchdogHost.deadlineWatchdog.completionPath -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(6)) -FailureMessage "hard watchdog did not terminate its independent host before its absolute deadline"
  $hardWatchdogCompletion = (Get-Content -LiteralPath $hardWatchdogHost.deadlineWatchdog.completionPath -Raw).Trim()
  Assert-True ($hardWatchdogCompletion -in @("terminated", "exited")) "hard watchdog returned an invalid independent-host completion: $hardWatchdogCompletion"
  Assert-True ($hardWatchdogHost.process.WaitForExit([uint32]0)) "hard watchdog completion did not signal the independent host original process handle"
  Write-HarnessStage "behavior.hard-watchdog" "host-termination-confirmed" "completion=$hardWatchdogCompletion identity=original-process-handle"
  Write-HarnessStage "behavior.hard-watchdog" "descendant-termination-waiting"
  $terminatedDescendant = Get-RunningProcess -ProcessId ([int]$hardWatchdogDescendantIdentity.processId)
  try {
    if ($null -ne $terminatedDescendant -and ($terminatedDescendant.StartTime.ToUniversalTime().Ticks -ne [Int64]$hardWatchdogDescendantIdentity.creationTimeUtcTicks -or [IO.Path]::GetFullPath($terminatedDescendant.Path) -cne [IO.Path]::GetFullPath([string]$hardWatchdogDescendantIdentity.executablePath))) {
      throw "hard watchdog descendant process identity no longer matches the original handle-owned process"
    }
    Assert-True ($null -eq $terminatedDescendant) "hard watchdog left its live descendant"
  } finally {
    if ($null -ne $terminatedDescendant) { $terminatedDescendant.Dispose() }
  }
  Write-HarnessStage "behavior.hard-watchdog" "descendant-termination-confirmed"
  Write-HarnessStage "behavior.hard-watchdog" "cleanup-started" "completion=$hardWatchdogCompletion identity=original-process-handle"
  Close-HarnessSuspendedProcessWatchdog -Watchdog $hardWatchdogHost.deadlineWatchdog
  $hardWatchdogHost.deadlineWatchdog = $null
  $hardWatchdogHost.process.Dispose()
  Write-HarnessStage "behavior.hard-watchdog" "cleanup-completed" "completion=$hardWatchdogCompletion identity=original-process-handle"
  $hardWatchdogHost = $null

  Write-Host "vision release installer harness behavior checks passed"
} finally {
  try {
    if ($null -eq $descendantIdentity -and (Test-Path -LiteralPath (Join-Path $root "descendant.identity.json") -PathType Leaf)) {
      $descendantIdentity = Get-Content -LiteralPath (Join-Path $root "descendant.identity.json") -Raw | ConvertFrom-Json
    }
    Stop-TrackedProcess -Identity $descendantIdentity
    Stop-TrackedProcess -Identity $normalDescendantIdentity
    Stop-TrackedProcess -Identity $hardWatchdogDescendantIdentity
  } finally {
    if ($null -ne $unrelated) {
      try {
        if (-not $unrelated.HasExited) {
          $unrelated.Kill()
          $unrelated.WaitForExit(5000) | Out-Null
        }
      } finally {
        $unrelated.Dispose()
      }
    }
    if ($null -ne $hardWatchdogHost) {
      try {
        Stop-HardWatchdogHost -HostProcess $hardWatchdogHost -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(5))
      } finally {
        $hardWatchdogHost = $null
      }
    }
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
    if ($null -ne $watchdog) { $watchdog.Dispose() }
  }
}
