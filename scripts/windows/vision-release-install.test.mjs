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
    "captures PowerShell 5.1 stdout and non-terminating stderr through the bounded native process",
    { skip: process.platform !== "win32", timeout: 120_000 },
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
. (Join-Path (Get-Location) "scripts\\windows\\vision-release-install.windows-harness.ps1") -Library
Initialize-HarnessNativeTypes
$root = Join-Path ([IO.Path]::GetTempPath()) ("vem-vision-node-streams-" + [guid]::NewGuid().ToString("N"))
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $script:HarnessSuspendedProcessWatchdogPath = Initialize-HarnessSuspendedProcessWatchdog -HarnessRoot $root
  $contextPath = Join-Path $root "context.json"
  Write-Json $contextPath ([ordered]@{ root=$root; stateRoot=(Join-Path $root "state"); bundleDigest="sha256:node-streams" })
  $childPowerShellPath = Join-Path $PSHOME "powershell.exe"
  $deadlineUtc = [DateTime]::UtcNow.AddSeconds(70)

  $clean = Invoke-BoundedPowerShell -Stage "node.ps51-streams-clean" -TimeoutSeconds 20 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $childPowerShellPath -HarnessDeadlineUtc $deadlineUtc -ScriptBody @'
$ErrorActionPreference = "Stop"
Write-Output ps51-stdout
Write-Error "VEM_VISION_HARNESS_PS51_STDERR" -ErrorAction Continue
exit 0
'@
  if ($clean.stdout.Trim() -cne "ps51-stdout") { throw "bounded PS5.1 invocation did not capture stdout: $($clean.stdout)" }
  if ($clean.stderr -notmatch "(?m)(?<!\S)VEM_VISION_HARNESS_PS51_STDERR(?!\S)") { throw "bounded PS5.1 invocation did not capture its non-terminating stderr marker: $($clean.stderr)" }
  if (-not (Test-Path -LiteralPath (Join-Path $clean.diagnosticsPath "stdout.log") -PathType Leaf)) { throw "bounded PS5.1 invocation did not retain stdout diagnostics" }
  if (-not (Test-Path -LiteralPath (Join-Path $clean.diagnosticsPath "stderr.log") -PathType Leaf)) { throw "bounded PS5.1 invocation did not retain stderr diagnostics" }

  $failure = $null
  try {
    Invoke-BoundedPowerShell -Stage "node.ps51-streams-nonzero" -TimeoutSeconds 20 -HarnessRoot $root -HarnessContextPath $contextPath -ChildPowerShellPath $childPowerShellPath -HarnessDeadlineUtc $deadlineUtc -ScriptBody @'
$ErrorActionPreference = "Stop"
Write-Output nonzero-stdout
Write-Error "VEM_VISION_HARNESS_PS51_NONZERO_STDERR" -ErrorAction Continue
exit 23
'@ | Out-Null
  } catch {
    $failure = $_.Exception.Message
  }
  if ([string]::IsNullOrWhiteSpace($failure)) { throw "bounded PS5.1 nonzero invocation did not fail" }
  foreach ($expectedDiagnostic in @("exit code 23", "command=", "nonzero-stdout")) {
    if ($failure -notmatch [regex]::Escape($expectedDiagnostic)) { throw "bounded PS5.1 nonzero invocation omitted diagnostic '$expectedDiagnostic': $failure" }
  }
  if ($failure -notmatch "(?m)(?<!\S)VEM_VISION_HARNESS_PS51_NONZERO_STDERR(?!\S)") { throw "bounded PS5.1 nonzero invocation omitted its stderr marker: $failure" }
} finally {
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
`;
      const result = spawnBounded(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          probe,
        ],
        { timeout: 90_000 },
      );
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    },
  );

  boundedIt(
    "captures and mirrors behavior fault telemetry from the Information stream on Windows",
    { skip: process.platform !== "win32" },
    () => {
      const probe = String.raw`
$ErrorActionPreference = "Stop"
$behaviorPath = Join-Path (Get-Location) "scripts\\windows\\vision-release-install-harness.behavior.ps1"
$harnessPath = Join-Path (Get-Location) "scripts\\windows\\vision-release-install.windows-harness.ps1"
. $behaviorPath -HarnessPath $harnessPath -Library
$marker = "VEM_VISION_HARNESS_INFORMATION_MIRROR_" + [guid]::NewGuid().ToString("N")
$records = New-Object 'System.Collections.Generic.List[object]'
& { Write-Host $marker } 6>&1 | ForEach-Object {
  [void]$records.Add($_)
  Write-FaultTelemetryRecordToHost $_
}
if ($records.Count -ne 1) { throw "expected one captured Information record, got $($records.Count)" }
if ($records[0] -isnot [Management.Automation.InformationRecord]) { throw "captured record is not InformationRecord: $($records[0].GetType().FullName)" }
if ([string]$records[0].MessageData -cne $marker) { throw "captured Information record changed: $($records[0].MessageData)" }
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
      const marker = result.stdout.match(
        /VEM_VISION_HARNESS_INFORMATION_MIRROR_[0-9a-f]+/g,
      );
      assert.equal(
        marker?.length,
        1,
        `Information telemetry was not mirrored exactly once: ${result.stdout}`,
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
      assert.match(harness, /TerminateUnresumed/);
      assert.match(harness, /\$job\.Assign\(\$nativeProcess\.ProcessHandle\)/);
      assert.match(harness, /\$nativeProcess\.Resume\(\)/);
      assert.match(harness, /\$nativeProcess\.TerminateUnresumed/);
      assert.match(harness, /stdout\.log/);
      assert.match(harness, /stderr\.log/);
      assert.doesNotMatch(harness, /RedirectStandardOutput\s*=\s*\$true/);
      assert.doesNotMatch(harness, /RedirectStandardError\s*=\s*\$true/);
      assert.match(harness, /\$Job\.Dispose\(\)/);
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
    "keeps behavior fault telemetry transcript-free and hard watchdogs bound to inherited handles",
    () => {
      const behavior = readFileSync(behaviorHarness, "utf8");
      const harness = readFileSync(windowsHarness, "utf8");
      const faultLoop = behavior.match(
        /\$faultRecords = New-Object 'System\.Collections\.Generic\.List\[object\]'([\s\S]*?)\n    if \(\$fault\.expectedOwnership/,
      )?.[1];

      assert.ok(faultLoop, "behavior fault telemetry capture is missing");
      assert.match(
        faultLoop,
        /Invoke-BoundedPowerShell[\s\S]*?6>&1\s*\|\s*ForEach-Object\s*\{\s*\[void\]\$faultRecords\.Add\(\$_\)\s*Write-FaultTelemetryRecordToHost \$_\s*\}/,
      );
      assert.match(
        faultLoop,
        /\[Management\.Automation\.InformationRecord\][\s\S]*?\.MessageData/,
      );
      assert.doesNotMatch(faultLoop, /Start-Transcript|Stop-Transcript/);
      assert.match(
        behavior,
        /function Write-FaultTelemetryRecordToHost\(\[object\]\$Record\)\s*\{[\s\S]*?\$Host\.UI\.WriteLine\(\$message\)/,
      );
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
        /Write-HarnessStage "behavior\.hard-watchdog" "host-termination-confirmed"/,
      );
      assert.doesNotMatch(behavior, /\$hardWatchdogHost\.WaitForExit\(/);
      assert.doesNotMatch(behavior, /\$hardWatchdogHost\.HasExited/);
      const inheritedWatchdog = harness.match(
        /public static class SuspendedProcessWatchdog \{([\s\S]*?)\r?\n  \}\r?\n}\r?\n'@/,
      )?.[1];
      assert.ok(
        inheritedWatchdog,
        "inherited-handle watchdog source is missing",
      );
      assert.doesNotMatch(inheritedWatchdog, /OpenProcess/);
      assert.doesNotMatch(inheritedWatchdog, /GetProcessById/);
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
    "atomically overwrites an existing watchdog signal with Windows PowerShell 5.1",
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
  Write-HarnessAtomicUtf8 -Path $path -Text "new"
  if ((Get-Content -LiteralPath $path -Raw -Encoding UTF8) -cne "new") { throw "atomic write did not replace an existing target" }
  if (@(Get-ChildItem -LiteralPath $root -Force | Where-Object { $_.Name -like ".command.*.tmp" }).Count -ne 0) { throw "atomic write left a temporary file" }
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

  boundedIt("keeps watchdog helper output contracts explicit", () => {
    const harness = readFileSync(windowsHarness, "utf8");

    assert.match(
      harness,
      /function Start-HarnessSuspendedProcessWatchdog[\s\S]*?\[void\]\(\$WatchdogReference\.Value = \$watchdog\)[\s\S]*?return/,
    );
    const startFunction = harness.match(
      /function Start-HarnessSuspendedProcessWatchdog \{([\s\S]*?)\r?\n\}\r?\nfunction Get-HarnessSuspendedProcessWatchdogCompletion/,
    )?.[1];
    assert.ok(startFunction, "watchdog start helper is missing");
    assert.doesNotMatch(startFunction, /Write-Output/);
    assert.match(
      harness,
      /function Complete-HarnessSuspendedProcessWatchdogTerminal[\s\S]*?Close-HarnessSuspendedProcessWatchdog -Watchdog \$Watchdog \| Out-Null[\s\S]*?Write-Output -NoEnumerate \$Completion/,
    );
    assert.match(
      harness,
      /function Write-HarnessAtomicUtf8[\s\S]*?Initialize-HarnessNativeTypes \| Out-Null[\s\S]*?Remove-Item[^\r\n]*\| Out-Null/,
    );
  });

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
    "extends a live watchdog termination deadline after its first command times out",
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
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $gatePath = Join-Path $root "allow-terminate"
  $env:VEM_VISION_HARNESS_FIXTURE_WATCHDOG_TERMINATE_GATE_PATH = $gatePath
  $watchdogPath = Initialize-HarnessSuspendedProcessWatchdog -HarnessRoot $root
  $powerShellPath = Get-Command pwsh -CommandType Application | Select-Object -First 1 -ExpandProperty Source
  $nativeProcess = [VemVisionHarness.SuspendedProcess]::Create($powerShellPath, [string[]]@("-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"), $root)
  Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "stage") -WatchdogPath $watchdogPath -NativeProcess $nativeProcess -DeadlineUtc ([DateTime]::UtcNow.AddSeconds(10)) -Watchdog ([ref]$watchdog) | Out-Null

  $firstDeadlineUtc = [DateTime]::UtcNow.AddMilliseconds(250)
  $firstFailure = $null
  try { Complete-HarnessSuspendedProcessWatchdog -Watchdog $watchdog -Action "terminate" -DeadlineUtc $firstDeadlineUtc | Out-Null } catch { $firstFailure = $_.Exception.Message }
  if ($firstFailure -notmatch "did not complete 'terminate' before the cleanup deadline") { throw "first watchdog command did not time out: $firstFailure" }
  $firstCommand = (Get-Content -LiteralPath $watchdog.commandPath -Raw -Encoding UTF8).Trim()
  if ($firstCommand -notmatch "^terminate:([0-9]+)$") { throw "first watchdog command was invalid: $firstCommand" }
  [Int64]$firstTicks = $Matches[1]
  if ($watchdog.disposed -or $watchdog.completed -or (Test-Path -LiteralPath $watchdog.completionPath -PathType Leaf)) { throw "watchdog stopped after its first command timed out" }

  New-Item -ItemType File -Path $gatePath | Out-Null
  $extendedDeadlineUtc = [DateTime]::UtcNow.AddSeconds(4)
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
    $watchdogProcessId = $watchdog.process.Id
    $confirmationDeadlineUtc = [DateTime]::UtcNow.AddMilliseconds(1500)
    $parentDeadlineUtc = [DateTime]::UtcNow.AddSeconds(4)
    Write-HarnessAtomicUtf8 $watchdog.commandPath ("terminate:" + $confirmationDeadlineUtc.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)) | Out-Null
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
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $completionPath = Join-Path $root "completion"
  [IO.File]::WriteAllText($completionPath, "termin", [Text.UTF8Encoding]::new($false))
  $partialWatchdog = [pscustomobject]@{ completionPath=$completionPath }
  if ($null -ne (Get-HarnessSuspendedProcessWatchdogCompletion -Watchdog $partialWatchdog)) { throw "partial completion was consumed as a terminal state" }

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
$watchdog = $null
try {
  New-Item -ItemType Directory -Force -Path $root | Out-Null
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = (Get-Command pwsh -CommandType Application | Select-Object -First 1 -ExpandProperty Source)
  $startInfo.Arguments = '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"'
  $startInfo.UseShellExecute = $false
  $child = [Diagnostics.Process]::Start($startInfo)
  $nativeProcess = [pscustomobject]@{ ProcessId=4243; child=$child }
  $nativeProcess | Add-Member -MemberType ScriptMethod -Name StartInheritedHandleWatchdog -Value { param($watchdogPath, $arguments, $workingDirectory) Start-Sleep -Milliseconds 350; return $this.child.Id }
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  $failure = $null
  try { Start-HarnessSuspendedProcessWatchdog -StageRoot (Join-Path $root "stage") -WatchdogPath "unused" -NativeProcess $nativeProcess -DeadlineUtc ([DateTime]::UtcNow.AddMilliseconds(650)) -Watchdog ([ref]$watchdog) | Out-Null } catch { $failure = $_.Exception.Message }
  $stopwatch.Stop()
  if ($failure -notmatch "did not inherit") { throw "slow watchdog start did not fail readiness: $failure" }
  if ($stopwatch.ElapsedMilliseconds -ge 620) { throw "slow watchdog readiness exceeded its absolute deadline budget: $($stopwatch.ElapsedMilliseconds)ms" }
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
  $nativeProcess | Add-Member -MemberType ScriptMethod -Name StartInheritedHandleWatchdog -Value { param($watchdogPath, $arguments, $workingDirectory) return $this.child.Id }
  $failure = $null
  try { Start-HarnessSuspendedProcessWatchdog -StageRoot $stageRoot -WatchdogPath "unused" -NativeProcess $nativeProcess -DeadlineUtc ([DateTime]::UtcNow.AddMilliseconds(800)) -Watchdog ([ref]$watchdog) | Out-Null } catch { $failure = $_.Exception.Message }
  if ([string]::IsNullOrWhiteSpace($failure) -or $failure -notmatch "did not inherit") { throw "stale ready signal was accepted: $failure" }
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
      assert.match(harness, /File\.WriteAllText\(temporaryPath, value\)/);
      assert.match(
        harness,
        /MoveFileExW\(temporaryPath, path, MOVEFILE_REPLACE_EXISTING \| MOVEFILE_WRITE_THROUGH\)/,
      );
      assert.match(
        harness,
        /\[VemVisionHarness\.AtomicFile\]::Replace\(\$temporaryPath, \$Path\)/,
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
        harness,
        /\$readyDeadlineUtc = \$DeadlineUtc\.AddMilliseconds\(-\$setupCleanupReserveMilliseconds\)/,
      );
      assert.match(
        behavior,
        /watchdog inherited-handle probe observed ERROR_INVALID_HANDLE/,
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
