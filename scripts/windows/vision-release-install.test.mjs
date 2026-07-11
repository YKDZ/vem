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
  return it(name, { ...options, timeout: TEST_TIMEOUT_MS }, fn);
}

function spawnBounded(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: SPAWN_TIMEOUT_MS,
    ...options,
  });
  assert.notEqual(
    result.error?.code,
    "ETIMEDOUT",
    `${command} exceeded ${SPAWN_TIMEOUT_MS}ms`,
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
      assert.match(installer, /\$process\.Kill\(\$true\)/);
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
      assert.match(launcher, /TerminateProcessOverride/);
      assert.match(launcher, /TerminateJobObjectOverride/);
      assert.match(
        launcher,
        /throw new Win32Exception\(error, "TerminateProcess failed"\)/,
      );
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
      assert.match(harness, /\$job\.Assign\(\$process\.Handle\)/);
      assert.match(harness, /job-assigned\.signal/);
      assert.match(harness, /stdout\.log/);
      assert.match(harness, /stderr\.log/);
      assert.doesNotMatch(harness, /RedirectStandardOutput\s*=\s*\$true/);
      assert.doesNotMatch(harness, /RedirectStandardError\s*=\s*\$true/);
      assert.match(harness, /\$job\.Dispose\(\)/);
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
});
