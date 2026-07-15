import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const MACHINE_UI_TARGET = "C:\\VEM\\bringup\\machine.exe";
const DAEMON_TARGET = "C:\\VEM\\bringup\\vending-daemon.exe";
const WEBVIEW_SIDECAR_TARGET = "C:\\VEM\\bringup\\WebView2Loader.dll";
const LIVE_FILE_CONTENTS = {
  [MACHINE_UI_TARGET]: Buffer.from("machine-ui-live-bytes"),
  [DAEMON_TARGET]: Buffer.from("daemon-live-bytes"),
  [WEBVIEW_SIDECAR_TARGET]: Buffer.from("webview-sidecar-live-bytes"),
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

const MACHINE_UI_SHA256 = sha256(LIVE_FILE_CONTENTS[MACHINE_UI_TARGET]);
const DAEMON_SHA256 = sha256(LIVE_FILE_CONTENTS[DAEMON_TARGET]);
const WEBVIEW_SIDECAR_SHA256 = sha256(
  LIVE_FILE_CONTENTS[WEBVIEW_SIDECAR_TARGET],
);

function validationFixture() {
  const manifestSha256 = "b".repeat(64);
  const daemonComponent = {
    component: "daemon",
    targetPath: DAEMON_TARGET,
    sha256: DAEMON_SHA256,
  };
  const uiComponent = {
    component: "ui",
    targetPath: MACHINE_UI_TARGET,
    sha256: MACHINE_UI_SHA256,
    sidecars: [
      {
        targetPath: WEBVIEW_SIDECAR_TARGET,
        sha256: WEBVIEW_SIDECAR_SHA256,
      },
    ],
  };
  return {
    fixtureFiles: [
      {
        targetPath: MACHINE_UI_TARGET,
        relativePath: "live/machine.exe",
        contentBase64: LIVE_FILE_CONTENTS[MACHINE_UI_TARGET].toString("base64"),
      },
      {
        targetPath: DAEMON_TARGET,
        relativePath: "live/vending-daemon.exe",
        contentBase64: LIVE_FILE_CONTENTS[DAEMON_TARGET].toString("base64"),
      },
      {
        targetPath: WEBVIEW_SIDECAR_TARGET,
        relativePath: "live/WebView2Loader.dll",
        contentBase64:
          LIVE_FILE_CONTENTS[WEBVIEW_SIDECAR_TARGET].toString("base64"),
      },
    ],
    host: { computerName: "DESKTOP-2STVS5B" },
    artifact: {
      path: MACHINE_UI_TARGET,
      sizeBytes: LIVE_FILE_CONTENTS[MACHINE_UI_TARGET].length,
      sha256: MACHINE_UI_SHA256,
    },
    liveRuntime: {
      cdpEndpoint: "http://127.0.0.1:9222",
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
        localAddress: "127.0.0.1",
        localPort: 9222,
      },
      cdpTarget: {
        id: "tauri-target",
        url: "http://tauri.localhost/#/bring-up",
      },
    },
    runtimeAcceptance: {
      target: { machineCode: "VEM-TESTBED-WINVM-01" },
      artifacts: {
        daemonSha256: DAEMON_SHA256,
        machineUiSha256: MACHINE_UI_SHA256,
      },
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
      manifestSha256,
      evidencePath:
        "C:\\VEM\\updates\\touch-keyboard\\managed-update-evidence.json",
      manifest: {
        updateId: "touch-keyboard-acceptance",
        sourceCommit: "5".repeat(40),
        components: [daemonComponent, uiComponent],
      },
      evidence: {
        ok: true,
        updateId: "touch-keyboard-acceptance",
        manifestPath: "C:\\VEM\\updates\\touch-keyboard\\managed-update.json",
        host: "DESKTOP-2STVS5B",
        sourceBinding: {
          schemaVersion: "managed-update-source-binding/v1",
          manifestSha256,
          sourceCommit: "5".repeat(40),
          updateId: "touch-keyboard-acceptance",
          components: [daemonComponent, uiComponent],
        },
        components: [
          {
            component: "daemon",
            targetPath: DAEMON_TARGET,
            expectedSha256: DAEMON_SHA256,
            installedSha256: DAEMON_SHA256,
            ok: true,
          },
          {
            component: "ui",
            targetPath: MACHINE_UI_TARGET,
            expectedSha256: MACHINE_UI_SHA256,
            installedSha256: MACHINE_UI_SHA256,
            ok: true,
            sidecars: [
              {
                targetPath: WEBVIEW_SIDECAR_TARGET,
                expectedSha256: WEBVIEW_SIDECAR_SHA256,
                installedSha256: WEBVIEW_SIDECAR_SHA256,
              },
            ],
          },
        ],
      },
    },
  };
}

function validateFixture(fixture) {
  const root = mkdtempSync(join(tmpdir(), "vem-touch-keyboard-"));
  const fixturePath = join(root, "fixture.json");
  const fixtureFiles = fixture.fixtureFiles ?? [];
  fixture.testInstallRoot = join(root, "live");
  fixture.testFileMappings = [];
  for (const file of fixtureFiles) {
    const livePath = join(root, file.relativePath);
    mkdirSync(dirname(livePath), { recursive: true });
    if (!file.omit) {
      if (file.kind === "symlink") {
        const backingPath = `${livePath}.backing`;
        writeFileSync(backingPath, Buffer.from(file.contentBase64, "base64"));
        symlinkSync(backingPath, livePath);
      } else {
        writeFileSync(livePath, Buffer.from(file.contentBase64, "base64"));
      }
    }
    fixture.testFileMappings.push({
      targetPath: file.targetPath,
      livePath,
    });
  }
  delete fixture.fixtureFiles;
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
    machineUiSha256: MACHINE_UI_SHA256,
    machineProcessId: 500,
    cdpListenerProcessId: 600,
    sessionId: 3,
    installedComponents: [
      {
        component: "daemon",
        targetPath: DAEMON_TARGET,
        sha256: DAEMON_SHA256,
        sidecars: [],
      },
      {
        component: "ui",
        targetPath: MACHINE_UI_TARGET,
        sha256: MACHINE_UI_SHA256,
        sidecars: [
          {
            targetPath: WEBVIEW_SIDECAR_TARGET,
            sha256: WEBVIEW_SIDECAR_SHA256,
          },
        ],
      },
    ],
  });
});

test("Windows touch-keyboard evidence rejects daemon bytes that drifted after an otherwise consistent update", () => {
  const fixture = validationFixture();
  fixture.fixtureFiles.find(
    (file) => file.targetPath === DAEMON_TARGET,
  ).contentBase64 = Buffer.from("drifted-daemon-live-bytes").toString("base64");

  const result = validateFixture(fixture);

  assert.notEqual(result.status, 0, result.stdout);
});

test("Windows touch-keyboard evidence rejects live sidecar bytes that drifted after deployment", () => {
  const fixture = validationFixture();
  fixture.fixtureFiles.find(
    (file) => file.targetPath === WEBVIEW_SIDECAR_TARGET,
  ).contentBase64 = Buffer.from("drifted-webview-sidecar-bytes").toString(
    "base64",
  );

  const result = validateFixture(fixture);

  assert.notEqual(result.status, 0, result.stdout);
});

test("Windows touch-keyboard evidence rejects a consistently rewritten target outside the allowed install root", () => {
  const fixture = validationFixture();
  const escapedTarget = "C:\\Temp\\vending-daemon.exe";
  fixture.delivery.manifest.components.find(
    (component) => component.component === "daemon",
  ).targetPath = escapedTarget;
  fixture.delivery.evidence.sourceBinding.components.find(
    (component) => component.component === "daemon",
  ).targetPath = escapedTarget;
  fixture.delivery.evidence.components.find(
    (component) => component.component === "daemon",
  ).targetPath = escapedTarget;
  fixture.fixtureFiles.find(
    (file) => file.targetPath === DAEMON_TARGET,
  ).targetPath = escapedTarget;

  const result = validateFixture(fixture);

  assert.notEqual(result.status, 0, result.stdout);
});

test("Windows touch-keyboard evidence rejects a missing installed target", () => {
  const fixture = validationFixture();
  fixture.fixtureFiles.find(
    (file) => file.targetPath === WEBVIEW_SIDECAR_TARGET,
  ).omit = true;

  const result = validateFixture(fixture);

  assert.notEqual(result.status, 0, result.stdout);
});

test("Windows touch-keyboard evidence rejects a reparse-point installed target even when bytes match", () => {
  const fixture = validationFixture();
  fixture.fixtureFiles.find(
    (file) => file.targetPath === MACHINE_UI_TARGET,
  ).kind = "symlink";

  const result = validateFixture(fixture);

  assert.notEqual(result.status, 0, result.stdout);
});

test("Windows touch-keyboard evidence rejects a runtime daemon hash that drifted from live bytes", () => {
  const fixture = validationFixture();
  fixture.runtimeAcceptance.artifacts.daemonSha256 = "f".repeat(64);

  const result = validateFixture(fixture);

  assert.notEqual(result.status, 0, result.stdout);
});

test("Windows touch-keyboard evidence fails closed when runtime omits a delivered component hash", () => {
  for (const artifactName of ["daemonSha256", "machineUiSha256"]) {
    const fixture = validationFixture();
    delete fixture.runtimeAcceptance.artifacts[artifactName];
    const result = validateFixture(fixture);
    assert.notEqual(result.status, 0, result.stdout);
  }
});

test("Windows touch-keyboard evidence rejects a remote CDP endpoint even when the same local port is bound", () => {
  const fixture = validationFixture();
  fixture.liveRuntime.cdpEndpoint = "http://attacker.example:9222";

  const result = validateFixture(fixture);

  assert.notEqual(result.status, 0, result.stdout);
});

test("Windows touch-keyboard evidence accepts only canonical IPv4 loopback CDP endpoints", () => {
  for (const endpoint of [
    "https://127.0.0.1:9222",
    "http://0.0.0.0:9222",
    "http://[::1]:9222",
    "http://[2001:db8::1]:9222",
    "http://user@127.0.0.1:9222",
    "http://127.0.0.1:9222/json",
    "http://127.0.0.1:9222/?target=remote",
    "http://127.0.0.1:9222/#remote",
  ]) {
    const fixture = validationFixture();
    fixture.liveRuntime.cdpEndpoint = endpoint;
    const result = validateFixture(fixture);
    assert.notEqual(result.status, 0, `${endpoint}\n${result.stdout}`);
  }

  const localhostFixture = validationFixture();
  localhostFixture.liveRuntime.cdpEndpoint = "http://LOCALHOST:9222/";
  const localhostResult = validateFixture(localhostFixture);
  assert.equal(localhostResult.status, 0, localhostResult.stderr);
});

test("Windows touch-keyboard evidence rejects a wildcard listener for a loopback CDP endpoint", () => {
  const fixture = validationFixture();
  fixture.liveRuntime.cdpListener.localAddress = "0.0.0.0";

  const result = validateFixture(fixture);

  assert.notEqual(result.status, 0, result.stdout);
});

test("Windows touch-keyboard evidence rejects a manifest changed to another valid source commit after deployment", () => {
  const fixture = validationFixture();
  fixture.delivery.manifest.sourceCommit = "6".repeat(40);
  fixture.delivery.manifestSha256 = "c".repeat(64);

  const result = validateFixture(fixture);

  assert.notEqual(result.status, 0, result.stdout);
});

test("Windows touch-keyboard evidence rejects altered immutable source hashes", () => {
  const mutations = [
    (fixture) => {
      fixture.delivery.evidence.sourceBinding.manifestSha256 = "d".repeat(64);
    },
    (fixture) => {
      fixture.delivery.evidence.sourceBinding.sourceCommit = "7".repeat(40);
    },
    (fixture) => {
      fixture.delivery.evidence.sourceBinding.components[0].sha256 = "e".repeat(
        64,
      );
    },
  ];

  for (const mutate of mutations) {
    const fixture = validationFixture();
    mutate(fixture);
    const result = validateFixture(fixture);
    assert.notEqual(result.status, 0, result.stdout);
  }
});

test("Windows touch-keyboard production evidence rejects legacy unbound managed updates", () => {
  const fixture = validationFixture();
  delete fixture.delivery.evidence.sourceBinding;

  const result = validateFixture(fixture);

  assert.notEqual(result.status, 0, result.stdout);
});

test("Windows touch-keyboard evidence verifies every delivered component hash, not only the UI", () => {
  const fixture = validationFixture();
  fixture.delivery.evidence.components.find(
    (component) => component.component === "daemon",
  ).installedSha256 = "e".repeat(64);

  const result = validateFixture(fixture);

  assert.notEqual(result.status, 0, result.stdout);
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
