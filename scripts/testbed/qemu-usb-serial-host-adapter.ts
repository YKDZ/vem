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
} from "./vm-host-adapter-contract.ts";

export const QEMU_USB_SERIAL_ADAPTER_VERSION = "1.0.0";
export const QEMU_USB_SERIAL_ADAPTER_IDENTITY = `vm-host-adapter://repo-qemu-usb-serial@${QEMU_USB_SERIAL_ADAPTER_VERSION}`;

const SELF_PATH = fileURLToPath(import.meta.url);
const REQUIRED_ROLES = ["lower-controller", "scanner"];
const FRAME_HEAD = 0x55;
const SCANNER_BINDING_PROBE_BYTES = Buffer.from("VEM-BINDING-PROBE\r", "utf8");
const TERMINATE_GRACE_MS = 3_000;
const KILL_GRACE_MS = 1_000;

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} is required`);
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function crc8(bytes: Uint8Array | number[]): number {
  let crc = 0x00;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
}

function validateVendSlotBounds(rowNo: number, cellNo: number): void {
  if (!Number.isInteger(rowNo) || !Number.isInteger(cellNo)) {
    throw new Error(
      "outbound vend frame must contain integer slot coordinates",
    );
  }
  if (rowNo < 1 || rowNo > 9) {
    throw new Error(
      `outbound vend frame layer ${rowNo} is out of production bounds`,
    );
  }
  const maxCellNo = rowNo <= 6 ? 5 : rowNo <= 8 ? 4 : 3;
  if (cellNo < 1 || cellNo > maxCellNo) {
    throw new Error(
      `outbound vend frame cell ${cellNo} is out of production bounds for layer ${rowNo}`,
    );
  }
}

export function validateProductionRawSerialFrame(
  record: unknown,
  label = "raw serial frame",
): JsonRecord {
  const recordValue_ = recordValue(record);
  if (
    !["daemon-to-controller", "controller-to-daemon"].includes(
      String(recordValue_?.direction ?? ""),
    ) ||
    !/^[0-9A-F]+$/.test(String(recordValue_?.rawFrameHex ?? "")) ||
    String(recordValue_.rawFrameHex ?? "").length % 2 !== 0 ||
    !Number.isInteger(recordValue_?.opcode) ||
    typeof recordValue_?.parsedOpcode !== "string"
  ) {
    throw new Error(`invalid ${label}`);
  }
  const bytes = Buffer.from(String(recordValue_.rawFrameHex), "hex");
  if (bytes[0] !== FRAME_HEAD) {
    throw new Error(`${label} must start with production frame head 55`);
  }
  if (recordValue_.parsedOpcode === "VEND") {
    if (recordValue_.direction !== "daemon-to-controller") {
      throw new Error(`${label} VEND direction must be daemon-to-controller`);
    }
    if (bytes.length !== 4) {
      throw new Error(
        `${label} VEND must be a 4-byte production dispense frame`,
      );
    }
    if (recordValue_.opcode !== bytes[1]) {
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
    return { ...recordValue_, bytes };
  }
  if (!/^[0-9A-F]{2}$/.test(String(recordValue_.parsedOpcode))) {
    throw new Error(
      `${label} must expose a production opcode, got ${recordValue_.parsedOpcode}`,
    );
  }
  const expectedOpcode = Number.parseInt(String(recordValue_.parsedOpcode), 16);
  if (expectedOpcode === 0xb0) {
    const validQuery =
      recordValue_.direction === "daemon-to-controller" &&
      bytes.length === 3 &&
      [0x01, 0x02].includes(bytes[2]);
    const validSample =
      recordValue_.direction === "controller-to-daemon" && bytes.length === 4;
    if (!validQuery && !validSample) {
      throw new Error(
        `${label} B0 must match the production environment query or sample frame`,
      );
    }
    if (bytes[1] !== expectedOpcode || recordValue_.opcode !== expectedOpcode) {
      throw new Error(`${label} B0 opcode must match the production frame`);
    }
    return { ...recordValue_, bytes };
  }
  if (expectedOpcode === 0xb1) {
    if (
      ![2, 4].includes(bytes.length) ||
      bytes[1] !== expectedOpcode ||
      recordValue_.opcode !== expectedOpcode
    ) {
      throw new Error(
        `${label} B1 must match a production air-conditioner state query or response frame`,
      );
    }
    return { ...recordValue_, bytes };
  }
  if ([0xb2, 0xb3].includes(expectedOpcode)) {
    const validLength = bytes.length === 2 || bytes.length === 3;
    const validValue =
      bytes.length === 2 ||
      (expectedOpcode === 0xb3
        ? bytes[2] >= 0 && bytes[2] <= 4
        : [0x00, 0xaa, 0xff].includes(bytes[2]));
    if (
      !validLength ||
      !validValue ||
      bytes[1] !== expectedOpcode ||
      recordValue_.opcode !== expectedOpcode
    ) {
      throw new Error(
        `${label} ${recordValue_.parsedOpcode} must match a production environment query, command, or response frame`,
      );
    }
    return { ...recordValue_, bytes };
  }
  if (
    bytes.length !== 2 ||
    bytes[1] !== expectedOpcode ||
    recordValue_.opcode !== expectedOpcode
  ) {
    throw new Error(
      `${label} ${recordValue_.parsedOpcode} must match the 2-byte production frame 55 ${recordValue_.parsedOpcode}`,
    );
  }
  return { ...recordValue_, bytes };
}

function xmlAttribute(source: string, name: string): string | null {
  return (
    source
      .match(new RegExp(`\\b${name}=(?:"([^"]+)"|'([^']+)')`))
      ?.slice(1)
      .find(Boolean) ?? null
  );
}

export function parseLibvirtUsbSerialMappings(
  xml: unknown,
  { requireAll = true }: { requireAll?: boolean } = {},
): JsonRecord[] {
  const mappings: JsonRecord[] = [];
  for (const match of String(xml).matchAll(
    /<serial\b[^>]*\btype=(?:"pty"|'pty')[^>]*>[\s\S]*?<\/serial>/g,
  )) {
    const block = match[0];
    const aliasTag = block.match(/<alias\b[^>]*>/)?.[0] ?? "";
    const sourceTag = block.match(/<source\b[^>]*>/)?.[0] ?? "";
    const targetTag = block.match(/<target\b[^>]*>/)?.[0] ?? "";
    const addressTag =
      block.match(/<address\b[^>]*\btype=(?:"usb"|'usb')[^>]*\/?\s*>/)?.[0] ??
      "";
    const alias = xmlAttribute(aliasTag, "name");
    const path = xmlAttribute(sourceTag, "path");
    const targetType = xmlAttribute(targetTag, "type");
    const targetPort = xmlAttribute(targetTag, "port");
    const usbBus = xmlAttribute(addressTag, "bus");
    const usbPort = xmlAttribute(addressTag, "port");
    if (!path || targetType !== "usb-serial") continue;
    if (
      !/^\d+$/.test(targetPort ?? "") ||
      !/^\d+$/.test(usbBus ?? "") ||
      !/^\d+(?:\.\d+)*$/.test(usbPort ?? "")
    ) {
      throw new Error(
        `${alias ?? "QEMU USB serial"} must expose explicit libvirt USB target and address topology`,
      );
    }
    // Libvirt may normalize or omit aliases. The target port is the stable
    // role contract; the USB address preserves the physical topology.
    const role =
      targetPort === "0"
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
        targetPort: Number.parseInt(String(targetPort), 10),
        usbBus: Number.parseInt(String(usbBus), 10),
        usbPort,
      },
    });
  }
  for (const role of requireAll ? REQUIRED_ROLES : []) {
    if (mappings.filter((mapping) => mapping.role === role).length !== 1) {
      throw new Error(
        `running libvirt domain must expose exactly one ${role} QEMU USB serial PTY`,
      );
    }
  }
  if (requireAll && mappings.length !== REQUIRED_ROLES.length) {
    throw new Error(
      "running libvirt domain exposes unexpected QEMU USB serial roles",
    );
  }
  return REQUIRED_ROLES.flatMap((role) => {
    const mapping = mappings.find((entry) => entry.role === role);
    return mapping ? [mapping] : [];
  });
}

function verifyImmutableEntry(
  environment: NodeJS.ProcessEnv = process.env,
): string {
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

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(
      `${command} failed: ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

function stateRoot(): string {
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

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForFile(path: string, timeoutMs: number, label: string): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    sleep(25);
  }
  throw new Error(`${label} did not become ready before deadline`);
}

export function qemuUsbSerialSessionPaths(
  root: string,
  serialSessionId: unknown,
): JsonRecord {
  const path = join(
    resolve(root),
    "sessions",
    sha256(Buffer.from(String(serialSessionId), "utf8")),
  );
  return {
    directory: path,
    statePath: join(path, "state.json"),
    journalPath: join(path, "raw-serial.socat.log"),
    lowerControllerProxyPath: join(path, "lower-controller-pty"),
    releaseF0Path: join(path, "release-f0"),
    releaseF2Path: join(path, "release-f2"),
    logPath: join(path, "simulator.log"),
  };
}

function sessionDirectory(serialSessionId: unknown): string {
  const path = qemuUsbSerialSessionPaths(stateRoot(), serialSessionId)
    .directory as string;
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return path;
}

function statePath(serialSessionId: unknown): string {
  return qemuUsbSerialSessionPaths(stateRoot(), serialSessionId)
    .statePath as string;
}

function readState(serialSessionId: unknown): JsonRecord {
  const path = statePath(serialSessionId);
  if (!existsSync(path)) throw new Error("serial session state was not found");
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeState(state: JsonRecord): void {
  writeFileSync(
    statePath(state.serialSessionId),
    `${JSON.stringify(state, null, 2)}\n`,
    { mode: 0o600 },
  );
}

function dumpMappings(): JsonRecord[] {
  const domain = required(
    process.env.VEM_VM_HOST_ADAPTER_DOMAIN,
    "VEM_VM_HOST_ADAPTER_DOMAIN",
  );
  return parseLibvirtUsbSerialMappings(run("virsh", ["dumpxml", domain]));
}

function contractMappings(
  liveMappings: JsonRecord[],
  pid: number,
  connectionState = "connected",
): JsonRecord[] {
  return liveMappings.map((mapping: JsonRecord) => ({
    role: mapping.role,
    guestDeviceIdentity:
      `guest-device://libvirt-usb-bus-${recordValue(mapping.guestUsbTopology).usbBus}` +
      `-port-${String(
        recordValue(mapping.guestUsbTopology).usbPort ?? "",
      ).replaceAll(".", "-")}` +
      `-target-${recordValue(mapping.guestUsbTopology).targetPort}`,
    guestUsbTopology: {
      ...recordValue(mapping.guestUsbTopology),
      alias: `serial-${mapping.role}`,
    },
    simulatorProcessIdentity:
      mapping.role === "lower-controller"
        ? `linux-process://pid-${pid}`
        : `linux-process://host-adapter-${process.pid}`,
    simulatorSocketIdentity: `simulator-socket://sha256-${sha256(
      Buffer.from(String(mapping.path), "utf8"),
    )}`,
    connectionState,
  }));
}

function processGroupAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupAlive(pid)) return true;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return !processGroupAlive(pid);
}

async function terminateProcessGroup(
  label: string,
  pid: number,
): Promise<JsonRecord> {
  const evidence: JsonRecord & { sent: string[] } = {
    label,
    pid,
    sent: [],
    exitedAfter: null,
  };
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

function survivingSocketCount(paths: string[]): number {
  return paths.filter((path: string) => {
    try {
      return statSync(path).isSocket();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }).length;
}

function startScannerBindingProbe(
  scannerPath: string,
  logPath: string,
): JsonRecord | null {
  if (process.env.VEM_LOCAL_TESTBED_SCANNER_BINDING_PROBE === "0") return null;
  const child = spawn(
    process.execPath,
    [
      "-e",
      "const { openSync, writeSync } = require('node:fs'); const path = process.argv[1]; const bytes = Buffer.from(process.argv[2], 'base64'); const fd = openSync(path, 'a'); const emit = () => writeSync(fd, bytes); setTimeout(emit, 100); const probe = setInterval(emit, 500); setInterval(() => {}, 60000); process.on('SIGUSR1', () => clearInterval(probe));",
      scannerPath,
      SCANNER_BINDING_PROBE_BYTES.toString("base64"),
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
    throw new Error("scanner binding probe did not start");
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
}: {
  stateRoot: string;
  serialSessionId: unknown;
  reason?: string;
}): Promise<JsonRecord> {
  const paths = qemuUsbSerialSessionPaths(root, serialSessionId);
  const statePathValue = String(paths.statePath);
  if (!existsSync(statePathValue)) {
    throw new Error("serial session state was not found");
  }
  const state = JSON.parse(readFileSync(statePathValue, "utf8")) as JsonRecord;
  const probe = recordValue(state.scannerBindingProbe);
  if (!probe) throw new Error("scanner binding probe was not started");
  if (probe.stoppedAt) return { ...probe, alreadyStopped: true };
  process.kill(-Number(probe.pid), "SIGUSR1");
  state.scannerBindingProbe = {
    ...probe,
    stoppedAt: new Date().toISOString(),
    stopReason: reason,
    pauseSignal: "SIGUSR1",
    ptyHolderAlive: processGroupAlive(Number(probe.pid)),
  };
  writeFileSync(statePathValue, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  return { ...recordValue(state.scannerBindingProbe), alreadyStopped: false };
}

function startSession(request: JsonRecord): JsonRecord {
  const binding = recordValue(
    deriveSerialSessionBinding({
      runId: request.runId,
      lifecycleReference: request.lifecycleReference,
      targetIdentity: recordValue(request.target).identity,
      startOperationReference: request.operationReference,
    }),
  );
  const dir = sessionDirectory(binding.serialSessionId);
  const liveMappings = dumpMappings();
  const lower = liveMappings.find(
    (mapping) => mapping.role === "lower-controller",
  );
  const scanner = liveMappings.find((mapping) => mapping.role === "scanner");
  if (!lower || !scanner) {
    throw new Error("QEMU USB serial mappings are incomplete");
  }
  const simulator = resolve(
    required(process.env.VEM_LOWER_CONTROLLER_SIM, "VEM_LOWER_CONTROLLER_SIM"),
  );
  if (!existsSync(simulator))
    throw new Error("repo lower-controller simulator binary does not exist");
  const journalPath = qemuUsbSerialSessionPaths(
    stateRoot(),
    binding.serialSessionId,
  ).journalPath as string;
  const socatLifecycleLogPath = join(dir, "socat.lifecycle.log");
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
      socatLifecycleLogPath,
      `PTY,link=${lowerControllerProxyPath},rawer,echo=0,waitslave`,
      `FILE:${String(lower.path)},raw,echo=0`,
    ],
    {
      detached: true,
      stdio: ["ignore", "ignore", openSync(journalPath, "a", 0o600)],
    },
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
  const scannerBindingProbe = startScannerBindingProbe(
    String(scanner.path),
    logPath,
  );
  const mappings = contractMappings(liveMappings, child.pid as number);
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

function injectScanner(request: JsonRecord, scannerCode: Buffer): JsonRecord {
  const serialSession = recordValue(request.serialSession);
  const state = readState(serialSession.serialSessionId);
  if (!state.active) throw new Error("serial session is not active");
  const descriptor = createScannerCodeDescriptor(scannerCode);
  if (
    !scannerDescriptorMatchesRequest(
      descriptor,
      recordValue(serialSession.scannerInjection),
    )
  ) {
    throw new Error(
      "protected scanner input does not match request descriptor",
    );
  }
  const scanner = arrayValue(state.liveMappings)
    .map((mapping: unknown) => recordValue(mapping))
    .find((mapping) => mapping.role === "scanner");
  if (!scanner) throw new Error("scanner mapping is missing");
  appendFileSync(String(scanner.path), scannerCode);
  state.scannerInjection = {
    ...descriptor,
    operationNonce: recordValue(serialSession.scannerInjection).operationNonce,
    acceptedAt: new Date().toISOString(),
  };
  writeState(state);
  return state;
}

export function scannerDescriptorMatchesRequest(
  descriptor: JsonRecord,
  scannerInjection: JsonRecord | null | undefined,
): boolean {
  return (
    descriptor.scannerCodeDigest ===
      recordValue(scannerInjection).scannerCodeDigest &&
    descriptor.scannerCodeByteLength ===
      recordValue(scannerInjection).scannerCodeByteLength &&
    descriptor.scannerCodeSuffix ===
      recordValue(scannerInjection).scannerCodeSuffix
  );
}

export function scannerAcknowledgementFor(
  scannerInjection: JsonRecord | null | undefined,
): JsonRecord {
  const injection = recordValue(scannerInjection);
  return {
    scannerCodeDigest: injection.scannerCodeDigest,
    scannerCodeByteLength: injection.scannerCodeByteLength,
    scannerCodeSuffix: injection.scannerCodeSuffix,
    accepted: true,
  };
}

export function readRawSerialJournal(path: string): JsonRecord[] {
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
      .map((line: string, index: number) => {
        const record = validateProductionRawSerialFrame(
          JSON.parse(line) as JsonRecord,
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
  const records: JsonRecord[] = [];
  let direction: string | null = null;
  let capturedAt: string | null = null;
  let declaredLength: number | null = null;
  let pending = Buffer.alloc(0);
  const flush = (): void => {
    while (pending.length >= 2) {
      const opcode = pending[1];
      const frameLength =
        pending[0] === FRAME_HEAD && opcode >= 1 && opcode <= 9
          ? 4
          : pending[0] === FRAME_HEAD && opcode === 0xb0
            ? direction === "daemon-to-controller"
              ? 3
              : 4
            : pending[0] === FRAME_HEAD && opcode === 0xb1
              ? pending.length >= 4 && pending[2] !== FRAME_HEAD
                ? 4
                : 2
              : pending[0] === FRAME_HEAD && [0xb2, 0xb3].includes(opcode)
                ? pending.length >= 3 && pending[2] !== FRAME_HEAD
                  ? 3
                  : 2
                : 2;
      if (pending.length < frameLength) return;
      const bytes = pending.subarray(0, frameLength);
      pending = pending.subarray(frameLength);
      if (bytes[0] !== FRAME_HEAD || !direction || !capturedAt) continue;
      const parsedOpcode =
        bytes[1] >= 1 && bytes[1] <= 9
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
      /^([<>])\s+(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?)(?:\s+length=(\d+))?/,
    );
    if (header) {
      flush();
      direction =
        header[1] === ">" ? "controller-to-daemon" : "daemon-to-controller";
      declaredLength = header[3] ? Number.parseInt(header[3], 10) : null;
      const secondsMatch = header[2].match(/^(.*?)(?:\.(\d+))?$/);
      if (!secondsMatch) continue;
      const [, seconds, fraction = ""] = secondsMatch;
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
      if (declaredLength === null || pending.length >= declaredLength) flush();
    }
  }
  flush();
  return records;
}

function capturedFrame(raw: JsonRecord, sequence: number): JsonRecord {
  const bytes = Buffer.from(String(raw.rawFrameHex), "hex");
  return {
    source: "guest-serial-session",
    sequence,
    digest: `sha256:${sha256(bytes)}`,
    byteLength: bytes.length,
  };
}

export function semanticRecords(
  request: JsonRecord,
  state: JsonRecord,
  rawFrames: JsonRecord[],
): JsonRecord[] {
  const serialSession = recordValue(request.serialSession);
  const saleBinding = arrayValue(serialSession.saleBindings)[0];
  const saleCorrelationId = arrayValue(serialSession.saleCorrelationIds)[0];
  const statusHeartbeats = new Set(["AA", "AB", "AC", "AF"]);
  const find = (
    predicate: (frame: JsonRecord) => boolean,
    label: string,
  ): JsonRecord => {
    const value = rawFrames.find(predicate);
    if (!value) throw new Error(`raw serial evidence is missing ${label}`);
    return value;
  };
  const handshakeFrames = rawFrames.filter(
    (frame: JsonRecord) =>
      frame.direction === "controller-to-daemon" &&
      statusHeartbeats.has(String(frame.parsedOpcode)),
  );
  const handshake = handshakeFrames[0];
  if (!handshake) {
    throw new Error(
      "raw serial evidence is missing an inbound status heartbeat",
    );
  }
  const health = handshakeFrames[1];
  if (!health) {
    throw new Error(
      "raw serial evidence is missing a second inbound status heartbeat",
    );
  }

  const f0 = find(
    (frame: JsonRecord) =>
      frame.direction === "controller-to-daemon" && frame.parsedOpcode === "F0",
    "inbound F0",
  );
  const f2 = find(
    (frame: JsonRecord) =>
      frame.direction === "controller-to-daemon" && frame.parsedOpcode === "F2",
    "inbound F2",
  );
  const vend = find(
    (frame: JsonRecord) =>
      frame.direction === "daemon-to-controller" &&
      frame.parsedOpcode === "VEND",
    "outbound vend frame",
  );
  const scannerFrame = {
    direction: "host-to-scanner",
    rawFrameHex: "00",
    opcode: 0,
    parsedOpcode: "SCANNER",
  };
  const events: Array<[string, string, JsonRecord, unknown, unknown]> = [
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
  let previousCaptureBindingDigest: unknown = null;
  return events.map(([role, event, raw, correlation, binding], index) => {
    const scanner = role === "scanner";
    const record: JsonRecord = {
      role,
      event,
      operationNonce: scanner
        ? recordValue(state.scannerInjection).operationNonce
        : request.operationNonce,
      sessionBindingToken: serialSession.sessionBindingToken,
      deviceMappingDigest: serialSession.deviceMappingDigest,
      scannerCodeDigest: scanner
        ? recordValue(state.scannerInjection).scannerCodeDigest
        : null,
      scannerCodeByteLength: scanner
        ? recordValue(state.scannerInjection).scannerCodeByteLength
        : null,
      scannerCodeSuffix: scanner
        ? recordValue(state.scannerInjection).scannerCodeSuffix
        : null,
      saleCorrelationId: correlation,
      saleBinding: binding,
      capturedFrame: capturedFrame(raw, index + 1),
    };
    record.captureBindingDigest = deriveSerialFrameCaptureBindingDigest({
      request,
      record,
      previousCaptureBindingDigest:
        typeof previousCaptureBindingDigest === "string"
          ? previousCaptureBindingDigest
          : null,
    });
    previousCaptureBindingDigest = record.captureBindingDigest;
    return record;
  });
}

async function stopSession(request: JsonRecord): Promise<JsonRecord> {
  const serialSession = recordValue(request.serialSession);
  const state = readState(serialSession.serialSessionId);
  state.cleanupAttemptCount = Number(state.cleanupAttemptCount) + 1;
  const errors: string[] = [];
  const termination: JsonRecord[] = [];
  for (const [label, pid] of [
    ["lower-controller simulator", Number(state.simulatorPid)],
    ["host PTY capture", Number(state.ptyCapturePid)],
    [
      "scanner binding probe",
      Number(recordValue(state.scannerBindingProbe).pid),
    ],
  ] as Array<[string, number]>) {
    if (!Number.isInteger(pid) || pid < 1) continue;
    try {
      termination.push(await terminateProcessGroup(label, pid));
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  state.active = false;
  const pids = [
    Number(state.simulatorPid),
    Number(state.ptyCapturePid),
    Number(recordValue(state.scannerBindingProbe).pid),
  ].filter((pid: unknown) => Number.isInteger(pid) && Number(pid) > 0);
  state.cleanup = {
    termination,
    errors,
    survivingProcessCount: pids.filter((pid) => processGroupAlive(pid)).length,
    survivingSocketCount: survivingSocketCount(
      arrayValue(state.runtimeSocketPaths).map((path: unknown) => String(path)),
    ),
  };
  writeState(state);
  return state;
}

function serialSessionReport(
  request: JsonRecord,
  state: JsonRecord,
): JsonRecord {
  const stopped = request.operation === "stop-serial-session";
  const binding = recordValue(state.binding);
  const serialSession = recordValue(request.serialSession);
  const mappings = arrayValue(state.mappings).map((mapping: unknown) =>
    recordValue(mapping),
  );
  const cleanup = recordValue(state.cleanup);
  return {
    serialSessionId: state.serialSessionId,
    sessionBindingToken: binding.sessionBindingToken,
    startOperationReference:
      binding.startOperationReference ??
      serialSession?.startOperationReference ??
      request.operationReference,
    deviceMappingDigest: deriveSerialDeviceMappingDigest(mappings),
    state: stopped ? "stopped" : "active",
    deviceMappings: mappings.map((mapping: JsonRecord) => ({
      ...mapping,
      connectionState: stopped ? "disconnected" : mapping.connectionState,
    })),
    scannerAcknowledgement:
      request.operation === "inject-scanner-code"
        ? scannerAcknowledgementFor(recordValue(serialSession.scannerInjection))
        : null,
    simulatorCleanup: stopped
      ? {
          cleanupAttemptCount: state.cleanupAttemptCount,
          idempotencyVerified: serialSession.idempotencyCheck,
          survivingProcessCount: cleanup.survivingProcessCount ?? 0,
          survivingSocketCount: cleanup.survivingSocketCount ?? 0,
          termination: arrayValue(cleanup.termination),
          errors: arrayValue(cleanup.errors),
        }
      : null,
  };
}

function reportFor(
  request: JsonRecord,
  state: JsonRecord,
  rawFrames: JsonRecord[] = [],
): JsonRecord {
  const now = new Date().toISOString();
  const records =
    request.operation === "collect-serial-evidence"
      ? semanticRecords(request, state, rawFrames)
      : null;
  const serialSession = serialSessionReport(request, state);
  const requestTarget = recordValue(request.target);
  const assets = arrayValue(request.assets).map((asset: unknown) =>
    recordValue(asset),
  );
  const serialSessionValue = recordValue(request.serialSession);
  const deviceMappings = arrayValue(serialSession.deviceMappings).map(
    (mapping: unknown) => recordValue(mapping),
  );
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
      targetIdentity: requestTarget.identity,
      displayCapture: request.displayCapture,
      audioCapture: request.audioCapture,
      requestedCapabilities: request.requestedCapabilities,
      serialSession: serialSessionValue,
    },
    result: "succeeded",
    negotiatedCapabilities: request.requestedCapabilities,
    completedOperations: [request.operation],
    observed: {
      vmIdentity: `libvirt-domain://${required(process.env.VEM_VM_HOST_ADAPTER_DOMAIN, "VEM_VM_HOST_ADAPTER_DOMAIN")}`,
      targetBinding: {
        relation: "host-target-mapping/v1",
        targetIdentity: requestTarget.identity,
      },
      baseIdentity: assets[0]?.identity ?? null,
      overlayIdentity: `vm-overlay://sha256-${sha256(
        Buffer.from(String(request.runId), "utf8"),
      )}`,
      firmwareMode: "uefi",
    },
    consumedAssets: assets,
    guest: {
      deviceMappings: deviceMappings.map(
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
        bootstrapMedia: "not-mounted",
      },
    },
    diagnostics: [{ code: "adapter_completed" }],
    serialSession,
    serialEvidence: records
      ? {
          serialSessionId: serialSessionValue.serialSessionId,
          sessionBindingToken: serialSessionValue.sessionBindingToken,
          deviceMappingDigest: serialSessionValue.deviceMappingDigest,
          operationEvidence: serialSessionValue.operationEvidence,
          records,
          captureChainDigest: deriveSerialEvidenceCaptureChainDigest({
            request,
            records,
          }),
        }
      : null,
  };
}

export async function runQemuUsbSerialAdapter(
  args: string[] = process.argv.slice(2),
): Promise<JsonRecord> {
  verifyImmutableEntry();
  const requestPath = option(args, "request");
  const reportPath = option(args, "report");
  const request = validateVmHostAdapterRequest(
    JSON.parse(readFileSync(requestPath, "utf8")),
  ) as JsonRecord;
  let state: JsonRecord;
  let rawFrames: JsonRecord[] = [];
  if (request.operation === "start-serial-session") {
    state = startSession(request);
  } else if (request.operation === "inject-scanner-code") {
    const scannerCodePath = option(args, "scanner-code-file");
    const scannerCode = readFileSync(scannerCodePath);
    state = injectScanner(request, scannerCode);
  } else if (request.operation === "collect-serial-evidence") {
    state = readState(recordValue(request.serialSession).serialSessionId);
    rawFrames = readRawSerialJournal(String(state.journalPath));
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
