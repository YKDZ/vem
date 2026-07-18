#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { inspectWavPcm } from "./default-audio-evidence.mjs";

export const SALE_AUDIO_CAPTURE_SCHEMA_VERSION =
  "vm-sale-audio-capture-request/v1";
export const SALE_AUDIO_REPORT_SCHEMA_VERSION =
  "vm-sale-audio-capture-report/v1";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const EVIDENCE_ID = /^factory-evidence:\/\/sha256\/[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${name} is required`);
  return value.trim();
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function timestamp(value, name) {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value))
    throw new Error(`${name} must be an ISO timestamp`);
  return value;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function exactKeys(value, keys, name) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !same(Object.keys(value).sort(), [...keys].sort())
  )
    throw new Error(`${name} fields are invalid`);
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`unknown argument: ${name}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--"))
      throw new Error(`${name} requires a value`);
    options[name.slice(2)] = value;
    index += 1;
  }
  return options;
}

function runtimeBinding(options) {
  return {
    processId: positiveInteger(
      options["machine-process-id"],
      "--machine-process-id",
    ),
    executablePath: requiredString(
      options["machine-executable-path"],
      "--machine-executable-path",
    ),
    principal: requiredString(
      options["interactive-principal"],
      "--interactive-principal",
    ),
    sessionId: positiveInteger(
      options["interactive-session-id"],
      "--interactive-session-id",
    ),
    cdpTargetId: requiredString(options["cdp-target-id"], "--cdp-target-id"),
    cdpSessionId: requiredString(options["cdp-session-id"], "--cdp-session-id"),
  };
}

function saleBinding(options) {
  return {
    saleCorrelationId: requiredString(
      options["sale-correlation-id"],
      "--sale-correlation-id",
    ),
    orderId: requiredString(options["order-id"], "--order-id"),
    orderNo: requiredString(options["order-no"], "--order-no"),
    commandId: requiredString(options["command-id"], "--command-id"),
    commandNo: requiredString(options["command-no"], "--command-no"),
  };
}

export function createSaleAudioCaptureRequest(options) {
  const phase = requiredString(options.phase, "--capture-phase");
  if (!new Set(["start", "stop"]).has(phase))
    throw new Error("--capture-phase must be start or stop");
  const operationNonce =
    options.operationNonce ?? `op-${randomBytes(16).toString("hex")}`;
  const request = {
    schemaVersion: SALE_AUDIO_CAPTURE_SCHEMA_VERSION,
    kind: "vm-sale-audio-capture-request",
    operation: "capture-sale-audio",
    phase,
    runId: requiredString(options.runId, "--run-id"),
    operationNonce,
    operationReference: `vm-operation://${operationNonce}`,
    lifecycleReference: requiredString(
      options.lifecycleReference,
      "--lifecycle-reference",
    ),
    targetIdentity: requiredString(options.targetIdentity, "--target-identity"),
    transactionId: requiredString(options.transactionId, "--transaction-id"),
    runtime: options.runtime,
    captureSession:
      phase === "start"
        ? null
        : {
            captureSessionId: requiredString(
              options.captureSessionId,
              "--capture-session-id",
            ),
            startOperationReference: requiredString(
              options.startOperationReference,
              "--start-operation-reference",
            ),
            startedAt: timestamp(
              options.captureStartedAt,
              "--capture-started-at",
            ),
          },
    sale: phase === "start" ? null : options.sale,
  };
  validateSaleAudioCaptureRequest(request);
  return request;
}

export function validateSaleAudioCaptureRequest(request) {
  exactKeys(
    request,
    [
      "schemaVersion",
      "kind",
      "operation",
      "phase",
      "runId",
      "operationNonce",
      "operationReference",
      "lifecycleReference",
      "targetIdentity",
      "transactionId",
      "runtime",
      "captureSession",
      "sale",
    ],
    "sale audio capture request",
  );
  if (request?.schemaVersion !== SALE_AUDIO_CAPTURE_SCHEMA_VERSION)
    throw new Error("sale audio capture request schema is invalid");
  if (
    request.kind !== "vm-sale-audio-capture-request" ||
    request.operation !== "capture-sale-audio" ||
    !new Set(["start", "stop"]).has(request.phase)
  )
    throw new Error("sale audio capture request operation is invalid");
  for (const name of [
    "runId",
    "operationNonce",
    "operationReference",
    "lifecycleReference",
    "targetIdentity",
    "transactionId",
  ])
    requiredString(request[name], `request.${name}`);
  const runtime = request.runtime;
  exactKeys(
    runtime,
    [
      "processId",
      "executablePath",
      "principal",
      "sessionId",
      "cdpTargetId",
      "cdpSessionId",
    ],
    "request.runtime",
  );
  positiveInteger(runtime?.processId, "request.runtime.processId");
  positiveInteger(runtime?.sessionId, "request.runtime.sessionId");
  for (const name of [
    "executablePath",
    "principal",
    "cdpTargetId",
    "cdpSessionId",
  ])
    requiredString(runtime?.[name], `request.runtime.${name}`);
  if (request.phase === "start") {
    if (request.captureSession !== null || request.sale !== null)
      throw new Error(
        "capture start must not claim sale identifiers before observation",
      );
  } else {
    exactKeys(
      request.captureSession,
      ["captureSessionId", "startOperationReference", "startedAt"],
      "request.captureSession",
    );
    for (const name of [
      "captureSessionId",
      "startOperationReference",
      "startedAt",
    ])
      requiredString(
        request.captureSession?.[name],
        `request.captureSession.${name}`,
      );
    timestamp(
      request.captureSession.startedAt,
      "request.captureSession.startedAt",
    );
    for (const name of [
      "saleCorrelationId",
      "orderId",
      "orderNo",
      "commandId",
      "commandNo",
    ])
      requiredString(request.sale?.[name], `request.sale.${name}`);
    exactKeys(
      request.sale,
      ["saleCorrelationId", "orderId", "orderNo", "commandId", "commandNo"],
      "request.sale",
    );
  }
  return structuredClone(request);
}

function validateEvidence(entry, role, extension) {
  exactKeys(entry, ["role", "identity", "digest", "fileName"], role);
  if (
    entry?.role !== role ||
    !EVIDENCE_ID.test(entry.identity ?? "") ||
    !SHA256.test(entry.digest ?? "") ||
    entry.identity !== `factory-evidence://sha256/${entry.digest.slice(7)}` ||
    entry.fileName !== `${entry.digest.slice(7)}.${extension}`
  )
    throw new Error(`${role} evidence binding is invalid`);
}

export function validateSaleAudioCaptureReport(report, requestInput) {
  const request = validateSaleAudioCaptureRequest(requestInput);
  exactKeys(
    report,
    [
      "schemaVersion",
      "kind",
      "result",
      "adapter",
      "request",
      "captureSession",
      "capture",
      "evidence",
    ],
    "sale audio capture report",
  );
  if (
    report?.schemaVersion !== SALE_AUDIO_REPORT_SCHEMA_VERSION ||
    report.kind !== "vm-sale-audio-capture-report" ||
    report.result !== "succeeded" ||
    !same(report.request, request)
  )
    throw new Error("sale audio capture report envelope is invalid");
  for (const name of ["identity", "version"])
    requiredString(report.adapter?.[name], `report.adapter.${name}`);
  exactKeys(report.adapter, ["identity", "version"], "report.adapter");
  const session = report.captureSession;
  exactKeys(
    session,
    ["captureSessionId", "startOperationReference", "startedAt"],
    "report.captureSession",
  );
  requiredString(
    session?.captureSessionId,
    "report.captureSession.captureSessionId",
  );
  requiredString(
    session?.startOperationReference,
    "report.captureSession.startOperationReference",
  );
  timestamp(session?.startedAt, "report.captureSession.startedAt");
  if (request.phase === "start") {
    if (
      session.startOperationReference !== request.operationReference ||
      report.capture !== null ||
      !Array.isArray(report.evidence) ||
      report.evidence.length !== 0
    )
      throw new Error(
        "capture start report must expose only the active capture session",
      );
    return structuredClone(report);
  }
  if (
    !same(session, request.captureSession) ||
    report.capture?.source !== "windows_default_output" ||
    !same(report.capture?.binding, {
      runId: request.runId,
      lifecycleReference: request.lifecycleReference,
      transactionId: request.transactionId,
      ...request.sale,
    })
  )
    throw new Error("completed sale audio capture binding is invalid");
  exactKeys(
    report.capture,
    [
      "source",
      "binding",
      "startedAt",
      "completedAt",
      "audioArtifact",
      "serialArtifact",
      "threshold",
    ],
    "report.capture",
  );
  exactKeys(
    report.capture.threshold,
    [
      "minimumPeakAbsoluteSample",
      "minimumNonSilentFrames",
      "minimumDurationMs",
      "minimumDistinctNonSilentSampleMagnitudes",
    ],
    "report.capture.threshold",
  );
  timestamp(report.capture.startedAt, "report.capture.startedAt");
  timestamp(report.capture.completedAt, "report.capture.completedAt");
  if (
    report.capture.startedAt !== request.captureSession.startedAt ||
    Date.parse(report.capture.completedAt) <=
      Date.parse(report.capture.startedAt)
  )
    throw new Error("sale audio capture timestamps are invalid");
  if (!Array.isArray(report.evidence) || report.evidence.length !== 2)
    throw new Error(
      "completed sale audio capture must export WAV and serial evidence",
    );
  validateEvidence(report.evidence[0], "sale-default-audio-capture", "wav");
  validateEvidence(report.evidence[1], "sale-serial-frame-capture", "json");
  if (
    report.capture.audioArtifact !== report.evidence[0].identity ||
    report.capture.serialArtifact !== report.evidence[1].identity
  )
    throw new Error("sale audio capture artifact references are invalid");
  return structuredClone(report);
}

function readContentAddressed(directory, evidence) {
  const bytes = readFileSync(join(directory, evidence.fileName));
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (`sha256:${digest}` !== evidence.digest)
    throw new Error(`${evidence.role} exported digest is invalid`);
  return bytes;
}

export function inspectCompletedSaleAudioCapture({
  report,
  request,
  directory,
}) {
  const validated = validateSaleAudioCaptureReport(report, request);
  if (request.phase !== "stop")
    throw new Error("only a stopped sale audio capture can be inspected");
  const wavBytes = readContentAddressed(directory, validated.evidence[0]);
  const serialBytes = readContentAddressed(directory, validated.evidence[1]);
  const audio = inspectWavPcm(wavBytes, validated.capture.threshold);
  if (!audio.ok || audio.kind !== "passed")
    throw new Error("sale default-audio WAV is silent or malformed");
  const serial = JSON.parse(serialBytes.toString("utf8"));
  if (
    serial?.schemaVersion !== "host-production-serial-frame-capture/v1" ||
    !same(serial.binding, validated.capture.binding) ||
    !Array.isArray(serial.frames)
  )
    throw new Error("host production serial frame capture is invalid");
  const inspection = {
    report: validated,
    audio: {
      sha256: validated.evidence[0].digest.slice(7),
      byteLength: wavBytes.length,
      format: audio.format,
      encoding: audio.encoding,
      sampleRateHz: audio.sampleRateHz,
      channels: audio.channels,
      frameCount: audio.frameCount,
      durationMs: audio.durationMs,
      nonSilentFrameCount: audio.nonSilentFrameCount,
      peakAbsoluteSample: audio.peakAbsoluteSample,
      distinctNonSilentSampleMagnitudes:
        audio.distinctNonSilentSampleMagnitudes,
    },
    serial,
  };
  Object.defineProperty(inspection, "wavBytes", {
    value: wavBytes,
    enumerable: false,
  });
  return inspection;
}

function invokeAdapter(
  request,
  { environment = process.env, timeoutMs = 600_000, evidenceDirectory } = {},
) {
  const executable = requiredString(
    environment.VEM_VM_HOST_ADAPTER,
    "VEM_VM_HOST_ADAPTER",
  );
  const root = mkdtempSync(
    join(resolve(environment.RUNNER_TEMP ?? tmpdir()), "vem-sale-audio-"),
  );
  const requestPath = join(root, "request.json");
  const reportPath = join(root, "report.json");
  const exportDirectory = resolve(
    requiredString(evidenceDirectory, "--evidence-dir"),
  );
  mkdirSync(exportDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(requestPath, `${JSON.stringify(request, null, 2)}\n`, {
    mode: 0o600,
  });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      executable,
      ["--request", requestPath, "--report", reportPath],
      {
        cwd: process.cwd(),
        env: {
          ...environment,
          VEM_VM_HOST_ADAPTER_EXTENSION: "capture-sale-audio/v1",
          VEM_VM_HOST_EVIDENCE_EXPORT_DIR: exportDirectory,
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4096);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rmSync(root, { recursive: true, force: true });
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0)
          throw new Error(
            `capture-sale-audio adapter failed: ${stderr || `exit ${code}`}`,
          );
        resolvePromise(JSON.parse(readFileSync(reportPath, "utf8")));
      } catch (error) {
        reject(error);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
}

export async function runSaleAudioCaptureHostAdapterCli(
  argv,
  dependencies = {},
) {
  const options = parseOptions(argv);
  const request = createSaleAudioCaptureRequest({
    phase: options["capture-phase"],
    runId: options["run-id"],
    lifecycleReference: options["lifecycle-reference"],
    targetIdentity: options["target-identity"],
    transactionId: options["transaction-id"],
    runtime: runtimeBinding(options),
    captureSessionId: options["capture-session-id"],
    startOperationReference: options["start-operation-reference"],
    captureStartedAt: options["capture-started-at"],
    sale: options["capture-phase"] === "stop" ? saleBinding(options) : null,
  });
  const invoke = dependencies.invokeAdapter ?? invokeAdapter;
  const report = validateSaleAudioCaptureReport(
    await invoke(request, {
      environment: dependencies.environment ?? process.env,
      timeoutMs: dependencies.timeoutMs,
      evidenceDirectory: options["evidence-dir"],
    }),
    request,
  );
  const out = requiredString(options.out, "--out");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSaleAudioCaptureHostAdapterCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
