import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildDaemonFulfillmentStoreCheckpointScript,
  createDaemonFulfillmentStoreEvidence,
} from "./delayed-pickup-daemon-evidence.mjs";
import { startDelayedPickupMachineEvidenceCapture } from "./delayed-pickup-machine-evidence.mjs";
import { createDelayedPickupPlatformF1Evidence } from "./delayed-pickup-platform-evidence.mjs";

const binding = {
  runId: "RUN-17",
  lifecycleReference: "vm-lifecycle://run-17.runtime",
  transactionId: "transaction://run-17",
  saleCorrelationId: "sale-correlation://run-17",
  orderId: "order-17",
  orderNo: "ORDER-17",
  commandId: "command-17",
  commandNo: "CMD-17",
};
const runtime = {
  processId: 42,
  executablePath: "C:\\VEM\\bringup\\machine.exe",
  principal: "FIELD\\Operator",
  sessionId: 6,
  cdpTargetId: "target-17",
  cdpSessionId: "cdp-session://17",
};

describe("delayed pickup production evidence producers", () => {
  it("reads daemon fulfillment and sale-view state from the installed IPC handoff", () => {
    const script = buildDaemonFulfillmentStoreCheckpointScript({
      stage: "after_f1_before_f2",
      binding,
    });
    assert.match(script, /daemon-ready\.json/);
    assert.match(script, /\/v1\/transactions\/current/);
    assert.match(script, /\/v1\/sale-view/);
    assert.match(script, /Authorization = "Bearer/);
    assert.doesNotMatch(script, /VEMKiosk/);
    const evidence = createDaemonFulfillmentStoreEvidence(binding, []);
    assert.equal(evidence.source, "vending_daemon_ipc");
  });

  it("polls the installed CDP target and retains raw Machine Runtime Trace", async () => {
    const samples = ["ordinary_warning", "urgent_warning", "reset_progress"];
    let sequence = 0;
    const capture = startDelayedPickupMachineEvidenceCapture({
      client: {},
      binding,
      runtime,
      intervalMs: 25,
      async readSample() {
        const surface = samples[Math.min(sequence, samples.length - 1)];
        sequence += 1;
        return {
          observedAt: new Date(
            Date.parse("2026-07-18T08:00:00.000Z") + sequence * 10,
          ).toISOString(),
          route: "#/dispensing",
          surface,
          orderId: binding.orderId,
          orderNo: binding.orderNo,
          commandId: binding.commandId,
          commandNo: binding.commandNo,
          runtimeTrace: [
            {
              type: "audio_terminal",
              id: sequence,
              at: "2026-07-18T08:00:00.000Z",
              recordedAt: "2026-07-18T08:00:00.000Z",
              transitionId: `transaction:${binding.orderNo}:pickup-warning-1`,
              requestId: "audio-request-1",
              terminalOutcomeId: "audio-terminal:audio-request-1",
              outcome: "completed",
              message: null,
            },
          ],
        };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 90));
    const evidence = await capture.stop();
    assert.deepEqual(
      evidence.uiObservations.map((entry) => entry.surface),
      samples,
    );
    assert.equal(
      evidence.runtimeTrace[0].terminalOutcomeId,
      "audio-terminal:audio-request-1",
    );
    assert.equal(evidence.runtime.principal, runtime.principal);
  });

  it("wraps the F1-time authoritative raw query without replacing its records", () => {
    const snapshot = {
      schemaVersion: "installed-kiosk-sale-platform-raw-records/v2",
      source: "authoritative_ephemeral_platform_database",
      scope: { runId: binding.runId, machineId: "machine-17" },
      raw: { movements: [] },
    };
    const evidence = createDelayedPickupPlatformF1Evidence({
      binding,
      snapshot,
      capturedAt: "2026-07-18T08:00:30.500Z",
    });
    assert.deepEqual(evidence.snapshot, snapshot);
    assert.equal(evidence.binding.commandId, binding.commandId);
  });
});
