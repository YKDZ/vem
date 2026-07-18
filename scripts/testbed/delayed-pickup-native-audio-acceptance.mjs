#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { verifyWindowsNativeAudioEvidence } from "./windows-native-audio-evidence.mjs";
import {
  DEFAULT_DELAYED_PICKUP_TIMING,
  analyzeDelayedPickupControllerTimeline,
  analyzeDelayedPickupRuntimeTrace,
  analyzeDelayedPickupUiObservations,
  inspectDelayedPickupDefaultAudioCapture,
} from "./delayed-pickup-native-audio-evidence.mjs";

function diagnostic(code, detail = null) {
  return detail === null ? { code } : { code, detail };
}

function parseJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}

function cueWindow(traceEntry, captureStartedAtMs, captureCompletedAtMs, label) {
  const startedAtMs = Date.parse(traceEntry?.started?.at ?? traceEntry?.queued?.at ?? "");
  const terminalAtMs = Date.parse(traceEntry?.terminal?.at ?? "");
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(terminalAtMs)) {
    return null;
  }
  return {
    label,
    startMs: Math.max(0, startedAtMs - captureStartedAtMs - 250),
    endMs: Math.max(
      0,
      Math.min(captureCompletedAtMs, terminalAtMs + 250) - captureStartedAtMs,
    ),
  };
}

function collectDiagnostics(target, ...sources) {
  for (const source of sources) {
    for (const entry of source ?? []) target.push(entry);
  }
}

export function verifyDelayedPickupNativeAudioAcceptance({
  runId,
  runtimeReport,
  adapterReport,
  daemonCalibrationResponse,
  daemonCalibrationResponseBytes,
  runtimeTrace,
  uiObservations,
  controllerTimeline,
  evidenceDirectory,
  timing = DEFAULT_DELAYED_PICKUP_TIMING,
}) {
  const diagnostics = [];
  const audio = verifyWindowsNativeAudioEvidence({
    runId,
    runtimeReport,
    adapterReport,
    daemonCalibrationResponse,
    daemonCalibrationResponseBytes,
  });
  const controller = analyzeDelayedPickupControllerTimeline(
    controllerTimeline,
    timing,
  );
  const ui = analyzeDelayedPickupUiObservations(uiObservations);
  const orderNo = controller.orderNo ?? ui.orderNo ?? null;
  const trace = analyzeDelayedPickupRuntimeTrace(runtimeTrace, orderNo);

  collectDiagnostics(
    diagnostics,
    audio.result === "failed" ? audio.diagnostics : [],
    controller.diagnostics,
    ui.diagnostics,
    trace.diagnostics,
  );

  if (
    controller.orderNo &&
    ui.orderNo &&
    controller.orderNo !== ui.orderNo
  ) {
    diagnostics.push(diagnostic("cross_artifact_order_binding_invalid"));
  }

  const controllerEvents = controller.events;
  const uiTimingChecks = [
    [
      "ordinary_warning",
      ui.firstBySurface?.ordinary_warning,
      controllerEvents?.firstE5?.atMs ?? null,
      controllerEvents?.secondE5?.atMs ?? null,
    ],
    [
      "urgent_warning",
      ui.firstBySurface?.urgent_warning,
      controllerEvents?.secondE5?.atMs ?? null,
      controllerEvents?.f1?.atMs ?? null,
    ],
    [
      "reset_progress",
      ui.firstBySurface?.reset_progress,
      controllerEvents?.f1?.atMs ?? null,
      controllerEvents?.f2?.atMs ?? null,
    ],
  ];
  for (const [surface, observation, minMs, maxMs] of uiTimingChecks) {
    if (!observation || minMs === null || maxMs === null) continue;
    if (observation.atMs < minMs || observation.atMs > maxMs) {
      diagnostics.push(
        diagnostic("ui_surface_timing_not_correlated", { surface }),
      );
    }
  }

  const traceTimingChecks = [
    ["outlet_opened", trace.cues.outlet_opened, controllerEvents?.f0?.atMs],
    [
      "ordinary_warning",
      trace.cues.ordinary_warning,
      controllerEvents?.firstE5?.atMs,
    ],
    [
      "urgent_warning",
      trace.cues.urgent_warning,
      controllerEvents?.secondE5?.atMs,
    ],
    ["reset_progress", trace.cues.reset_progress, controllerEvents?.f1?.atMs],
    [
      "dispense_succeeded",
      trace.cues.dispense_succeeded,
      controllerEvents?.f2?.atMs,
    ],
  ];
  for (const [label, cue, controllerAtMs] of traceTimingChecks) {
    const transitionAtMs = Date.parse(cue?.journey?.at ?? "");
    if (!Number.isFinite(transitionAtMs) || !Number.isFinite(controllerAtMs))
      continue;
    if (
      transitionAtMs < controllerAtMs ||
      transitionAtMs - controllerAtMs > timing.traceTimingToleranceMs
    ) {
      diagnostics.push(
        diagnostic("runtime_trace_timing_not_correlated", { label }),
      );
    }
  }

  let capture = null;
  const captureStartedAtMs = Date.parse(
    adapterReport?.defaultAudioCapture?.capture?.startedAt ?? "",
  );
  const captureCompletedAtMs = Date.parse(
    adapterReport?.defaultAudioCapture?.capture?.completedAt ?? "",
  );
  if (
    Number.isFinite(captureStartedAtMs) &&
    Number.isFinite(captureCompletedAtMs) &&
    evidenceDirectory
  ) {
    const windows = [
      ["outlet_opened", trace.cues.outlet_opened],
      ["ordinary_warning", trace.cues.ordinary_warning],
      ["urgent_warning", trace.cues.urgent_warning],
      ["reset_progress", trace.cues.reset_progress],
      ["dispense_succeeded", trace.cues.dispense_succeeded],
    ]
      .map(([label, cue]) =>
        cueWindow(cue, captureStartedAtMs, captureCompletedAtMs, label),
      )
      .filter(Boolean);
    capture = inspectDelayedPickupDefaultAudioCapture({
      directory: evidenceDirectory,
      adapterReport,
      cueWindows: windows,
    });
    collectDiagnostics(diagnostics, capture.diagnostics);
  } else {
    diagnostics.push(diagnostic("default_audio_capture_window_binding_missing"));
  }

  return {
    schemaVersion: "delayed-pickup-native-audio-acceptance/v1",
    runId,
    result: diagnostics.length === 0 ? "passed" : "failed",
    delayedPickup: {
      orderNo,
      commandNo: controller.commandNo,
      controller,
      ui,
      runtimeTrace: trace,
    },
    nativeAudio: {
      report: audio,
      capture,
    },
    diagnostics,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const runtimeReportPath = option("--runtime-report");
    const adapterReportPath = option("--adapter-report");
    const daemonCalibrationResponsePath = option("--daemon-calibration-response");
    const out = option("--out");
    const report = verifyDelayedPickupNativeAudioAcceptance({
      runId: option("--run-id"),
      runtimeReport: parseJson(runtimeReportPath),
      adapterReport: parseJson(adapterReportPath),
      daemonCalibrationResponse: parseJson(daemonCalibrationResponsePath),
      daemonCalibrationResponseBytes: readFileSync(
        daemonCalibrationResponsePath,
        "utf8",
      ),
      runtimeTrace: parseJson(option("--runtime-trace")),
      uiObservations: parseJson(option("--ui-observations")),
      controllerTimeline: parseJson(option("--controller-timeline")),
      evidenceDirectory: option("--evidence-dir"),
    });
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.exitCode = report.result === "passed" ? 0 : 1;
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "delayed pickup native audio acceptance failed",
    );
    process.exitCode = 1;
  }
}

