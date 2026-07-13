import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DEFAULT_AUDIO_THRESHOLD,
  inspectWavPcm,
} from "./default-audio-evidence.mjs";

function wav(samples) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(sample, index * 2));
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24);
  bytes.writeUInt32LE(96000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(data.length, 40);
  data.copy(bytes, 44);
  return bytes;
}

describe("default audio evidence PCM inspection", () => {
  it("requires both declared peak and non-silent-frame thresholds", () => {
    const samples = Array.from({ length: 20 }, () => 1024);
    const result = inspectWavPcm(wav(samples));
    assert.equal(result.kind, "passed");
    assert.equal(result.nonSilentFrameCount, 20);
    assert.deepEqual(result.threshold, DEFAULT_AUDIO_THRESHOLD);
  });

  it("rejects a silent but structurally valid capture", () => {
    assert.equal(inspectWavPcm(wav([0, 0, 0])).kind, "silent");
  });

  it("rejects malformed containers", () => {
    assert.deepEqual(inspectWavPcm(Buffer.from("not a wav")).kind, "malformed");
  });
});
