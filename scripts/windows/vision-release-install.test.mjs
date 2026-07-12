import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const fixture = "scripts/windows/vision-release-install.fixtures.ps1";
const behaviorHarness =
  "scripts/windows/vision-release-install-harness.behavior.ps1";
const windowsHarness =
  "scripts/windows/vision-release-install.windows-harness.ps1";
const ciWorkflow = ".github/workflows/ci.yml";
const SPAWN_TIMEOUT_MS = 45_000;
const TEST_TIMEOUT_MS = 60_000;

function boundedIt(name, options, fn) {
  if (typeof options === "function") {
    return it(name, { timeout: TEST_TIMEOUT_MS }, options);
  }
  return it(name, { timeout: TEST_TIMEOUT_MS, ...options }, fn);
}

function spawnBounded(command, args, options = {}) {
  const timeout = options.timeout ?? SPAWN_TIMEOUT_MS;
  const result = spawnSync(command, args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout,
    ...options,
  });
  assert.notEqual(
    result.error?.code,
    "ETIMEDOUT",
    `${command} exceeded ${timeout}ms`,
  );
  return result;
}

function parsePowerShell(path) {
  return spawnBounded("pwsh", [
    "-NoProfile",
    "-Command",
    `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${path}',[ref]$tokens,[ref]$errors)|Out-Null;if(@($errors).Count){$errors|% {Write-Error $_};exit 1}`,
  ]);
}

describe("Vision release installer fixtures", () => {
  for (const testCase of [
    "archive",
    "bytes",
    "first-install",
    "acl",
    "task",
    "process-record",
    "launcher",
    "protocol",
    "rollback",
    "orphan",
    "mutex",
    "reinstall",
    "runtime-verifier",
  ]) {
    boundedIt(`runs the ${testCase} fixture through PowerShell`, () => {
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-File",
        fixture,
        "-Case",
        testCase,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(`${testCase} fixtures passed`));
    });
  }

  for (const [name, path] of [
    ["production installer", "scripts/windows/install-vision-release.ps1"],
    ["Vision runtime verifier", "scripts/windows/verify-vem-runtime.ps1"],
    ["Windows harness library seam", windowsHarness],
    ["Windows behavior harness", behaviorHarness],
  ]) {
    boundedIt(`parses the ${name}`, () => {
      const result = parsePowerShell(path);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });
  }

  boundedIt(
    "uses a PS 5.1-compatible Windows command-line quote for spaced child paths",
    () => {
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-Command",
        ". ./scripts/windows/vision-release-install.windows-harness.ps1 -Library; Initialize-HarnessNativeTypes; $actual=[VemVisionHarness.SuspendedProcess]::QuoteArgument('C:\\Program Files\\PowerShell\\7\\pwsh.exe'); if($actual -cne '\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\"'){throw \"unexpected quote: $actual\"}",
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "uses the native child-path quote under both PowerShell editions on Windows",
    { skip: process.platform !== "win32" },
    () => {
      const quoteProbe =
        ". ./scripts/windows/vision-release-install.windows-harness.ps1 -Library; Initialize-HarnessNativeTypes; $actual=[VemVisionHarness.SuspendedProcess]::QuoteArgument('C:\\Program Files\\PowerShell\\7\\pwsh.exe'); if($actual -cne '\"C:\\Program Files\\PowerShell\\7\\pwsh.exe\"'){throw \"unexpected quote: $actual\"}";

      for (const command of ["pwsh", "powershell.exe"]) {
        const result = spawnBounded(command, [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          quoteProbe,
        ]);
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      }
    },
  );

  boundedIt(
    "keeps the behavior PS5.1 native wrapper clean and nonzero diagnostics covered",
    () => {
      const behavior = readFileSync(behaviorHarness, "utf8");

      assert.match(
        behavior,
        /Invoke-BoundedPowerShell -Stage "behavior\.ps51-native-wrapper"[\s\S]*?VEM_VISION_HARNESS_PS51_STDERR[\s\S]*?PS5\.1 native wrapper did not capture stdout[\s\S]*?PS5\.1 native wrapper did not capture its non-terminating stderr marker/,
      );
      assert.match(
        behavior,
        /Invoke-BoundedPowerShell -Stage "behavior\.ps51-native-wrapper-nonzero"[\s\S]*?Write-Output nonzero-stdout[\s\S]*?VEM_VISION_HARNESS_PS51_NONZERO_STDERR[\s\S]*?exit 23[\s\S]*?PS5\.1 native wrapper nonzero invocation did not fail[\s\S]*?"exit code 23", "command=", "nonzero-stdout"/,
      );
      assert.match(
        behavior,
        /PS5\.1 native wrapper nonzero invocation omitted its stderr marker/,
      );
      assert.match(
        behavior,
        /stage=behavior\.ps51-native-wrapper status=process-ownership detail=state=\$status[\s\S]*?stage=behavior\.ps51-native-wrapper status=cleanup-job-dispose-completed/,
      );
    },
  );

  boundedIt(
    "keeps trust roots outside update inputs and uses validated process/job lifecycles",
    () => {
      const installer = readFileSync(
        "scripts/windows/install-vision-release.ps1",
        "utf8",
      );
      const harness = readFileSync(windowsHarness, "utf8");
      const behavior = readFileSync(behaviorHarness, "utf8");
      const result = spawnBounded("node", [
        "-e",
        "const fs=require('fs'); const s=fs.readFileSync('scripts/windows/install-vision-release.ps1','utf8'); const required=['FactoryTrustRoot','FactoryTrustPolicyPath','FactoryEvidenceVerifierPath','Assert-FactoryTrustAcl','process-state','CreateProcessW','CREATE_SUSPENDED','STARTUPINFO','PROCESS_INFORMATION','vision.hello','vision.ready','Get-ExtractedFileManifest','Assert-InstalledRelease','Resolve-ApprovedVisionExecution','Quarantine-UntrustedReleaseDirectory','Get-CanonicalContainedPath','CON|PRN|AUX|NUL']; const forbidden=['[string]$TrustPolicyPath','[string]$EvidenceVerifierPath','FactoryTrustAnchorDigest']; for (const item of required) if (!s.includes(item)) throw new Error('missing '+item); for (const item of forbidden) if (s.includes(item)) throw new Error('mutable trust input '+item);",
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(installer, /\$process -isnot \[Diagnostics\.Process\]/);
      assert.match(installer, /function Stop-VerifiedProcessTree/);
      assert.match(installer, /taskkill\.exe/);
      assert.match(installer, /Stop-VerifiedProcessTree \$process/);
      assert.match(installer, /\$process\.WaitForExit\(5000\)/);
      assert.match(installer, /\$process\.Dispose\(\)/);
      assert.doesNotMatch(installer, /Stop-Process\s+-Id/);
      const launcher = installer.match(
        /\$launcher = @'\r?\n([\s\S]*?)\r?\n'@/,
      )?.[1];
      assert.ok(launcher, "generated Vision launcher is missing");
      assert.match(launcher, /ConvertTo-WindowsCommandLineArgument/);
      assert.match(launcher, /CreateProcessW/);
      assert.match(launcher, /CREATE_SUSPENDED/);
      assert.match(launcher, /CREATE_UNICODE_ENVIRONMENT/);
      assert.match(launcher, /private struct STARTUPINFO/);
      assert.match(launcher, /private struct PROCESS_INFORMATION/);
      assert.match(launcher, /var mutableCommandLine = new StringBuilder/);
      assert.match(launcher, /CreateEnvironmentBlock/);
      assert.match(launcher, /\$recordCommitted\s*=\s*\$false/);
      assert.match(launcher, /VemVisionLauncher\.KillOnCloseJob/);
      assert.match(launcher, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
      assert.match(launcher, /JOBOBJECT_EXTENDED_LIMIT_INFORMATION/);
      assert.match(launcher, /AssignProcessToJobObject/);
      assert.match(
        launcher,
        /\[DllImport\("kernel32\.dll", SetLastError = true\)\]\s+private static extern bool TerminateProcess/,
      );
      assert.match(
        launcher,
        /\[DllImport\("kernel32\.dll", SetLastError = true\)\]\s+private static extern bool TerminateJobObject/,
      );
      assert.doesNotMatch(launcher, /TerminateProcessOverride/);
      assert.doesNotMatch(launcher, /TerminateJobObjectOverride/);
      assert.match(
        launcher,
        /throw new Win32Exception\(error, "TerminateProcess failed"\)/,
      );
      assert.match(launcher, /private const uint WAIT_TIMEOUT = 258;/);
      assert.match(
        launcher,
        /private const uint TERMINATION_CONFIRMATION_TIMEOUT_MS = 5000;/,
      );
      assert.match(
        launcher,
        /WaitForSingleObject\(processHandle, TERMINATION_CONFIRMATION_TIMEOUT_MS\) == WAIT_OBJECT_0/,
      );
      assert.doesNotMatch(launcher, /WaitForSingleObject\(processHandle, 0\)/);
      assert.match(
        launcher,
        /throw new Win32Exception\(Marshal\.GetLastWin32Error\(\), "TerminateJobObject failed"\)/,
      );
      assert.match(launcher, /\$job\.Assign\(\$nativeProcess\.ProcessHandle\)/);
      assert.match(launcher, /\$nativeProcess\.Resume\(\)/);
      assert.match(
        launcher,
        /\[Diagnostics\.Process\]::GetProcessById\(\[int\]\$nativeProcess\.ProcessId\)/,
      );
      assert.match(launcher, /\$job\.Terminate\(\)/);
      assert.match(launcher, /\$job\.Release\(\)/);
      assert.match(launcher, /SetLimitFlags\(0\)/);
      assert.match(launcher, /\[AggregateException\]::new/);
      assert.match(
        launcher,
        /\[Exception\[\]\]@\(\$launchFailure\.Exception, \$cleanupFailure\)/,
      );
      assert.doesNotMatch(launcher, /\$cleanupFailure\.Exception/);
      assert.doesNotMatch(launcher, /ArgumentList/);
      assert.doesNotMatch(launcher, /ProcessStartInfo/);
      assert.doesNotMatch(launcher, /VEM_VISION_LAUNCHER_JOB_ASSIGNED_SIGNAL/);
      assert.doesNotMatch(launcher, /Kill\(\$true\)/);
      assert.doesNotMatch(launcher, /ConvertFrom-Json\s+-Depth/);
      assert.match(
        installer,
        /unsupported legacy creationTimeUtc identity; hard migration requires creationTimeUtcTicks/,
      );
      assert.match(harness, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
      assert.match(harness, /JOBOBJECT_EXTENDED_LIMIT_INFORMATION/);
      assert.match(harness, /public UIntPtr Affinity/);
      assert.match(harness, /AssertNativeLayout\(\)/);
      assert.match(harness, /AssignProcessToJobObject/);
      assert.match(
        harness,
        /public sealed class SuspendedProcess : IDisposable/,
      );
      assert.match(harness, /CreateProcessW/);
      assert.match(harness, /CREATE_SUSPENDED/);
      assert.match(harness, /ResumeThread/);
      assert.match(
        harness,
        /VEM_VISION_HARNESS_FIXTURE_FORCE_RESUME_FAILURE[\s\S]*?ResumeThread fixture failure/,
      );
      assert.match(harness, /TerminateUnresumed/);
      assert.match(harness, /\$job\.Assign\(\$nativeProcess\.ProcessHandle\)/);
      assert.match(harness, /\$nativeProcess\.Resume\(\)/);
      assert.match(harness, /\$nativeProcess\.TerminateUnresumed/);
      assert.match(harness, /stdout\.log/);
      assert.match(harness, /stderr\.log/);
      assert.doesNotMatch(harness, /RedirectStandardOutput\s*=\s*\$true/);
      assert.doesNotMatch(harness, /RedirectStandardError\s*=\s*\$true/);
      assert.match(harness, /\$Job\.Dispose\(\)/);
      assert.match(
        harness,
        /\$jobAssigned = \$CleanupState\.processOwnership -in @\("job-assigned-suspended", "resumed-job-assigned"\)[\s\S]*?\$mustTerminate = \$CleanupState\.exceptionalExit -and \$jobAssigned/,
      );
      assert.match(
        harness,
        /Invoke-HarnessJobCleanup[\s\S]*?\$jobCleanupConfirmed = \$true[\s\S]*?if \(\$null -ne \$nativeProcess -and -not \$nativeCleanupConfirmed\) \{[\s\S]*?if \(\$jobCleanupConfirmed -and \$cleanupState\.processOwnership -in @\("job-assigned-suspended", "resumed-job-assigned"\)\) \{[\s\S]*?\$nativeProcess\.Dispose\(\)[\s\S]*?suspended-process-handle-released.*reason=job-cleanup-confirmed/,
      );
      assert.match(
        harness,
        /\$nativeTargetTerminationConfirmed = \$null -eq \$nativeProcess[\s\S]*?\$authoritativeTargetTerminationConfirmed = \$nativeTargetTerminationConfirmed -or \(\$jobCleanupConfirmed -and \$cleanupState\.processOwnership -in @\("job-assigned-suspended", "resumed-job-assigned"\)\)[\s\S]*?if \(\$authoritativeTargetTerminationConfirmed\) \{[\s\S]*?suspended-process-watchdog-completion-ignored[\s\S]*?\} else \{[\s\S]*?\$cleanupFailures\.Add\(/,
      );
      assert.match(
        harness,
        /\$targetTerminationConfirmationFailures = New-Object 'System\.Collections\.Generic\.List\[System\.Exception\]'[\s\S]*?if \(\$suspendedProcessWatchdog\.terminalCompletion -eq "missing-completion"\) \{[\s\S]*?\$watchdogCompletionFailure = \$_[\s\S]*?\} else \{[\s\S]*?\$cleanupFailures\.Add\(\$_.Exception\)[\s\S]*?Close-HarnessSuspendedProcessWatchdog -Watchdog \$suspendedProcessWatchdog/,
      );
      assert.match(
        behavior,
        /public static class MissingCompletionWatchdog[\s\S]*?String\.Equals\(command, "disarm", StringComparison\.Ordinal\)[\s\S]*?command\.StartsWith\("terminate:", StringComparison\.Ordinal\)[\s\S]*?Int64\.TryParse\(command\.Substring\("terminate:"\.Length\), NumberStyles\.None, CultureInfo\.InvariantCulture, out terminationDeadlineTicks\)[\s\S]*?terminationDeadlineTicks > 0[\s\S]*?terminationDeadlineTicks <= DateTime\.MaxValue\.Ticks[\s\S]*?behavior\.watchdog-missing-completion-native[\s\S]*?authority="native-process-handle"[\s\S]*?behavior\.watchdog-missing-completion-job[\s\S]*?authority="job-object"/,
      );
      assert.match(
        harness,
        /\$job\.Assign\(\$nativeProcess\.ProcessHandle\)[\s\S]*?if \(\[Environment\]::GetEnvironmentVariable\("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", \[EnvironmentVariableTarget\]::Process\) -eq "1"\) \{\s+\[Environment\]::SetEnvironmentVariable\("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", \$null, \[EnvironmentVariableTarget\]::Process\)\s+throw "fixture forced pre-disarm operation failure"\s+\}[\s\S]*?Complete-HarnessSuspendedProcessWatchdog -Watchdog \$suspendedProcessWatchdog -Action "disarm"/,
      );
      assert.match(
        harness,
        /function Start-HarnessSuspendedProcessWatchdog[\s\S]*?\[DateTime\]\$AutomaticConfirmationDeadlineUtc = \[DateTime\]::MinValue[\s\S]*?if \(\$AutomaticConfirmationDeadlineUtc -eq \[DateTime\]::MinValue\) \{ \$AutomaticConfirmationDeadlineUtc = \$DeadlineUtc\.AddMilliseconds\(\$ConfirmationReserveMilliseconds\) \}[\s\S]*?if \(\$AutomaticConfirmationDeadlineUtc -le \$DeadlineUtc\) \{ throw "suspended-process watchdog automatic confirmation deadline must follow its termination deadline" \}[\s\S]*?\$setupHandoffReserveMilliseconds = \[Math\]::Min\(250, \[Math\]::Max\(50, \[int\]\[Math\]::Floor\(\$remainingMilliseconds \/ 4\)\)\)[\s\S]*?\$automaticConfirmationDeadlineUtcTicks = \$AutomaticConfirmationDeadlineUtc\.Ticks[\s\S]*?setupHandoffReserveMilliseconds=\$setupHandoffReserveMilliseconds/,
      );
      assert.match(
        harness,
        /function New-HarnessBoundedPowerShellDeadlinePlan[\s\S]*?\$availableTicks = \$harnessCleanupDeadlineUtc\.Ticks - \$InvokeStartUtc\.Ticks[\s\S]*?\$availableMilliseconds = \[int\]\[Math\]::Floor\(\[double\]\$availableTicks \/ \[TimeSpan\]::TicksPerMillisecond\)[\s\S]*?\$harnessBudgetDeadlineUtc = \$InvokeStartUtc\.AddMilliseconds\(\$availableMilliseconds\)[\s\S]*?\$normalTailMilliseconds = \$requestedExecutionMilliseconds \+ \$confirmationReserveMilliseconds[\s\S]*?\$preTailAvailableMilliseconds = \$availableMilliseconds - \$normalTailMilliseconds[\s\S]*?\$watchdogHandoffEndDeadlineUtc = \$watchdogSetupDeadlineUtc\.AddMilliseconds\(\$watchdogHandoffReserveMilliseconds\)[\s\S]*?\$watchdogDisarmHandoffDeadlineUtc = \$watchdogHandoffEndDeadlineUtc\.AddMilliseconds\(-\$resumeTransitionReserveMilliseconds\)[\s\S]*?\$watchdogAutomaticDeadlineUtc = \$watchdogHandoffEndDeadlineUtc\.AddMilliseconds\(\$automaticTargetReserveMilliseconds\)[\s\S]*?\$normalExecutionLatestStartDeadlineUtc = \$harnessBudgetDeadlineUtc\.AddMilliseconds\(-\$normalTailMilliseconds\)/,
      );
      assert.match(
        harness,
        /Start-HarnessSuspendedProcessWatchdog -StageRoot \$stageRoot -WatchdogPath \$script:HarnessSuspendedProcessWatchdogPath -NativeProcess \$nativeProcess -DeadlineUtc \$watchdogAutomaticDeadlineUtc -SetupDeadlineUtc \$watchdogSetupDeadlineUtc -SetupAcceptanceDeadlineUtc \$setupAcceptanceDeadlineUtc -AutomaticConfirmationDeadlineUtc \$watchdogAutomaticConfirmationDeadlineUtc/,
      );
      assert.match(
        harness,
        /\$invokeStartUtc = \[DateTime\]::UtcNow[\s\S]*?New-HarnessBoundedPowerShellDeadlinePlan -InvokeStartUtc \$invokeStartUtc -HarnessDeadlineUtc \$HarnessDeadlineUtc[\s\S]*?\$setupAcceptanceDeadlineUtc = \$deadlinePlan\.setupAcceptanceDeadlineUtc[\s\S]*?-SetupAcceptanceDeadlineUtc \$setupAcceptanceDeadlineUtc[\s\S]*?\$initialHandoffReserveMilliseconds = \[int\]\$suspendedProcessWatchdog\.setupHandoffReserveMilliseconds[\s\S]*?did not preserve its planned watchdog setup acceptance reserve[\s\S]*?\$handoffDeadlineUtc = \$watchdogDisarmHandoffDeadlineUtc[\s\S]*?Complete-HarnessSuspendedProcessWatchdog -Watchdog \$suspendedProcessWatchdog -Action "disarm" -DeadlineUtc \$handoffDeadlineUtc[\s\S]*?if \(\[DateTime\]::UtcNow -ge \$normalExecutionLatestStartDeadlineUtc\) \{[\s\S]*?\$nativeProcess\.Resume\(\)[\s\S]*?\$executionDeadlineUtc = \$executionStartUtc\.AddMilliseconds\(\$requestedExecutionMilliseconds\)[\s\S]*?\$requestedCleanupDeadlineUtc = \$executionDeadlineUtc\.AddMilliseconds\(\$confirmationReserveMilliseconds\)[\s\S]*?if \(\$requestedCleanupDeadlineUtc -gt \$harnessBudgetDeadlineUtc\) \{[\s\S]*?requested execution timeout and Job cleanup reserve/,
      );
      assert.match(
        behavior,
        /public static class DelayedDisarmWatchdog[\s\S]*?DISARM_CONFIRMATION_DELAY_MILLISECONDS = 100[\s\S]*?Write\(args\[2\], "armed"\)[\s\S]*?IsDisarmCommand\(args\[1\]\)[\s\S]*?Thread\.Sleep\(DISARM_CONFIRMATION_DELAY_MILLISECONDS\)[\s\S]*?Write\(args\[3\], "disarmed"\)[\s\S]*?\$delayedDisarmStage = "b\.dh"[\s\S]*?TimeoutSeconds 2[\s\S]*?HarnessDeadlineUtc \(\[DateTime\]::UtcNow\.AddSeconds\(4\)\)[\s\S]*?suspended-process-watchdog-disarmed[\s\S]*?completion=disarmed[\s\S]*?state=resumed-job-assigned/,
      );
      assert.match(
        harness,
        /if \(\$Action -eq "disarm" -and \[Environment\]::GetEnvironmentVariable\("VEM_VISION_HARNESS_FIXTURE_FORCE_WATCHDOG_DISARM_COMMAND_WRITE_FAILURE", \[EnvironmentVariableTarget\]::Process\) -eq "1"\) \{\s+\[Environment\]::SetEnvironmentVariable\("VEM_VISION_HARNESS_FIXTURE_FORCE_WATCHDOG_DISARM_COMMAND_WRITE_FAILURE", \$null, \[EnvironmentVariableTarget\]::Process\)\s+throw \[InvalidOperationException\]::new\("fixture forced watchdog disarm command write failure"\)\s+\}\s+\$completion = Get-HarnessSuspendedProcessWatchdogCompletion -Watchdog \$Watchdog[\s\S]*?Write-HarnessWatchdogCommand \$Watchdog\.commandPath \$command/,
      );
      assert.match(
        behavior,
        /VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE[\s\S]*?VEM_VISION_HARNESS_FIXTURE_FORCE_WATCHDOG_DISARM_COMMAND_WRITE_FAILURE[\s\S]*?"1"[\s\S]*?b\.wf[\s\S]*?fixture forced pre-disarm operation failure[\s\S]*?fixture forced watchdog disarm command write failure[\s\S]*?suspended-process-termination-confirmed[\s\S]*?suspended-process-watchdog-closed[\s\S]*?SetEnvironmentVariable\("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", \$previousPreDisarmOperationFailure[\s\S]*?SetEnvironmentVariable\("VEM_VISION_HARNESS_FIXTURE_FORCE_WATCHDOG_DISARM_COMMAND_WRITE_FAILURE", \$previousWatchdogDisarmCommandWriteFailure/,
      );
      assert.doesNotMatch(
        harness,
        /Wait-HarnessFixtureWatchdogCommandBlock|VEM_VISION_HARNESS_FIXTURE_WATCHDOG_(ARMED_SIGNAL_PATH|COMMAND_BLOCKED_SIGNAL_PATH|COMMAND_BLOCK_DEADLINE_PATH)/,
      );
      assert.doesNotMatch(
        behavior,
        /BlockingCommandWatchdog|VEM_VISION_HARNESS_FIXTURE_WATCHDOG_(ARMED_SIGNAL_PATH|COMMAND_BLOCKED_SIGNAL_PATH|COMMAND_BLOCK_DEADLINE_PATH|COMMAND_BLOCK_EXIT_PATH)/,
      );
      assert.doesNotMatch(
        behavior,
        /behavior\.(watchdog-write-failure|watchdog-unconfirmed|primary-job-unavailable|watchdog-disarm-handoff|watchdog-setup-timeout)/,
      );
      assert.match(
        behavior,
        /\$root = Join-Path \(\[IO\.Path\]::GetTempPath\(\)\) \("vh-" \+ \[guid\]::NewGuid\(\)\.ToString\("N"\)\)/,
      );
      assert.match(
        behavior,
        /\[ValidateRange\(30, 120\)\]\[int\]\$DeadlineSeconds = 120,[\s\S]*?\[ValidateRange\(60, 180\)\]\[int\]\$HardDeadlineSeconds = 180,[\s\S]*?if \(\$HardDeadlineSeconds -le \$DeadlineSeconds\) \{ throw "HardDeadlineSeconds must leave time for cleanup after DeadlineSeconds" \}/,
      );
      assert.doesNotMatch(behavior, /vem-vision-harness-behavior/);
      assert.doesNotMatch(
        behavior,
        /SetupTimeoutWatchdog|b\.st|Assert-HarnessWatchdogStagePathBudget|ready\.(deadline|confirm)|setup-timeout-watchdog/,
      );
      assert.match(
        behavior,
        /\$previousUnconfirmedPreDisarmOperationFailure = \[Environment\]::GetEnvironmentVariable\("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", \[EnvironmentVariableTarget\]::Process\)[\s\S]*?SetEnvironmentVariable\("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", "1", \[EnvironmentVariableTarget\]::Process\)[\s\S]*?\$unconfirmedStage = "b\.wu"[\s\S]*?HarnessDeadlineUtc \(\[DateTime\]::UtcNow\.AddSeconds\(12\)\)[\s\S]*?fixture forced pre-disarm operation failure[\s\S]*?could not terminate process \[0-9\]\+: missing-completion[\s\S]*?stage=\$unconfirmedStage status=suspended-process-watchdog-armed detail=processId=\[0-9\]\+ identity=original-process-handle[\s\S]*?stage=\$unconfirmedStage status=process-ownership detail=state=job-assigned-suspended processId=\[0-9\]\+[\s\S]*?SetEnvironmentVariable\("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", \$null, \[EnvironmentVariableTarget\]::Process\)[\s\S]*?\$primaryFailureStage = "b\.pj"[\s\S]*?\$primaryFailureRecords = New-Object 'System\.Collections\.Generic\.List\[object\]'[\s\S]*?Invoke-BoundedPowerShell -Stage \$primaryFailureStage[\s\S]*?\$primaryFailure\.InnerExceptions\[0\]\.Message -match "failed with exit code 23"[\s\S]*?status=process-ownership detail=state=resumed-job-assigned processId=\[0-9\]\+[\s\S]*?status=failed detail=exitCode=23[\s\S]*?SetEnvironmentVariable\("VEM_VISION_HARNESS_FIXTURE_FORCE_PRE_DISARM_OPERATION_FAILURE", \$previousUnconfirmedPreDisarmOperationFailure/,
      );
      assert.match(
        behavior,
        /\$scenarioTerminateUnresumedFailure = \$null\s+if \(\$scenario\.forceTerminateFailure\) \{\s+\$scenarioTerminateUnresumedFailure = "1"\s+\}\s+\[Environment\]::SetEnvironmentVariable\("VEM_VISION_HARNESS_FIXTURE_FORCE_TERMINATE_UNRESUMED_FAILURE", \$scenarioTerminateUnresumedFailure, \[EnvironmentVariableTarget\]::Process\)/,
      );
      assert.doesNotMatch(
        behavior,
        /SetEnvironmentVariable\([^\r\n]*\(if\s*\(/,
      );
    },
  );

  boundedIt(
    "wires the direct Windows behavior harness before the full harness",
    () => {
      const workflow = readFileSync(ciWorkflow, "utf8");
      const visionJob = workflow.match(
        /windows-vision-release-installer:([\s\S]*?)(?=\n  [a-z0-9-]+:|$)/,
      )?.[1];

      assert.ok(visionJob, "Windows Vision installer job is missing");
      assert.match(visionJob, /runs-on: windows-2022/);
      assert.match(visionJob, /timeout-minutes: 15/);
      assert.match(
        visionJob,
        /timeout-minutes: 3[\s\S]*vision-release-install-harness\.behavior\.ps1/,
      );
      assert.ok(
        visionJob.indexOf("vision-release-install-harness.behavior.ps1") <
          visionJob.indexOf("vision-release-install.windows-harness.ps1"),
        "the direct behavior harness must run before the full Windows harness",
      );
      assert.match(visionJob, /-CorePowerShellPaths pwsh,powershell\.exe/);
    },
  );

  boundedIt(
    "keeps core behavior cleanup coverage without the fault-injection matrix",
    () => {
      const behavior = readFileSync(behaviorHarness, "utf8");
      const harness = readFileSync(windowsHarness, "utf8");
      assert.doesNotMatch(
        behavior,
        /foreach \(\$fault in @\(|behavior\.(create-job-failure|set-job-limit-failure|assign-job-failure|assign-and-suspended-terminate-failure|resume-and-suspended-terminate-failure|terminate-job-failure|active-process-count-failure)/,
      );
      assert.doesNotMatch(behavior, /Write-FaultTelemetryRecordToHost/);
      assert.doesNotMatch(behavior, /\$readyStopwatch|TimeoutSeconds 3/);
      assert.match(
        behavior,
        /function Wait-ForSignal\(\[string\]\$Path, \[DateTime\]\$DeadlineUtc, \[string\]\$FailureMessage\)/,
      );
      assert.match(
        behavior,
        /\$runDeadlineUtc = \[DateTime\]::new\(\[Int64\]\$RunDeadlineUtcTicks, \[DateTimeKind\]::Utc\)/,
      );
      assert.match(
        behavior,
        /hard watchdog host did not receive its run signal before the behavior deadline/,
      );
      assert.match(
        behavior,
        /\[VemVisionHarness\.SuspendedProcess\]::Create\(\$PowerShellPath, \$arguments, \$HarnessRoot\)/,
      );
      assert.match(
        behavior,
        /Start-HarnessSuspendedProcessWatchdog -StageRoot \(Join-Path \$HarnessRoot "hard-watchdog-host-lifetime"\)/,
      );
      assert.match(
        behavior,
        /function Stop-HardWatchdogHost[\s\S]*?Complete-HarnessSuspendedProcessWatchdog -Watchdog \$watchdog -Action "terminate" -DeadlineUtc \$DeadlineUtc/,
      );
      assert.match(
        harness,
        /DuplicateHandle\(GetCurrentProcess\(\), processHandle, GetCurrentProcess\(\), out inheritedHandle, 0, true, DUPLICATE_SAME_ACCESS\)/,
      );
      assert.match(
        behavior,
        /Wait-ForSignal -Path \$hardWatchdogHost\.deadlineWatchdog\.completionPath -DeadlineUtc \(\[DateTime\]::UtcNow\.AddSeconds\(6\)\)[\s\S]*?\$hardWatchdogCompletion = \(Get-Content -LiteralPath \$hardWatchdogHost\.deadlineWatchdog\.completionPath -Raw\)\.Trim\(\)[\s\S]*?Assert-True \(\$hardWatchdogCompletion -in @\("terminated", "exited"\)\)[\s\S]*?Assert-True \(\$hardWatchdogHost\.process\.WaitForExit\(\[uint32\]0\)\)[\s\S]*?Write-HarnessStage "behavior\.hard-watchdog" "host-termination-confirmed" "completion=\$hardWatchdogCompletion identity=original-process-handle"/,
      );
      assert.doesNotMatch(behavior, /\$hardWatchdogHost\.WaitForExit\(/);
      assert.doesNotMatch(behavior, /\$hardWatchdogHost\.HasExited/);
      assert.match(
        behavior,
        /stage=behavior\.parent-exits-near-timeout status=timed-out[\s\S]*?status=termination-requested[\s\S]*?status=termination-confirmed[\s\S]*?timed-out bounded invocation left its descendant alive/,
      );
      const normalParentExitFixture = behavior.match(
        /Invoke-BoundedPowerShell -Stage "behavior\.normal-parent-exit-active-descendant"[\s\S]*?-ScriptBody @'([\s\S]*?)'@/,
      )?.[1];
      assert.ok(
        normalParentExitFixture,
        "normal-parent-exit descendant fixture is missing",
      );
      assert.match(
        normalParentExitFixture,
        /Start-Process -FilePath \$env:COMSPEC[\s\S]*?-RedirectStandardOutput \$descendantStdoutPath[\s\S]*?-RedirectStandardError \$descendantStderrPath[\s\S]*?-WindowStyle Hidden/,
      );
      assert.doesNotMatch(normalParentExitFixture, /-NoNewWindow/);
      assert.match(
        behavior,
        /stage=behavior\.normal-parent-exit-active-descendant status=completed[\s\S]*?stage=behavior\.normal-parent-exit-active-descendant status=cleanup-confirmation-waiting[\s\S]*?stage=behavior\.normal-parent-exit-active-descendant status=termination-confirmed/,
      );
      for (const fixtureName of ["SlowWatchdog"]) {
        const fixtureSource = behavior.match(
          new RegExp(
            `public static class ${fixtureName} \\{([\\s\\S]*?)\\r?\\n\\}`,
            "",
          ),
        )?.[1];
        assert.ok(fixtureSource, `${fixtureName} source is missing`);
        assert.match(
          fixtureSource,
          /new UTF8Encoding\(false\)\.GetBytes\(value\)[\s\S]*?new FileStream\(path, FileMode\.CreateNew, FileAccess\.Write, FileShare\.Read\)[\s\S]*?stream\.Write\(bytes, 0, bytes\.Length\);[\s\S]*?stream\.Flush\(true\);/,
        );
        assert.doesNotMatch(
          fixtureSource,
          /temporaryPath|File\.Move|Guid\.NewGuid/,
        );
      }
      const inheritedWatchdog = harness.match(
        /public static class SuspendedProcessWatchdog \{([\s\S]*?)\r?\n  \}\r?\n}\r?\n'@/,
      )?.[1];
      assert.ok(
        inheritedWatchdog,
        "inherited-handle watchdog source is missing",
      );
      assert.match(
        harness,
        /public sealed class RetainedWatchdogProcess : IDisposable \{[\s\S]*?public bool WaitForExit\(uint waitMilliseconds\)[\s\S]*?public bool HasExited[\s\S]*?public int ExitCode[\s\S]*?public void Dispose\(\)/,
      );
      assert.match(
        harness,
        /public RetainedWatchdogProcess StartInheritedHandleWatchdog\([\s\S]*?return new RetainedWatchdogProcess\(processInformation\.hProcess, processInformation\.dwProcessId\);/,
      );
      assert.doesNotMatch(inheritedWatchdog, /OpenProcess/);
      assert.doesNotMatch(inheritedWatchdog, /GetProcessById/);
      assert.match(
        inheritedWatchdog,
        /new FileStream\(path, FileMode\.CreateNew, FileAccess\.Write, FileShare\.Read\)[\s\S]*?stream\.Write\(bytes, 0, bytes\.Length\);[\s\S]*?stream\.Flush\(true\);/,
      );
      assert.doesNotMatch(
        inheritedWatchdog,
        /MoveFileExW|MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH|File\.Move\(temporaryPath, path\)|temporaryPath/,
      );
    },
  );

  boundedIt(
    "cleans up a pre-run hard-watchdog host through its inherited handle on Windows",
    { skip: process.platform !== "win32" },
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts\\windows\\vision-release-install-harness.behavior.ps1") -HarnessPath (Join-Path (Get-Location) "scripts\\windows\\vision-release-install.windows-harness.ps1") -Library
. (Join-Path (Get-Location) "scripts\\windows\\vision-release-install.windows-harness.ps1") -Library
Initialize-HarnessNativeTypes
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-inherited-watchdog-early-cleanup-" + [guid]::NewGuid().ToString("N"))
$hostProcess = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $script:HarnessSuspendedProcessWatchdogPath = Initialize-HarnessSuspendedProcessWatchdog -HarnessRoot $root
  $powerShellPath = Get-Command pwsh -CommandType Application | Select-Object -First 1 -ExpandProperty Source
  $hostPath = Join-Path $root "host.ps1"
  $hostScript = @'
param($HarnessPath, $HarnessRoot, $HarnessContextPath, $ChildPowerShellPath, $IdentityPath, $ReadySignalPath, $RunSignalPath, $RunDeadlineUtcTicks, $FaultSignalPath, $TelemetryPath, $ObservedChildPowerShellPath)
Start-Sleep -Seconds 30
'@
  [IO.File]::WriteAllText($hostPath, $hostScript, [Text.UTF8Encoding]::new($false))
  $hostProcess = Start-HardWatchdogHost -PowerShellPath $powerShellPath -HostPath $hostPath -HarnessPath $hostPath -HarnessRoot $root -HarnessContextPath (Join-Path $root "context.json") -ChildPowerShellPath $powerShellPath -IdentityPath (Join-Path $root "identity.json") -ReadySignalPath (Join-Path $root "ready") -RunSignalPath (Join-Path $root "run") -RunDeadlineUtcTicks ([DateTime]::UtcNow.AddSeconds(20).Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)) -FaultSignalPath (Join-Path $root "fault") -TelemetryPath (Join-Path $root "telemetry") -ObservedChildPowerShellPath (Join-Path $root "observed") -LifetimeDeadlineUtc ([DateTime]::UtcNow.AddSeconds(10))
  Stop-HardWatchdogHost -HostProcess $hostProcess -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(4))
  if ((Get-Content -LiteralPath $hostProcess.lifetimeWatchdog.completionPath -Raw).Trim() -notin @("terminated", "exited")) { throw "pre-run hard-watchdog cleanup did not confirm inherited-handle termination" }
  $hostProcess = $null
} finally {
  if ($null -ne $hostProcess) { Stop-HardWatchdogHost -HostProcess $hostProcess -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(4)) }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "confirms an automatic inherited-handle deadline termination on Windows",
    { skip: process.platform !== "win32" },
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts\\windows\\vision-release-install.windows-harness.ps1") -Library
Initialize-HarnessNativeTypes
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-inherited-watchdog-deadline-" + [guid]::NewGuid().ToString("N"))
$nativeProcess = $null
$watchdog = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $watchdogPath = Initialize-HarnessSuspendedProcessWatchdog -HarnessRoot $root
  $powerShellPath = Get-Command pwsh -CommandType Application | Select-Object -First 1 -ExpandProperty Source
  $nativeProcess = [VemVisionHarness.SuspendedProcess]::Create($powerShellPath, [string[]]@("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"), $root)
  Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "deadline") -WatchdogPath $watchdogPath -NativeProcess $nativeProcess -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(1)) -Watchdog ([ref]$watchdog) | Out-Null
  $nativeProcess.Resume()
  $completionDeadlineUtc = [DateTime]::UtcNow.AddSeconds(4)
  while (-not (Test-Path -LiteralPath $watchdog.completionPath -PathType Leaf) -and [DateTime]::UtcNow -lt $completionDeadlineUtc) { Start-Sleep -Milliseconds 10 }
  if (-not (Test-Path -LiteralPath $watchdog.completionPath -PathType Leaf)) { throw "automatic watchdog deadline did not write a completion state" }
  if ((Get-Content -LiteralPath $watchdog.completionPath -Raw).Trim() -notin @("terminated", "exited")) { throw "automatic watchdog did not confirm termination" }
  if (-not $nativeProcess.WaitForExit(1000)) { throw "automatic watchdog left its host process running" }
  Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2)) | Out-Null
  $watchdog = $null
} finally {
  if ($null -ne $watchdog) { Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2)) | Out-Null }
  if ($null -ne $nativeProcess) { $nativeProcess.Dispose() }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "stops an automatically completed hard-watchdog host without waiting for its cleanup deadline on Windows",
    { skip: process.platform !== "win32" },
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts\\windows\\vision-release-install-harness.behavior.ps1") -HarnessPath (Join-Path (Get-Location) "scripts\\windows\\vision-release-install.windows-harness.ps1") -Library
. (Join-Path (Get-Location) "scripts\\windows\\vision-release-install.windows-harness.ps1") -Library
Initialize-HarnessNativeTypes
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-completed-hard-watchdog-stop-" + [guid]::NewGuid().ToString("N"))
$hostProcess = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $script:HarnessSuspendedProcessWatchdogPath = Initialize-HarnessSuspendedProcessWatchdog -HarnessRoot $root
  $powerShellPath = Get-Command pwsh -CommandType Application | Select-Object -First 1 -ExpandProperty Source
  $hostPath = Join-Path $root "host.ps1"
  $hostScript = @'
param($HarnessPath, $HarnessRoot, $HarnessContextPath, $ChildPowerShellPath, $IdentityPath, $ReadySignalPath, $RunSignalPath, $RunDeadlineUtcTicks, $FaultSignalPath, $TelemetryPath, $ObservedChildPowerShellPath)
Start-Sleep -Seconds 30
'@
  [IO.File]::WriteAllText($hostPath, $hostScript, [Text.UTF8Encoding]::new($false))
  $hostProcess = Start-HardWatchdogHost -PowerShellPath $powerShellPath -HostPath $hostPath -HarnessPath $hostPath -HarnessRoot $root -HarnessContextPath (Join-Path $root "context.json") -ChildPowerShellPath $powerShellPath -IdentityPath (Join-Path $root "identity.json") -ReadySignalPath (Join-Path $root "ready") -RunSignalPath (Join-Path $root "run") -RunDeadlineUtcTicks ([DateTime]::UtcNow.AddSeconds(20).Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)) -FaultSignalPath (Join-Path $root "fault") -TelemetryPath (Join-Path $root "telemetry") -ObservedChildPowerShellPath (Join-Path $root "observed") -LifetimeDeadlineUtc ([DateTime]::UtcNow.AddSeconds(10))
  $deadlineWatchdog = $null
  try {
    Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "deadline") -WatchdogPath $script:HarnessSuspendedProcessWatchdogPath -NativeProcess $hostProcess.process -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(1)) -Watchdog ([ref]$deadlineWatchdog) | Out-Null
  } finally {
    $hostProcess.deadlineWatchdog = $deadlineWatchdog
  }
  Complete-HarnessSuspendedProcessWatchdog -Watchdog $hostProcess.lifetimeWatchdog -Action "disarm" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2)) | Out-Null
  $hostProcess.lifetimeWatchdog = $null
  $completionDeadlineUtc = [DateTime]::UtcNow.AddSeconds(4)
  while (-not (Test-Path -LiteralPath $hostProcess.deadlineWatchdog.completionPath -PathType Leaf) -and [DateTime]::UtcNow -lt $completionDeadlineUtc) { Start-Sleep -Milliseconds 10 }
  if (-not (Test-Path -LiteralPath $hostProcess.deadlineWatchdog.completionPath -PathType Leaf)) { throw "automatic hard-watchdog deadline did not write a completion state" }
  if ((Get-Content -LiteralPath $hostProcess.deadlineWatchdog.completionPath -Raw).Trim() -notin @("terminated", "exited")) { throw "automatic hard-watchdog did not confirm host termination" }
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  Stop-HardWatchdogHost -HostProcess $hostProcess -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(4))
  $stopwatch.Stop()
  if ($stopwatch.ElapsedMilliseconds -ge 1000) { throw "Stop-HardWatchdogHost waited $($stopwatch.ElapsedMilliseconds)ms after automatic watchdog completion" }
  if (-not $hostProcess.deadlineWatchdog.completed) { throw "automatic hard-watchdog completion was not consumed during host cleanup" }
  $hostProcess = $null
} finally {
  if ($null -ne $hostProcess) { Stop-HardWatchdogHost -HostProcess $hostProcess -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(4)) }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "passes complete Factory release inputs to every signed-install shell",
    () => {
      const harness = readFileSync(windowsHarness, "utf8");
      const signedInstall = harness.match(
        /Invoke-BoundedPowerShell -Stage "fixture\.signed-install\.\$corePowerShellName"[\s\S]*?-ScriptBody @'\r?\n([\s\S]*?)\r?\n'@ \| Out-Null/,
      )?.[1];

      assert.ok(signedInstall, "signed-install shell body is missing");
      assert.match(
        signedInstall,
        /\$factoryDelivery = Join-Path \$context\.factoryRoot "vision-release"/,
      );
      for (const [parameter, file] of [
        ["BundlePath", "bundle.bin"],
        ["DescriptorPath", "descriptor.json"],
        ["AttestationPath", "attestation.json"],
        ["SbomPath", "sbom.json"],
        ["ProvenancePath", "provenance.json"],
        ["ConformanceEvidencePath", "conformance.json"],
        ["ApprovalPath", "approval.json"],
        ["FactoryManifestPath", "factory-manifest.json"],
      ]) {
        assert.match(
          signedInstall,
          new RegExp(
            `-${parameter} \\(Join-Path \\$factoryDelivery "${file}"\\)`,
          ),
        );
      }
      assert.match(
        signedInstall,
        /-ConfigurationPath \(Join-Path \$context\.stateRoot "config\\fixture\.json"\) -EvidencePath \$context\.evidencePath -TaskUser \$env:USERNAME/,
      );
      assert.doesNotMatch(
        signedInstall,
        /install-vision-release\.ps1" -ConfigurationPath/,
      );
    },
  );

  boundedIt(
    "reserves termination confirmation from a single remaining deadline budget",
    () => {
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-Command",
        ". ./scripts/windows/vision-release-install.windows-harness.ps1 -Library; if((Get-HarnessTerminationConfirmationReserveMilliseconds -TotalMilliseconds 4000) -ne 1000){throw 'four-second reserve'}; if((Get-HarnessTerminationConfirmationReserveMilliseconds -TotalMilliseconds 8000) -ne 2000){throw 'eight-second reserve'}; $deadline=[DateTime]::UtcNow.AddMilliseconds(20); Start-Sleep -Milliseconds 40; if((Get-HarnessRemainingMilliseconds -DeadlineUtc $deadline) -ne 0){throw 'expired deadline still has budget'}",
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "derives a three-second watchdog budget from one absolute invocation anchor",
    () => {
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-Command",
        ". ./scripts/windows/vision-release-install.windows-harness.ps1 -Library; $anchor=[DateTime]::UtcNow; $harnessDeadlineUtc=$anchor.AddMilliseconds(3000); $plan=New-HarnessBoundedPowerShellDeadlinePlan -InvokeStartUtc $anchor -HarnessDeadlineUtc $harnessDeadlineUtc -CleanupReserveSeconds 0 -TimeoutSeconds 1; if($plan.availableMilliseconds -ne 3000){throw 'three-second available budget'}; if($plan.confirmationReserveMilliseconds -ne 1000){throw 'three-second Job reserve'}; if($plan.requestedExecutionMilliseconds -ne 1000){throw 'three-second execution reserve'}; if($plan.watchdogHandoffReserveMilliseconds -ne 250){throw 'three-second handoff reserve'}; if($plan.automaticConfirmationReserveMilliseconds -ne 250){throw 'three-second automatic confirmation reserve'}; if($plan.watchdogSetupBudgetMilliseconds -ne 750){throw 'three-second setup reserve'}; if($plan.watchdogDisarmHandoffDeadlineUtc -ge $plan.normalExecutionLatestStartDeadlineUtc){throw 'handoff did not leave resume transition reserve'}; if($plan.normalExecutionLatestStartDeadlineUtc.AddMilliseconds($plan.requestedExecutionMilliseconds + $plan.confirmationReserveMilliseconds) -gt $harnessDeadlineUtc){throw 'three-second normal tail exceeds harness deadline'}",
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "keeps latest legal handoff inside the true harness deadline after sampling overhead",
    () => {
      const probe = String.raw`
. ./scripts/windows/vision-release-install.windows-harness.ps1 -Library

function Assert-Plan([int]$HarnessMilliseconds, [int]$SamplingOffsetMilliseconds, [int]$CleanupReserveSeconds, [int]$TimeoutSeconds, [int]$ExpectedJobReserveMilliseconds) {
  $harnessDeadlineUtc = [DateTime]::UtcNow.AddMilliseconds($HarnessMilliseconds)
  $invokeStartUtc = $harnessDeadlineUtc.AddMilliseconds(-($HarnessMilliseconds - $SamplingOffsetMilliseconds))
  $plan = New-HarnessBoundedPowerShellDeadlinePlan -InvokeStartUtc $invokeStartUtc -HarnessDeadlineUtc $harnessDeadlineUtc -CleanupReserveSeconds $CleanupReserveSeconds -TimeoutSeconds $TimeoutSeconds

  if ($plan.confirmationReserveMilliseconds -ne $ExpectedJobReserveMilliseconds) { throw "unexpected Job reserve: $($plan.confirmationReserveMilliseconds)" }
  if ($plan.watchdogSetupBudgetMilliseconds -le 0 -or $plan.setupAcceptanceReserveMilliseconds -lt 50) { throw "setup budget was not viable" }
  if (-not ($plan.setupAcceptanceDeadlineUtc -lt $plan.watchdogDisarmHandoffDeadlineUtc -and $plan.watchdogDisarmHandoffDeadlineUtc -lt $plan.watchdogAutomaticDeadlineUtc -and $plan.watchdogAutomaticDeadlineUtc -lt $plan.watchdogAutomaticConfirmationDeadlineUtc -and $plan.watchdogAutomaticConfirmationDeadlineUtc -le $harnessDeadlineUtc)) { throw "watchdog deadline order was invalid" }
  if ($plan.watchdogDisarmHandoffDeadlineUtc -ge $plan.normalExecutionLatestStartDeadlineUtc) { throw "latest legal disarm did not leave the resume transition reserve" }
  $latestCleanupDeadlineUtc = $plan.normalExecutionLatestStartDeadlineUtc.AddMilliseconds($plan.requestedExecutionMilliseconds + $plan.confirmationReserveMilliseconds)
  if ($latestCleanupDeadlineUtc -gt $harnessDeadlineUtc) { throw "latest legal handoff shortened normal execution" }
  return $plan
}

$short = Assert-Plan -HarnessMilliseconds 3000 -SamplingOffsetMilliseconds 137 -CleanupReserveSeconds 0 -TimeoutSeconds 1 -ExpectedJobReserveMilliseconds 1000
if ($short.availableMilliseconds -ne 2863 -or $short.requestedExecutionMilliseconds -ne 1000) { throw "short branch sampling offset changed" }
$long = Assert-Plan -HarnessMilliseconds 12000 -SamplingOffsetMilliseconds 731 -CleanupReserveSeconds 1 -TimeoutSeconds 6 -ExpectedJobReserveMilliseconds 2000
if ($long.availableMilliseconds -ne 10269 -or $long.requestedExecutionMilliseconds -ne 6000) { throw "long branch sampling offset changed" }
`;
      const result = spawnBounded("pwsh", ["-NoProfile", "-Command", probe]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "allows a bounded 60-second watchdog cold setup window before child execution",
    () => {
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '. ./scripts/windows/vision-release-install.windows-harness.ps1 -Library; $budget=Get-HarnessWatchdogSetupBudgetMilliseconds -AvailableMilliseconds 75000; if($budget -ne 60000){throw "expected 60000ms bounded watchdog setup budget, got $budget"}',
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "keeps watchdog preflight bounded across synchronous process operations",
    () => {
      const harness = readFileSync(windowsHarness, "utf8");
      const preflight = harness.match(
        /function Invoke-HarnessSuspendedProcessWatchdogPreflight \{([\s\S]*?)\r?\n\}\r?\nfunction Start-HarnessSuspendedProcessWatchdog/,
      )?.[1];

      assert.ok(preflight, "watchdog preflight helper is missing");
      assert.match(
        preflight,
        /\$preflightFailFastWatchdog = Arm-HarnessFailFastWatchdog -Message "suspended-process watchdog preflight exceeded its hard deadline" -DeadlineUtc \$DeadlineUtc/,
      );
      assert.match(preflight, /\$operationFailure = \$null/);
      assert.match(
        preflight,
        /\$cleanupFailures = New-Object 'System\.Collections\.Generic\.List\[System\.Exception\]'/,
      );
      assert.match(
        preflight,
        /\[AggregateException\]::new\("suspended-process watchdog preflight failed and cleanup failed", \$failures\)/,
      );
      assert.match(
        preflight,
        /finally \{\s+\$preflightFailFastWatchdog\.Dispose\(\)\s+\}/,
      );
      assert.doesNotMatch(preflight, /\bTask\b/);
    },
  );

  boundedIt(
    "overwrites an existing watchdog command signal with Windows PowerShell 5.1",
    { skip: process.platform !== "win32" },
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-atomic-replace-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $path = Join-Path $root "command"
  [IO.File]::WriteAllText($path, "old", [Text.UTF8Encoding]::new($false))
  Write-HarnessWatchdogCommand -Path $path -Command "new" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2))
  if ((Get-Content -LiteralPath $path -Raw -Encoding UTF8) -cne ("new" + [char]10)) { throw "command write did not publish its complete LF-terminated frame" }
  if (@(Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -like ".command.*.tmp" }).Count -ne 0) { throw "command write left a temporary file" }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "keeps watchdog ready and completion signals create-once with Windows PowerShell 5.1",
    { skip: process.platform !== "win32" },
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-create-once-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  foreach ($signalName in @("ready", "completion")) {
    $destinationPath = Join-Path $root $signalName
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes("armed")
    $stream = [IO.FileStream]::new($destinationPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    $createFailure = $null
    try { [IO.FileStream]::new($destinationPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read).Dispose() } catch [IO.IOException] { $createFailure = $_.Exception }
    if ($null -eq $createFailure) { throw "create-once $signalName watchdog signal unexpectedly replaced its destination" }
    if ((Get-Content -LiteralPath $destinationPath -Raw -Encoding UTF8) -cne "armed") { throw "create-once $signalName watchdog signal modified its destination" }
  }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "publishes complete watchdog commands after partial reads and keeps the latest terminate deadline",
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-command-protocol-" + [guid]::NewGuid().ToString("N"))
$partialStream = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $commandPath = Join-Path $root "command"
  $partialStream = [IO.FileStream]::new($commandPath, [IO.FileMode]::Create, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  $partialBytes = [Text.UTF8Encoding]::new($false).GetBytes("dis")
  $partialStream.Write($partialBytes, 0, $partialBytes.Length)
  $partialStream.Flush($true)
  $partial = $null
  try { $partial = [IO.File]::ReadAllText($commandPath, [Text.UTF8Encoding]::new($false)).Trim() } catch [IO.IOException] { }
  if ($partial -eq "disarm" -or $partial -match "^terminate:[0-9]+$") { throw "partial watchdog command was consumable: $partial" }
  $partialStream.Dispose()
  $partialStream = $null

  Write-HarnessWatchdogCommand -Path $commandPath -Command "disarm" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2))
  if ([IO.File]::ReadAllText($commandPath, [Text.UTF8Encoding]::new($false)) -cne ("disarm" + [char]10)) { throw "complete disarm command frame was not published" }

  $firstDeadlineUtc = [DateTime]::UtcNow.AddSeconds(2)
  $secondDeadlineUtc = $firstDeadlineUtc.AddSeconds(2)
  Write-HarnessWatchdogCommand -Path $commandPath -Command ("terminate:" + $firstDeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)) -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2))
  Write-HarnessWatchdogCommand -Path $commandPath -Command ("terminate:" + $secondDeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)) -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2))
  $latest = [IO.File]::ReadAllText($commandPath, [Text.UTF8Encoding]::new($false))
  if ($latest -cne (("terminate:" + $secondDeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)) + [char]10)) { throw "latest terminate deadline frame was not retained: $latest" }
  if (@(Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -like ".command.*.tmp" }).Count -ne 0) { throw "watchdog command writer left a rename temporary file" }
} finally {
  if ($null -ne $partialStream) { $partialStream.Dispose() }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt("keeps watchdog helper output contracts explicit", () => {
    const harness = readFileSync(windowsHarness, "utf8");
    assert.match(
      harness,
      /state=job-assigned-suspended[\s\S]*?Complete-HarnessSuspendedProcessWatchdog -Watchdog \$suspendedProcessWatchdog -Action "disarm"[\s\S]*?suspended-process-watchdog-disarmed[\s\S]*?\$nativeProcess\.Resume\(\)[\s\S]*?state=resumed-job-assigned/,
    );
    assert.match(
      harness,
      /\$job\.Assign\(\$nativeProcess\.ProcessHandle\)[\s\S]*?Complete-HarnessSuspendedProcessWatchdog -Watchdog \$suspendedProcessWatchdog -Action "disarm"[\s\S]*?\$nativeProcess\.Resume\(\)/,
    );

    assert.match(
      harness,
      /function Start-HarnessSuspendedProcessWatchdog[\s\S]*?\[void\]\(\$WatchdogReference\.Value = \$watchdog\)[\s\S]*?return/,
    );
    const startFunction = harness.match(
      /function Start-HarnessSuspendedProcessWatchdog \{([\s\S]*?)\r?\n\}\r?\nfunction Get-HarnessSuspendedProcessWatchdogCompletion/,
    )?.[1];
    assert.ok(startFunction, "watchdog start helper is missing");
    assert.doesNotMatch(startFunction, /Write-Output/);
    assert.doesNotMatch(startFunction, /GetProcessById|watchdogProcessId/);
    assert.match(
      startFunction,
      /while \(\$true\) \{[\s\S]*?Get-HarnessSuspendedProcessWatchdogSetupSignalDiagnostic -Name "ready"[\s\S]*?\$readySignal -eq "ready=armed"[\s\S]*?readyAcceptanceDeadlineUtc[\s\S]*?ready signal armed after setup handoff deadline[\s\S]*?setup handoff deadline elapsed with \$readyFailure ready signal/,
    );
    assert.doesNotMatch(startFunction, /Get-Content -LiteralPath \$readyPath/);
    assert.match(
      startFunction,
      /readyFailure = "late-armed"[\s\S]*?SuspendedProcessWatchdogReadyFailure"] = "late-armed"/,
    );
    assert.match(
      startFunction,
      /catch \{[\s\S]*?if \(\$null -ne \$process\) \{[\s\S]*?\[void\]\(\$WatchdogReference\.Value = \$watchdog\)[\s\S]*?\$_\.Exception\.Data\["VemVisionHarness\.SuspendedProcessWatchdog"\] = \$watchdog[\s\S]*?\}[\s\S]*?\$diagnostic = Get-HarnessSuspendedProcessWatchdogSetupFailureDiagnostic/,
    );
    const signalDiagnostic = harness.match(
      /function Get-HarnessSuspendedProcessWatchdogSetupSignalDiagnostic \{([\s\S]*?)\r?\n\}\r?\nfunction Get-HarnessSuspendedProcessWatchdogSetupFailureDiagnostic/,
    )?.[1];
    assert.ok(
      signalDiagnostic,
      "watchdog setup signal diagnostic helper is missing",
    );
    assert.match(
      signalDiagnostic,
      /try \{\s+if \(-not \(Test-Path -LiteralPath \$Path -PathType Leaf\)\) \{ return "\$Name=missing" \}/,
    );
    const setupDiagnostic = harness.match(
      /function Get-HarnessSuspendedProcessWatchdogSetupFailureDiagnostic \{([\s\S]*?)\r?\n\}\r?\nfunction Add-HarnessSuspendedProcessWatchdogSetupFailureDiagnostic/,
    )?.[1];
    assert.ok(
      setupDiagnostic,
      "watchdog setup failure diagnostic helper is missing",
    );
    assert.match(
      setupDiagnostic,
      /\[IO\.Directory\]::EnumerateFiles\(\$WatchdogRoot\)[\s\S]*?if \(\$temporaryEntries -gt 8\) \{[\s\S]*?\$temporaryOverflow = \$true/,
    );
    assert.match(
      setupDiagnostic,
      /temporaryFiles=command:\$\(\$temporaryCounts\.command\),invalid:\$\(\$temporaryCounts\.invalid\),overflow:/,
    );
    assert.doesNotMatch(setupDiagnostic, /Get-ChildItem|Sort-Object/);
    assert.match(
      harness,
      /function Complete-HarnessSuspendedProcessWatchdogTerminal[\s\S]*?Close-HarnessSuspendedProcessWatchdog -Watchdog \$Watchdog \| Out-Null[\s\S]*?Write-Output -NoEnumerate \$Completion/,
    );
    assert.match(
      harness,
      /function Write-HarnessWatchdogCommand\(\[string\]\$Path, \[string\]\$Command, \[DateTime\]\$DeadlineUtc\) \{[\s\S]*?while \(\$true\) \{[\s\S]*?command write was late before[\s\S]*?new\(\$Path, \[IO\.FileMode\]::Create, \[IO\.FileAccess\]::Write, \[IO\.FileShare\]::Read\)[\s\S]*?\.Flush\(\$true\)[\s\S]*?command write completed after[\s\S]*?catch \[IO\.IOException\][\s\S]*?Get-HarnessRemainingMilliseconds -DeadlineUtc \$DeadlineUtc/,
    );
    assert.match(
      harness,
      /try \{\s+Start-HarnessSuspendedProcessWatchdog -StageRoot \$stageRoot[\s\S]*?\} catch \{\s+\$watchdogSetupDiagnostic = \[string\]\$_.Exception.Data\["VemVisionHarness\.SuspendedProcessWatchdogSetupDiagnostic"\][\s\S]*?Write-HarnessStage \$Stage "suspended-process-watchdog-setup-failed" \$watchdogSetupDiagnostic[\s\S]*?throw\s+\}/,
    );
    assert.match(
      harness,
      /\$watchdogReadyFailure = \[string\]\$_.Exception.Data\["VemVisionHarness\.SuspendedProcessWatchdogReadyFailure"\][\s\S]*?\$watchdogSetupDiagnostic \+= ";readyFailure=late-armed"/,
    );
  });

  boundedIt(
    "retains an immediate watchdog exit handle without reopening its PID on Windows",
    { skip: process.platform !== "win32" },
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
Initialize-HarnessNativeTypes
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-retained-watchdog-" + [guid]::NewGuid().ToString("N"))
$nativeProcess = $null
$watchdogProcess = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $csc = Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"
  if (-not (Test-Path -LiteralPath $csc -PathType Leaf)) { throw "C# compiler missing" }
  $sourcePath = Join-Path $root "ExitTwo.cs"
  $watchdogPath = Join-Path $root "exit-two.exe"
  [IO.File]::WriteAllText($sourcePath, 'public static class ExitTwo { public static int Main(string[] args) { return 2; } }', [Text.UTF8Encoding]::new($false))
  & $csc /nologo /target:exe ("/out:{0}" -f $watchdogPath) $sourcePath
  if ($LASTEXITCODE -ne 0) { throw "immediate-exit watchdog fixture compilation failed" }
  $powerShellPath = Get-Command pwsh -CommandType Application | Select-Object -First 1 -ExpandProperty Source
  $nativeProcess = [VemVisionHarness.SuspendedProcess]::Create($powerShellPath, [string[]]@("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"), $root)
  $watchdogProcess = $nativeProcess.StartInheritedHandleWatchdog($watchdogPath, [string[]]@("reserved", "command", "ready", "completion", "1", "2"), $root)
  if (-not $watchdogProcess.WaitForExit(5000) -or -not $watchdogProcess.HasExited) { throw "retained watchdog did not report its immediate exit" }
  if ($watchdogProcess.ExitCode -ne 2) { throw "retained watchdog lost its immediate exit code: $($watchdogProcess.ExitCode)" }
  $watchdogProcess.Dispose()
  $watchdogProcess.Dispose()
  $disposedFailure = $null
  try { $watchdogProcess.WaitForExit(0) | Out-Null } catch [ObjectDisposedException] { $disposedFailure = $_.Exception }
  if ($null -eq $disposedFailure) { throw "retained watchdog wrapper remained usable after Dispose" }
  $watchdogProcess = $null
} finally {
  if ($null -ne $watchdogProcess) { $watchdogProcess.Dispose() }
  if ($null -ne $nativeProcess) {
    try { if (-not $nativeProcess.WaitForExit(0)) { $nativeProcess.TerminateUnresumed(2000) } } finally { $nativeProcess.Dispose() }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "returns a watchdog only through ref without success-stream output on Windows",
    { skip: process.platform !== "win32" },
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
Initialize-HarnessNativeTypes
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-start-output-" + [guid]::NewGuid().ToString("N"))
$nativeProcess = $null
$watchdog = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $watchdogPath = Initialize-HarnessSuspendedProcessWatchdog -HarnessRoot $root
  $powerShellPath = Get-Command pwsh -CommandType Application | Select-Object -First 1 -ExpandProperty Source
  $nativeProcess = [VemVisionHarness.SuspendedProcess]::Create($powerShellPath, [string[]]@("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"), $root)
  if (@(Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "stage") -WatchdogPath $watchdogPath -NativeProcess $nativeProcess -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(5)) -Watchdog ([ref]$watchdog)).Count -ne 0) { throw "watchdog start emitted success-stream output" }
  if (@($watchdog).Count -ne 1 -or $watchdog -isnot [pscustomobject]) { throw "watchdog start did not assign exactly one watchdog object through ref" }
  if ($null -eq $watchdog.process -or [string]::IsNullOrWhiteSpace([string]$watchdog.commandPath) -or [string]::IsNullOrWhiteSpace([string]$watchdog.completionPath)) { throw "watchdog ref object is incomplete" }
} finally {
  if ($null -ne $watchdog) { Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2)) | Out-Null }
  if ($null -ne $nativeProcess) { $nativeProcess.Dispose() }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "retries a watchdog command writer through a concurrent reader on Windows",
    { skip: process.platform !== "win32" },
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
Initialize-HarnessNativeTypes
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;

public sealed class CommandReadLock : IDisposable {
  private readonly ManualResetEventSlim acquired = new ManualResetEventSlim(false);
  private readonly ManualResetEventSlim finished = new ManualResetEventSlim(false);
  private readonly Thread thread;
  private Exception failure;

  private CommandReadLock(string path, int holdMilliseconds) {
    thread = new Thread(() => {
      try {
        using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read)) {
          acquired.Set();
          Thread.Sleep(holdMilliseconds);
        }
      } catch (Exception exception) {
        failure = exception;
        acquired.Set();
      } finally {
        finished.Set();
      }
    });
    thread.IsBackground = true;
    thread.Start();
  }

  public static CommandReadLock Hold(string path, int holdMilliseconds) { return new CommandReadLock(path, holdMilliseconds); }
  public void WaitForAcquired(int timeoutMilliseconds) {
    if (!acquired.Wait(timeoutMilliseconds)) { throw new TimeoutException("command reader did not acquire its lock"); }
    if (failure != null) { throw new InvalidOperationException("command reader failed", failure); }
  }
  public void Dispose() {
    if (!finished.Wait(5000)) { throw new TimeoutException("command reader did not release its lock"); }
    if (failure != null) { throw new InvalidOperationException("command reader failed", failure); }
    acquired.Dispose();
    finished.Dispose();
  }
}
'@
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-command-reader-" + [guid]::NewGuid().ToString("N"))
$nativeProcess = $null
$watchdog = $null
$reader = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $watchdogPath = Initialize-HarnessSuspendedProcessWatchdog -HarnessRoot $root
  $powerShellPath = Get-Command pwsh -CommandType Application | Select-Object -First 1 -ExpandProperty Source
  $nativeProcess = [VemVisionHarness.SuspendedProcess]::Create($powerShellPath, [string[]]@("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"), $root)
  Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "stage") -WatchdogPath $watchdogPath -NativeProcess $nativeProcess -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(8)) -Watchdog ([ref]$watchdog) | Out-Null
  [IO.File]::WriteAllText($watchdog.commandPath, ("partial" + [Environment]::NewLine), [Text.UTF8Encoding]::new($false))
  $reader = [CommandReadLock]::Hold($watchdog.commandPath, 350)
  $reader.WaitForAcquired(1000)
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  $completion = Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "disarm" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(3))
  $stopwatch.Stop()
  if ($completion -cne "disarmed" -or $stopwatch.ElapsedMilliseconds -lt 100) { throw "watchdog command writer did not retry through its concurrent reader: completion=$completion elapsed=$($stopwatch.ElapsedMilliseconds)" }
  $commandPath = $watchdog.commandPath
  $watchdog = $null
  $reader.Dispose()
  $reader = [CommandReadLock]::Hold($commandPath, 600)
  $reader.WaitForAcquired(1000)
  $lateWriteFailure = $null
  try { Write-HarnessWatchdogCommand -Path $commandPath -Command "disarm" -DeadlineUtc ([DateTime]::UtcNow.AddMilliseconds(150)) } catch { $lateWriteFailure = $_.Exception.Message }
  if ($lateWriteFailure -notmatch "command write was late|could not acquire") { throw "permanent command sharing lock did not fail within its deadline: $lateWriteFailure" }
} finally {
  if ($null -ne $reader) { $reader.Dispose() }
  if ($null -ne $watchdog -and -not $watchdog.completed) { try { Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2)) | Out-Null } catch { } }
  if ($null -ne $nativeProcess) {
    try { if (-not $nativeProcess.WaitForExit(0)) { $nativeProcess.TerminateUnresumed(2000) } } finally { $nativeProcess.Dispose() }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt("returns exactly one terminal watchdog completion", () => {
    const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-output-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $completionPath = Join-Path $root "completion"
  [IO.File]::WriteAllText($completionPath, "terminated", [Text.UTF8Encoding]::new($false))
  $process = [pscustomobject]@{ disposeCalls=0 }
  $process | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.disposeCalls++ }
  $watchdog = [pscustomobject]@{ process=$process; commandPath=(Join-Path $root "command"); completionPath=$completionPath; processId=4244; completed=$false; commandAction=$null; disposed=$false; terminalCompletion=$null }
  $results = @(Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(1)))
  if ($results.Count -ne 1 -or $results[0] -cne "terminated") { throw "terminal watchdog completion returned $($results.Count) results: $($results -join ',')" }
  if (-not $watchdog.completed -or -not $watchdog.disposed -or $process.disposeCalls -ne 1) { throw "terminal watchdog completion did not finalize its watchdog" }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
    const result = spawnBounded("pwsh", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      probe,
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });

  boundedIt(
    "applies a watchdog deadline extension before the prior confirmation deadline expires",
    { skip: process.platform !== "win32" },
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
Initialize-HarnessNativeTypes
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-extend-" + [guid]::NewGuid().ToString("N"))
$nativeProcess = $null
$watchdog = $null
$previousGate = $env:VEM_VISION_HARNESS_FIXTURE_WATCHDOG_TERMINATE_GATE_PATH
$previousCommandDeadlinePath = $env:VEM_VISION_HARNESS_FIXTURE_WATCHDOG_COMMAND_DEADLINE_PATH
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $gatePath = Join-Path $root "allow-terminate"
  $commandDeadlinePath = Join-Path $root "observed-command-deadline"
  $env:VEM_VISION_HARNESS_FIXTURE_WATCHDOG_TERMINATE_GATE_PATH = $gatePath
  $env:VEM_VISION_HARNESS_FIXTURE_WATCHDOG_COMMAND_DEADLINE_PATH = $commandDeadlinePath
  $watchdogPath = Initialize-HarnessSuspendedProcessWatchdog -HarnessRoot $root
  $powerShellPath = Get-Command pwsh -CommandType Application | Select-Object -First 1 -ExpandProperty Source
  $nativeProcess = [VemVisionHarness.SuspendedProcess]::Create($powerShellPath, [string[]]@("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"), $root)
  $watchdogDeadlineUtc = [DateTime]::UtcNow.AddSeconds(5)
  $automaticConfirmationDeadlineUtc = $watchdogDeadlineUtc.AddSeconds(1)
  Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "stage") -WatchdogPath $watchdogPath -NativeProcess $nativeProcess -DeadlineUtc $watchdogDeadlineUtc -Watchdog ([ref]$watchdog) | Out-Null

  $firstDeadlineUtc = $automaticConfirmationDeadlineUtc.AddMilliseconds(800)
  if ($firstDeadlineUtc -le $automaticConfirmationDeadlineUtc) { throw "first terminate deadline did not exceed automatic confirmation deadline" }
  Write-HarnessWatchdogCommand -Path $watchdog.commandPath -Command ("terminate:" + $firstDeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)) -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(3))
  $watchdog.commandAction = "terminate"
  $watchdog.confirmationDeadlineUtcTicks = $firstDeadlineUtc.Ticks
  $firstCommand = (Get-Content -LiteralPath $watchdog.commandPath -Raw -Encoding UTF8).Trim()
  if ($firstCommand -notmatch "^terminate:([0-9]+)$") { throw "first watchdog command was invalid: $firstCommand" }
  [Int64]$firstTicks = $Matches[1]
  $telemetryDeadlineUtc = [DateTime]::UtcNow.AddSeconds(1)
  while ((-not (Test-Path -LiteralPath $commandDeadlinePath -PathType Leaf) -or [Int64](Get-Content -LiteralPath $commandDeadlinePath -Raw) -ne $firstTicks) -and [DateTime]::UtcNow -lt $telemetryDeadlineUtc) { Start-Sleep -Milliseconds 10 }
  if (-not (Test-Path -LiteralPath $commandDeadlinePath -PathType Leaf) -or [Int64](Get-Content -LiteralPath $commandDeadlinePath -Raw) -ne $firstTicks) { throw "watchdog did not consume the first terminate deadline" }

  Start-Sleep -Milliseconds 400
  $extendedDeadlineUtc = $firstDeadlineUtc.AddSeconds(2)
  Write-HarnessWatchdogCommand -Path $watchdog.commandPath -Command ("terminate:" + $extendedDeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)) -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(3))
  $watchdog.confirmationDeadlineUtcTicks = $extendedDeadlineUtc.Ticks
  $telemetryDeadlineUtc = [DateTime]::UtcNow.AddSeconds(1)
  while ((-not (Test-Path -LiteralPath $commandDeadlinePath -PathType Leaf) -or [Int64](Get-Content -LiteralPath $commandDeadlinePath -Raw) -ne $extendedDeadlineUtc.Ticks) -and [DateTime]::UtcNow -lt $telemetryDeadlineUtc) { Start-Sleep -Milliseconds 10 }
  if (-not (Test-Path -LiteralPath $commandDeadlinePath -PathType Leaf) -or [Int64](Get-Content -LiteralPath $commandDeadlinePath -Raw) -ne $extendedDeadlineUtc.Ticks) { throw "watchdog did not consume the second terminate deadline" }
  Start-Sleep -Milliseconds ([Math]::Max(0, (Get-HarnessRemainingMilliseconds -DeadlineUtc $firstDeadlineUtc) + 100))
  if ($watchdog.process.HasExited -or (Test-Path -LiteralPath $watchdog.completionPath -PathType Leaf)) { throw "watchdog expired the old confirmation deadline after receiving its extension" }

  New-Item -ItemType File -Path $gatePath | Out-Null
  $completion = Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc $extendedDeadlineUtc
  if ($completion -notin @("terminated", "exited")) { throw "extended watchdog command did not confirm termination: $completion" }
  $extendedCommand = (Get-Content -LiteralPath $watchdog.commandPath -Raw -Encoding UTF8).Trim()
  if ($extendedCommand -notmatch "^terminate:([0-9]+)$") { throw "extended watchdog command was invalid: $extendedCommand" }
  if ([Int64]$Matches[1] -le $firstTicks) { throw "watchdog confirmation deadline did not increase monotonically" }
  if (-not $nativeProcess.WaitForExit(1000)) { throw "watchdog completion did not signal the original suspended process handle" }
} finally {
  if ($null -ne $watchdog -and -not $watchdog.completed) { try { Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2)) | Out-Null } catch { } }
  if ($null -ne $nativeProcess) {
    try { if (-not $nativeProcess.WaitForExit(0)) { $nativeProcess.TerminateUnresumed(2000) } } finally { $nativeProcess.Dispose() }
  }
  $env:VEM_VISION_HARNESS_FIXTURE_WATCHDOG_TERMINATE_GATE_PATH = $previousGate
  $env:VEM_VISION_HARNESS_FIXTURE_WATCHDOG_COMMAND_DEADLINE_PATH = $previousCommandDeadlinePath
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "honors a first future watchdog terminate deadline before automatic termination",
    { skip: process.platform !== "win32" },
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
Initialize-HarnessNativeTypes
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-first-terminate-" + [guid]::NewGuid().ToString("N"))
$nativeProcess = $null
$watchdog = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $watchdogPath = Initialize-HarnessSuspendedProcessWatchdog -HarnessRoot $root
  $powerShellPath = Get-Command pwsh -CommandType Application | Select-Object -First 1 -ExpandProperty Source
  $nativeProcess = [VemVisionHarness.SuspendedProcess]::Create($powerShellPath, [string[]]@("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"), $root)
  $watchdogDeadlineUtc = [DateTime]::UtcNow.AddSeconds(5)
  $automaticConfirmationDeadlineUtc = $watchdogDeadlineUtc.AddSeconds(1)
  Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "stage") -WatchdogPath $watchdogPath -NativeProcess $nativeProcess -DeadlineUtc $watchdogDeadlineUtc -Watchdog ([ref]$watchdog) | Out-Null
  $requestedDeadlineUtc = [DateTime]::UtcNow.AddMilliseconds(500)
  if ($requestedDeadlineUtc -ge $automaticConfirmationDeadlineUtc) { throw "first requested deadline was not before automatic confirmation" }
  Write-HarnessWatchdogCommand -Path $watchdog.commandPath -Command ("terminate:" + $requestedDeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)) -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2))
  if (-not $watchdog.process.WaitForExit(2000)) { throw "first future terminate deadline did not trigger watchdog termination" }
  if ([DateTime]::UtcNow -ge $automaticConfirmationDeadlineUtc) { throw "first future terminate waited for automatic confirmation" }
  $completion = Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(1))
  if ($completion -notin @("terminated", "exited")) { throw "first future terminate did not confirm termination: $completion" }
  if (-not $nativeProcess.WaitForExit(1000)) { throw "first future terminate did not signal the inherited process handle" }
  $watchdog = $null
} finally {
  if ($null -ne $watchdog -and -not $watchdog.completed) { try { Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2)) | Out-Null } catch { } }
  if ($null -ne $nativeProcess) {
    try { if (-not $nativeProcess.WaitForExit(0)) { $nativeProcess.TerminateUnresumed(2000) } } finally { $nativeProcess.Dispose() }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "expires unconfirmed watchdog termination and releases both watchdog handles",
    { skip: process.platform !== "win32" },
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
Initialize-HarnessNativeTypes
foreach ($terminationResult in @("success", "failure")) {
  $root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-unconfirmed-" + $terminationResult + "-" + [guid]::NewGuid().ToString("N"))
  $nativeProcess = $null
  $watchdog = $null
  $previousTerminationResult = $env:VEM_VISION_HARNESS_FIXTURE_WATCHDOG_TERMINATE_RESULT
  try {
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    $env:VEM_VISION_HARNESS_FIXTURE_WATCHDOG_TERMINATE_RESULT = $terminationResult
    $watchdogPath = Initialize-HarnessSuspendedProcessWatchdog -HarnessRoot $root
    $powerShellPath = Get-Command pwsh -CommandType Application | Select-Object -First 1 -ExpandProperty Source
    $nativeProcess = [VemVisionHarness.SuspendedProcess]::Create($powerShellPath, [string[]]@("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"), $root)
    Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "stage") -WatchdogPath $watchdogPath -NativeProcess $nativeProcess -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(1)) -ConfirmationReserveMilliseconds 100 -Watchdog ([ref]$watchdog) | Out-Null
    $watchdogProcessId = $watchdog.process.ProcessId
    $confirmationDeadlineUtc = [DateTime]::UtcNow.AddMilliseconds(1500)
    $parentDeadlineUtc = [DateTime]::UtcNow.AddSeconds(4)
    Write-HarnessWatchdogCommand $watchdog.commandPath ("terminate:" + $confirmationDeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)) -DeadlineUtc $parentDeadlineUtc | Out-Null
    $watchdog.commandAction = "terminate"
    $watchdog.confirmationDeadlineUtcTicks = $confirmationDeadlineUtc.Ticks
    if (-not $watchdog.process.WaitForExit((Get-HarnessRemainingMilliseconds -DeadlineUtc $parentDeadlineUtc))) { throw "$terminationResult watchdog did not exit before the parent deadline" }
    if ([DateTime]::UtcNow -le $confirmationDeadlineUtc) { throw "$terminationResult watchdog exited before its confirmation deadline" }
    if ((Get-HarnessRemainingMilliseconds -DeadlineUtc $parentDeadlineUtc) -le 0) { throw "$terminationResult parent deadline elapsed before unconfirmed completion was consumed" }
    $failure = $null
    try { Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc $parentDeadlineUtc | Out-Null } catch { $failure = $_.Exception.Message }
    if ($failure -notmatch "could not terminate process .*: terminate-unconfirmed") { throw "$terminationResult termination did not become unconfirmed: $failure" }
    if ($watchdog.completed -or -not $watchdog.disposed -or $watchdog.terminalCompletion -cne "terminate-unconfirmed") { throw "$terminationResult termination did not retain its unconfirmed terminal state" }
    if ($null -ne (Get-Process -Id $watchdogProcessId -ErrorAction SilentlyContinue)) { throw "$terminationResult watchdog did not exit" }
    if ($nativeProcess.WaitForExit(0)) { throw "$terminationResult fixture unexpectedly signaled the inherited process handle" }
    $commandBeforeRetry = Get-Content -LiteralPath $watchdog.commandPath -Raw -Encoding UTF8
    $retryFailure = $null
    try { Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2)) | Out-Null } catch { $retryFailure = $_.Exception.Message }
    if ($retryFailure -notmatch "could not terminate process .*: terminate-unconfirmed") { throw "$terminationResult post-expiry retry revived the watchdog: $retryFailure" }
    if ((Get-Content -LiteralPath $watchdog.commandPath -Raw -Encoding UTF8) -cne $commandBeforeRetry) { throw "$terminationResult post-expiry retry extended the command deadline" }
  } finally {
    if ($null -ne $nativeProcess) {
      try { if (-not $nativeProcess.WaitForExit(0)) { $nativeProcess.TerminateUnresumed(2000) } } finally { $nativeProcess.Dispose() }
    }
    $env:VEM_VISION_HARNESS_FIXTURE_WATCHDOG_TERMINATE_RESULT = $previousTerminationResult
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
  }
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "retries only live watchdog timeouts and keeps invalid terminal completions failed",
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-completion-" + [guid]::NewGuid().ToString("N"))
$completionWriter = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;

public sealed class PartialSignalWriter : IDisposable {
  private readonly ManualResetEventSlim partialWritten = new ManualResetEventSlim(false);
  private readonly ManualResetEventSlim finished = new ManualResetEventSlim(false);
  private readonly Thread thread;
  private Exception failure;

  private PartialSignalWriter(string path, string partial, string remainder, int delayMilliseconds) {
    thread = new Thread(() => {
      try {
        using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
          var encoding = new UTF8Encoding(false);
          var partialBytes = encoding.GetBytes(partial);
          stream.Write(partialBytes, 0, partialBytes.Length);
          stream.Flush(true);
          partialWritten.Set();
          Thread.Sleep(delayMilliseconds);
          var remainderBytes = encoding.GetBytes(remainder);
          stream.Write(remainderBytes, 0, remainderBytes.Length);
          stream.Flush(true);
        }
      } catch (Exception exception) {
        failure = exception;
        partialWritten.Set();
      } finally {
        finished.Set();
      }
    });
    thread.IsBackground = true;
    thread.Start();
  }

  public static PartialSignalWriter Start(string path, string partial, string remainder, int delayMilliseconds) {
    return new PartialSignalWriter(path, partial, remainder, delayMilliseconds);
  }

  public void WaitForPartial(int timeoutMilliseconds) {
    if (!partialWritten.Wait(timeoutMilliseconds)) { throw new TimeoutException("partial signal was not written"); }
    if (failure != null) { throw new InvalidOperationException("partial signal writer failed", failure); }
  }

  public void WaitForCompletion(int timeoutMilliseconds) {
    if (!finished.Wait(timeoutMilliseconds)) { throw new TimeoutException("partial signal writer did not finish"); }
    if (failure != null) { throw new InvalidOperationException("partial signal writer failed", failure); }
  }

  public void Dispose() {
    WaitForCompletion(5000);
    partialWritten.Dispose();
    finished.Dispose();
  }
}
'@
  $completionPath = Join-Path $root "completion"
  $completionWriter = [PartialSignalWriter]::Start($completionPath, "termin", "ated", 300)
  $completionWriter.WaitForPartial(1000)
  $partialWatchdog = [pscustomobject]@{ completionPath=$completionPath }
  if ($null -ne (Get-HarnessSuspendedProcessWatchdogCompletion -Watchdog $partialWatchdog)) { throw "partial completion was consumed as a terminal state" }
  $eventualCompletion = Get-HarnessSuspendedProcessWatchdogCompletion -Watchdog $partialWatchdog -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2))
  if ($eventualCompletion -cne "terminated") { throw "partial completion did not become terminal before its bounded deadline: $eventualCompletion" }
  $completionWriter.WaitForCompletion(1000)
  $completionWriter.Dispose()
  $completionWriter = $null

  Remove-Item -LiteralPath $completionPath -Force
  $timeoutProcess = [pscustomobject]@{ waitCalls=0; disposeCalls=0 }
  $timeoutProcess | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($milliseconds) $this.waitCalls++; return $false }
  $timeoutProcess | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.disposeCalls++ }
  $timeoutWatchdog = [pscustomobject]@{ process=$timeoutProcess; commandPath=(Join-Path $root "timeout-command"); completionPath=$completionPath; processId=4241; completed=$false; commandAction="terminate"; disposed=$false; terminalCompletion=$null }
  foreach ($attempt in @(1, 2)) {
    $failure = $null
    try { Complete-HarnessSuspendedProcessWatchdog -Watchdog $timeoutWatchdog -Action "terminate" -DeadlineUtc ([DateTime]::UtcNow.AddMilliseconds(20)) | Out-Null } catch { $failure = $_.Exception.Message }
    if ($failure -notmatch "did not complete 'terminate' before the cleanup deadline") { throw "timeout attempt $attempt was not retryable: $failure" }
  }
  if ($timeoutWatchdog.disposed -or $timeoutWatchdog.completed -or $timeoutProcess.disposeCalls -ne 0 -or $timeoutProcess.waitCalls -ne 2) { throw "timed out watchdog was not left live for a safe retry" }

  [IO.File]::WriteAllText($completionPath, "terminate-unconfirmed", [Text.UTF8Encoding]::new($false))
  $fakeProcess = [pscustomobject]@{ disposeCalls=0 }
  $fakeProcess | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.disposeCalls++ }
  $watchdog = [pscustomobject]@{ process=$fakeProcess; commandPath=(Join-Path $root "command"); completionPath=$completionPath; processId=4242; completed=$false; commandAction=$null; disposed=$false; terminalCompletion=$null }
  foreach ($attempt in @(1, 2)) {
    $failure = $null
    try { Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(1)) | Out-Null } catch { $failure = $_.Exception.Message }
    if ($failure -notmatch "could not terminate process 4242: terminate-unconfirmed") { throw "attempt $attempt accepted an invalid watchdog completion: $failure" }
  }
  if ($watchdog.completed -or -not $watchdog.disposed -or $watchdog.terminalCompletion -cne "terminate-unconfirmed" -or $fakeProcess.disposeCalls -ne 1) { throw "invalid watchdog completion was not retained as one terminal failure" }
} finally {
  if ($null -ne $completionWriter) { $completionWriter.Dispose() }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "rejects an armed watchdog signal observed inside the setup handoff reserve",
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-armed-after-deadline-" + [guid]::NewGuid().ToString("N"))
$watchdog = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $wrapper = [pscustomobject]@{ disposeCalls=0 }
  $wrapper | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.disposeCalls++ }
  $nativeProcess = [pscustomobject]@{ ProcessId=4340; watchdogWrapper=$wrapper }
  $nativeProcess | Add-Member -MemberType ScriptMethod -Name StartInheritedHandleWatchdog -Value {
    param($watchdogPath, $watchdogArguments, $workingDirectory)
    [IO.File]::WriteAllText([string]$watchdogArguments[2], "armed", [Text.UTF8Encoding]::new($false))
    Start-Sleep -Milliseconds 1000
    return $this.watchdogWrapper
  }
  $failure = $null
  try { Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "stage") -WatchdogPath "unused" -NativeProcess $nativeProcess -DeadlineUtc ([DateTime]::UtcNow.AddMilliseconds(1200)) -Watchdog ([ref]$watchdog) | Out-Null } catch { $failure = $_ }
  if ($null -eq $failure -or $failure.Exception.Message -notmatch "ready signal armed after setup handoff deadline") { throw "armed signal inside the setup handoff reserve was accepted: $failure" }
  if ([string]$failure.Exception.Data["VemVisionHarness.SuspendedProcessWatchdogReadyFailure"] -cne "late-armed") { throw "late armed setup was not classified for telemetry" }
  if ($null -eq $watchdog -or $null -eq $failure.Exception.Data["VemVisionHarness.SuspendedProcessWatchdog"]) { throw "late armed setup did not publish cleanup ownership" }
  Close-HarnessSuspendedProcessWatchdog -Watchdog $watchdog | Out-Null
  if ($wrapper.disposeCalls -ne 1) { throw "late armed watchdog wrapper was not disposed" }
  $watchdog = $null
} finally {
  if ($null -ne $watchdog -and -not $watchdog.disposed) { Close-HarnessSuspendedProcessWatchdog -Watchdog $watchdog | Out-Null }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "accepts an early partial ready signal only after its original stream completes",
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-partial-signal-" + [guid]::NewGuid().ToString("N"))
$writer = $null
$readyWatchdog = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading;

public sealed class PartialReadySignalWriter : IDisposable {
  private readonly ManualResetEventSlim partialWritten = new ManualResetEventSlim(false);
  private readonly ManualResetEventSlim finished = new ManualResetEventSlim(false);
  private readonly Thread thread;
  private Exception failure;

  private PartialReadySignalWriter(string path) {
    thread = new Thread(() => {
      try {
        using (var stream = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
          var encoding = new UTF8Encoding(false);
          var partialBytes = encoding.GetBytes("ar");
          stream.Write(partialBytes, 0, partialBytes.Length);
          stream.Flush(true);
          partialWritten.Set();
          Thread.Sleep(300);
          var remainderBytes = encoding.GetBytes("med");
          stream.Write(remainderBytes, 0, remainderBytes.Length);
          stream.Flush(true);
        }
      } catch (Exception exception) {
        failure = exception;
        partialWritten.Set();
      } finally {
        finished.Set();
      }
    });
    thread.IsBackground = true;
    thread.Start();
  }

  public static PartialReadySignalWriter Start(string path) { return new PartialReadySignalWriter(path); }

  public void WaitForPartial(int timeoutMilliseconds) {
    if (!partialWritten.Wait(timeoutMilliseconds)) { throw new TimeoutException("partial ready signal was not written"); }
    if (failure != null) { throw new InvalidOperationException("partial ready writer failed", failure); }
  }

  public void WaitForCompletion(int timeoutMilliseconds) {
    if (!finished.Wait(timeoutMilliseconds)) { throw new TimeoutException("partial ready writer did not finish"); }
    if (failure != null) { throw new InvalidOperationException("partial ready writer failed", failure); }
  }

  public void Dispose() {
    WaitForCompletion(5000);
    partialWritten.Dispose();
    finished.Dispose();
  }
}
'@
  $readyWrapper = [pscustomobject]@{ disposeCalls=0 }
  $readyWrapper | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.disposeCalls++ }
  $readyNativeProcess = [pscustomobject]@{ ProcessId=4341; watchdogWrapper=$readyWrapper }
  $readyNativeProcess | Add-Member -MemberType ScriptMethod -Name StartInheritedHandleWatchdog -Value {
    param($watchdogPath, $watchdogArguments, $workingDirectory)
    $readyPath = [string]$watchdogArguments[2]
    $script:writer = [PartialReadySignalWriter]::Start($readyPath)
    $script:writer.WaitForPartial(1000)
    return $this.watchdogWrapper
  }
  Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "eventual") -WatchdogPath "unused" -NativeProcess $readyNativeProcess -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2)) -Watchdog ([ref]$readyWatchdog) | Out-Null
  if ($null -eq $readyWatchdog) { throw "partial ready signal did not become an armed watchdog" }
  $writer.WaitForCompletion(1000)
  $writer.Dispose()
  $writer = $null
  Close-HarnessSuspendedProcessWatchdog -Watchdog $readyWatchdog | Out-Null
  if ($readyWrapper.disposeCalls -ne 1) { throw "eventual ready watchdog wrapper was not disposed" }
  $readyWatchdog = $null

} finally {
  if ($null -ne $writer) { $writer.Dispose() }
  if ($null -ne $readyWatchdog -and -not $readyWatchdog.disposed) { Close-HarnessSuspendedProcessWatchdog -Watchdog $readyWatchdog | Out-Null }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "bounds a permanently partial ready signal held by its original stream",
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-permanent-partial-" + [guid]::NewGuid().ToString("N"))
$watchdog = $null
$readyStream = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $wrapper = [pscustomobject]@{ disposeCalls=0 }
  $wrapper | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.disposeCalls++ }
  $nativeProcess = [pscustomobject]@{ ProcessId=4342; watchdogWrapper=$wrapper; readyStream=$null }
  $nativeProcess | Add-Member -MemberType ScriptMethod -Name StartInheritedHandleWatchdog -Value {
    param($watchdogPath, $watchdogArguments, $workingDirectory)
    $stream = [IO.FileStream]::new([string]$watchdogArguments[2], [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes("ar")
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
    $this.readyStream = $stream
    return $this.watchdogWrapper
  }
  $failure = $null
  try { Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "stage") -WatchdogPath "unused" -NativeProcess $nativeProcess -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2)) -Watchdog ([ref]$watchdog) | Out-Null } catch { $failure = $_ }
  if ($null -eq $failure -or $failure.Exception.Message -notmatch "setup handoff deadline elapsed with (invalid|unavailable) ready signal") { throw "permanently partial ready signal was not bounded safely: $failure" }
  $diagnostic = [string]$failure.Exception.Data["VemVisionHarness.SuspendedProcessWatchdogSetupDiagnostic"]
  if ($diagnostic -notmatch "ready=(invalid|unavailable)") { throw "permanently partial ready signal did not retain its safe read classification: $diagnostic" }
  if ($null -eq $nativeProcess.readyStream -or $null -eq $watchdog -or $null -eq $failure.Exception.Data["VemVisionHarness.SuspendedProcessWatchdog"]) { throw "permanently partial setup did not preserve its live protocol stream and cleanup ownership" }
  $readyStream = $nativeProcess.readyStream
  Close-HarnessSuspendedProcessWatchdog -Watchdog $watchdog | Out-Null
  if ($wrapper.disposeCalls -ne 1) { throw "permanently partial watchdog wrapper was not disposed" }
  $watchdog = $null
} finally {
  if ($null -ne $readyStream) { $readyStream.Dispose() }
  if ($null -ne $watchdog -and -not $watchdog.disposed) { Close-HarnessSuspendedProcessWatchdog -Watchdog $watchdog | Out-Null }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "keeps a failed watchdog setup live until its suspended process cleanup starts",
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-slow-start-" + [guid]::NewGuid().ToString("N"))
$child = $null
$watchdogWrapper = $null
$watchdog = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Get-Command pwsh -CommandType Application | Select-Object -First 1 -ExpandProperty Source)
  $startInfo.Arguments = '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"'
  $startInfo.UseShellExecute = $false
  $child = [Diagnostics.Process]::Start($startInfo)
  $watchdogWrapper = [pscustomobject]@{ child=$child; ProcessId=$child.Id; disposeCalls=0 }
  $watchdogWrapper | Add-Member -MemberType ScriptProperty -Name HasExited -Value { $this.child.HasExited }
  $watchdogWrapper | Add-Member -MemberType ScriptProperty -Name ExitCode -Value { $this.child.ExitCode }
  $watchdogWrapper | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param($milliseconds) return $this.child.WaitForExit($milliseconds) }
  $watchdogWrapper | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.disposeCalls++ }
  $nativeProcess = [pscustomobject]@{ ProcessId=4243; watchdogWrapper=$watchdogWrapper }
  $nativeProcess | Add-Member -MemberType ScriptMethod -Name StartInheritedHandleWatchdog -Value {
    param($watchdogPath, $arguments, $workingDirectory)
    [IO.File]::WriteAllText((Join-Path $workingDirectory ".command.0123456789abcdef0123456789abcdef.tmp"), "temporary", [Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText((Join-Path $workingDirectory ".ready.fixture.tmp"), "invalid", [Text.UTF8Encoding]::new($false))
    return $this.watchdogWrapper
  }
  $failure = $null
  try { Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "stage") -WatchdogPath "unused" -NativeProcess $nativeProcess -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(2)) -Watchdog ([ref]$watchdog) | Out-Null } catch { $failure = $_ }
  if ($null -eq $failure -or $failure.Exception.Message -notmatch "setup handoff deadline elapsed with missing ready signal") { throw "slow watchdog start did not preserve its readiness failure: $failure" }
  $ownership = $failure.Exception.Data["VemVisionHarness.SuspendedProcessWatchdog"]
  if ($null -eq $ownership -or $null -eq $watchdog -or -not [object]::ReferenceEquals($ownership, $watchdog)) { throw "failed watchdog setup did not publish its cleanup ownership before returning" }
  $diagnostic = [string]$failure.Exception.Data["VemVisionHarness.SuspendedProcessWatchdogSetupDiagnostic"]
  if ($diagnostic -notmatch "watchdogProcess=running;ready=missing;completion=missing;temporaryFiles=command:1,invalid:1,overflow:false;setupDeadlineUtcTicks=[0-9]+;automaticDeadlineUtcTicks=[0-9]+;automaticConfirmationDeadlineUtcTicks=[0-9]+;lastWin32Error=[0-9]+") { throw "slow watchdog start did not attach bounded setup diagnostics: $diagnostic" }
  if ($diagnostic -match [regex]::Escape($root) -or $diagnostic -match "processId|handle|0123456789abcdef|fixture") { throw "slow watchdog setup diagnostics leaked a secret process detail: $diagnostic" }
  Close-HarnessSuspendedProcessWatchdog -Watchdog $watchdog | Out-Null
  if (-not $watchdog.disposed -or $watchdogWrapper.disposeCalls -ne 1) { throw "failed watchdog setup leaked its watchdog process wrapper" }
  $watchdog = $null
} finally {
  if ($null -ne $watchdog -and -not $watchdog.disposed) { Close-HarnessSuspendedProcessWatchdog -Watchdog $watchdog | Out-Null }
  if ($null -ne $child) {
    try { if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit(1000) | Out-Null } } finally { $child.Dispose() }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "rejects stale watchdog stage signals without discarding a live fallback",
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-stale-stage-" + [guid]::NewGuid().ToString("N"))
$child = $null
$watchdog = $null
try {
  $stageRoot = Join-Path $root "stage"
  $staleRoot = Join-Path $stageRoot "suspended-process-watchdog"
  New-Item -ItemType Directory -Force -Path $staleRoot | Out-Null
  [IO.File]::WriteAllText((Join-Path $staleRoot "command"), "disarm", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $staleRoot "ready"), "armed", [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText((Join-Path $staleRoot "completion"), "terminated", [Text.UTF8Encoding]::new($false))
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Get-Command pwsh -CommandType Application | Select-Object -First 1 -ExpandProperty Source)
  $startInfo.Arguments = '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"'
  $startInfo.UseShellExecute = $false
  $child = [Diagnostics.Process]::Start($startInfo)
  $nativeProcess = [pscustomobject]@{ ProcessId=4242; child=$child }
  $nativeProcess | Add-Member -MemberType ScriptMethod -Name StartInheritedHandleWatchdog -Value { param($watchdogPath, $arguments, $workingDirectory) return $this.child }
  $failure = $null
  try { Start-HarnessSuspendedProcessWatchdog -StageRoot $stageRoot -WatchdogPath "unused" -NativeProcess $nativeProcess -DeadlineUtc ([DateTime]::UtcNow.AddMilliseconds(800)) -Watchdog ([ref]$watchdog) | Out-Null } catch { $failure = $_.Exception.Message }
  if ([string]::IsNullOrWhiteSpace($failure) -or $failure -notmatch "setup handoff deadline elapsed with missing ready signal") { throw "stale ready signal was accepted: $failure" }
  foreach ($staleSignalPath in @((Join-Path $staleRoot "command"), (Join-Path $staleRoot "ready"), (Join-Path $staleRoot "completion"))) {
    if (Test-Path -LiteralPath $staleSignalPath -PathType Leaf) { throw "stale watchdog signal was not removed: $staleSignalPath" }
  }
} finally {
  if ($null -ne $child) {
    try { if (-not $child.HasExited) { $child.Kill(); $child.WaitForExit(1000) | Out-Null } } finally { $child.Dispose() }
  }
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "reports deterministic exited and atomic-ready watchdog setup diagnostics",
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts/windows/vision-release-install.windows-harness.ps1") -Library
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-watchdog-setup-diagnostics-" + [guid]::NewGuid().ToString("N"))
try {
  $watchdogRoot = Join-Path $root "watchdog"
  New-Item -ItemType Directory -Force -Path $watchdogRoot | Out-Null
  $readyPath = Join-Path $watchdogRoot "ready"
  $completionPath = Join-Path $watchdogRoot "completion"
  $setupDeadlineUtc = [DateTime]::UtcNow.AddSeconds(5)
  $automaticDeadlineUtc = $setupDeadlineUtc.AddSeconds(1)
  $automaticConfirmationDeadlineUtc = $automaticDeadlineUtc.AddSeconds(1)

  $exitedProcess = [pscustomobject]@{ HasExited=$true; ExitCode=2 }
  $exitedDiagnostic = Get-HarnessSuspendedProcessWatchdogSetupFailureDiagnostic -Process $exitedProcess -WatchdogRoot $watchdogRoot -ReadyPath $readyPath -CompletionPath $completionPath -SetupDeadlineUtc $setupDeadlineUtc -AutomaticDeadlineUtc $automaticDeadlineUtc -AutomaticConfirmationDeadlineUtc $automaticConfirmationDeadlineUtc -LastWin32Error 0
  if ($exitedDiagnostic -notmatch "watchdogProcess=exited:2;ready=missing;completion=missing;temporaryFiles=command:0,invalid:0,overflow:false") { throw "exited watchdog setup diagnostics were incomplete: $exitedDiagnostic" }

  [IO.File]::WriteAllText($completionPath, "watchdog-failed:Win32Exception:5", [Text.UTF8Encoding]::new($false))
  for ($index = 0; $index -lt 9; $index++) {
    $temporaryName = ".command.{0:x32}.tmp" -f $index
    [IO.File]::WriteAllText((Join-Path $watchdogRoot $temporaryName), "temporary", [Text.UTF8Encoding]::new($false))
  }
  $runningProcess = [pscustomobject]@{ HasExited=$false; ExitCode=$null }
  $completionDiagnostic = Get-HarnessSuspendedProcessWatchdogSetupFailureDiagnostic -Process $runningProcess -WatchdogRoot $watchdogRoot -ReadyPath $readyPath -CompletionPath $completionPath -SetupDeadlineUtc $setupDeadlineUtc -AutomaticDeadlineUtc $automaticDeadlineUtc -AutomaticConfirmationDeadlineUtc $automaticConfirmationDeadlineUtc -LastWin32Error 5
  if ($completionDiagnostic -notmatch "watchdogProcess=running;ready=missing;completion=watchdog-failed:Win32Exception:5;temporaryFiles=command:8,invalid:0,overflow:true") { throw "atomic ready failure diagnostics were incomplete: $completionDiagnostic" }
  if ($completionDiagnostic -match "[0-9a-f]{32}|$([regex]::Escape($root))") { throw "watchdog setup diagnostics exposed a temporary filename or root path: $completionDiagnostic" }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        probe,
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "passes the inherited watchdog handle with bounded trigger and confirmation deadlines",
    () => {
      const harness = readFileSync(windowsHarness, "utf8");
      const behavior = readFileSync(behaviorHarness, "utf8");

      assert.match(
        harness,
        /watchdogArguments\[0\]\s*=\s*unchecked\(\(ulong\)inheritedHandle\.ToInt64\(\)\)\.ToString/,
      );
      assert.match(
        harness,
        /new DateTime\(deadlineUtcTicks, DateTimeKind\.Utc\)/,
      );
      assert.match(
        harness,
        /new DateTime\(automaticConfirmationDeadlineUtcTicks, DateTimeKind\.Utc\)/,
      );
      assert.match(
        harness,
        /if \(args == null \|\| args\.Length != 6\) \{ return 2; \}/,
      );
      assert.match(
        harness,
        /if \(automaticConfirmationDeadlineUtc <= deadlineUtc\) \{ return 2; \}/,
      );
      assert.match(
        harness,
        /if \(command\.StartsWith\("terminate:", StringComparison\.Ordinal\)\)/,
      );
      assert.match(
        harness,
        /if \(terminationRequested && DateTime\.UtcNow >= confirmationDeadlineUtc\) \{\s+Write\(completionPath, "terminate-unconfirmed"\);/,
      );
      assert.match(
        harness,
        /for \(;;\) \{[\s\S]*?if \(TryReadCommand\(commandPath, out command\)\)[\s\S]*?if \(terminationRequested && DateTime\.UtcNow >= confirmationDeadlineUtc\)/,
      );
      assert.doesNotMatch(
        harness,
        /!terminationRequested \|\| requestedDeadlineUtc > confirmationDeadlineUtc/,
      );
      assert.match(
        harness,
        /VEM_VISION_HARNESS_FIXTURE_WATCHDOG_TERMINATE_RESULT/,
      );
      assert.match(harness, /finally \{\s+CloseHandle\(process\);\s+\}/);
      assert.match(
        harness,
        /\$command = if \(\$Action -eq "terminate"\) \{ "terminate:" \+ \$DeadlineUtc\.Ticks\.ToString/,
      );
      assert.match(
        harness,
        /using System\.Globalization;\s+using System\.IO;\s+using System\.Runtime\.InteropServices;/,
      );
      assert.match(
        harness,
        /function Write-HarnessWatchdogCommand\(\[string\]\$Path, \[string\]\$Command, \[DateTime\]\$DeadlineUtc\) \{[\s\S]*?new\(\$Path, \[IO\.FileMode\]::Create, \[IO\.FileAccess\]::Write, \[IO\.FileShare\]::Read\)[\s\S]*?\.Write\([\s\S]*?\.Flush\(\$true\)[\s\S]*?catch \[UnauthorizedAccessException\]/,
      );
      assert.match(
        harness,
        /private static void Write\(string path, string value\) \{\s+var bytes = new UTF8Encoding\(false\)\.GetBytes\(value\);\s+using \(var stream = new FileStream\(path, FileMode\.CreateNew, FileAccess\.Write, FileShare\.Read\)\) \{\s+stream\.Write\(bytes, 0, bytes\.Length\);\s+stream\.Flush\(true\);/,
      );
      assert.match(
        harness,
        /Write-HarnessWatchdogCommand \$Watchdog\.commandPath \$command/,
      );
      assert.match(
        harness,
        /private const int MAX_COMMAND_BYTES = 256;[\s\S]*?TryReadCommand[\s\S]*?new FileStream\(path, FileMode\.Open, FileAccess\.Read, FileShare\.ReadWrite\)[\s\S]*?text\.EndsWith\("\\n", StringComparison\.Ordinal\)[\s\S]*?return TryGetTerminationDeadline\(command, out terminationDeadlineUtc\)[\s\S]*?catch \(IOException\) \{\s+return false;\s+\}/,
      );
      assert.match(
        harness,
        /if \(TryReadCommand\(commandPath, out command\)\) \{\s+var commandObservedUtc = DateTime\.UtcNow;[\s\S]*?!terminationRequested && requestedDeadlineUtc > commandObservedUtc[\s\S]*?terminationRequested && commandObservedUtc < confirmationDeadlineUtc && requestedDeadlineUtc > confirmationDeadlineUtc[\s\S]*?if \(terminationRequested && DateTime\.UtcNow >= confirmationDeadlineUtc\)/,
      );
      assert.doesNotMatch(
        harness,
        /Write-HarnessAtomicUtf8|AtomicFile|MoveFileExW|MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH/,
      );
      assert.match(
        harness,
        /foreach \(\$staleSignalPath in @\(\(Join-Path \$watchdogStageRoot "command"\), \(Join-Path \$watchdogStageRoot "ready"\), \(Join-Path \$watchdogStageRoot "completion"\)\)\)/,
      );
      assert.match(
        harness,
        /\$watchdogRoot = Join-Path \$watchdogStageRoot \(\[guid\]::NewGuid\(\)\.ToString\("N"\)\)/,
      );
      assert.match(
        harness,
        /\$_\.Exception\.Data\["VemVisionHarness\.SuspendedProcessWatchdog"\] = \$watchdog/,
      );
      assert.doesNotMatch(
        harness,
        /DateTime\.UtcNow\.AddMilliseconds\(deadlineMilliseconds\)/,
      );
      assert.match(
        behavior,
        /inherited-watchdog-armed[\s\S]*?Complete-HarnessSuspendedProcessWatchdog -Watchdog \$hardWatchdogHost\.lifetimeWatchdog -Action "disarm"[\s\S]*?\$hardWatchdogHost\.lifetimeWatchdog = \$null[\s\S]*?lifetime-watchdog-disarmed/,
      );
    },
  );

  boundedIt(
    "keeps the production installer compatible with Windows PowerShell 5.1",
    () => {
      const installer = readFileSync(
        "scripts/windows/install-vision-release.ps1",
        "utf8",
      );

      assert.doesNotMatch(installer, /ConvertFrom-Json\s+-Depth/);
      assert.doesNotMatch(installer, /\.ArgumentList(?:\.|\b)/);
      assert.doesNotMatch(
        installer,
        /\[Convert\]::ToHexString|\[Security\.Cryptography\.SHA256\]::HashData|\.Kill\(\$true\)/,
      );
      assert.match(installer, /function ConvertTo-WindowsCommandLineArgument/);
      assert.match(installer, /\$start\.Arguments\s*=/);
      const result = spawnBounded("pwsh", [
        "-NoProfile",
        "-Command",
        ". ./scripts/windows/install-vision-release.ps1 -Library -VisionRoot ([IO.Path]::GetTempPath()) -StateRoot ([IO.Path]::GetTempPath()); $actual=@('plain', 'space value', 'quote\"value', 'trailing\\' | ForEach-Object { ConvertTo-WindowsCommandLineArgument $_ }) -join '|'; if($actual -cne '\"plain\"|\"space value\"|\"quote\\\"value\"|\"trailing\\\\\"'){throw \"unexpected quote: $actual\"}",
      ]);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "keeps Node coverage to parser, fixture, and workflow guards",
    () => {
      const source = readFileSync(new URL(import.meta.url), "utf8");
      assert.match(source, /const SPAWN_TIMEOUT_MS = 45_000/);
      assert.match(source, /const TEST_TIMEOUT_MS = 60_000/);
      assert.match(source, /function parsePowerShell/);
      assert.match(source, /spawnSync/);
    },
  );

  boundedIt(
    "keeps launcher cleanup failure injection compatible with Windows PowerShell",
    () => {
      const fixtureSource = readFileSync(fixture, "utf8");
      assert.match(
        fixtureSource,
        /generated launcher fixture did not inject runtime native termination failure/,
      );
      assert.doesNotMatch(
        fixtureSource,
        /Terminate(?:JobObject|Process)Override\s*=\s*\[Func\[/,
      );
      assert.doesNotMatch(fixtureSource, /Marshal\.SetLastWin32Error/);
      assert.doesNotMatch(fixtureSource, /if \(false\) \{ return; \}/);
      assert.match(
        fixtureSource,
        /generated launcher fixture did not retain the WaitForSingleObject P\/Invoke boundary/,
      );
      assert.match(
        fixtureSource,
        /generated launcher fixture did not intercept the WaitForSingleObject P\/Invoke call/,
      );
      assert.match(
        fixtureSource,
        /private static extern void SetLastError\(uint dwErrCode\);/,
      );
      assert.match(fixtureSource, /FIXTURE_TERMINATE_PROCESS_ERROR = 5/);
      assert.match(fixtureSource, /FIXTURE_TERMINATE_JOB_ERROR = 87/);
      assert.match(
        fixtureSource,
        /SetLastError\(FIXTURE_TERMINATE_PROCESS_ERROR\);/,
      );
      assert.match(
        fixtureSource,
        /SetLastErrorForFixture\(FIXTURE_TERMINATE_JOB_ERROR\);/,
      );
      assert.match(
        fixtureSource,
        /\[DllImport\("kernel32\.dll", SetLastError = true, EntryPoint = "SetLastError"\)\]\s+private static extern void SetLastErrorForFixture\(uint dwErrCode\);/,
      );
      assert.match(fixtureSource, /function Get-CleanupFailureDiagnostic/);
      assert.match(
        fixtureSource,
        /function Unwrap-CleanupFailureWin32Exception/,
      );
      assert.match(fixtureSource, /\$cleanupFailure\.InnerException/);
      assert.match(
        fixtureSource,
        /\$cleanupFailure\.GetType\(\) -ne \[Management\.Automation\.MethodInvocationException\]/,
      );
      assert.match(
        fixtureSource,
        /\$root\.GetType\(\) -ne \[ComponentModel\.Win32Exception\]/,
      );
      assert.doesNotMatch(
        fixtureSource,
        /\$cleanupFailure -is(?:not)? \[Management\.Automation\.MethodInvocationException\]/,
      );
      assert.doesNotMatch(
        fixtureSource,
        /\$root -is(?:not)? \[ComponentModel\.Win32Exception\]/,
      );
      assert.match(fixtureSource, /unexpected nested cleanup failure wrapper/);
      assert.match(fixtureSource, /wrapper type=/);
      assert.match(fixtureSource, /root type=/);
      assert.match(fixtureSource, /root NativeErrorCode=/);
      assert.match(fixtureSource, /FIXTURE_TERMINATE_JOB_ERROR/);
      assert.match(fixtureSource, /FIXTURE_TERMINATE_PROCESS_ERROR/);
      assert.doesNotMatch(fixtureSource, /\$cleanupFailures\[0\]/);
      assert.doesNotMatch(fixtureSource, /\$cleanupFailures\[1\]/);
      assert.match(
        fixtureSource,
        /`?\$cleanupFailureDiagnostics = @\(\s+"cleanup failure count=`?\$\(`?\$cleanupFailures\.Count\)"\s+for \(`?\$index = 0; `?\$index -lt `?\$cleanupFailures\.Count; `?\$index\+\+\) { Get-CleanupFailureDiagnostic `?\$cleanupFailures\[`?\$index\] `?\$index }\s+\) -join \[Environment\]::NewLine/,
      );
      assert.match(
        fixtureSource,
        /if \(`?\$cleanupFailures\.Count -ne 2\) \{ throw "aggregate failure fixture did not preserve both cleanup failures; `?\$cleanupFailureDiagnostics" \}/,
      );
      assert.ok(
        fixtureSource.indexOf("`$cleanupFailureDiagnostics = @(") <
          fixtureSource.indexOf("if (`$cleanupFailures.Count -ne 2)"),
        "cleanup diagnostics must be built before the count guard for every existing entry",
      );
      assert.match(
        fixtureSource,
        /`?\$unwrappedCleanupFailures = @\(for \(`?\$index = 0; `?\$index -lt `?\$cleanupFailures\.Count; `?\$index\+\+\) { Unwrap-CleanupFailureWin32Exception `?\$cleanupFailures\[`?\$index\] `?\$index }\)/,
      );
      assert.match(
        fixtureSource,
        /`?\$jobCleanupFailures = @\(`?\$unwrappedCleanupFailures \| Where-Object { `?\$_\.Root\.Message -ceq "TerminateJobObject failed" -and `?\$_\.Root\.NativeErrorCode -eq 87 }\)/,
      );
      assert.match(
        fixtureSource,
        /`?\$processCleanupFailures = @\(`?\$unwrappedCleanupFailures \| Where-Object { `?\$_\.Root\.Message -ceq "TerminateProcess failed" -and `?\$_\.Root\.NativeErrorCode -eq 5 }\)/,
      );
      assert.match(
        fixtureSource,
        /VEM_VISION_LAUNCHER_FIXTURE_FORCE_TERMINATE_FAILURE/,
      );
      assert.match(fixtureSource, /TerminateJobObjectForFixture/);
      assert.match(fixtureSource, /TerminateProcessForFixture/);
      assert.match(
        fixtureSource,
        /VEM_VISION_LAUNCHER_FIXTURE_FORCE_NATIVE_TERMINATE_FALSE/,
      );
    },
  );

  boundedIt(
    "makes every post-start failure fixture observe its started process tree",
    () => {
      const fixtureSource = readFileSync(fixture, "utf8");
      assert.match(fixtureSource, /New-FixturePostStartFailure/);
      assert.match(fixtureSource, /Get-FixturePostStartFailureMessage/);
      assert.match(fixtureSource, /Wait-FixtureRuntimeIdentities/);
      assert.match(
        fixtureSource,
        /fixture runtime did not record parent and child process identities/,
      );
      assert.match(fixtureSource, /launcher fixture identity wait timed out/);
      assert.match(fixtureSource, /Assert-FixtureRuntimeIdentitiesStopped/);
      assert.match(
        fixtureSource,
        /aggregate failure fixture runner did not collect parent and child process identities/,
      );
      assert.match(
        fixtureSource,
        /aggregate failure fixture runner did not report the collected parent and child process identities/,
      );
      assert.match(
        fixtureSource,
        /Assert-FixtureRuntimeIdentitiesStopped "selection-reread-and-cleanup"/,
      );
      assert.match(fixtureSource, /function Add-FixturePostStartFailure/);
      assert.match(
        fixtureSource,
        /\$Failure -in @\("selection-reread", "hash", "record-write", "selection-reread-and-cleanup", "selection-reread-job-terminated-native-race"\)/,
      );
      assert.match(
        fixtureSource,
        /Add-FixturePostStartFailure \$executionLauncher \$Failure/,
      );
      assert.match(
        fixtureSource,
        /\$message = Get-FixturePostStartFailureMessage \$Failure/,
      );
      assert.match(
        fixtureSource,
        /Get-FixturePostStartFailureMessage \$failure/,
      );
      assert.match(fixtureSource, /Get-FixtureCapturedText/);
      assert.match(
        fixtureSource,
        /launcher failure fixture did not preserve the injected \$expectedFailureMessage failure/,
      );
      assert.match(fixtureSource, /launcher failure fixture passed: \{0\}/);
      assert.match(fixtureSource, /captured output:/);
      assert.match(
        fixtureSource,
        /launcher aggregate failure fixture committed a process record/,
      );
      assert.match(fixtureSource, /selection-reread-and-cleanup/);
      assert.match(
        fixtureSource,
        /selection-reread-job-terminated-native-race/,
      );
      assert.match(
        fixtureSource,
        /launcher race fixture did not preserve the injected selection reread failure/,
      );
      assert.match(
        fixtureSource,
        /launcher race fixture unexpectedly reported cleanup failure/,
      );
      assert.match(
        fixtureSource,
        /Assert-FixtureRuntimeIdentitiesStopped "selection-reread-job-terminated-native-race"/,
      );
    },
  );

  boundedIt(
    "keeps generated post-start failure fixtures parseable by Windows PowerShell",
    () => {
      const fixtureSource = readFileSync(fixture, "utf8");
      assert.doesNotMatch(
        fixtureSource,
        /\(Wait-FixtureRuntimeIdentities; throw/,
      );
      assert.match(fixtureSource, /Assert-WindowsPowerShellFixtureParses/);
      assert.match(
        fixtureSource,
        /\$handshakeNeedle = '  \$record = \[ordered\]@\{'/,
      );
      assert.match(
        fixtureSource,
        /\$handshakeReplacement = "  Wait-FixtureRuntimeIdentities`n" \+ \$handshakeNeedle/,
      );
      assert.doesNotMatch(
        fixtureSource,
        /Wait-FixtureRuntimeIdentities; throw.*WriteAllText/,
      );
      assert.match(fixtureSource, /launcher fixture PS5\.1 parser passed/);
      assert.match(
        fixtureSource,
        /\$replacement = '\$\(' \+ \('throw "\{0\}"' -f \$message\) \+ '\)'/,
      );
    },
  );
});
