import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const installerPath = "scripts/windows/install-vem-runtime-owners.ps1";

function source(path) {
  return readFileSync(path, "utf8");
}

test("installs the production runtime owners and emits their shared manifest", () => {
  assert.equal(
    existsSync(installerPath),
    true,
    "runtime owner installer is present",
  );

  const installer = source(installerPath);
  assert.match(installer, /VemVendingDaemon/);
  assert.match(installer, /New-Service/);
  assert.match(installer, /LocalSystem/);
  assert.match(installer, /Set-Service[\s\S]*Automatic/);
  assert.match(installer, /sc\.exe[\s\S]*failure/);
  assert.match(installer, /VEMMachineUI/);
  assert.match(installer, /VEMVisionRuntime/);
  assert.match(installer, /New-ScheduledTaskTrigger[\s\S]*AtLogOn/);
  assert.match(installer, /VEMKiosk/);
  assert.match(installer, /AutoAdminLogon/);
  assert.match(installer, /\[string\]\$KioskPassword/);
  assert.match(installer, /DefaultPassword/);
  assert.match(installer, /icacls\.exe/);
  assert.match(installer, /vem-runtime-owners\/v1/);
  assert.match(installer, /owner-manifest\.json/);
});

test("interactive owner launchers replace stale component processes without watchdogs", () => {
  const installer = source(installerPath);
  assert.match(installer, /launch-vem-machine-ui\.ps1/);
  assert.match(installer, /launch-vem-vision\.ps1/);
  assert.match(installer, /Get-CimInstance Win32_Process/);
  assert.match(installer, /Stop-Process/);
  assert.match(installer, /Diagnostics\.ProcessStartInfo/);
  assert.match(installer, /Diagnostics\.Process\]::Start/);
  assert.match(installer, /InheritedEnvironmentVariableNames/);
  assert.match(installer, /ExplicitEnvironmentVariables/);
  assert.match(installer, /-MultipleInstances Parallel/);
  assert.doesNotMatch(installer, /-MultipleInstances StopExisting/);
  assert.match(installer, /MachineUiWebViewDebugPort/);
  assert.match(installer, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/);
  assert.match(
    installer,
    /Write-InteractiveLauncher \$machineLauncher "machine\.exe" \$machineExecutable @\(\) @\(\) \$machineUiEnvironment/,
  );
  assert.match(installer, /Set-Item -LiteralPath "Env:`\$name"/);
  assert.match(installer, /EnvironmentVariables\[`\$name\]/);
  assert.doesNotMatch(installer, /Register-ObjectEvent/);
  assert.doesNotMatch(installer, /RestartOnFailure/);
  assert.doesNotMatch(installer, /while \(\$true\)/);
});

test("runtime owner probe consumes the installed owner manifest", () => {
  const probe = source("scripts/windows/probe-vem-runtime.ps1");

  assert.match(probe, /owner-manifest\.json/);
  assert.match(probe, /vem-runtime-owners\/v1/);
  assert.match(probe, /owners\.daemon/);
  assert.match(probe, /owners\.machineUi/);
  assert.match(probe, /owners\.vision/);
  assert.doesNotMatch(probe, /VEMDaemonConsole/);
  assert.match(probe, /StartVisionServer/);
  assert.match(probe, /Test-RuntimeExecutableReference/);
  assert.match(probe, /competingOwners/);
  assert.match(probe, /duplicateProcesses/);
  assert.match(probe, /unexpectedProcesses/);
  assert.match(probe, /DefaultPassword/);
  assert.match(probe, /TaskLogonTrigger/);
  assert.match(probe, /LocalSystem/);
});

test("owner installer writes one manifest through its public PowerShell entrypoint", () => {
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      "scripts/windows/install-vem-runtime-owners.windows-harness.ps1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.schemaVersion, "vem-runtime-owners-harness/v2");
  assert.equal(output.manifest.owners.daemon.name, "VemVendingDaemon");
  assert.deepEqual(output.manifest.owners.daemon.arguments, [
    "--data-dir",
    output.daemonDataDirectory,
  ]);
  assert.match(output.machineLauncher, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/);
  assert.match(output.machineLauncher, /--remote-debugging-port=9222/);
  assert.match(output.machineLauncher, /Diagnostics\.ProcessStartInfo/);
  assert.match(
    output.machineLauncher,
    /EnvironmentVariables\[\[string\]\$entry\.Key\]/,
  );
  assert.doesNotMatch(output.machineLauncher, /-ArgumentList @\(\)/);
  assert.match(output.visionLauncher, /\$startInfo\.Arguments = '"--config" "/);
  assert.match(output.visionLauncher, /VEM_AI_MODEL_PACK/);
  assert.match(output.visionLauncher, /VEM_AI_ACCEPTANCE_EVIDENCE_ROOT/);
  assert.match(output.defaultVisionLauncher, /\$explicitEnvironment = @\{\}/);
  assert.deepEqual(output.aiInputFailures, [
    "unpaired",
    "relative",
    "nonempty",
    "model-mismatch",
    "reparse",
  ]);
  assert.equal(output.parentReplacementRejected, true);
  assert.match(output.visionLauncher, /EnvironmentVariables\.Remove/);
  assert.match(source(installerPath), /CreateFileW\(path, 0x80, 1,/);
  assert.match(source(installerPath), /GetFinalPathNameByHandleW/);
  assert.equal(output.manifest.owners.machineUi.trigger, "AtLogon");
  assert.equal(output.manifest.owners.vision.trigger, "AtLogon");
  assert.equal(output.manifest.acl.length, 5);
  assert.equal(output.registeredTasks.length, 2);
  assert.equal(output.missingPasswordRejected, true);
  assert.equal(output.globalOwnerScanRemoved, true);
  assert.equal(output.aclCalls.length, 5);
  assert.deepEqual(
    output.registeredTasks.map((task) => task.trigger.kind),
    ["AtLogon", "AtLogon"],
  );
  assert.deepEqual(
    output.registeredTasks.map((task) => task.principal.UserId),
    ["VEMKiosk", "VEMKiosk"],
  );
  assert.ok(
    output.scCalls.some(
      (call) =>
        call.includes("obj=") &&
        call.includes("LocalSystem") &&
        call.includes("start=") &&
        call.includes("auto"),
    ),
  );
  assert.ok(
    output.registryWrites.some((write) => write.name === "DefaultPassword"),
  );
});

test("field probe rejects incomplete or competing installed owner definitions", () => {
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      "scripts/windows/probe-vem-runtime.windows-harness.ps1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.schemaVersion, "vem-runtime-probe-harness/v1");
  assert.equal(output.visionMainCount, 1);
  assert.equal(output.visionWorkerCount, 2);
  assert.deepEqual(output.topologyCases, [
    {
      name: "second-listener",
      topologyIssue: "multiple-listeners",
      visionDuplicateCount: 1,
    },
    {
      name: "canonical-sibling",
      topologyIssue: "canonical-sibling",
      visionDuplicateCount: 1,
    },
    {
      name: "wrong-worker-parent",
      topologyIssue: "worker-parent-drift",
      visionDuplicateCount: 1,
    },
    {
      name: "missing-worker-token",
      topologyIssue: "worker-fork-token-missing",
      visionDuplicateCount: 1,
    },
    {
      name: "duplicate-canonical-pid",
      topologyIssue: "canonical-pid-duplicate",
      visionDuplicateCount: 1,
    },
    {
      name: "wrong-main-config",
      topologyIssue: "main-config-drift",
      visionDuplicateCount: 1,
    },
    {
      name: "noncanonical-listener",
      topologyIssue: "listener-owner-noncanonical",
      visionDuplicateCount: 0,
    },
  ]);
  assert.equal(output.baselineFixtureUnchanged, true);
  assert.deepEqual(output.reversedTopologyCases, output.topologyCases);
  assert.deepEqual(output.requireHealthyFailures, [
    "non-localsystem-service",
    "unexpected-service-path",
    "missing-password",
    "missing-logon-trigger",
    "unexpected-task-action",
    "task-restart-policy",
    "legacy-vision-owner",
    "legacy-runtime-task-owner",
    "legacy-runtime-service-owner",
    "non-interactive-session",
    "unexpected-process-user",
    "invalid-vision-topology",
  ]);
});
