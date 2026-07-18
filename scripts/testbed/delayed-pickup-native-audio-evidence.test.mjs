import assert from "node:assert/strict";
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
  orderId: "order-17",
  orderNo: "ORDER-17",
  commandId: "command-17",
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
  return {
    sequence,
    role: "lower-controller",
    direction: "guest_to_host",
    bytesHex: `80${code}`,
    capturedAt: new Date(
      Date.parse("2026-07-18T08:00:00.000Z") + offset,
    ).toISOString(),
    digest: `sha256:${String(sequence).padStart(64, "0")}`,
    binding: { ...binding },
  };
}

describe("delayed pickup production evidence algorithms", () => {
  it("decodes real controller bytes and collapses only protocol repeats", () => {
    const frames = [
      frame(1, 0, "f0"),
      frame(2, 50, "f0"),
      frame(3, 100, "f0"),
      frame(4, 15_000, "e5"),
      frame(5, 25_000, "e5"),
      frame(6, 30_000, "f1"),
      frame(7, 30_050, "f1"),
      frame(8, 30_100, "f1"),
      frame(9, 30_500, "af"),
      frame(10, 31_000, "f2"),
      frame(11, 31_050, "f2"),
      frame(12, 31_100, "f2"),
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

  it("binds UI evidence to the canonical process, target, session, and transaction", () => {
    const evidence = {
      schemaVersion: "machine-production-evidence/v1",
      source: "installed_canonical_machine_cdp",
      binding: { ...binding },
      runtime: { ...runtime },
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
        runtime: { ...runtime },
      })),
      runtimeTrace: [],
    };
    assert.equal(
      analyzeDelayedPickupUiEvidence(evidence, binding, runtime).ok,
      true,
    );
    evidence.uiObservations[1].runtime.principal = "SITE\\Other";
    const rejected = analyzeDelayedPickupUiEvidence(evidence, binding, runtime);
    assert.equal(rejected.ok, false);
    assert.ok(
      rejected.diagnostics.some(
        (entry) => entry.code === "ui_observation_binding_invalid",
      ),
    );
  });

  it("rejects absent request, transition, terminal IDs and empty cue windows", () => {
    const transitionId = `transaction:${binding.orderNo}:pickup-outlet-opened`;
    const at = "2026-07-18T08:00:00.000Z";
    const evidence = {
      schemaVersion: "machine-production-evidence/v1",
      source: "installed_canonical_machine_cdp",
      binding: { ...binding },
      runtime: { ...runtime },
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
});
