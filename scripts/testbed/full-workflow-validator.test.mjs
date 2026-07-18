import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  buildFullWorkflowAggregate,
} from "./full-workflow-validator.mjs";
import { buildStabilityGateReport } from "./full-workflow-stability-gate.mjs";

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
    },
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
    const scannerPath = join(root, "scanner.json");
    const delayedPath = join(root, "delayed.json");
    const visionPath = join(root, "vision.json");
    writeJson(fastPath, sampleFastReport());
    writeJson(scannerPath, sampleScannerReport());
    writeJson(delayedPath, sampleDelayedReport());
    writeJson(visionPath, sampleVisionReport());
    const report = buildFullWorkflowAggregate({
      mode: "full",
      fastReportPath: fastPath,
      scannerReportPath: scannerPath,
      delayedPickupReportPath: delayedPath,
      visionTryOnReportPath: visionPath,
      executedTracks: [
        { key: "fast", status: "passed" },
        { key: "scanner", status: "passed" },
      ],
    });
    assert.equal(report.ok, true);
    assert.equal(report.tracks.standardSale.status, "passed");
    assert.equal(report.tracks.audio.status, "passed");
    assert.equal(report.tracks.scanner.status, "passed");
    assert.equal(report.tracks.vision.status, "passed");
    assert.equal(report.tracks.tryOn.status, "passed");
    assert.equal(report.tracks.error.status, "passed");
  });

  it("marks full aggregate failed when the scanner invalid-scan evidence is incomplete", () => {
    const root = tempRoot();
    const fastPath = join(root, "fast.json");
    const scannerPath = join(root, "scanner.json");
    const delayedPath = join(root, "delayed.json");
    const visionPath = join(root, "vision.json");
    const scanner = sampleScannerReport();
    scanner.invalidScanEvidence.timeout.paymentDelta = 1;
    writeJson(fastPath, sampleFastReport());
    writeJson(scannerPath, scanner);
    writeJson(delayedPath, sampleDelayedReport());
    writeJson(visionPath, sampleVisionReport());
    const report = buildFullWorkflowAggregate({
      mode: "full",
      fastReportPath: fastPath,
      scannerReportPath: scannerPath,
      delayedPickupReportPath: delayedPath,
      visionTryOnReportPath: visionPath,
    });
    assert.equal(report.ok, false);
    assert.equal(report.tracks.error.status, "failed");
  });
});

describe("full workflow stability gate", () => {
  it("accepts two passed full workflow reports for the same commit", () => {
    const root = tempRoot();
    const passA = join(root, "pass-a.json");
    const passB = join(root, "pass-b.json");
    const fullAggregate = {
      schemaVersion: "vem-local-testbed-full-workflow/v2",
      mode: "full",
      ok: true,
      failures: [],
      tracks: {
        standardSale: { status: "passed" },
        audio: { status: "passed" },
        scanner: { status: "passed" },
        vision: { status: "passed" },
        tryOn: { status: "passed" },
        error: { status: "passed" },
      },
    };
    writeJson(passA, fullAggregate);
    writeJson(passB, fullAggregate);
    const report = buildStabilityGateReport({
      commit: "56c14184",
      passAPath: passA,
      passBPath: passB,
    });
    assert.equal(report.ok, true);
    assert.deepEqual(report.gateFailures, []);
    assert.equal(report.declaredStateReconstruction.retainedCaches.length, 5);
  });
});
