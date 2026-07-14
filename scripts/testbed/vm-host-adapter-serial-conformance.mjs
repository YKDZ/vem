#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
  if (!fromFile || process.argv.includes("--scanner-code-stdin"))
    throw new Error(
      "provide exactly one protected scanner input: --scanner-code-file",
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
  saleBinding,
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
          saleBindings: [],
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
          saleBindings: saleBinding ? [saleBinding] : [],
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
  const contractTest =
    process.env.VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY === "1";
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
  let failureMatrix;
  let session;
  let preparedSale;
  let completedSale;
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
        saleBinding: null,
      }),
      workDirectory,
      environment,
    });
    session = start.serialSession;
    preparedSale = contractTest
      ? {
          saleCorrelationId,
          orderId: readOption("--order-id"),
          paymentId: readOption("--payment-id"),
          vendingCommandId: null,
        }
      : runSaleCommand(readOption("--sale-prepare-command-json"), "prepare");
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
        saleBinding: preparedSale,
      }),
      workDirectory,
      environment,
      scannerCode,
    });
    completedSale = contractTest
      ? {
          ...preparedSale,
          vendingCommandId: readOption("--vending-command-id"),
        }
      : runSaleCommand(readOption("--sale-complete-command-json"), "complete");
    if (
      completedSale.orderId !== preparedSale.orderId ||
      completedSale.paymentId !== preparedSale.paymentId
    )
      throw new Error(
        "completed scanner sale does not bind the prepared order and payment IDs",
      );
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
        saleBinding: completedSale,
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
        saleBinding: completedSale,
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
        saleBinding: completedSale,
        idempotencyCheck: true,
      }),
      workDirectory,
      environment,
    });
    if (!repeatedStop.serialSession.simulatorCleanup.idempotencyVerified)
      throw new Error("adapter did not prove repeated serial stop idempotency");
    failureMatrix = await runFailureMatrix({
      runId,
      targetIdentity,
      lifecycleReference,
      approvedRuntimeBase,
      saleCorrelationId,
      saleBinding: completedSale,
      scannerCode,
      workDirectory,
      environment,
    });
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
            saleBinding: completedSale ?? preparedSale ?? null,
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
          failureMatrix,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
  if (primaryError) throw primaryError;
}

function runSaleCommand(commandJson, expectedPhase) {
  let command;
  try {
    command = JSON.parse(commandJson);
  } catch {
    throw new Error(`${expectedPhase} sale command must be a JSON array`);
  }
  if (!Array.isArray(command) || command.length < 2)
    throw new Error(`${expectedPhase} sale command must be a JSON array`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  if (result.status !== 0)
    throw new Error(
      `${expectedPhase} scanner sale failed: ${result.stderr || result.stdout}`,
    );
  const output = JSON.parse(result.stdout || "null");
  const sale = output?.simulatedHardwareSaleFlow?.sale;
  if (
    output?.ok !== true ||
    output?.simulatedHardwareSaleFlow?.phase !== expectedPhase ||
    typeof sale?.orderId !== "string" ||
    typeof sale?.paymentId !== "string"
  )
    throw new Error(`${expectedPhase} scanner sale did not return actual IDs`);
  if (
    expectedPhase === "complete" &&
    typeof sale?.vendingCommandId !== "string"
  )
    throw new Error("completed scanner sale has no vending command ID");
  return {
    saleCorrelationId: readOption("--sale-correlation-id"),
    orderId: sale.orderId,
    paymentId: sale.paymentId,
    vendingCommandId:
      expectedPhase === "complete" ? sale.vendingCommandId : null,
  };
}

async function runFailureMatrix({
  runId,
  targetIdentity,
  lifecycleReference,
  approvedRuntimeBase,
  saleCorrelationId,
  saleBinding,
  scannerCode,
  workDirectory,
  environment,
}) {
  const cases = [];
  for (const failureMode of [
    "malformed-frame",
    "device-disconnected",
    "scanner-timeout",
    "dispense-failed",
  ]) {
    const expectedCode = {
      "malformed-frame": "serial_malformed_frame",
      "device-disconnected": "serial_device_disconnected",
      "scanner-timeout": "serial_scanner_timeout",
      "dispense-failed": "serial_dispense_failed",
    }[failureMode];
    let session;
    let stop;
    try {
      const start = await runVmHostAdapter({
        request: requestFor({
          operation: "start-serial-session",
          runId,
          targetIdentity,
          lifecycleReference,
          approvedRuntimeBase,
          saleCorrelationId,
          saleBinding,
        }),
        workDirectory,
        environment,
      });
      session = start.serialSession;
      const scannerDescriptor = createScannerCodeDescriptor(scannerCode);
      try {
        const inject = await runVmHostAdapter({
          request: requestFor({
            operation: "inject-scanner-code",
            runId,
            targetIdentity,
            lifecycleReference,
            approvedRuntimeBase,
            session,
            scannerDescriptor,
            saleCorrelationId,
            saleBinding,
          }),
          workDirectory,
          environment:
            failureMode === "scanner-timeout"
              ? {
                  ...environment,
                  VEM_VM_HOST_SERIAL_CONFORMANCE_FAULT: failureMode,
                }
              : environment,
          scannerCode,
        });
        if (failureMode !== "scanner-timeout")
          await runVmHostAdapter({
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
              saleBinding,
            }),
            workDirectory,
            environment: {
              ...environment,
              VEM_VM_HOST_SERIAL_CONFORMANCE_FAULT: failureMode,
            },
          });
        throw new Error(`${failureMode} unexpectedly produced sale evidence`);
      } catch (error) {
        if (!(error instanceof VmHostAdapterExecutionError)) throw error;
        if (error.diagnostic.result !== "failed")
          throw new Error(`${failureMode} did not fail the serial session`);
        const actualCode = error.diagnostic.diagnostics?.[0]?.code;
        if (actualCode !== expectedCode)
          throw new Error(
            `${failureMode} returned ${actualCode ?? "no diagnostic"}, expected ${expectedCode}`,
          );
        cases.push({
          failureMode,
          operation:
            failureMode === "scanner-timeout"
              ? "inject-scanner-code"
              : "collect-serial-evidence",
          result: error.diagnostic.result,
          diagnosticCode: actualCode,
        });
      }
    } finally {
      if (session) {
        stop = await runVmHostAdapter({
          request: requestFor({
            operation: "stop-serial-session",
            runId,
            targetIdentity,
            lifecycleReference,
            approvedRuntimeBase,
            session,
            saleCorrelationId,
            saleBinding,
            idempotencyCheck: true,
          }),
          workDirectory,
          environment,
        });
        if (stop.serialSession.simulatorCleanup.survivingProcessCount !== 0)
          throw new Error(
            `${failureMode} left serial simulator processes behind`,
          );
      }
    }
  }
  return cases;
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "serial conformance failed",
  );
  process.exitCode = 1;
});
