#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import {
  createScannerCodeDescriptor,
  createVmHostAdapterRequest,
  runVmHostAdapter,
  VM_HOST_ADAPTER_CONTRACT_VERSION,
  VmHostAdapterExecutionError,
} from "./vm-host-adapter-contract.mjs";

const CAPABILITIES_BY_OPERATION = {
  "clean-install": [
    "clean-install",
    "disposable-overlay",
    "serial:lower-controller",
    "serial:scanner",
    "cancellation",
    "cleanup",
  ],
  "capture-approved-base": [
    "approved-base-capture",
    "disposable-overlay",
    "cancellation",
    "cleanup",
  ],
  "restore-approved-base": [
    "approved-base-restore",
    "disposable-overlay",
    "serial:lower-controller",
    "serial:scanner",
    "cancellation",
    "cleanup",
  ],
  "create-disposable-overlay": [
    "disposable-overlay",
    "serial:lower-controller",
    "serial:scanner",
    "cancellation",
    "cleanup",
  ],
  "capture-display": ["display-capture", "cancellation", "cleanup"],
  "capture-default-audio": ["default-audio-capture", "cancellation", "cleanup"],
  "start-serial-session": [
    "serial-session",
    "serial:lower-controller",
    "serial:scanner",
    "cancellation",
    "cleanup",
  ],
  "inject-scanner-code": [
    "serial-session",
    "serial:lower-controller",
    "serial:scanner",
    "serial:scanner-injection",
    "cancellation",
    "cleanup",
  ],
  "collect-serial-evidence": [
    "serial-session",
    "serial:lower-controller",
    "serial:scanner",
    "serial:evidence",
    "cancellation",
    "cleanup",
  ],
  "stop-serial-session": [
    "serial-session",
    "serial:lower-controller",
    "serial:scanner",
    "cleanup",
    "cancellation",
  ],
  cleanup: ["cleanup", "cancellation"],
  cancel: ["cancellation", "cleanup"],
};

function readOption(name, { optional = false } = {}) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    if (optional) return null;
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}

function readOptions(name) {
  return process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]] : [],
  );
}

function assetFromIdentity(role, identity) {
  const pattern =
    role === "approved-runtime-base"
      ? /^runtime-base:\/\/sha256\/([a-f0-9]{64})$/
      : /^factory-cas:\/\/sha256\/([a-f0-9]{64})$/;
  const match = String(identity).match(pattern);
  if (!match) throw new Error(`${role} must be a SHA-256 asset identity`);
  return { role, identity, digest: `sha256:${match[1]}` };
}

function assetsForOperation(operation) {
  if (operation === "clean-install") {
    return [
      assetFromIdentity("factory-iso", readOption("--factory-iso")),
      assetFromIdentity(
        "factory-personalization-media",
        readOption("--factory-personalization-media"),
      ),
    ];
  }
  if (operation === "capture-approved-base") {
    return [assetFromIdentity("factory-iso", readOption("--factory-iso"))];
  }
  return [
    assetFromIdentity("approved-runtime-base", readOption("--runtime-base")),
  ];
}

function factoryMediaForOperation(operation) {
  if (!["clean-install", "capture-approved-base"].includes(operation))
    return null;
  const outputIdentity = readOption("--factory-iso");
  const outputDigest = `sha256:${outputIdentity.match(/^factory-cas:\/\/sha256\/([a-f0-9]{64})$/)?.[1] ?? ""}`;
  return {
    assemblyMode: readOption("--factory-assembly-mode"),
    targetFirmware: readOption("--factory-target-firmware"),
    manifestIdentity: readOption("--factory-manifest"),
    provenanceIdentity: readOption("--factory-provenance"),
    provenanceDigest: readOption("--factory-provenance-digest"),
    outputIdentity,
    outputDigest,
  };
}

function audioCaptureForOperation(operation) {
  if (operation !== "capture-default-audio") return null;
  const sessionId = Number(readOption("--active-kiosk-session-id"));
  if (!Number.isInteger(sessionId) || sessionId < 1)
    throw new Error("--active-kiosk-session-id must be a positive integer");
  return {
    schemaVersion: "vm-default-audio-capture-request/v2",
    activeKioskSession: {
      sessionUser: readOption("--active-kiosk-session-user"),
      sessionId,
    },
    daemonCalibration: {
      source: "vending_daemon_ipc",
      command: "audio_output_calibration",
      challenge: randomBytes(32).toString("hex"),
    },
    threshold: {
      minimumPeakAbsoluteSample: 512,
      minimumNonSilentFrames: 24_000,
      minimumDurationMs: 500,
      minimumDistinctNonSilentSampleMagnitudes: 2,
    },
  };
}

function displayCaptureForOperation(operation) {
  if (operation !== "capture-display") return null;
  const sessionId = Number(readOption("--active-kiosk-session-id"));
  if (!Number.isInteger(sessionId) || sessionId < 1)
    throw new Error("--active-kiosk-session-id must be a positive integer");
  const tauriRoute = readOption("--tauri-route");
  if (!/^http:\/\/tauri\.localhost\/#\/(?:[^?#].*)?$/.test(tauriRoute))
    throw new Error(
      "--tauri-route must be a strict tauri.localhost hash route",
    );
  const rawChallenge = readOption("--visual-challenge-json", {
    optional: true,
  });
  let visualChallenge;
  if (rawChallenge) {
    try {
      visualChallenge = JSON.parse(rawChallenge);
    } catch {
      throw new Error("--visual-challenge-json must be valid JSON");
    }
  } else {
    const bytes = randomBytes(8);
    visualChallenge = {
      token: randomBytes(32).toString("hex"),
      colorRgb: [...randomBytes(3)].map((component) => component || 1),
      region: {
        x: bytes[0] % 1033,
        y: bytes[1] % 1897,
        width: 48,
        height: 24,
      },
    };
  }
  return {
    activeKioskSession: {
      sessionUser: readOption("--active-kiosk-session-user"),
      sessionId,
    },
    tauriRoute,
    cdpTargetId: readOption("--cdp-target-id"),
    visualChallenge,
  };
}

function protectedScannerCode(operation) {
  if (operation !== "inject-scanner-code") return undefined;
  const fromFile = readOption("--scanner-code-file", { optional: true });
  if (!fromFile || process.argv.includes("--scanner-code-stdin"))
    throw new Error(
      "inject-scanner-code requires exactly one protected scanner input: --scanner-code-file",
    );
  if (!isAbsolute(fromFile))
    throw new Error(
      "--scanner-code-file must be an absolute runner-owned path",
    );
  const runnerScope = resolve(process.env.RUNNER_TEMP ?? "");
  const inputPath = resolve(fromFile);
  if (
    !runnerScope ||
    (inputPath !== runnerScope && !inputPath.startsWith(`${runnerScope}${sep}`))
  )
    throw new Error("--scanner-code-file must be inside RUNNER_TEMP");
  const inputStat = statSync(inputPath);
  if (!inputStat.isFile() || (inputStat.mode & 0o777) !== 0o600)
    throw new Error("--scanner-code-file must be a regular 0600 file");
  if (
    typeof process.getuid === "function" &&
    typeof inputStat.uid === "number" &&
    inputStat.uid !== process.getuid()
  )
    throw new Error("--scanner-code-file must be owned by the runner user");
  try {
    return readFileSync(inputPath, "utf8");
  } finally {
    rmSync(inputPath, { force: true });
  }
}

function sessionBindingFromOptions() {
  return {
    serialSessionId: readOption("--serial-session-id"),
    sessionBindingToken: readOption("--session-binding-token"),
    startOperationReference: readOption("--start-operation-reference"),
    deviceMappingDigest: readOption("--device-mapping-digest"),
  };
}

function scannerInjectionFromOptions(operation, scannerCode) {
  if (operation === "inject-scanner-code")
    return {
      operationNonce: null,
      ...createScannerCodeDescriptor(scannerCode),
    };
  if (operation !== "collect-serial-evidence") return null;
  return {
    operationNonce: readOption("--scanner-injection-operation-nonce"),
    scannerCodeDigest: readOption("--scanner-code-digest"),
    scannerCodeByteLength: Number.parseInt(
      readOption("--scanner-code-byte-length"),
      10,
    ),
    scannerCodeSuffix: readOption("--scanner-code-suffix"),
  };
}

function serialSessionForOperation(operation, scannerCode) {
  if (
    ![
      "start-serial-session",
      "inject-scanner-code",
      "collect-serial-evidence",
      "stop-serial-session",
    ].includes(operation)
  )
    return null;
  const isStart = operation === "start-serial-session";
  return {
    ...(isStart
      ? {
          serialSessionId: null,
          sessionBindingToken: null,
          startOperationReference: null,
          deviceMappingDigest: null,
        }
      : sessionBindingFromOptions()),
    deviceRoles: ["lower-controller", "scanner"],
    scannerInjection: scannerInjectionFromOptions(operation, scannerCode),
    operationEvidence: null,
    saleCorrelationIds: readOptions("--sale-correlation-id"),
    saleBindings: isStart
      ? []
      : readOptions("--sale-correlation-id").map((saleCorrelationId) => ({
          saleCorrelationId,
          orderId: readOption("--order-id"),
          paymentId: readOption("--payment-id"),
          vendingCommandId: readOption("--vending-command-id"),
        })),
    idempotencyCheck:
      operation === "stop-serial-session" &&
      process.argv.includes("--idempotency-check"),
  };
}

function readStrictJsonObjectOption(name) {
  const raw = readOption(name, { optional: true });
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`${name} must be a JSON object`);
  }
}

function maintenanceEndpointContextFromOptions() {
  const maintenanceRelaySession = readStrictJsonObjectOption(
    "--maintenance-relay-session-json",
  );
  const maintenanceEndpointPolicy = readStrictJsonObjectOption(
    "--maintenance-endpoint-policy-json",
  );
  if (maintenanceEndpointPolicy !== null && maintenanceRelaySession === null) {
    throw new Error(
      "--maintenance-endpoint-policy-json requires --maintenance-relay-session-json",
    );
  }
  return { maintenanceRelaySession, maintenanceEndpointPolicy };
}

function assertActiveRuntimeOperation(operation) {
  if (["clean-install", "capture-approved-base"].includes(operation)) {
    throw new Error(
      `${operation} is retired from the active VM runtime adapter`,
    );
  }
}

async function main() {
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  const operation = readOption("--operation");
  assertActiveRuntimeOperation(operation);
  const runId = readOption("--run-id");
  const targetIdentity = readOption("--target-identity");
  const out = readOption("--out");
  const nonce = `op-${randomBytes(16).toString("hex")}`;
  const lifecycleSeed = createHash("sha256")
    .update(`${runId}\n${targetIdentity}`)
    .digest("hex")
    .slice(0, 32);
  const factoryMedia = factoryMediaForOperation(operation);
  const displayCapture = displayCaptureForOperation(operation);
  const audioCapture = audioCaptureForOperation(operation);
  const scannerCode = protectedScannerCode(operation);
  const serialSession = serialSessionForOperation(operation, scannerCode);
  const maintenanceEndpointContext = maintenanceEndpointContextFromOptions();
  if (serialSession?.scannerInjection?.operationNonce === null)
    serialSession.scannerInjection.operationNonce = nonce;
  const request = createVmHostAdapterRequest({
    contractVersion: VM_HOST_ADAPTER_CONTRACT_VERSION,
    schemaVersion: "vem-vm-host-adapter-request/v2",
    kind: "vm-host-adapter-request",
    operation,
    runId,
    operationNonce: nonce,
    operationReference: `vm-operation://${nonce}`,
    lifecycleReference: `vm-lifecycle://${runId.toLowerCase()}.${lifecycleSeed}`,
    cancelOperationReference:
      operation === "cancel"
        ? readOption("--cancel-operation-reference")
        : null,
    target: { identity: targetIdentity },
    factoryMedia,
    displayCapture,
    audioCapture,
    assets: assetsForOperation(operation),
    requestedCapabilities: CAPABILITIES_BY_OPERATION[operation] ?? [],
    ...maintenanceEndpointContext,
    serialSession,
  });
  mkdirSync(dirname(out), { recursive: true });
  try {
    try {
      const report = await runVmHostAdapter({
        request,
        workDirectory: process.env.RUNNER_TEMP ?? ".vm-host-adapter-tmp",
        evidenceDirectory: join(dirname(out), "evidence"),
        signal: cancellation.signal,
        scannerCode,
      });
      if (operation === "capture-default-audio") {
        const calibrationEvidence = report.evidence.find(
          (entry) => entry.role === "daemon-audio-calibration-response",
        );
        if (!calibrationEvidence)
          throw new Error("daemon calibration response evidence is missing");
        const source = join(
          dirname(out),
          "evidence",
          runId,
          nonce,
          calibrationEvidence.fileName,
        );
        const responseOut = readOption("--daemon-calibration-response-out");
        mkdirSync(dirname(responseOut), { recursive: true });
        writeFileSync(responseOut, readFileSync(source), { mode: 0o600 });
      }
      writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, {
        mode: 0o600,
      });
    } catch (error) {
      if (error instanceof VmHostAdapterExecutionError) {
        writeFileSync(out, `${JSON.stringify(error.diagnostic, null, 2)}\n`, {
          mode: 0o600,
        });
      }
      throw error;
    }
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

main().catch((error) => {
  console.error(
    error instanceof Error
      ? error.message
      : "VM Host Adapter invocation failed",
  );
  process.exitCode = 1;
});
