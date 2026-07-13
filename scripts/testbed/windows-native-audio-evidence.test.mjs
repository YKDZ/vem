import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyWindowsNativeAudioEvidence } from "./windows-native-audio-evidence.mjs";

function fixture() {
  const hash = "a".repeat(64);
  return {
    runId: "RUN-17-AUDIO",
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
        },
      },
      guest: { defaultAudioIdentity: "guest-audio://runtime" },
      evidence: [{ identity: `factory-evidence://sha256/${hash}` }],
      defaultAudioCapture: {
        runId: "RUN-17-AUDIO",
        lifecycleReference: "vm-lifecycle://run-17-audio.runtime",
        captureOperationReference: "vm-operation://op-0123456789abcdef",
        endpoint: { status: "selected", identity: "guest-audio://runtime" },
        nativeCue: {
          status: "emitted",
          source: "tauri_native_audio",
          command: "play_machine_audio",
          emittedAt: "2026-07-13T00:00:01.000Z",
        },
        capture: {
          artifact: `factory-evidence://sha256/${hash}`,
          threshold: {
            minimumPeakAbsoluteSample: 512,
            minimumNonSilentFrames: 2,
          },
          nonSilentFrameCount: 2,
          peakAbsoluteSample: 1024,
          startedAt: "2026-07-13T00:00:00.000Z",
          completedAt: "2026-07-13T00:00:02.000Z",
        },
      },
    },
  };
}

describe("Windows native audio evidence", () => {
  it("accepts a selected default endpoint, active kiosk cue, and synchronized non-silent capture", () => {
    const result = verifyWindowsNativeAudioEvidence(fixture());
    assert.equal(result.result, "passed");
    assert.equal(result.physicalSpeakerAudibility, "not_asserted");
  });

  it("fails session, endpoint, cue, silence, and timing substitutions", () => {
    const input = fixture();
    input.adapterReport.defaultAudioCapture.lifecycleReference =
      "vm-lifecycle://different.runtime";
    input.adapterReport.request.audioCapture.activeKioskSession.sessionId = 7;
    input.adapterReport.defaultAudioCapture.endpoint.status = "missing";
    input.adapterReport.defaultAudioCapture.nativeCue.status = "failed";
    input.adapterReport.defaultAudioCapture.capture.nonSilentFrameCount = 0;
    input.adapterReport.defaultAudioCapture.capture.completedAt =
      "2026-07-13T00:00:00.500Z";
    const result = verifyWindowsNativeAudioEvidence(input);
    assert.equal(result.result, "failed");
    assert.deepEqual(
      result.diagnostics.map((entry) => entry.code),
      [
        "audio_capture_semantic_binding_mismatch",
        "audio_capture_session_mismatch",
        "default_audio_endpoint_missing",
        "tauri_native_audio_cue_missing",
        "default_audio_capture_silent_or_invalid",
        "default_audio_capture_not_synchronized",
      ],
    );
  });
});
