import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_PCM_NON_SILENCE_THRESHOLD,
  inspectWavPcmNonSilence,
  verifyLogicalDefaultAudioEvidence,
} from "./default-audio-evidence.mjs";

const RUN_ID = "RUN-17-AUDIO";
const SESSION = { sessionUser: "VEMKiosk", sessionId: 3 };
const ARTIFACT = {
  identity: `factory-evidence://sha256/${"a".repeat(64)}`,
  sha256: "a".repeat(64),
};

function wavPcm16(samples, { channels = 1, sampleRateHz = 48_000 } = {}) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRateHz, 24);
  bytes.writeUInt32LE(sampleRateHz * channels * 2, 28);
  bytes.writeUInt16LE(channels * 2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(data.length, 40);
  data.copy(bytes, 44);
  return bytes;
}

function audioInput(overrides = {}) {
  return {
    runId: RUN_ID,
    captureOperationReference: "vm-operation://op-1234567890abcdef",
    adapter: {
      identity: "vm-host-adapter://testbed-audio@1.0.0",
      version: "1.0.0",
    },
    endpoint: {
      status: "selected",
      identity: "guest-audio://testbed-default-output",
    },
    nativeCue: {
      runId: RUN_ID,
      status: "emitted",
      source: "tauri_native_audio",
      ...SESSION,
    },
    captureArtifact: ARTIFACT,
    wavBytes: wavPcm16([0, 768, -1_024, 0]),
    expectedSession: SESSION,
    ...overrides,
  };
}

describe("logical default audio evidence", () => {
  it("accepts WAV PCM with frames above the declared non-silence threshold", () => {
    const result = inspectWavPcmNonSilence(wavPcm16([0, 768, -1_024, 0]));
    assert.deepEqual(result, {
      ok: true,
      kind: "passed",
      format: "wav_pcm",
      encoding: "pcm_s16le",
      sampleRateHz: 48_000,
      channels: 1,
      frameCount: 4,
      threshold: DEFAULT_PCM_NON_SILENCE_THRESHOLD,
      nonSilentFrameCount: 2,
      peakAbsoluteSample: 1_024,
    });
  });

  it("emits a sanitized contract-shaped logical capture summary", () => {
    const result = verifyLogicalDefaultAudioEvidence(audioInput());
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.evidence.capture).sort(), [
      "artifact",
      "channels",
      "encoding",
      "format",
      "frameCount",
      "nonSilentFrameCount",
      "peakAbsoluteSample",
      "sampleRateHz",
      "status",
      "threshold",
    ]);
    assert.equal("ok" in result.evidence.capture, false);
    assert.equal("kind" in result.evidence.capture, false);
  });

  it("marks a valid silent PCM capture as non-accepting evidence", () => {
    const result = verifyLogicalDefaultAudioEvidence({
      ...audioInput(),
      wavBytes: wavPcm16([0, 0, 0, 0]),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, ["default_audio_capture_silent"]);
    assert.equal(result.evidence.capture.status, "silent");
    assert.equal(result.evidence.physicalSpeakerAudibility, "not_asserted");
  });

  it("rejects malformed RIFF/WAV captures without treating them as silence", () => {
    const result = verifyLogicalDefaultAudioEvidence({
      ...audioInput(),
      wavBytes: Buffer.from("not-a-wav"),
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, ["default_audio_capture_malformed"]);
    assert.equal(result.evidence.capture.status, "malformed");
    assert.match(result.evidence.capture.reason, /RIFF/);
  });

  it("rejects evidence without a selected default endpoint", () => {
    const result = verifyLogicalDefaultAudioEvidence({
      ...audioInput(),
      endpoint: { status: "missing", identity: null },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, ["default_audio_endpoint_missing"]);
  });

  it("binds the native cue to the requested run and kiosk session", () => {
    const result = verifyLogicalDefaultAudioEvidence({
      ...audioInput(),
      nativeCue: {
        ...audioInput().nativeCue,
        runId: "RUN-OTHER",
        sessionId: 7,
      },
    });
    assert.equal(result.ok, false);
    assert.deepEqual(result.diagnostics, [
      "default_audio_run_or_session_mismatch",
    ]);
  });
});
