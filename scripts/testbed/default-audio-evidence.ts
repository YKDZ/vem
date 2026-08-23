import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_AUDIO_THRESHOLD = Object.freeze({
  minimumPeakAbsoluteSample: 512,
  minimumNonSilentFrames: 24_000,
  minimumDurationMs: 500,
  minimumDistinctNonSilentSampleMagnitudes: 2,
});

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function malformed(message: string): JsonRecord {
  return { ok: false, kind: "malformed", message };
}

function sampleMagnitude(bytes: Buffer, offset: number, bits: number): number {
  if (bits === 8) return Math.abs(bytes.readUInt8(offset) - 128);
  if (bits === 16) return Math.abs(bytes.readInt16LE(offset));
  if (bits === 24) {
    const value = bytes.readUIntLE(offset, 3);
    return Math.abs(value & 0x800000 ? value - 0x1000000 : value);
  }
  return Math.abs(bytes.readInt32LE(offset));
}

function parseWavPcm(bytes: Buffer): JsonRecord {
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
  return {
    ok: true,
    format: "wav_pcm",
    encoding,
    sampleRateHz: format.sampleRateHz,
    channels: format.channels,
    frameCount: data.length / format.blockAlign,
    blockAlign: format.blockAlign,
    bytesPerSample,
    bits: format.bits,
    data,
  };
}

function inspectParsedWavPcm(
  parsed: JsonRecord,
  threshold: JsonRecord,
  {
    startMs = 0,
    endMs = null,
    label = null,
  }: {
    startMs?: number;
    endMs?: number | null;
    label?: string | null;
  } = {},
): JsonRecord {
  if (!parsed.ok) return parsed;
  const normalizedStartMs = Number.isFinite(startMs) ? Math.max(0, startMs) : 0;
  const normalizedEndMs =
    endMs === null || endMs === undefined
      ? null
      : Number.isFinite(endMs)
        ? Math.max(normalizedStartMs, endMs)
        : null;
  const startFrame = Math.max(
    0,
    Math.floor(
      (normalizedStartMs / 1_000) * Number(parsed.sampleRateHz),
    ),
  );
  const unclampedEndFrame =
    normalizedEndMs === null
      ? Number(parsed.frameCount)
      : Math.ceil((normalizedEndMs / 1_000) * Number(parsed.sampleRateHz));
  const endFrame = Math.min(Number(parsed.frameCount), unclampedEndFrame);
  if (endFrame <= startFrame)
    return malformed("WAV inspection window must span at least one frame");
  let peakAbsoluteSample = 0;
  let nonSilentFrameCount = 0;
  const nonSilentSampleMagnitudes = new Set();
  for (let frame = startFrame; frame < endFrame; frame += 1) {
    let framePeak = 0;
    for (
      let channel = 0;
      channel < Number(parsed.channels);
      channel += 1
    )
      framePeak = Math.max(
        framePeak,
        sampleMagnitude(
          parsed.data as Buffer,
          frame * Number(parsed.blockAlign) +
            channel * Number(parsed.bytesPerSample),
          Number(parsed.bits),
        ),
      );
    peakAbsoluteSample = Math.max(peakAbsoluteSample, framePeak);
    if (framePeak >= Number(threshold.minimumPeakAbsoluteSample)) {
      nonSilentFrameCount += 1;
      nonSilentSampleMagnitudes.add(framePeak);
    }
  }
  const frameCount = endFrame - startFrame;
  const durationMs = (frameCount / Number(parsed.sampleRateHz)) * 1_000;
  return {
    ok: true,
    kind:
      nonSilentFrameCount >= Number(threshold.minimumNonSilentFrames) &&
      peakAbsoluteSample >= Number(threshold.minimumPeakAbsoluteSample) &&
      durationMs >= Number(threshold.minimumDurationMs) &&
      nonSilentSampleMagnitudes.size >=
        Number(threshold.minimumDistinctNonSilentSampleMagnitudes)
        ? "passed"
        : "silent",
    label,
    format: parsed.format,
    encoding: parsed.encoding,
    sampleRateHz: parsed.sampleRateHz,
    channels: parsed.channels,
    frameCount,
    durationMs,
    threshold: { ...threshold },
    nonSilentFrameCount,
    peakAbsoluteSample,
    distinctNonSilentSampleMagnitudes: nonSilentSampleMagnitudes.size,
    window: {
      startMs: normalizedStartMs,
      endMs:
        normalizedEndMs ??
        (Number(parsed.frameCount) / Number(parsed.sampleRateHz)) * 1_000,
    },
  };
}

export function inspectWavPcm(
  bytes: Buffer,
  threshold: JsonRecord = DEFAULT_AUDIO_THRESHOLD,
): JsonRecord {
  const parsed = parseWavPcm(bytes);
  return inspectParsedWavPcm(parsed, threshold);
}

export function inspectWavPcmWindows(
  bytes: Buffer,
  windows: JsonRecord[],
  threshold: JsonRecord = DEFAULT_AUDIO_THRESHOLD,
): JsonRecord[] {
  const parsed = parseWavPcm(bytes);
  return windows.map((window: JsonRecord) =>
    inspectParsedWavPcm(parsed, threshold, {
      startMs: Number(window?.startMs),
      endMs:
        window?.endMs == null ? null : Number(window?.endMs),
      label: window?.label == null ? null : String(window?.label),
    }),
  );
}

export function inspectExportedDefaultAudioCapture({
  directory,
  evidence,
  capture,
}: {
  directory: string;
  evidence: JsonRecord;
  capture: JsonRecord;
}): JsonRecord {
  if (!/^[a-f0-9]{64}\.wav$/.test(String(evidence?.fileName ?? "")))
    throw new Error(
      "default audio evidence must use a digest-bound relative WAV file name",
    );
  const bytes = readFileSync(join(directory, String(evidence.fileName)));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (
    evidence.identity !== `runtime-evidence://sha256/${digest}` ||
    evidence.digest !== `sha256:${digest}`
  )
    throw new Error(
      "default audio evidence file digest does not match its logical identity",
    );
  const inspected = recordValue(
    inspectWavPcm(bytes, recordValue(capture.threshold)),
  );
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
  return {
    ...inspected,
    sha256: digest,
    byteLength: bytes.length,
  };
}
