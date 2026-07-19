import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  analyzeDelayedPickupControllerFrames,
  analyzeDelayedPickupRuntimeTrace,
  analyzeDelayedPickupUiEvidence,
  correlateDelayedPickupCueWindows,
} from "./delayed-pickup-native-audio-evidence.mjs";

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
  processId: 17,
  executablePath: "C:\\VEM\\bringup\\machine.exe",
  principal: "SITE\\Operator",
  sessionId: 3,
  cdpTargetId: "target-17",
  cdpSessionId: "cdp-session://17",
};

function frame(sequence, offset, code) {
  const bytesHex = `55${code}`;
  return {
    sequence,
    role: "lower-controller",
    direction: "host_to_guest",
    bytesHex,
    capturedAt: new Date(
      Date.parse("2026-07-18T08:00:00.000Z") + offset,
    ).toISOString(),
    digest: `sha256:${createHash("sha256").update(Buffer.from(bytesHex, "hex")).digest("hex")}`,
    binding: { ...binding },
  };
}

function dispenseFrame() {
  const bytesHex = "55020531";
  return {
    sequence: 1,
    role: "upper-controller",
    direction: "guest_to_host",
    bytesHex,
    capturedAt: "2026-07-18T07:59:59.900Z",
    digest: `sha256:${createHash("sha256").update(Buffer.from(bytesHex, "hex")).digest("hex")}`,
    binding: { ...binding },
  };
}

function runtimeTraceFixture() {
  const trace = [];
  let id = 1;
  [
    "pickup-waiting",
    "pickup-warning-1",
    "pickup-warning-2",
    "pickup-completed",
    "dispense-succeeded",
  ].forEach((suffix, index) => {
    const transitionId = `transaction:${binding.orderNo}:${suffix}`;
    const requestId = `audio-request-${index + 1}`;
    const base = Date.parse("2026-07-18T08:00:00.000Z") + index * 4_000;
    for (const [entryIndex, type] of [
      "journey_transition",
      "audio_queued",
      "audio_started",
      "audio_terminal",
    ].entries()) {
      const at = new Date(base + [0, 10, 100, 500][entryIndex]).toISOString();
      trace.push({
        type,
        id: id++,
        at,
        recordedAt: at,
        transitionId,
        requestId: entryIndex === 0 ? null : requestId,
        terminalOutcomeId:
          type === "audio_terminal" ? `audio-terminal:${requestId}` : null,
        outcome: type === "audio_terminal" ? "completed" : null,
      });
    }
  });
  return trace;
}

describe("delayed pickup production evidence algorithms", () => {
  it("decodes real controller bytes and collapses only protocol repeats", () => {
    const frames = [
      dispenseFrame(),
      frame(2, 0, "f0"),
      frame(3, 50, "f0"),
      frame(4, 100, "f0"),
      frame(5, 15_000, "e5"),
      frame(6, 25_000, "e5"),
      frame(7, 30_000, "f1"),
      frame(8, 30_050, "f1"),
      frame(9, 30_100, "f1"),
      frame(10, 30_500, "af"),
      frame(11, 31_000, "f2"),
      frame(12, 31_050, "f2"),
      frame(13, 31_100, "f2"),
    ];
    const result = analyzeDelayedPickupControllerFrames(
      {
        schemaVersion: "host-production-serial-frame-capture/v1",
        binding: { ...binding },
        frames,
      },
      binding,
    );
    assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
    assert.equal(result.timing.firstWarningDeltaMs, 15_000);
    assert.equal(result.events.af.length, 1);
  });

  it("fails closed for fabricated headers, invalid dispense CRC, and non-canonical timestamps", () => {
    const valid = [
      dispenseFrame(),
      frame(2, 0, "f0"),
      frame(3, 50, "f0"),
      frame(4, 100, "f0"),
      frame(5, 15_000, "e5"),
      frame(6, 25_000, "e5"),
      frame(7, 30_000, "f1"),
      frame(8, 30_050, "f1"),
      frame(9, 30_100, "f1"),
      frame(10, 30_500, "af"),
      frame(11, 31_000, "f2"),
      frame(12, 31_050, "f2"),
      frame(13, 31_100, "f2"),
    ];
    const capture = {
      schemaVersion: "host-production-serial-frame-capture/v1",
      binding: { ...binding },
      frames: valid,
    };
    const fabricated = structuredClone(capture);
    fabricated.frames[1].bytesHex = "54f0";
    fabricated.frames[1].digest = `sha256:${createHash("sha256").update(Buffer.from("54f0", "hex")).digest("hex")}`;
    assert.equal(
      analyzeDelayedPickupControllerFrames(fabricated, binding).ok,
      false,
    );

    const badCrc = structuredClone(capture);
    badCrc.frames[0].bytesHex = "55020530";
    badCrc.frames[0].digest = `sha256:${createHash("sha256").update(Buffer.from("55020530", "hex")).digest("hex")}`;
    const badCrcResult = analyzeDelayedPickupControllerFrames(badCrc, binding);
    assert.equal(badCrcResult.ok, false);
    assert.ok(
      badCrcResult.diagnostics.some(
        (entry) => entry.code === "dispense_command_frame_invalid",
      ),
    );

    const nonCanonicalTime = structuredClone(capture);
    nonCanonicalTime.frames[4].capturedAt = "2026-07-18T08:00:15+00:00";
    assert.equal(
      analyzeDelayedPickupControllerFrames(nonCanonicalTime, binding).ok,
      false,
    );

    const whitespaceId = structuredClone(capture);
    whitespaceId.frames[6].binding.commandNo = ` ${binding.commandNo}`;
    assert.equal(
      analyzeDelayedPickupControllerFrames(whitespaceId, binding).ok,
      false,
    );
  });

  it("fails closed for duplicate and out-of-order trace identities and timestamps", () => {
    const evidence = {
      schemaVersion: "machine-production-evidence/v2",
      binding: { ...binding },
      runtime: { ...runtime },
      captureStartedAt: "2026-07-18T07:59:59.000Z",
      captureCompletedAt: "2026-07-18T08:00:20.000Z",
      runtimeTrace: runtimeTraceFixture(),
    };
    assert.equal(
      analyzeDelayedPickupRuntimeTrace(evidence, binding, runtime).ok,
      true,
    );

    const duplicateRequest = structuredClone(evidence);
    duplicateRequest.runtimeTrace[5].requestId = "audio-request-1";
    assert.equal(
      analyzeDelayedPickupRuntimeTrace(duplicateRequest, binding, runtime).ok,
      false,
    );

    const duplicateTerminal = structuredClone(evidence);
    duplicateTerminal.runtimeTrace[7].terminalOutcomeId =
      duplicateTerminal.runtimeTrace[3].terminalOutcomeId;
    assert.equal(
      analyzeDelayedPickupRuntimeTrace(duplicateTerminal, binding, runtime).ok,
      false,
    );

    const outOfOrder = structuredClone(evidence);
    outOfOrder.runtimeTrace[6].at = "2026-07-18T08:00:03.000Z";
    outOfOrder.runtimeTrace[6].recordedAt = outOfOrder.runtimeTrace[6].at;
    const result = analyzeDelayedPickupRuntimeTrace(
      outOfOrder,
      binding,
      runtime,
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.diagnostics.some(
        (entry) =>
          entry.code === "runtime_trace_entry_invalid" ||
          entry.code === "runtime_audio_trace_order_invalid",
      ),
    );
  });

  it("binds UI evidence to the canonical process, target, session, and transaction", () => {
    const evidence = {
      schemaVersion: "machine-production-evidence/v2",
      source: "installed_canonical_machine_cdp",
      binding: { ...binding },
      runtime: { ...runtime },
      captureStartedAt: "2026-07-18T07:59:59.000Z",
      captureCompletedAt: "2026-07-18T08:00:31.000Z",
      uiObservations: [
        ["ordinary_warning", 15_000],
        ["urgent_warning", 25_000],
        ["reset_progress", 30_000],
      ].map(([surface, offset]) => ({
        surface,
        route: "#/dispensing",
        observedAt: new Date(
          Date.parse("2026-07-18T08:00:00.000Z") + offset,
        ).toISOString(),
        binding: { ...binding },
        observedSale: {
          orderId: binding.orderId,
          orderNo: binding.orderNo,
          commandId: binding.commandId,
          commandNo: binding.commandNo,
        },
      })),
      runtimeTrace: [],
    };
    assert.equal(
      analyzeDelayedPickupUiEvidence(evidence, binding, runtime).ok,
      true,
    );
    evidence.uiObservations[1].observedSale.commandNo = "CMD-OTHER";
    const rejected = analyzeDelayedPickupUiEvidence(evidence, binding, runtime);
    assert.equal(rejected.ok, false);
    assert.ok(
      rejected.diagnostics.some(
        (entry) => entry.code === "ui_observation_binding_invalid",
      ),
    );
  });

  it("rejects absent request, transition, terminal IDs and empty cue windows", () => {
    const transitionId = `transaction:${binding.orderNo}:pickup-waiting`;
    const at = "2026-07-18T08:00:00.000Z";
    const evidence = {
      schemaVersion: "machine-production-evidence/v2",
      source: "installed_canonical_machine_cdp",
      binding: { ...binding },
      runtime: { ...runtime },
      captureStartedAt: "2026-07-18T07:59:59.000Z",
      captureCompletedAt: "2026-07-18T08:00:02.000Z",
      runtimeTrace: [
        {
          type: "journey_transition",
          id: 1,
          at,
          recordedAt: at,
          transitionId,
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
        },
        {
          type: "audio_queued",
          id: 2,
          at,
          recordedAt: at,
          transitionId,
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
        },
        {
          type: "audio_started",
          id: 3,
          at,
          recordedAt: at,
          transitionId,
          requestId: null,
          terminalOutcomeId: null,
          outcome: null,
        },
        {
          type: "audio_terminal",
          id: 4,
          at,
          recordedAt: at,
          transitionId,
          requestId: null,
          terminalOutcomeId: null,
          outcome: "completed",
        },
      ],
    };
    const trace = analyzeDelayedPickupRuntimeTrace(evidence, binding, runtime);
    assert.equal(trace.ok, false);
    assert.ok(
      trace.diagnostics.some(
        (entry) => entry.code === "runtime_audio_request_binding_invalid",
      ),
    );
    assert.ok(
      trace.diagnostics.some(
        (entry) => entry.code === "runtime_terminal_outcome_id_invalid",
      ),
    );

    const windows = correlateDelayedPickupCueWindows({
      captureBytes: Buffer.alloc(44),
      captureStartedAt: "2026-07-18T08:00:00.000Z",
      captureCompletedAt: "2026-07-18T08:00:01.000Z",
      cues: {},
    });
    assert.equal(windows.ok, false);
    assert.equal(windows.inspections.length, 0);
    assert.ok(
      windows.diagnostics.some(
        (entry) => entry.code === "audio_cue_window_missing_or_empty",
      ),
    );
  });

  it("enforces the maximum cue start latency after its production transition", () => {
    const trace = runtimeTraceFixture();
    trace[2].at = "2026-07-18T08:00:02.001Z";
    trace[2].recordedAt = trace[2].at;
    trace[3].at = "2026-07-18T08:00:02.500Z";
    trace[3].recordedAt = trace[3].at;
    const result = analyzeDelayedPickupRuntimeTrace(
      {
        schemaVersion: "machine-production-evidence/v2",
        binding: { ...binding },
        runtime: { ...runtime },
        captureStartedAt: "2026-07-18T07:59:59.000Z",
        captureCompletedAt: "2026-07-18T08:00:20.000Z",
        runtimeTrace: trace,
      },
      binding,
      runtime,
    );
    assert.equal(result.ok, false);
    assert.ok(
      result.diagnostics.some(
        (entry) => entry.code === "runtime_audio_cue_start_latency_invalid",
      ),
    );
  });
});
