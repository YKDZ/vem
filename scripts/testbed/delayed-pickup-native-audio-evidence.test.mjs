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

function wav(samples, sampleRateHz = 48_000) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRateHz, 24);
  bytes.writeUInt32LE(sampleRateHz * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(data.length, 40);
  data.copy(bytes, 44);
  return bytes;
}

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
    "pickup-outlet-opened",
    "pickup-warning-1",
    "pickup-warning-2",
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

  it("accepts protocol repeats and reset heartbeats recorded at PTY second precision", () => {
    const frames = [
      dispenseFrame(),
      frame(2, 0, "f0"),
      frame(3, 1_000, "f0"),
      frame(4, 1_000, "f0"),
      frame(5, 16_000, "e5"),
      frame(6, 26_000, "e5"),
      frame(7, 31_000, "f1"),
      frame(8, 31_000, "f1"),
      frame(9, 31_000, "f1"),
      frame(10, 31_000, "af"),
      frame(11, 31_000, "af"),
      frame(12, 32_000, "f2"),
      frame(13, 32_000, "f2"),
      frame(14, 32_000, "f2"),
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
    assert.equal(result.events.af.length, 2);
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

  it("keeps valid cue windows and reports only missing windows for incomplete cue timing", () => {
    const sampleRateHz = 48_000;
    const signalDurationMs = 1_500;
    const samples = Array.from(
      { length: Math.ceil((signalDurationMs / 1_000) * sampleRateHz) },
      (_, index) => {
        const frameMs = (index / sampleRateHz) * 1_000;
        return frameMs >= 100 && frameMs < 1_000
          ? index % 2 === 0
            ? 1024
            : 2048
          : 0;
      },
    );

    const result = correlateDelayedPickupCueWindows({
      captureBytes: wav(samples, sampleRateHz),
      captureStartedAt: "2026-07-18T08:00:00.000Z",
      captureCompletedAt: "2026-07-18T08:00:02.000Z",
      cues: {
        pickup_started: {
          started: { at: "2026-07-18T08:00:00.150Z" },
          terminal: { at: "2026-07-18T08:00:00.350Z" },
        },
        ordinary_warning: {
          started: { at: "2026-07-18T08:00:00.450Z" },
          terminal: { at: "2026-07-18T08:00:00.620Z" },
        },
        urgent_warning: {
          started: { at: "2026-07-18T08:00:00.650Z" },
          terminal: { at: "2026-07-18T08:00:00.820Z" },
        },
        dispense_succeeded: {
          started: { at: "2026-07-18T08:00:01.500Z" },
          terminal: { at: null },
        },
      },
    });

    assert.equal(result.ok, false);
    assert.deepEqual(
      result.cueTimings.map((entry) => entry.label),
      ["pickup_started", "ordinary_warning", "urgent_warning"],
    );
    assert.equal(result.inspections.length, 1);
    assert.equal(result.inspections[0].label, "default_output_capture");
    assert.equal(result.inspections[0].kind, "passed");
    assert.ok(
      result.diagnostics.some(
        (entry) =>
          entry.code === "audio_cue_window_missing_or_empty" &&
          entry.detail?.label === "dispense_succeeded",
      ),
      "missing cue timing should be reported per-label",
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

  it("validates cue playback against overall WAV non-silence when wall clock exceeds WAV duration", () => {
    const sampleRateHz = 48_000;
    const signalDurationMs = 1_200;
    const samples = Array.from(
      { length: sampleRateHz * (signalDurationMs / 1_000) },
      (_, index) => {
        const frameMs = (index / sampleRateHz) * 1_000;
        return frameMs >= 100 && frameMs < 900
          ? index % 2 === 0
            ? 1024
            : 2048
          : 0;
      },
    );

    const result = correlateDelayedPickupCueWindows({
      captureBytes: wav(samples, sampleRateHz),
      captureStartedAt: "2026-07-18T08:00:00.000Z",
      captureCompletedAt: "2026-07-18T08:00:02.000Z",
      cues: {
        pickup_started: {
          started: { at: "2026-07-18T08:00:00.150Z" },
          terminal: { at: "2026-07-18T08:00:00.250Z" },
        },
        ordinary_warning: {
          started: { at: "2026-07-18T08:00:00.450Z" },
          terminal: { at: "2026-07-18T08:00:00.540Z" },
        },
        urgent_warning: {
          started: { at: "2026-07-18T08:00:00.650Z" },
          terminal: { at: "2026-07-18T08:00:00.740Z" },
        },
        dispense_succeeded: {
          started: { at: "2026-07-18T08:00:01.500Z" },
          terminal: { at: "2026-07-18T08:00:01.700Z" },
        },
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.cueTimings.length, 4);
    assert.equal(result.inspections.length, 1);
    assert.equal(result.inspections[0].label, "default_output_capture");
    assert.equal(result.inspections[0].kind, "passed");
    assert.equal(
      result.inspections.some((entry) => entry.kind === "malformed"),
      false,
    );
    assert.equal(
      result.diagnostics.some(
        (entry) => entry.code === "cue_audio_window_silent",
      ),
      false,
    );
  });
});
