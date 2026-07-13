const RIFF = "RIFF";
const WAVE = "WAVE";
const PCM_FORMAT = 1;

export const DEFAULT_PCM_NON_SILENCE_THRESHOLD = Object.freeze({
  minimumPeakAbsoluteSample: 512,
  minimumNonSilentFrames: 1,
});

function malformed(message) {
  return { ok: false, kind: "malformed", message };
}

function readAscii(bytes, offset, length) {
  return bytes.subarray(offset, offset + length).toString("ascii");
}

function encodingForBitsPerSample(bitsPerSample) {
  return {
    8: "pcm_u8",
    16: "pcm_s16le",
    24: "pcm_s24le",
    32: "pcm_s32le",
  }[bitsPerSample];
}

function readAbsolutePcmSample(bytes, offset, bitsPerSample) {
  if (bitsPerSample === 8) return Math.abs(bytes.readUInt8(offset) - 128);
  if (bitsPerSample === 16) return Math.abs(bytes.readInt16LE(offset));
  if (bitsPerSample === 24) {
    const unsigned = bytes.readUIntLE(offset, 3);
    const signed = unsigned & 0x800000 ? unsigned - 0x1000000 : unsigned;
    return Math.abs(signed);
  }
  return Math.abs(bytes.readInt32LE(offset));
}

function parseWavPcm(bytes) {
  if (!Buffer.isBuffer(bytes)) return malformed("Capture must be a Buffer.");
  if (bytes.length < 12)
    return malformed("WAV capture is shorter than the RIFF header.");
  if (readAscii(bytes, 0, 4) !== RIFF || readAscii(bytes, 8, 4) !== WAVE)
    return malformed("Capture must be a RIFF/WAVE container.");
  if (bytes.readUInt32LE(4) + 8 !== bytes.length)
    return malformed("RIFF chunk size does not match capture length.");

  let format;
  let data;
  let offset = 12;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length)
      return malformed("WAV capture contains a truncated chunk header.");
    const id = readAscii(bytes, offset, 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.length) return malformed(`WAV ${id} chunk is truncated.`);
    if (id === "fmt ") {
      if (format) return malformed("WAV capture contains multiple fmt chunks.");
      if (size < 16)
        return malformed("WAV fmt chunk is shorter than PCM fields.");
      format = {
        audioFormat: bytes.readUInt16LE(start),
        channels: bytes.readUInt16LE(start + 2),
        sampleRateHz: bytes.readUInt32LE(start + 4),
        byteRate: bytes.readUInt32LE(start + 8),
        blockAlign: bytes.readUInt16LE(start + 12),
        bitsPerSample: bytes.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      if (data) return malformed("WAV capture contains multiple data chunks.");
      data = bytes.subarray(start, end);
    }
    offset = end + (size % 2);
    if (offset > bytes.length)
      return malformed(`WAV ${id} chunk is missing its alignment byte.`);
  }
  if (!format) return malformed("WAV capture is missing its fmt chunk.");
  if (!data) return malformed("WAV capture is missing its data chunk.");
  if (format.audioFormat !== PCM_FORMAT)
    return malformed("WAV capture must use uncompressed PCM encoding.");
  const encoding = encodingForBitsPerSample(format.bitsPerSample);
  if (!encoding)
    return malformed("WAV PCM bit depth must be 8, 16, 24, or 32.");
  if (format.channels === 0 || format.sampleRateHz === 0)
    return malformed("WAV PCM channels and sample rate must be positive.");
  const bytesPerSample = format.bitsPerSample / 8;
  const expectedBlockAlign = format.channels * bytesPerSample;
  if (format.blockAlign !== expectedBlockAlign)
    return malformed("WAV PCM block alignment does not match format fields.");
  if (format.byteRate !== format.sampleRateHz * format.blockAlign)
    return malformed("WAV PCM byte rate does not match format fields.");
  if (data.length === 0 || data.length % format.blockAlign !== 0)
    return malformed("WAV PCM data must contain complete frames.");
  return {
    ok: true,
    format,
    encoding,
    data,
    frameCount: data.length / format.blockAlign,
  };
}

export function inspectWavPcmNonSilence(
  bytes,
  threshold = DEFAULT_PCM_NON_SILENCE_THRESHOLD,
) {
  if (
    !Number.isInteger(threshold.minimumPeakAbsoluteSample) ||
    threshold.minimumPeakAbsoluteSample <= 0 ||
    !Number.isInteger(threshold.minimumNonSilentFrames) ||
    threshold.minimumNonSilentFrames <= 0
  ) {
    throw new Error("PCM non-silence thresholds must be positive integers.");
  }
  const parsed = parseWavPcm(bytes);
  if (!parsed.ok) return parsed;

  let nonSilentFrameCount = 0;
  let peakAbsoluteSample = 0;
  const bytesPerSample = parsed.format.bitsPerSample / 8;
  for (let frame = 0; frame < parsed.frameCount; frame += 1) {
    let framePeak = 0;
    for (let channel = 0; channel < parsed.format.channels; channel += 1) {
      const sampleOffset =
        frame * parsed.format.blockAlign + channel * bytesPerSample;
      framePeak = Math.max(
        framePeak,
        readAbsolutePcmSample(
          parsed.data,
          sampleOffset,
          parsed.format.bitsPerSample,
        ),
      );
    }
    peakAbsoluteSample = Math.max(peakAbsoluteSample, framePeak);
    if (framePeak >= threshold.minimumPeakAbsoluteSample)
      nonSilentFrameCount += 1;
  }
  return {
    ok: true,
    kind:
      nonSilentFrameCount >= threshold.minimumNonSilentFrames &&
      peakAbsoluteSample >= threshold.minimumPeakAbsoluteSample
        ? "passed"
        : "silent",
    format: "wav_pcm",
    encoding: parsed.encoding,
    sampleRateHz: parsed.format.sampleRateHz,
    channels: parsed.format.channels,
    frameCount: parsed.frameCount,
    threshold: { ...threshold },
    nonSilentFrameCount,
    peakAbsoluteSample,
  };
}

export function verifyLogicalDefaultAudioEvidence({
  runId,
  captureOperationReference,
  adapter,
  endpoint,
  nativeCue,
  captureArtifact,
  wavBytes,
  threshold,
  expectedSession,
}) {
  const diagnostics = [];
  if (!endpoint || endpoint.status !== "selected")
    diagnostics.push("default_audio_endpoint_missing");
  if (!nativeCue || nativeCue.status !== "emitted")
    diagnostics.push("native_audio_cue_missing");
  if (
    !nativeCue ||
    nativeCue.runId !== runId ||
    nativeCue.sessionUser !== expectedSession.sessionUser ||
    nativeCue.sessionId !== expectedSession.sessionId
  ) {
    diagnostics.push("default_audio_run_or_session_mismatch");
  }

  const inspected = wavBytes
    ? inspectWavPcmNonSilence(wavBytes, threshold)
    : { ok: false, kind: "missing", message: "Capture bytes are missing." };
  const capture =
    inspected.kind === "passed" || inspected.kind === "silent"
      ? {
          status: inspected.kind,
          artifact: captureArtifact,
          format: inspected.format,
          encoding: inspected.encoding,
          sampleRateHz: inspected.sampleRateHz,
          channels: inspected.channels,
          frameCount: inspected.frameCount,
          threshold: inspected.threshold,
          nonSilentFrameCount: inspected.nonSilentFrameCount,
          peakAbsoluteSample: inspected.peakAbsoluteSample,
        }
      : inspected.kind === "missing"
        ? { status: "missing", artifact: null, reason: "capture_missing" }
        : {
            status: "malformed",
            artifact: captureArtifact,
            reason: inspected.message,
          };
  if (capture.status === "silent")
    diagnostics.push("default_audio_capture_silent");
  if (capture.status === "malformed")
    diagnostics.push("default_audio_capture_malformed");
  if (capture.status === "missing")
    diagnostics.push("default_audio_capture_missing");

  return {
    ok: diagnostics.length === 0,
    diagnostics,
    evidence: {
      schemaVersion: "logical-default-audio-evidence/v1",
      runId,
      captureOperationReference,
      adapter,
      endpoint,
      nativeCue,
      capture,
      physicalSpeakerAudibility: "not_asserted",
    },
  };
}
