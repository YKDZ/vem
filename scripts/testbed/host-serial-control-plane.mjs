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
  paymentMockCreateGatePaths,
  readPaymentMockCreateGateStatus,
  writePaymentMockCreateGateState,
} from "./mock-payment-create-gate.mjs";
import {
  parseLibvirtUsbSerialMappings,
  qemuUsbSerialSessionPaths,
  readRawSerialJournal,
  stopQemuScannerBindingProbe,
} from "./qemu-usb-serial-host-adapter.mjs";
import {
  abortSaleAudioCaptureSession,
  executeSaleAudioCaptureHostAdapter,
} from "./sale-audio-capture-host-adapter.mjs";

const MOSQUITTO_CONTAINER = "vem-local-testbed-mosquitto";
const PLATFORM_DATABASE_URL =
  process.env.VEM_LOCAL_TESTBED_PLATFORM_DATABASE_URL ??
  "postgresql://vem:vem_local_testbed_password@127.0.0.1:55432/vem_local_testbed";
const SERIAL_SCENARIOS = Object.freeze({
  NORMAL: "normal",
  DELAYED_PICKUP: "delayed-pickup",
  E6: "e6",
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
  if (
    runtime === null ||
    typeof runtime !== "object" ||
    Array.isArray(runtime)
  ) {
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
    executablePath: required(runtime.executablePath, "runtime.executablePath"),
    principal: required(runtime.principal, "runtime.principal"),
    sessionId,
    cdpTargetId: required(runtime.cdpTargetId, "runtime.cdpTargetId"),
    cdpSessionId: required(runtime.cdpSessionId, "runtime.cdpSessionId"),
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function parseHostSerialControlPlaneArgs(args) {
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

export function buildMqttTopic(machineCode) {
  return `vem/machines/${required(machineCode, "machineCode")}/commands/dispense`;
}

function buildMachineMqttTopic(machineCode) {
  return `vem/machines/${required(machineCode, "machineCode")}/#`;
}

function normalizeSerialScenario(value) {
  if (value == null) return SERIAL_SCENARIOS.NORMAL;
  const scenario = String(value).trim().toLowerCase();
  if (!Object.values(SERIAL_SCENARIOS).includes(scenario)) {
    throw new Error("serialScenario must be normal, delayed-pickup, or e6");
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
        "--serial-runner-challenge",
        request.operationEvidence.runnerChallenge,
        "--serial-start-report-digest",
        request.operationEvidence.startReportDigest,
        "--serial-inject-report-digest",
        request.operationEvidence.injectReportDigest,
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

function audioStopArgs({
  capture,
  input,
  outPath,
  evidenceDirectory,
  runtime,
}) {
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

function audioCancelArgs({ capture, outPath, evidenceDirectory, runtime }) {
  return [
    ...audioBaseArgs({
      input: capture.startInput,
      outPath,
      evidenceDirectory,
      runtime,
      phase: "cancel",
    }).slice(0, -4),
    "--capture-session-id",
    capture.startReport.captureSession.captureSessionId,
    "--start-operation-reference",
    capture.startReport.captureSession.startOperationReference,
    "--capture-started-at",
    capture.startReport.captureSession.startedAt,
    "--evidence-dir",
    evidenceDirectory,
    "--out",
    outPath,
  ];
}

export function runJsonCommand(
  command,
  { timeoutMs = 60_000, terminationGraceMs = 2_000 } = {},
) {
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
    let killTimer = null;
    const settle = (callback, value) => {
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

async function terminateProcessGroup(pid) {
  if (!Number.isInteger(pid)) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (await waitForProcessExit(pid)) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  if (!(await waitForProcessExit(pid, 2_000))) {
    throw new Error("lower-controller simulator did not exit");
  }
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

function spawnMqttCapture({
  machineCode,
  topic = buildMqttTopic(machineCode),
  limit = 4,
}) {
  const child = spawn(
    "docker",
    [
      "exec",
      MOSQUITTO_CONTAINER,
      "sh",
      "-lc",
      `mosquitto_sub -h 127.0.0.1 -p 1883 -t '${topic}' -C ${limit} -W 180 -v`,
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
      const firstSpace = trimmed.indexOf(" ");
      const observedTopic =
        firstSpace > 0 ? trimmed.slice(0, firstSpace) : topic;
      const payloadText =
        firstSpace > 0 ? trimmed.slice(firstSpace + 1).trim() : trimmed;
      try {
        messages.push({
          topic: observedTopic,
          payload: JSON.parse(payloadText),
        });
      } catch {
        messages.push({ topic: observedTopic, payload: payloadText });
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
  E6: "controller-to-daemon",
  F2: "controller-to-daemon",
});

const REPEATED_STATE_OPCODES = new Set(["F0", "F1", "AF", "F2"]);

function collapseRepeatedStateFrames(frames) {
  return frames.filter((frame, index) => {
    const previous = frames[index - 1];
    return !(
      previous?.parsedOpcode === frame.parsedOpcode &&
      REPEATED_STATE_OPCODES.has(frame.parsedOpcode)
    );
  });
}

function orderedMilestoneFrames(frames, expected) {
  const milestones = [];
  let expectedIndex = 0;
  for (const frame of frames) {
    if (frame.parsedOpcode !== expected[expectedIndex]) continue;
    milestones.push(frame);
    expectedIndex += 1;
    if (expectedIndex === expected.length) return milestones;
  }
  return null;
}

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
    [SERIAL_SCENARIOS.E6]: {
      VEND: ["VEND"],
      F0: ["VEND", "F0"],
      E6: ["VEND", "F0", "E5", "E5", "F1", "E6"],
    },
  }[scenario]?.[parsedOpcode];
  if (!expected)
    throw new Error("parsedOpcode is not valid for the serial scenario");
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
    const normalizedProtocolFrames =
      collapseRepeatedStateFrames(protocolFrames);
    const opcodes = normalizedProtocolFrames.map((frame) => frame.parsedOpcode);
    if (parsedOpcode === "VEND" && opcodes.includes("F0")) {
      throw new Error("F0 appeared before the before-F0 gate was released");
    }
    if (
      !["F2", "E6"].includes(parsedOpcode) &&
      opcodes.includes("F2") &&
      !opcodes.includes(parsedOpcode)
    ) {
      throw new Error(`F2 appeared before required ${parsedOpcode} boundary`);
    }
    const boundaryIndex = opcodes.indexOf(parsedOpcode);
    if (boundaryIndex >= 0) {
      const prefix = normalizedProtocolFrames.slice(0, boundaryIndex + 1);
      const milestones = orderedMilestoneFrames(prefix, expected);
      if (!milestones) {
        throw new Error(
          `raw serial protocol order must contain ${expected.join(" -> ")}; observed ${prefix.map((frame) => frame.parsedOpcode).join(" -> ")}`,
        );
      }
      return {
        parsedOpcode,
        frame: milestones.at(-1),
        protocolFrames: milestones,
        observedProtocolFrames: prefix,
      };
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
  return boundary;
}

async function stopScannerBindingProbe(server, input) {
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
    if (error?.code !== "ESRCH") throw error;
    const state = JSON.parse(readFileSync(paths.statePath, "utf8"));
    return {
      sessionId: session.id,
      scannerBindingProbe: {
        ...state.scannerBindingProbe,
        stoppedAt: new Date().toISOString(),
        stopReason: "daemon_binding_confirmed",
        alreadyExited: true,
      },
    };
  }
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
    saleBinding: session.sale ?? null,
    rawFrames: readRawSerialJournal(paths.journalPath)
      .slice(-64)
      .map((frame) => ({
        ...frame,
        boundaryId: `host-pty:${session.binding.serialSessionId}:${frame.sequence}`,
        sessionId: session.binding.serialSessionId,
        provenance: "host_pty_raw_serial_journal",
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

function normalizeLifecycleRole(value) {
  const role = required(value, "role");
  if (role === "lower_controller") return "lower-controller";
  if (role === "lower-controller" || role === "scanner") return role;
  throw new Error("role must be lower-controller or scanner");
}

function normalizeLifecycleOperation(value) {
  const operation = required(value, "operation");
  if (operation !== "disconnect" && operation !== "reconnect") {
    throw new Error("operation must be disconnect or reconnect");
  }
  return operation;
}

function serialDeviceXmlForRole(domainXml, role) {
  const alias = `serial-${normalizeLifecycleRole(role)}`;
  const match = domainXml.match(
    new RegExp(
      `<serial\\b[\\s\\S]*?<alias\\s+name="${alias}"\\s*/>[\\s\\S]*?</serial>`,
    ),
  );
  if (!match) throw new Error(`live libvirt domain XML omitted ${alias}`);
  return match[0];
}

function runVirshDeviceLifecycle(server, { role, operation, xml }) {
  const paths = qemuUsbSerialSessionPaths(
    server.options.stateRoot,
    `host-control-plane-device-${role}-${operation}-${randomUUID()}`,
  );
  mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  const xmlPath = join(paths.directory, `${role}-${operation}.xml`);
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

function dumpDomainXml(server) {
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

function serialDeviceLifecycle(server, input) {
  const session = requireSession(server, input.sessionId);
  const role = normalizeLifecycleRole(input.role);
  const operation = normalizeLifecycleOperation(input.operation);
  const domainXml = dumpDomainXml(server);
  const xml =
    operation === "reconnect" && session.detachedDeviceXml?.[role]
      ? session.detachedDeviceXml[role]
      : serialDeviceXmlForRole(domainXml, role);
  const before = parseLibvirtUsbSerialMappings(domainXml).filter(
    (mapping) => mapping.role === role,
  );
  const virsh = runVirshDeviceLifecycle(server, { role, operation, xml });
  if (operation === "disconnect") {
    session.detachedDeviceXml = {
      ...(session.detachedDeviceXml ?? {}),
      [role]: xml,
    };
  }
  const afterXml = dumpDomainXml(server);
  const after = parseLibvirtUsbSerialMappings(afterXml).filter(
    (mapping) => mapping.role === role,
  );
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

function audioCaptureProductionBinding(server, session) {
  const paths = adapterSessionPaths(session);
  return {
    libvirtUri: server.options.libvirtUri,
    domainName: server.options.domainName,
    serialJournalPath: paths.journalPath,
  };
}

function requireAudioCapture(server, audioCaptureId) {
  const capture = server.audioCaptures.get(
    required(audioCaptureId, "audioCaptureId"),
  );
  if (!capture) throw new Error("audio capture session was not found");
  return capture;
}

function audioCaptureEvidencePayloads(capture) {
  return (capture.stopReport?.evidence ?? []).map((artifact) => ({
    fileName: artifact.fileName,
    bytesBase64: readFileSync(
      join(capture.evidenceDirectory, artifact.fileName),
    ).toString("base64"),
  }));
}

async function startAudioCapture(server, input) {
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
  const startReport = await server.dependencies.executeSaleAudioCapture(
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
  );
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

async function stopAudioCapture(server, input) {
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
  capture.stopReport = await server.dependencies.executeSaleAudioCapture(
    {
      phase: "stop",
      runId: capture.startInput.runId,
      lifecycleReference: capture.startInput.lifecycleReference,
      targetIdentity: capture.startInput.targetIdentity,
      transactionId: capture.startInput.transactionId,
      runtime: cloneJson(capture.runtime),
      captureSessionId: capture.startReport.captureSession.captureSessionId,
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
  );
  return {
    audioCaptureId: capture.id,
    stopReport: capture.stopReport,
    evidencePayloads: audioCaptureEvidencePayloads(capture),
    repeated: false,
  };
}

async function cancelAudioCapture(server, input) {
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

async function cancelAudioCaptureByOperation(server, input) {
  const operationId = required(input.operationId, "operationId");
  const captureId = server.audioCapturesByOperation.get(operationId);
  if (!captureId)
    return { operationId, status: "not-started", cancelled: false };
  return {
    operationId,
    ...(await cancelAudioCapture(server, { audioCaptureId: captureId })),
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

function bindSale(server, input) {
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

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return true;
      throw error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
}

async function abortProcessGroup(label, pid) {
  if (!Number.isInteger(pid))
    return { label, pid: null, exitedAfter: "not_started" };
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH")
      return { label, pid, exitedAfter: "already_exited" };
    throw error;
  }
  if (await waitForProcessGroupExit(pid, 3_000))
    return { label, pid, exitedAfter: "SIGTERM" };
  process.kill(-pid, "SIGKILL");
  if (await waitForProcessGroupExit(pid, 1_000))
    return { label, pid, exitedAfter: "SIGKILL" };
  throw new Error(
    `${label} process group ${pid} survived abort SIGTERM and SIGKILL`,
  );
}

async function abortSession(server, input) {
  const session = requireSession(server, input.sessionId);
  const paths = adapterSessionPaths(session);
  const cleanup = {
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
  if (existsSync(paths.statePath)) {
    const state = JSON.parse(readFileSync(paths.statePath, "utf8"));
    for (const [label, pid] of [
      ["lower-controller simulator", state.simulatorPid],
      ["host PTY capture", state.ptyCapturePid],
      ["scanner binding probe", state.scannerBindingProbe?.pid],
    ]) {
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
    const pids = [
      state.simulatorPid,
      state.ptyCapturePid,
      state.scannerBindingProbe?.pid,
    ].filter(Number.isInteger);
    cleanup.survivingProcessCount = pids.filter((pid) => {
      try {
        process.kill(-pid, 0);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
      }
    }).length;
    cleanup.survivingSocketCount = (state.runtimeSocketPaths ?? []).filter(
      (path) => existsSync(path),
    ).length;
    state.cleanup = cleanup;
    writeFileSync(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, {
      mode: 0o600,
    });
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

async function abortExistingSerialSessions(server) {
  for (const session of [...server.sessions.values()]) {
    await abortSession(server, { sessionId: session.id });
    server.sessions.delete(session.id);
  }
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
  const report = parseJsonLine(stdout, outPath);
  const mqttCapture = spawnMqttCapture({ machineCode });
  const machineMqttCapture = spawnMqttCapture({
    machineCode,
    topic: buildMachineMqttTopic(machineCode),
    limit: 40,
  });
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
    machineMqttCapture,
    deviceLifecycle: [],
    detachedDeviceXml: {},
    injectReport: null,
    collectReport: null,
    stopReports: [],
  };
  server.sessions.set(sessionId, session);
  return {
    sessionId,
    saleCorrelationId,
    serialScenario,
    binding: session.binding,
    qemuUsbSerialMappings: report.serialSession.deviceMappings,
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
  const reportDigest = (report) =>
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
  const report = parseJsonLine(stdout, outPath);
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

function authorize(request, token) {
  return request.headers.authorization === `Bearer ${token}`;
}

export function createHostSerialControlPlane(options, dependencies = {}) {
  const sessions = new Map();
  const audioCaptures = new Map();
  const audioCapturesByOperation = new Map();
  const serverState = {
    options,
    sessions,
    audioCaptures,
    audioCapturesByOperation,
    dependencies: {
      executeSaleAudioCapture:
        dependencies.executeSaleAudioCapture ??
        executeSaleAudioCaptureHostAdapter,
      abortSaleAudioCapture:
        dependencies.abortSaleAudioCapture ?? abortSaleAudioCaptureSession,
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
      const sessionMatch = request.url?.match(
        /^\/v1\/serial-sessions\/([^/]+)(?:\/(inject|wait-frame|release-f0|release-f2|bind-sale|platform-log|evidence|device-lifecycle|abort|collect|stop|stop-scanner-probe))?$/,
      );
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
      jsonResponse(response, 500, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
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
      await new Promise((resolve, reject) => {
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
