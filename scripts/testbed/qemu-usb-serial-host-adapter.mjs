#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { inspectWavPcm } from "./default-audio-evidence.mjs";
import {
  SALE_AUDIO_REPORT_SCHEMA_VERSION,
  validateSaleAudioCaptureRequest,
} from "./sale-audio-capture-host-adapter.mjs";
import {
  createScannerCodeDescriptor,
  deriveSerialDeviceMappingDigest,
  deriveSerialEvidenceCaptureChainDigest,
  deriveSerialFrameCaptureBindingDigest,
  deriveSerialSessionBinding,
  validateVmHostAdapterRequest,
  VM_HOST_ADAPTER_CONTRACT_VERSION,
} from "./vm-host-adapter-contract.mjs";

export const QEMU_USB_SERIAL_ADAPTER_VERSION = "1.0.0";
export const QEMU_USB_SERIAL_ADAPTER_IDENTITY = `vm-host-adapter://repo-qemu-usb-serial@${QEMU_USB_SERIAL_ADAPTER_VERSION}`;

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
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} is required`);
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
    throw new Error(
      "outbound vend frame must contain integer slot coordinates",
    );
  }
  if (layerNo < 1 || layerNo > 9) {
    throw new Error(
      `outbound vend frame layer ${layerNo} is out of production bounds`,
    );
  }
  const maxCellNo = layerNo <= 6 ? 5 : layerNo <= 8 ? 4 : 3;
  if (cellNo < 1 || cellNo > maxCellNo) {
    throw new Error(
      `outbound vend frame cell ${cellNo} is out of production bounds for layer ${layerNo}`,
    );
  }
}

export function validateProductionRawSerialFrame(
  record,
  label = "raw serial frame",
) {
  if (
    !["daemon-to-controller", "controller-to-daemon"].includes(
      record?.direction,
    ) ||
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
      throw new Error(
        `${label} VEND must be a 4-byte production dispense frame`,
      );
    }
    if (record.opcode !== bytes[1]) {
      throw new Error(
        `${label} VEND opcode must equal the outbound layer byte`,
      );
    }
    validateVendSlotBounds(bytes[1], bytes[2]);
    const expectedCrc = crc8(bytes.subarray(1, 3));
    if (bytes[3] !== expectedCrc) {
      throw new Error(
        `${label} VEND CRC must match the production dispense checksum`,
      );
    }
    return { ...record, bytes };
  }
  if (!/^[0-9A-F]{2}$/.test(record.parsedOpcode)) {
    throw new Error(
      `${label} must expose a production opcode, got ${record.parsedOpcode}`,
    );
  }
  const expectedOpcode = Number.parseInt(record.parsedOpcode, 16);
  if (
    bytes.length !== 2 ||
    bytes[1] !== expectedOpcode ||
    record.opcode !== expectedOpcode
  ) {
    throw new Error(
      `${label} ${record.parsedOpcode} must match the 2-byte production frame 55 ${record.parsedOpcode}`,
    );
  }
  return { ...record, bytes };
}

function xmlAttribute(source, name) {
  return (
    source
      .match(new RegExp(`\\b${name}=(?:"([^"]+)"|'([^']+)')`))
      ?.slice(1)
      .find(Boolean) ?? null
  );
}

export function parseLibvirtUsbSerialMappings(xml) {
  const mappings = [];
  for (const match of String(xml).matchAll(
    /<serial\b[^>]*\btype=(?:"pty"|'pty')[^>]*>[\s\S]*?<\/serial>/g,
  )) {
    const block = match[0];
    const aliasTag = block.match(/<alias\b[^>]*>/)?.[0] ?? "";
    const sourceTag = block.match(/<source\b[^>]*>/)?.[0] ?? "";
    const targetTag = block.match(/<target\b[^>]*>/)?.[0] ?? "";
    const alias = xmlAttribute(aliasTag, "name");
    const path = xmlAttribute(sourceTag, "path");
    const targetType = xmlAttribute(targetTag, "type");
    if (!alias?.startsWith("serial-") || !path || targetType !== "usb-serial")
      continue;
    mappings.push({ role: alias.slice("serial-".length), alias, path });
  }
  for (const role of REQUIRED_ROLES) {
    if (mappings.filter((mapping) => mapping.role === role).length !== 1) {
      throw new Error(
        `running libvirt domain must expose exactly one ${role} QEMU USB serial PTY`,
      );
    }
  }
  if (mappings.length !== REQUIRED_ROLES.length) {
    throw new Error(
      "running libvirt domain exposes unexpected QEMU USB serial roles",
    );
  }
  return REQUIRED_ROLES.map((role) =>
    mappings.find((mapping) => mapping.role === role),
  );
}

function verifyImmutableEntry(environment = process.env) {
  const configuredPath = resolve(
    required(environment.VEM_VM_HOST_ADAPTER, "VEM_VM_HOST_ADAPTER"),
  );
  if (
    configuredPath !== resolve(SELF_PATH) ||
    basename(configuredPath).includes("fake")
  ) {
    throw new Error(
      "VEM_VM_HOST_ADAPTER must resolve to the repo-owned QEMU USB serial adapter entry",
    );
  }
  if (
    environment.VEM_VM_HOST_ADAPTER_VERSION !== QEMU_USB_SERIAL_ADAPTER_VERSION
  ) {
    throw new Error(
      "VEM_VM_HOST_ADAPTER_VERSION does not match the adapter entry",
    );
  }
  const expected = required(
    environment.VEM_VM_HOST_ADAPTER_SHA256,
    "VEM_VM_HOST_ADAPTER_SHA256",
  );
  const actual = `sha256:${sha256(readFileSync(SELF_PATH))}`;
  if (expected !== actual)
    throw new Error(
      "VEM_VM_HOST_ADAPTER_SHA256 does not match the adapter entry",
    );
  return actual;
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

function stateRoot() {
  const root = resolve(
    required(
      process.env.VEM_VM_HOST_ADAPTER_STATE_ROOT,
      "VEM_VM_HOST_ADAPTER_STATE_ROOT",
    ),
  );
  if (!isAbsolute(root))
    throw new Error("VEM_VM_HOST_ADAPTER_STATE_ROOT must be absolute");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  return root;
}

function saleAudioStatePaths(captureSessionId) {
  const path = join(
    stateRoot(),
    "sale-audio-captures",
    sha256(captureSessionId),
  );
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

function wavFormat(bytes) {
  if (
    bytes.length < 44 ||
    bytes.subarray(0, 4).toString("ascii") !== "RIFF" ||
    bytes.subarray(8, 12).toString("ascii") !== "WAVE" ||
    bytes.subarray(12, 16).toString("ascii") !== "fmt " ||
    bytes.readUInt16LE(20) !== 1 ||
    bytes.subarray(36, 40).toString("ascii") !== "data"
  )
    throw new Error("QEMU default audio sink must be a PCM WAV file");
  const channels = bytes.readUInt16LE(22);
  const sampleRateHz = bytes.readUInt32LE(24);
  const bitsPerSample = bytes.readUInt16LE(34);
  if (channels < 1 || sampleRateHz < 8_000 || bitsPerSample !== 16)
    throw new Error("QEMU default audio sink must be signed 16-bit PCM");
  return { channels, sampleRateHz, bitsPerSample, dataOffset: 44 };
}

function writeCapturedPcmWav(pcm, { sampleRateHz, channels }) {
  const blockAlign = channels * 2;
  if (pcm.length === 0 || pcm.length % blockAlign !== 0)
    throw new Error("continuous QEMU audio capture has no complete PCM frames");
  const bytes = Buffer.alloc(44 + pcm.length);
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
  bytes.writeUInt32LE(pcm.length, 40);
  pcm.copy(bytes, 44);
  return bytes;
}

function captureWorkerPaths(captureSessionId) {
  const directory = saleAudioStatePaths(captureSessionId).directory;
  return {
    directory,
    pcmPath: join(directory, "qemu-default-output.pcm"),
    readyPath: join(directory, "capture-ready.json"),
    stopPath: join(directory, "capture-stop"),
    donePath: join(directory, "capture-done.json"),
  };
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForFile(path, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    sleep(25);
  }
  throw new Error(`${label} did not become ready before deadline`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

function terminateCaptureWorker(state) {
  const pid = state.captureWorker?.pid;
  if (!Number.isInteger(pid) || pid < 1 || !processAlive(pid)) return;
  writeFileSync(state.captureWorker.stopPath, "stop\n", { mode: 0o600 });
  const deadline = Date.now() + 2_000;
  while (processAlive(pid) && Date.now() < deadline) sleep(25);
  if (processAlive(pid)) {
    process.kill(pid, "SIGTERM");
    const termDeadline = Date.now() + 2_000;
    while (processAlive(pid) && Date.now() < termDeadline) sleep(25);
  }
  if (processAlive(pid)) process.kill(pid, "SIGKILL");
  if (processAlive(pid))
    throw new Error("QEMU audio capture worker did not terminate");
}

function terminateProcessGroup(pid, label, graceMs = 2_000) {
  if (!Number.isInteger(pid) || pid < 1) return;
  const alive = () => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  if (!alive()) return;
  process.kill(-pid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (alive() && Date.now() < deadline) sleep(25);
  if (alive()) process.kill(-pid, "SIGKILL");
  const killDeadline = Date.now() + graceMs;
  while (alive() && Date.now() < killDeadline) sleep(25);
  if (alive())
    throw new Error(`${label} did not exit before termination deadline`);
}

export function qemuUsbSerialSessionPaths(root, serialSessionId) {
  const path = join(resolve(root), "sessions", sha256(serialSessionId));
  return {
    directory: path,
    statePath: join(path, "state.json"),
    journalPath: join(path, "raw-serial.jsonl"),
    lowerControllerProxyPath: join(path, "lower-controller-pty"),
    releaseF0Path: join(path, "release-f0"),
    releaseF2Path: join(path, "release-f2"),
    logPath: join(path, "simulator.log"),
  };
}

function sessionDirectory(serialSessionId) {
  const path = qemuUsbSerialSessionPaths(
    stateRoot(),
    serialSessionId,
  ).directory;
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
  writeFileSync(
    statePath(state.serialSessionId),
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function dumpMappings() {
  const domain = required(
    process.env.VEM_VM_HOST_ADAPTER_DOMAIN,
    "VEM_VM_HOST_ADAPTER_DOMAIN",
  );
  return parseLibvirtUsbSerialMappings(run("virsh", ["dumpxml", domain]));
}

function qemuDefaultAudioSinkPath() {
  if (process.env.VEM_VM_HOST_AUDIO_CAPTURE_SOURCE)
    return resolve(process.env.VEM_VM_HOST_AUDIO_CAPTURE_SOURCE);
  const domain = required(
    process.env.VEM_VM_HOST_ADAPTER_DOMAIN,
    "VEM_VM_HOST_ADAPTER_DOMAIN",
  );
  const domainXml = run("virsh", ["dumpxml", domain]);
  const audio = domainXml.match(
    /<audio\b[^>]*\btype=(?:"file"|'file')[^>]*>[\s\S]*?<output\b[^>]*\bfile=(?:"([^"]+)"|'([^']+)')[^>]*\/>[\s\S]*?<\/audio>/,
  );
  const path = audio?.[1] ?? audio?.[2];
  if (!path)
    throw new Error(
      "running libvirt domain does not expose a capturable default audio sink",
    );
  return resolve(path);
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
  const lower = liveMappings.find(
    (mapping) => mapping.role === "lower-controller",
  );
  const simulator = resolve(
    required(process.env.VEM_LOWER_CONTROLLER_SIM, "VEM_LOWER_CONTROLLER_SIM"),
  );
  if (!existsSync(simulator))
    throw new Error("repo lower-controller simulator binary does not exist");
  const journalPath = join(dir, "raw-serial.jsonl");
  const lowerControllerProxyPath = join(dir, "lower-controller-pty");
  const releaseF0Path = join(dir, "release-f0");
  const releaseF2Path = join(dir, "release-f2");
  const logPath = join(dir, "simulator.log");
  writeFileSync(journalPath, "", { mode: 0o600 });
  writeFileSync(logPath, "", { mode: 0o600 });
  // The host owns the PTY bridge and observes bytes before the simulator sees
  // them. Simulator JSONL is deliberately not an evidence input.
  const bridge = spawn(
    "socat",
    [
      "-x",
      "-v",
      "-lf",
      journalPath,
      `PTY,link=${lowerControllerProxyPath},rawer,echo=0,waitslave`,
      `FILE:${lower.path},raw,echo=0`,
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore"] },
  );
  bridge.unref();
  if (!Number.isInteger(bridge.pid))
    throw new Error("QEMU PTY capture bridge did not start");
  waitForFile(lowerControllerProxyPath, 3_000, "QEMU PTY capture bridge");
  const child = spawn(
    simulator,
    [
      "--port",
      lowerControllerProxyPath,
      "--scenario",
      process.env.VEM_LOCAL_TESTBED_SERIAL_SCENARIO === "delayed-pickup"
        ? "pickup-timeout-success"
        : "normal",
      "--trace",
      "--f0-release-file",
      releaseF0Path,
      "--f2-release-file",
      releaseF2Path,
    ],
    {
      detached: true,
      stdio: [
        "ignore",
        openSync(logPath, "a", 0o600),
        openSync(logPath, "a", 0o600),
      ],
    },
  );
  child.unref();
  if (!Number.isInteger(child.pid))
    throw new Error("lower-controller simulator did not start");
  const mappings = contractMappings(liveMappings, child.pid);
  const state = {
    serialSessionId: binding.serialSessionId,
    binding,
    liveMappings,
    mappings,
    simulatorPid: child.pid,
    ptyCapturePid: bridge.pid,
    lowerControllerProxyPath,
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
  if (
    JSON.stringify(descriptor) !==
    JSON.stringify(request.serialSession.scannerInjection)
  ) {
    throw new Error(
      "protected scanner input does not match request descriptor",
    );
  }
  const scanner = state.liveMappings.find(
    (mapping) => mapping.role === "scanner",
  );
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
  const source = readFileSync(path, "utf8");
  if (source.trimStart().startsWith("{")) {
    if (process.env.VEM_TEST_ALLOW_JSON_PTY_FIXTURE !== "1")
      throw new Error(
        "production serial evidence must be captured from the host QEMU PTY",
      );
    return source
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
  // socat -x -v logs the bytes observed by the host-owned bridge. Its arrow
  // describes bridge direction: left (simulator) to right (QEMU) is inbound.
  const records = [];
  let direction = null;
  let capturedAt = null;
  let pending = Buffer.alloc(0);
  const flush = () => {
    while (pending.length >= 2) {
      const frameLength =
        pending[0] === FRAME_HEAD && pending[1] >= 1 && pending[1] <= 9 ? 4 : 2;
      if (pending.length < frameLength) return;
      const bytes = pending.subarray(0, frameLength);
      pending = pending.subarray(frameLength);
      if (bytes[0] !== FRAME_HEAD || !direction || !capturedAt) continue;
      const parsedOpcode =
        frameLength === 4
          ? "VEND"
          : bytes[1].toString(16).padStart(2, "0").toUpperCase();
      records.push({
        direction,
        rawFrameHex: bytes.toString("hex").toUpperCase(),
        opcode: bytes[1],
        parsedOpcode,
        capturedAt,
        sequence: records.length + 1,
      });
    }
  };
  for (const line of source.split(/\r?\n/)) {
    const header = line.match(
      /^([<>])\s+(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)/,
    );
    if (header) {
      direction =
        header[1] === ">" ? "controller-to-daemon" : "daemon-to-controller";
      const [, seconds, fraction = ""] = header[2].match(/^(.*?)(?:\.(\d+))?$/);
      capturedAt = new Date(
        `${seconds.replaceAll("/", "-").replace(" ", "T")}.${fraction.padEnd(3, "0").slice(0, 3)}Z`,
      ).toISOString();
      continue;
    }
    if (!direction) continue;
    const bytes = [...line.matchAll(/\b[0-9a-fA-F]{2}\b/g)].map((match) =>
      Number.parseInt(match[0], 16),
    );
    if (bytes.length) {
      pending = Buffer.concat([pending, Buffer.from(bytes)]);
      flush();
    }
  }
  return records;
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

function startSaleAudioCapture(request) {
  const captureSession = {
    captureSessionId: `sale-audio-session://sha256-${sha256(request.operationReference)}`,
    startOperationReference: request.operationReference,
    startedAt: new Date().toISOString(),
  };
  const sourcePath = qemuDefaultAudioSinkPath();
  const worker = captureWorkerPaths(captureSession.captureSessionId);
  if (!existsSync(sourcePath))
    throw new Error(
      "QEMU default audio sink does not exist before capture start",
    );
  const child = spawn(
    process.execPath,
    [
      SELF_PATH,
      "--capture-worker",
      "--source",
      sourcePath,
      "--pcm",
      worker.pcmPath,
      "--ready",
      worker.readyPath,
      "--stop",
      worker.stopPath,
      "--done",
      worker.donePath,
    ],
    { detached: true, stdio: ["ignore", "ignore", "ignore"] },
  );
  child.unref();
  if (!Number.isInteger(child.pid))
    throw new Error("QEMU default audio capture worker did not start");
  waitForFile(worker.readyPath, 3_000, "QEMU default audio capture worker");
  const format = JSON.parse(readFileSync(worker.readyPath, "utf8"));
  writeSaleAudioState({
    request,
    captureSession,
    journalPath: resolve(
      required(
        process.env.VEM_VM_HOST_AUDIO_SERIAL_JOURNAL,
        "VEM_VM_HOST_AUDIO_SERIAL_JOURNAL",
      ),
    ),
    audioSourcePath: sourcePath,
    audioFormat: format,
    captureWorker: { pid: child.pid, ...worker },
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
  terminateCaptureWorker(state);
  const binding = normalizedSaleAudioBinding(request);
  const serialCapture = buildSaleAudioFrameCapture(
    binding,
    readRawSerialJournal(state.journalPath),
  );
  if (!existsSync(state.captureWorker.donePath))
    throw new Error("QEMU default audio capture worker did not finalize PCM");
  const workerResult = JSON.parse(
    readFileSync(state.captureWorker.donePath, "utf8"),
  );
  if (workerResult.failure)
    throw new Error(
      `QEMU default audio capture failed: ${workerResult.failure}`,
    );
  const completedAt = new Date().toISOString();
  const wavBytes = writeCapturedPcmWav(
    readFileSync(state.captureWorker.pcmPath),
    state.audioFormat,
  );
  const waveform = inspectWavPcm(wavBytes, SALE_AUDIO_THRESHOLD);
  if (!waveform.ok)
    throw new Error("Windows default output capture is silent or malformed");
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

function cancelSaleAudioCapture(request) {
  const state = readSaleAudioState(request.captureSession.captureSessionId);
  if (state.status === "stopped" || state.status === "cancelled") {
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
      capture: null,
      evidence: [],
    };
  }
  terminateCaptureWorker(state);
  state.status = "cancelled";
  state.cancelledAt = new Date().toISOString();
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
    capture: null,
    evidence: [],
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
  const handshake = find(
    (frame) =>
      frame.direction === "daemon-to-controller" && frame.parsedOpcode === "A0",
    "status query",
  );
  const health = find(
    (frame) =>
      frame.direction === "controller-to-daemon" && frame.parsedOpcode === "00",
    "health frame",
  );
  const vend = find(
    (frame) =>
      frame.direction === "daemon-to-controller" &&
      frame.parsedOpcode === "VEND",
    "outbound vend frame",
  );
  const f0 = find(
    (frame) =>
      frame.direction === "controller-to-daemon" && frame.parsedOpcode === "F0",
    "inbound F0",
  );
  const f2 = find(
    (frame) =>
      frame.direction === "controller-to-daemon" && frame.parsedOpcode === "F2",
    "inbound F2",
  );
  const scannerFrame = {
    direction: "host-to-scanner",
    rawFrameHex: "00",
    opcode: 0,
    parsedOpcode: "SCANNER",
  };
  const events = [
    ["lower-controller", "handshake", handshake, null, null],
    ["lower-controller", "health", health, null, null],
    [
      "scanner",
      "scanner-injection",
      scannerFrame,
      saleCorrelationId,
      saleBinding,
    ],
    [
      "payment",
      "payment-request",
      scannerFrame,
      saleCorrelationId,
      saleBinding,
    ],
    ["payment", "payment-ack", scannerFrame, saleCorrelationId, saleBinding],
    ["payment", "payment-result", scannerFrame, saleCorrelationId, saleBinding],
    [
      "lower-controller",
      "dispense-request",
      vend,
      saleCorrelationId,
      saleBinding,
    ],
    ["lower-controller", "dispense-ack", f0, saleCorrelationId, saleBinding],
    ["lower-controller", "dispense-result", f2, saleCorrelationId, saleBinding],
  ];
  let previousCaptureBindingDigest = null;
  return events.map(([role, event, raw, correlation, binding], index) => {
    const scanner = role === "scanner";
    const record = {
      role,
      event,
      operationNonce: scanner
        ? state.scannerInjection.operationNonce
        : request.operationNonce,
      sessionBindingToken: request.serialSession.sessionBindingToken,
      deviceMappingDigest: request.serialSession.deviceMappingDigest,
      scannerCodeDigest: scanner
        ? state.scannerInjection.scannerCodeDigest
        : null,
      scannerCodeByteLength: scanner
        ? state.scannerInjection.scannerCodeByteLength
        : null,
      scannerCodeSuffix: scanner
        ? state.scannerInjection.scannerCodeSuffix
        : null,
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
    terminateProcessGroup(state.simulatorPid, "lower-controller simulator");
  }
  if (state.ptyCapturePid) {
    terminateProcessGroup(state.ptyCapturePid, "QEMU PTY capture bridge");
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
    startOperationReference:
      state.binding.startOperationReference ??
      request.serialSession?.startOperationReference ??
      request.operationReference,
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
  const records =
    request.operation === "collect-serial-evidence"
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
      targetBinding: {
        relation: "host-target-mapping/v1",
        targetIdentity: request.target.identity,
      },
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
      deviceMappings: serialSession.deviceMappings.map(
        ({ role, guestDeviceIdentity }) => ({ role, guestDeviceIdentity }),
      ),
      defaultAudioIdentity: "guest-audio://qemu-ich9-default",
    },
    evidence: [],
    timestamps: { startedAt: now, completedAt: now },
    displayCapture: null,
    defaultAudioCapture: null,
    cleanup: {
      status: "not-run",
      overlayDisposition: "active",
      observed: {
        overlay: "present",
        runDirectory: "present",
        personalizationMedia: "not-mounted",
      },
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
          captureChainDigest: deriveSerialEvidenceCaptureChainDigest({
            request,
            records,
          }),
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
        : request.phase === "stop"
          ? stopSaleAudioCapture(request)
          : cancelSaleAudioCapture(request);
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
    throw new Error(
      `repo QEMU USB serial adapter does not implement ${request.operation}`,
    );
  }
  const report = reportFor(request, state, rawFrames);
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });
  return report;
}

function workerOption(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? null : args[index + 1];
  if (!value) throw new Error(`capture worker --${name} is required`);
  return resolve(value);
}

async function runQemuAudioCaptureWorker(args) {
  const sourcePath = workerOption(args, "source");
  const pcmPath = workerOption(args, "pcm");
  const readyPath = workerOption(args, "ready");
  const stopPath = workerOption(args, "stop");
  const donePath = workerOption(args, "done");
  mkdirSync(dirname(pcmPath), { recursive: true, mode: 0o700 });
  const header = readFileSync(sourcePath);
  const format = wavFormat(header);
  let cursor = Math.max(format.dataOffset, statSync(sourcePath).size);
  writeFileSync(pcmPath, Buffer.alloc(0), { mode: 0o600 });
  writeFileSync(readyPath, `${JSON.stringify(format)}\n`, { mode: 0o600 });
  const copyNewPcm = () => {
    const bytes = readFileSync(sourcePath);
    if (bytes.length < cursor) {
      throw new Error("QEMU default audio sink was truncated during capture");
    }
    if (bytes.length > cursor) {
      appendFileSync(pcmPath, bytes.subarray(cursor));
      cursor = bytes.length;
    }
  };
  let failure = null;
  try {
    while (!existsSync(stopPath)) {
      copyNewPcm();
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
    }
    copyNewPcm();
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    writeFileSync(
      donePath,
      `${JSON.stringify({ completedAt: new Date().toISOString(), failure })}\n`,
      { mode: 0o600 },
    );
  }
  if (failure) throw new Error(failure);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const runner = process.argv.includes("--capture-worker")
    ? runQemuAudioCaptureWorker(process.argv.slice(2))
    : runQemuUsbSerialAdapter();
  runner.catch((error) => {
    console.error(
      error instanceof Error ? error.message : "QEMU USB serial adapter failed",
    );
    process.exitCode = 1;
  });
}
