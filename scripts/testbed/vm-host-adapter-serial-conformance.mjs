#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  createScannerCodeDescriptor,
  createVmHostAdapterRequest,
  runVmHostAdapter,
  VM_HOST_ADAPTER_CONTRACT_VERSION,
} from "./vm-host-adapter-contract.mjs";

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1])
    throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

function readProtectedScannerCode() {
  const fromFile = process.argv.includes("--scanner-code-file")
    ? readOption("--scanner-code-file")
    : null;
  const fromStdin = process.argv.includes("--scanner-code-stdin");
  if (Number(Boolean(fromFile)) + Number(fromStdin) !== 1)
    throw new Error(
      "provide exactly one protected scanner input: --scanner-code-file or --scanner-code-stdin",
    );
  return fromFile ? readFileSync(fromFile, "utf8") : readFileSync(0, "utf8");
}

function nonce() {
  return `op-${randomBytes(16).toString("hex")}`;
}

function asset(identity) {
  const match = String(identity).match(
    /^factory-cas:\/\/sha256\/([a-f0-9]{64})$/,
  );
  if (!match)
    throw new Error(
      "--approved-runtime-base must be a factory-cas SHA-256 identity",
    );
  return {
    role: "approved-runtime-base",
    identity,
    digest: `sha256:${match[1]}`,
  };
}

function requestFor({
  operation,
  runId,
  targetIdentity,
  lifecycleReference,
  approvedRuntimeBase,
  session,
  scannerDescriptor,
  saleCorrelationId,
  idempotencyCheck = false,
}) {
  const operationNonce = nonce();
  const request = {
    contractVersion: VM_HOST_ADAPTER_CONTRACT_VERSION,
    schemaVersion: "vem-vm-host-adapter-request/v2",
    kind: "vm-host-adapter-request",
    operation,
    runId,
    operationNonce,
    operationReference: `vm-operation://${operationNonce}`,
    lifecycleReference,
    cancelOperationReference: null,
    target: { identity: targetIdentity },
    factoryMedia: null,
    displayCapture: null,
    audioCapture: null,
    assets: [asset(approvedRuntimeBase)],
    requestedCapabilities: {
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
    }[operation],
    serialSession: null,
  };
  request.serialSession =
    operation === "start-serial-session"
      ? {
          serialSessionId: null,
          sessionBindingToken: null,
          startOperationReference: null,
          deviceMappingDigest: null,
          deviceRoles: ["lower-controller", "scanner"],
          scannerInjection: null,
          saleCorrelationIds: [saleCorrelationId],
          idempotencyCheck: false,
        }
      : {
          serialSessionId: session.serialSessionId,
          sessionBindingToken: session.sessionBindingToken,
          startOperationReference: session.startOperationReference,
          deviceMappingDigest: session.deviceMappingDigest,
          deviceRoles: ["lower-controller", "scanner"],
          scannerInjection:
            operation === "inject-scanner-code"
              ? { operationNonce, ...scannerDescriptor }
              : operation === "collect-serial-evidence"
                ? scannerDescriptor
                : null,
          saleCorrelationIds: [saleCorrelationId],
          idempotencyCheck,
        };
  return createVmHostAdapterRequest(request);
}

async function main() {
  const adapter = readOption("--adapter");
  const out = readOption("--out");
  const scannerCode = readProtectedScannerCode();
  const runId = readOption("--run-id");
  const targetIdentity = readOption("--target-identity");
  const approvedRuntimeBase = readOption("--approved-runtime-base");
  const lifecycleReference = readOption("--lifecycle-reference");
  const saleCorrelationId = readOption("--sale-correlation-id");
  const workDirectory = join(
    dirname(out),
    "vm-host-adapter-serial-conformance",
  );
  const environment = { ...process.env, VEM_VM_HOST_ADAPTER: adapter };
  mkdirSync(dirname(out), { recursive: true, mode: 0o700 });

  let start;
  let inject;
  let collect;
  let firstStop;
  let repeatedStop;
  let recoveryStop;
  let session;
  let primaryError;
  try {
    start = await runVmHostAdapter({
      request: requestFor({
        operation: "start-serial-session",
        runId,
        targetIdentity,
        lifecycleReference,
        approvedRuntimeBase,
        saleCorrelationId,
      }),
      workDirectory,
      environment,
    });
    session = start.serialSession;
    const scannerDescriptor = createScannerCodeDescriptor(scannerCode);
    inject = await runVmHostAdapter({
      request: requestFor({
        operation: "inject-scanner-code",
        runId,
        targetIdentity,
        lifecycleReference,
        approvedRuntimeBase,
        session,
        scannerDescriptor,
        saleCorrelationId,
      }),
      workDirectory,
      environment,
      scannerCode,
    });
    collect = await runVmHostAdapter({
      request: requestFor({
        operation: "collect-serial-evidence",
        runId,
        targetIdentity,
        lifecycleReference,
        approvedRuntimeBase,
        session,
        scannerDescriptor: {
          operationNonce: inject.request.operationNonce,
          ...scannerDescriptor,
        },
        saleCorrelationId,
      }),
      workDirectory,
      environment,
    });
    firstStop = await runVmHostAdapter({
      request: requestFor({
        operation: "stop-serial-session",
        runId,
        targetIdentity,
        lifecycleReference,
        approvedRuntimeBase,
        session,
        saleCorrelationId,
      }),
      workDirectory,
      environment,
    });
    repeatedStop = await runVmHostAdapter({
      request: requestFor({
        operation: "stop-serial-session",
        runId,
        targetIdentity,
        lifecycleReference,
        approvedRuntimeBase,
        session,
        saleCorrelationId,
        idempotencyCheck: true,
      }),
      workDirectory,
      environment,
    });
    if (!repeatedStop.serialSession.simulatorCleanup.idempotencyVerified)
      throw new Error("adapter did not prove repeated serial stop idempotency");
  } catch (error) {
    primaryError = error;
  } finally {
    if (session && !repeatedStop) {
      try {
        recoveryStop = await runVmHostAdapter({
          request: requestFor({
            operation: "stop-serial-session",
            runId,
            targetIdentity,
            lifecycleReference,
            approvedRuntimeBase,
            session,
            saleCorrelationId,
            idempotencyCheck: true,
          }),
          workDirectory,
          environment,
        });
      } catch (error) {
        if (!primaryError) primaryError = error;
      }
    }
    writeFileSync(
      out,
      `${JSON.stringify(
        {
          schemaVersion: "vem-vm-host-adapter-serial-conformance/v1",
          runId,
          session:
            session === undefined
              ? null
              : {
                  serialSessionId: session.serialSessionId,
                  sessionBindingToken: session.sessionBindingToken,
                  deviceMappingDigest: session.deviceMappingDigest,
                },
          reports: {
            start,
            inject,
            collect,
            firstStop,
            repeatedStop,
            recoveryStop,
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
  if (primaryError) throw primaryError;
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "serial conformance failed",
  );
  process.exitCode = 1;
});
