import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const installerPath = "scripts/windows/install-vem-runtime-owners.ps1";

interface OwnerHarnessOutput {
  schemaVersion: string;
  manifest: {
    owners: {
      daemon: { name: string; arguments: string[] };
      machineUi: { trigger: string };
      vision: { trigger: string };
    };
    acl: unknown[];
  };
  daemonDataDirectory: string;
  machineLauncher: string;
  visionLauncher: string;
  registeredTasks: Array<{
    trigger: { kind: string };
    principal: { UserId: string };
    settings: { StartWhenAvailable: boolean; MultipleInstances: string };
  }>;
  missingPasswordRejected: boolean;
  aclCalls: string[];
  scCalls: string[];
  registryWrites: Array<{ name: string }>;
  reentryResults: Array<{
    adapter: string;
    status: string;
    reasonCode: string;
    processId: number;
    invocationId: string;
  }>;
  transientReentry: {
    status: string;
    reasonCode: string;
    processId: number;
  };
}

function source(path: string): string {
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

test("interactive owner launchers converge reentry without replacing a healthy owner", () => {
  const installer = source(installerPath);
  assert.match(installer, /launch-vem-machine-ui\.ps1/);
  assert.match(installer, /launch-vem-vision\.ps1/);
  assert.match(installer, /Get-CimInstance Win32_Process/);
  assert.match(installer, /Diagnostics\.ProcessStartInfo/);
  assert.match(installer, /Diagnostics\.Process\]::Start/);
  assert.match(installer, /Threading\.Mutex/);
  assert.match(installer, /WaitOne/);
  assert.match(installer, /vem-runtime-owner-launch-result\/v1/);
  assert.match(installer, /owner_already_ready/);
  assert.match(installer, /InheritedEnvironmentVariableNames/);
  assert.match(installer, /ExplicitEnvironmentVariables/);
  assert.match(installer, /-MultipleInstances IgnoreNew/);
  assert.doesNotMatch(installer, /-MultipleInstances Parallel/);
  assert.doesNotMatch(installer, /-MultipleInstances StopExisting/);
  assert.doesNotMatch(installer, /Stop-Process/);
  assert.match(installer, /MachineUiWebViewDebugPort/);
  assert.match(installer, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/);
  assert.match(installer, /-Role "machine-ui"/);
  assert.match(installer, /-Role "vision"/);
  assert.match(installer, /-ReadinessPort \$MachineUiWebViewDebugPort/);
  assert.match(installer, /-ReadinessPort 7892/);
  assert.match(installer, /"descendant_listener"/);
  assert.match(installer, /"direct_listener"/);
  assert.match(installer, /Test-ListenerOwnership/);
  assert.match(installer, /Set-Item -LiteralPath "Env:`\$name"/);
  assert.match(installer, /EnvironmentVariables\[`\$name\]/);
  assert.doesNotMatch(installer, /Register-ObjectEvent/);
  assert.doesNotMatch(installer, /RestartOnFailure/);
  assert.doesNotMatch(installer, /while \(\$true\)/);
});

test("interactive owner launchers do not query listener ownership before a process exists", () => {
  const installer = source(installerPath);
  const readiness = installer.slice(
    installer.indexOf("function Get-ReadyOwnerProcess"),
    installer.indexOf(
      "try {",
      installer.indexOf("function Get-ReadyOwnerProcess"),
    ),
  );
  const emptyOwnerGuard = readiness.indexOf(
    "if (`$canonical.Count -eq 0) { return `$null }",
  );
  const listenerProbe = readiness.indexOf("Get-NetTCPConnection");

  assert.ok(emptyOwnerGuard >= 0, "launcher omitted its empty-owner fast path");
  assert.ok(
    emptyOwnerGuard < listenerProbe,
    "launcher queried the listener before ruling out an owner process",
  );
});

test("registering an owner does not replay an already-missed logon", () => {
  const installer = source(installerPath);
  const registration = installer.slice(
    installer.indexOf("function Register-InteractiveOwnerTask"),
    installer.indexOf("function Assert-NoDuplicateRuntimeProcesses"),
  );

  assert.doesNotMatch(registration, /-StartWhenAvailable/);
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
  const output = JSON.parse(result.stdout) as OwnerHarnessOutput;
  assert.equal(output.schemaVersion, "vem-runtime-owners-harness/v3");
  assert.equal(output.manifest.owners.daemon.name, "VemVendingDaemon");
  assert.deepEqual(output.manifest.owners.daemon.arguments, [
    "--data-dir",
    output.daemonDataDirectory,
  ]);
  assert.match(output.machineLauncher, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/);
  assert.match(output.machineLauncher, /--remote-debugging-port=9222/);
  assert.match(output.machineLauncher, /Diagnostics\.ProcessStartInfo/);
  assert.match(output.machineLauncher, /Threading\.Mutex/);
  assert.match(
    output.machineLauncher,
    /schemaVersion = "vem-runtime-owner-launch-result\/v1"/,
  );
  assert.match(
    output.machineLauncher,
    /New-OwnerLaunchResult "ready" \$null "owner_already_ready"/,
  );
  assert.doesNotMatch(output.machineLauncher, /Stop-Process/);
  assert.match(
    output.machineLauncher,
    /EnvironmentVariables\[\[string\]\$entry\.Key\]/,
  );
  assert.doesNotMatch(output.machineLauncher, /-ArgumentList @\(\)/);
  assert.match(output.visionLauncher, /\$startInfo\.Arguments = '"--config" "/);
  assert.doesNotMatch(
    output.visionLauncher,
    new RegExp(["VEM", "AI"].join("_") + "_"),
  );
  assert.match(source(installerPath), /CreateFileW\(path, 0x80, 1,/);
  assert.match(source(installerPath), /GetFinalPathNameByHandleW/);
  assert.equal(output.manifest.owners.machineUi.trigger, "AtLogon");
  assert.equal(output.manifest.owners.vision.trigger, "AtLogon");
  assert.equal(output.manifest.acl.length, 5);
  assert.equal(output.registeredTasks.length, 3);
  assert.equal(output.missingPasswordRejected, true);
  assert.equal(output.aclCalls.length, 5);
  const ownerTasks = output.registeredTasks.slice(0, 2);
  assert.deepEqual(
    ownerTasks.map((task) => task.trigger.kind),
    ["AtLogon", "AtLogon"],
  );
  assert.deepEqual(
    ownerTasks.map((task) => task.principal.UserId),
    ["VEMKiosk", "VEMKiosk"],
  );
  assert.deepEqual(
    ownerTasks.map((task) => task.settings.MultipleInstances),
    ["IgnoreNew", "IgnoreNew"],
  );
  assert.deepEqual(
    ownerTasks.map((task) => task.settings.StartWhenAvailable),
    [false, false],
  );
  const watchdogTasks = output.registeredTasks.slice(2);
  assert.equal(watchdogTasks.length, 1);
  assert.equal(watchdogTasks[0].principal.UserId, "SYSTEM");
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
  assert.deepEqual(
    output.reentryResults.map((result) => ({
      adapter: result.adapter,
      status: result.status,
      reasonCode: result.reasonCode,
      processId: result.processId,
    })),
    [
      {
        adapter: "manual",
        status: "ready",
        reasonCode: "owner_already_ready",
        processId: 4101,
      },
      {
        adapter: "manual",
        status: "ready",
        reasonCode: "owner_already_ready",
        processId: 4101,
      },
    ],
  );
  assert.notEqual(
    output.reentryResults[0].invocationId,
    output.reentryResults[1].invocationId,
  );
  assert.deepEqual(
    {
      status: output.transientReentry.status,
      reasonCode: output.transientReentry.reasonCode,
      processId: output.transientReentry.processId,
    },
    {
      status: "ready",
      reasonCode: "owner_already_ready",
      processId: 4101,
    },
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
  assert.equal(output.bootedAt, "2026-08-24T12:05:00.000Z");
  assert.deepEqual(output.taskObservations, [
    {
      name: "VEMMachineUI",
      state: "Ready",
      lastRunTime: "2026-08-24T12:05:08.000Z",
      lastTaskResult: 0,
      multipleInstances: "IgnoreNew",
    },
    {
      name: "VEMVisionRuntime",
      state: "Ready",
      lastRunTime: "2026-08-24T12:05:09.000Z",
      lastTaskResult: 0,
      multipleInstances: "IgnoreNew",
    },
  ]);
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
    "parallel-task-reentry",
    "legacy-vision-owner",
    "legacy-runtime-task-owner",
    "legacy-runtime-service-owner",
    "non-interactive-session",
    "unexpected-process-user",
    "invalid-vision-topology",
  ]);
});

test("kiosk shell hardening replaces the kiosk shell and disables edge swipe", () => {
  const result = spawnSync(
    "pwsh",
    ["-NoProfile", "-File", "scripts/windows/kiosk-shell.windows-harness.ps1"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as {
    schemaVersion: string;
    install: {
      edgeSwipeDisabled: boolean;
      hiveLoaded: boolean;
      hiveUnloaded: boolean;
      shellUsesHolder: boolean;
    };
    disable: { edgePolicyRemoved: boolean; shellRestored: boolean };
  };
  assert.equal(output.schemaVersion, "vem-kiosk-shell-harness/v1");
  assert.equal(output.install.edgeSwipeDisabled, true);
  assert.equal(output.install.hiveLoaded, true);
  assert.equal(output.install.hiveUnloaded, true);
  assert.equal(output.install.shellUsesHolder, true);
  assert.equal(output.install.expectationWritten, true);
  assert.equal(output.disable.edgePolicyRemoved, true);
  assert.equal(output.disable.shellRestored, true);
  assert.equal(output.disable.expectationRemoved, true);
});

test("runtime watchdog decides the tailnet offline escape from a pure table", () => {
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      "scripts/windows/watchdog-decision.windows-harness.ps1",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout) as {
    schemaVersion: string;
    allMatched: boolean;
    cases: Array<{ name: string; actual: string; expected: string }>;
  };
  assert.equal(output.schemaVersion, "vem-watchdog-decision-harness/v1");
  assert.equal(output.allMatched, true);
  assert.deepEqual(
    output.cases.map((entry) => [entry.name, entry.actual]),
    [
      ["not-installed", "not-applicable"],
      ["online", "online"],
      ["offline-arms", "arm"],
      ["offline-waits", "wait"],
      ["offline-escapes", "escape"],
    ],
  );
});

test("runtime owner installer wires kiosk shell hardening and the probe reports it", () => {
  const installer = source(installerPath);
  const probe = source("scripts/windows/probe-vem-runtime.ps1");

  assert.match(installer, /Install-KioskShell/);
  assert.match(installer, /kiosk-shell-holder\.ps1/);
  assert.match(installer, /set-vem-kiosk-shell\.ps1/);
  assert.match(installer, /holderPath = \$KioskShellHolder/);
  assert.match(probe, /Get-KioskShellState/);
  assert.match(probe, /AllowEdgeSwipe/);
  assert.match(probe, /RequireKioskShell/);
});
