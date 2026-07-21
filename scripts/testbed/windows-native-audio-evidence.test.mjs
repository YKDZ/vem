import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import { verifyWindowsNativeAudioEvidence } from "./windows-native-audio-evidence.mjs";

function fixture() {
  const hash = "a".repeat(64);
  const daemonCalibrationResponse = {
    testEvidenceToken: "11111111-2222-4333-8444-555555555555",
    testEvidenceExpiresAt: "2026-07-13T00:05:00.000Z",
    observationRevision: `sha256:${"c".repeat(64)}`,
    observationGeneration: 7,
    configRevision: `sha256:${"d".repeat(64)}`,
    configGeneration: 11,
    proposedSettingsDigest: `sha256:${"e".repeat(64)}`,
    challenge: "b".repeat(64),
  };
  const daemonCalibrationResponseBytes = `${JSON.stringify(daemonCalibrationResponse)}\n`;
  const responseHash = createHash("sha256")
    .update(daemonCalibrationResponseBytes)
    .digest("hex");
  return {
    runId: "RUN-17-AUDIO",
    daemonCalibrationResponse,
    daemonCalibrationResponseBytes,
    runtimeReport: {
      runtimeAcceptanceReport: {
        result: { runtimeReady: { status: "passed" } },
        kioskRuntime: { sessionUser: "VEMKiosk", sessionId: 3 },
      },
    },
    adapterReport: {
      adapter: { identity: "vm-host-adapter://test@1.0.0", version: "1.0.0" },
      request: {
        runId: "RUN-17-AUDIO",
        operation: "capture-default-audio",
        operationReference: "vm-operation://op-0123456789abcdef",
        lifecycleReference: "vm-lifecycle://run-17-audio.runtime",
        audioCapture: {
          activeKioskSession: { sessionUser: "VEMKiosk", sessionId: 3 },
          daemonCalibration: {
            source: "vending_daemon_ipc",
            command: "audio_output_calibration",
            challenge: "b".repeat(64),
          },
        },
      },
      guest: { defaultAudioIdentity: "guest-audio://runtime" },
      evidence: [
        { identity: `runtime-evidence://sha256/${hash}` },
        {
          role: "daemon-audio-calibration-response",
          identity: `runtime-evidence://sha256/${responseHash}`,
          digest: `sha256:${responseHash}`,
          fileName: `${responseHash}.json`,
        },
      ],
      defaultAudioCapture: {
        runId: "RUN-17-AUDIO",
        lifecycleReference: "vm-lifecycle://run-17-audio.runtime",
        captureOperationReference: "vm-operation://op-0123456789abcdef",
        defaultOutput: {
          status: "active",
        },
        daemonCalibration: {
          status: "completed",
          source: "vending_daemon_ipc",
          command: "audio_output_calibration",
          challenge: "b".repeat(64),
          responseArtifact: `runtime-evidence://sha256/${responseHash}`,
          responseDigest: `sha256:${responseHash}`,
          responseFileName: `${responseHash}.json`,
          startedAt: "2026-07-13T00:00:00.500Z",
          completedAt: "2026-07-13T00:00:01.500Z",
        },
        capture: {
          artifact: `runtime-evidence://sha256/${hash}`,
          threshold: {
            minimumPeakAbsoluteSample: 512,
            minimumNonSilentFrames: 24_000,
            minimumDurationMs: 500,
            minimumDistinctNonSilentSampleMagnitudes: 2,
          },
          nonSilentFrameCount: 24_000,
          peakAbsoluteSample: 2048,
          durationMs: 500,
          distinctNonSilentSampleMagnitudes: 4,
          startedAt: "2026-07-13T00:00:00.000Z",
          completedAt: "2026-07-13T00:00:02.000Z",
        },
      },
    },
  };
}

describe("Windows native audio evidence", () => {
  it("accepts daemon calibration through the Windows default output with synchronized non-silent capture", () => {
    const result = verifyWindowsNativeAudioEvidence(fixture());
    assert.equal(result.result, "passed");
    assert.equal(result.schemaVersion, "windows-native-audio-evidence/v2");
    assert.equal(result.audioOutput, "windows_default");
    assert.equal(result.physicalSpeakerAudibility, "hitl_required");
  });

  it("fails session, default-output, daemon evidence, silence, and timing substitutions", () => {
    const input = fixture();
    input.adapterReport.defaultAudioCapture.lifecycleReference =
      "vm-lifecycle://different.runtime";
    input.adapterReport.request.audioCapture.activeKioskSession.sessionId = 7;
    input.adapterReport.defaultAudioCapture.defaultOutput.status = "missing";
    input.adapterReport.defaultAudioCapture.daemonCalibration.source =
      "tauri_native_audio";
    input.adapterReport.defaultAudioCapture.daemonCalibration.command =
      "play_machine_audio";
    input.daemonCalibrationResponse.testEvidenceToken = "";
    input.daemonCalibrationResponse.challenge = "c".repeat(64);
    input.adapterReport.defaultAudioCapture.capture.nonSilentFrameCount = 0;
    input.adapterReport.defaultAudioCapture.capture.completedAt =
      "2026-07-13T00:00:00.500Z";
    const result = verifyWindowsNativeAudioEvidence(input);
    assert.equal(result.result, "failed");
    assert.deepEqual(
      result.diagnostics.map((entry) => entry.code),
      [
        "audio_capture_semantic_binding_mismatch",
        "audio_capture_challenge_mismatch",
        "audio_capture_session_mismatch",
        "windows_default_output_missing",
        "daemon_audio_calibration_evidence_missing",
        "default_audio_capture_silent_or_invalid",
        "default_audio_capture_not_synchronized",
      ],
    );
  });

  it("rejects the legacy Tauri playback path as Windows default-output evidence", () => {
    const input = fixture();
    input.adapterReport.request.audioCapture.daemonCalibration.source =
      "tauri_native_audio";
    input.adapterReport.request.audioCapture.daemonCalibration.command =
      "play_machine_audio";
    input.adapterReport.defaultAudioCapture.daemonCalibration.source =
      "tauri_native_audio";
    input.adapterReport.defaultAudioCapture.daemonCalibration.command =
      "play_machine_audio";

    const result = verifyWindowsNativeAudioEvidence(input);

    assert.equal(result.result, "failed");
    assert.ok(
      result.diagnostics.some(
        (entry) => entry.code === "daemon_audio_calibration_evidence_missing",
      ),
    );
  });

  it("requires the inner runtime response instead of accepting a response-shaped wrapper", () => {
    const input = fixture();
    input.runtimeReport = input.runtimeReport.runtimeAcceptanceReport;
    const result = verifyWindowsNativeAudioEvidence(input);
    assert.equal(result.result, "failed");
    assert.deepEqual(result.diagnostics, [
      { code: "runtime_acceptance_not_ready" },
      { code: "active_kiosk_session_missing" },
      { code: "audio_capture_session_mismatch" },
    ]);
  });
});
