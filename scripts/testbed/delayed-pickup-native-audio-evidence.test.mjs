import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  analyzeDelayedPickupControllerTimeline,
  analyzeDelayedPickupRuntimeTrace,
  analyzeDelayedPickupUiObservations,
  inspectDelayedPickupDefaultAudioCapture,
} from "./delayed-pickup-native-audio-evidence.mjs";
import { inspectWavPcm } from "./default-audio-evidence.mjs";

function stereoWav({
  durationMs,
  sampleRateHz = 48_000,
  windows = [],
}) {
  const frameCount = Math.ceil((durationMs / 1_000) * sampleRateHz);
  const data = Buffer.alloc(frameCount * 4);
  for (const window of windows) {
    const startFrame = Math.max(
      0,
      Math.floor((window.startMs / 1_000) * sampleRateHz),
    );
    const endFrame = Math.min(
      frameCount,
      Math.ceil((window.endMs / 1_000) * sampleRateHz),
    );
    for (let frame = startFrame; frame < endFrame; frame += 1) {
      const sample = [512, 1024, 1536, 2048][frame % 4];
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

function cueTrace(orderNo, baseAt = Date.parse("2026-07-18T08:00:00.000Z")) {
  const definitions = [
    ["pickup-outlet-opened", 500],
    ["pickup-warning-1", 15_100],
    ["pickup-warning-2", 25_100],
    ["pickup-completed", 30_050],
    ["dispense-succeeded", 31_050],
  ];
  let id = 1;
  let request = 1;
  return definitions.flatMap(([suffix, offset]) => {
    const transitionId = `transaction:${orderNo}:${suffix}`;
    const requestId = `audio-request-${request++}`;
    const journeyAt = new Date(baseAt + offset).toISOString();
    const startedAt = new Date(baseAt + offset + 100).toISOString();
    const terminalAt = new Date(baseAt + offset + 900).toISOString();
    return [
      {
        type: "journey_transition",
        id: id++,
        at: journeyAt,
        recordedAt: journeyAt,
        transitionId,
        requestId: null,
        outcome: null,
        message: null,
      },
      {
        type: "audio_queued",
        id: id++,
        at: journeyAt,
        recordedAt: journeyAt,
        transitionId,
        requestId,
        outcome: null,
        message: null,
      },
      {
        type: "audio_started",
        id: id++,
        at: startedAt,
        recordedAt: startedAt,
        transitionId,
        requestId,
        outcome: null,
        message: "native",
      },
      {
        type: "audio_terminal",
        id: id++,
        at: terminalAt,
        recordedAt: terminalAt,
        transitionId,
        requestId,
        outcome: "completed",
        message: null,
      },
    ];
  });
}

describe("delayed pickup native audio evidence helpers", () => {
  it("accepts real delayed-pickup controller timing and reset heartbeat order", () => {
    const timeline = [
      { code: "F0", at: "2026-07-18T08:00:00.000Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
      { code: "E5", at: "2026-07-18T08:00:15.200Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
      { code: "E5", at: "2026-07-18T08:00:25.100Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
      { code: "F1", at: "2026-07-18T08:00:30.150Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
      { code: "AF", at: "2026-07-18T08:00:30.700Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
      { code: "F2", at: "2026-07-18T08:00:31.250Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
    ];

    const result = analyzeDelayedPickupControllerTimeline(timeline);

    assert.equal(result.ok, true);
    assert.equal(result.orderNo, "ORDER-17");
    assert.equal(result.commandNo, "CMD-17");
    assert.equal(result.timing.resetStartDeltaMs, 30_150);
  });

  it("rejects missing AF and regressed controller timing", () => {
    const timeline = [
      { code: "F0", at: "2026-07-18T08:00:00.000Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
      { code: "E5", at: "2026-07-18T08:00:25.200Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
      { code: "E5", at: "2026-07-18T08:00:15.100Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
      { code: "F1", at: "2026-07-18T08:00:34.150Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
      { code: "F2", at: "2026-07-18T08:00:31.250Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
    ];

    const result = analyzeDelayedPickupControllerTimeline(timeline);

    assert.equal(result.ok, false);
    assert.ok(
      result.diagnostics.some(
        (entry) => entry.code === "controller_reset_heartbeat_missing",
      ),
    );
    assert.ok(
      result.diagnostics.some(
        (entry) => entry.code === "controller_reset_start_timing_invalid",
      ),
    );
  });

  it("requires one dispensing route and ordered ordinary, urgent, reset surfaces", () => {
    const result = analyzeDelayedPickupUiObservations([
      {
        surface: "ordinary_warning",
        route: "#/dispensing",
        orderNo: "ORDER-17",
        observedAt: "2026-07-18T08:00:15.500Z",
      },
      {
        surface: "urgent_warning",
        route: "#/dispensing",
        orderNo: "ORDER-17",
        observedAt: "2026-07-18T08:00:25.500Z",
      },
      {
        surface: "reset_progress",
        route: "#/dispensing",
        orderNo: "ORDER-17",
        observedAt: "2026-07-18T08:00:30.500Z",
      },
    ]);

    assert.equal(result.ok, true);
    assert.equal(result.firstBySurface.reset_progress.surface, "reset_progress");
  });

  it("rejects route drift and missing cue transitions in runtime trace", () => {
    const ui = analyzeDelayedPickupUiObservations([
      {
        surface: "ordinary_warning",
        route: "#/dispensing",
        orderNo: "ORDER-17",
        observedAt: "2026-07-18T08:00:15.500Z",
      },
      {
        surface: "urgent_warning",
        route: "#/result",
        orderNo: "ORDER-17",
        observedAt: "2026-07-18T08:00:25.500Z",
      },
      {
        surface: "reset_progress",
        route: "#/dispensing",
        orderNo: "ORDER-17",
        observedAt: "2026-07-18T08:00:30.500Z",
      },
    ]);
    assert.equal(ui.ok, false);
    assert.ok(
      ui.diagnostics.some(
        (entry) => entry.code === "ui_route_not_stable_on_dispensing",
      ),
    );

    const trace = cueTrace("ORDER-17").filter(
      (entry) =>
        entry.transitionId !== "transaction:ORDER-17:pickup-warning-2",
    );
    const traceResult = analyzeDelayedPickupRuntimeTrace(trace, "ORDER-17");
    assert.equal(traceResult.ok, false);
    assert.ok(
      traceResult.diagnostics.some(
        (entry) => entry.code === "runtime_transition_count_invalid",
      ),
    );
  });

  it("binds cue windows to a non-silent exported WAV", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-delayed-pickup-audio-"));
    try {
      const bytes = stereoWav({
        durationMs: 33_000,
        windows: [
          { startMs: 500, endMs: 1_100 },
          { startMs: 15_200, endMs: 15_800 },
          { startMs: 25_200, endMs: 25_800 },
          { startMs: 30_200, endMs: 30_450 },
          { startMs: 31_200, endMs: 31_800 },
        ],
      });
      const digest = createHash("sha256").update(bytes).digest("hex");
      const inspected = inspectWavPcm(bytes, {
        minimumPeakAbsoluteSample: 512,
        minimumNonSilentFrames: 4_800,
        minimumDurationMs: 100,
        minimumDistinctNonSilentSampleMagnitudes: 2,
      });
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, `${digest}.wav`), bytes);
      const adapterReport = {
        evidence: [
          {
            identity: `factory-evidence://sha256/${digest}`,
            digest: `sha256:${digest}`,
            fileName: `${digest}.wav`,
          },
        ],
        defaultAudioCapture: {
          capture: {
            artifact: `factory-evidence://sha256/${digest}`,
            format: inspected.format,
            encoding: inspected.encoding,
            sampleRateHz: inspected.sampleRateHz,
            channels: inspected.channels,
            frameCount: inspected.frameCount,
            threshold: {
              minimumPeakAbsoluteSample: 512,
              minimumNonSilentFrames: 4_800,
              minimumDurationMs: 100,
              minimumDistinctNonSilentSampleMagnitudes: 2,
            },
            nonSilentFrameCount: inspected.nonSilentFrameCount,
            peakAbsoluteSample: inspected.peakAbsoluteSample,
            durationMs: inspected.durationMs,
            distinctNonSilentSampleMagnitudes:
              inspected.distinctNonSilentSampleMagnitudes,
          },
        },
      };
      const result = inspectDelayedPickupDefaultAudioCapture({
        directory: root,
        adapterReport,
        cueWindows: [
          { label: "ordinary_warning", startMs: 15_100, endMs: 15_900 },
          { label: "urgent_warning", startMs: 25_100, endMs: 25_900 },
        ],
      });

      assert.equal(result.ok, true);
      assert.equal(result.cueWindows[0].kind, "passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
