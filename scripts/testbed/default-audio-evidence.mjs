import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_AUDIO_THRESHOLD = Object.freeze({
  minimumPeakAbsoluteSample: 512,
  minimumNonSilentFrames: 24_000,
  minimumDurationMs: 500,
  minimumDistinctNonSilentSampleMagnitudes: 2,
});

function malformed(message) {
  return { ok: false, kind: "malformed", message };
}

function sampleMagnitude(bytes, offset, bits) {
  if (bits === 8) return Math.abs(bytes.readUInt8(offset) - 128);
  if (bits === 16) return Math.abs(bytes.readInt16LE(offset));
  if (bits === 24) {
    const value = bytes.readUIntLE(offset, 3);
    return Math.abs(value & 0x800000 ? value - 0x1000000 : value);
  }
  return Math.abs(bytes.readInt32LE(offset));
}

export function inspectWavPcm(bytes, threshold = DEFAULT_AUDIO_THRESHOLD) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 44)
    return malformed("capture must be a complete RIFF/WAV buffer");
  if (
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE"
  )
    return malformed("capture must be a RIFF/WAVE container");
  if (bytes.readUInt32LE(4) + 8 !== bytes.length)
    return malformed("RIFF size does not match capture bytes");
  let format = null;
  let data = null;
  for (let offset = 12; offset < bytes.length; ) {
    if (offset + 8 > bytes.length)
      return malformed("WAV chunk header is truncated");
    const id = bytes.toString("ascii", offset, offset + 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length) return malformed(`WAV ${id} chunk is truncated`);
    if (id === "fmt ") {
      if (format || size < 16)
        return malformed("WAV must contain one complete PCM fmt chunk");
      format = {
        audioFormat: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRateHz: bytes.readUInt32LE(start + 4),
        byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12),
        bits: bytes.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      if (data) return malformed("WAV must contain one data chunk");
      data = bytes.subarray(start, end);
    }
    offset = end + (size % 2);
  }
  if (!format || !data || format.audioFormat !== 1)
    return malformed("capture must contain PCM format and data chunks");
  const encoding = {
    8: "pcm_u8",
    16: "pcm_s16le",
    24: "pcm_s24le",
    32: "pcm_s32le",
  }[format.bits];
  const bytesPerSample = format.bits / 8;
  if (
    !encoding ||
    !format.channels ||
    !format.sampleRateHz ||
    format.blockAlign !== format.channels * bytesPerSample ||
    format.byteRate !== format.sampleRateHz * format.blockAlign ||
    !data.length ||
    data.length % format.blockAlign
  )
    return malformed("WAV PCM format fields or frames are invalid");
  let peakAbsoluteSample = 0;
  let nonSilentFrameCount = 0;
  const nonSilentSampleMagnitudes = new Set();
  const frameCount = data.length / format.blockAlign;
  for (let frame = 0; frame < frameCount; frame += 1) {
    let framePeak = 0;
    for (let channel = 0; channel < format.channels; channel += 1)
      framePeak = Math.max(
        framePeak,
        sampleMagnitude(
          data,
          frame * format.blockAlign + channel * bytesPerSample,
          format.bits,
        ),
      );
    peakAbsoluteSample = Math.max(peakAbsoluteSample, framePeak);
    if (framePeak >= threshold.minimumPeakAbsoluteSample) {
      nonSilentFrameCount += 1;
      nonSilentSampleMagnitudes.add(framePeak);
    }
  }
  const durationMs = (frameCount / format.sampleRateHz) * 1_000;
  return {
    ok: true,
    kind:
      nonSilentFrameCount >= threshold.minimumNonSilentFrames &&
      peakAbsoluteSample >= threshold.minimumPeakAbsoluteSample &&
      durationMs >= threshold.minimumDurationMs &&
      nonSilentSampleMagnitudes.size >=
        threshold.minimumDistinctNonSilentSampleMagnitudes
        ? "passed"
        : "silent",
    format: "wav_pcm",
    encoding,
    sampleRateHz: format.sampleRateHz,
    channels: format.channels,
    frameCount,
    durationMs,
    threshold: { ...threshold },
    nonSilentFrameCount,
    peakAbsoluteSample,
    distinctNonSilentSampleMagnitudes: nonSilentSampleMagnitudes.size,
  };
}

export function inspectExportedDefaultAudioCapture({
  directory,
  evidence,
  capture,
}) {
  if (!/^[a-f0-9]{64}\.wav$/.test(evidence?.fileName ?? ""))
    throw new Error(
      "default audio evidence must use a digest-bound relative WAV file name",
    );
  const bytes = readFileSync(join(directory, evidence.fileName));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (
    evidence.identity !== `factory-evidence://sha256/${digest}` ||
    evidence.digest !== `sha256:${digest}`
  )
    throw new Error(
      "default audio evidence file digest does not match its logical identity",
    );
  const inspected = inspectWavPcm(bytes, capture.threshold);
  if (!inspected.ok || inspected.kind !== "passed")
    throw new Error(
      `default audio PCM capture is ${inspected.kind}: ${inspected.message ?? "below threshold"}`,
    );
  for (const key of [
    "format",
    "encoding",
    "sampleRateHz",
    "channels",
    "frameCount",
    "durationMs",
    "nonSilentFrameCount",
    "peakAbsoluteSample",
    "distinctNonSilentSampleMagnitudes",
  ]) {
    if (capture[key] !== inspected[key])
      throw new Error(
        `default audio capture ${key} does not match exported WAV inspection`,
      );
  }
  return inspected;
}
