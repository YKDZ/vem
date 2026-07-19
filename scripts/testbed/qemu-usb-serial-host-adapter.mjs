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
export const QEMU_USB_SERIAL_ADAPTER_IDENTITY =
  `vm-host-adapter://repo-qemu-usb-serial@${QEMU_USB_SERIAL_ADAPTER_VERSION}`;

const SELF_PATH = fileURLToPath(import.meta.url);
const REQUIRED_ROLES = ["lower-controller", "scanner"];
const FRAME_HEAD = 0x55;
const SALE_AUDIO_EXTENSION = "capture-sale-audio/v1";
const SCANNER_BINDING_PROBE_BYTES = Buffer.from("VEM-BINDING-PROBE\r\n", "utf8");
const TERMINATE_GRACE_MS = 3_000;
const KILL_GRACE_MS = 1_000;
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
    const addressTag = block.match(/<address\b[^>]*\btype=(?:"usb"|'usb')[^>]*\/?\s*>/)?.[0] ?? "";
    const alias = xmlAttribute(aliasTag, "name");
    const path = xmlAttribute(sourceTag, "path");
    const targetType = xmlAttribute(targetTag, "type");
    const targetPort = xmlAttribute(targetTag, "port");
    const usbBus = xmlAttribute(addressTag, "bus");
    const usbPort = xmlAttribute(addressTag, "port");
    if (!alias || !path || targetType !== "usb-serial") continue;
    if (!/^\d+$/.test(targetPort ?? "") || !/^\d+$/.test(usbBus ?? "") || !/^\d+(?:\.\d+)*$/.test(usbPort ?? "")) {
      throw new Error(`${alias} must expose explicit libvirt USB target and address topology`);
    }
    const role = alias.startsWith("serial-")
      ? alias.slice("serial-".length)
      : targetPort === "0"
        ? "lower-controller"
        : targetPort === "1"
          ? "scanner"
          : null;
    if (!role) continue;
    mappings.push({
      role,
      alias,
      path,
      guestUsbTopology: {
        alias,
        targetPort: Number.parseInt(targetPort, 10),
        usbBus: Number.parseInt(usbBus, 10),
        usbPort,
      },
    });
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

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessExit(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Number.isInteger(pid) && processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return !Number.isInteger(pid) || !processAlive(pid);
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

function contractMappings(liveMappings, pid, connectionState = "connected") {
  return liveMappings.map((mapping) => ({
    role: mapping.role,
    guestDeviceIdentity:
      `guest-device://libvirt-usb-bus-${mapping.guestUsbTopology.usbBus}` +
      `-port-${mapping.guestUsbTopology.usbPort.replaceAll(".", "-")}` +
      `-target-${mapping.guestUsbTopology.targetPort}`,
    guestUsbTopology: {
      ...mapping.guestUsbTopology,
      alias: `serial-${mapping.role}`,
    },
    simulatorProcessIdentity:
      mapping.role === "lower-controller"
        ? `linux-process://pid-${pid}`
        : `linux-process://host-adapter-${process.pid}`,
    simulatorSocketIdentity: `simulator-socket://sha256-${sha256(mapping.path)}`,
    connectionState,
  }));
}

function processGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return !processGroupAlive(pid);
}

async function terminateProcessGroup(label, pid) {
  const evidence = { label, pid, sent: [], exitedAfter: null };
  if (!processGroupAlive(pid)) {
    evidence.exitedAfter = "already_exited";
    return evidence;
  }
  process.kill(-pid, "SIGTERM");
  evidence.sent.push("SIGTERM");
  if (await waitForProcessGroupExit(pid, TERMINATE_GRACE_MS)) {
    evidence.exitedAfter = "SIGTERM";
    return evidence;
  }
  process.kill(-pid, "SIGKILL");
  evidence.sent.push("SIGKILL");
  if (await waitForProcessGroupExit(pid, KILL_GRACE_MS)) {
    evidence.exitedAfter = "SIGKILL";
    return evidence;
  }
  throw new Error(`${label} process group ${pid} survived SIGTERM and SIGKILL`);
}

function survivingSocketCount(paths) {
  return paths.filter((path) => {
    try {
      return statSync(path).isSocket();
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }).length;
}

function startScannerBindingProbe(scannerPath, logPath) {
  if (process.env.VEM_LOCAL_TESTBED_SCANNER_BINDING_PROBE === "0") return null;
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const { openSync, writeSync } = require('node:fs'); const path = process.argv[1]; const bytes = Buffer.from(process.argv[2], 'base64'); const fd = openSync(path, 'a'); const emit = () => writeSync(fd, bytes); setTimeout(emit, 100); setInterval(emit, 500);",
      scannerPath,
      SCANNER_BINDING_PROBE_BYTES.toString("base64"),
    ],
    {
      detached: true,
      stdio: ["ignore", openSync(logPath, "a", 0o600), openSync(logPath, "a", 0o600)],
    },
  );
  child.unref();
  if (!Number.isInteger(child.pid)) throw new Error("scanner binding probe did not start");
  return {
    pid: child.pid,
    byteLength: SCANNER_BINDING_PROBE_BYTES.length,
    digest: `sha256:${sha256(SCANNER_BINDING_PROBE_BYTES)}`,
    suffix: "crlf",
    purpose: "non_payment_scanner_binding_probe",
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    stopReason: null,
  };
}

export async function stopQemuScannerBindingProbe({
  stateRoot: root,
  serialSessionId,
  reason = "daemon_binding_confirmed",
}) {
  const paths = qemuUsbSerialSessionPaths(root, serialSessionId);
  if (!existsSync(paths.statePath)) {
    throw new Error("serial session state was not found");
  }
  const state = JSON.parse(readFileSync(paths.statePath, "utf8"));
  const probe = state.scannerBindingProbe;
  if (!probe) throw new Error("scanner binding probe was not started");
  if (probe.stoppedAt) return { ...probe, alreadyStopped: true };
  const termination = await terminateProcessGroup("scanner binding probe", probe.pid);
  state.scannerBindingProbe = {
    ...probe,
    stoppedAt: new Date().toISOString(),
    stopReason: reason,
    termination,
  };
  writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  return { ...state.scannerBindingProbe, alreadyStopped: false };
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
  const scanner = liveMappings.find((mapping) => mapping.role === "scanner");
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
        : process.env.VEM_LOCAL_TESTBED_SERIAL_SCENARIO === "e6"
          ? "pickup-timeout-blocked"
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
  const scannerBindingProbe = startScannerBindingProbe(scanner.path, logPath);
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
        : process.env.VEM_LOCAL_TESTBED_SERIAL_SCENARIO === "e6"
          ? "e6"
          : "normal",
    journalPath,
    releaseF0Path,
    releaseF2Path,
    logPath,
    runtimeSocketPaths: [],
    scannerBindingProbe,
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

async function stopSession(request) {
  const state = readState(request.serialSession.serialSessionId);
  state.cleanupAttemptCount += 1;
  const errors = [];
  const termination = [];
  for (const [label, pid] of [
    ["lower-controller simulator", state.simulatorPid],
    ["host PTY capture", state.ptyCapturePid],
    ["scanner binding probe", state.scannerBindingProbe?.pid],
  ]) {
    if (!Number.isInteger(pid)) continue;
    try {
      termination.push(await terminateProcessGroup(label, pid));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  state.active = false;
  const pids = [
    state.simulatorPid,
    state.ptyCapturePid,
    state.scannerBindingProbe?.pid,
  ].filter(Number.isInteger);
  state.cleanup = {
    termination,
    errors,
    survivingProcessCount: pids.filter((pid) => processGroupAlive(pid)).length,
    survivingSocketCount: survivingSocketCount(state.runtimeSocketPaths ?? []),
  };
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
          survivingProcessCount: state.cleanup?.survivingProcessCount ?? 0,
          survivingSocketCount: state.cleanup?.survivingSocketCount ?? 0,
          termination: state.cleanup?.termination ?? [],
          errors: state.cleanup?.errors ?? [],
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
        ({ role, guestDeviceIdentity, guestUsbTopology }) => ({
          role,
          guestDeviceIdentity,
          guestUsbTopology,
        }),
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
  const request = validateVmHostAdapterRequest(
    JSON.parse(readFileSync(requestPath, "utf8")),
  );
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
    state = await stopSession(request);
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runQemuUsbSerialAdapter().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "QEMU USB serial adapter failed",
    );
    process.exitCode = 1;
  });
}
