#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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
  const match = String(identity).match(
    /^factory-cas:\/\/sha256\/([a-f0-9]{64})$/,
  );
  if (!match) throw new Error(`${role} must be a factory-cas SHA-256 identity`);
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
    assetFromIdentity(
      "approved-runtime-base",
      readOption("--approved-runtime-base"),
    ),
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
    schemaVersion: "vm-default-audio-capture-request/v1",
    activeKioskSession: {
      sessionUser: readOption("--active-kiosk-session-user"),
      sessionId,
    },
    nativeCue: {
      source: "tauri_native_audio",
      command: "play_machine_audio",
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
  if (!/^http:\/\/tauri\.localhost\/#\/.+/.test(tauriRoute))
    throw new Error(
      "--tauri-route must be a strict tauri.localhost hash route",
    );
  return {
    activeKioskSession: {
      sessionUser: readOption("--active-kiosk-session-user"),
      sessionId,
    },
    tauriRoute,
  };
}

function protectedScannerCode(operation) {
  if (operation !== "inject-scanner-code") return undefined;
  const fromFile = readOption("--scanner-code-file", { optional: true });
  const fromEnvironment = process.env.VEM_VM_HOST_SCANNER_CODE;
  const fromStdin = process.argv.includes("--scanner-code-stdin");
  const sources = [
    fromFile ? "file" : null,
    fromEnvironment === undefined ? null : "environment",
    fromStdin ? "stdin" : null,
  ].filter(Boolean);
  if (sources.length !== 1)
    throw new Error(
      "inject-scanner-code requires exactly one protected scanner input: --scanner-code-file, --scanner-code-stdin, or VEM_VM_HOST_SCANNER_CODE",
    );
  if (fromFile) return readFileSync(fromFile, "utf8");
  if (fromStdin) return readFileSync(0, "utf8");
  return fromEnvironment;
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
    saleCorrelationIds: readOptions("--sale-correlation-id"),
    idempotencyCheck:
      operation === "stop-serial-session" &&
      process.argv.includes("--idempotency-check"),
  };
}

async function admitHostOwnedFactoryMedia(operation, factoryMedia) {
  if (!["clean-install", "capture-approved-base"].includes(operation))
    return null;
  const manifestPath = readOption("--factory-manifest-path", {
    optional: true,
  });
  const provenancePath = readOption("--factory-provenance-path", {
    optional: true,
  });
  const isoPath = readOption("--factory-iso-path", { optional: true });
  const udfExtractorPath = readOption("--factory-udf-extractor", {
    optional: true,
  });
  const udfWriterPath = readOption("--factory-udf-writer", { optional: true });
  const wimlibPath = readOption("--factory-wimlib", { optional: true });
  const required =
    process.env.VEM_FACTORY_ACCEPTANCE_REQUIRE_HOST_PROVENANCE === "1";
  if (!manifestPath && !provenancePath && !isoPath && !required) return null;
  if (
    !manifestPath ||
    !provenancePath ||
    !isoPath ||
    !udfExtractorPath ||
    !udfWriterPath ||
    !wimlibPath
  )
    throw new Error(
      "Factory acceptance requires host-owned manifest, provenance, and ISO paths before adapter mutation",
    );
  const { admitFactoryAcceptance } =
    await import("../factory/factory-acceptance-admission.mjs");
  return admitFactoryAcceptance({
    manifestPath,
    provenancePath,
    outputIsoPath: isoPath,
    manifestIdentity: factoryMedia.manifestIdentity,
    provenanceDigest: factoryMedia.provenanceDigest,
    outputIdentity: factoryMedia.outputIdentity,
    outputDigest: factoryMedia.outputDigest,
    udfExtractorPath,
    udfWriterPath,
    wimlibPath,
  });
}

async function main() {
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  const operation = readOption("--operation");
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
  if (serialSession?.scannerInjection?.operationNonce === null)
    serialSession.scannerInjection.operationNonce = nonce;
  const admission = await admitHostOwnedFactoryMedia(operation, factoryMedia);
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
      if (
        admission &&
        report.observed.factoryProvenanceDigest !== admission.provenanceDigest
      )
        throw new Error(
          "adapter report does not bind admitted Factory provenance",
        );
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
