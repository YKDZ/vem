#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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
  paymentMockCreateGatePaths,
  readPaymentMockCreateGateStatus,
  writePaymentMockCreateGateState,
} from "./mock-payment-create-gate.mjs";
import { createProductionTransactionTrace } from "./production-transaction-trace.mjs";
import {
  qemuUsbSerialSessionPaths,
  readRawSerialJournal,
} from "./qemu-usb-serial-host-adapter.mjs";
import { runSaleAudioCaptureHostAdapterCli } from "./sale-audio-capture-host-adapter.mjs";

const MOSQUITTO_CONTAINER = "vem-local-testbed-mosquitto";
const PLATFORM_DATABASE_URL =
  process.env.VEM_LOCAL_TESTBED_PLATFORM_DATABASE_URL ??
  "postgresql://vem:vem_local_testbed_password@127.0.0.1:55432/vem_local_testbed";
const SERIAL_SCENARIOS = Object.freeze({
  NORMAL: "normal",
  DELAYED_PICKUP: "delayed-pickup",
});

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function absolute(value, label) {
  const path = required(value, label);
  if (!isAbsolute(path)) throw new Error(`${label} must be absolute`);
  return resolve(path);
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index === -1 ? undefined : args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

function positiveInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function runtimeBinding(runtime) {
  if (runtime === null || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new Error("runtime binding is required");
  }
  const processId = Number(runtime.processId);
  const sessionId = Number(runtime.sessionId);
  if (!Number.isInteger(processId) || processId < 1) {
    throw new Error("runtime.processId must be a positive integer");
  }
  if (!Number.isInteger(sessionId) || sessionId < 1) {
    throw new Error("runtime.sessionId must be a positive integer");
  }
  return {
    processId,
    executablePath: required(
      runtime.executablePath,
      "runtime.executablePath",
    ),
    principal: required(runtime.principal, "runtime.principal"),
    sessionId,
    cdpTargetId: required(runtime.cdpTargetId, "runtime.cdpTargetId"),
    cdpSessionId: required(runtime.cdpSessionId, "runtime.cdpSessionId"),
  };
}

export function parseHostSerialControlPlaneArgs(args) {
  return {
    workspace: absolute(option(args, "workspace"), "--workspace"),
    stateRoot: absolute(option(args, "state-root"), "--state-root"),
    bind: required(option(args, "bind"), "--bind"),
    port: positiveInteger(option(args, "port"), "--port"),
    token: required(option(args, "token"), "--token"),
  };
}

export function buildMqttTopic(machineCode) {
  return `vem/machines/${required(machineCode, "machineCode")}/commands/dispense`;
}

function normalizeSerialScenario(value) {
  if (value == null) return SERIAL_SCENARIOS.NORMAL;
  const scenario = String(value).trim().toLowerCase();
  if (!Object.values(SERIAL_SCENARIOS).includes(scenario)) {
    throw new Error("serialScenario must be normal or delayed-pickup");
  }
  return scenario;
}

function baseSerialArgs(request) {
  return [
    "scripts/testbed/run-vm-host-adapter.mjs",
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

function sessionArgs(sessionBinding) {
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

function saleArgs(sale) {
  return [
    "--sale-correlation-id",
    sale.saleCorrelationId,
    "--order-id",
    sale.orderId,
    "--payment-id",
    sale.paymentId,
  ];
}

export function buildSerialOperationCommand({ workspace, stateRoot, request }) {
  const args = baseSerialArgs(request);
  if (request.operation === "start-serial-session") {
    args.push("--sale-correlation-id", request.saleCorrelationId);
  } else {
    args.push(
      ...sessionArgs(request.sessionBinding),
      ...saleArgs(request.sale),
    );
    if (request.operation === "inject-scanner-code") {
      args.push("--scanner-code-file", request.scannerCodeFile);
    } else if (request.operation === "collect-serial-evidence") {
      args.push(
        "--vending-command-id",
        request.sale.vendingCommandId,
        "--scanner-injection-operation-nonce",
        request.scannerInjection.operationNonce,
        "--scanner-code-digest",
        request.scannerInjection.scannerCodeDigest,
        "--scanner-code-byte-length",
        String(request.scannerInjection.scannerCodeByteLength),
        "--scanner-code-suffix",
        request.scannerInjection.scannerCodeSuffix,
      );
    } else if (request.sale.vendingCommandId) {
      args.push("--vending-command-id", request.sale.vendingCommandId);
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

function buildPlatformQueryCommand({ workspace, runId, machineCode, outPath }) {
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

function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

function parseJsonLine(stdout, path) {
  const trimmed = String(stdout).trim();
  if (trimmed) {
    const lastLine = trimmed.split(/\r?\n/).at(-1);
    try {
      return JSON.parse(lastLine);
    } catch {}
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function audioBaseArgs({ input, outPath, evidenceDirectory, runtime, phase }) {
  return [
    "--operation",
    "capture-sale-audio",
    "--capture-phase",
    phase,
    "--run-id",
    required(input.runId, "runId"),
    "--lifecycle-reference",
    required(input.lifecycleReference, "lifecycleReference"),
    "--target-identity",
    required(input.targetIdentity, "targetIdentity"),
    "--transaction-id",
    required(input.transactionId, "transactionId"),
    "--machine-process-id",
    String(runtime.processId),
    "--machine-executable-path",
    runtime.executablePath,
    "--interactive-principal",
    runtime.principal,
    "--interactive-session-id",
    String(runtime.sessionId),
    "--cdp-target-id",
    runtime.cdpTargetId,
    "--cdp-session-id",
    runtime.cdpSessionId,
    "--evidence-dir",
    evidenceDirectory,
    "--out",
    outPath,
  ];
}

function audioStartArgs({ input, outPath, evidenceDirectory, runtime }) {
  return audioBaseArgs({
    input,
    outPath,
    evidenceDirectory,
    runtime,
    phase: "start",
  });
}

function audioStopArgs({ capture, input, outPath, evidenceDirectory, runtime }) {
  return [
    ...audioBaseArgs({
      input: {
        runId: capture.startInput.runId,
        lifecycleReference: capture.startInput.lifecycleReference,
        targetIdentity: capture.startInput.targetIdentity,
        transactionId: capture.startInput.transactionId,
      },
      outPath,
      evidenceDirectory,
      runtime,
      phase: "stop",
    }).slice(0, -4),
    "--capture-session-id",
    capture.startReport.captureSession.captureSessionId,
    "--start-operation-reference",
    capture.startReport.captureSession.startOperationReference,
    "--capture-started-at",
    capture.startReport.captureSession.startedAt,
    "--sale-correlation-id",
    required(input.saleCorrelationId, "saleCorrelationId"),
    "--order-id",
    required(input.orderId, "orderId"),
    "--order-no",
    required(input.orderNo, "orderNo"),
    "--command-id",
    required(input.commandId, "commandId"),
    "--command-no",
    required(input.commandNo, "commandNo"),
    "--evidence-dir",
    evidenceDirectory,
    "--out",
    outPath,
  ];
}

function runJsonCommand(command) {
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
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else
        reject(
          new Error(
            stderr ||
              stdout ||
              `${command.command} exited with ${code ?? "signal"}`,
          ),
        );
    });
  });
}

function readRequestBody(request) {
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

function jsonResponse(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

function runnerTempRoot(stateRoot) {
  const path = join(stateRoot, "runner-temp");
  mkdirSync(path, { recursive: true });
  return path;
}

export { paymentMockCreateGatePaths as mockPaymentCreateGatePaths } from "./mock-payment-create-gate.mjs";

function armMockPaymentCreateGate(server) {
  writePaymentMockCreateGateState(server.options.stateRoot, { state: "hold" });
  return {
    armedAt: new Date().toISOString(),
    state: "hold",
  };
}

function readMockPaymentCreateGateStatus(server) {
  return readPaymentMockCreateGateStatus(server.options.stateRoot);
}

function releaseMockPaymentCreateGate(server, input) {
  writePaymentMockCreateGateState(server.options.stateRoot, {
    state: "release",
    paymentNo: required(input.paymentNo, "paymentNo"),
  });
  return {
    releasedAt: new Date().toISOString(),
    state: "release",
  };
}

function openMockPaymentCreateGate(server) {
  writePaymentMockCreateGateState(server.options.stateRoot, { state: "open" });
  return {
    openedAt: new Date().toISOString(),
    state: "open",
  };
}

function writeProtectedTempFile(root, prefix, contents) {
  const directory = mkdtempSync(join(root, `${prefix}-`));
  const path = join(directory, `${prefix}.bin`);
  const bytes = Buffer.isBuffer(contents)
    ? contents
    : Buffer.from(String(contents), "utf8");
  writeFileSync(path, bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function spawnMqttCapture({ machineCode }) {
  const topic = buildMqttTopic(machineCode);
  const child = spawn(
    "docker",
    [
      "exec",
      MOSQUITTO_CONTAINER,
      "sh",
      "-lc",
      `mosquitto_sub -h 127.0.0.1 -p 1883 -t '${topic}' -C 4 -W 180`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const messages = [];
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        messages.push({ topic, payload: JSON.parse(trimmed) });
      } catch {
        messages.push({ topic, payload: trimmed });
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  return {
    child,
    stop() {
      child.kill("SIGTERM");
    },
    snapshot() {
      return { topic, messages: [...messages], stderr: stderr.trim() };
    },
  };
}

function summarizeReport(report) {
  return {
    result: report?.result ?? null,
    operation:
      report?.request?.operation ?? report?.request?.operationReference ?? null,
    serialSessionId: report?.serialSession?.serialSessionId ?? null,
  };
}

const RAW_PROTOCOL_DIRECTIONS = Object.freeze({
  VEND: "daemon-to-controller",
  F0: "controller-to-daemon",
  E5: "controller-to-daemon",
  F1: "controller-to-daemon",
  AF: "controller-to-daemon",
  F2: "controller-to-daemon",
});

export async function waitForRawSerialFrame({
  journalPath,
  parsedOpcode,
  serialScenario = SERIAL_SCENARIOS.NORMAL,
  timeoutMs = 30_000,
  pollMs = 25,
}) {
  const scenario = normalizeSerialScenario(serialScenario);
  const expected = {
    [SERIAL_SCENARIOS.NORMAL]: {
      VEND: ["VEND"],
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
  }[scenario]?.[parsedOpcode];
  if (!expected) throw new Error("parsedOpcode must be VEND, F0, F1, or F2");
  const deadline = Date.now() + timeoutMs;
  do {
    const raw = readRawSerialJournal(journalPath);
    if (raw.length > 256)
      throw new Error("raw serial evidence exceeded 256 records");
    const protocolFrames = raw.filter((frame) =>
      Object.hasOwn(RAW_PROTOCOL_DIRECTIONS, frame.parsedOpcode),
    );
    for (const frame of protocolFrames) {
      if (frame.direction !== RAW_PROTOCOL_DIRECTIONS[frame.parsedOpcode]) {
        throw new Error(
          `${frame.parsedOpcode} has invalid serial direction ${frame.direction}`,
        );
      }
    }
    const opcodes = protocolFrames.map((frame) => frame.parsedOpcode);
    if (parsedOpcode === "VEND" && opcodes.includes("F0")) {
      throw new Error("F0 appeared before the before-F0 gate was released");
    }
    if (
      parsedOpcode !== "F2" &&
      opcodes.includes("F2") &&
      !opcodes.includes(parsedOpcode)
    ) {
      throw new Error(`F2 appeared before required ${parsedOpcode} boundary`);
    }
    const boundaryIndex = opcodes.indexOf(parsedOpcode);
    if (boundaryIndex >= 0) {
      const prefix = protocolFrames.slice(0, boundaryIndex + 1);
      if (
        JSON.stringify(prefix.map((frame) => frame.parsedOpcode)) !==
        JSON.stringify(expected)
      ) {
        throw new Error(
          `raw serial protocol order must be ${expected.join(" -> ")}`,
        );
      }
      return { parsedOpcode, frame: prefix.at(-1), protocolFrames: prefix };
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, pollMs));
  } while (Date.now() < deadline);
  throw new Error(`timed out waiting for inbound ${parsedOpcode}`);
}

function releaseSessionF0(server, input) {
  const session = requireSession(server, input.sessionId);
  const path = adapterSessionPaths(session).releaseF0Path;
  writeFileSync(path, `${new Date().toISOString()}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { released: true, releaseFile: path };
}

function adapterSessionPaths(session) {
  const adapterRoot = required(
    process.env.VEM_VM_HOST_ADAPTER_STATE_ROOT,
    "VEM_VM_HOST_ADAPTER_STATE_ROOT",
  );
  return qemuUsbSerialSessionPaths(
    adapterRoot,
    session.binding.serialSessionId,
  );
}

async function waitForSessionFrame(server, input) {
  const session = requireSession(server, input.sessionId);
  const boundary = await waitForRawSerialFrame({
    journalPath: adapterSessionPaths(session).journalPath,
    parsedOpcode: required(input.parsedOpcode, "parsedOpcode"),
    serialScenario: normalizeSerialScenario(
      input.serialScenario ?? session.serialScenario,
    ),
    timeoutMs: Number(input.timeoutMs ?? 30_000),
  });
  session.productionTrace.controllerFrame(boundary.frame);
  return boundary;
}

function releaseSessionF2(server, input) {
  const session = requireSession(server, input.sessionId);
  const path = adapterSessionPaths(session).releaseF2Path;
  writeFileSync(path, `${new Date().toISOString()}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { released: true, releaseFile: path };
}

function collectPlatformLog(server, input) {
  const lines = Number.isInteger(input.lines)
    ? input.lines
    : Number(input.lines ?? 200);
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
    ? join(paths.directory, "platform-service-api.log")
    : null;
  if (logPath) writeFileSync(logPath, boundedStdout, { mode: 0o600 });
  return {
    unit: "vem-local-testbed-service-api.service",
    lineCount,
    log: boundedStdout,
    reference: logPath,
  };
}

function boundedSessionEvidence(server, input) {
  const session = requireSession(server, input.sessionId);
  const paths = adapterSessionPaths(session);
  const simulatorLog = existsSync(paths.logPath)
    ? readFileSync(paths.logPath, "utf8").slice(-64 * 1024)
    : "";
  return {
    serialSessionId: session.binding.serialSessionId,
    rawFrames: readRawSerialJournal(paths.journalPath).slice(-64),
    productionTransactionTrace: session.productionTrace.entries(),
    mqtt: {
      ...session.mqttCapture.snapshot(),
      messages: session.mqttCapture.snapshot().messages.slice(-4),
    },
    simulatorLog,
    references: {
      journal: paths.journalPath,
      simulatorLog: paths.logPath,
    },
  };
}

function audioCaptureEnvironment(session) {
  const paths = adapterSessionPaths(session);
  return {
    ...process.env,
    RUNNER_TEMP: runnerTempRoot(session.dir),
    VEM_VM_HOST_AUDIO_SERIAL_JOURNAL: paths.journalPath,
    VEM_VM_HOST_AUDIO_SIMULATOR_LOG: paths.logPath,
  };
}

function requireAudioCapture(server, audioCaptureId) {
  const capture = server.audioCaptures.get(required(audioCaptureId, "audioCaptureId"));
  if (!capture) throw new Error("audio capture session was not found");
  return capture;
}

async function startAudioCapture(server, input) {
  const session = requireSession(server, input.sessionId);
  const runtime = runtimeBinding(input.runtime);
  const audioCaptureId = `audio-capture-${randomUUID()}`;
  const evidenceDirectory = join(session.dir, "host-default-audio");
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const outPath = join(session.dir, "audio-capture-start.json");
  const startInput = {
    runId: required(input.runId, "runId"),
    lifecycleReference: required(input.lifecycleReference, "lifecycleReference"),
    targetIdentity: required(input.targetIdentity, "targetIdentity"),
    transactionId: required(input.transactionId, "transactionId"),
  };
  const startReport = await runSaleAudioCaptureHostAdapterCli(
    audioStartArgs({
      input: startInput,
      outPath,
      evidenceDirectory,
      runtime,
    }),
    {
      environment: audioCaptureEnvironment(session),
    },
  );
  server.audioCaptures.set(audioCaptureId, {
    id: audioCaptureId,
    sessionId: session.id,
    startInput,
    startReport,
    runtime,
    evidenceDirectory,
    cancelledAt: null,
    stopReport: null,
  });
  return {
    audioCaptureId,
    startReport,
  };
}

async function stopAudioCapture(server, input) {
  const capture = requireAudioCapture(server, input.audioCaptureId);
  if (capture.stopReport) {
    return {
      audioCaptureId: capture.id,
      stopReport: capture.stopReport,
      repeated: true,
    };
  }
  const session = requireSession(server, capture.sessionId);
  const outPath = join(session.dir, "audio-capture-stop.json");
  capture.stopReport = await runSaleAudioCaptureHostAdapterCli(
    audioStopArgs({
      capture,
      input,
      outPath,
      evidenceDirectory: capture.evidenceDirectory,
      runtime: capture.runtime,
    }),
    {
      environment: audioCaptureEnvironment(session),
    },
  );
  return {
    audioCaptureId: capture.id,
    stopReport: capture.stopReport,
    repeated: false,
  };
}

function cancelAudioCapture(server, input) {
  const capture = requireAudioCapture(server, input.audioCaptureId);
  if (capture.stopReport) {
    return {
      audioCaptureId: capture.id,
      status: "stopped",
      cancelled: false,
    };
  }
  if (!capture.cancelledAt) capture.cancelledAt = new Date().toISOString();
  return {
    audioCaptureId: capture.id,
    status: "cancelled",
    cancelled: true,
    cancelledAt: capture.cancelledAt,
  };
}

function audioCaptureDiagnostics(server, input) {
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

function observePaymentBoundary(server, input) {
  const session = requireSession(server, input.sessionId);
  return session.productionTrace.payment({
    orderId: input.orderId,
    paymentId: input.paymentId,
    commandId: input.commandId,
    paymentNo: input.paymentNo,
  });
}

function observeResultBoundary(server, input) {
  const session = requireSession(server, input.sessionId);
  const entry = session.productionTrace.result(input.surface);
  return { entry, entries: session.productionTrace.validate() };
}

function abortSession(server, input) {
  const session = requireSession(server, input.sessionId);
  const paths = adapterSessionPaths(session);
  if (existsSync(paths.statePath)) {
    const state = JSON.parse(readFileSync(paths.statePath, "utf8"));
    if (state.active && Number.isInteger(state.simulatorPid)) {
      try {
        process.kill(-state.simulatorPid, "SIGTERM");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      state.active = false;
      state.cleanupAttemptCount = Number(state.cleanupAttemptCount ?? 0) + 1;
      writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, {
        mode: 0o600,
      });
    }
  }
  session.mqttCapture.stop();
  return { aborted: true };
}

async function executePlatformQuery(server, input) {
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

async function createSerialSession(server, input) {
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
  const report = parseJsonLine(stdout, outPath);
  const mqttCapture = spawnMqttCapture({ machineCode });
  const session = {
    id: sessionId,
    dir,
    runId,
    machineCode,
    targetIdentity: input.targetIdentity,
    runtimeBase: input.runtimeBase,
    saleCorrelationId,
    serialScenario,
    startReport: report,
    binding: {
      serialSessionId: report.serialSession.serialSessionId,
      sessionBindingToken: report.serialSession.sessionBindingToken,
      startOperationReference: report.serialSession.startOperationReference,
      deviceMappingDigest: report.serialSession.deviceMappingDigest,
    },
    mqttCapture,
    injectReport: null,
    collectReport: null,
    stopReports: [],
    productionTrace: createProductionTransactionTrace({
      stateRoot: server.options.stateRoot,
      sessionId,
    }),
  };
  server.sessions.set(sessionId, session);
  return {
    sessionId,
    saleCorrelationId,
    serialScenario,
    binding: session.binding,
    startReport: summarizeReport(report),
  };
}

function requireSession(server, sessionId) {
  const session = server.sessions.get(required(sessionId, "sessionId"));
  if (!session) throw new Error("serial session was not found");
  return session;
}

async function injectScannerCode(server, input) {
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
  const report = parseJsonLine(stdout, outPath);
  session.injectReport = report;
  session.sale = {
    ...sale,
    vendingCommandId: null,
  };
  return {
    sessionId: session.id,
    injectReport: summarizeReport(report),
    scannerInjection: report.request.serialSession.scannerInjection,
  };
}

async function collectSerialEvidence(server, input) {
  const session = requireSession(server, input.sessionId);
  if (!session.injectReport) {
    throw new Error("inject-scanner-code must complete before collect");
  }
  const scannerInjection =
    session.injectReport.request.serialSession.scannerInjection;
  const sale = {
    saleCorrelationId: session.saleCorrelationId,
    orderId: required(input.orderId, "orderId"),
    paymentId: required(input.paymentId, "paymentId"),
    vendingCommandId: required(input.vendingCommandId, "vendingCommandId"),
  };
  const outPath = join(session.dir, "collect.json");
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
      outPath,
    },
  });
  const { stdout } = await runJsonCommand(command);
  const report = parseJsonLine(stdout, outPath);
  session.collectReport = report;
  session.sale = sale;
  return {
    sessionId: session.id,
    collectReport: report,
    collectSummary: summarizeReport(report),
    mqtt: session.mqttCapture.snapshot(),
  };
}

async function stopSerialSession(server, input) {
  const session = requireSession(server, input.sessionId);
  const sale = session.sale ?? {
    saleCorrelationId: session.saleCorrelationId,
    orderId: required(input.orderId, "orderId"),
    paymentId: required(input.paymentId, "paymentId"),
    vendingCommandId: required(input.vendingCommandId, "vendingCommandId"),
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
  const report = parseJsonLine(stdout, outPath);
  session.stopReports.push(report);
  if (input.idempotencyCheck !== true) {
    session.mqttCapture.stop();
  }
  return {
    sessionId: session.id,
    stopReport: summarizeReport(report),
    mqtt: session.mqttCapture.snapshot(),
  };
}

function authorize(request, token) {
  return request.headers.authorization === `Bearer ${token}`;
}

export function createHostSerialControlPlane(options) {
  const sessions = new Map();
  const audioCaptures = new Map();
  const serverState = { options, sessions, audioCaptures };
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
        request.url === "/v1/mock-payment-create-gate/arm"
      ) {
        jsonResponse(response, 200, {
          ok: true,
          ...armMockPaymentCreateGate(serverState),
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
      if (request.method === "POST" && request.url === "/v1/audio-captures/start") {
        jsonResponse(response, 200, {
          ok: true,
          ...(await startAudioCapture(serverState, await readRequestBody(request))),
        });
        return;
      }
      const sessionMatch = request.url?.match(
        /^\/v1\/serial-sessions\/([^/]+)(?:\/(inject|wait-frame|release-f0|release-f2|observe-payment|observe-result|platform-log|evidence|abort|collect|stop))?$/,
      );
      const audioCaptureMatch = request.url?.match(
        /^\/v1\/audio-captures\/([^/]+)\/(stop|cancel|diagnostics)$/,
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
        if (request.method === "POST" && action === "cancel") {
          jsonResponse(response, 200, {
            ok: true,
            ...cancelAudioCapture(serverState, body),
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
      if (request.method === "POST" && action === "observe-payment") {
        jsonResponse(response, 200, {
          ok: true,
          sessionId,
          entry: observePaymentBoundary(serverState, body),
        });
        return;
      }
      if (request.method === "POST" && action === "observe-result") {
        jsonResponse(response, 200, {
          ok: true,
          sessionId,
          ...observeResultBoundary(serverState, body),
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
      if (request.method === "POST" && action === "abort") {
        jsonResponse(response, 200, {
          ok: true,
          sessionId,
          ...abortSession(serverState, body),
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
      jsonResponse(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  return {
    sessions,
    audioCaptures,
    listen() {
      mkdirSync(options.stateRoot, { recursive: true });
      server.listen(options.port, options.bind);
      return server;
    },
    close() {
      for (const session of sessions.values()) {
        session.mqttCapture?.stop();
      }
      server.close();
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
