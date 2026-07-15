#!/usr/bin/env node

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
}) {
  const diagnostics = [];
  const runtime = getRuntimeAcceptanceReport(runtimeReport);
  const kiosk = runtime?.kioskRuntime;
  const audio = adapterReport?.defaultAudioCapture;
  const requestedAudio = adapterReport?.request?.audioCapture;
  const selectedEndpointId = requestedAudio?.selectedEndpointId;
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
  if (audio?.nativeCue?.challenge !== requestedAudio?.nativeCue?.challenge)
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
  if (
    typeof selectedEndpointId !== "string" ||
    selectedEndpointId.length === 0 ||
    audio?.endpoint?.status !== "selected"
  )
    diagnostics.push(diagnostic("selected_audio_endpoint_missing"));
  if (
    typeof selectedEndpointId === "string" &&
    selectedEndpointId.length > 0 &&
    (audio?.endpoint?.stableEndpointId !== selectedEndpointId ||
      audio?.nativeCue?.endpointId !== selectedEndpointId)
  )
    diagnostics.push(diagnostic("selected_audio_endpoint_mismatch"));
  const digestPattern = /^sha256:[0-9a-f]{64}$/;
  if (
    requestedAudio?.nativeCue?.source !== "vending_daemon" ||
    requestedAudio?.nativeCue?.command !== "audio_output_calibration" ||
    audio?.nativeCue?.status !== "emitted" ||
    audio?.nativeCue?.source !== "vending_daemon" ||
    audio?.nativeCue?.command !== "audio_output_calibration" ||
    typeof audio?.nativeCue?.testEvidenceToken !== "string" ||
    audio.nativeCue.testEvidenceToken.length === 0 ||
    !digestPattern.test(audio?.nativeCue?.observationRevision ?? "") ||
    !digestPattern.test(audio?.nativeCue?.configRevision ?? "") ||
    !digestPattern.test(audio?.nativeCue?.proposedSettingsDigest ?? "")
  )
    diagnostics.push(diagnostic("daemon_audio_calibration_evidence_missing"));
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
  const cueEmittedAt = Date.parse(audio?.nativeCue?.emittedAt);
  const captureCompletedAt = Date.parse(capture?.completedAt);
  if (
    !Number.isFinite(captureStartedAt) ||
    !Number.isFinite(cueEmittedAt) ||
    !Number.isFinite(captureCompletedAt) ||
    !(captureStartedAt <= cueEmittedAt && cueEmittedAt <= captureCompletedAt)
  )
    diagnostics.push(diagnostic("default_audio_capture_not_synchronized"));
  return {
    schemaVersion: "windows-native-audio-evidence/v2",
    runId,
    result: diagnostics.length === 0 ? "passed" : "failed",
    selectedEndpointId:
      typeof selectedEndpointId === "string" && selectedEndpointId.length > 0
        ? selectedEndpointId
        : null,
    automatedCaptureScope: "daemon_selected_endpoint_non_silent_pcm",
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
