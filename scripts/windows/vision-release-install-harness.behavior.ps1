[CmdletBinding()]
param(
  [string]$HarnessPath = (Join-Path $PSScriptRoot "vision-release-install.windows-harness.ps1"),
  [ValidateRange(30, 120)][int]$DeadlineSeconds = 60,
  [ValidateRange(60, 180)][int]$HardDeadlineSeconds = 90,
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

function Assert-ExactCertificateCleanup([string]$CertificateSubject) {
  foreach ($storePath in "Cert:\CurrentUser\My", "Cert:\CurrentUser\Root", "Cert:\CurrentUser\TrustedPublisher") {
    $remaining = @(Get-ChildItem -Path $storePath -ErrorAction Stop | Where-Object { $_.Subject -eq $CertificateSubject })
    Assert-True ($remaining.Count -eq 0) "fixture certificate remained after cleanup in $storePath"
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

function Write-FaultTelemetryRecordToHost([object]$Record) {
  $message = if ($Record -is [Management.Automation.InformationRecord]) { [string]$Record.MessageData } else { [string]$Record }
  $Host.UI.WriteLine($message)
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
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-harness-behavior-" + [guid]::NewGuid().ToString("N"))
$contextPath = Join-Path $root "context.json"
$certificateSubject = "CN=VEM Vision Harness Behavior " + [guid]::NewGuid().ToString("N")
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
using System.Threading;

public static class SlowWatchdog {
  private static void Write(string path, string value) {
    var temporaryPath = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
    File.WriteAllText(temporaryPath, value);
    File.Move(temporaryPath, path);
  }

  public static int Main(string[] args) {
    if (args == null || args.Length != 6) { return 2; }
    Thread.Sleep(4000);
    Write(args[2], "armed");
    for (;;) {
      if (File.Exists(args[1])) {
        var command = File.ReadAllText(args[1]).Trim();
        if (String.Equals(command, "disarm", StringComparison.Ordinal)) {
          Write(args[3], "disarmed");
          return 0;
        }
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
  $setupTimeoutWatchdogPath = Join-Path $root "setup-timeout-watchdog.exe"
  $setupTimeoutWatchdogSourcePath = Join-Path $root "SetupTimeoutWatchdog.cs"
  Write-Utf8 $setupTimeoutWatchdogSourcePath @'
using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class SetupTimeoutWatchdog {
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool TerminateProcess(IntPtr process, uint exitCode);

  private static void Write(string path, string value) {
    var temporaryPath = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
    File.WriteAllText(temporaryPath, value);
    File.Move(temporaryPath, path);
  }

  public static int Main(string[] args) {
    if (args == null || args.Length != 6) { return 2; }
    Write(args[2] + ".deadline", args[4]);
    var deadlineUtc = new DateTime(Int64.Parse(args[4], NumberStyles.None, CultureInfo.InvariantCulture), DateTimeKind.Utc);
    while (DateTime.UtcNow < deadlineUtc) { Thread.Sleep(10); }
    var process = new IntPtr(unchecked((long)UInt64.Parse(args[0], CultureInfo.InvariantCulture)));
    if (!TerminateProcess(process, 1)) {
      Write(args[3], "terminate-failed:" + Marshal.GetLastWin32Error());
      return 1;
    }
    Write(args[3], "terminated");
    return 0;
  }
}
'@
  & $csc /nologo /target:exe ("/out:{0}" -f $setupTimeoutWatchdogPath) $setupTimeoutWatchdogSourcePath
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $setupTimeoutWatchdogPath -PathType Leaf)) { throw "setup timeout watchdog fixture compilation failed" }
  $setupTimeoutTranscriptPath = Join-Path $root "setup-timeout-watchdog.telemetry.log"
  $originalWatchdogPath = $script:HarnessSuspendedProcessWatchdogPath
  $previousTerminateUnresumedFailure = $env:VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_UNRESUMED_FAILURE
  $script:HarnessSuspendedProcessWatchdogPath = $setupTimeoutWatchdogPath
  $env:VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_UNRESUMED_FAILURE = "1"
  $setupTimeoutStartUtc = [DateTime]::UtcNow
  $setupTimeoutHarnessDeadlineUtc = $setupTimeoutStartUtc.AddSeconds(7)
  try {
    $setupTimeoutFailure = $null
    Start-Transcript -Path $setupTimeoutTranscriptPath -Force | Out-Null
    try {
      Invoke-BoundedPowerShell -Stage "behavior.watchdog-setup-timeout" -TimeoutSeconds 2 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc $setupTimeoutHarnessDeadlineUtc -ScriptBody 'Write-Output must-not-run' | Out-Null
    } catch {
      $setupTimeoutFailure = $_.Exception.Message
    } finally {
      Stop-Transcript | Out-Null
    }
    Assert-True ($setupTimeoutFailure -match "did not inherit|setup handoff deadline elapsed") "watchdog setup timeout did not fail its bounded invocation: $setupTimeoutFailure"
    $automaticDeadlinePath = Get-ChildItem -LiteralPath $root -Recurse -Filter "ready.deadline" | Select-Object -First 1 -ExpandProperty FullName
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$automaticDeadlinePath)) "setup timeout watchdog did not record its automatic termination deadline"
    $automaticDeadlineUtc = [DateTime]::new([Int64](Get-Content -LiteralPath $automaticDeadlinePath -Raw), [DateTimeKind]::Utc)
    Assert-True ($automaticDeadlineUtc -lt $setupTimeoutStartUtc.AddSeconds(6)) "setup timeout watchdog received the harness deadline instead of its setup deadline"
    $setupTimeoutTelemetry = Get-Content -LiteralPath $setupTimeoutTranscriptPath -Raw
    Assert-True ($setupTimeoutTelemetry -match "stage=behavior.watchdog-setup-timeout status=suspended-process-watchdog-setup-failed detail=watchdogProcess=running;ready=missing;completion=missing;temporaryFiles=command:0,invalid:0,overflow:false;setupDeadlineUtcTicks=[0-9]+;automaticDeadlineUtcTicks=[0-9]+;automaticConfirmationDeadlineUtcTicks=[0-9]+;lastWin32Error=[0-9]+") "setup timeout did not record bounded watchdog setup diagnostics"
    $takeover = [regex]::Match($setupTimeoutTelemetry, "stage=behavior.watchdog-setup-timeout status=suspended-process-watchdog-terminated detail=processId=([0-9]+) completion=terminated identity=original-process-handle")
    Assert-True $takeover.Success "setup timeout did not confirm delayed watchdog takeover"
    $suspendedProcess = Get-RunningProcess -ProcessId ([int]$takeover.Groups[1].Value)
    try {
      Assert-True ($null -eq $suspendedProcess) "watchdog setup timeout left its suspended native process running"
    } finally {
      if ($null -ne $suspendedProcess) { $suspendedProcess.Dispose() }
    }
  } finally {
    $script:HarnessSuspendedProcessWatchdogPath = $originalWatchdogPath
    $env:VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_UNRESUMED_FAILURE = $previousTerminateUnresumedFailure
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
$descendant = Start-Process -FilePath $env:COMSPEC -ArgumentList @('/d', '/c', 'ping -t 127.0.0.1') -PassThru -NoNewWindow
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

  foreach ($fault in @(
    [pscustomobject]@{ stage="behavior.create-job-failure"; variable="VEM_VISION_HARNESS_FIXTURE_FORCE_CREATE_JOB_FAILURE"; secondaryVariable=$null; scriptBody="Write-Output create-job-probe"; cleanupMechanism=$null; expectedOwnership=$null },
    [pscustomobject]@{ stage="behavior.set-job-limit-failure"; variable="VEM_VISION_HARNESS_FIXTURE_FORCE_SET_JOB_LIMIT_FAILURE"; secondaryVariable=$null; scriptBody="Write-Output set-job-limit-probe"; cleanupMechanism=$null; expectedOwnership=$null },
    [pscustomobject]@{ stage="behavior.assign-job-failure"; variable="VEM_VISION_HARNESS_FIXTURE_FORCE_ASSIGN_JOB_FAILURE"; secondaryVariable=$null; scriptBody="Write-Output assign-job-probe"; cleanupMechanism="native"; expectedOwnership="created-suspended" },
    [pscustomobject]@{ stage="behavior.assign-and-suspended-terminate-failure"; variable="VEM_VISION_HARNESS_FIXTURE_FORCE_ASSIGN_JOB_FAILURE"; secondaryVariable="VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_UNRESUMED_FAILURE"; scriptBody="Write-Output assign-and-terminate-probe"; cleanupMechanism="watchdog"; expectedOwnership="created-suspended" },
    [pscustomobject]@{ stage="behavior.terminate-job-failure"; variable="VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_JOB_FAILURE"; secondaryVariable=$null; scriptBody="exit 17"; cleanupMechanism=$null; expectedOwnership="resumed-job-assigned" },
    [pscustomobject]@{ stage="behavior.active-process-count-failure"; variable="VEM_VISION_HARNESS_FIXTURE_FORCE_ACTIVE_PROCESS_COUNT_FAILURE"; secondaryVariable=$null; scriptBody="Write-Output active-process-count-probe"; cleanupMechanism=$null; expectedOwnership="resumed-job-assigned" }
  )) {
    Assert-BeforeDeadline
    $previousFaultValue = [Environment]::GetEnvironmentVariable($fault.variable, [EnvironmentVariableTarget]::Process)
    $previousSecondaryFaultValue = if ([string]::IsNullOrWhiteSpace([string]$fault.secondaryVariable)) { $null } else { [Environment]::GetEnvironmentVariable($fault.secondaryVariable, [EnvironmentVariableTarget]::Process) }
    [Environment]::SetEnvironmentVariable($fault.variable, "1", [EnvironmentVariableTarget]::Process)
    if (-not [string]::IsNullOrWhiteSpace([string]$fault.secondaryVariable)) { [Environment]::SetEnvironmentVariable($fault.secondaryVariable, "1", [EnvironmentVariableTarget]::Process) }
    $faultRecords = New-Object 'System.Collections.Generic.List[object]'
    try {
      Invoke-BoundedPowerShell -Stage $fault.stage -TimeoutSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $windowsPowerShell -HarnessDeadlineUtc $deadlineUtc -ScriptBody $fault.scriptBody 6>&1 | ForEach-Object {
        [void]$faultRecords.Add($_)
        Write-FaultTelemetryRecordToHost $_
      }
      if ($fault.stage -match "(create-job|set-job-limit|assign-job)") { throw "fault injection $($fault.stage) did not fail bounded setup" }
    } catch {
      if ($fault.stage -match "(terminate-job|active-process-count)" -and $_.Exception.Message -notmatch "failed with exit code") { throw }
    } finally {
      [Environment]::SetEnvironmentVariable($fault.variable, $previousFaultValue, [EnvironmentVariableTarget]::Process)
      if (-not [string]::IsNullOrWhiteSpace([string]$fault.secondaryVariable)) { [Environment]::SetEnvironmentVariable($fault.secondaryVariable, $previousSecondaryFaultValue, [EnvironmentVariableTarget]::Process) }
    }
    $faultTelemetry = ($faultRecords | ForEach-Object {
      if ($_ -is [Management.Automation.InformationRecord]) { [string]$_.MessageData } else { [string]$_ }
    }) -join [Environment]::NewLine
    if ($fault.expectedOwnership -eq "resumed-job-assigned") {
      Assert-True ($faultTelemetry -match "stage=$($fault.stage) status=process-ownership detail=state=resumed-job-assigned") "fault injection $($fault.stage) did not record resumed Job Object process ownership"
    } elseif ($fault.cleanupMechanism -eq "native") {
      Assert-True ($faultTelemetry -match "stage=$($fault.stage) status=process-ownership detail=state=$($fault.expectedOwnership)") "fault injection $($fault.stage) did not record its suspended process"
      Assert-True ($faultTelemetry -match "stage=$($fault.stage) status=suspended-process-termination-confirmed detail=processId=[0-9]+") "fault injection $($fault.stage) did not terminate its unresumed process through the native handle"
      Assert-True ($faultTelemetry -notmatch "stage=$($fault.stage) status=suspended-process-watchdog-terminated") "native cleanup fault unexpectedly delegated to the watchdog"
    } elseif ($fault.cleanupMechanism -eq "watchdog") {
      Assert-True ($faultTelemetry -match "stage=$($fault.stage) status=process-ownership detail=state=$($fault.expectedOwnership)") "watchdog cleanup fault did not record its suspended process"
      Assert-True ($faultTelemetry -match "stage=$($fault.stage) status=suspended-process-termination-failed") "watchdog cleanup fault did not preserve the native termination failure"
      $watchdogTermination = [regex]::Match($faultTelemetry, "stage=$($fault.stage) status=suspended-process-watchdog-terminated detail=processId=([0-9]+) completion=(terminated|exited) identity=original-process-handle")
      Assert-True $watchdogTermination.Success "watchdog cleanup fault did not confirm termination through the inherited original process handle"
      Assert-True ($faultTelemetry -notmatch "wait-failed:6|ERROR_INVALID_HANDLE") "watchdog inherited-handle probe observed ERROR_INVALID_HANDLE"
      $suspendedProcess = Get-RunningProcess -ProcessId ([int]$watchdogTermination.Groups[1].Value)
      try {
        Assert-True ($null -eq $suspendedProcess) "watchdog cleanup did not terminate the combined setup-failure process"
      } finally {
        if ($null -ne $suspendedProcess) { $suspendedProcess.Dispose() }
      }
    } else {
      Assert-True ($faultTelemetry -notmatch "stage=$($fault.stage) status=process-ownership") "fault injection $($fault.stage) created a child before Job setup completed"
    }
    if ($fault.stage -eq "behavior.terminate-job-failure") {
      Assert-True ($faultTelemetry -match "stage=$($fault.stage) status=termination-failed detail=termination=job-object operation=terminate-job-object exceptionType=[A-Za-z0-9._:-]+ exceptionMessage=[A-Za-z0-9._:-]+ nativeErrorCode=[0-9]+") "termination failure did not retain sanitized telemetry"
      Assert-True ($faultTelemetry -match "stage=$($fault.stage) status=cleanup-job-dispose-completed") "historical termination failure blocked Job Object close after activeProcesses reached zero"
    }
    if ($fault.stage -eq "behavior.active-process-count-failure") {
      Assert-True ($faultTelemetry -match "stage=$($fault.stage) status=termination-query-failed detail=termination=job-object operation=active-process-count") "query failure did not retain telemetry"
      Assert-True ($faultTelemetry -match "stage=$($fault.stage) status=cleanup-job-dispose-completed") "historical query failure blocked Job Object close after activeProcesses reached zero"
    }
  }

  Assert-BeforeDeadline
  Write-HarnessStage "behavior.hard-watchdog" "run-signal-creating"
  New-Item -ItemType File -Path $hardWatchdogRunSignalPath -ErrorAction Stop | Out-Null
  Write-HarnessStage "behavior.hard-watchdog" "run-signal-created"
  Wait-ForSignal -Path $hardWatchdogFaultSignalPath -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(3)) -FailureMessage "hard watchdog host did not validate its unconfirmed cleanup telemetry"
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
  Assert-True ((Get-Content -LiteralPath $hardWatchdogHost.deadlineWatchdog.completionPath -Raw).Trim() -ceq "terminated") "hard watchdog did not terminate its independent host"
  Write-HarnessStage "behavior.hard-watchdog" "host-termination-confirmed"
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
  Stop-HardWatchdogHost -HostProcess $hardWatchdogHost -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(5))
  $hardWatchdogHost = $null

  Assert-BeforeDeadline
  $certificate = $null
  try {
    $certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $certificateSubject -KeyUsage DigitalSignature -HashAlgorithm SHA256 -CertStoreLocation "Cert:\CurrentUser\My"
    $certificatePath = Join-Path $root "certificate.cer"
    Export-Certificate -Cert $certificate -FilePath $certificatePath -Force | Out-Null
    Import-Certificate -FilePath $certificatePath -CertStoreLocation "Cert:\CurrentUser\Root" | Out-Null
    Import-Certificate -FilePath $certificatePath -CertStoreLocation "Cert:\CurrentUser\TrustedPublisher" | Out-Null
    foreach ($storePath in "Cert:\CurrentUser\My", "Cert:\CurrentUser\Root", "Cert:\CurrentUser\TrustedPublisher") {
      Assert-True (@(Get-ChildItem -Path $storePath | Where-Object { $_.Subject -eq $certificateSubject }).Count -eq 1) "fixture certificate mutation was incomplete in $storePath"
    }

    New-Item -ItemType Directory -Force -Path $context.stateRoot | Out-Null
    Write-Json (Join-Path $context.stateRoot "current.json") @{}
    Write-Json (Join-Path $root "fixture-certificate-cleanup.json") @{ certificateSubject=$certificateSubject }
    $serialized = Invoke-BoundedPowerShell -Stage "behavior.serialized-cleanup" -TimeoutSeconds 5 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $pwshPath -HarnessDeadlineUtc $deadlineUtc -ScriptBody @'
try {
  Invoke-HarnessFixtureCleanup -Context $context
  throw "serialized cleanup did not report the invalid runtime selection"
} catch {
  if ($_.Exception.Message -notmatch "fixture runtime cleanup could not verify") { throw }
  Write-HarnessStage "behavior.serialized-cleanup" "completed" "runtime failure still cleaned certificates"
}
'@
    Assert-True ($serialized.stdout -match "stage=behavior.serialized-cleanup status=completed") "serialized cleanup did not execute its dependency chain"
    Assert-ExactCertificateCleanup $certificateSubject
  } finally {
    Remove-HarnessFixtureCertificates -CertificateSubject $certificateSubject
    Assert-ExactCertificateCleanup $certificateSubject
  }

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
