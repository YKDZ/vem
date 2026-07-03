import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("maintenance Machine Audio test tone asset", () => {
  it("is a valid audible PCM WAV packaged with the machine UI", () => {
    const tone = readFileSync(
      new URL("./maintenance-test-tone.wav", import.meta.url),
    );

    expect(tone.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(tone.subarray(8, 12).toString("ascii")).toBe("WAVE");

    const fmtOffset = findChunk(tone, "fmt ");
    expect(fmtOffset).toBeGreaterThan(0);
    expect(tone.readUInt16LE(fmtOffset + 8)).toBe(1);
    expect(tone.readUInt16LE(fmtOffset + 10)).toBe(1);
    expect(tone.readUInt32LE(fmtOffset + 12)).toBe(44_100);
    expect(tone.readUInt16LE(fmtOffset + 22)).toBe(16);

    const dataOffset = findChunk(tone, "data");
    const dataByteLength = tone.readUInt32LE(dataOffset + 4);
    const pcm = tone.subarray(dataOffset + 8, dataOffset + 8 + dataByteLength);
    const nonZeroBytes = pcm.reduce(
      (count, value) => count + (value === 0 ? 0 : 1),
      0,
    );

    expect(dataByteLength).toBeGreaterThan(20_000);
    expect(nonZeroBytes).toBeGreaterThan(dataByteLength / 3);
  });
});

function findChunk(wav: Buffer, chunkId: string): number {
  let offset = 12;
  while (offset + 8 <= wav.length) {
    if (wav.subarray(offset, offset + 4).toString("ascii") === chunkId) {
      return offset;
    }
    offset += 8 + wav.readUInt32LE(offset + 4);
  }
  throw new Error(`${chunkId} chunk not found`);
}
