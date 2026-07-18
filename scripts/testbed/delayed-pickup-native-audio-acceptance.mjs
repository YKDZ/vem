#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  DEFAULT_DELAYED_PICKUP_TIMING,
  analyzeAuthoritativePlatformEvidence,
  analyzeDaemonFulfillmentStoreEvidence,
  analyzeDelayedPickupControllerFrames,
  analyzeDelayedPickupRuntimeTrace,
  analyzeDelayedPickupUiEvidence,
  correlateDelayedPickupCueWindows,
} from "./delayed-pickup-native-audio-evidence.mjs";
import {
  inspectCompletedSaleAudioCapture,
  validateSaleAudioCaptureReport,
} from "./sale-audio-capture-host-adapter.mjs";

function diagnostic(code, detail = null) {
  return detail === null ? { code } : { code, detail };
}

function readArtifact(path, label) {
  const absolutePath = resolve(path);
  const bytes = readFileSync(absolutePath);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} must be JSON`);
  }
  return {
    path: absolutePath,
    value,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
  };
}

function collectDiagnostics(target, ...sources) {
  for (const source of sources)
    for (const entry of source ?? []) target.push(entry);
}

function one(values, label) {
  if (!Array.isArray(values) || values.length !== 1)
    throw new Error(`${label} must contain exactly one record`);
  return values[0];
}

function deriveSerialSaleBinding(serial) {
  const collect = serial?.reports?.collect;
  if (
    collect?.request?.operation !== "collect-serial-evidence" ||
    collect.result !== "succeeded"
  )
    throw new Error("installed sale serial collect report is missing");
  const correlationId = one(
    collect.request.serialSession?.saleCorrelationIds,
    "serial sale correlations",
  );
  const sale = one(
    collect.request.serialSession?.saleBindings,
    "serial sale bindings",
  );
  if (
    sale.saleCorrelationId !== correlationId ||
    ![sale.orderId, sale.paymentId, sale.vendingCommandId].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  )
    throw new Error("serial sale binding is incomplete");
  return { correlationId, sale };
}

function canonicalRuntime(installedSale, machineEvidence) {
  const debug = installedSale?.runtimeBinding?.debug;
  const machine = debug?.machine;
  const runtime = {
    processId: machine?.processId,
    executablePath: machine?.executablePath,
    principal: machine?.principal,
    sessionId: machine?.sessionId,
    cdpTargetId: debug?.targetId,
    cdpSessionId: machineEvidence?.runtime?.cdpSessionId,
  };
  if (
    !Number.isSafeInteger(runtime.processId) ||
    runtime.processId < 1 ||
    !Number.isSafeInteger(runtime.sessionId) ||
    runtime.sessionId < 1 ||
    ![
      runtime.executablePath,
      runtime.principal,
      runtime.cdpTargetId,
      runtime.cdpSessionId,
    ].every((value) => typeof value === "string" && value.length > 0)
  )
    throw new Error(
      "installed canonical machine process/CDP handoff is incomplete",
    );
  if (
    installedSale.runtimeBinding.prelaunch?.principal !== runtime.principal ||
    installedSale.runtimeBinding.prelaunch?.sessionId !== runtime.sessionId
  )
    throw new Error(
      "installed interactive principal changed during CDP handoff",
    );
  return runtime;
}

function evidencePath(installedSale, name) {
  const path = installedSale?.evidence?.[name];
  if (typeof path !== "string" || path.length === 0)
    throw new Error(`installed sale evidence.${name} is missing`);
  return path;
}

export function collectDelayedPickupProductionEvidence({
  installedSaleReportPath,
  machineEvidencePath,
  daemonEvidencePath,
  platformF1Path,
  audioStartReportPath,
  audioStopReportPath,
}) {
  const installedSale = readArtifact(
    installedSaleReportPath,
    "installed sale report",
  );
  if (
    installedSale.value?.schemaVersion !==
      "installed-kiosk-sale-acceptance/v2" ||
    installedSale.value.status !== "passed" ||
    installedSale.value.ok !== true ||
    typeof installedSale.value.runId !== "string"
  )
    throw new Error("installed sale report is not a passed production handoff");
  const artifacts = {
    installedSale,
    machine: readArtifact(machineEvidencePath, "machine CDP evidence"),
    daemon: readArtifact(daemonEvidencePath, "daemon fulfillment evidence"),
    platformBaseline: readArtifact(
      evidencePath(installedSale.value, "platformRawBaselinePath"),
      "platform baseline",
    ),
    platformF1: readArtifact(platformF1Path, "platform F1 snapshot"),
    platformPost: readArtifact(
      evidencePath(installedSale.value, "platformRawRecordsPath"),
      "platform post-F2 snapshot",
    ),
    serial: readArtifact(
      evidencePath(installedSale.value, "serialConformancePath"),
      "production serial conformance",
    ),
    audioStart: readArtifact(audioStartReportPath, "sale audio start report"),
    audioStop: readArtifact(audioStopReportPath, "sale audio stop report"),
  };
  return artifacts;
}

export function verifyDelayedPickupNativeAudioProductionEvidence({
  artifacts,
  audioEvidenceDirectory,
  timing = DEFAULT_DELAYED_PICKUP_TIMING,
}) {
  const diagnostics = [];
  const runId = artifacts.installedSale.value.runId;
  const platform = analyzeAuthoritativePlatformEvidence({
    runId,
    baseline: artifacts.platformBaseline.value,
    atF1: artifacts.platformF1.value,
    postF2: artifacts.platformPost.value,
  });
  collectDiagnostics(diagnostics, platform.diagnostics);
  let serialBinding = null;
  let runtime = null;
  try {
    serialBinding = deriveSerialSaleBinding(artifacts.serial.value);
  } catch (error) {
    diagnostics.push(
      diagnostic("installed_serial_sale_binding_invalid", {
        message: error.message,
      }),
    );
  }
  try {
    runtime = canonicalRuntime(
      artifacts.installedSale.value,
      artifacts.machine.value,
    );
  } catch (error) {
    diagnostics.push(
      diagnostic("installed_runtime_handoff_invalid", {
        message: error.message,
      }),
    );
  }
  const stopRequest = artifacts.audioStop.value?.request;
  const expectedBinding =
    platform.binding && serialBinding
      ? {
          runId,
          lifecycleReference: stopRequest?.lifecycleReference,
          transactionId: stopRequest?.transactionId,
          saleCorrelationId: serialBinding.correlationId,
          orderId: platform.binding.orderId,
          orderNo: platform.binding.orderNo,
          commandId: platform.binding.commandId,
          commandNo: platform.binding.commandNo,
        }
      : null;
  if (
    !expectedBinding ||
    serialBinding?.sale.orderId !== platform.binding?.orderId ||
    serialBinding?.sale.paymentId !== platform.binding?.paymentId ||
    serialBinding?.sale.vendingCommandId !== platform.binding?.commandId
  )
    diagnostics.push(diagnostic("cross_producer_sale_binding_invalid"));

  let audioCapture = null;
  if (expectedBinding && runtime) {
    try {
      const start = validateSaleAudioCaptureReport(
        artifacts.audioStart.value,
        artifacts.audioStart.value.request,
      );
      if (
        start.request.phase !== "start" ||
        start.request.runId !== runId ||
        start.request.lifecycleReference !==
          expectedBinding.lifecycleReference ||
        start.request.transactionId !== expectedBinding.transactionId ||
        JSON.stringify(start.request.runtime) !== JSON.stringify(runtime) ||
        stopRequest?.phase !== "stop" ||
        JSON.stringify(stopRequest.runtime) !== JSON.stringify(runtime) ||
        JSON.stringify(stopRequest.sale) !==
          JSON.stringify({
            saleCorrelationId: expectedBinding.saleCorrelationId,
            orderId: expectedBinding.orderId,
            orderNo: expectedBinding.orderNo,
            commandId: expectedBinding.commandId,
            commandNo: expectedBinding.commandNo,
          }) ||
        stopRequest.captureSession?.captureSessionId !==
          start.captureSession.captureSessionId ||
        stopRequest.captureSession?.startOperationReference !==
          start.captureSession.startOperationReference ||
        stopRequest.captureSession?.startedAt !== start.captureSession.startedAt
      )
        throw new Error("sale audio start/stop lifecycle binding is invalid");
      audioCapture = inspectCompletedSaleAudioCapture({
        report: artifacts.audioStop.value,
        request: stopRequest,
        directory: resolve(audioEvidenceDirectory),
      });
    } catch (error) {
      diagnostics.push(
        diagnostic("sale_audio_capture_invalid", { message: error.message }),
      );
    }
  }

  const controller =
    expectedBinding && audioCapture
      ? analyzeDelayedPickupControllerFrames(
          audioCapture.serial,
          expectedBinding,
          timing,
        )
      : {
          diagnostics: [diagnostic("production_serial_capture_missing")],
          events: null,
        };
  const ui =
    expectedBinding && runtime
      ? analyzeDelayedPickupUiEvidence(
          artifacts.machine.value,
          expectedBinding,
          runtime,
        )
      : {
          diagnostics: [diagnostic("canonical_machine_cdp_evidence_missing")],
          firstBySurface: {},
        };
  const trace =
    expectedBinding && runtime
      ? analyzeDelayedPickupRuntimeTrace(
          artifacts.machine.value,
          expectedBinding,
          runtime,
        )
      : { diagnostics: [diagnostic("runtime_trace_missing")], cues: {} };
  const daemon =
    expectedBinding && platform.binding
      ? analyzeDaemonFulfillmentStoreEvidence(
          artifacts.daemon.value,
          expectedBinding,
          platform.binding,
        )
      : {
          diagnostics: [
            diagnostic("daemon_fulfillment_store_evidence_missing"),
          ],
          stock: null,
        };
  collectDiagnostics(
    diagnostics,
    controller.diagnostics,
    ui.diagnostics,
    trace.diagnostics,
    daemon.diagnostics,
  );

  if (controller.events) {
    const platformF1At = Date.parse(platform.f1Capture?.capturedAt ?? "");
    if (
      JSON.stringify(platform.f1Capture?.binding) !==
        JSON.stringify(expectedBinding) ||
      !Number.isFinite(platformF1At) ||
      platformF1At <= controller.events.f1.atMs ||
      platformF1At >= controller.events.f2.atMs
    )
      diagnostics.push(
        diagnostic("platform_f1_capture_timing_or_binding_invalid"),
      );
    const daemonTimes = {
      beforeF0: Date.parse(daemon.checkpointTimes?.beforeF0 ?? ""),
      atF1: Date.parse(daemon.checkpointTimes?.atF1 ?? ""),
      afterF2: Date.parse(daemon.checkpointTimes?.afterF2 ?? ""),
    };
    if (
      !Number.isFinite(daemonTimes.beforeF0) ||
      !Number.isFinite(daemonTimes.atF1) ||
      !Number.isFinite(daemonTimes.afterF2) ||
      daemonTimes.beforeF0 >= controller.events.f0.atMs ||
      daemonTimes.atF1 <= controller.events.f1.atMs ||
      daemonTimes.atF1 >= controller.events.f2.atMs ||
      daemonTimes.afterF2 <= controller.events.f2.atMs
    )
      diagnostics.push(diagnostic("daemon_checkpoint_timing_invalid"));
    const uiTiming = [
      [
        "ordinary_warning",
        controller.events.firstE5,
        controller.events.secondE5,
      ],
      ["urgent_warning", controller.events.secondE5, controller.events.f1],
      ["reset_progress", controller.events.f1, controller.events.f2],
    ];
    for (const [surface, minimum, maximum] of uiTiming) {
      const observed = ui.firstBySurface?.[surface];
      if (
        observed &&
        minimum &&
        maximum &&
        (observed.atMs < minimum.atMs || observed.atMs > maximum.atMs)
      )
        diagnostics.push(
          diagnostic("ui_surface_timing_not_correlated", { surface }),
        );
    }
    for (const [label, event] of [
      ["outlet_opened", controller.events.f0],
      ["ordinary_warning", controller.events.firstE5],
      ["urgent_warning", controller.events.secondE5],
      ["reset_progress", controller.events.f1],
      ["dispense_succeeded", controller.events.f2],
    ]) {
      const traceAt = Date.parse(trace.cues?.[label]?.journey?.at ?? "");
      if (
        event &&
        (!Number.isFinite(traceAt) ||
          traceAt < event.atMs ||
          traceAt - event.atMs > timing.traceTimingToleranceMs)
      )
        diagnostics.push(
          diagnostic("runtime_trace_timing_not_correlated", { label }),
        );
    }
  }

  let cueWindows = null;
  if (audioCapture && controller.events) {
    const capture = audioCapture.report.capture;
    const captureStart = Date.parse(capture.startedAt);
    const captureEnd = Date.parse(capture.completedAt);
    if (
      captureStart >= controller.events.f0.atMs ||
      captureEnd <= controller.events.f2.atMs
    )
      diagnostics.push(diagnostic("sale_audio_capture_does_not_cover_sale"));
    cueWindows = correlateDelayedPickupCueWindows({
      captureBytes: audioCapture.wavBytes,
      captureStartedAt: capture.startedAt,
      captureCompletedAt: capture.completedAt,
      cues: trace.cues,
    });
    collectDiagnostics(diagnostics, cueWindows.diagnostics);
  } else diagnostics.push(diagnostic("audio_cue_window_missing_or_empty"));

  const compactSources = Object.fromEntries(
    Object.entries(artifacts).map(([name, artifact]) => [
      name,
      { sha256: artifact.sha256, byteLength: artifact.byteLength },
    ]),
  );
  return {
    schemaVersion: "delayed-pickup-native-audio-production-acceptance/v2",
    kind: "delayed-pickup-native-audio-production-acceptance",
    runId,
    result: diagnostics.length === 0 ? "passed" : "failed",
    binding: expectedBinding,
    runtime,
    controller: {
      timing: controller.timing ?? null,
      frameCounts: audioCapture
        ? Object.fromEntries(
            ["f0", "e5", "f1", "af", "f2"].map((code) => [
              code.toUpperCase(),
              audioCapture.serial.frames.filter(
                (frame) => String(frame.bytesHex).toLowerCase() === `80${code}`,
              ).length,
            ]),
          )
        : null,
    },
    inventory: {
      local: daemon.stock ?? null,
      platform: platform.exactOnce ?? null,
    },
    audio: audioCapture
      ? {
          source: "windows_default_output",
          physicalSpeakerAudibility: "hitl_required_issue_22",
          capture: audioCapture.audio,
          cueWindows: cueWindows?.inspections ?? [],
        }
      : null,
    evidenceSources: compactSources,
    diagnostics,
  };
}

function option(argv, name) {
  const index = argv.indexOf(name);
  const value = index < 0 ? null : argv[index + 1];
  if (typeof value !== "string" || value.startsWith("--"))
    throw new Error(`${name} is required`);
  return value;
}

export function runDelayedPickupNativeAudioTrackCli(argv) {
  const artifacts = collectDelayedPickupProductionEvidence({
    installedSaleReportPath: option(argv, "--installed-sale-report"),
    machineEvidencePath: option(argv, "--machine-evidence"),
    daemonEvidencePath: option(argv, "--daemon-evidence"),
    platformF1Path: option(argv, "--platform-f1"),
    audioStartReportPath: option(argv, "--audio-start-report"),
    audioStopReportPath: option(argv, "--audio-stop-report"),
  });
  const report = verifyDelayedPickupNativeAudioProductionEvidence({
    artifacts,
    audioEvidenceDirectory: option(argv, "--audio-evidence-dir"),
  });
  const out = option(argv, "--out");
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(resolve(out), `${JSON.stringify(report, null, 2)}\n`, {
    mode: 0o600,
  });
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const report = runDelayedPickupNativeAudioTrackCli(process.argv.slice(2));
    process.exitCode = report.result === "passed" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
