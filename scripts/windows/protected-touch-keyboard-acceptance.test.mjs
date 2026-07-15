import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

function validationFixture() {
  const sha256 = "a".repeat(64);
  return {
    host: { computerName: "DESKTOP-2STVS5B" },
    artifact: {
      path: "C:\\VEM\\bringup\\machine.exe",
      sizeBytes: 123456,
      sha256,
    },
    liveRuntime: {
      machineProcess: {
        processId: 500,
        sessionId: 3,
        sessionUser: "VEMKiosk",
      },
      cdpListener: {
        processId: 600,
        sessionId: 3,
        machineAncestorProcessId: 500,
        bound: true,
      },
      cdpTarget: {
        id: "tauri-target",
        url: "http://tauri.localhost/#/bring-up",
      },
    },
    runtimeAcceptance: {
      target: { machineCode: "VEM-TESTBED-WINVM-01" },
      artifacts: { machineUiSha256: sha256 },
      kioskRuntime: {
        webviewRunning: true,
        sessionUser: "VEMKiosk",
        sessionId: 3,
        processId: 500,
        cdpAvailable: true,
        cdpListenerProcessId: 600,
        cdpListenerSessionId: 3,
        cdpMachineAncestorProcessId: 500,
        cdpTargetId: "tauri-target",
        url: "http://tauri.localhost/#/bring-up",
      },
      result: { runtimeReady: { status: "passed", asserted: true } },
    },
    delivery: {
      manifestPath: "C:\\VEM\\updates\\touch-keyboard\\managed-update.json",
      evidencePath:
        "C:\\VEM\\updates\\touch-keyboard\\managed-update-evidence.json",
      manifest: {
        updateId: "touch-keyboard-acceptance",
        sourceCommit: "5".repeat(40),
        components: [
          {
            component: "ui",
            targetPath: "C:\\VEM\\bringup\\machine.exe",
            sha256,
          },
        ],
      },
      evidence: {
        ok: true,
        updateId: "touch-keyboard-acceptance",
        manifestPath: "C:\\VEM\\updates\\touch-keyboard\\managed-update.json",
        host: "DESKTOP-2STVS5B",
        components: [
          {
            component: "ui",
            targetPath: "C:\\VEM\\bringup\\machine.exe",
            expectedSha256: sha256,
            installedSha256: sha256,
            ok: true,
          },
        ],
      },
    },
  };
}

function validateFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), "vem-touch-keyboard-"));
  const fixturePath = join(root, "fixture.json");
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      "scripts/windows/accept-protected-touch-keyboard.ps1",
      "-ValidateFixturePath",
      fixturePath,
    ],
    { encoding: "utf8" },
  );
  rmSync(root, { recursive: true, force: true });
  return result;
}

test("Windows touch-keyboard acceptance plan binds the interactive kiosk and protected routes", () => {
  const result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-File",
      "scripts/windows/accept-protected-touch-keyboard.ps1",
      "-PrintPlan",
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(
    plan.schemaVersion,
    "protected-touch-keyboard-acceptance-plan/v1",
  );
  assert.equal(plan.requiredSessionUser, "VEMKiosk");
  assert.deepEqual(plan.allowedRoutes, ["bring-up", "maintenance"]);
  assert.deepEqual(plan.deniedRoutes, [
    "boot",
    "catalog",
    "checkout",
    "payment",
    "dispensing",
    "result",
  ]);
  assert.deepEqual(
    plan.observations.map((observation) => observation.code),
    [
      "bring_up_touch_entry",
      "bring_up_native_submit",
      "maintenance_unauthorized_denied",
      "maintenance_authorized_touch_entry",
      "customer_route_denied",
      "physical_keyboard_preserved",
    ],
  );
});

test("Windows touch-keyboard evidence accepts aligned authoritative runtime and delivery facts", () => {
  const result = validateFixture(validationFixture());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: "passed",
    sourceCommit: "5".repeat(40),
    machineUiSha256: "a".repeat(64),
    machineProcessId: 500,
    cdpListenerProcessId: 600,
    sessionId: 3,
  });
});

test("Windows touch-keyboard evidence rejects fake CDP, process, session, and source facts", () => {
  const mutations = [
    (fixture) => {
      fixture.runtimeAcceptance.kioskRuntime.cdpTargetId = "fake-target";
    },
    (fixture) => {
      fixture.runtimeAcceptance.kioskRuntime.processId = 999;
    },
    (fixture) => {
      fixture.liveRuntime.cdpListener.sessionId = 4;
    },
    (fixture) => {
      fixture.delivery.manifest.sourceCommit = "unbound-source";
    },
  ];

  for (const mutate of mutations) {
    const fixture = validationFixture();
    mutate(fixture);
    const result = validateFixture(fixture);
    assert.notEqual(result.status, 0, result.stdout);
  }
});
