import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_AUDIO_THRESHOLD,
  inspectWavPcm,
} from "./default-audio-evidence.mjs";

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

describe("default audio evidence PCM inspection", () => {
  it("requires both declared peak and non-silent-frame thresholds", () => {
    const samples = Array.from({ length: 24_000 }, (_, index) =>
      index % 2 === 0 ? 1024 : 2048,
    );
    const result = inspectWavPcm(wav(samples));
    assert.equal(result.kind, "passed");
    assert.equal(result.nonSilentFrameCount, 24_000);
    assert.deepEqual(result.threshold, DEFAULT_AUDIO_THRESHOLD);
  });

  it("rejects a silent but structurally valid capture", () => {
    assert.equal(inspectWavPcm(wav([0, 0, 0])).kind, "silent");
  });

  it("rejects a constant 5 ms buffer even when its samples exceed the peak threshold", () => {
    assert.equal(
      inspectWavPcm(wav(Array.from({ length: 240 }, () => 1024))).kind,
      "silent",
    );
  });

  it("rejects malformed containers", () => {
    assert.deepEqual(inspectWavPcm(Buffer.from("not a wav")).kind, "malformed");
  });

  it("preserves the exact fractional duration of a valid 44.1 kHz capture", () => {
    const samples = Array.from({ length: 24_000 }, (_, index) =>
      index % 2 === 0 ? 1024 : 2048,
    );
    const result = inspectWavPcm(wav(samples, 44_100));

    assert.equal(result.kind, "passed");
    assert.equal(result.durationMs, (24_000 / 44_100) * 1_000);
    assert.equal(Number.isInteger(result.durationMs), false);
  });
});
