#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

function getRuntimeAcceptanceReport(value) {
  return value?.runtimeAcceptanceReport ?? null;
}

function diagnostic(code) {
  return { code };
}

export function verifyWindowsNativeAudioEvidence({
  runId,
  runtimeReport,
  adapterReport,
  daemonCalibrationResponse,
  daemonCalibrationResponseBytes,
}) {
  const diagnostics = [];
  const runtime = getRuntimeAcceptanceReport(runtimeReport);
  const kiosk = runtime?.kioskRuntime;
  const audio = adapterReport?.defaultAudioCapture;
  const requestedAudio = adapterReport?.request?.audioCapture;
  if (runtime?.result?.runtimeReady?.status !== "passed")
    diagnostics.push(diagnostic("runtime_acceptance_not_ready"));
  if (adapterReport?.request?.runId !== runId)
    diagnostics.push(diagnostic("audio_capture_run_mismatch"));
  if (adapterReport?.request?.operation !== "capture-default-audio")
    diagnostics.push(diagnostic("audio_capture_operation_mismatch"));
  if (
    audio?.runId !== runId ||
    audio?.lifecycleReference !== adapterReport?.request?.lifecycleReference ||
    audio?.captureOperationReference !==
      adapterReport?.request?.operationReference
  )
    diagnostics.push(diagnostic("audio_capture_semantic_binding_mismatch"));
  const calibration = audio?.daemonCalibration;
  if (
    calibration?.challenge !== requestedAudio?.daemonCalibration?.challenge ||
    daemonCalibrationResponse?.challenge !==
      requestedAudio?.daemonCalibration?.challenge
  )
    diagnostics.push(diagnostic("audio_capture_challenge_mismatch"));
  if (
    !kiosk ||
    kiosk.sessionUser !== "VEMKiosk" ||
    !Number.isInteger(kiosk.sessionId) ||
    kiosk.sessionId < 1
  )
    diagnostics.push(diagnostic("active_kiosk_session_missing"));
  if (
    JSON.stringify(adapterReport?.request?.audioCapture?.activeKioskSession) !==
    JSON.stringify({
      sessionUser: kiosk?.sessionUser,
      sessionId: kiosk?.sessionId,
    })
  )
    diagnostics.push(diagnostic("audio_capture_session_mismatch"));
  if (audio?.defaultOutput?.status !== "active")
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
    daemonCalibrationResponse?.testEvidenceExpiresAt,
  );
  const calibrationCompletedAt = Date.parse(calibration?.completedAt);
  if (
    requestedAudio?.daemonCalibration?.source !== "vending_daemon_ipc" ||
    requestedAudio?.daemonCalibration?.command !== "audio_output_calibration" ||
    calibration?.status !== "completed" ||
    calibration?.source !== "vending_daemon_ipc" ||
    calibration?.command !== "audio_output_calibration" ||
    JSON.stringify(Object.keys(daemonCalibrationResponse ?? {}).sort()) !==
      JSON.stringify(daemonResponseKeys) ||
    !tokenPattern.test(daemonCalibrationResponse?.testEvidenceToken ?? "") ||
    !Number.isFinite(evidenceExpiresAt) ||
    !Number.isFinite(calibrationCompletedAt) ||
    evidenceExpiresAt <= calibrationCompletedAt ||
    !digestPattern.test(daemonCalibrationResponse?.observationRevision ?? "") ||
    !Number.isInteger(daemonCalibrationResponse?.observationGeneration) ||
    daemonCalibrationResponse.observationGeneration < 0 ||
    !digestPattern.test(daemonCalibrationResponse?.configRevision ?? "") ||
    !Number.isInteger(daemonCalibrationResponse?.configGeneration) ||
    daemonCalibrationResponse.configGeneration < 0 ||
    !digestPattern.test(daemonCalibrationResponse?.proposedSettingsDigest ?? "")
  )
    diagnostics.push(diagnostic("daemon_audio_calibration_evidence_missing"));
  const calibrationEvidence = adapterReport?.evidence?.find(
    (entry) => entry?.role === "daemon-audio-calibration-response",
  );
  if (
    calibration?.responseArtifact !== calibrationEvidence?.identity ||
    calibration?.responseDigest !== calibrationEvidence?.digest ||
    calibration?.responseFileName !== calibrationEvidence?.fileName
  )
    diagnostics.push(diagnostic("daemon_audio_calibration_reference_mismatch"));
  const responseDigest =
    typeof daemonCalibrationResponseBytes === "string"
      ? `sha256:${createHash("sha256").update(daemonCalibrationResponseBytes).digest("hex")}`
      : null;
  if (
    responseDigest !== calibrationEvidence?.digest ||
    calibrationEvidence?.identity !==
      `runtime-evidence://${responseDigest?.replace(":", "/")}`
  )
    diagnostics.push(diagnostic("daemon_audio_calibration_digest_mismatch"));
  const capture = audio?.capture;
  if (
    !capture ||
    capture.artifact !== adapterReport?.evidence?.[0]?.identity ||
    capture.nonSilentFrameCount < capture.threshold?.minimumNonSilentFrames ||
    capture.peakAbsoluteSample < capture.threshold?.minimumPeakAbsoluteSample ||
    capture.durationMs < capture.threshold?.minimumDurationMs ||
    capture.distinctNonSilentSampleMagnitudes <
      capture.threshold?.minimumDistinctNonSilentSampleMagnitudes
  )
    diagnostics.push(diagnostic("default_audio_capture_silent_or_invalid"));
  const captureStartedAt = Date.parse(capture?.startedAt);
  const calibrationStartedAt = Date.parse(calibration?.startedAt);
  const captureCompletedAt = Date.parse(capture?.completedAt);
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
    adapter: adapterReport?.adapter
      ? {
          identity: adapterReport.adapter.identity,
          version: adapterReport.adapter.version,
        }
      : null,
    captureOperationReference:
      adapterReport?.request?.operationReference ?? null,
    lifecycleReference: adapterReport?.request?.lifecycleReference ?? null,
    activeKioskSession: kiosk
      ? { sessionUser: kiosk.sessionUser, sessionId: kiosk.sessionId }
      : null,
    diagnostics,
  };
}

function option(name) {
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
