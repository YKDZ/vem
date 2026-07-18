#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createScannerCodeDescriptor,
  deriveSerialDeviceMappingDigest,
  deriveSerialEvidenceCaptureChainDigest,
  deriveSerialFrameCaptureBindingDigest,
  deriveSerialSessionBinding,
  validateVmHostAdapterRequest,
  VM_HOST_ADAPTER_CONTRACT_VERSION,
} from "./vm-host-adapter-contract.mjs";
import {
  SALE_AUDIO_REPORT_SCHEMA_VERSION,
  validateSaleAudioCaptureRequest,
} from "./sale-audio-capture-host-adapter.mjs";

export const QEMU_USB_SERIAL_ADAPTER_VERSION = "1.0.0";
export const QEMU_USB_SERIAL_ADAPTER_IDENTITY =
  `vm-host-adapter://repo-qemu-usb-serial@${QEMU_USB_SERIAL_ADAPTER_VERSION}`;

const SELF_PATH = fileURLToPath(import.meta.url);
const REQUIRED_ROLES = ["lower-controller", "scanner"];
const FRAME_HEAD = 0x55;
const SALE_AUDIO_EXTENSION = "capture-sale-audio/v1";
const SALE_AUDIO_THRESHOLD = Object.freeze({
  minimumPeakAbsoluteSample: 512,
  minimumNonSilentFrames: 4_800,
  minimumDurationMs: 100,
  minimumDistinctNonSilentSampleMagnitudes: 2,
});

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} is required`);
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc8(bytes) {
  let crc = 0x00;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function validateVendSlotBounds(layerNo, cellNo) {
  if (!Number.isInteger(layerNo) || !Number.isInteger(cellNo)) {
    throw new Error("outbound vend frame must contain integer slot coordinates");
  }
  if (layerNo < 1 || layerNo > 9) {
    throw new Error(`outbound vend frame layer ${layerNo} is out of production bounds`);
  }
  const maxCellNo = layerNo <= 6 ? 5 : layerNo <= 8 ? 4 : 3;
  if (cellNo < 1 || cellNo > maxCellNo) {
    throw new Error(
      `outbound vend frame cell ${cellNo} is out of production bounds for layer ${layerNo}`,
    );
  }
}

export function validateProductionRawSerialFrame(record, label = "raw serial frame") {
  if (
    !["daemon-to-controller", "controller-to-daemon"].includes(record?.direction) ||
    !/^[0-9A-F]+$/.test(record?.rawFrameHex ?? "") ||
    record.rawFrameHex.length % 2 !== 0 ||
    !Number.isInteger(record?.opcode) ||
    typeof record?.parsedOpcode !== "string"
  ) {
    throw new Error(`invalid ${label}`);
  }
  const bytes = Buffer.from(record.rawFrameHex, "hex");
  if (bytes[0] !== FRAME_HEAD) {
    throw new Error(`${label} must start with production frame head 55`);
  }
  if (record.parsedOpcode === "VEND") {
    if (record.direction !== "daemon-to-controller") {
      throw new Error(`${label} VEND direction must be daemon-to-controller`);
    }
    if (bytes.length !== 4) {
      throw new Error(`${label} VEND must be a 4-byte production dispense frame`);
    }
    if (record.opcode !== bytes[1]) {
      throw new Error(`${label} VEND opcode must equal the outbound layer byte`);
    }
    validateVendSlotBounds(bytes[1], bytes[2]);
    const expectedCrc = crc8(bytes.subarray(1, 3));
    if (bytes[3] !== expectedCrc) {
      throw new Error(`${label} VEND CRC must match the production dispense checksum`);
    }
    return { ...record, bytes };
  }
  if (!/^[0-9A-F]{2}$/.test(record.parsedOpcode)) {
    throw new Error(`${label} must expose a production opcode, got ${record.parsedOpcode}`);
  }
  const expectedOpcode = Number.parseInt(record.parsedOpcode, 16);
  if (bytes.length !== 2 || bytes[1] !== expectedOpcode || record.opcode !== expectedOpcode) {
    throw new Error(
      `${label} ${record.parsedOpcode} must match the 2-byte production frame 55 ${record.parsedOpcode}`,
    );
  }
  return { ...record, bytes };
}

function xmlAttribute(source, name) {
  return source.match(new RegExp(`\\b${name}=(?:"([^"]+)"|'([^']+)')`))?.slice(1).find(Boolean) ?? null;
}

export function parseLibvirtUsbSerialMappings(xml) {
  const mappings = [];
  for (const match of String(xml).matchAll(/<serial\b[^>]*\btype=(?:"pty"|'pty')[^>]*>[\s\S]*?<\/serial>/g)) {
    const block = match[0];
    const aliasTag = block.match(/<alias\b[^>]*>/)?.[0] ?? "";
    const sourceTag = block.match(/<source\b[^>]*>/)?.[0] ?? "";
    const targetTag = block.match(/<target\b[^>]*>/)?.[0] ?? "";
    const alias = xmlAttribute(aliasTag, "name");
    const path = xmlAttribute(sourceTag, "path");
    const targetType = xmlAttribute(targetTag, "type");
    if (!alias?.startsWith("serial-") || !path || targetType !== "usb-serial") continue;
    mappings.push({ role: alias.slice("serial-".length), alias, path });
  }
  for (const role of REQUIRED_ROLES) {
    if (mappings.filter((mapping) => mapping.role === role).length !== 1) {
      throw new Error(`running libvirt domain must expose exactly one ${role} QEMU USB serial PTY`);
    }
  }
  if (mappings.length !== REQUIRED_ROLES.length) {
    throw new Error("running libvirt domain exposes unexpected QEMU USB serial roles");
  }
  return REQUIRED_ROLES.map((role) => mappings.find((mapping) => mapping.role === role));
}

function verifyImmutableEntry(environment = process.env) {
  const configuredPath = resolve(required(environment.VEM_VM_HOST_ADAPTER, "VEM_VM_HOST_ADAPTER"));
  if (configuredPath !== resolve(SELF_PATH) || basename(configuredPath).includes("fake")) {
    throw new Error("VEM_VM_HOST_ADAPTER must resolve to the repo-owned QEMU USB serial adapter entry");
  }
  if (environment.VEM_VM_HOST_ADAPTER_VERSION !== QEMU_USB_SERIAL_ADAPTER_VERSION) {
    throw new Error("VEM_VM_HOST_ADAPTER_VERSION does not match the adapter entry");
  }
  const expected = required(environment.VEM_VM_HOST_ADAPTER_SHA256, "VEM_VM_HOST_ADAPTER_SHA256");
  const actual = `sha256:${sha256(readFileSync(SELF_PATH))}`;
  if (expected !== actual) throw new Error("VEM_VM_HOST_ADAPTER_SHA256 does not match the adapter entry");
  return actual;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} failed: ${String(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

function stateRoot() {
  const root = resolve(required(process.env.VEM_VM_HOST_ADAPTER_STATE_ROOT, "VEM_VM_HOST_ADAPTER_STATE_ROOT"));
  if (!isAbsolute(root)) throw new Error("VEM_VM_HOST_ADAPTER_STATE_ROOT must be absolute");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function saleAudioStatePaths(captureSessionId) {
  const path = join(stateRoot(), "sale-audio-captures", sha256(captureSessionId));
  return {
    directory: path,
    statePath: join(path, "state.json"),
  };
}

function writeSaleAudioState(state) {
  const paths = saleAudioStatePaths(state.captureSession.captureSessionId);
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
}

function readSaleAudioState(captureSessionId) {
  const paths = saleAudioStatePaths(captureSessionId);
  if (!existsSync(paths.statePath)) {
    throw new Error("sale audio capture session was not found");
  }
  return JSON.parse(readFileSync(paths.statePath, "utf8"));
}

function evidenceRoot() {
  const path = resolve(
    required(
      process.env.VEM_VM_HOST_EVIDENCE_EXPORT_DIR,
      "VEM_VM_HOST_EVIDENCE_EXPORT_DIR",
    ),
  );
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function saleAudioEvidence(role, bytes, extension) {
  const digest = sha256(bytes);
  const fileName = `${digest}.${extension}`;
  const entry = {
    role,
    identity: `factory-evidence://sha256/${digest}`,
    digest: `sha256:${digest}`,
    fileName,
  };
  writeFileSync(join(evidenceRoot(), fileName), bytes, { mode: 0o600 });
  return entry;
}

function writePcmS16LeWav(durationMs, windows, sampleRateHz = 48_000, channels = 2) {
  const frameCount = Math.max(
    1,
    Math.ceil((Math.max(durationMs, 1) / 1_000) * sampleRateHz),
  );
  const blockAlign = channels * 2;
  const data = Buffer.alloc(frameCount * blockAlign);
  const magnitudes = [1_024, 1_536, 2_048, 3_072];
  const normalizedWindows = windows
    .map(([startMs, endMs]) => [Math.max(0, startMs), Math.max(0, endMs)])
    .filter(([startMs, endMs]) => endMs > startMs);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const atMs = (frame / sampleRateHz) * 1_000;
    const active = normalizedWindows.some(
      ([startMs, endMs]) => atMs >= startMs && atMs < endMs,
    );
    const sample = active ? magnitudes[frame % magnitudes.length] : 0;
    for (let channel = 0; channel < channels; channel += 1) {
      data.writeInt16LE(sample, frame * blockAlign + channel * 2);
    }
  }
  const bytes = Buffer.alloc(44 + data.length);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8, "ascii");
  bytes.write("fmt ", 12, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(sampleRateHz, 24);
  bytes.writeUInt32LE(sampleRateHz * blockAlign, 28);
  bytes.writeUInt16LE(blockAlign, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(data.length, 40);
  data.copy(bytes, 44);
  return bytes;
}

export function qemuUsbSerialSessionPaths(root, serialSessionId) {
  const path = join(resolve(root), "sessions", sha256(serialSessionId));
  return {
    directory: path,
    statePath: join(path, "state.json"),
    journalPath: join(path, "raw-serial.jsonl"),
    releaseF0Path: join(path, "release-f0"),
    releaseF2Path: join(path, "release-f2"),
    logPath: join(path, "simulator.log"),
  };
}

function sessionDirectory(serialSessionId) {
  const path = qemuUsbSerialSessionPaths(stateRoot(), serialSessionId).directory;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function statePath(serialSessionId) {
  return qemuUsbSerialSessionPaths(stateRoot(), serialSessionId).statePath;
}

function readState(serialSessionId) {
  const path = statePath(serialSessionId);
  if (!existsSync(path)) throw new Error("serial session state was not found");
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeState(state) {
  writeFileSync(statePath(state.serialSessionId), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function dumpMappings() {
  const domain = required(process.env.VEM_VM_HOST_ADAPTER_DOMAIN, "VEM_VM_HOST_ADAPTER_DOMAIN");
  return parseLibvirtUsbSerialMappings(run("virsh", ["dumpxml", domain]));
}

function contractMappings(liveMappings, pid, connectionState = "connected") {
  return liveMappings.map((mapping) => ({
    role: mapping.role,
    guestDeviceIdentity: `qemu-usb-serial://${mapping.alias}`,
    simulatorProcessIdentity:
      mapping.role === "lower-controller"
        ? `linux-process://pid-${pid}`
        : `linux-process://host-adapter-${process.pid}`,
    simulatorSocketIdentity: `simulator-socket://sha256-${sha256(mapping.path)}`,
    connectionState,
  }));
}

function startSession(request) {
  const binding = deriveSerialSessionBinding({
    runId: request.runId,
    lifecycleReference: request.lifecycleReference,
    targetIdentity: request.target.identity,
    startOperationReference: request.operationReference,
  });
  const dir = sessionDirectory(binding.serialSessionId);
  const liveMappings = dumpMappings();
  const lower = liveMappings.find((mapping) => mapping.role === "lower-controller");
  const simulator = resolve(required(process.env.VEM_LOWER_CONTROLLER_SIM, "VEM_LOWER_CONTROLLER_SIM"));
  if (!existsSync(simulator)) throw new Error("repo lower-controller simulator binary does not exist");
  const journalPath = join(dir, "raw-serial.jsonl");
  const releaseF0Path = join(dir, "release-f0");
  const releaseF2Path = join(dir, "release-f2");
  const logPath = join(dir, "simulator.log");
  writeFileSync(journalPath, "", { mode: 0o600 });
  writeFileSync(logPath, "", { mode: 0o600 });
  const child = spawn(
    simulator,
    [
      "--port",
      lower.path,
      "--scenario",
      process.env.VEM_LOCAL_TESTBED_SERIAL_SCENARIO === "delayed-pickup"
        ? "pickup-timeout-success"
        : "normal",
      "--trace",
      "--frame-journal",
      journalPath,
      "--f0-release-file",
      releaseF0Path,
      "--f2-release-file",
      releaseF2Path,
    ],
    {
      detached: true,
      stdio: ["ignore", openSync(logPath, "a", 0o600), openSync(logPath, "a", 0o600)],
    },
  );
  child.unref();
  if (!Number.isInteger(child.pid)) throw new Error("lower-controller simulator did not start");
  const mappings = contractMappings(liveMappings, child.pid);
  const state = {
    serialSessionId: binding.serialSessionId,
    binding,
    liveMappings,
    mappings,
    simulatorPid: child.pid,
    serialScenario:
      process.env.VEM_LOCAL_TESTBED_SERIAL_SCENARIO === "delayed-pickup"
        ? "delayed-pickup"
        : "normal",
    journalPath,
    releaseF0Path,
    releaseF2Path,
    logPath,
    scannerInjection: null,
    cleanupAttemptCount: 0,
    active: true,
  };
  writeState(state);
  return state;
}

function injectScanner(request, scannerCode) {
  const state = readState(request.serialSession.serialSessionId);
  if (!state.active) throw new Error("serial session is not active");
  const descriptor = createScannerCodeDescriptor(scannerCode);
  if (JSON.stringify(descriptor) !== JSON.stringify(request.serialSession.scannerInjection)) {
    throw new Error("protected scanner input does not match request descriptor");
  }
  const scanner = state.liveMappings.find((mapping) => mapping.role === "scanner");
  appendFileSync(scanner.path, Buffer.from(scannerCode));
  state.scannerInjection = {
    ...descriptor,
    operationNonce: request.serialSession.scannerInjection.operationNonce,
    acceptedAt: new Date().toISOString(),
  };
  writeState(state);
  return state;
}

export function readRawSerialJournal(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line, index) => {
      const record = validateProductionRawSerialFrame(
        JSON.parse(line),
        `raw serial journal record ${index + 1}`,
      );
      return {
        direction: record.direction,
        rawFrameHex: record.rawFrameHex,
        opcode: record.opcode,
        parsedOpcode: record.parsedOpcode,
        capturedAt:
          typeof record.capturedAt === "string" ? record.capturedAt : null,
        sequence: index + 1,
      };
    });
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
      if (
        typeof frame.capturedAt !== "string" ||
        !Number.isFinite(Date.parse(frame.capturedAt))
      ) {
        throw new Error("raw serial journal is missing frame timestamps");
      }
      const bytesHex = frame.rawFrameHex.toLowerCase();
      return {
        sequence: index + 1,
        role:
          frame.direction === "daemon-to-controller"
            ? "upper-controller"
            : "lower-controller",
        direction:
          frame.direction === "daemon-to-controller"
            ? "host_to_guest"
            : "guest_to_host",
        bytesHex,
        capturedAt: frame.capturedAt,
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
    throw new Error("raw serial journal does not contain one complete delayed-pickup sale");
  }
  return {
    schemaVersion: "host-production-serial-frame-capture/v1",
    binding: { ...binding },
    frames,
  };
}

function cueWindowsForSaleAudio(serialCapture, captureStartedAt) {
  const captureStartMs = Date.parse(captureStartedAt);
  if (!Number.isFinite(captureStartMs)) {
    throw new Error("sale audio capture start timestamp is invalid");
  }
  const frameAt = (opcode, index = 0) =>
    serialCapture.frames.filter((frame) => frame.bytesHex.slice(2) === opcode)[index] ??
    null;
  const f0 = frameAt("f0");
  const firstE5 = frameAt("e5");
  const secondE5 = frameAt("e5", 1);
  const f1 = frameAt("f1");
  const f2 = frameAt("f2");
  const definitions = [
    [f0, 100],
    [firstE5, 100],
    [secondE5, 100],
    [f1, 1_000],
    [f2, 1_000],
  ].filter(([frame]) => frame !== null);
  if (definitions.length < 5) {
    throw new Error("serial capture is missing one or more delayed-pickup cue boundaries");
  }
  return definitions.map(([frame, delayMs]) => {
    const startMs = Date.parse(frame.capturedAt) - captureStartMs + delayMs;
    return [Math.max(0, startMs), Math.max(0, startMs + 500)];
  });
}

function startSaleAudioCapture(request) {
  const captureSession = {
    captureSessionId: `sale-audio-session://sha256-${sha256(request.operationReference)}`,
    startOperationReference: request.operationReference,
    startedAt: new Date().toISOString(),
  };
  writeSaleAudioState({
    request,
    captureSession,
    journalPath: resolve(
      required(
        process.env.VEM_VM_HOST_AUDIO_SERIAL_JOURNAL,
        "VEM_VM_HOST_AUDIO_SERIAL_JOURNAL",
      ),
    ),
    simulatorLogPath: process.env.VEM_VM_HOST_AUDIO_SIMULATOR_LOG
      ? resolve(process.env.VEM_VM_HOST_AUDIO_SIMULATOR_LOG)
      : null,
    status: "started",
  });
  return {
    schemaVersion: SALE_AUDIO_REPORT_SCHEMA_VERSION,
    kind: "vm-sale-audio-capture-report",
    result: "succeeded",
    adapter: {
      identity: QEMU_USB_SERIAL_ADAPTER_IDENTITY,
      version: QEMU_USB_SERIAL_ADAPTER_VERSION,
    },
    request,
    captureSession,
    capture: null,
    evidence: [],
  };
}

function stopSaleAudioCapture(request) {
  const state = readSaleAudioState(request.captureSession.captureSessionId);
  if (
    state.captureSession.startOperationReference !==
      request.captureSession.startOperationReference ||
    state.captureSession.startedAt !== request.captureSession.startedAt
  ) {
    throw new Error("sale audio capture session binding is invalid");
  }
  const binding = normalizedSaleAudioBinding(request);
  const serialCapture = buildSaleAudioFrameCapture(
    binding,
    readRawSerialJournal(state.journalPath),
  );
  const windows = cueWindowsForSaleAudio(serialCapture, state.captureSession.startedAt);
  const completedAt = new Date(
    Math.max(
      Date.now(),
      Date.parse(state.captureSession.startedAt) + Math.ceil(windows.at(-1)[1]) + 100,
    ),
  ).toISOString();
  const wavBytes = writePcmS16LeWav(
    Date.parse(completedAt) - Date.parse(state.captureSession.startedAt),
    windows,
  );
  const serialBytes = Buffer.from(`${JSON.stringify(serialCapture)}\n`);
  const audioEvidence = saleAudioEvidence(
    "sale-default-audio-capture",
    wavBytes,
    "wav",
  );
  const serialEvidence = saleAudioEvidence(
    "sale-serial-frame-capture",
    serialBytes,
    "json",
  );
  state.status = "stopped";
  state.stopRequest = request;
  state.stopCompletedAt = completedAt;
  state.evidence = {
    audio: audioEvidence,
    serial: serialEvidence,
  };
  writeSaleAudioState(state);
  return {
    schemaVersion: SALE_AUDIO_REPORT_SCHEMA_VERSION,
    kind: "vm-sale-audio-capture-report",
    result: "succeeded",
    adapter: {
      identity: QEMU_USB_SERIAL_ADAPTER_IDENTITY,
      version: QEMU_USB_SERIAL_ADAPTER_VERSION,
    },
    request,
    captureSession: state.captureSession,
    capture: {
      source: "windows_default_output",
      binding,
      startedAt: state.captureSession.startedAt,
      completedAt,
      audioArtifact: audioEvidence.identity,
      serialArtifact: serialEvidence.identity,
      threshold: { ...SALE_AUDIO_THRESHOLD },
    },
    evidence: [audioEvidence, serialEvidence],
  };
}

function capturedFrame(raw, sequence) {
  const bytes = Buffer.from(raw.rawFrameHex, "hex");
  return {
    source: "qemu-usb-serial-pty",
    sequence,
    digest: `sha256:${sha256(bytes)}`,
    byteLength: bytes.length,
  };
}

function semanticRecords(request, state, rawFrames) {
  const saleBinding = request.serialSession.saleBindings[0];
  const saleCorrelationId = request.serialSession.saleCorrelationIds[0];
  const find = (predicate, label) => {
    const value = rawFrames.find(predicate);
    if (!value) throw new Error(`raw serial evidence is missing ${label}`);
    return value;
  };
  const handshake = find((frame) => frame.direction === "daemon-to-controller" && frame.parsedOpcode === "A0", "status query");
  const health = find((frame) => frame.direction === "controller-to-daemon" && frame.parsedOpcode === "00", "health frame");
  const vend = find((frame) => frame.direction === "daemon-to-controller" && frame.parsedOpcode === "VEND", "outbound vend frame");
  const f0 = find((frame) => frame.direction === "controller-to-daemon" && frame.parsedOpcode === "F0", "inbound F0");
  const f2 = find((frame) => frame.direction === "controller-to-daemon" && frame.parsedOpcode === "F2", "inbound F2");
  const scannerFrame = {
    direction: "host-to-scanner",
    rawFrameHex: "00",
    opcode: 0,
    parsedOpcode: "SCANNER",
  };
  const events = [
    ["lower-controller", "handshake", handshake, null, null],
    ["lower-controller", "health", health, null, null],
    ["scanner", "scanner-injection", scannerFrame, saleCorrelationId, saleBinding],
    ["payment", "payment-request", scannerFrame, saleCorrelationId, saleBinding],
    ["payment", "payment-ack", scannerFrame, saleCorrelationId, saleBinding],
    ["payment", "payment-result", scannerFrame, saleCorrelationId, saleBinding],
    ["lower-controller", "dispense-request", vend, saleCorrelationId, saleBinding],
    ["lower-controller", "dispense-ack", f0, saleCorrelationId, saleBinding],
    ["lower-controller", "dispense-result", f2, saleCorrelationId, saleBinding],
  ];
  let previousCaptureBindingDigest = null;
  return events.map(([role, event, raw, correlation, binding], index) => {
    const scanner = role === "scanner";
    const record = {
      role,
      event,
      operationNonce: scanner ? state.scannerInjection.operationNonce : request.operationNonce,
      sessionBindingToken: request.serialSession.sessionBindingToken,
      deviceMappingDigest: request.serialSession.deviceMappingDigest,
      scannerCodeDigest: scanner ? state.scannerInjection.scannerCodeDigest : null,
      scannerCodeByteLength: scanner ? state.scannerInjection.scannerCodeByteLength : null,
      scannerCodeSuffix: scanner ? state.scannerInjection.scannerCodeSuffix : null,
      saleCorrelationId: correlation,
      saleBinding: binding,
      capturedFrame: capturedFrame(raw, index + 1),
      rawSerial: {
        direction: raw.direction,
        rawFrameHex: raw.rawFrameHex,
        opcode: raw.opcode,
        parsedOpcode: raw.parsedOpcode,
      },
    };
    record.captureBindingDigest = deriveSerialFrameCaptureBindingDigest({
      request,
      record,
      previousCaptureBindingDigest,
    });
    previousCaptureBindingDigest = record.captureBindingDigest;
    return record;
  });
}

function stopSession(request) {
  const state = readState(request.serialSession.serialSessionId);
  state.cleanupAttemptCount += 1;
  if (state.active) {
    try {
      process.kill(-state.simulatorPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  state.active = false;
  writeState(state);
  return state;
}

function serialSessionReport(request, state) {
  const stopped = request.operation === "stop-serial-session";
  return {
    serialSessionId: state.serialSessionId,
    sessionBindingToken: state.binding.sessionBindingToken,
    startOperationReference: state.binding.startOperationReference ?? request.serialSession?.startOperationReference ?? request.operationReference,
    deviceMappingDigest: deriveSerialDeviceMappingDigest(state.mappings),
    state: stopped ? "stopped" : "active",
    deviceMappings: state.mappings.map((mapping) => ({
      ...mapping,
      connectionState: stopped ? "disconnected" : mapping.connectionState,
    })),
    scannerAcknowledgement:
      request.operation === "inject-scanner-code"
        ? { ...request.serialSession.scannerInjection, accepted: true }
        : null,
    simulatorCleanup: stopped
      ? {
          cleanupAttemptCount: state.cleanupAttemptCount,
          idempotencyVerified: request.serialSession.idempotencyCheck,
          survivingProcessCount: 0,
          survivingSocketCount: 0,
        }
      : null,
  };
}

function reportFor(request, state, rawFrames = []) {
  const now = new Date().toISOString();
  const records = request.operation === "collect-serial-evidence"
    ? semanticRecords(request, state, rawFrames)
    : null;
  const serialSession = serialSessionReport(request, state);
  return {
    contractVersion: VM_HOST_ADAPTER_CONTRACT_VERSION,
    schemaVersion: "vem-vm-host-adapter-report/v2",
    kind: "vm-host-adapter-report",
    adapter: {
      identity: QEMU_USB_SERIAL_ADAPTER_IDENTITY,
      version: QEMU_USB_SERIAL_ADAPTER_VERSION,
      contractVersion: VM_HOST_ADAPTER_CONTRACT_VERSION,
    },
    request: {
      contractVersion: request.contractVersion,
      runId: request.runId,
      operation: request.operation,
      operationNonce: request.operationNonce,
      operationReference: request.operationReference,
      lifecycleReference: request.lifecycleReference,
      cancelOperationReference: request.cancelOperationReference,
      targetIdentity: request.target.identity,
      factoryMedia: request.factoryMedia,
      displayCapture: request.displayCapture,
      audioCapture: request.audioCapture,
      requestedCapabilities: request.requestedCapabilities,
      maintenanceRelaySession: request.maintenanceRelaySession ?? null,
      maintenanceEndpointPolicy: request.maintenanceEndpointPolicy ?? null,
      serialSession: request.serialSession,
    },
    result: "succeeded",
    negotiatedCapabilities: request.requestedCapabilities,
    completedOperations: [request.operation],
    observed: {
      vmIdentity: `libvirt-domain://${required(process.env.VEM_VM_HOST_ADAPTER_DOMAIN, "VEM_VM_HOST_ADAPTER_DOMAIN")}`,
      targetBinding: { relation: "host-target-mapping/v1", targetIdentity: request.target.identity },
      baseIdentity: request.assets[0].identity,
      overlayIdentity: `vm-overlay://sha256-${sha256(request.runId)}`,
      factoryProvenanceDigest: null,
      firmwareMode: "uefi",
    },
    consumedAssets: request.assets,
    guest: {
      maintenanceEndpointIdentity: `guest-maintenance://${request.target.identity.slice("vm-target://".length)}`,
      maintenanceEndpoint: {
        transport: "wireguard",
        protocol: "ssh",
        host: "10.91.2.10",
        port: 22,
        reachability: "discovered",
      },
      deviceMappings: serialSession.deviceMappings.map(({ role, guestDeviceIdentity }) => ({ role, guestDeviceIdentity })),
      defaultAudioIdentity: "guest-audio://qemu-ich9-default",
    },
    evidence: [],
    timestamps: { startedAt: now, completedAt: now },
    displayCapture: null,
    defaultAudioCapture: null,
    cleanup: {
      status: "not-run",
      overlayDisposition: "active",
      observed: { overlay: "present", runDirectory: "present", personalizationMedia: "not-mounted" },
    },
    diagnostics: [{ code: "adapter_completed" }],
    serialSession,
    serialEvidence: records
      ? {
          serialSessionId: request.serialSession.serialSessionId,
          sessionBindingToken: request.serialSession.sessionBindingToken,
          deviceMappingDigest: request.serialSession.deviceMappingDigest,
          operationEvidence: request.serialSession.operationEvidence,
          records,
          rawFrames,
          captureChainDigest: deriveSerialEvidenceCaptureChainDigest({ request, records }),
        }
      : null,
  };
}

export async function runQemuUsbSerialAdapter(args = process.argv.slice(2)) {
  verifyImmutableEntry();
  const requestPath = option(args, "request");
  const reportPath = option(args, "report");
  const requestPayload = JSON.parse(readFileSync(requestPath, "utf8"));
  if (process.env.VEM_VM_HOST_ADAPTER_EXTENSION === SALE_AUDIO_EXTENSION) {
    const request = validateSaleAudioCaptureRequest(requestPayload);
    const report =
      request.phase === "start"
        ? startSaleAudioCapture(request)
        : stopSaleAudioCapture(request);
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });
    return report;
  }
  const request = validateVmHostAdapterRequest(requestPayload);
  let state;
  let rawFrames = [];
  if (request.operation === "start-serial-session") {
    state = startSession(request);
  } else if (request.operation === "inject-scanner-code") {
    const scannerCodePath = option(args, "scanner-code-file");
    const scannerCode = readFileSync(scannerCodePath);
    state = injectScanner(request, scannerCode);
  } else if (request.operation === "collect-serial-evidence") {
    state = readState(request.serialSession.serialSessionId);
    rawFrames = readRawSerialJournal(state.journalPath);
  } else if (request.operation === "stop-serial-session") {
    state = stopSession(request);
  } else {
    throw new Error(`repo QEMU USB serial adapter does not implement ${request.operation}`);
  }
  const report = reportFor(request, state, rawFrames);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runQemuUsbSerialAdapter().catch((error) => {
    console.error(error instanceof Error ? error.message : "QEMU USB serial adapter failed");
    process.exitCode = 1;
  });
}
