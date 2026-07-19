#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import { inspectWavPcm } from "./default-audio-evidence.mjs";
import { readRawSerialJournal } from "./qemu-usb-serial-host-adapter.mjs";

export const SALE_AUDIO_CAPTURE_SCHEMA_VERSION =
  "vm-sale-audio-capture-request/v1";
export const SALE_AUDIO_REPORT_SCHEMA_VERSION =
  "vm-sale-audio-capture-report/v1";

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const EVIDENCE_ID = /^factory-evidence:\/\/sha256\/[a-f0-9]{64}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const URI_ID =
  /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]{1,254}$/;
const SALE_AUDIO_THRESHOLD = Object.freeze({
  minimumPeakAbsoluteSample: 512,
  minimumNonSilentFrames: 4_800,
  minimumDurationMs: 100,
  minimumDistinctNonSilentSampleMagnitudes: 2,
});

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
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new Error(`${name} must be an ISO timestamp`);
  return value;
}

function canonical(value, pattern, name) {
  const normalized = requiredString(value, name);
  if (normalized !== value || !pattern.test(value))
    throw new Error(`${name} format is invalid`);
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

function writeReport(out, report) {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
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
  if (!new Set(["start", "stop", "cancel"]).has(phase))
    throw new Error("--capture-phase must be start, stop, or cancel");
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
    sale: phase === "stop" ? options.sale : null,
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
    !new Set(["start", "stop", "cancel"]).has(request.phase)
  )
    throw new Error("sale audio capture request operation is invalid");
  canonical(request.runId, TOKEN_ID, "request.runId");
  canonical(
    request.operationNonce,
    /^op-[a-f0-9]{32}$/,
    "request.operationNonce",
  );
  if (request.operationReference !== `vm-operation://${request.operationNonce}`)
    throw new Error("request.operationReference format is invalid");
  for (const name of ["lifecycleReference", "targetIdentity", "transactionId"])
    canonical(request[name], URI_ID, `request.${name}`);
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
  canonical(runtime.cdpTargetId, TOKEN_ID, "request.runtime.cdpTargetId");
  canonical(
    runtime.cdpSessionId,
    /^cdp-connection:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "request.runtime.cdpSessionId",
  );
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
    canonical(
      request.captureSession.captureSessionId,
      URI_ID,
      "request.captureSession.captureSessionId",
    );
    canonical(
      request.captureSession.startOperationReference,
      URI_ID,
      "request.captureSession.startOperationReference",
    );
    timestamp(
      request.captureSession.startedAt,
      "request.captureSession.startedAt",
    );
    if (request.phase === "cancel") {
      if (request.sale !== null)
        throw new Error("capture cancel must not claim sale identifiers");
    } else {
      canonical(
        request.sale?.saleCorrelationId,
        URI_ID,
        "request.sale.saleCorrelationId",
      );
      canonical(request.sale?.orderId, UUID, "request.sale.orderId");
      canonical(request.sale?.orderNo, TOKEN_ID, "request.sale.orderNo");
      canonical(request.sale?.commandId, UUID, "request.sale.commandId");
      canonical(request.sale?.commandNo, TOKEN_ID, "request.sale.commandNo");
      exactKeys(
        request.sale,
        ["saleCorrelationId", "orderId", "orderNo", "commandId", "commandNo"],
        "request.sale",
      );
    }
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sessionStatePath(evidenceDirectory, captureSessionId) {
  return join(
    resolve(requiredString(evidenceDirectory, "evidenceDirectory")),
    `.capture-session-${sha256(captureSessionId)}.json`,
  );
}

function writeSessionState(evidenceDirectory, captureSessionId, state) {
  const path = sessionStatePath(evidenceDirectory, captureSessionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function readSessionState(evidenceDirectory, captureSessionId) {
  const path = sessionStatePath(evidenceDirectory, captureSessionId);
  if (!existsSync(path))
    throw new Error("sale audio capture session was not found");
  return JSON.parse(readFileSync(path, "utf8"));
}

function evidenceEntry(directory, role, bytes, extension) {
  const digest = sha256(bytes);
  const fileName = `${digest}.${extension}`;
  const entry = {
    role,
    identity: `factory-evidence://sha256/${digest}`,
    digest: `sha256:${digest}`,
    fileName,
  };
  writeFileSync(join(directory, fileName), bytes, { mode: 0o600 });
  return entry;
}

function normalizedSaleAudioBinding(request) {
  return {
    runId: request.runId,
    lifecycleReference: request.lifecycleReference,
    transactionId: request.transactionId,
    saleCorrelationId: request.sale.saleCorrelationId,
    orderId: request.sale.orderId,
    orderNo: request.sale.orderNo,
    commandId: request.sale.commandId,
    commandNo: request.sale.commandNo,
  };
}

function buildSaleAudioFrameCapture(binding, rawFrames) {
  const frames = rawFrames
    .filter((frame) =>
      ["VEND", "F0", "E5", "F1", "AF", "F2"].includes(frame.parsedOpcode),
    )
    .map((frame, index) => {
      const bytesHex = frame.rawFrameHex.toLowerCase();
      return {
        sequence: index + 1,
        role:
          frame.direction === "daemon-to-controller"
            ? "upper-controller"
            : "lower-controller",
        direction:
          frame.direction === "daemon-to-controller"
            ? "guest_to_host"
            : "host_to_guest",
        bytesHex,
        capturedAt: frame.capturedAt ?? null,
        digest: `sha256:${sha256(Buffer.from(bytesHex, "hex"))}`,
        binding: { ...binding },
      };
    });
  const opcodes = frames.map((frame) => frame.bytesHex.slice(2).toUpperCase());
  if (
    !opcodes.includes("F0") ||
    !opcodes.includes("F1") ||
    !opcodes.includes("F2") ||
    !frames.some((frame) => frame.role === "upper-controller")
  ) {
    throw new Error(
      "raw serial journal does not contain one complete delayed-pickup sale",
    );
  }
  return {
    schemaVersion: "host-production-serial-frame-capture/v1",
    binding: { ...binding },
    frames,
  };
}

function libvirtDomainBinding(value) {
  exactKeys(
    value,
    ["libvirtUri", "domainName", "serialJournalPath"],
    "libvirt domain binding",
  );
  const libvirtUri = requiredString(value.libvirtUri, "libvirtUri");
  const domainName = requiredString(value.domainName, "domainName");
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(domainName))
    throw new Error("domainName contains unsupported characters");
  return {
    libvirtUri,
    domainName,
    serialJournalPath: resolve(
      requiredString(value.serialJournalPath, "serialJournalPath"),
    ),
  };
}

function attribute(element, name) {
  const match = String(element).match(new RegExp(`\\b${name}=(['\"])(.*?)\\1`));
  return match?.[2] ?? null;
}

function soleDomainAudioOutput(domainXml) {
  const xml = String(domainXml);
  const sounds = [...xml.matchAll(/<sound\b[^>]*>([\s\S]*?)<\/sound>/g)];
  const audioXml = xml.replace(/<sound\b[^>]*>[\s\S]*?<\/sound>/g, "");
  const audioDevices = [
    ...audioXml.matchAll(/<audio\b[^>]*>([\s\S]*?)<\/audio>/g),
    ...audioXml.matchAll(/<audio\b[^>]*\/>/g),
  ];
  if (
    sounds.length !== 1 ||
    attribute(sounds[0][0], "model") !== "ich9" ||
    !/<audio\b[^>]*\bid=(['"])1\1\s*\/>/.test(sounds[0][0]) ||
    audioDevices.length !== 1 ||
    attribute(audioDevices[0][0], "id") !== "1" ||
    attribute(audioDevices[0][0], "type") !== "file"
  ) {
    throw new Error(
      "running domain must expose one default ICH9 file audio output",
    );
  }
  const outputs = [...audioDevices[0][0].matchAll(/<output\b[^>]*\/>/g)];
  const outputPath =
    attribute(audioDevices[0][0], "path") ??
    (outputs.length === 1 ? attribute(outputs[0][0], "file") : null);
  if (!outputPath || !outputPath.startsWith("/") || outputPath.includes("\0")) {
    throw new Error("running domain audio output path is invalid");
  }
  return { model: "ich9", audioId: 1, outputPath: resolve(outputPath) };
}

function productionVirsh(args) {
  const result = spawnSync("/usr/bin/virsh", args, { encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `virsh ${args.at(-1)} failed: ${String(result.stderr ?? result.stdout ?? "").trim()}`,
    );
  }
  return String(result.stdout ?? "");
}

function runningDomainAudio(binding, runVirsh = productionVirsh) {
  const state = runVirsh([
    "--connect",
    binding.libvirtUri,
    "domstate",
    binding.domainName,
  ])
    .trim()
    .toLowerCase();
  if (state !== "running") throw new Error("libvirt domain is not running");
  const domainXml = runVirsh([
    "--connect",
    binding.libvirtUri,
    "dumpxml",
    binding.domainName,
  ]);
  return { state, ...soleDomainAudioOutput(domainXml) };
}

function wavSnapshot(path) {
  const stat = statSync(path);
  if (!stat.isFile())
    throw new Error("running domain audio output is not a regular file");
  return {
    path,
    device: stat.dev,
    inode: stat.ino,
    byteLength: stat.size,
  };
}

function readStableWavSnapshot(path, expected) {
  const before = wavSnapshot(path);
  if (before.device !== expected.device || before.inode !== expected.inode) {
    throw new Error("running domain audio output inode changed during capture");
  }
  const bytes = readFileSync(path);
  const after = wavSnapshot(path);
  if (
    after.device !== before.device ||
    after.inode !== before.inode ||
    after.byteLength !== before.byteLength ||
    bytes.length !== after.byteLength
  ) {
    throw new Error("running domain audio output changed while snapshotting");
  }
  return { bytes, snapshot: after };
}

function capturedQemuWav(bytes, startByteLength) {
  if (
    bytes.length < 44 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WAVE" ||
    bytes.toString("ascii", 12, 16) !== "fmt " ||
    bytes.toString("ascii", 36, 40) !== "data"
  ) {
    return bytes;
  }
  const blockAlign = bytes.readUInt16LE(32);
  if (!blockAlign) return bytes;
  const requestedStart = startByteLength >= 44 ? startByteLength : 44;
  const alignedStart =
    44 + Math.ceil((requestedStart - 44) / blockAlign) * blockAlign;
  if (alignedStart >= bytes.length) return bytes.subarray(0, 44);
  const dataLength =
    Math.floor((bytes.length - alignedStart) / blockAlign) * blockAlign;
  const captured = Buffer.alloc(44 + dataLength);
  bytes.copy(captured, 0, 0, 44);
  bytes.copy(captured, 44, alignedStart, alignedStart + dataLength);
  captured.writeUInt32LE(captured.length - 8, 4);
  captured.writeUInt32LE(dataLength, 40);
  return captured;
}

function createLibvirtDomainBackend(binding, testOnlyRunVirsh) {
  const runVirsh = testOnlyRunVirsh ?? productionVirsh;
  return {
    async start() {
      const domain = runningDomainAudio(binding, runVirsh);
      const snapshot = existsSync(domain.outputPath)
        ? wavSnapshot(domain.outputPath)
        : null;
      return {
        kind: "libvirt-domain-file-output",
        domain,
        startSnapshot: snapshot,
      };
    },
    async stop(state) {
      const domain = runningDomainAudio(binding, runVirsh);
      if (
        domain.outputPath !== state.domain.outputPath ||
        domain.model !== state.domain.model ||
        domain.audioId !== state.domain.audioId
      ) {
        throw new Error("running domain audio output changed during capture");
      }
      const completed = state.startSnapshot
        ? readStableWavSnapshot(domain.outputPath, state.startSnapshot)
        : (() => {
            const snapshot = wavSnapshot(domain.outputPath);
            return { bytes: readFileSync(domain.outputPath), snapshot };
          })();
      const startByteLength = state.startSnapshot?.byteLength ?? 0;
      if (completed.snapshot.byteLength <= startByteLength) {
        throw new Error(
          "running domain audio output did not advance after capture start",
        );
      }
      return {
        bytes: capturedQemuWav(completed.bytes, startByteLength),
        completedAt: new Date().toISOString(),
        provenance: {
          domain: {
            libvirtUri: binding.libvirtUri,
            domainName: binding.domainName,
            state: domain.state,
            model: domain.model,
            audioId: domain.audioId,
          },
          wav: {
            path: domain.outputPath,
            device: completed.snapshot.device,
            inode: completed.snapshot.inode,
            startOffset: startByteLength,
            endOffset: completed.snapshot.byteLength,
            capturedByteLength: completed.snapshot.byteLength - startByteLength,
          },
        },
      };
    },
    async abort() {},
  };
}

// This is intentionally test-only. Production always derives the path from the
// running libvirt domain and never accepts an ambient audio file configuration.
export function createFileBackedAudioCaptureTestBackend(wavPath) {
  const path = resolve(requiredString(wavPath, "test WAV path"));
  return {
    async start() {
      return { kind: "test-file", wavPath: path };
    },
    async stop(state) {
      return {
        bytes: readFileSync(state.wavPath),
        completedAt: new Date().toISOString(),
      };
    },
    async abort() {},
  };
}

function productionReadSerialJournal(path) {
  if (
    existsSync(path) &&
    readFileSync(path, "utf8").trimStart().startsWith("{")
  ) {
    throw new Error(
      "production serial evidence must be captured from the host QEMU PTY",
    );
  }
  return readRawSerialJournal(path);
}

async function executeAdapterOperation(
  request,
  {
    evidenceDirectory,
    production,
    backendFactory,
    readSerialJournal,
    testOnlyRunVirsh,
  } = {},
) {
  const exportDirectory = resolve(
    requiredString(evidenceDirectory, "evidenceDirectory"),
  );
  mkdirSync(exportDirectory, { recursive: true, mode: 0o700 });
  if (request.phase === "start") {
    const captureSession = {
      captureSessionId: `sale-audio-session://sha256-${sha256(request.operationReference)}`,
      startOperationReference: request.operationReference,
      startedAt: new Date().toISOString(),
    };
    const domainBinding = libvirtDomainBinding(production);
    const backend = await (
      backendFactory
        ? backendFactory()
        : createLibvirtDomainBackend(domainBinding, testOnlyRunVirsh)
    ).start({
      request,
      evidenceDirectory: exportDirectory,
      captureSession,
    });
    writeSessionState(exportDirectory, captureSession.captureSessionId, {
      request,
      captureSession,
      rawSerialJournalPath: domainBinding.serialJournalPath,
      backend,
      status: "started",
    });
    return {
      schemaVersion: SALE_AUDIO_REPORT_SCHEMA_VERSION,
      kind: "vm-sale-audio-capture-report",
      result: "succeeded",
      adapter: {
        identity: "vm-host-adapter://sale-audio-capture",
        version: "1.0.0",
      },
      request,
      captureSession,
      capture: null,
      evidence: [],
    };
  }

  const state = readSessionState(
    exportDirectory,
    request.captureSession.captureSessionId,
  );
  if (
    JSON.stringify(state.captureSession) !==
    JSON.stringify(request.captureSession)
  ) {
    throw new Error("sale audio capture session binding is invalid");
  }
  const domainBinding = libvirtDomainBinding(production);
  const backend = backendFactory
    ? backendFactory()
    : createLibvirtDomainBackend(domainBinding, testOnlyRunVirsh);
  const stopped = await backend.stop(state.backend, {
    request,
    evidenceDirectory: exportDirectory,
    state,
  });
  const saleBinding = normalizedSaleAudioBinding(request);
  const serialCapture = buildSaleAudioFrameCapture(
    saleBinding,
    (readSerialJournal ?? productionReadSerialJournal)(
      state.rawSerialJournalPath,
    ),
  );
  const inspection = inspectWavPcm(stopped.bytes, SALE_AUDIO_THRESHOLD);
  if (!inspection.ok || inspection.kind !== "passed") {
    throw new Error("sale default-audio WAV is silent or malformed");
  }
  const audioEvidence = evidenceEntry(
    exportDirectory,
    "sale-default-audio-capture",
    stopped.bytes,
    "wav",
  );
  const serialEvidence = evidenceEntry(
    exportDirectory,
    "sale-serial-frame-capture",
    Buffer.from(`${JSON.stringify(serialCapture)}\n`),
    "json",
  );
  writeSessionState(exportDirectory, request.captureSession.captureSessionId, {
    ...state,
    status: "stopped",
    completedAt: stopped.completedAt,
  });
  return {
    schemaVersion: SALE_AUDIO_REPORT_SCHEMA_VERSION,
    kind: "vm-sale-audio-capture-report",
    result: "succeeded",
    adapter: {
      identity: "vm-host-adapter://sale-audio-capture",
      version: "1.0.0",
    },
    request,
    captureSession: state.captureSession,
    capture: {
      source: "windows_default_output",
      binding: saleBinding,
      startedAt: state.captureSession.startedAt,
      completedAt: stopped.completedAt,
      audioArtifact: audioEvidence.identity,
      serialArtifact: serialEvidence.identity,
      threshold: { ...SALE_AUDIO_THRESHOLD },
      provenance: stopped.provenance ?? null,
    },
    evidence: [audioEvidence, serialEvidence],
  };
}

export async function abortSaleAudioCaptureSession(
  { captureSessionId, evidenceDirectory },
  { production, backendFactory, testOnlyRunVirsh } = {},
) {
  const state = readSessionState(evidenceDirectory, captureSessionId);
  if (state.status !== "started")
    return { aborted: false, alreadyStopped: true };
  const backend = backendFactory
    ? backendFactory()
    : createLibvirtDomainBackend(
        libvirtDomainBinding(production),
        testOnlyRunVirsh,
      );
  await backend.abort(state.backend, {
    evidenceDirectory,
    state,
  });
  writeSessionState(evidenceDirectory, captureSessionId, {
    ...state,
    status: "aborted",
    abortedAt: new Date().toISOString(),
  });
  return { aborted: true };
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
  if (request.phase === "start" || request.phase === "cancel") {
    if (
      (request.phase === "start" &&
        session.startOperationReference !== request.operationReference) ||
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
      "provenance",
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
  if (report.capture.provenance !== null) {
    exactKeys(
      report.capture.provenance,
      ["domain", "wav"],
      "report.capture.provenance",
    );
    exactKeys(
      report.capture.provenance.domain,
      ["libvirtUri", "domainName", "state", "model", "audioId"],
      "report.capture.provenance.domain",
    );
    exactKeys(
      report.capture.provenance.wav,
      [
        "path",
        "device",
        "inode",
        "startOffset",
        "endOffset",
        "capturedByteLength",
      ],
      "report.capture.provenance.wav",
    );
    if (
      report.capture.provenance.domain.state !== "running" ||
      report.capture.provenance.domain.model !== "ich9" ||
      report.capture.provenance.domain.audioId !== 1 ||
      !String(report.capture.provenance.wav.path ?? "").startsWith("/") ||
      !Number.isInteger(report.capture.provenance.wav.device) ||
      !Number.isInteger(report.capture.provenance.wav.inode) ||
      !Number.isInteger(report.capture.provenance.wav.startOffset) ||
      !Number.isInteger(report.capture.provenance.wav.endOffset) ||
      report.capture.provenance.wav.endOffset <=
        report.capture.provenance.wav.startOffset ||
      report.capture.provenance.wav.capturedByteLength !==
        report.capture.provenance.wav.endOffset -
          report.capture.provenance.wav.startOffset
    ) {
      throw new Error("sale audio capture provenance is invalid");
    }
  }
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

export async function runSaleAudioCaptureHostAdapterCli(
  argv,
  dependencies = {},
) {
  const options = parseOptions(argv);
  return executeSaleAudioCaptureHostAdapter(
    {
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
      evidenceDirectory: options["evidence-dir"],
      outPath: requiredString(options.out, "--out"),
      production: {
        libvirtUri: requiredString(options["libvirt-uri"], "--libvirt-uri"),
        domainName: requiredString(options["domain-name"], "--domain-name"),
        serialJournalPath: requiredString(
          options["serial-journal-path"],
          "--serial-journal-path",
        ),
      },
    },
    dependencies,
  );
}

export async function executeSaleAudioCaptureHostAdapter(
  options,
  dependencies = {},
) {
  const request = createSaleAudioCaptureRequest({
    phase: options.phase,
    runId: options.runId,
    lifecycleReference: options.lifecycleReference,
    targetIdentity: options.targetIdentity,
    transactionId: options.transactionId,
    runtime: options.runtime,
    captureSessionId: options.captureSessionId,
    startOperationReference: options.startOperationReference,
    captureStartedAt: options.captureStartedAt,
    sale: options.phase === "stop" ? options.sale : null,
  });
  const invoke = dependencies.invokeAdapter ?? executeAdapterOperation;
  const report = validateSaleAudioCaptureReport(
    await invoke(request, {
      environment: dependencies.environment ?? process.env,
      evidenceDirectory: requiredString(
        options.evidenceDirectory,
        "evidenceDirectory",
      ),
      production: options.production,
      backendFactory: dependencies.backendFactory,
      readSerialJournal: dependencies.readSerialJournal,
      testOnlyRunVirsh: dependencies.testOnlyRunVirsh,
    }),
    request,
  );
  writeReport(requiredString(options.outPath, "outPath"), report);
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runSaleAudioCaptureHostAdapterCli(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
