import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { buildStabilityGateReport } from "./full-workflow-stability-gate.mjs";
import { buildFullWorkflowAggregate } from "./full-workflow-validator.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), "vem-full-workflow-"));
  roots.push(root);
  return root;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sampleEvidenceManifest(path) {
  return {
    schemaVersion: "vem-local-testbed-full-workflow-evidence-manifest/v1",
    ok: true,
    limits: {
      tracePerFileBytes: 512 * 1024,
      logPerFileBytes: 256 * 1024,
      screenshotPerFileBytes: 2 * 1024 * 1024,
      totalBytes: 8 * 1024 * 1024,
    },
    requiredKinds: ["traces", "logs", "screenshots"],
    totals: { byteLength: 3, traces: 1, logs: 1, screenshots: 1 },
    files: ["traces", "logs", "screenshots"].map((kind, index) => ({
      path,
      kind,
      byteLength: 1,
      sha256: String.fromCharCode(97 + index).repeat(64),
    })),
    failures: [],
  };
}

function sampleFastReport() {
  return {
    schemaVersion: "vem-fast-route-stress-sale/v2",
    ok: true,
    summary: {
      orderId: "ORDER-1",
      paymentId: "PAYMENT-1",
      vendingCommandId: "VEND-1",
      protocol: ["VEND", "F0", "F1", "F2"],
      daemonStockDeltaAfterF2: -1,
      platformStockDeltaAfterF2: -1,
      guardedNavigationReason: "active_transaction_route",
      visionEventId: "VISION-1",
      repeatedPhysicalTouchTraceId: "TRACE-1",
    },
  };
}

function sampleIdentity(reconstruction = "a") {
  return {
    githubSha: "c".repeat(40),
    baseline: {
      releaseId: "win10-runtime-20260718",
      digest: `sha256:${"b".repeat(64)}`,
    },
    runtimeBase: `runtime-base://sha256/${"d".repeat(64)}`,
    reconstructionId: `reconstruction://sha256/${reconstruction.repeat(64).slice(0, 64)}`,
    retainedCaches: [
      "D:\\runtime-cache\\v1\\pnpm-store",
      "D:\\runtime-cache\\v1\\cargo-home",
      "D:\\runtime-cache\\v1\\target",
      "D:\\runtime-cache\\v1\\sccache",
      "D:\\runtime-cache\\v1\\turbo",
    ],
  };
}

function sampleDelayedReport() {
  return {
    schemaVersion: "local-testbed-delayed-pickup-native-audio/v1",
    ok: true,
    delayedPickupNativeAudio: {
      schemaVersion: "delayed-pickup-native-audio-production-acceptance/v3",
      result: "passed",
      audio: {
        source: "windows_default_output",
        cueWindows: [
          { kind: "passed" },
          { kind: "passed" },
          { kind: "passed" },
          { kind: "passed" },
          { kind: "passed" },
        ],
      },
    },
  };
}

function sampleIpcRecoveryReport() {
  return {
    schemaVersion: "vem-installed-ipc-recovery-guest-full/v1",
    ok: true,
    renderedSale: {
      orderId: "ORDER-1",
      paymentId: "PAYMENT-1",
      orderNo: "NO-1",
    },
    liveSale: {
      vendingCommandId: "COMMAND-1",
    },
    result: {
      kind: "success",
    },
    ipcRecovery: {
      evidence: {
        status: "passed",
      },
      assertions: {
        overlayObserved: true,
        retainedOrderCredential: "NO-1",
        resumedOrderCredential: "NO-1",
        daemonTransportPhase: "recovered",
      },
    },
    cleanup: {
      ok: true,
    },
  };
}

function sampleFulfillmentFailureReport() {
  return {
    schemaVersion: "vem-serial-fulfillment-error-guest-full/v1",
    ok: true,
    paymentCompletion: {
      ok: true,
    },
    assertions: {
      orderStatus: "refunded",
      commandId: "COMMAND-1",
      inventoryDelta: 0,
    },
    cleanup: {
      stopped: true,
    },
  };
}

function sampleScannerReport() {
  return {
    schemaVersion: "vem-scanner-payment-code-guest-full/v1",
    ok: true,
    renderedSale: {
      orderId: "ORDER-1",
      paymentId: "PAYMENT-1",
      orderNo: "NO-1",
    },
    scannerAttempt: {
      status: "succeeded",
      source: "serial_text",
      scannerEventId: "SCAN-1",
    },
    platformAssertions: {
      attempt: {
        status: "succeeded",
      },
      movement: {
        id: "MOVE-1",
      },
    },
    invalidScanEvidence: {
      malformed: {
        attemptCount: 0,
        paymentDelta: 0,
      },
      timeout: {
        attemptCount: 0,
        paymentDelta: 0,
      },
    },
    final: {
      result: {
        kind: "success",
      },
    },
  };
}

function sampleVisionReport() {
  return {
    schemaVersion: "vem-vision-try-on-acceptance/v1",
    ok: true,
    health: {
      vision: {
        protocolSummary: { ok: true },
      },
    },
    ui: {
      tryOnSummary: { ok: true },
      tryOnFailure: { ok: true },
    },
    degradations: {
      visionDown: {
        experienceCapabilityDegraded: true,
        saleStartStillAvailable: true,
      },
      tryOnUnavailableWhileVisionOnline: {
        experienceCapabilityDegraded: true,
        saleStartStillAvailable: true,
        visionOnline: true,
      },
    },
  };
}

describe("full workflow aggregate validator", () => {
  it("builds a passed full aggregate from compact track reports", () => {
    const root = tempRoot();
    const fastPath = join(root, "fast.json");
    const ipcRecoveryPath = join(root, "ipc-recovery.json");
    const fulfillmentFailurePath = join(root, "fulfillment-failure.json");
    const scannerPath = join(root, "scanner.json");
    const delayedPath = join(root, "delayed.json");
    const visionPath = join(root, "vision.json");
    const manifestPath = join(root, "manifest.json");
    writeJson(fastPath, sampleFastReport());
    writeJson(ipcRecoveryPath, sampleIpcRecoveryReport());
    writeJson(fulfillmentFailurePath, sampleFulfillmentFailureReport());
    writeJson(scannerPath, sampleScannerReport());
    writeJson(delayedPath, sampleDelayedReport());
    writeJson(visionPath, sampleVisionReport());
    writeJson(manifestPath, sampleEvidenceManifest(fastPath));
    const report = buildFullWorkflowAggregate({
      mode: "full",
      fastReportPath: fastPath,
      ipcRecoveryReportPath: ipcRecoveryPath,
      fulfillmentFailureReportPath: fulfillmentFailurePath,
      scannerReportPath: scannerPath,
      delayedPickupReportPath: delayedPath,
      visionTryOnReportPath: visionPath,
      evidenceManifestPath: manifestPath,
      executedTracks: [
        { key: "fast", status: "passed", exitCode: 0, reportOk: true },
        { key: "delayedPickup", status: "passed", exitCode: 0, reportOk: true },
        { key: "scanner", status: "passed", exitCode: 0, reportOk: true },
        { key: "ipcRecovery", status: "passed", exitCode: 0, reportOk: true },
        {
          key: "fulfillmentFailure",
          status: "passed",
          exitCode: 0,
          reportOk: true,
        },
        { key: "visionTryOn", status: "passed", exitCode: 0, reportOk: true },
      ],
    });
    assert.equal(report.ok, true);
    assert.equal(report.tracks.standardSale.status, "passed");
    assert.equal(report.tracks.ipcRecovery.status, "passed");
    assert.equal(report.tracks.fulfillmentFailure.status, "passed");
    assert.equal(report.tracks.audio.status, "passed");
    assert.equal(report.tracks.scanner.status, "passed");
    assert.equal(report.tracks.vision.status, "passed");
    assert.equal(report.tracks.tryOn.status, "passed");
    assert.equal(report.tracks.evidence.status, "passed");
    assert.equal(report.tracks.error.status, "passed");
  });

  it("marks full aggregate failed when the scanner invalid-scan evidence is incomplete", () => {
    const root = tempRoot();
    const fastPath = join(root, "fast.json");
    const ipcRecoveryPath = join(root, "ipc-recovery.json");
    const fulfillmentFailurePath = join(root, "fulfillment-failure.json");
    const scannerPath = join(root, "scanner.json");
    const delayedPath = join(root, "delayed.json");
    const visionPath = join(root, "vision.json");
    const manifestPath = join(root, "manifest.json");
    const scanner = sampleScannerReport();
    scanner.invalidScanEvidence.timeout.paymentDelta = 1;
    writeJson(fastPath, sampleFastReport());
    writeJson(ipcRecoveryPath, sampleIpcRecoveryReport());
    writeJson(fulfillmentFailurePath, sampleFulfillmentFailureReport());
    writeJson(scannerPath, scanner);
    writeJson(delayedPath, sampleDelayedReport());
    writeJson(visionPath, sampleVisionReport());
    writeJson(manifestPath, sampleEvidenceManifest(fastPath));
    const report = buildFullWorkflowAggregate({
      mode: "full",
      fastReportPath: fastPath,
      ipcRecoveryReportPath: ipcRecoveryPath,
      fulfillmentFailureReportPath: fulfillmentFailurePath,
      scannerReportPath: scannerPath,
      delayedPickupReportPath: delayedPath,
      visionTryOnReportPath: visionPath,
      evidenceManifestPath: manifestPath,
      executedTracks: [
        { key: "fast", exitCode: 0, reportOk: true },
        { key: "delayedPickup", exitCode: 0, reportOk: true },
        { key: "scanner", exitCode: 0, reportOk: true },
        { key: "ipcRecovery", exitCode: 0, reportOk: true },
        { key: "fulfillmentFailure", exitCode: 0, reportOk: true },
        { key: "visionTryOn", exitCode: 0, reportOk: true },
      ],
    });
    assert.equal(report.ok, false);
    assert.equal(report.tracks.error.status, "failed");
  });

  it("returns an aggregate failure when a required child report is missing", () => {
    const root = tempRoot();
    const fastPath = join(root, "fast.json");
    const manifestPath = join(root, "manifest.json");
    writeJson(fastPath, sampleFastReport());
    writeJson(manifestPath, sampleEvidenceManifest(fastPath));
    const report = buildFullWorkflowAggregate({
      mode: "full",
      fastReportPath: fastPath,
      evidenceManifestPath: manifestPath,
      executedTracks: [{ key: "fast", exitCode: 0, reportOk: true }],
    });
    assert.equal(report.ok, false);
    assert.equal(report.tracks.audio.status, "failed");
    assert.equal(report.tracks.error.status, "failed");
  });

  it("rejects a child that exits zero but emits an invalid report", () => {
    const root = tempRoot();
    const fastPath = join(root, "fast.json");
    const ipcPath = join(root, "ipc.json");
    const fulfillmentPath = join(root, "fulfillment.json");
    const scannerPath = join(root, "scanner.json");
    const delayedPath = join(root, "delayed.json");
    const visionPath = join(root, "vision.json");
    const manifestPath = join(root, "manifest.json");
    writeJson(fastPath, sampleFastReport());
    writeJson(ipcPath, { ok: true });
    writeJson(fulfillmentPath, sampleFulfillmentFailureReport());
    writeJson(scannerPath, sampleScannerReport());
    writeJson(delayedPath, sampleDelayedReport());
    writeJson(visionPath, sampleVisionReport());
    writeJson(manifestPath, sampleEvidenceManifest(fastPath));
    const report = buildFullWorkflowAggregate({
      mode: "full",
      fastReportPath: fastPath,
      ipcRecoveryReportPath: ipcPath,
      fulfillmentFailureReportPath: fulfillmentPath,
      scannerReportPath: scannerPath,
      delayedPickupReportPath: delayedPath,
      visionTryOnReportPath: visionPath,
      evidenceManifestPath: manifestPath,
      executedTracks: [
        "fast",
        "ipcRecovery",
        "fulfillmentFailure",
        "delayedPickup",
        "scanner",
        "visionTryOn",
      ].map((key) => ({ key, exitCode: 0, reportOk: true })),
    });
    assert.equal(report.ok, false);
    assert.equal(report.tracks.ipcRecovery.status, "failed");
  });
});

describe("full workflow stability gate", () => {
  it("accepts two passed full workflow reports for the same commit", () => {
    const root = tempRoot();
    const passA = join(root, "pass-a.json");
    const passB = join(root, "pass-b.json");
    const fullAggregate = {
      schemaVersion: "vem-local-testbed-full-workflow/v3",
      mode: "full",
      ok: true,
      failures: [],
      tracks: {
        standardSale: { status: "passed" },
        ipcRecovery: { status: "passed" },
        fulfillmentFailure: { status: "passed" },
        audio: { status: "passed" },
        scanner: { status: "passed" },
        vision: { status: "passed" },
        tryOn: { status: "passed" },
        evidence: { status: "passed" },
        error: { status: "passed" },
      },
      execution: {
        executedTracks: [
          "fast",
          "delayedPickup",
          "scanner",
          "ipcRecovery",
          "fulfillmentFailure",
          "visionTryOn",
        ].map((key) => ({ key })),
      },
      identity: sampleIdentity(),
    };
    writeJson(passA, fullAggregate);
    writeJson(passB, {
      ...fullAggregate,
      identity: sampleIdentity("e"),
    });
    const report = buildStabilityGateReport({
      commit: "c".repeat(40),
      passAPath: passA,
      passBPath: passB,
    });
    assert.equal(report.ok, true);
    assert.deepEqual(report.gateFailures, []);
    assert.equal(report.declaredStateReconstruction.retainedCaches.length, 5);
  });

  it("rejects a repeated reconstruction ID", () => {
    const root = tempRoot();
    const passA = join(root, "pass-a.json");
    const passB = join(root, "pass-b.json");
    const aggregate = {
      schemaVersion: "vem-local-testbed-full-workflow/v3",
      mode: "full",
      ok: true,
      failures: [],
      tracks: Object.fromEntries(
        [
          "standardSale",
          "ipcRecovery",
          "fulfillmentFailure",
          "audio",
          "scanner",
          "vision",
          "tryOn",
          "evidence",
          "error",
        ].map((key) => [key, { status: "passed" }]),
      ),
      execution: {
        executedTracks: [
          "fast",
          "ipcRecovery",
          "fulfillmentFailure",
          "delayedPickup",
          "scanner",
          "visionTryOn",
        ].map((key) => ({ key })),
      },
      identity: sampleIdentity("a"),
    };
    writeJson(passA, aggregate);
    writeJson(passB, aggregate);
    const report = buildStabilityGateReport({
      commit: "c".repeat(40),
      passAPath: passA,
      passBPath: passB,
    });
    assert.equal(report.ok, false);
    assert.ok(
      report.gateFailures.includes("two passes reused one reconstruction ID"),
    );
  });
});
