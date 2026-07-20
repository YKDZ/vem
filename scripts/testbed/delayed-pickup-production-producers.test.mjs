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
  orderId: "11111111-1111-4111-8111-111111111111",
  orderNo: "ORDER-17",
  commandId: "22222222-2222-4222-8222-222222222222",
  commandNo: "CMD-17",
};
const runtime = {
  processId: 42,
  executablePath: "C:\\VEM\\bringup\\machine.exe",
  principal: "FIELD\\Operator",
  sessionId: 6,
  cdpTargetId: "target-17",
  cdpSessionId: "cdp-connection:33333333-3333-4333-8333-333333333333",
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
    const capture = await startDelayedPickupMachineEvidenceCapture({
      client: {
        async observeIdentity() {
          return {
            targetId: runtime.cdpTargetId,
            sessionId: runtime.cdpSessionId,
            connectedAt: "2026-07-18T08:00:00.000Z",
          };
        },
      },
      async inspectRuntime() {
        return {
          machine: runtime,
          cdpListener: {
            machineAncestorProcessId: runtime.processId,
            sessionId: runtime.sessionId,
            principal: runtime.principal,
          },
        };
      },
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
    const evidence = await capture.stop(binding);
    assert.deepEqual(
      evidence.uiObservations.map((entry) => entry.surface),
      samples,
    );
    assert.equal(
      evidence.runtimeTrace[0].terminalOutcomeId,
      "audio-terminal:audio-request-1",
    );
    assert.equal(evidence.runtime.principal, runtime.principal);
    assert.equal(
      evidence.runtime.source,
      "windows_process_and_live_cdp_client",
    );
  });

  it("makes machine evidence stop/cancel idempotent and halts polling after failure", async () => {
    let polls = 0;
    const capture = await startDelayedPickupMachineEvidenceCapture({
      client: {
        async observeIdentity() {
          return {
            targetId: runtime.cdpTargetId,
            sessionId: runtime.cdpSessionId,
            connectedAt: "2026-07-18T08:00:00.000Z",
          };
        },
      },
      async inspectRuntime() {
        return {
          machine: runtime,
          cdpListener: {
            machineAncestorProcessId: runtime.processId,
            sessionId: runtime.sessionId,
            principal: runtime.principal,
          },
        };
      },
      intervalMs: 25,
      async readSample() {
        polls += 1;
        if (polls > 1) throw new Error("sample failed");
        return {
          observedAt: "2026-07-18T08:00:00.010Z",
          route: "#/dispensing",
          surface: "ordinary_warning",
          orderId: binding.orderId,
          orderNo: binding.orderNo,
          commandId: binding.commandId,
          commandNo: binding.commandNo,
          runtimeTrace: [],
        };
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const failedPolls = polls;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(polls, failedPolls);
    await assert.rejects(() => capture.stop(binding), /sample failed/);
    await capture.cancel();
    await capture.cancel();
  });

  it("takes a final synchronous Machine trace sample when capture stops", async () => {
    let polls = 0;
    const capture = await startDelayedPickupMachineEvidenceCapture({
      client: {
        async observeIdentity() {
          return {
            targetId: runtime.cdpTargetId,
            sessionId: runtime.cdpSessionId,
            connectedAt: "2026-07-18T08:00:00.000Z",
          };
        },
      },
      async inspectRuntime() {
        return {
          machine: runtime,
          cdpListener: {
            machineAncestorProcessId: runtime.processId,
            sessionId: runtime.sessionId,
            principal: runtime.principal,
          },
        };
      },
      intervalMs: 1_000,
      async readSample() {
        polls += 1;
        return {
          observedAt: "2026-07-18T08:00:00.010Z",
          route: "#/result/success",
          surface: "none",
          runtimeTrace: [{ id: polls, type: "audio_terminal" }],
        };
      },
    });

    const evidence = await capture.stop(binding);
    assert.equal(polls, 2);
    assert.equal(evidence.runtimeTrace[0].id, 2);
  });

  it("wraps the F1-time authoritative raw query without replacing its records", () => {
    const snapshot = {
      schemaVersion: "installed-kiosk-sale-platform-raw-records/v3",
      capturedAt: "2026-07-18T08:00:00.000Z",
      source: "authoritative_ephemeral_platform_database",
      scope: { runId: binding.runId, machineId: "machine-17" },
      raw: { movements: [] },
    };
    const evidence = createDelayedPickupPlatformF1Evidence({
      binding,
      snapshot,
      capturedAt: "2026-07-18T08:00:30.500Z",
    });
    assert.deepEqual(evidence.raw, snapshot.raw);
    assert.equal(evidence.capturedAt, snapshot.capturedAt);
    assert.equal(Object.hasOwn(evidence, "binding"), false);
  });
});
