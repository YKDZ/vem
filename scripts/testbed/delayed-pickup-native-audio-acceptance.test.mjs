import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { verifyDelayedPickupNativeAudioAcceptance } from "./delayed-pickup-native-audio-acceptance.mjs";
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

function fixture(root) {
  const response = {
    testEvidenceToken: "11111111-2222-4333-8444-555555555555",
    testEvidenceExpiresAt: "2026-07-18T08:05:00.000Z",
    observationRevision: `sha256:${"a".repeat(64)}`,
    observationGeneration: 7,
    configRevision: `sha256:${"b".repeat(64)}`,
    configGeneration: 11,
    proposedSettingsDigest: `sha256:${"c".repeat(64)}`,
    challenge: "d".repeat(64),
  };
  const responseBytes = `${JSON.stringify(response)}\n`;
  const responseHash = createHash("sha256")
    .update(responseBytes)
    .digest("hex");
  const wav = stereoWav({
    durationMs: 33_000,
    windows: [
      { startMs: 600, endMs: 1_100 },
      { startMs: 15_200, endMs: 15_900 },
      { startMs: 25_200, endMs: 25_900 },
      { startMs: 30_200, endMs: 30_500 },
      { startMs: 31_200, endMs: 31_900 },
    ],
  });
  const wavHash = createHash("sha256").update(wav).digest("hex");
  const inspected = inspectWavPcm(wav, {
    minimumPeakAbsoluteSample: 512,
    minimumNonSilentFrames: 4_800,
    minimumDurationMs: 100,
    minimumDistinctNonSilentSampleMagnitudes: 2,
  });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, `${wavHash}.wav`), wav);
  writeFileSync(join(root, `${responseHash}.json`), responseBytes);

  const runId = "RUN-17-DELAYED";
  const runtimeReport = {
    runtimeAcceptanceReport: {
      result: { runtimeReady: { status: "passed" } },
      kioskRuntime: { sessionUser: "VEMKiosk", sessionId: 3 },
    },
  };
  const adapterReport = {
    adapter: { identity: "vm-host-adapter://test@1.0.0", version: "1.0.0" },
    request: {
      runId,
      operation: "capture-default-audio",
      operationReference: "vm-operation://op-0123456789abcdef",
      lifecycleReference: "vm-lifecycle://run-17-delayed.runtime",
      audioCapture: {
        activeKioskSession: { sessionUser: "VEMKiosk", sessionId: 3 },
        daemonCalibration: {
          source: "vending_daemon_ipc",
          command: "audio_output_calibration",
          challenge: response.challenge,
        },
      },
    },
    evidence: [
      {
        identity: `factory-evidence://sha256/${wavHash}`,
        digest: `sha256:${wavHash}`,
        fileName: `${wavHash}.wav`,
      },
      {
        role: "daemon-audio-calibration-response",
        identity: `factory-evidence://sha256/${responseHash}`,
        digest: `sha256:${responseHash}`,
        fileName: `${responseHash}.json`,
      },
    ],
    defaultAudioCapture: {
      runId,
      lifecycleReference: "vm-lifecycle://run-17-delayed.runtime",
      captureOperationReference: "vm-operation://op-0123456789abcdef",
      defaultOutput: { status: "active" },
      daemonCalibration: {
        status: "completed",
        source: "vending_daemon_ipc",
        command: "audio_output_calibration",
        challenge: response.challenge,
        responseArtifact: `factory-evidence://sha256/${responseHash}`,
        responseDigest: `sha256:${responseHash}`,
        responseFileName: `${responseHash}.json`,
        startedAt: "2026-07-18T08:00:00.250Z",
        completedAt: "2026-07-18T08:00:00.750Z",
      },
      capture: {
        artifact: `factory-evidence://sha256/${wavHash}`,
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
        startedAt: "2026-07-18T08:00:00.000Z",
        completedAt: "2026-07-18T08:00:33.000Z",
      },
    },
  };
  const runtimeTrace = (() => {
    const definitions = [
      ["pickup-outlet-opened", 500],
      ["pickup-warning-1", 15_300],
      ["pickup-warning-2", 25_300],
      ["pickup-completed", 30_250],
      ["dispense-succeeded", 31_300],
    ];
    let id = 1;
    let request = 1;
    return definitions.flatMap(([suffix, offset]) => {
      const transitionId = `transaction:ORDER-17:${suffix}`;
      const requestId = `audio-request-${request++}`;
      const journeyAt = new Date(
        Date.parse("2026-07-18T08:00:00.000Z") + offset,
      ).toISOString();
      const startedAt = new Date(
        Date.parse("2026-07-18T08:00:00.000Z") + offset + 100,
      ).toISOString();
      const terminalAt = new Date(
        Date.parse("2026-07-18T08:00:00.000Z") + offset + 800,
      ).toISOString();
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
  })();
  const uiObservations = [
    {
      surface: "ordinary_warning",
      route: "#/dispensing",
      orderNo: "ORDER-17",
      observedAt: "2026-07-18T08:00:15.400Z",
    },
    {
      surface: "urgent_warning",
      route: "#/dispensing",
      orderNo: "ORDER-17",
      observedAt: "2026-07-18T08:00:25.400Z",
    },
    {
      surface: "reset_progress",
      route: "#/dispensing",
      orderNo: "ORDER-17",
      observedAt: "2026-07-18T08:00:30.300Z",
    },
  ];
  const controllerTimeline = [
    { code: "F0", at: "2026-07-18T08:00:00.000Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
    { code: "E5", at: "2026-07-18T08:00:15.200Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
    { code: "E5", at: "2026-07-18T08:00:25.100Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
    { code: "F1", at: "2026-07-18T08:00:30.150Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
    { code: "AF", at: "2026-07-18T08:00:30.700Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
    { code: "F2", at: "2026-07-18T08:00:31.250Z", orderNo: "ORDER-17", commandNo: "CMD-17" },
  ];
  return {
    runId,
    daemonCalibrationResponse: response,
    daemonCalibrationResponseBytes: responseBytes,
    runtimeReport,
    adapterReport,
    runtimeTrace,
    uiObservations,
    controllerTimeline,
    evidenceDirectory: root,
  };
}

describe("delayed pickup native audio acceptance", () => {
  it("accepts correlated delayed pickup, runtime trace, and non-silent cue windows", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-delayed-pickup-acceptance-"));
    try {
      const input = fixture(root);
      const result = verifyDelayedPickupNativeAudioAcceptance(input);

      assert.equal(result.result, "passed", JSON.stringify(result.diagnostics));
      assert.equal(result.nativeAudio.report.result, "passed");
      assert.equal(result.delayedPickup.orderNo, "ORDER-17");
      assert.equal(result.nativeAudio.capture.cueWindows[0].kind, "passed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when the reset UI leaves dispensing and the urgent cue window is silent", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-delayed-pickup-acceptance-"));
    try {
      const input = fixture(root);
      input.uiObservations[2].route = "#/result";
      input.runtimeTrace = input.runtimeTrace.map((entry) =>
        entry.transitionId === "transaction:ORDER-17:pickup-warning-2" &&
        entry.type === "audio_terminal"
          ? { ...entry, outcome: "failed" }
          : entry,
      );
      const bytes = readFileSync(
        join(root, input.adapterReport.evidence[0].fileName),
      );
      const silentUrgent = Buffer.from(bytes);
      const sampleRate = 48_000;
      const startFrame = Math.floor((25_200 / 1_000) * sampleRate);
      const endFrame = Math.ceil((25_900 / 1_000) * sampleRate);
      for (let frame = startFrame; frame < endFrame; frame += 1) {
        silentUrgent.writeInt16LE(0, 44 + frame * 4);
        silentUrgent.writeInt16LE(0, 46 + frame * 4);
      }
      writeFileSync(
        join(root, input.adapterReport.evidence[0].fileName),
        silentUrgent,
      );

      const result = verifyDelayedPickupNativeAudioAcceptance(input);

      assert.equal(result.result, "failed");
      assert.ok(
        result.diagnostics.some(
          (entry) => entry.code === "ui_route_not_stable_on_dispensing",
        ),
      );
      assert.ok(
        result.diagnostics.some(
          (entry) => entry.code === "runtime_audio_terminal_outcome_invalid",
        ),
      );
      assert.ok(
        result.diagnostics.some(
          (entry) =>
            entry.code === "cue_audio_window_silent" ||
            entry.code === "default_audio_capture_export_invalid",
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
