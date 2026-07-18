import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  collectDelayedPickupProductionEvidence,
  runDelayedPickupNativeAudioTrackCli,
  verifyDelayedPickupNativeAudioProductionEvidence,
} from "./delayed-pickup-native-audio-acceptance.mjs";
import {
  createSaleAudioCaptureRequest,
  SALE_AUDIO_REPORT_SCHEMA_VERSION,
} from "./sale-audio-capture-host-adapter.mjs";

function wav(durationMs, windows, sampleRateHz = 48_000) {
  const frames = Math.ceil((durationMs / 1_000) * sampleRateHz);
  const data = Buffer.alloc(frames * 4);
  for (const window of windows) {
    const start = Math.floor((window[0] / 1_000) * sampleRateHz);
    const end = Math.ceil((window[1] / 1_000) * sampleRateHz);
    for (let frame = start; frame < end; frame += 1) {
      const sample = [1024, 2048, 3072][frame % 3];
      data.writeInt16LE(sample, frame * 4);
      data.writeInt16LE(-sample, frame * 4 + 2);
    }
  }
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(2, 22);
  bytes.writeUInt32LE(sampleRateHz, 24);
  bytes.writeUInt32LE(sampleRateHz * 4, 28);
  bytes.writeUInt16LE(4, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(data.length, 40);
  data.copy(bytes, 44);
  return bytes;
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function platformSnapshot(runId, raw) {
  return {
    schemaVersion: "installed-kiosk-sale-platform-raw-records/v2",
    source: "authoritative_ephemeral_platform_database",
    scope: {
      runId,
      machineCode: "MACHINE-17",
      machineId: "machine-17",
    },
    raw,
  };
}

function fixture(root) {
  const runId = "RUN-17-PRODUCTION";
  const runtime = {
    processId: 4242,
    executablePath: "C:\\VEM\\bringup\\machine.exe",
    principal: "FIELD-DOMAIN\\InteractiveOperator",
    sessionId: 7,
    cdpTargetId: "target-17",
    cdpSessionId: "cdp-session://run-17",
  };
  const binding = {
    runId,
    lifecycleReference: "vm-lifecycle://run-17-production.runtime",
    transactionId: "transaction://run-17-production",
    saleCorrelationId: "sale-correlation://installed-kiosk-run-17-production",
    orderId: "order-17",
    orderNo: "ORDER-17",
    commandId: "command-17",
    commandNo: "CMD-17",
  };
  const platformBaseRaw = {
    orders: [],
    orderItems: [],
    payments: [],
    reservations: [],
    commands: [],
    movements: [],
  };
  const platformSaleRaw = {
    orders: [
      {
        id: binding.orderId,
        orderNo: binding.orderNo,
        machineId: "machine-17",
        status: "paid",
      },
    ],
    orderItems: [
      {
        id: "item-17",
        orderId: binding.orderId,
        inventoryId: "inventory-17",
        slotId: "slot-17",
        quantity: 1,
      },
    ],
    payments: [
      {
        id: "payment-17",
        orderId: binding.orderId,
        paymentNo: "PAY-17",
        status: "succeeded",
      },
    ],
    reservations: [
      {
        id: "reservation-17",
        orderId: binding.orderId,
        orderItemId: "item-17",
        inventoryId: "inventory-17",
        quantity: 1,
        status: "confirmed",
      },
    ],
    commands: [
      {
        id: binding.commandId,
        commandNo: binding.commandNo,
        orderId: binding.orderId,
        machineId: "machine-17",
        orderItemId: "item-17",
        slotId: "slot-17",
        status: "succeeded",
      },
    ],
    movements: [],
  };
  const platformPostRaw = {
    ...platformSaleRaw,
    movements: [
      {
        id: "movement-row-17",
        movementId: "movement-17",
        machineId: "machine-17",
        movementType: "dispense_succeeded",
        quantity: 1,
        status: "accepted",
        slotId: "slot-17",
        orderNo: binding.orderNo,
        orderItemId: "item-17",
        inventoryId: "inventory-17",
        commandNo: binding.commandNo,
      },
    ],
  };
  const platformBaselinePath = join(root, "platform-baseline.json");
  const platformF1Path = join(root, "platform-f1.json");
  const platformPostPath = join(root, "platform-post.json");
  writeJson(platformBaselinePath, platformSnapshot(runId, platformBaseRaw));
  writeJson(platformF1Path, {
    schemaVersion: "delayed-pickup-platform-f1-evidence/v1",
    source: "authoritative_ephemeral_platform_database",
    capturedAt: "2026-07-18T08:00:30.300Z",
    binding: { ...binding },
    snapshot: platformSnapshot(runId, platformSaleRaw),
  });
  writeJson(platformPostPath, platformSnapshot(runId, platformPostRaw));

  const serialPath = join(root, "serial.json");
  writeJson(serialPath, {
    reports: {
      collect: {
        result: "succeeded",
        request: {
          operation: "collect-serial-evidence",
          serialSession: {
            saleCorrelationIds: [binding.saleCorrelationId],
            saleBindings: [
              {
                saleCorrelationId: binding.saleCorrelationId,
                orderId: binding.orderId,
                paymentId: "payment-17",
                vendingCommandId: binding.commandId,
              },
            ],
          },
        },
      },
    },
  });
  const installedPath = join(root, "installed-sale.json");
  writeJson(installedPath, {
    schemaVersion: "installed-kiosk-sale-acceptance/v2",
    status: "passed",
    ok: true,
    runId,
    runtimeBinding: {
      prelaunch: {
        processId: 4000,
        executablePath: runtime.executablePath,
        principal: runtime.principal,
        sessionId: runtime.sessionId,
      },
      debug: {
        targetId: runtime.cdpTargetId,
        machine: {
          processId: runtime.processId,
          executablePath: runtime.executablePath,
          principal: runtime.principal,
          sessionId: runtime.sessionId,
        },
      },
    },
    evidence: {
      platformRawBaselinePath: platformBaselinePath,
      platformRawRecordsPath: platformPostPath,
      serialConformancePath: serialPath,
    },
  });

  const base = Date.parse("2026-07-18T08:00:00.000Z");
  const controller = [
    [0, "f0"],
    [50, "f0"],
    [100, "f0"],
    [15_000, "e5"],
    [25_000, "e5"],
    [30_000, "f1"],
    [30_050, "f1"],
    [30_100, "f1"],
    [30_500, "af"],
    [31_200, "f2"],
    [31_250, "f2"],
    [31_300, "f2"],
  ];
  const frames = controller.map(([offset, code], index) => ({
    sequence: index + 1,
    role: "lower-controller",
    direction: "guest_to_host",
    bytesHex: `80${code}`,
    capturedAt: new Date(base + offset).toISOString(),
    digest: `sha256:${createHash("sha256").update(`${index}:${code}`).digest("hex")}`,
    binding: { ...binding },
  }));
  const serialCapture = {
    schemaVersion: "host-production-serial-frame-capture/v1",
    binding: { ...binding },
    frames,
  };
  const serialBytes = Buffer.from(`${JSON.stringify(serialCapture)}\n`);
  const serialHash = createHash("sha256").update(serialBytes).digest("hex");
  writeFileSync(join(root, `${serialHash}.json`), serialBytes);

  const captureStartedAt = "2026-07-18T07:59:59.000Z";
  const captureCompletedAt = "2026-07-18T08:00:33.000Z";
  const cueOffsets = [1_100, 16_100, 26_100, 31_100, 32_300];
  const wavBytes = wav(
    34_000,
    cueOffsets.map((offset) => [offset, offset + 500]),
  );
  const wavHash = createHash("sha256").update(wavBytes).digest("hex");
  writeFileSync(join(root, `${wavHash}.wav`), wavBytes);

  const startRequest = createSaleAudioCaptureRequest({
    phase: "start",
    runId,
    lifecycleReference: binding.lifecycleReference,
    targetIdentity: "vm-target://runtime-testbed",
    transactionId: binding.transactionId,
    runtime,
    operationNonce: "op-1111111111111111",
  });
  const captureSession = {
    captureSessionId: "sale-audio-session://run-17",
    startOperationReference: startRequest.operationReference,
    startedAt: captureStartedAt,
  };
  const startReport = {
    schemaVersion: SALE_AUDIO_REPORT_SCHEMA_VERSION,
    kind: "vm-sale-audio-capture-report",
    result: "succeeded",
    adapter: {
      identity: "vm-host-adapter://windows-production",
      version: "1.0.0",
    },
    request: startRequest,
    captureSession,
    capture: null,
    evidence: [],
  };
  const stopRequest = createSaleAudioCaptureRequest({
    phase: "stop",
    runId,
    lifecycleReference: binding.lifecycleReference,
    targetIdentity: "vm-target://runtime-testbed",
    transactionId: binding.transactionId,
    runtime,
    captureSessionId: captureSession.captureSessionId,
    startOperationReference: captureSession.startOperationReference,
    captureStartedAt,
    sale: {
      saleCorrelationId: binding.saleCorrelationId,
      orderId: binding.orderId,
      orderNo: binding.orderNo,
      commandId: binding.commandId,
      commandNo: binding.commandNo,
    },
    operationNonce: "op-2222222222222222",
  });
  const audioEvidence = {
    role: "sale-default-audio-capture",
    identity: `factory-evidence://sha256/${wavHash}`,
    digest: `sha256:${wavHash}`,
    fileName: `${wavHash}.wav`,
  };
  const serialEvidence = {
    role: "sale-serial-frame-capture",
    identity: `factory-evidence://sha256/${serialHash}`,
    digest: `sha256:${serialHash}`,
    fileName: `${serialHash}.json`,
  };
  const stopReport = {
    schemaVersion: SALE_AUDIO_REPORT_SCHEMA_VERSION,
    kind: "vm-sale-audio-capture-report",
    result: "succeeded",
    adapter: {
      identity: "vm-host-adapter://windows-production",
      version: "1.0.0",
    },
    request: stopRequest,
    captureSession,
    capture: {
      source: "windows_default_output",
      binding: { ...binding },
      startedAt: captureStartedAt,
      completedAt: captureCompletedAt,
      audioArtifact: audioEvidence.identity,
      serialArtifact: serialEvidence.identity,
      threshold: {
        minimumPeakAbsoluteSample: 512,
        minimumNonSilentFrames: 4_800,
        minimumDurationMs: 100,
        minimumDistinctNonSilentSampleMagnitudes: 2,
      },
    },
    evidence: [audioEvidence, serialEvidence],
  };
  const audioStartPath = join(root, "audio-start.json");
  const audioStopPath = join(root, "audio-stop.json");
  writeJson(audioStartPath, startReport);
  writeJson(audioStopPath, stopReport);

  const traceDefinitions = [
    ["pickup-outlet-opened", 100],
    ["pickup-warning-1", 15_100],
    ["pickup-warning-2", 25_100],
    ["pickup-completed", 30_100],
    ["dispense-succeeded", 31_300],
  ];
  let traceId = 1;
  const runtimeTrace = traceDefinitions.flatMap(
    ([suffix, offset], requestIndex) => {
      const transitionId = `transaction:${binding.orderNo}:${suffix}`;
      const requestId = `audio-request-${requestIndex + 1}`;
      return [
        ["journey_transition", offset, null, null, null],
        ["audio_queued", offset + 10, requestId, null, null],
        ["audio_started", offset + 100, requestId, null, null],
        [
          "audio_terminal",
          offset + 500,
          requestId,
          `audio-terminal:${requestId}`,
          "completed",
        ],
      ].map(([type, atOffset, request, terminalOutcomeId, outcome]) => ({
        type,
        id: traceId++,
        at: new Date(base + atOffset).toISOString(),
        recordedAt: new Date(base + atOffset).toISOString(),
        transitionId,
        requestId: request,
        terminalOutcomeId,
        outcome,
        message: type === "audio_started" ? "native" : null,
      }));
    },
  );
  const machinePath = join(root, "machine.json");
  writeJson(machinePath, {
    schemaVersion: "machine-production-evidence/v1",
    source: "installed_canonical_machine_cdp",
    binding: { ...binding },
    runtime,
    uiObservations: [
      ["ordinary_warning", 15_300],
      ["urgent_warning", 25_300],
      ["reset_progress", 30_300],
    ].map(([surface, offset]) => ({
      surface,
      route: "#/dispensing",
      observedAt: new Date(base + offset).toISOString(),
      binding: { ...binding },
      runtime: { ...runtime },
    })),
    runtimeTrace,
  });
  const saleView = (physicalStock) => ({
    items: [{ inventoryId: "inventory-17", slotId: "slot-17", physicalStock }],
  });
  const transaction = (stage) => ({
    orderNo: binding.orderNo,
    orderStatus: stage === "f2" ? "fulfilled" : "dispensing",
    nextAction: stage === "f2" ? "success" : "dispensing",
    vending: {
      commandNo: binding.commandNo,
      status: stage === "f2" ? "succeeded" : "dispensing",
      fulfillmentProgressStage:
        stage === "f1"
          ? "pickup_completed"
          : stage === "f2"
            ? "reset_completed"
            : "outlet_opened",
    },
  });
  const daemonPath = join(root, "daemon.json");
  writeJson(daemonPath, {
    schemaVersion: "daemon-fulfillment-store-evidence/v1",
    source: "vending_daemon_ipc",
    binding: { ...binding },
    checkpoints: [
      ["before_f0", -100, 4, "before"],
      ["after_f1_before_f2", 30_200, 4, "f1"],
      ["after_f2", 31_500, 3, "f2"],
    ].map(([stage, offset, stock, state]) => ({
      stage,
      capturedAt: new Date(base + offset).toISOString(),
      binding: { ...binding },
      transaction: transaction(state),
      saleView: saleView(stock),
    })),
  });
  return {
    paths: {
      installedSaleReportPath: installedPath,
      machineEvidencePath: machinePath,
      daemonEvidencePath: daemonPath,
      platformF1Path,
      audioStartReportPath: audioStartPath,
      audioStopReportPath: audioStopPath,
    },
    audioEvidenceDirectory: root,
    binding,
  };
}

describe("delayed pickup native audio production track", () => {
  it("derives one production sale from raw CDP, daemon, platform, serial, and WAV evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-delayed-production-"));
    try {
      const input = fixture(root);
      const artifacts = collectDelayedPickupProductionEvidence(input.paths);
      const report = verifyDelayedPickupNativeAudioProductionEvidence({
        artifacts,
        audioEvidenceDirectory: input.audioEvidenceDirectory,
      });

      assert.equal(report.result, "passed", JSON.stringify(report.diagnostics));
      assert.deepEqual(report.binding, input.binding);
      assert.equal(report.inventory.local.atF1, 4);
      assert.equal(report.inventory.local.afterF2, 3);
      assert.equal(report.inventory.platform.platformStockDelta, -1);
      assert.equal(report.audio.cueWindows.length, 5);
      assert.equal(
        report.audio.cueWindows.every((window) => window.kind === "passed"),
        true,
      );
      assert.equal(JSON.stringify(report).includes('"data"'), false);
      assert.equal(JSON.stringify(report).includes('"wavBytes"'), false);
      assert.equal(
        report.runtime.principal,
        "FIELD-DOMAIN\\InteractiveOperator",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails closed for F1 stock mutation, incomplete frame binding, and missing terminal outcome id", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-delayed-production-"));
    try {
      const input = fixture(root);
      const artifacts = collectDelayedPickupProductionEvidence(input.paths);
      artifacts.daemon.value.checkpoints[1].saleView.items[0].physicalStock = 3;
      const serialFile = artifacts.audioStop.value.evidence[1].fileName;
      const serial = JSON.parse(
        Buffer.from(
          // The collector intentionally does not cache exported serial bytes.
          readFileSync(join(root, serialFile)),
        ).toString("utf8"),
      );
      delete serial.frames[3].binding.commandId;
      const serialBytes = Buffer.from(`${JSON.stringify(serial)}\n`);
      const serialHash = createHash("sha256").update(serialBytes).digest("hex");
      writeFileSync(join(root, `${serialHash}.json`), serialBytes);
      artifacts.audioStop.value.evidence[1] = {
        role: "sale-serial-frame-capture",
        identity: `factory-evidence://sha256/${serialHash}`,
        digest: `sha256:${serialHash}`,
        fileName: `${serialHash}.json`,
      };
      artifacts.audioStop.value.capture.serialArtifact =
        artifacts.audioStop.value.evidence[1].identity;
      delete artifacts.machine.value.runtimeTrace.find(
        (entry) => entry.type === "audio_terminal",
      ).terminalOutcomeId;

      const report = verifyDelayedPickupNativeAudioProductionEvidence({
        artifacts,
        audioEvidenceDirectory: root,
      });
      assert.equal(report.result, "failed");
      assert.ok(
        report.diagnostics.some(
          (entry) => entry.code === "daemon_inventory_changed_before_f2",
        ),
      );
      assert.ok(
        report.diagnostics.some(
          (entry) => entry.code === "controller_frame_sale_binding_incomplete",
        ),
      );
      assert.ok(
        report.diagnostics.some(
          (entry) => entry.code === "runtime_terminal_outcome_id_invalid",
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("provides one CLI entry that Issue16 fast/full orchestration can invoke", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-delayed-production-cli-"));
    try {
      const input = fixture(root);
      const out = join(root, "acceptance.json");
      const report = runDelayedPickupNativeAudioTrackCli([
        "--installed-sale-report",
        input.paths.installedSaleReportPath,
        "--machine-evidence",
        input.paths.machineEvidencePath,
        "--daemon-evidence",
        input.paths.daemonEvidencePath,
        "--platform-f1",
        input.paths.platformF1Path,
        "--audio-start-report",
        input.paths.audioStartReportPath,
        "--audio-stop-report",
        input.paths.audioStopReportPath,
        "--audio-evidence-dir",
        root,
        "--out",
        out,
      ]);
      assert.equal(report.result, "passed", JSON.stringify(report.diagnostics));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
