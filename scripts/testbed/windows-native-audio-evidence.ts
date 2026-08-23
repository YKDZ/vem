#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function getRuntimeAcceptanceReport(value: JsonRecord): JsonRecord | null {
  return value?.runtimeAcceptanceReport == null
    ? null
    : recordValue(value.runtimeAcceptanceReport);
}

function diagnostic(code: string): JsonRecord {
  return { code };
}

export function verifyWindowsNativeAudioEvidence({
  runId,
  runtimeReport,
  adapterReport,
  daemonCalibrationResponse,
  daemonCalibrationResponseBytes,
}: {
  runId: string;
  runtimeReport: JsonRecord;
  adapterReport: JsonRecord;
  daemonCalibrationResponse: JsonRecord;
  daemonCalibrationResponseBytes: string | Buffer;
}): JsonRecord {
  const diagnostics: JsonRecord[] = [];
  const runtime = getRuntimeAcceptanceReport(runtimeReport);
  const kiosk = recordValue(runtime?.kioskRuntime);
  const audio = recordValue(adapterReport?.defaultAudioCapture);
  const request = recordValue(adapterReport?.request);
  const requestedAudio = recordValue(request.audioCapture);
  const requestedDaemonCalibration = recordValue(
    requestedAudio.daemonCalibration,
  );
  const calibration = recordValue(audio.daemonCalibration);
  const capture = recordValue(audio.capture);
  const captureThreshold = recordValue(capture.threshold);
  const evidence = arrayValue(adapterReport?.evidence).map((entry: unknown) =>
    recordValue(entry),
  );
  const calibrationEvidence = evidence.find(
    (entry) => entry.role === "daemon-audio-calibration-response",
  );
  if (
    recordValue(recordValue(runtime?.result).runtimeReady).status !== "passed"
  )
    diagnostics.push(diagnostic("runtime_acceptance_not_ready"));
  if (request?.runId !== runId)
    diagnostics.push(diagnostic("audio_capture_run_mismatch"));
  if (request?.operation !== "capture-default-audio")
    diagnostics.push(diagnostic("audio_capture_operation_mismatch"));
  if (
    audio?.runId !== runId ||
    audio?.lifecycleReference !== request?.lifecycleReference ||
    audio?.captureOperationReference !== request?.operationReference
  )
    diagnostics.push(diagnostic("audio_capture_semantic_binding_mismatch"));
  if (
    calibration?.challenge !== requestedDaemonCalibration?.challenge ||
    daemonCalibrationResponse?.challenge !==
      requestedDaemonCalibration?.challenge
  )
    diagnostics.push(diagnostic("audio_capture_challenge_mismatch"));
  if (
    !kiosk ||
    kiosk.sessionUser !== "VEMKiosk" ||
    !Number.isInteger(Number(kiosk.sessionId)) ||
    Number(kiosk.sessionId) < 1
  )
    diagnostics.push(diagnostic("active_kiosk_session_missing"));
  if (
    JSON.stringify(requestedAudio?.activeKioskSession) !==
    JSON.stringify({
      sessionUser: kiosk?.sessionUser,
      sessionId: kiosk?.sessionId,
    })
  )
    diagnostics.push(diagnostic("audio_capture_session_mismatch"));
  if (recordValue(audio?.defaultOutput).status !== "active")
    diagnostics.push(diagnostic("windows_default_output_missing"));
  const digestPattern = /^sha256:[0-9a-f]{64}$/;
  const tokenPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const daemonResponseKeys = [
    "challenge",
    "configGeneration",
    "configRevision",
    "observationGeneration",
    "observationRevision",
    "proposedSettingsDigest",
    "testEvidenceExpiresAt",
    "testEvidenceToken",
  ];
  const evidenceExpiresAt = Date.parse(
    String(daemonCalibrationResponse?.testEvidenceExpiresAt ?? ""),
  );
  const calibrationCompletedAt = Date.parse(
    String(calibration?.completedAt ?? ""),
  );
  if (
    requestedDaemonCalibration?.source !== "vending_daemon_ipc" ||
    requestedDaemonCalibration?.command !== "audio_output_calibration" ||
    calibration?.status !== "completed" ||
    calibration?.source !== "vending_daemon_ipc" ||
    calibration?.command !== "audio_output_calibration" ||
    JSON.stringify(Object.keys(daemonCalibrationResponse ?? {}).sort()) !==
      JSON.stringify(daemonResponseKeys) ||
    !tokenPattern.test(
      String(daemonCalibrationResponse?.testEvidenceToken ?? ""),
    ) ||
    !Number.isFinite(evidenceExpiresAt) ||
    !Number.isFinite(calibrationCompletedAt) ||
    evidenceExpiresAt <= calibrationCompletedAt ||
    !digestPattern.test(
      String(daemonCalibrationResponse?.observationRevision ?? ""),
    ) ||
    !Number.isInteger(daemonCalibrationResponse?.observationGeneration) ||
    Number(daemonCalibrationResponse?.observationGeneration) < 0 ||
    !digestPattern.test(
      String(daemonCalibrationResponse?.configRevision ?? ""),
    ) ||
    !Number.isInteger(daemonCalibrationResponse?.configGeneration) ||
    Number(daemonCalibrationResponse?.configGeneration) < 0 ||
    !digestPattern.test(
      String(daemonCalibrationResponse?.proposedSettingsDigest ?? ""),
    )
  )
    diagnostics.push(diagnostic("daemon_audio_calibration_evidence_missing"));
  if (
    calibration?.responseArtifact !== calibrationEvidence?.identity ||
    calibration?.responseDigest !== calibrationEvidence?.digest ||
    calibration?.responseFileName !== calibrationEvidence?.fileName
  )
    diagnostics.push(diagnostic("daemon_audio_calibration_reference_mismatch"));
  const responseDigest = `sha256:${createHash("sha256")
    .update(daemonCalibrationResponseBytes)
    .digest("hex")}`;
  if (
    responseDigest !== calibrationEvidence?.digest ||
    calibrationEvidence?.identity !==
      `runtime-evidence://${responseDigest?.replace(":", "/")}`
  )
    diagnostics.push(diagnostic("daemon_audio_calibration_digest_mismatch"));
  if (
    !capture ||
    capture.artifact !== evidence[0]?.identity ||
    Number(capture.nonSilentFrameCount) <
      Number(captureThreshold.minimumNonSilentFrames) ||
    Number(capture.peakAbsoluteSample) <
      Number(captureThreshold.minimumPeakAbsoluteSample) ||
    Number(capture.durationMs) < Number(captureThreshold.minimumDurationMs) ||
    Number(capture.distinctNonSilentSampleMagnitudes) <
      Number(captureThreshold.minimumDistinctNonSilentSampleMagnitudes)
  )
    diagnostics.push(diagnostic("default_audio_capture_silent_or_invalid"));
  const captureStartedAt = Date.parse(String(capture?.startedAt ?? ""));
  const calibrationStartedAt = Date.parse(String(calibration?.startedAt ?? ""));
  const captureCompletedAt = Date.parse(String(capture?.completedAt ?? ""));
  if (
    !Number.isFinite(captureStartedAt) ||
    !Number.isFinite(calibrationStartedAt) ||
    !Number.isFinite(calibrationCompletedAt) ||
    !Number.isFinite(captureCompletedAt) ||
    !(
      captureStartedAt <= calibrationStartedAt &&
      calibrationStartedAt <= calibrationCompletedAt &&
      calibrationCompletedAt <= captureCompletedAt
    )
  )
    diagnostics.push(diagnostic("default_audio_capture_not_synchronized"));
  return {
    schemaVersion: "windows-native-audio-evidence/v2",
    runId,
    result: diagnostics.length === 0 ? "passed" : "failed",
    audioOutput: "windows_default",
    automatedCaptureScope: "windows_default_output_non_silent_pcm",
    physicalSpeakerAudibility: "hitl_required",
    adapter: recordValue(adapterReport?.adapter).identity
      ? {
          identity: recordValue(adapterReport.adapter).identity,
          version: recordValue(adapterReport.adapter).version,
        }
      : null,
    captureOperationReference: request?.operationReference ?? null,
    lifecycleReference: request?.lifecycleReference ?? null,
    activeKioskSession: kiosk
      ? { sessionUser: kiosk.sessionUser, sessionId: kiosk.sessionId }
      : null,
    diagnostics,
  };
}

function option(name: string): string {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1])
    throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const runId = option("--run-id");
    const report = verifyWindowsNativeAudioEvidence({
      runId,
      runtimeReport: JSON.parse(
        readFileSync(option("--runtime-report"), "utf8"),
      ),
      adapterReport: JSON.parse(
        readFileSync(option("--adapter-report"), "utf8"),
      ),
      ...(() => {
        const daemonCalibrationResponseBytes = readFileSync(
          option("--daemon-calibration-response"),
          "utf8",
        );
        return {
          daemonCalibrationResponseBytes,
          daemonCalibrationResponse: JSON.parse(daemonCalibrationResponseBytes),
        };
      })(),
    });
    const out = option("--out");
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.exitCode = report.result === "passed" ? 0 : 1;
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "native audio evidence verification failed",
    );
    process.exitCode = 1;
  }
}
