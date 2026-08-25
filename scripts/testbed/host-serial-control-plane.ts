#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  readPaymentMockCreateGateStatus,
  readPaymentMockQueryFaultStatus,
  writePaymentMockCreateGateState,
  writePaymentMockQueryFaultState,
} from "./mock-payment-create-gate.ts";
import {
  parseLibvirtUsbSerialMappings,
  qemuUsbSerialSessionPaths,
  readRawSerialJournal,
  stopQemuScannerBindingProbe,
} from "./qemu-usb-serial-host-adapter.ts";
import {
  abortSaleAudioCaptureSession,
  executeSaleAudioCaptureHostAdapter,
  stopDefaultAudioCaptureSession,
} from "./sale-audio-capture-host-adapter.ts";

const MOSQUITTO_CONTAINER = "vem-local-testbed-mosquitto";
const TESTBED_MQTT_USERNAME =
  process.env.VEM_LOCAL_TESTBED_MQTT_USERNAME ?? "vem_local_testbed_mqtt";
const TESTBED_MQTT_PASSWORD =
  process.env.VEM_LOCAL_TESTBED_MQTT_PASSWORD ??
  "vem_local_testbed_mqtt_password";
const PLATFORM_DATABASE_URL =
  process.env.VEM_LOCAL_TESTBED_PLATFORM_DATABASE_URL ??
  "postgresql://vem:vem_local_testbed_password@127.0.0.1:55432/vem_local_testbed";
const SERIAL_SCENARIOS = Object.freeze({
  NORMAL: "normal",
  DELAYED_PICKUP: "delayed-pickup",
  E6: "e6",
});

type SerialScenario = "normal" | "delayed-pickup" | "e6";

interface ControlPlaneOptions {
  workspace: string;
  stateRoot: string;
  bind: string;
  port: number;
  token: string;
  libvirtUri: string;
  domainName: string;
}

interface RuntimeBinding {
  processId: number;
  executablePath: string;
  principal: string;
  sessionId: number;
  cdpTargetId: string;
  cdpSessionId: string;
}

interface CommandSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface MqttMessage {
  topic: string;
  payload: unknown;
}

interface MqttCapture {
  child: ReturnType<typeof spawn>;
  ready: Promise<{ topic: string; subscribedAt: string }>;
  stop: () => void;
  snapshot: () => {
    topic: string;
    messages: MqttMessage[];
    stderr: string;
  };
}

interface SerialSessionBinding {
  serialSessionId: string;
  sessionBindingToken: string;
  startOperationReference: string;
  deviceMappingDigest: string;
}

interface SaleBinding {
  saleCorrelationId: string;
  orderId: string;
  paymentId: string;
  vendingCommandId: string | null;
}

interface SerialSession {
  id: string;
  dir: string;
  runId: string;
  machineCode: string;
  targetIdentity: string;
  runtimeBase: string;
  saleCorrelationId: string;
  serialScenario: SerialScenario;
  startReport: unknown;
  binding: SerialSessionBinding;
  frozenMilestoneFrames: unknown[];
  mqttCapture: MqttCapture;
  machineMqttCapture: MqttCapture;
  deviceLifecycle: Array<Record<string, unknown>>;
  detachedDeviceXml: Record<string, string>;
  injectReport: unknown | null;
  collectReport: unknown | null;
  stopReports: unknown[];
  sale: SaleBinding | null;
}

interface AudioCaptureSession {
  id: string;
  operationId: string;
  sessionId: string;
  startInput: Record<string, string>;
  startReport: {
    captureSession: {
      captureSessionId: string;
      startOperationReference: string;
      startedAt: string;
    };
  };
  runtime: RuntimeBinding;
  evidenceDirectory: string;
  cancelledAt: string | null;
  stopReport: {
    captureSession?: unknown;
    evidence?: Array<{ fileName: string }>;
  } | null;
}

interface ControlPlaneDependencies {
  executeSaleAudioCapture?: (
    options: {
      phase: string;
      runId: string;
      lifecycleReference: string;
      targetIdentity: string;
      transactionId: string;
      runtime: RuntimeBinding;
      captureSessionId?: string;
      startOperationReference?: string;
      captureStartedAt?: string;
      sale?: unknown;
      evidenceDirectory: string;
      outPath: string;
      production?: unknown;
    },
    dependencies?: Record<string, unknown>,
  ) => Promise<unknown>;
  stopDefaultAudioCapture?: (
    options: {
      captureSessionId: string;
      evidenceDirectory: string;
    },
    dependencies?: Record<string, unknown>,
  ) => Promise<unknown>;
  abortSaleAudioCapture?: (
    options: {
      captureSessionId: string;
      evidenceDirectory: string;
    },
    dependencies?: Record<string, unknown>,
  ) => Promise<unknown>;
  mqttCaptureFactory?: (options: {
    machineCode: string;
    topic?: string;
    limit?: number;
  }) => MqttCapture;
}

interface ControlPlaneServerState {
  options: ControlPlaneOptions;
  sessions: Map<string, SerialSession>;
  audioCaptures: Map<string, AudioCaptureSession>;
  audioCapturesByOperation: Map<string, string>;
  dependencies: {
    executeSaleAudioCapture: NonNullable<
      ControlPlaneDependencies["executeSaleAudioCapture"]
    >;
    stopDefaultAudioCapture: NonNullable<
      ControlPlaneDependencies["stopDefaultAudioCapture"]
    >;
    abortSaleAudioCapture: NonNullable<
      ControlPlaneDependencies["abortSaleAudioCapture"]
    >;
    mqttCaptureFactory?: ControlPlaneDependencies["mqttCaptureFactory"];
  };
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function absolute(value: unknown, label: string): string {
  const path = required(value, label);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function runtimeBinding(runtime: unknown): RuntimeBinding {
  if (
    runtime === null ||
    typeof runtime !== "object" ||
    Array.isArray(runtime)
  ) {
    throw new Error("runtime binding is required");
  }
  const record = runtime as Record<string, unknown>;
  const processId = Number(record.processId);
  const sessionId = Number(record.sessionId);
  if (!Number.isInteger(processId) || processId < 1) {
    throw new Error("runtime.processId must be a positive integer");
  }
  if (!Number.isInteger(sessionId) || sessionId < 1) {
    throw new Error("runtime.sessionId must be a positive integer");
  }
  return {
    processId,
    executablePath: required(record.executablePath, "runtime.executablePath"),
    principal: required(record.principal, "runtime.principal"),
    sessionId,
    cdpTargetId: required(record.cdpTargetId, "runtime.cdpTargetId"),
    cdpSessionId: required(record.cdpSessionId, "runtime.cdpSessionId"),
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

class TestbedInfrastructureError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "TestbedInfrastructureError";
    this.code = "testbed_infra_failed";
    this.details = details;
  }
}

function errorResponsePayload(error: unknown): Record<string, unknown> {
  if (error instanceof TestbedInfrastructureError) {
    return {
      ok: false,
      error: error.message,
      code: error.code,
      stage: error.details.stage ?? "unknown",
      details: error.details,
    };
  }
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  };
}

export function parseHostSerialControlPlaneArgs(args: string[]): {
  workspace: string;
  stateRoot: string;
  bind: string;
  port: number;
  token: string;
  libvirtUri: string;
  domainName: string;
} {
  return {
    workspace: absolute(option(args, "workspace"), "--workspace"),
    stateRoot: absolute(option(args, "state-root"), "--state-root"),
    bind: required(option(args, "bind"), "--bind"),
    port: positiveInteger(option(args, "port"), "--port"),
    token: required(option(args, "token"), "--token"),
    libvirtUri: required(option(args, "libvirt-uri"), "--libvirt-uri"),
    domainName: required(option(args, "domain-name"), "--domain-name"),
  };
}

export function buildMqttTopic(machineCode: unknown): string {
  return `vem/machines/${required(machineCode, "machineCode")}/commands/dispense`;
}

function buildMachineMqttTopic(machineCode: unknown): string {
  return `vem/machines/${required(machineCode, "machineCode")}/#`;
}

function normalizeSerialScenario(value: unknown): SerialScenario {
  if (value == null) return SERIAL_SCENARIOS.NORMAL;
  const scenario = String(value).trim().toLowerCase();
  if (!Object.values(SERIAL_SCENARIOS).includes(scenario as SerialScenario)) {
    throw new Error("serialScenario must be normal, delayed-pickup, or e6");
  }
  return scenario as SerialScenario;
}

interface SerialOperationRequest {
  operation: string;
  runId: string;
  targetIdentity: string;
  runtimeBase: string;
  outPath: string;
  saleCorrelationId?: string;
  sessionBinding?: SerialSessionBinding;
  sale?: {
    saleCorrelationId: string;
    orderId: string;
    paymentId: string;
    vendingCommandId?: string | null;
  };
  scannerCodeFile?: string;
  scannerInjection?: {
    operationNonce: string;
    scannerCodeDigest: string;
    scannerCodeByteLength: number;
    scannerCodeSuffix: string;
  };
  operationEvidence?: {
    runnerChallenge: string;
    startReportDigest: string;
    injectReportDigest: string;
  };
  idempotencyCheck?: boolean;
  serialScenario?: unknown;
}

interface SerialSessionStartReport {
  serialSession: {
    serialSessionId: string;
    sessionBindingToken: string;
    startOperationReference: string;
    deviceMappingDigest: string;
    deviceMappings: unknown;
  };
}

interface SerialRunnerReport {
  request?: {
    serialSession?: {
      scannerInjection?: {
        operationNonce: string;
        scannerCodeDigest: string;
        scannerCodeByteLength: number;
        scannerCodeSuffix: string;
      };
    };
  };
}

function baseSerialArgs(request: SerialOperationRequest): string[] {
  return [
    "scripts/testbed/run-vm-host-adapter.ts",
    "--operation",
    request.operation,
    "--run-id",
    request.runId,
    "--target-identity",
    request.targetIdentity,
    "--runtime-base",
    request.runtimeBase,
    "--out",
    request.outPath,
  ];
}

function sessionArgs(sessionBinding: SerialSessionBinding): string[] {
  return [
    "--serial-session-id",
    sessionBinding.serialSessionId,
    "--session-binding-token",
    sessionBinding.sessionBindingToken,
    "--start-operation-reference",
    sessionBinding.startOperationReference,
    "--device-mapping-digest",
    sessionBinding.deviceMappingDigest,
  ];
}

function saleArgs(sale: NonNullable<SerialOperationRequest["sale"]>): string[] {
  return [
    "--sale-correlation-id",
    sale.saleCorrelationId,
    "--order-id",
    sale.orderId,
    "--payment-id",
    sale.paymentId,
  ];
}

export function buildSerialOperationCommand({
  workspace,
  stateRoot,
  request,
}: {
  workspace: string;
  stateRoot: string;
  request: SerialOperationRequest;
}): CommandSpec {
  const args = baseSerialArgs(request);
  if (request.operation === "start-serial-session") {
    args.push(
      "--sale-correlation-id",
      required(request.saleCorrelationId, "saleCorrelationId"),
    );
  } else {
    const sessionBinding = request.sessionBinding;
    const sale = request.sale;
    if (sessionBinding === undefined || sale === undefined) {
      throw new Error(
        "serial session binding and sale are required for non-start operations",
      );
    }
    args.push(...sessionArgs(sessionBinding), ...saleArgs(sale));
    if (request.operation === "inject-scanner-code") {
      args.push(
        "--scanner-code-file",
        required(request.scannerCodeFile, "scannerCodeFile"),
      );
    } else if (request.operation === "collect-serial-evidence") {
      const scannerInjection = request.scannerInjection;
      const operationEvidence = request.operationEvidence;
      if (scannerInjection === undefined || operationEvidence === undefined) {
        throw new Error(
          "scanner injection and operation evidence are required for collect-serial-evidence",
        );
      }
      args.push(
        "--vending-command-id",
        required(sale.vendingCommandId, "vendingCommandId"),
        "--scanner-injection-operation-nonce",
        scannerInjection.operationNonce,
        "--scanner-code-digest",
        scannerInjection.scannerCodeDigest,
        "--scanner-code-byte-length",
        String(scannerInjection.scannerCodeByteLength),
        "--scanner-code-suffix",
        scannerInjection.scannerCodeSuffix,
        "--serial-runner-challenge",
        operationEvidence.runnerChallenge,
        "--serial-start-report-digest",
        operationEvidence.startReportDigest,
        "--serial-inject-report-digest",
        operationEvidence.injectReportDigest,
      );
    } else if (sale.vendingCommandId) {
      args.push("--vending-command-id", sale.vendingCommandId);
    }
    if (request.idempotencyCheck === true) args.push("--idempotency-check");
  }
  return {
    command: process.execPath,
    args,
    cwd: workspace,
    env: {
      ...process.env,
      RUNNER_TEMP: join(stateRoot, "runner-temp"),
      ...(request.operation === "start-serial-session"
        ? {
            VEM_LOCAL_TESTBED_SERIAL_SCENARIO: normalizeSerialScenario(
              request.serialScenario,
            ),
          }
        : {}),
    },
  };
}

function buildPlatformQueryCommand({
  workspace,
  runId,
  machineCode,
  outPath,
}: {
  workspace: string;
  runId: string;
  machineCode: string;
  outPath: string;
}): CommandSpec {
  return {
    command: process.execPath,
    args: [
      "--conditions=vem-source",
      "--import",
      "tsx",
      "apps/service-api/src/testbed/query-installed-kiosk-sale-platform.cli.ts",
      "--run-id",
      runId,
      "--machine-code",
      machineCode,
      "--out",
      outPath,
    ],
    cwd: workspace,
    env: {
      ...process.env,
      VEM_INSTALLED_KIOSK_SALE_DATABASE_URL: PLATFORM_DATABASE_URL,
    },
  };
}

function buildPaymentExpiryInjectionCommand({
  workspace,
  runId,
  machineCode,
  paymentId,
  expiresAt,
}: {
  workspace: string;
  runId: string;
  machineCode: string;
  paymentId: string;
  expiresAt: string;
}): CommandSpec {
  return {
    command: process.execPath,
    args: [
      "--conditions=vem-source",
      "--import",
      "tsx",
      "apps/service-api/src/testbed/inject-installed-kiosk-payment-expiry.cli.ts",
      "--run-id",
      runId,
      "--machine-code",
      machineCode,
      "--payment-id",
      paymentId,
      "--expires-at",
      expiresAt,
    ],
    cwd: workspace,
    env: {
      ...process.env,
      VEM_INSTALLED_KIOSK_SALE_DATABASE_URL: PLATFORM_DATABASE_URL,
    },
  };
}

function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

function parseJsonLine(stdout: unknown, path?: string): unknown {
  const trimmed = String(stdout).trim();
  if (trimmed) {
    const lastLine = trimmed.split(/\r?\n/).at(-1);
    if (lastLine !== undefined) {
      try {
        return JSON.parse(lastLine);
      } catch {}
    }
  }
  if (!path) throw new Error("command did not emit JSON output");
  return JSON.parse(readFileSync(path, "utf8"));
}

export function runJsonCommand(
  command: CommandSpec,
  {
    timeoutMs = 60_000,
    terminationGraceMs = 2_000,
  }: { timeoutMs?: number; terminationGraceMs?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let settled = false;
    let timedOut = false;
    let killTimer: NodeJS.Timeout | null = null;
    const settle = <T>(callback: (value: T) => void, value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      callback(value);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }, terminationGraceMs);
    }, timeoutMs);
    child.once("error", (error) => settle(reject, error));
    child.once("exit", (code) => {
      if (timedOut)
        settle(
          reject,
          new Error(`${command.command} exceeded ${timeoutMs}ms deadline`),
        );
      else if (code === 0) settle(resolvePromise, { stdout, stderr });
      else
        settle(
          reject,
          new Error(
            stderr ||
              stdout ||
              `${command.command} exited with ${code ?? "signal"}`,
          ),
        );
    });
  });
}

function readRequestBody(
  request: import("node:http").IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 512 * 1024) {
        reject(new Error("request body exceeded maximum size"));
      }
    });
    request.once("end", () => {
      if (body.trim() === "") {
        resolvePromise({});
        return;
      }
      try {
        resolvePromise(JSON.parse(body));
      } catch {
        reject(new Error("request body must be JSON"));
      }
    });
    request.once("error", reject);
  });
}

function jsonResponse(
  response: import("node:http").ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

function runnerTempRoot(stateRoot: string): string {
  const path = join(stateRoot, "runner-temp");
  mkdirSync(path, { recursive: true });
  return path;
}

export {
  paymentMockCreateGatePaths as mockPaymentCreateGatePaths,
  paymentMockQueryFaultPaths as mockPaymentQueryFaultPaths,
} from "./mock-payment-create-gate.ts";

function armMockPaymentCreateGate(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const timeoutMs = Number(input?.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new Error("mock payment create gate timeoutMs must be 100..30000");
  }
  writePaymentMockCreateGateState(server.options.stateRoot, {
    state: "hold",
    timeoutMs,
  });
  return {
    armedAt: new Date().toISOString(),
    state: "hold",
    timeoutMs,
  };
}

function readMockPaymentCreateGateStatus(
  server: ControlPlaneServerState,
): Record<string, unknown> {
  return readPaymentMockCreateGateStatus(server.options.stateRoot);
}

function releaseMockPaymentCreateGate(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Record<string, unknown> {
  writePaymentMockCreateGateState(server.options.stateRoot, {
    state: "release",
    paymentNo: required(input.paymentNo, "paymentNo"),
  });
  return {
    releasedAt: new Date().toISOString(),
    state: "release",
  };
}

function openMockPaymentCreateGate(
  server: ControlPlaneServerState,
): Record<string, unknown> {
  writePaymentMockCreateGateState(server.options.stateRoot, { state: "open" });
  return {
    openedAt: new Date().toISOString(),
    state: "open",
  };
}

function armMockPaymentQueryFault(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const paymentNo = required(input.paymentNo, "paymentNo");
  writePaymentMockQueryFaultState(server.options.stateRoot, {
    state: "fail",
    paymentNo,
  });
  return { armedAt: new Date().toISOString(), state: "fail", paymentNo };
}

function readMockPaymentQueryFault(
  server: ControlPlaneServerState,
): Record<string, unknown> {
  return readPaymentMockQueryFaultStatus(server.options.stateRoot);
}

function openMockPaymentQueryFault(
  server: ControlPlaneServerState,
): Record<string, unknown> {
  writePaymentMockQueryFaultState(server.options.stateRoot, { state: "open" });
  return { openedAt: new Date().toISOString(), state: "open" };
}

function writeProtectedTempFile(
  root: string,
  prefix: string,
  contents: string | Buffer | Uint8Array,
): string {
  const directory = mkdtempSync(join(root, `${prefix}-`));
  const path = join(directory, `${prefix}.bin`);
  const bytes = Buffer.isBuffer(contents)
    ? contents
    : Buffer.from(String(contents), "utf8");
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function spawnMqttCapture({
  machineCode,
  topic = buildMqttTopic(machineCode),
  limit = 4,
}: {
  machineCode: unknown;
  topic?: string;
  limit?: number;
}): MqttCapture {
  const timeoutSeconds = Number.parseInt(
    process.env.VEM_TESTBED_MQTT_CAPTURE_TIMEOUT_SECONDS ?? "180",
    10,
  );
  const boundedTimeoutSeconds =
    Number.isSafeInteger(timeoutSeconds) && timeoutSeconds >= 30
      ? timeoutSeconds
      : 180;
  const probeId = randomUUID();
  const probeTopic = `vem/testbed/capture-probes/${probeId}`;
  const authArgs = ["-u", TESTBED_MQTT_USERNAME, "-P", TESTBED_MQTT_PASSWORD];
  const child = spawn(
    "docker",
    [
      "exec",
      MOSQUITTO_CONTAINER,
      "mosquitto_sub",
      "-h",
      "127.0.0.1",
      "-p",
      "1883",
      ...authArgs,
      "-t",
      topic,
      "-t",
      probeTopic,
      "-C",
      String(limit + 1),
      "-W",
      String(boundedTimeoutSeconds),
      "-v",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const messages: MqttMessage[] = [];
  let stderr = "";
  let readySettled = false;
  let readyResolve!: (value: { topic: string; subscribedAt: string }) => void;
  let readyReject!: (error: Error) => void;
  const ready = new Promise<{ topic: string; subscribedAt: string }>(
    (resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    },
  );
  const readyTimeout = setTimeout(() => {
    if (readySettled) return;
    readySettled = true;
    readyReject(
      new Error(
        `MQTT capture did not subscribe to ${topic} within 5000ms; stderr: ${stderr.trim()}`,
      ),
    );
  }, 5_000);
  readyTimeout.unref?.();
  const markReady = () => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimeout);
    spawn(
      "docker",
      [
        "exec",
        MOSQUITTO_CONTAINER,
        "mosquitto_pub",
        "-h",
        "127.0.0.1",
        "-p",
        "1883",
        ...authArgs,
        "-t",
        probeTopic,
        "-r",
        "-n",
      ],
      { stdio: "ignore" },
    );
    readyResolve({ topic, subscribedAt: new Date().toISOString() });
  };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const firstSpace = trimmed.indexOf(" ");
      const observedTopic =
        firstSpace > 0 ? trimmed.slice(0, firstSpace) : topic;
      const payloadText =
        firstSpace > 0 ? trimmed.slice(firstSpace + 1).trim() : trimmed;
      if (observedTopic === probeTopic) {
        try {
          const payload = JSON.parse(payloadText) as {
            __vemTestbedMqttCaptureProbe?: string;
          };
          if (payload.__vemTestbedMqttCaptureProbe === probeId) {
            markReady();
          }
        } catch {}
        continue;
      }
      try {
        const payload: unknown = JSON.parse(payloadText);
        messages.push({
          topic: observedTopic,
          payload,
        });
      } catch {
        messages.push({ topic: observedTopic, payload: payloadText });
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimeout);
    readyReject(error);
  });
  child.once("exit", (code, signal) => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimeout);
    readyReject(
      new Error(
        `MQTT capture exited before subscribing to ${topic}; exit=${code} signal=${signal} stderr: ${stderr.trim()}`,
      ),
    );
  });
  const publish = spawn(
    "docker",
    [
      "exec",
      MOSQUITTO_CONTAINER,
      "mosquitto_pub",
      "-h",
      "127.0.0.1",
      "-p",
      "1883",
      ...authArgs,
      "-t",
      probeTopic,
      "-r",
      "-m",
      JSON.stringify({ __vemTestbedMqttCaptureProbe: probeId }),
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  let publishStderr = "";
  publish.stderr.setEncoding("utf8");
  publish.stderr.on("data", (chunk) => {
    publishStderr += chunk;
  });
  publish.once("error", (error) => {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimeout);
    readyReject(error);
  });
  publish.once("exit", (code, signal) => {
    if (readySettled || code === 0) return;
    readySettled = true;
    clearTimeout(readyTimeout);
    readyReject(
      new Error(
        `MQTT capture probe publish failed for ${topic}; exit=${code} signal=${signal} stderr: ${publishStderr.trim()}`,
      ),
    );
  });
  return {
    child,
    ready,
    stop() {
      child.kill("SIGTERM");
      publish.kill("SIGTERM");
    },
    snapshot() {
      return { topic, messages: [...messages], stderr: stderr.trim() };
    },
  };
}

function summarizeReport(report: unknown): Record<string, unknown> {
  const record = report as
    | {
        result?: unknown;
        request?: { operation?: unknown; operationReference?: unknown };
        serialSession?: { serialSessionId?: unknown };
      }
    | null
    | undefined;
  return {
    result: record?.result ?? null,
    operation:
      record?.request?.operation ?? record?.request?.operationReference ?? null,
    serialSessionId: record?.serialSession?.serialSessionId ?? null,
  };
}

const RAW_PROTOCOL_DIRECTIONS = Object.freeze({
  VEND: "daemon-to-controller",
  B3: ["daemon-to-controller", "controller-to-daemon"],
  F0: "controller-to-daemon",
  E5: "controller-to-daemon",
  F1: "controller-to-daemon",
  AF: "controller-to-daemon",
  E6: "controller-to-daemon",
  F2: "controller-to-daemon",
});

const REPEATED_STATE_OPCODES = new Set(["F0", "F1", "AF", "F2"]);

interface SerialFrame {
  sequence?: number;
  direction?: string;
  parsedOpcode?: string;
  rawFrameHex?: string;
  capturedAt?: string;
  sessionId?: string;
  provenance?: string;
  [key: string]: unknown;
}

function collapseRepeatedStateFrames(frames: SerialFrame[]): SerialFrame[] {
  return frames.filter((frame, index) => {
    const previous = frames[index - 1];
    return !(
      previous?.parsedOpcode === frame.parsedOpcode &&
      frame.parsedOpcode !== undefined &&
      REPEATED_STATE_OPCODES.has(frame.parsedOpcode)
    );
  });
}

function orderedMilestoneFrames(
  frames: SerialFrame[],
  expected: readonly string[],
): SerialFrame[] | null {
  const milestones: SerialFrame[] = [];
  let expectedIndex = 0;
  for (const frame of frames) {
    if (frame.parsedOpcode !== expected[expectedIndex]) continue;
    milestones.push(frame);
    expectedIndex += 1;
    if (expectedIndex === expected.length) return milestones;
  }
  return null;
}

function frozenFrameKey(frame: SerialFrame): string {
  if (Number.isSafeInteger(frame?.sequence))
    return `sequence:${frame.sequence}`;
  return JSON.stringify([
    frame?.direction ?? null,
    frame?.parsedOpcode ?? null,
    frame?.rawFrameHex ?? null,
    frame?.capturedAt ?? null,
  ]);
}

export function mergeFrozenSerialMilestones({
  sessionId,
  existing = [],
  boundary,
}: {
  sessionId: unknown;
  existing?: unknown;
  boundary?: { protocolFrames?: unknown };
}): SerialFrame[] {
  const boundSessionId = required(sessionId, "serial session id");
  const frozen: SerialFrame[] = Array.isArray(existing) ? existing : [];
  for (const frame of frozen) {
    if (frame?.sessionId !== boundSessionId) {
      throw new Error(
        "frozen serial milestone belongs to another serial session",
      );
    }
  }
  const observed: SerialFrame[] = Array.isArray(boundary?.protocolFrames)
    ? (boundary.protocolFrames as SerialFrame[])
    : [];
  const byKey = new Map<string, SerialFrame>();
  for (const frame of [...frozen, ...observed]) {
    const normalized = {
      ...frame,
      sessionId: boundSessionId,
      provenance: frame?.provenance ?? "host_pty_raw_serial_journal",
    };
    const key = frozenFrameKey(normalized);
    if (!byKey.has(key)) byKey.set(key, normalized);
  }
  return [...byKey.values()].sort((left, right) => {
    const leftSequence = left.sequence;
    const rightSequence = right.sequence;
    if (
      typeof leftSequence === "number" &&
      Number.isSafeInteger(leftSequence) &&
      typeof rightSequence === "number" &&
      Number.isSafeInteger(rightSequence)
    ) {
      return leftSequence - rightSequence;
    }
    return 0;
  });
}

export async function waitForRawSerialFrame({
  journalPath,
  parsedOpcode,
  afterSequence = null,
  serialScenario = SERIAL_SCENARIOS.NORMAL,
  timeoutMs = 30_000,
  pollMs = 25,
}: {
  journalPath: unknown;
  parsedOpcode: unknown;
  afterSequence?: unknown;
  serialScenario?: unknown;
  timeoutMs?: number;
  pollMs?: number;
}): Promise<{
  parsedOpcode: string;
  frame: SerialFrame | undefined;
  protocolFrames: SerialFrame[];
  observedProtocolFrames: SerialFrame[];
}> {
  const opcode = String(parsedOpcode ?? "");
  const normalizedAfterSequence =
    afterSequence === null || afterSequence === undefined
      ? null
      : Number(afterSequence);
  if (
    normalizedAfterSequence !== null &&
    (!Number.isSafeInteger(normalizedAfterSequence) ||
      normalizedAfterSequence < 0)
  ) {
    throw new Error("afterSequence must be a non-negative safe integer");
  }
  const scenario = normalizeSerialScenario(serialScenario);
  const scenarioExpected: Record<
    string,
    Record<string, string[] | undefined>
  > = {
    [SERIAL_SCENARIOS.NORMAL]: {
      VEND: ["VEND"],
      B3: ["B3"],
      F0: ["VEND", "F0"],
      F1: ["VEND", "F0", "F1"],
      F2: ["VEND", "F0", "F1", "AF", "F2"],
    },
    [SERIAL_SCENARIOS.DELAYED_PICKUP]: {
      VEND: ["VEND"],
      F0: ["VEND", "F0"],
      F1: ["VEND", "F0", "E5", "E5", "F1"],
      F2: ["VEND", "F0", "E5", "E5", "F1", "AF", "F2"],
    },
    [SERIAL_SCENARIOS.E6]: {
      VEND: ["VEND"],
      F0: ["VEND", "F0"],
      E6: ["VEND", "F0", "E5", "E5", "F1", "E6"],
    },
  };
  const expected = scenarioExpected[scenario]?.[opcode];
  if (!expected)
    throw new Error("parsedOpcode is not valid for the serial scenario");
  const deadline = Date.now() + timeoutMs;
  do {
    const journal = readRawSerialJournal(String(journalPath));
    if (journal.length > 256)
      throw new Error("raw serial evidence exceeded 256 records");
    const raw =
      normalizedAfterSequence === null
        ? journal
        : journal.filter(
            (frame: SerialFrame) =>
              Number.isSafeInteger(frame.sequence) &&
              Number(frame.sequence) > normalizedAfterSequence,
          );
    const protocolFrames = raw.filter(
      (frame: SerialFrame) =>
        frame.parsedOpcode !== undefined &&
        Object.hasOwn(RAW_PROTOCOL_DIRECTIONS, frame.parsedOpcode),
    );
    for (const frame of protocolFrames) {
      const expectedDirections = (
        RAW_PROTOCOL_DIRECTIONS as Record<string, string | string[]>
      )[String(frame.parsedOpcode ?? "")];
      const allowedDirections = Array.isArray(expectedDirections)
        ? expectedDirections
        : [expectedDirections];
      if (!allowedDirections.includes(String(frame.direction))) {
        throw new Error(
          `${frame.parsedOpcode} has invalid serial direction ${frame.direction}`,
        );
      }
    }
    const normalizedProtocolFrames =
      collapseRepeatedStateFrames(protocolFrames);
    const opcodes = normalizedProtocolFrames.map((frame) => frame.parsedOpcode);
    if (opcode === "VEND" && opcodes.includes("F0")) {
      throw new Error("F0 appeared before the before-F0 gate was released");
    }
    if (
      !["F2", "E6"].includes(opcode) &&
      opcodes.includes("F2") &&
      !opcodes.includes(opcode)
    ) {
      throw new Error(`F2 appeared before required ${opcode} boundary`);
    }
    const boundaryIndex = opcodes.indexOf(opcode);
    if (boundaryIndex >= 0) {
      const prefix = normalizedProtocolFrames.slice(0, boundaryIndex + 1);
      const milestones = orderedMilestoneFrames(prefix, expected);
      if (!milestones) {
        throw new Error(
          `raw serial protocol order must contain ${expected.join(" -> ")}; observed ${prefix.map((frame) => frame.parsedOpcode).join(" -> ")}`,
        );
      }
      return {
        parsedOpcode: opcode,
        frame: milestones.at(-1),
        protocolFrames: milestones,
        observedProtocolFrames: prefix,
      };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for inbound ${opcode}`);
}

function releaseSessionF0(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const session = requireSession(server, input.sessionId);
  const path = adapterSessionPaths(session).releaseF0Path;
  writeFileSync(String(path), `${new Date().toISOString()}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { released: true, releaseFile: path };
}

function adapterSessionPaths(
  session: SerialSession,
): ReturnType<typeof qemuUsbSerialSessionPaths> {
  const adapterRoot = required(
    process.env.VEM_VM_HOST_ADAPTER_STATE_ROOT,
    "VEM_VM_HOST_ADAPTER_STATE_ROOT",
  );
  return qemuUsbSerialSessionPaths(
    adapterRoot,
    session.binding.serialSessionId,
  );
}

async function waitForSessionFrame(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const session = requireSession(server, input.sessionId);
  const boundary = await waitForRawSerialFrame({
    journalPath: adapterSessionPaths(session).journalPath,
    parsedOpcode: required(input.parsedOpcode, "parsedOpcode"),
    afterSequence: input.afterSequence,
    serialScenario: normalizeSerialScenario(
      input.serialScenario ?? session.serialScenario,
    ),
    timeoutMs: Number(input.timeoutMs ?? 30_000),
  });
  session.frozenMilestoneFrames = mergeFrozenSerialMilestones({
    sessionId: session.binding.serialSessionId,
    existing: session.frozenMilestoneFrames,
    boundary,
  });
  return boundary as unknown as Record<string, unknown>;
}

async function stopScannerBindingProbe(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const session = requireSession(server, input.sessionId);
  const root = required(
    process.env.VEM_VM_HOST_ADAPTER_STATE_ROOT,
    "VEM_VM_HOST_ADAPTER_STATE_ROOT",
  );
  const serialSessionId = session.binding.serialSessionId;
  const paths = qemuUsbSerialSessionPaths(root, serialSessionId);
  try {
    return {
      sessionId: session.id,
      scannerBindingProbe: await stopQemuScannerBindingProbe({
        stateRoot: root,
        serialSessionId,
        reason: "daemon_binding_confirmed",
      }),
    };
  } catch (error) {
    if (!isErrnoCode(error, "ESRCH")) throw error;
    const state = JSON.parse(
      readFileSync(String(paths.statePath), "utf8"),
    ) as Record<string, unknown>;
    return {
      sessionId: session.id,
      scannerBindingProbe: {
        ...(state.scannerBindingProbe as Record<string, unknown>),
        stoppedAt: new Date().toISOString(),
        stopReason: "daemon_binding_confirmed",
        alreadyExited: true,
      },
    };
  }
}

function releaseSessionF2(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const session = requireSession(server, input.sessionId);
  const path = adapterSessionPaths(session).releaseF2Path;
  writeFileSync(String(path), `${new Date().toISOString()}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { released: true, releaseFile: path };
}

function collectPlatformLog(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const rawLines = input.lines;
  const lines =
    typeof rawLines === "number" && Number.isInteger(rawLines)
      ? rawLines
      : Number(rawLines ?? 200);
  const lineCount =
    Number.isInteger(lines) && lines > 0 ? Math.min(lines, 400) : 200;
  const result = spawnSync(
    "journalctl",
    [
      "--unit",
      "vem-local-testbed-service-api.service",
      "--no-pager",
      "--lines",
      String(lineCount),
      "--output",
      "short-iso-precise",
    ],
    { encoding: "utf8" },
  );
  const stdout = String(result.stdout ?? "");
  const boundedStdout = stdout.slice(-64 * 1024);
  const stderr = String(result.stderr ?? "").slice(-8 * 1024);
  if (result.status !== 0) {
    throw new Error(
      `journalctl exited with ${result.status}: ${
        boundedStdout.trim() || stderr.trim() || "stdout was empty"
      }`,
    );
  }
  if (boundedStdout.trim() === "") {
    throw new Error("journalctl returned empty stdout");
  }
  const session = input.sessionId
    ? requireSession(server, input.sessionId)
    : null;
  const paths = session ? adapterSessionPaths(session) : null;
  const logPath = paths
    ? join(String(paths.directory), "platform-service-api.log")
    : null;
  if (logPath) writeFileSync(logPath, boundedStdout, { mode: 0o600 });
  return {
    unit: "vem-local-testbed-service-api.service",
    lineCount,
    log: boundedStdout,
    reference: logPath,
  };
}

function boundedSessionEvidence(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const session = requireSession(server, input.sessionId);
  const paths = adapterSessionPaths(session);
  const simulatorLog = existsSync(String(paths.logPath))
    ? readFileSync(String(paths.logPath), "utf8").slice(-64 * 1024)
    : "";
  const rawFrameLimitValue = input.rawFrameLimit;
  const rawFrameLimit =
    typeof rawFrameLimitValue === "number" &&
    Number.isSafeInteger(rawFrameLimitValue) &&
    rawFrameLimitValue >= 64 &&
    rawFrameLimitValue <= 1_024
      ? rawFrameLimitValue
      : 64;
  const tailFrames = readRawSerialJournal(String(paths.journalPath))
    .slice(-rawFrameLimit)
    .map((frame) => ({
      ...frame,
      sessionId: session.binding.serialSessionId,
      provenance: "host_pty_raw_serial_journal",
    }));
  const rawFrames = mergeFrozenSerialMilestones({
    sessionId: session.binding.serialSessionId,
    existing: session.frozenMilestoneFrames,
    boundary: { protocolFrames: tailFrames },
  });
  return {
    serialSessionId: session.binding.serialSessionId,
    saleBinding: session.sale ?? null,
    rawFrames: rawFrames.map((frame) => ({
      ...frame,
      boundaryId: `host-pty:${session.binding.serialSessionId}:${frame.sequence}`,
    })),
    mqtt: {
      ...session.mqttCapture.snapshot(),
      messages: session.mqttCapture.snapshot().messages.slice(-4),
    },
    machineMqtt: {
      ...session.machineMqttCapture.snapshot(),
      messages: session.machineMqttCapture.snapshot().messages.slice(-40),
    },
    deviceLifecycle: session.deviceLifecycle ?? [],
    simulatorLog,
    references: {
      journal: paths.journalPath,
      simulatorLog: paths.logPath,
    },
  };
}

function normalizeLifecycleRole(value: unknown): string {
  const role = required(value, "role");
  if (role === "lower_controller") return "lower-controller";
  if (role === "lower-controller" || role === "scanner") return role;
  throw new Error("role must be lower-controller or scanner");
}

function normalizeLifecycleOperation(
  value: unknown,
): "disconnect" | "reconnect" {
  const operation = required(value, "operation");
  if (operation !== "disconnect" && operation !== "reconnect") {
    throw new Error("operation must be disconnect or reconnect");
  }
  return operation;
}

export function serialDeviceXmlForRole(
  domainXml: unknown,
  role: unknown,
): string {
  const targetPort =
    normalizeLifecycleRole(role) === "lower-controller" ? 0 : 1;
  const serialDevices =
    String(domainXml ?? "").match(/<serial\b[\s\S]*?<\/serial>/g) ?? [];
  const device = serialDevices.find((candidate) =>
    new RegExp(`<target\\b[^>]*\\bport=(['"])${targetPort}\\1`).test(candidate),
  );
  if (!device) {
    throw new Error(
      `live libvirt domain XML omitted ${normalizeLifecycleRole(role)} target port ${targetPort}`,
    );
  }
  return device;
}

function runVirshDeviceLifecycle(
  server: ControlPlaneServerState,
  {
    role,
    operation,
    xml,
  }: {
    role: unknown;
    operation: unknown;
    xml: unknown;
  },
): Record<string, unknown> {
  const paths = qemuUsbSerialSessionPaths(
    server.options.stateRoot,
    `host-control-plane-device-${role}-${operation}-${randomUUID()}`,
  );
  mkdirSync(String(paths.directory), { recursive: true, mode: 0o700 });
  const xmlPath = join(String(paths.directory), `${role}-${operation}.xml`);
  writeFileSync(xmlPath, `${xml}\n`, { mode: 0o600 });
  const command =
    operation === "disconnect" ? "detach-device" : "attach-device";
  const result = spawnSync(
    "virsh",
    [
      "--connect",
      server.options.libvirtUri,
      command,
      server.options.domainName,
      xmlPath,
      "--live",
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `virsh ${command} ${role} failed: ${(result.stderr || result.stdout || "").trim() || result.error?.message || `exit ${result.status ?? 1}`}`,
    );
  }
  return {
    command,
    xmlPath,
    stdout: String(result.stdout ?? "")
      .trim()
      .slice(-4 * 1024),
    stderr: String(result.stderr ?? "")
      .trim()
      .slice(-4 * 1024),
  };
}

function dumpDomainXml(server: ControlPlaneServerState): string {
  const result = spawnSync(
    "virsh",
    [
      "--connect",
      server.options.libvirtUri,
      "dumpxml",
      server.options.domainName,
    ],
    { encoding: "utf8", timeout: 30_000 },
  );
  if (result.status !== 0) {
    throw new Error(
      `virsh dumpxml failed: ${(result.stderr || result.stdout || "").trim() || result.error?.message || `exit ${result.status ?? 1}`}`,
    );
  }
  return String(result.stdout ?? "");
}

function serialDeviceLifecycle(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const session = requireSession(server, input.sessionId);
  const role = normalizeLifecycleRole(input.role);
  const operation = normalizeLifecycleOperation(input.operation);
  const domainXml = dumpDomainXml(server);
  const xml =
    operation === "reconnect" && session.detachedDeviceXml?.[role]
      ? session.detachedDeviceXml[role]
      : serialDeviceXmlForRole(domainXml, role);
  const before = parseLibvirtUsbSerialMappings(domainXml, {
    requireAll: false,
  }).filter((mapping) => mapping.role === role);
  const virsh = runVirshDeviceLifecycle(server, { role, operation, xml });
  if (operation === "disconnect") {
    session.detachedDeviceXml = {
      ...(session.detachedDeviceXml ?? {}),
      [role]: xml,
    };
  } else {
    delete session.detachedDeviceXml[role];
  }
  const afterXml = dumpDomainXml(server);
  const after = parseLibvirtUsbSerialMappings(afterXml, {
    requireAll: false,
  }).filter((mapping) => mapping.role === role);
  const lifecycle = {
    role,
    operation,
    libvirtUri: server.options.libvirtUri,
    domainName: server.options.domainName,
    beforeMappingCount: before.length,
    afterMappingCount: after.length,
    evidence: virsh,
    capturedAt: new Date().toISOString(),
  };
  session.deviceLifecycle.push(lifecycle);
  return { sessionId: session.id, lifecycle };
}

function audioCaptureProductionBinding(
  server: ControlPlaneServerState,
  session: SerialSession,
): Record<string, unknown> {
  const paths = adapterSessionPaths(session);
  return {
    libvirtUri: server.options.libvirtUri,
    domainName: server.options.domainName,
    serialJournalPath: paths.journalPath,
  };
}

function requireAudioCapture(
  server: ControlPlaneServerState,
  audioCaptureId: unknown,
): AudioCaptureSession {
  const capture = server.audioCaptures.get(
    required(audioCaptureId, "audioCaptureId"),
  );
  if (!capture) throw new Error("audio capture session was not found");
  return capture;
}

function audioCaptureEvidencePayloads(
  capture: AudioCaptureSession,
): Array<{ fileName: string; bytesBase64: string }> {
  return (capture.stopReport?.evidence ?? []).map((artifact) => ({
    fileName: artifact.fileName,
    bytesBase64: readFileSync(
      join(capture.evidenceDirectory, artifact.fileName),
    ).toString("base64"),
  }));
}

async function startAudioCapture(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const session = requireSession(server, input.sessionId);
  const runtime = runtimeBinding(input.runtime);
  const operationId = required(input.operationId, "operationId");
  const existingId = server.audioCapturesByOperation.get(operationId);
  if (existingId) {
    const existing = requireAudioCapture(server, existingId);
    return {
      audioCaptureId: existing.id,
      startReport: existing.startReport,
      repeated: true,
    };
  }
  const audioCaptureId = `audio-capture-${randomUUID()}`;
  const evidenceDirectory = join(session.dir, "host-default-audio");
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const outPath = join(session.dir, "audio-capture-start.json");
  const startInput = {
    runId: required(input.runId, "runId"),
    lifecycleReference: required(
      input.lifecycleReference,
      "lifecycleReference",
    ),
    targetIdentity: required(input.targetIdentity, "targetIdentity"),
    transactionId: required(input.transactionId, "transactionId"),
  };
  const startReport = (await server.dependencies.executeSaleAudioCapture(
    {
      phase: "start",
      runId: startInput.runId,
      lifecycleReference: startInput.lifecycleReference,
      targetIdentity: startInput.targetIdentity,
      transactionId: startInput.transactionId,
      runtime: cloneJson(runtime),
      evidenceDirectory,
      outPath,
      production: audioCaptureProductionBinding(server, session),
    },
    {},
  )) as AudioCaptureSession["startReport"];
  server.audioCaptures.set(audioCaptureId, {
    id: audioCaptureId,
    operationId,
    sessionId: session.id,
    startInput,
    startReport,
    runtime,
    evidenceDirectory,
    cancelledAt: null,
    stopReport: null,
  });
  server.audioCapturesByOperation.set(operationId, audioCaptureId);
  return {
    audioCaptureId,
    startReport,
    repeated: false,
  };
}

async function stopAudioCapture(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const capture = requireAudioCapture(server, input.audioCaptureId);
  if (capture.stopReport) {
    return {
      audioCaptureId: capture.id,
      stopReport: capture.stopReport,
      evidencePayloads: audioCaptureEvidencePayloads(capture),
      repeated: true,
    };
  }
  const session = requireSession(server, capture.sessionId);
  const outPath = join(session.dir, "audio-capture-stop.json");
  capture.stopReport = (
    input.captureKind === "default-audio"
      ? await server.dependencies.stopDefaultAudioCapture(
          {
            captureSessionId:
              capture.startReport.captureSession.captureSessionId,
            evidenceDirectory: capture.evidenceDirectory,
          },
          { production: audioCaptureProductionBinding(server, session) },
        )
      : await server.dependencies.executeSaleAudioCapture(
          {
            phase: "stop",
            runId: capture.startInput.runId,
            lifecycleReference: capture.startInput.lifecycleReference,
            targetIdentity: capture.startInput.targetIdentity,
            transactionId: capture.startInput.transactionId,
            runtime: cloneJson(capture.runtime),
            captureSessionId:
              capture.startReport.captureSession.captureSessionId,
            startOperationReference:
              capture.startReport.captureSession.startOperationReference,
            captureStartedAt: capture.startReport.captureSession.startedAt,
            sale: {
              saleCorrelationId: required(
                input.saleCorrelationId,
                "saleCorrelationId",
              ),
              orderId: required(input.orderId, "orderId"),
              orderNo: required(input.orderNo, "orderNo"),
              commandId: required(input.commandId, "commandId"),
              commandNo: required(input.commandNo, "commandNo"),
            },
            evidenceDirectory: capture.evidenceDirectory,
            outPath,
            production: audioCaptureProductionBinding(server, session),
          },
          {},
        )
  ) as NonNullable<AudioCaptureSession["stopReport"]>;
  return {
    audioCaptureId: capture.id,
    stopReport: capture.stopReport,
    evidencePayloads: audioCaptureEvidencePayloads(capture),
    repeated: false,
  };
}

async function cancelAudioCapture(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const capture = requireAudioCapture(server, input.audioCaptureId);
  if (capture.stopReport) {
    return {
      audioCaptureId: capture.id,
      status: "stopped",
      cancelled: false,
    };
  }
  if (!capture.cancelledAt) {
    await server.dependencies.abortSaleAudioCapture(
      {
        captureSessionId: capture.startReport.captureSession.captureSessionId,
        evidenceDirectory: capture.evidenceDirectory,
      },
      {
        production: audioCaptureProductionBinding(
          server,
          requireSession(server, capture.sessionId),
        ),
      },
    );
    capture.cancelledAt = new Date().toISOString();
  }
  return {
    audioCaptureId: capture.id,
    status: "cancelled",
    cancelled: true,
    cancelledAt: capture.cancelledAt,
  };
}

async function cancelAudioCaptureByOperation(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operationId = required(input.operationId, "operationId");
  const captureId = server.audioCapturesByOperation.get(operationId);
  if (!captureId)
    return { operationId, status: "not-started", cancelled: false };
  return {
    operationId,
    ...(await cancelAudioCapture(server, { audioCaptureId: captureId })),
  };
}

function audioCaptureDiagnostics(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const capture = requireAudioCapture(server, input.audioCaptureId);
  return {
    audioCaptureId: capture.id,
    sessionId: capture.sessionId,
    status: capture.stopReport
      ? "stopped"
      : capture.cancelledAt
        ? "cancelled"
        : "started",
    evidenceDirectory: capture.evidenceDirectory,
    captureSession: capture.startReport.captureSession,
    cancelledAt: capture.cancelledAt,
    startReport: capture.startReport,
    stopReport: capture.stopReport,
  };
}

function bindSale(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const session = requireSession(server, input.sessionId);
  const sale = {
    saleCorrelationId: session.saleCorrelationId,
    orderId: required(input.orderId, "orderId"),
    paymentId: required(input.paymentId, "paymentId"),
    vendingCommandId: required(input.vendingCommandId, "vendingCommandId"),
  };
  if (
    session.sale &&
    (session.sale.orderId !== sale.orderId ||
      session.sale.paymentId !== sale.paymentId ||
      (session.sale.vendingCommandId &&
        session.sale.vendingCommandId !== sale.vendingCommandId))
  ) {
    throw new Error("serial session is already bound to another sale");
  }
  session.sale = sale;
  return { saleBinding: sale };
}

async function waitForProcessGroupExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (isErrnoCode(error, "ESRCH")) return true;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (isErrnoCode(error, "ESRCH")) return true;
    throw error;
  }
}

async function abortProcessGroup(
  label: string,
  pid: unknown,
): Promise<Record<string, unknown>> {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid < 1)
    return { label, pid: null, exitedAfter: "not_started" };
  try {
    process.kill(-numericPid, "SIGTERM");
  } catch (error) {
    if (isErrnoCode(error, "ESRCH"))
      return { label, pid: numericPid, exitedAfter: "already_exited" };
    throw error;
  }
  if (await waitForProcessGroupExit(numericPid, 3_000))
    return { label, pid: numericPid, exitedAfter: "SIGTERM" };
  process.kill(-numericPid, "SIGKILL");
  if (await waitForProcessGroupExit(numericPid, 1_000))
    return { label, pid: numericPid, exitedAfter: "SIGKILL" };
  throw new Error(
    `${label} process group ${numericPid} survived abort SIGTERM and SIGKILL`,
  );
}

async function abortSession(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const session = requireSession(server, input.sessionId);
  const paths = adapterSessionPaths(session);
  const cleanup: {
    termination: Array<Record<string, unknown>>;
    errors: string[];
    survivingProcessCount: number;
    survivingSocketCount: number;
  } = {
    termination: [],
    errors: [],
    survivingProcessCount: 0,
    survivingSocketCount: 0,
  };
  for (const [role, xml] of Object.entries(session.detachedDeviceXml ?? {})) {
    try {
      const evidence = runVirshDeviceLifecycle(server, {
        role,
        operation: "reconnect",
        xml,
      });
      session.deviceLifecycle.push({
        role,
        operation: "reconnect",
        libvirtUri: server.options.libvirtUri,
        domainName: server.options.domainName,
        beforeMappingCount: null,
        afterMappingCount: null,
        evidence,
        capturedAt: new Date().toISOString(),
        cleanup: true,
      });
      delete session.detachedDeviceXml[role];
    } catch (error) {
      cleanup.errors.push(
        `restore ${role}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (existsSync(String(paths.statePath))) {
    const state = JSON.parse(
      readFileSync(String(paths.statePath), "utf8"),
    ) as Record<string, unknown>;
    const statePids: Array<[string, unknown]> = [
      ["lower-controller simulator", state.simulatorPid],
      ["host PTY capture", state.ptyCapturePid],
      [
        "scanner binding probe",
        (state.scannerBindingProbe as { pid?: unknown } | null | undefined)
          ?.pid,
      ],
    ];
    for (const [label, pid] of statePids) {
      try {
        cleanup.termination.push(await abortProcessGroup(label, pid));
      } catch (error) {
        cleanup.errors.push(
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    state.active = false;
    state.cleanupAttemptCount = Number(state.cleanupAttemptCount ?? 0) + 1;
    const pids = statePids
      .map(([, pid]) => Number(pid))
      .filter((pid) => Number.isInteger(pid) && pid >= 1);
    cleanup.survivingProcessCount = pids.filter((pid) => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        if (isErrnoCode(error, "ESRCH")) return false;
        throw error;
      }
    }).length;
    const runtimeSocketPaths = Array.isArray(state.runtimeSocketPaths)
      ? (state.runtimeSocketPaths as string[])
      : [];
    cleanup.survivingSocketCount = runtimeSocketPaths.filter((path: string) =>
      existsSync(path),
    ).length;
    state.cleanup = cleanup;
    writeFileSync(
      String(paths.statePath),
      `${JSON.stringify(state, null, 2)}\n`,
      {
        mode: 0o600,
      },
    );
  }
  session.mqttCapture.stop();
  session.machineMqttCapture.stop();
  if (
    cleanup.errors.length ||
    cleanup.survivingProcessCount ||
    cleanup.survivingSocketCount
  ) {
    throw new Error(
      `serial session abort cleanup failed: ${JSON.stringify(cleanup)}`,
    );
  }
  return { aborted: true, cleanup };
}

async function abortExistingSerialSessions(
  server: ControlPlaneServerState,
): Promise<void> {
  for (const session of [...server.sessions.values()]) {
    await abortSession(server, { sessionId: session.id });
    server.sessions.delete(session.id);
  }
}

async function executePlatformQuery(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Promise<unknown> {
  const sessionId = input.sessionId
    ? required(input.sessionId, "sessionId")
    : null;
  const session = sessionId ? server.sessions.get(sessionId) : null;
  const outPath =
    input.outPath && typeof input.outPath === "string"
      ? input.outPath
      : join(
          session?.dir ?? join(server.options.stateRoot, "fast-route"),
          `platform-${Date.now()}.json`,
        );
  ensureParent(outPath);
  const command = buildPlatformQueryCommand({
    workspace: server.options.workspace,
    runId: required(input.runId ?? session?.runId, "runId"),
    machineCode: required(
      input.machineCode ?? session?.machineCode,
      "machineCode",
    ),
    outPath,
  });
  const { stdout } = await runJsonCommand(command);
  return parseJsonLine(stdout, outPath);
}

async function injectPlatformPaymentExpiry(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Promise<unknown> {
  const command = buildPaymentExpiryInjectionCommand({
    workspace: server.options.workspace,
    runId: required(input.runId, "runId"),
    machineCode: required(input.machineCode, "machineCode"),
    paymentId: required(input.paymentId, "paymentId"),
    expiresAt: required(input.expiresAt, "expiresAt"),
  });
  const { stdout } = await runJsonCommand(command);
  return parseJsonLine(stdout);
}

async function createSerialSession(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await abortExistingSerialSessions(server);
  const runId = required(input.runId, "runId");
  const machineCode = required(input.machineCode, "machineCode");
  const serialScenario = normalizeSerialScenario(input.serialScenario);
  const saleCorrelationId = required(
    input.saleCorrelationId ?? `sale-correlation-${randomUUID()}`,
    "saleCorrelationId",
  );
  const sessionId = `fast-sale-${randomUUID()}`;
  const dir = join(server.options.stateRoot, "fast-route", sessionId);
  mkdirSync(dir, { recursive: true });
  const outPath = join(dir, "start.json");
  const command = buildSerialOperationCommand({
    workspace: server.options.workspace,
    stateRoot: server.options.stateRoot,
    request: {
      operation: "start-serial-session",
      runId,
      targetIdentity: required(input.targetIdentity, "targetIdentity"),
      runtimeBase: required(input.runtimeBase, "runtimeBase"),
      serialScenario,
      saleCorrelationId,
      outPath,
    },
  });
  const { stdout } = await runJsonCommand(command);
  const report = parseJsonLine(stdout, outPath) as SerialSessionStartReport;
  const mqttCaptureFactory =
    server.dependencies.mqttCaptureFactory ?? spawnMqttCapture;
  const mqttCapture = mqttCaptureFactory({ machineCode });
  const machineMqttCapture = mqttCaptureFactory({
    machineCode,
    topic: buildMachineMqttTopic(machineCode),
    limit: 40,
  });
  const session = {
    id: sessionId,
    dir,
    runId,
    machineCode,
    targetIdentity: required(input.targetIdentity, "targetIdentity"),
    runtimeBase: required(input.runtimeBase, "runtimeBase"),
    saleCorrelationId,
    serialScenario,
    startReport: report,
    binding: {
      serialSessionId: report.serialSession.serialSessionId,
      sessionBindingToken: report.serialSession.sessionBindingToken,
      startOperationReference: report.serialSession.startOperationReference,
      deviceMappingDigest: report.serialSession.deviceMappingDigest,
    },
    frozenMilestoneFrames: [] as unknown[],
    mqttCapture,
    machineMqttCapture,
    deviceLifecycle: [] as Array<Record<string, unknown>>,
    detachedDeviceXml: {},
    injectReport: null,
    collectReport: null,
    stopReports: [] as unknown[],
    sale: null,
  };
  server.sessions.set(sessionId, session);
  try {
    await Promise.all([mqttCapture.ready, machineMqttCapture.ready]);
  } catch (error) {
    const mqttSnapshot = mqttCapture.snapshot();
    const machineMqttSnapshot = machineMqttCapture.snapshot();
    let cleanup = null;
    let cleanupError = null;
    try {
      cleanup = await abortSession(server, { sessionId });
    } catch (abortError) {
      cleanupError =
        abortError instanceof Error ? abortError.message : String(abortError);
      mqttCapture.stop();
      machineMqttCapture.stop();
    } finally {
      server.sessions.delete(sessionId);
    }
    throw new TestbedInfrastructureError(
      `MQTT capture readiness failed before customer flow: ${error instanceof Error ? error.message : String(error)}`,
      {
        stage: "mqtt_capture_ready",
        machineCode,
        serialSessionId: report.serialSession?.serialSessionId ?? null,
        sessionCleanup: cleanup,
        sessionCleanupError: cleanupError,
        mqtt: {
          topic: mqttSnapshot.topic,
          stderr: mqttSnapshot.stderr,
          messageCount: mqttSnapshot.messages.length,
        },
        machineMqtt: {
          topic: machineMqttSnapshot.topic,
          stderr: machineMqttSnapshot.stderr,
          messageCount: machineMqttSnapshot.messages.length,
        },
      },
    );
  }
  return {
    sessionId,
    saleCorrelationId,
    serialScenario,
    binding: session.binding,
    qemuUsbSerialMappings: report.serialSession.deviceMappings,
    startReport: summarizeReport(report),
  };
}

function requireSession(
  server: ControlPlaneServerState,
  sessionId: unknown,
): SerialSession {
  const session = server.sessions.get(required(sessionId, "sessionId"));
  if (!session) throw new Error("serial session was not found");
  return session;
}

async function injectScannerCode(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const session = requireSession(server, input.sessionId);
  const sale = {
    saleCorrelationId: session.saleCorrelationId,
    orderId: required(input.orderId, "orderId"),
    paymentId: required(input.paymentId, "paymentId"),
  };
  const runnerTemp = runnerTempRoot(server.options.stateRoot);
  const scannerBytes =
    typeof input.scannerCodeBase64 === "string"
      ? Buffer.from(input.scannerCodeBase64, "base64")
      : required(input.scannerCode, "scannerCode");
  const scannerCodeFile = writeProtectedTempFile(
    runnerTemp,
    "scanner-code",
    scannerBytes,
  );
  const outPath = join(session.dir, "inject.json");
  const command = buildSerialOperationCommand({
    workspace: server.options.workspace,
    stateRoot: server.options.stateRoot,
    request: {
      operation: "inject-scanner-code",
      runId: session.runId,
      targetIdentity: session.targetIdentity,
      runtimeBase: session.runtimeBase,
      sessionBinding: session.binding,
      sale,
      scannerCodeFile,
      outPath,
    },
  });
  const { stdout } = await runJsonCommand(command);
  const report = parseJsonLine(stdout, outPath) as SerialRunnerReport;
  session.injectReport = report;
  session.sale = {
    ...sale,
    vendingCommandId: null,
  };
  return {
    sessionId: session.id,
    injectReport: summarizeReport(report),
    scannerInjection: report.request?.serialSession?.scannerInjection,
  };
}

async function collectSerialEvidence(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const session = requireSession(server, input.sessionId);
  if (!session.injectReport) {
    throw new Error("inject-scanner-code must complete before collect");
  }
  const scannerInjection = (session.injectReport as SerialRunnerReport).request
    ?.serialSession?.scannerInjection;
  if (scannerInjection === undefined) {
    throw new Error("inject report is missing scanner injection evidence");
  }
  const sale = {
    saleCorrelationId: session.saleCorrelationId,
    orderId: required(input.orderId, "orderId"),
    paymentId: required(input.paymentId, "paymentId"),
    vendingCommandId: required(input.vendingCommandId, "vendingCommandId"),
  };
  const outPath = join(session.dir, "collect.json");
  const reportDigest = (report: unknown) =>
    `sha256:${createHash("sha256").update(JSON.stringify(report)).digest("hex")}`;
  const command = buildSerialOperationCommand({
    workspace: server.options.workspace,
    stateRoot: server.options.stateRoot,
    request: {
      operation: "collect-serial-evidence",
      runId: session.runId,
      targetIdentity: session.targetIdentity,
      runtimeBase: session.runtimeBase,
      sessionBinding: session.binding,
      sale,
      scannerInjection: {
        operationNonce: scannerInjection.operationNonce,
        scannerCodeDigest: scannerInjection.scannerCodeDigest,
        scannerCodeByteLength: scannerInjection.scannerCodeByteLength,
        scannerCodeSuffix: scannerInjection.scannerCodeSuffix,
      },
      operationEvidence: {
        runnerChallenge: `serial-runner-challenge://sha256-${randomBytes(32).toString("hex")}`,
        startReportDigest: reportDigest(session.startReport),
        injectReportDigest: reportDigest(session.injectReport),
      },
      outPath,
    },
  });
  const { stdout } = await runJsonCommand(command);
  const report = parseJsonLine(stdout, outPath) as SerialRunnerReport;
  session.collectReport = report;
  session.sale = sale;
  return {
    sessionId: session.id,
    collectReport: report,
    collectSummary: summarizeReport(report),
    mqtt: session.mqttCapture.snapshot(),
  };
}

async function stopSerialSession(
  server: ControlPlaneServerState,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const session = requireSession(server, input.sessionId);
  const sale = {
    saleCorrelationId:
      session.sale?.saleCorrelationId ?? session.saleCorrelationId,
    orderId: required(input.orderId ?? session.sale?.orderId, "orderId"),
    paymentId: required(
      input.paymentId ?? session.sale?.paymentId,
      "paymentId",
    ),
    vendingCommandId: required(
      input.vendingCommandId ?? session.sale?.vendingCommandId,
      "vendingCommandId",
    ),
  };
  const outPath = join(
    session.dir,
    input.idempotencyCheck === true ? "stop-idempotent.json" : "stop.json",
  );
  const command = buildSerialOperationCommand({
    workspace: server.options.workspace,
    stateRoot: server.options.stateRoot,
    request: {
      operation: "stop-serial-session",
      runId: session.runId,
      targetIdentity: session.targetIdentity,
      runtimeBase: session.runtimeBase,
      sessionBinding: session.binding,
      sale,
      idempotencyCheck: input.idempotencyCheck === true,
      outPath,
    },
  });
  const { stdout } = await runJsonCommand(command);
  const report = parseJsonLine(stdout, outPath) as SerialRunnerReport;
  session.stopReports.push(report);
  if (input.idempotencyCheck !== true) {
    session.mqttCapture.stop();
    session.machineMqttCapture.stop();
  }
  return {
    sessionId: session.id,
    stopReport: summarizeReport(report),
    mqtt: session.mqttCapture.snapshot(),
  };
}

function authorize(
  request: import("node:http").IncomingMessage,
  token: unknown,
): boolean {
  return request.headers.authorization === `Bearer ${token}`;
}

export function createHostSerialControlPlane(
  options: ControlPlaneOptions,
  dependencies: ControlPlaneDependencies = {},
): {
  sessions: Map<string, SerialSession>;
  audioCaptures: Map<string, AudioCaptureSession>;
  audioCapturesByOperation: Map<string, string>;
  listen: () => import("node:http").Server;
  close: () => Promise<void>;
} {
  const sessions = new Map<string, SerialSession>();
  const audioCaptures = new Map<string, AudioCaptureSession>();
  const audioCapturesByOperation = new Map<string, string>();
  const serverState = {
    options,
    sessions,
    audioCaptures,
    audioCapturesByOperation,
    dependencies: {
      executeSaleAudioCapture:
        dependencies.executeSaleAudioCapture ??
        executeSaleAudioCaptureHostAdapter,
      stopDefaultAudioCapture:
        dependencies.stopDefaultAudioCapture ?? stopDefaultAudioCaptureSession,
      abortSaleAudioCapture:
        dependencies.abortSaleAudioCapture ?? abortSaleAudioCaptureSession,
      mqttCaptureFactory: dependencies.mqttCaptureFactory,
    },
  };
  const server = createServer(async (request, response) => {
    try {
      if (!authorize(request, options.token)) {
        jsonResponse(response, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (request.method === "GET" && request.url === "/healthz") {
        jsonResponse(response, 200, { ok: true, sessionCount: sessions.size });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/platform/query") {
        jsonResponse(response, 200, {
          ok: true,
          report: await executePlatformQuery(
            serverState,
            await readRequestBody(request),
          ),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/platform/payment-expiry"
      ) {
        jsonResponse(response, 200, {
          ok: true,
          report: await injectPlatformPaymentExpiry(
            serverState,
            await readRequestBody(request),
          ),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/mock-payment-create-gate/arm"
      ) {
        jsonResponse(response, 200, {
          ok: true,
          ...armMockPaymentCreateGate(
            serverState,
            await readRequestBody(request),
          ),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/mock-payment-create-gate/status"
      ) {
        jsonResponse(response, 200, {
          ok: true,
          ...readMockPaymentCreateGateStatus(serverState),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/mock-payment-create-gate/release"
      ) {
        jsonResponse(response, 200, {
          ok: true,
          ...releaseMockPaymentCreateGate(
            serverState,
            await readRequestBody(request),
          ),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/mock-payment-create-gate/open"
      ) {
        jsonResponse(response, 200, {
          ok: true,
          ...openMockPaymentCreateGate(serverState),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/mock-payment-query-fault/arm"
      ) {
        jsonResponse(response, 200, {
          ok: true,
          ...armMockPaymentQueryFault(
            serverState,
            await readRequestBody(request),
          ),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/mock-payment-query-fault/status"
      ) {
        jsonResponse(response, 200, {
          ok: true,
          ...readMockPaymentQueryFault(serverState),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/mock-payment-query-fault/open"
      ) {
        jsonResponse(response, 200, {
          ok: true,
          ...openMockPaymentQueryFault(serverState),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/serial-sessions/start"
      ) {
        jsonResponse(response, 200, {
          ok: true,
          ...(await createSerialSession(
            serverState,
            await readRequestBody(request),
          )),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/audio-captures/start"
      ) {
        jsonResponse(response, 200, {
          ok: true,
          ...(await startAudioCapture(
            serverState,
            await readRequestBody(request),
          )),
        });
        return;
      }
      if (
        request.method === "POST" &&
        request.url === "/v1/audio-captures/cancel"
      ) {
        jsonResponse(response, 200, {
          ok: true,
          ...(await cancelAudioCaptureByOperation(
            serverState,
            await readRequestBody(request),
          )),
        });
        return;
      }
      const sessionMatch =
        request.url?.match(
          /^\/v1\/serial-sessions\/([^/]+)(?:\/(inject|wait-frame|release-f0|release-f2|bind-sale|platform-log|evidence|device-lifecycle|abort|collect|stop|stop-scanner-probe))?$/,
        ) ?? [];
      const audioCaptureMatch = request.url?.match(
        /^\/v1\/audio-captures\/([^/]+)\/(stop|cancel|abort|diagnostics)$/,
      );
      if (!sessionMatch && !audioCaptureMatch) {
        jsonResponse(response, 404, { ok: false, error: "not_found" });
        return;
      }
      if (audioCaptureMatch) {
        const [, audioCaptureId, action] = audioCaptureMatch;
        const body = { ...(await readRequestBody(request)), audioCaptureId };
        if (request.method === "POST" && action === "stop") {
          jsonResponse(response, 200, {
            ok: true,
            ...(await stopAudioCapture(serverState, body)),
          });
          return;
        }
        if (
          request.method === "POST" &&
          (action === "cancel" || action === "abort")
        ) {
          jsonResponse(response, 200, {
            ok: true,
            ...(await cancelAudioCapture(serverState, body)),
          });
          return;
        }
        if (request.method === "POST" && action === "diagnostics") {
          jsonResponse(response, 200, {
            ok: true,
            ...audioCaptureDiagnostics(serverState, body),
          });
          return;
        }
        jsonResponse(response, 404, { ok: false, error: "not_found" });
        return;
      }
      const [, sessionId, action] = sessionMatch;
      if (request.method === "GET" && !action) {
        const session = requireSession(serverState, sessionId);
        jsonResponse(response, 200, {
          ok: true,
          sessionId: session.id,
          mqtt: session.mqttCapture.snapshot(),
          binding: session.binding,
        });
        return;
      }
      const body = { ...(await readRequestBody(request)), sessionId };
      if (request.method === "POST" && action === "inject") {
        jsonResponse(response, 200, {
          ok: true,
          ...(await injectScannerCode(serverState, body)),
        });
        return;
      }
      if (request.method === "POST" && action === "wait-frame") {
        jsonResponse(response, 200, {
          ok: true,
          sessionId,
          ...(await waitForSessionFrame(serverState, body)),
        });
        return;
      }
      if (request.method === "POST" && action === "stop-scanner-probe") {
        jsonResponse(response, 200, {
          ok: true,
          ...(await stopScannerBindingProbe(serverState, body)),
        });
        return;
      }
      if (request.method === "POST" && action === "release-f0") {
        jsonResponse(response, 200, {
          ok: true,
          sessionId,
          ...releaseSessionF0(serverState, body),
        });
        return;
      }
      if (request.method === "POST" && action === "release-f2") {
        jsonResponse(response, 200, {
          ok: true,
          sessionId,
          ...releaseSessionF2(serverState, body),
        });
        return;
      }
      if (request.method === "POST" && action === "bind-sale") {
        jsonResponse(response, 200, {
          ok: true,
          sessionId,
          ...bindSale(serverState, body),
        });
        return;
      }
      if (request.method === "POST" && action === "platform-log") {
        jsonResponse(response, 200, {
          ok: true,
          sessionId,
          ...collectPlatformLog(serverState, { ...body, sessionId }),
        });
        return;
      }
      if (request.method === "POST" && action === "evidence") {
        jsonResponse(response, 200, {
          ok: true,
          sessionId,
          ...boundedSessionEvidence(serverState, body),
        });
        return;
      }
      if (request.method === "POST" && action === "device-lifecycle") {
        jsonResponse(response, 200, {
          ok: true,
          sessionId,
          ...serialDeviceLifecycle(serverState, body),
        });
        return;
      }
      if (request.method === "POST" && action === "abort") {
        if (!serverState.sessions.has(sessionId)) {
          jsonResponse(response, 200, {
            ok: true,
            sessionId,
            aborted: true,
            alreadyAbsent: true,
          });
          return;
        }
        const result = await abortSession(serverState, body);
        serverState.sessions.delete(sessionId);
        jsonResponse(response, 200, {
          ok: true,
          sessionId,
          ...result,
        });
        return;
      }
      if (request.method === "POST" && action === "collect") {
        jsonResponse(response, 200, {
          ok: true,
          ...(await collectSerialEvidence(serverState, body)),
        });
        return;
      }
      if (request.method === "POST" && action === "stop") {
        jsonResponse(response, 200, {
          ok: true,
          ...(await stopSerialSession(serverState, body)),
        });
        return;
      }
      jsonResponse(response, 404, { ok: false, error: "not_found" });
    } catch (error) {
      jsonResponse(response, 500, errorResponsePayload(error));
    }
  });
  return {
    sessions,
    audioCaptures,
    audioCapturesByOperation,
    listen() {
      mkdirSync(options.stateRoot, { recursive: true });
      server.listen(options.port, options.bind);
      return server;
    },
    async close() {
      for (const capture of audioCaptures.values()) {
        if (!capture.stopReport && !capture.cancelledAt) {
          try {
            await serverState.dependencies.abortSaleAudioCapture(
              {
                captureSessionId:
                  capture.startReport.captureSession.captureSessionId,
                evidenceDirectory: capture.evidenceDirectory,
              },
              {
                production: audioCaptureProductionBinding(
                  serverState,
                  requireSession(serverState, capture.sessionId),
                ),
              },
            );
          } catch {}
        }
      }
      for (const session of sessions.values()) {
        try {
          await abortSession(serverState, { sessionId: session.id });
        } catch {}
        session.mqttCapture?.stop();
      }
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
  };
}

async function main() {
  const options = parseHostSerialControlPlaneArgs(process.argv.slice(2));
  const controlPlane = createHostSerialControlPlane(options);
  controlPlane.listen();
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      bind: options.bind,
      port: options.port,
      stateRoot: options.stateRoot,
    })}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
