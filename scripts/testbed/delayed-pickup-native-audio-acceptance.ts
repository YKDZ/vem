#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DEFAULT_DELAYED_PICKUP_TIMING,
  analyzeAuthoritativePlatformEvidence,
  analyzeDaemonFulfillmentStoreEvidence,
  analyzeDelayedPickupControllerFrames,
  analyzeDelayedPickupRuntimeTrace,
  analyzeDelayedPickupUiEvidence,
  correlateDelayedPickupCueWindows,
  pickupCueWithinPickupPhase,
} from "./delayed-pickup-native-audio-evidence.ts";
import {
  inspectCompletedSaleAudioCapture,
  validateSaleAudioCaptureReport,
} from "./sale-audio-capture-host-adapter.ts";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function diagnostic(code: string, detail: JsonRecord | null = null): JsonRecord {
  return detail === null ? { code } : { code, detail };
}

function readArtifact(
  path: string,
  label: string,
): {
  path: string;
  value: JsonRecord;
  sha256: string;
  byteLength: number;
} {
  const absolutePath = resolve(path);
  const bytes = readFileSync(absolutePath);
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8")) as JsonRecord;
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

function collectDiagnostics(
  target: JsonRecord[],
  ...sources: Array<unknown[] | null | undefined>
): void {
  for (const source of sources)
    for (const entry of source ?? []) target.push(recordValue(entry));
}

function one(values: unknown, label: string): JsonRecord {
  if (!Array.isArray(values) || values.length !== 1)
    throw new Error(`${label} must contain exactly one record`);
  return recordValue(values[0]);
}

function deriveSerialSaleBinding(serial: JsonRecord): JsonRecord {
  const reports = recordValue(serial.reports);
  const collect = recordValue(reports.collect);
  const request = recordValue(collect.request);
  const serialSession = recordValue(request.serialSession);
  if (
    request?.operation !== "collect-serial-evidence" ||
    collect.result !== "succeeded"
  )
    throw new Error("installed sale serial collect report is missing");
  const correlationId = one(
    serialSession?.saleCorrelationIds,
    "serial sale correlations",
  );
  const sale = one(
    serialSession?.saleBindings,
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

function canonicalRuntime(
  _installedSale: unknown,
  machineEvidence: JsonRecord,
): JsonRecord {
  const runtime = recordValue(machineEvidence?.runtime);
  if (
    machineEvidence?.schemaVersion !== "machine-production-evidence/v2" ||
    runtime?.source !== "windows_process_and_live_cdp_client" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      String(runtime?.observedAt ?? ""),
    ) ||
    !Number.isSafeInteger(runtime.processId) ||
    Number(runtime.processId) < 1 ||
    !Number.isSafeInteger(runtime.sessionId) ||
    Number(runtime.sessionId) < 1 ||
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
  return Object.fromEntries(
    [
      "processId",
      "executablePath",
      "principal",
      "sessionId",
      "cdpTargetId",
      "cdpSessionId",
    ].map((name) => [name, runtime[name]]),
  );
}

function evidencePath(installedSale: JsonRecord, name: string): string {
  const path = recordValue(installedSale.evidence)[name];
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
}: {
  installedSaleReportPath: string;
  machineEvidencePath: string;
  daemonEvidencePath: string;
  platformF1Path: string;
  audioStartReportPath: string;
  audioStopReportPath: string;
}): JsonRecord {
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
}: {
  artifacts: JsonRecord;
  audioEvidenceDirectory: string;
  timing?: Parameters<typeof analyzeDelayedPickupControllerFrames>[2];
}): JsonRecord {
  const diagnostics: JsonRecord[] = [];
  const installedSaleArtifact = recordValue(artifacts.installedSale);
  const machineArtifact = recordValue(artifacts.machine);
  const platformBaselineArtifact = recordValue(artifacts.platformBaseline);
  const platformF1Artifact = recordValue(artifacts.platformF1);
  const platformPostArtifact = recordValue(artifacts.platformPost);
  const serialArtifact = recordValue(artifacts.serial);
  const audioStartArtifact = recordValue(artifacts.audioStart);
  const audioStopArtifact = recordValue(artifacts.audioStop);
  const installedSaleValue = recordValue(installedSaleArtifact.value);
  const machineValue = recordValue(machineArtifact.value);
  const platformBaselineValue = recordValue(platformBaselineArtifact.value);
  const platformF1Value = recordValue(platformF1Artifact.value);
  const platformPostValue = recordValue(platformPostArtifact.value);
  const serialValue = recordValue(serialArtifact.value);
  const audioStartValue = recordValue(audioStartArtifact.value);
  const audioStopValue = recordValue(audioStopArtifact.value);
  const runId = String(installedSaleValue.runId);
  const platform = analyzeAuthoritativePlatformEvidence({
    runId,
    baseline: platformBaselineValue,
    atF1: platformF1Value,
    postF2: platformPostValue,
  });
  const platformBinding = recordValue(platform.binding);
  collectDiagnostics(diagnostics, arrayValue(platform.diagnostics));
  let serialBinding: JsonRecord | null = null;
  let runtime: JsonRecord | null = null;
  try {
    serialBinding = deriveSerialSaleBinding(serialValue);
  } catch (error) {
    diagnostics.push(
      diagnostic("installed_serial_sale_binding_invalid", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  try {
    runtime = canonicalRuntime(
      installedSaleValue,
      machineValue,
    );
  } catch (error) {
    diagnostics.push(
      diagnostic("installed_runtime_handoff_invalid", {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
  const stopRequest = recordValue(audioStopValue).request;
  const stopRequestRecord = recordValue(stopRequest);
  const serialBindingSale = recordValue(serialBinding?.sale);
  const expectedBinding =
    platformBinding && serialBinding
      ? {
          runId,
          lifecycleReference: stopRequestRecord?.lifecycleReference,
          transactionId: stopRequestRecord?.transactionId,
          saleCorrelationId: serialBinding.correlationId,
          orderId: platformBinding.orderId,
          orderNo: platformBinding.orderNo,
          commandId: platformBinding.commandId,
          commandNo: platformBinding.commandNo,
        }
      : null;
  if (
    !expectedBinding ||
    serialBindingSale.orderId !== platformBinding?.orderId ||
    serialBindingSale.paymentId !== platformBinding?.paymentId ||
    serialBindingSale.vendingCommandId !== platformBinding?.commandId
  )
    diagnostics.push(diagnostic("cross_producer_sale_binding_invalid"));

  let audioCapture: JsonRecord | null = null;
  if (expectedBinding && runtime) {
    try {
      const start = recordValue(
        validateSaleAudioCaptureReport(
          audioStartValue,
          recordValue(recordValue(audioStartValue).request),
        ),
      );
      const startRequest = recordValue(start.request);
      const startCaptureSession = recordValue(start.captureSession);
      const stopRequestRecord = recordValue(stopRequest);
      const stopCaptureSession = recordValue(
        stopRequestRecord.captureSession,
      );
      if (
        startRequest.phase !== "start" ||
        startRequest.runId !== runId ||
        startRequest.lifecycleReference !==
          expectedBinding.lifecycleReference ||
        startRequest.transactionId !== expectedBinding.transactionId ||
        JSON.stringify(startRequest.runtime) !== JSON.stringify(runtime) ||
        stopRequestRecord?.phase !== "stop" ||
        JSON.stringify(stopRequestRecord.runtime) !== JSON.stringify(runtime) ||
        JSON.stringify(stopRequestRecord.sale) !==
          JSON.stringify({
            saleCorrelationId: expectedBinding.saleCorrelationId,
            orderId: expectedBinding.orderId,
            orderNo: expectedBinding.orderNo,
            commandId: expectedBinding.commandId,
            commandNo: expectedBinding.commandNo,
          }) ||
        stopCaptureSession?.captureSessionId !==
          startCaptureSession.captureSessionId ||
        stopCaptureSession?.startOperationReference !==
          startCaptureSession.startOperationReference ||
        stopCaptureSession?.startedAt !== startCaptureSession.startedAt
      )
        throw new Error("sale audio start/stop lifecycle binding is invalid");
      audioCapture = recordValue(
        inspectCompletedSaleAudioCapture({
          report: audioStopValue,
          request: stopRequestRecord,
          directory: resolve(audioEvidenceDirectory),
        }),
      );
    } catch (error) {
      diagnostics.push(
        diagnostic("sale_audio_capture_invalid", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  const controller: JsonRecord =
    expectedBinding && audioCapture
      ? recordValue(
          analyzeDelayedPickupControllerFrames(
            recordValue(audioCapture.serial),
            expectedBinding,
            timing,
          ),
        )
      : {
          diagnostics: [diagnostic("production_serial_capture_missing")],
          events: null,
        };
  const ui: JsonRecord =
    expectedBinding && runtime
      ? recordValue(
          analyzeDelayedPickupUiEvidence(
            machineValue,
            expectedBinding,
            runtime,
          ),
        )
      : {
          diagnostics: [diagnostic("canonical_machine_cdp_evidence_missing")],
          firstBySurface: {},
        };
  const trace: JsonRecord =
    expectedBinding && runtime
      ? recordValue(
          analyzeDelayedPickupRuntimeTrace(
            machineValue,
            expectedBinding,
            runtime,
            timing,
          ),
        )
      : { diagnostics: [diagnostic("runtime_trace_missing")], cues: {} };
  const daemon: JsonRecord =
    expectedBinding && platform.binding
      ? recordValue(
          analyzeDaemonFulfillmentStoreEvidence(
            recordValue(recordValue(artifacts.daemon).value),
            expectedBinding,
            platformBinding,
          ),
        )
      : {
          diagnostics: [
            diagnostic("daemon_fulfillment_store_evidence_missing"),
          ],
          stock: null,
        };
  collectDiagnostics(
    diagnostics,
    arrayValue(controller.diagnostics),
    arrayValue(ui.diagnostics),
    arrayValue(trace.diagnostics),
    arrayValue(daemon.diagnostics),
  );
  let cueWindows: JsonRecord | null = null;
  const controllerEvents = recordValue(controller.events);
  const traceCues = recordValue(trace.cues);
  const controllerF0 = recordValue(controllerEvents.f0);
  const controllerF2 = recordValue(controllerEvents.f2);
  if (audioCapture && controller.events) {
    const capture = recordValue(recordValue(audioCapture.report).capture);
    const captureStart = Date.parse(String(capture.startedAt));
    const captureEnd = Date.parse(String(capture.completedAt));
    if (
      captureStart >= Number(controllerF0.atMs) ||
      captureEnd <= Number(controllerF2.atMs)
    )
      diagnostics.push(diagnostic("sale_audio_capture_does_not_cover_sale"));
    cueWindows = recordValue(
      correlateDelayedPickupCueWindows({
        captureBytes: audioCapture.wavBytes as Buffer,
        captureStartedAt: capture.startedAt,
        captureCompletedAt: capture.completedAt,
        cues: traceCues,
        clockOffsetMs:
          Date.parse(
            String(
              recordValue(
                recordValue(traceCues.dispense_succeeded).journey,
              ).at ?? "",
            ),
          ) - Number(controllerF2.atMs),
      }),
    );
    collectDiagnostics(diagnostics, arrayValue(cueWindows.diagnostics));
  } else diagnostics.push(diagnostic("audio_cue_window_missing_or_empty"));
  if (
    controller.events &&
    !pickupCueWithinPickupPhase({
      playback: recordValue(recordValue(traceCues.pickup_started).started),
      controller: controllerEvents,
      clockOffsetMs:
        Date.parse(
          String(
            recordValue(
              recordValue(traceCues.dispense_succeeded).journey,
            ).at ?? "",
          ),
        ) - Number(controllerF2.atMs),
      toleranceMs: Number(timing.controllerTimingToleranceMs),
    })
  ) {
    diagnostics.push(diagnostic("pickup_playback_outside_pickup_phase"));
  }

  const compactSources = Object.fromEntries(
    Object.entries(artifacts).map(([name, artifact]) => {
      const artifactRecord = recordValue(artifact);
      return [
        name,
        {
          sha256: artifactRecord.sha256,
          byteLength: artifactRecord.byteLength,
        },
      ];
    }),
  ) as JsonRecord;
  return {
    schemaVersion: "delayed-pickup-native-audio-production-acceptance/v3",
    kind: "delayed-pickup-native-audio-production-acceptance",
    runId,
    result: diagnostics.length === 0 ? "passed" : "failed",
    binding: expectedBinding,
    runtime,
    controller: {
      timing: controller.timing ?? null,
      cueStartLatencyMs: Object.fromEntries(
        Object.entries(traceCues).map(([label, cue]) => [
          label,
          recordValue(cue).startLatencyMs ?? null,
        ]),
      ),
      pickupPlaybackStartedAt:
        recordValue(recordValue(traceCues.pickup_started).started).at ?? null,
      frameCounts: audioCapture
        ? Object.fromEntries(
            ["f0", "e5", "f1", "af", "f2"].map((code) => [
              code.toUpperCase(),
              arrayValue(recordValue(audioCapture.serial).frames).filter(
                (frame: unknown) =>
                  String(recordValue(frame).bytesHex).toLowerCase() ===
                  `55${code}`,
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
