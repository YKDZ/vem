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
import { fileURLToPath } from "node:url";

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
    failureMatrix = contractTest
      ? await runFailureMatrix({
          runId,
          targetIdentity,
          lifecycleReference,
          approvedRuntimeBase,
          saleCorrelationId,
          saleBinding: completedSale,
          scannerCode,
          workDirectory,
          environment,
        })
      : await runProductionFailureMatrix({
          runId,
          targetIdentity,
          lifecycleReference,
          approvedRuntimeBase,
          saleCorrelationId,
          successfulSaleBinding: completedSale,
          scannerCode,
          workDirectory,
          environment,
          salePrepareCommandJson: readOption("--sale-prepare-command-json"),
          saleCompleteCommandJson: readOption("--sale-complete-command-json"),
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

function runFailedDispenseCommand(commandJson) {
  const command = JSON.parse(commandJson);
  if (!Array.isArray(command) || command.length < 2)
    throw new Error("failed-dispense sale command must be a JSON array");
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  const output = JSON.parse(result.stdout || "null");
  const sale = output?.simulatedHardwareSaleFlow?.sale;
  if (
    result.status === 0 ||
    output?.simulatedHardwareSaleFlow?.phase !== "complete" ||
    sale?.dispenseResult !== "failed" ||
    typeof sale?.orderId !== "string" ||
    typeof sale?.paymentId !== "string" ||
    typeof sale?.vendingCommandId !== "string"
  )
    throw new Error(
      "dispense-failed sale did not prove an actual failed command",
    );
  return {
    saleCorrelationId: readOption("--sale-correlation-id"),
    orderId: sale.orderId,
    paymentId: sale.paymentId,
    vendingCommandId: sale.vendingCommandId,
  };
}

function runBlockedSaleCommand(commandJson, failureMode, runId) {
  const command = JSON.parse(commandJson);
  if (!Array.isArray(command) || command.length < 2)
    throw new Error(`${failureMode} blocked-sale command must be a JSON array`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  let output;
  try {
    output = JSON.parse(result.stdout || "null");
  } catch {
    throw new Error(
      `${failureMode} blocked-sale command returned invalid JSON`,
    );
  }
  return assertBlockedSaleEvidence({
    commandExitStatus: result.status,
    output,
    failureMode,
    runId,
  });
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertBlockedSaleEvidence({
  commandExitStatus,
  output,
  failureMode,
  runId,
}) {
  const flow = output?.simulatedHardwareSaleFlow;
  const sale = flow?.sale;
  const healthz = flow?.daemonIpc?.healthz;
  const readyz = flow?.daemonIpc?.readyz;
  const mappingFault = flow?.hardwareMappingFault;
  const transactionEntry = flow?.transactionEntry;
  const readinessBlockingCodes = readyz?.blockingCodes;
  const responseBlockingCodes = transactionEntry?.responseBlockingCodes;
  const context = transactionEntry?.context;
  const request = transactionEntry?.request;
  const selectedItem = context?.selectedItem;
  const paymentOption = context?.paymentOption;
  const exactLowerControllerBlocker =
    Array.isArray(readinessBlockingCodes) &&
    readinessBlockingCodes.length === 1 &&
    readinessBlockingCodes[0] === "LOWER_CONTROLLER_UNAVAILABLE";
  const exactResponseLowerControllerBlocker =
    Array.isArray(responseBlockingCodes) &&
    responseBlockingCodes.length === 1 &&
    responseBlockingCodes[0] === "LOWER_CONTROLLER_UNAVAILABLE";
  if (
    !Number.isInteger(commandExitStatus) ||
    commandExitStatus <= 0 ||
    output?.ok === true ||
    flow?.phase !== "prepare" ||
    flow?.result?.simulatedHardwareReady?.status !== "failed" ||
    healthz?.observed !== true ||
    healthz.hardwareOnline !== false ||
    readyz?.observed !== true ||
    !exactLowerControllerBlocker ||
    mappingFault?.healthzObserved !== true ||
    mappingFault?.readyzObserved !== true ||
    mappingFault?.hardwareOnline !== false ||
    JSON.stringify(mappingFault?.readinessBlockingCodes) !==
      JSON.stringify(readinessBlockingCodes) ||
    Object.hasOwn(mappingFault ?? {}, "adapterDiagnosticCode") ||
    transactionEntry?.endpoint !== "/v1/intents/create-order" ||
    transactionEntry?.attempted !== true ||
    transactionEntry?.rejected !== true ||
    transactionEntry?.statusCode !== 400 ||
    transactionEntry?.responseCode !== "create_order_blocked" ||
    !exactResponseLowerControllerBlocker ||
    JSON.stringify(transactionEntry?.readinessBlockingCodes) !==
      JSON.stringify(readinessBlockingCodes) ||
    context?.runId !== runId ||
    context?.successfulPrepare?.runId !== runId ||
    context?.successfulPrepare?.status !== "succeeded" ||
    context?.successfulPrepare?.phase !== "prepare" ||
    Object.hasOwn(context?.successfulPrepare ?? {}, "orderId") ||
    Object.hasOwn(context?.successfulPrepare ?? {}, "paymentId") ||
    !isNonEmptyString(selectedItem?.inventoryId) ||
    !isNonEmptyString(selectedItem?.slotId) ||
    !isNonEmptyString(selectedItem?.slotCode) ||
    !isNonEmptyString(context?.planogramVersion) ||
    paymentOption?.method === "payment_code" ||
    !isNonEmptyString(paymentOption?.optionKey) ||
    !isNonEmptyString(paymentOption?.method) ||
    !isNonEmptyString(paymentOption?.providerCode) ||
    paymentOption?.ready !== true ||
    request?.inventoryId !== selectedItem?.inventoryId ||
    request?.slotId !== selectedItem?.slotId ||
    request?.slotCode !== selectedItem?.slotCode ||
    request?.planogramVersion !== context?.planogramVersion ||
    request?.quantity !== 1 ||
    request?.paymentMethod !== paymentOption?.method ||
    request?.paymentProviderCode !== paymentOption?.providerCode ||
    transactionEntry?.orderId !== null ||
    transactionEntry?.paymentId !== null ||
    transactionEntry?.vendingCommandId !== null ||
    sale?.orderId !== null ||
    sale?.paymentId !== null ||
    sale?.vendingCommandId !== null
  )
    throw new Error(
      `${failureMode} did not fail closed before creating a sale binding`,
    );
  return {
    commandExitStatus,
    simulatedHardwareReady: "failed",
    daemonHealthObserved: healthz.observed,
    hardwareOnline: healthz.hardwareOnline,
    scannerOnline: healthz.scannerOnline,
    readyzObserved: readyz.observed,
    readinessBlockingCodes,
    responseBlockingCodes,
    transactionEntry,
    saleBindingCreated: false,
  };
}

export function observedMappingFailureCase({
  failureMode,
  startReport,
  expectedDiagnosticCode,
  daemonFailClosed,
}) {
  const serialSession = startReport?.serialSession;
  const diagnosticCode = startReport?.diagnostics?.find(
    (diagnostic) => diagnostic?.code === expectedDiagnosticCode,
  )?.code;
  if (
    startReport?.result !== "succeeded" ||
    diagnosticCode !== expectedDiagnosticCode ||
    !isNonEmptyString(serialSession?.serialSessionId) ||
    !isNonEmptyString(serialSession?.startOperationReference) ||
    !isNonEmptyString(serialSession?.deviceMappingDigest)
  ) {
    throw new Error(
      `${failureMode} did not bind its fail-closed evidence to the observed start-serial-session report`,
    );
  }
  return {
    failureMode,
    operation: "prepare-sale-with-faulted-mapping",
    result: "observed_failure",
    adapterResult: startReport.result,
    diagnosticCode,
    startSerialSession: {
      serialSessionId: serialSession.serialSessionId,
      startOperationReference: serialSession.startOperationReference,
      deviceMappingDigest: serialSession.deviceMappingDigest,
    },
    daemonFailClosed,
  };
}

async function runProductionFailureMatrix(options) {
  const cases = await runFailureMatrix({
    ...options,
    saleBinding: options.successfulSaleBinding,
    failureModes: ["malformed-frame", "device-disconnected"],
  });

  for (const [failureMode, expectedCode] of [
    ["swapped-roles", "serial_swapped_roles"],
    ["missing-device", "serial_missing_device"],
  ]) {
    let mappingSession;
    try {
      const faultEnvironment = {
        ...options.environment,
        VEM_VM_HOST_SERIAL_CONFORMANCE_FAULT: failureMode,
      };
      const start = await runVmHostAdapter({
        request: requestFor({
          operation: "start-serial-session",
          ...options,
          saleBinding: null,
        }),
        workDirectory: options.workDirectory,
        environment: faultEnvironment,
      });
      mappingSession = start.serialSession;
      const diagnosticCode = assertObservedDeviceFault(
        start,
        failureMode,
        expectedCode,
        null,
      );
      const failClosed = runBlockedSaleCommand(
        options.salePrepareCommandJson,
        failureMode,
        options.runId,
      );
      cases.push(
        observedMappingFailureCase({
          failureMode,
          startReport: start,
          expectedDiagnosticCode: diagnosticCode,
          daemonFailClosed: failClosed,
        }),
      );
    } finally {
      if (mappingSession)
        await stopFailureSession(options, mappingSession, null);
    }
  }

  let pendingSale;
  let scannerSession;
  try {
    const start = await runVmHostAdapter({
      request: requestFor({
        operation: "start-serial-session",
        ...options,
        saleBinding: null,
      }),
      workDirectory: options.workDirectory,
      environment: options.environment,
    });
    scannerSession = start.serialSession;
    pendingSale = runSaleCommand(options.salePrepareCommandJson, "prepare");
    const scannerTimeout = await runVmHostAdapter({
      request: requestFor({
        operation: "inject-scanner-code",
        ...options,
        session: scannerSession,
        scannerDescriptor: createScannerCodeDescriptor(options.scannerCode),
        saleBinding: pendingSale,
      }),
      workDirectory: options.workDirectory,
      environment: {
        ...options.environment,
        VEM_VM_HOST_SERIAL_CONFORMANCE_FAULT: "scanner-timeout",
      },
      scannerCode: options.scannerCode,
    });
    const scannerTimeoutCode = assertObservedDeviceFault(
      scannerTimeout,
      "scanner-timeout",
      "serial_scanner_timeout",
      pendingSale,
    );
    cases.push(
      observedFailureCase({
        failureMode: "scanner-timeout",
        operation: "inject-scanner-code",
        report: scannerTimeout,
        saleBinding: pendingSale,
        diagnosticCode: scannerTimeoutCode,
      }),
    );
  } finally {
    if (scannerSession)
      await stopFailureSession(options, scannerSession, pendingSale);
  }

  let dispenseSession;
  let failedSale;
  try {
    const start = await runVmHostAdapter({
      request: requestFor({
        operation: "start-serial-session",
        ...options,
        saleBinding: null,
      }),
      workDirectory: options.workDirectory,
      environment: {
        ...options.environment,
        VEM_VM_HOST_SERIAL_CONFORMANCE_FAULT: "dispense-failed",
      },
    });
    dispenseSession = start.serialSession;
    const dispenseInject = await runVmHostAdapter({
      request: requestFor({
        operation: "inject-scanner-code",
        ...options,
        session: dispenseSession,
        scannerDescriptor: createScannerCodeDescriptor(options.scannerCode),
        saleBinding: pendingSale,
      }),
      workDirectory: options.workDirectory,
      environment: options.environment,
      scannerCode: options.scannerCode,
    });
    failedSale = runFailedDispenseCommand(options.saleCompleteCommandJson);
    if (
      failedSale.orderId !== pendingSale.orderId ||
      failedSale.paymentId !== pendingSale.paymentId
    )
      throw new Error("dispense-failed sale changed the pending business IDs");
    const dispenseFailure = await runVmHostAdapter({
      request: requestFor({
        operation: "collect-serial-evidence",
        ...options,
        session: dispenseSession,
        scannerDescriptor: {
          operationNonce: dispenseInject.request.operationNonce,
          ...createScannerCodeDescriptor(options.scannerCode),
        },
        saleBinding: failedSale,
      }),
      workDirectory: options.workDirectory,
      environment: {
        ...options.environment,
        VEM_VM_HOST_SERIAL_CONFORMANCE_FAULT: "dispense-failed",
      },
    });
    const dispenseFailureCode = assertObservedDeviceFault(
      dispenseFailure,
      "dispense-failed",
      "serial_dispense_failed",
      failedSale,
    );
    cases.push(
      observedFailureCase({
        failureMode: "dispense-failed",
        operation: "collect-serial-evidence",
        report: dispenseFailure,
        saleBinding: failedSale,
        diagnosticCode: dispenseFailureCode,
      }),
    );
  } finally {
    if (dispenseSession)
      await stopFailureSession(
        options,
        dispenseSession,
        failedSale ?? pendingSale,
      );
  }
  return cases;
}

function assertObservedDeviceFault(
  report,
  failureMode,
  expectedCode,
  saleBinding,
) {
  const actualCode = report.diagnostics?.find(
    (diagnostic) => diagnostic?.code === expectedCode,
  )?.code;
  if (report.result !== "succeeded" || actualCode !== expectedCode)
    throw new Error(
      `${failureMode} adapter returned ${actualCode ?? "no diagnostic"}, expected ${expectedCode}`,
    );
  if (
    report.cleanup?.status !== "not-run" ||
    report.cleanup?.overlayDisposition !== "active" ||
    report.cleanup?.observed?.overlay !== "present" ||
    report.cleanup?.observed?.runDirectory !== "present"
  )
    throw new Error(`${failureMode} unexpectedly cleaned the active overlay`);
  if (
    JSON.stringify(report.request.serialSession.saleBindings) !==
    JSON.stringify(saleBinding ? [saleBinding] : [])
  )
    throw new Error(`${failureMode} did not bind the observed device fault`);
  return actualCode;
}

function observedFailureCase({
  failureMode,
  operation,
  report,
  saleBinding,
  diagnosticCode,
}) {
  return {
    failureMode,
    operation,
    result: "observed_failure",
    adapterResult: report.result,
    diagnosticCode,
    orderId: saleBinding.orderId,
    paymentId: saleBinding.paymentId,
    ...(saleBinding.vendingCommandId
      ? { vendingCommandId: saleBinding.vendingCommandId }
      : {}),
  };
}

async function stopFailureSession(options, session, saleBinding) {
  await runVmHostAdapter({
    request: requestFor({
      operation: "stop-serial-session",
      ...options,
      session,
      saleBinding,
    }),
    workDirectory: options.workDirectory,
    environment: options.environment,
  });
  const repeatedStop = await runVmHostAdapter({
    request: requestFor({
      operation: "stop-serial-session",
      ...options,
      session,
      saleBinding,
      idempotencyCheck: true,
    }),
    workDirectory: options.workDirectory,
    environment: options.environment,
  });
  if (!repeatedStop.serialSession.simulatorCleanup.idempotencyVerified)
    throw new Error("adapter did not prove repeated serial stop idempotency");
  return repeatedStop;
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
  failureModes = [
    "malformed-frame",
    "device-disconnected",
    "scanner-timeout",
    "dispense-failed",
    "swapped-roles",
    "missing-device",
  ],
}) {
  const cases = [];
  for (const failureMode of failureModes) {
    const expectedCode = {
      "malformed-frame": "serial_malformed_frame",
      "device-disconnected": "serial_device_disconnected",
      "scanner-timeout": "serial_scanner_timeout",
      "dispense-failed": "serial_dispense_failed",
      "swapped-roles": "serial_swapped_roles",
      "missing-device": "serial_missing_device",
    }[failureMode];
    let session;
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
      const observation =
        failureMode === "scanner-timeout"
          ? inject
          : await runVmHostAdapter({
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
      const diagnosticCode = assertObservedDeviceFault(
        observation,
        failureMode,
        expectedCode,
        saleBinding,
      );
      cases.push(
        observedFailureCase({
          failureMode,
          operation:
            failureMode === "scanner-timeout"
              ? "inject-scanner-code"
              : "collect-serial-evidence",
          report: observation,
          saleBinding,
          diagnosticCode,
        }),
      );
    } finally {
      if (session) {
        const stop = await stopFailureSession(
          {
            runId,
            targetIdentity,
            lifecycleReference,
            approvedRuntimeBase,
            saleCorrelationId,
            workDirectory,
            environment,
          },
          session,
          saleBinding,
        );
        if (stop.serialSession.simulatorCleanup.survivingProcessCount !== 0)
          throw new Error(
            `${failureMode} left serial simulator processes behind`,
          );
      }
    }
  }
  return cases;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "serial conformance failed",
    );
    process.exitCode = 1;
  });
}
