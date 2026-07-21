#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  createHash,
  createPublicKey,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
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
  validateVmHostAdapterReport,
  VM_HOST_ADAPTER_CONTRACT_VERSION,
} from "./vm-host-adapter-contract.mjs";

function assertConformance(condition, message) {
  if (!condition) throw new Error(message);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function deriveSerialOperationReportDigest(report) {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(report))
    .digest("hex")}`;
}

export function deriveSerialConformanceReportDigest(report) {
  const committedReport = structuredClone(report);
  if (committedReport?.runnerEvidence)
    delete committedReport.runnerEvidence.conformance;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(committedReport))
    .digest("hex")}`;
}

function runnerChallenge() {
  return `serial-runner-challenge://sha256-${randomBytes(32).toString("hex")}`;
}

function createRunnerEvidence() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey: `ed25519-public-key:base64:${publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64")}`,
    operations: {},
  };
}

function publicKeyEncoding(publicKey) {
  return `ed25519-public-key:base64:${publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64")}`;
}

function protectedRunnerSigningKey() {
  const signingKeyFile = readOption("--runner-signing-key-file", {
    optional: true,
  });
  const expectedRunnerPublicKey = readOption("--expected-runner-public-key", {
    optional: true,
  });
  if (!signingKeyFile && !expectedRunnerPublicKey) {
    if (process.env.VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY !== "1")
      throw new Error(
        "serial conformance requires --runner-signing-key-file and --expected-runner-public-key",
      );
    const evidence = createRunnerEvidence();
    return { ...evidence, expectedRunnerPublicKey: evidence.publicKey };
  }
  if (!signingKeyFile || !expectedRunnerPublicKey)
    throw new Error(
      "serial conformance requires --runner-signing-key-file and --expected-runner-public-key together",
    );
  if (!isAbsolute(signingKeyFile))
    throw new Error(
      "--runner-signing-key-file must be an absolute runner-owned path",
    );
  const runnerScope = resolve(process.env.RUNNER_TEMP ?? "");
  const keyPath = resolve(signingKeyFile);
  if (
    !runnerScope ||
    (keyPath !== runnerScope && !keyPath.startsWith(`${runnerScope}${sep}`))
  )
    throw new Error("--runner-signing-key-file must be inside RUNNER_TEMP");
  const keyStat = statSync(keyPath);
  if (!keyStat.isFile() || (keyStat.mode & 0o777) !== 0o600)
    throw new Error("--runner-signing-key-file must be a regular 0600 file");
  if (
    typeof process.getuid === "function" &&
    typeof keyStat.uid === "number" &&
    keyStat.uid !== process.getuid()
  )
    throw new Error(
      "--runner-signing-key-file must be owned by the runner user",
    );
  let privateKey;
  try {
    privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
  } finally {
    rmSync(keyPath, { force: true });
  }
  const publicKey = publicKeyEncoding(createPublicKey(privateKey));
  if (publicKey !== expectedRunnerPublicKey)
    throw new Error(
      "--runner-signing-key-file does not match --expected-runner-public-key",
    );
  return { privateKey, publicKey, expectedRunnerPublicKey, operations: {} };
}

function commitRunnerOperation(evidence, stage, report) {
  const reportDigest = deriveSerialOperationReportDigest(report);
  evidence.operations[stage] = {
    operationReference: report.request.operationReference,
    reportDigest,
    signature: `ed25519-signature:base64:${sign(
      null,
      Buffer.from(reportDigest),
      evidence.privateKey,
    ).toString("base64")}`,
  };
  return reportDigest;
}

function commitRunnerConformance(evidence, report) {
  const reportDigest = deriveSerialConformanceReportDigest(report);
  report.runnerEvidence.conformance = {
    reportDigest,
    signature: `ed25519-signature:base64:${sign(
      null,
      Buffer.from(reportDigest),
      evidence.privateKey,
    ).toString("base64")}`,
  };
}

function runnerPublicKey(expectedRunnerPublicKey) {
  const keyPrefix = "ed25519-public-key:base64:";
  return createPublicKey({
    key: Buffer.from(expectedRunnerPublicKey.slice(keyPrefix.length), "base64"),
    format: "der",
    type: "spki",
  });
}

function validateRunnerConformanceEvidence(report, expectedRunnerPublicKey) {
  const receipt = report?.runnerEvidence?.conformance;
  const signaturePrefix = "ed25519-signature:base64:";
  assertConformance(
    report?.runnerEvidence?.publicKey === expectedRunnerPublicKey,
    "serial conformance does not match the expected runner public key",
  );
  assertConformance(
    typeof receipt?.reportDigest === "string" &&
      typeof receipt?.signature === "string" &&
      receipt.signature.startsWith(signaturePrefix),
    "runner serial conformance evidence is required",
  );
  assertConformance(
    receipt.reportDigest === deriveSerialConformanceReportDigest(report),
    "runner serial conformance evidence does not bind the report",
  );
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(receipt.reportDigest),
      runnerPublicKey(expectedRunnerPublicKey),
      Buffer.from(receipt.signature.slice(signaturePrefix.length), "base64"),
    );
  } catch {
    valid = false;
  }
  assertConformance(valid, "runner serial conformance signature is invalid");
}

function validateRunnerOperationEvidence(
  evidence,
  stage,
  report,
  expectedRunnerPublicKey,
) {
  const receipt = evidence?.operations?.[stage];
  assertConformance(
    receipt &&
      typeof receipt === "object" &&
      typeof receipt.operationReference === "string" &&
      typeof receipt.reportDigest === "string" &&
      typeof receipt.signature === "string",
    `runner ${stage} operation evidence is required`,
  );
  assertConformance(
    receipt.operationReference === report.request.operationReference &&
      receipt.reportDigest === deriveSerialOperationReportDigest(report),
    `runner ${stage} operation evidence does not bind its validated report`,
  );
  const keyPrefix = "ed25519-public-key:base64:";
  const signaturePrefix = "ed25519-signature:base64:";
  assertConformance(
    typeof evidence.publicKey === "string" &&
      evidence.publicKey.startsWith(keyPrefix) &&
      receipt.signature.startsWith(signaturePrefix),
    "runner operation evidence must use an Ed25519 public key and signature",
  );
  assertConformance(
    evidence.publicKey === expectedRunnerPublicKey,
    "runner operation evidence does not match the expected runner public key",
  );
  let valid = false;
  try {
    valid = verify(
      null,
      Buffer.from(receipt.reportDigest),
      runnerPublicKey(expectedRunnerPublicKey),
      Buffer.from(receipt.signature.slice(signaturePrefix.length), "base64"),
    );
  } catch {
    valid = false;
  }
  assertConformance(
    valid,
    `runner ${stage} operation evidence signature is invalid`,
  );
  return receipt;
}

export function validateSerialConformanceReport(
  input,
  { expectedRunnerPublicKey, expectedAdapterIdentity } = {},
) {
  const conformance = structuredClone(input);
  assertConformance(
    typeof expectedRunnerPublicKey === "string" &&
      expectedRunnerPublicKey.startsWith("ed25519-public-key:base64:"),
    "expected runner public key is required",
  );
  assertConformance(
    conformance?.schemaVersion === "vem-vm-host-adapter-serial-conformance/v1",
    "serial conformance schemaVersion is invalid",
  );
  assertConformance(
    typeof conformance.runId === "string" && conformance.runId.length > 0,
    "serial conformance runId is required",
  );
  validateRunnerConformanceEvidence(conformance, expectedRunnerPublicKey);
  const reports = conformance.reports;
  const requests = conformance.requests;
  assertConformance(
    reports && typeof reports === "object" && !Array.isArray(reports),
    "serial conformance reports are required",
  );
  for (const name of [
    "start",
    "inject",
    "collect",
    "firstStop",
    "repeatedStop",
  ])
    assertConformance(
      reports[name],
      `serial conformance ${name} report is required`,
    );
  assertConformance(
    requests && typeof requests === "object" && !Array.isArray(requests),
    "serial conformance requests are required",
  );
  for (const name of [
    "start",
    "inject",
    "collect",
    "firstStop",
    "repeatedStop",
  ])
    assertConformance(
      requests[name],
      `serial conformance ${name} request is required`,
    );

  const validatedReports = {};
  for (const name of [
    "start",
    "inject",
    "collect",
    "firstStop",
    "repeatedStop",
  ]) {
    const report = reports[name];
    assertConformance(
      report && typeof report === "object" && !Array.isArray(report),
      `serial conformance ${name} report is invalid`,
    );
    assertConformance(
      requests[name],
      `serial conformance ${name} request is required for report validation`,
    );
    validatedReports[name] = validateVmHostAdapterReport(
      report,
      requests[name],
    );
  }

  const start = validatedReports.start;
  const inject = validatedReports.inject;
  const collect = validatedReports.collect;
  const firstStop = validatedReports.firstStop;
  const repeatedStop = validatedReports.repeatedStop;
  assertConformance(
    typeof expectedAdapterIdentity === "string" &&
      expectedAdapterIdentity.length > 0,
    "expected adapter identity is required",
  );
  const lifecycleIdentity = (report) => ({
    adapter: report.adapter,
    vmIdentity: report.observed.vmIdentity,
    targetBinding: report.observed.targetBinding,
    baseIdentity: report.observed.baseIdentity,
    overlayIdentity: report.observed.overlayIdentity,
    factoryProvenanceDigest: report.observed.factoryProvenanceDigest,
  });
  assertConformance(
    start.adapter.identity === expectedAdapterIdentity &&
      [inject, collect, firstStop, repeatedStop].every((report) =>
        sameJson(lifecycleIdentity(report), lifecycleIdentity(start)),
      ),
    "serial conformance reports must bind one trusted adapter and VM lifecycle",
  );
  const startReceipt = validateRunnerOperationEvidence(
    conformance.runnerEvidence,
    "start",
    start,
    expectedRunnerPublicKey,
  );
  const injectReceipt = validateRunnerOperationEvidence(
    conformance.runnerEvidence,
    "inject",
    inject,
    expectedRunnerPublicKey,
  );
  validateRunnerOperationEvidence(
    conformance.runnerEvidence,
    "collect",
    collect,
    expectedRunnerPublicKey,
  );
  assertConformance(
    [start, inject, collect, firstStop, repeatedStop].every(
      (report) => report.result === "succeeded",
    ),
    "serial conformance lifecycle reports must succeed",
  );
  assertConformance(
    start.request.operation === "start-serial-session" &&
      inject.request.operation === "inject-scanner-code" &&
      collect.request.operation === "collect-serial-evidence" &&
      firstStop.request.operation === "stop-serial-session" &&
      repeatedStop.request.operation === "stop-serial-session",
    "serial conformance lifecycle report operations are invalid",
  );
  assertConformance(
    [start, inject, collect, firstStop, repeatedStop].every(
      (report) => report.request.runId === conformance.runId,
    ),
    "serial conformance reports must bind the declared run",
  );
  assertConformance(
    [inject, collect, firstStop, repeatedStop].every(
      (report) =>
        report.request.lifecycleReference ===
          start.request.lifecycleReference &&
        report.request.targetIdentity === start.request.targetIdentity,
    ),
    "serial conformance reports must bind one lifecycle target",
  );
  const startSession = start.serialSession;
  assertConformance(
    startSession,
    "serial conformance start session is required",
  );
  assertConformance(
    sameJson(conformance.session, {
      serialSessionId: startSession.serialSessionId,
      sessionBindingToken: startSession.sessionBindingToken,
      deviceMappingDigest: startSession.deviceMappingDigest,
    }),
    "serial conformance session must match the validated start report",
  );
  for (const report of [inject, collect, firstStop, repeatedStop])
    assertConformance(
      [
        "serialSessionId",
        "sessionBindingToken",
        "startOperationReference",
        "deviceMappingDigest",
      ].every(
        (key) => report.request.serialSession?.[key] === startSession[key],
      ),
      "serial conformance reports must retain the validated start session",
    );
  assertConformance(
    collect.request.serialSession.scannerInjection?.operationNonce ===
      inject.request.operationNonce,
    "serial evidence collection must bind the validated scanner injection",
  );
  assertConformance(
    sameJson(collect.request.serialSession.operationEvidence, {
      runnerChallenge: conformance.runnerEvidence.runnerChallenge,
      startReportDigest: startReceipt.reportDigest,
      injectReportDigest: injectReceipt.reportDigest,
    }),
    "serial evidence collection must use runner-held start and inject commitments",
  );
  const injectedSale = inject.request.serialSession.saleBindings?.[0];
  const collectedSale = collect.request.serialSession.saleBindings?.[0];
  assertConformance(
    injectedSale &&
      collectedSale &&
      injectedSale.saleCorrelationId === collectedSale.saleCorrelationId &&
      injectedSale.orderId === collectedSale.orderId &&
      injectedSale.paymentId === collectedSale.paymentId &&
      injectedSale.vendingCommandId === null &&
      typeof collectedSale.vendingCommandId === "string",
    "serial collection must complete the injected sale without relabeling it",
  );
  if (conformance.profile === "installed-kiosk-sale") {
    assertConformance(
      conformance.customerUiSale?.orderId === collectedSale.orderId &&
        conformance.customerUiSale?.paymentId === collectedSale.paymentId &&
        conformance.customerUiSale?.orderNo &&
        conformance.customerUiSale?.scenarioSha256 &&
        inject.request.serialSession.saleBindings?.length === 1 &&
        collect.request.serialSession.saleBindings?.length === 1 &&
        !Object.hasOwn(conformance, "failureMatrix"),
      "installed kiosk sale conformance must derive one rendered customer sale from exact serial operations",
    );
  } else {
    validateFailureMatrix(
      conformance.failureMatrix,
      collectedSale,
      lifecycleIdentity(start),
    );
  }
  return { ...conformance, reports: validatedReports };
}

function validateFailureMatrix(
  failureMatrix,
  completedSale,
  expectedLifecycleIdentity,
) {
  const expected = new Map([
    ["malformed-frame", ["collect-serial-evidence", "serial_malformed_frame"]],
    [
      "device-disconnected",
      ["collect-serial-evidence", "serial_device_disconnected"],
    ],
    ["scanner-timeout", ["inject-scanner-code", "serial_scanner_timeout"]],
    ["dispense-failed", ["collect-serial-evidence", "serial_dispense_failed"]],
    [
      "swapped-roles",
      ["prepare-sale-with-faulted-mapping", "serial_swapped_roles"],
    ],
    [
      "missing-device",
      ["prepare-sale-with-faulted-mapping", "serial_missing_device"],
    ],
  ]);
  assertConformance(
    Array.isArray(failureMatrix) && failureMatrix.length === expected.size,
    "serial conformance failure matrix is incomplete",
  );
  const byMode = new Map(
    failureMatrix.map((entry) => [entry?.failureMode, entry]),
  );
  assertConformance(
    byMode.size === expected.size,
    "serial conformance failure matrix modes must be unique",
  );
  for (const [failureMode, [operation, diagnosticCode]] of expected) {
    const entry = byMode.get(failureMode);
    assertConformance(
      entry?.operation === operation &&
        entry.result === "observed_failure" &&
        entry.adapterResult === "succeeded" &&
        entry.diagnosticCode === diagnosticCode,
      `serial conformance ${failureMode} failure evidence is invalid`,
    );
    validateFailureSource(
      entry?.source?.fault,
      `${failureMode} fault`,
      expectedLifecycleIdentity,
    );
    assertConformance(
      (failureMode === "swapped-roles" || failureMode === "missing-device"
        ? entry.source.fault.request.operation === "start-serial-session" &&
          sameJson(entry.source.fault.request.serialSession.saleBindings, [])
        : entry.source.fault.request.operation === operation) &&
        entry.source.fault.report.diagnostics?.some(
          (diagnostic) => diagnostic?.code === diagnosticCode,
        ),
      `serial conformance ${failureMode} source does not prove the declared fault`,
    );
  }

  for (const failureMode of ["malformed-frame", "device-disconnected"]) {
    const entry = byMode.get(failureMode);
    const sourceSale = entry.source.fault.request.serialSession.saleBindings;
    assertConformance(
      entry.orderId === completedSale.orderId &&
        entry.paymentId === completedSale.paymentId &&
        entry.vendingCommandId === completedSale.vendingCommandId &&
        sameJson(sourceSale, [completedSale]),
      `serial conformance ${failureMode} must bind the completed sale`,
    );
  }
  const scannerTimeout = byMode.get("scanner-timeout");
  const dispenseFailed = byMode.get("dispense-failed");
  const scannerSale =
    scannerTimeout.source.fault.report.request.serialSession.saleBindings[0];
  const dispenseSale =
    dispenseFailed.source.fault.report.request.serialSession.saleBindings[0];
  assertConformance(
    typeof scannerTimeout.orderId === "string" &&
      typeof scannerTimeout.paymentId === "string" &&
      scannerTimeout.orderId === scannerSale?.orderId &&
      scannerTimeout.paymentId === scannerSale?.paymentId &&
      scannerTimeout.orderId === dispenseFailed.orderId &&
      scannerTimeout.paymentId === dispenseFailed.paymentId &&
      !Object.hasOwn(scannerTimeout, "vendingCommandId") &&
      scannerSale?.vendingCommandId === null &&
      typeof dispenseFailed.vendingCommandId === "string" &&
      dispenseFailed.orderId === dispenseSale?.orderId &&
      dispenseFailed.paymentId === dispenseSale?.paymentId &&
      dispenseFailed.vendingCommandId === dispenseSale?.vendingCommandId,
    "serial conformance scanner timeout and failed dispense must bind one failed sale",
  );

  for (const failureMode of ["swapped-roles", "missing-device"]) {
    const entry = byMode.get(failureMode);
    const start = validateFailureSource(
      entry?.source?.start,
      `${failureMode} start`,
      expectedLifecycleIdentity,
    );
    const fault = validateFailureSource(
      entry.source.fault,
      `${failureMode} fault session`,
      expectedLifecycleIdentity,
    );
    const session = entry.startSerialSession;
    const faultSession = fault.serialSession;
    const failClosed = entry.daemonFailClosed;
    assertConformance(
      !Object.hasOwn(entry, "orderId") &&
        !Object.hasOwn(entry, "paymentId") &&
        !Object.hasOwn(entry, "vendingCommandId") &&
        sameJson(entry.source.start, entry.source.fault) &&
        sameJson(fault.request.serialSession.saleBindings, []) &&
        sameJson(session, {
          serialSessionId: start.serialSession?.serialSessionId,
          startOperationReference: start.serialSession?.startOperationReference,
          deviceMappingDigest: start.serialSession?.deviceMappingDigest,
        }) &&
        [
          "serialSessionId",
          "startOperationReference",
          "deviceMappingDigest",
        ].every((key) => faultSession?.[key] === session?.[key]) &&
        failClosed?.commandExitStatus > 0 &&
        failClosed.simulatedHardwareReady === "failed" &&
        failClosed.daemonHealthObserved === true &&
        failClosed.hardwareOnline === false &&
        failClosed.readyzObserved === true &&
        sameJson(failClosed.adapterSession, {
          ...session,
          faultStartedAt: failClosed.adapterSession?.faultStartedAt,
        }) &&
        typeof failClosed.adapterSession.faultStartedAt === "string" &&
        sameJson(failClosed.readinessBlockingCodes, [
          "LOWER_CONTROLLER_UNAVAILABLE",
        ]) &&
        sameJson(failClosed.responseBlockingCodes, [
          "LOWER_CONTROLLER_UNAVAILABLE",
        ]) &&
        failClosed.transactionEntry?.endpoint === "/v1/intents/create-order" &&
        failClosed.transactionEntry?.attempted === true &&
        failClosed.transactionEntry?.rejected === true &&
        failClosed.transactionEntry?.statusCode === 400 &&
        failClosed.transactionEntry?.responseCode === "create_order_blocked" &&
        sameJson(failClosed.transactionEntry?.readinessBlockingCodes, [
          "LOWER_CONTROLLER_UNAVAILABLE",
        ]) &&
        failClosed.transactionEntry?.orderId === null &&
        failClosed.transactionEntry?.paymentId === null &&
        failClosed.transactionEntry?.vendingCommandId === null &&
        failClosed.saleBindingCreated === false &&
        entry.recovery?.runtimeReady === "passed" &&
        entry.recovery?.hardwareOnline === true &&
        entry.recovery?.scannerOnline === true &&
        entry.recovery?.ready === true,
      `serial conformance ${failureMode} mapping failure is not fail-closed and recovered`,
    );
  }
}

export function readFailureMatrixCommands(commandJson) {
  let commands;
  try {
    commands = JSON.parse(commandJson);
  } catch {
    throw new Error("failure matrix commands must be a JSON object");
  }
  const required = {
    "swapped-roles": ["salePrepareCommand", "runtimeRecoveryCommand"],
    "missing-device": ["salePrepareCommand", "runtimeRecoveryCommand"],
    "scanner-timeout": ["salePrepareCommand"],
    "dispense-failed": ["saleCompleteCommand"],
  };
  for (const [failureMode, keys] of Object.entries(required)) {
    const entry = commands?.[failureMode];
    if (!entry || typeof entry !== "object")
      throw new Error(`${failureMode} failure matrix commands are required`);
    for (const key of keys)
      if (
        !Array.isArray(entry[key]) ||
        entry[key].length < 2 ||
        !entry[key].every((argument) => typeof argument === "string")
      )
        throw new Error(`${failureMode} ${key} must be a command array`);
  }
  return commands;
}

function readFailureMatrixArtifactPaths(pathJson) {
  let paths;
  try {
    paths = JSON.parse(pathJson);
  } catch {
    throw new Error("failure matrix artifact paths must be a JSON object");
  }
  const failureModes = [
    "malformed-frame",
    "device-disconnected",
    "scanner-timeout",
    "dispense-failed",
    "swapped-roles",
    "missing-device",
  ];
  const reports = failureModes.map((failureMode) => {
    const report = paths?.[failureMode]?.report;
    if (typeof report !== "string" || report.trim().length === 0)
      throw new Error(`${failureMode} failure matrix report path is required`);
    return report;
  });
  if (new Set(reports).size !== reports.length)
    throw new Error("failure matrix report paths must be unique");
  return paths;
}

function writeFailureMatrixArtifacts(failureMatrix, paths) {
  for (const entry of failureMatrix) {
    const reportPath = paths[entry.failureMode].report;
    mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          schemaVersion: "vem-vm-host-adapter-serial-failure-report/v1",
          failureMode: entry.failureMode,
          failure: entry,
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
  }
}

function validateFailureSource(source, label, expectedLifecycleIdentity) {
  assertConformance(
    source?.request && source?.report,
    `serial conformance ${label} source is required`,
  );
  const report = validateVmHostAdapterReport(source.report, source.request);
  const lifecycleIdentity = {
    adapter: report.adapter,
    vmIdentity: report.observed.vmIdentity,
    targetBinding: report.observed.targetBinding,
    baseIdentity: report.observed.baseIdentity,
    overlayIdentity: report.observed.overlayIdentity,
    factoryProvenanceDigest: report.observed.factoryProvenanceDigest,
  };
  assertConformance(
    sameJson(lifecycleIdentity, expectedLifecycleIdentity),
    `serial conformance ${label} source belongs to another VM lifecycle`,
  );
  return report;
}

function readOption(name, { optional = false } = {}) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    if (optional) return null;
    throw new Error(`${name} is required`);
  }
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
    return readFileSync(inputPath);
  } finally {
    rmSync(inputPath, { force: true });
  }
}

function readCustomerUiSaleBinding() {
  const path = readOption("--customer-ui-sale-binding-file", {
    optional: true,
  });
  if (!path) return null;
  let binding;
  try {
    binding = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("--customer-ui-sale-binding-file must contain JSON");
  }
  for (const field of ["orderId", "paymentId", "orderNo", "scenarioSha256"]) {
    if (typeof binding?.[field] !== "string" || binding[field].trim() === "")
      throw new Error(`customer UI sale binding requires ${field}`);
  }
  return binding;
}

function nonce() {
  return `op-${randomBytes(16).toString("hex")}`;
}

function asset(identity) {
  const match = String(identity).match(
    /^runtime-base:\/\/sha256\/([a-f0-9]{64})$/,
  );
  if (!match)
    throw new Error("--runtime-base must be a SHA-256 runtime base identity");
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
  operationEvidence = null,
  idempotencyCheck = false,
}) {
  const operationNonce = nonce();
  const serialOperationEvidence =
    operation === "collect-serial-evidence" && operationEvidence === null
      ? {
          runnerChallenge: runnerChallenge(),
          startReportDigest: `sha256:${randomBytes(32).toString("hex")}`,
          injectReportDigest: `sha256:${randomBytes(32).toString("hex")}`,
        }
      : operationEvidence;
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
          operationEvidence: null,
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
          operationEvidence: serialOperationEvidence,
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
  const approvedRuntimeBase = readOption("--runtime-base");
  const lifecycleReference = readOption("--lifecycle-reference");
  const saleCorrelationId = readOption("--sale-correlation-id");
  const startOnly = process.argv.includes("--start-only");
  const prestartedReportPath = readOption("--prestarted-report", {
    optional: true,
  });
  if (startOnly && prestartedReportPath)
    throw new Error("--start-only cannot be combined with --prestarted-report");
  const customerUiSale = readCustomerUiSaleBinding();
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
  const failureMatrixArtifactPaths = startOnly
    ? null
    : customerUiSale
      ? null
      : contractTest
        ? null
        : readFailureMatrixArtifactPaths(
            readOption("--failure-matrix-artifact-paths-json"),
          );
  let session;
  let startRequest;
  let injectRequest;
  let collectRequest;
  let firstStopRequest;
  let repeatedStopRequest;
  let recoveryStopRequest;
  let preparedSale;
  let completedSale;
  let primaryError;
  const runnerEvidence = protectedRunnerSigningKey();
  const serialRunnerChallenge = runnerChallenge();
  try {
    if (prestartedReportPath) {
      const prestarted = JSON.parse(readFileSync(prestartedReportPath, "utf8"));
      if (
        prestarted?.schemaVersion !==
          "vem-vm-host-adapter-serial-prestart/v1" ||
        prestarted.runId !== runId
      )
        throw new Error("prestarted serial report does not match this run");
      startRequest = prestarted.request;
      start = prestarted.report;
    } else {
      startRequest = requestFor({
        operation: "start-serial-session",
        runId,
        targetIdentity,
        lifecycleReference,
        approvedRuntimeBase,
        saleCorrelationId,
        saleBinding: null,
      });
      start = await runVmHostAdapter({
        request: startRequest,
        workDirectory,
        environment,
      });
    }
    const startReportDigest = commitRunnerOperation(
      runnerEvidence,
      "start",
      start,
    );
    session = start.serialSession;
    if (startOnly) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            schemaVersion: "vem-vm-host-adapter-serial-prestart/v1",
            runId,
            request: startRequest,
            report: start,
            session,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      return;
    }
    preparedSale = customerUiSale
      ? {
          saleCorrelationId,
          orderId: customerUiSale.orderId,
          paymentId: customerUiSale.paymentId,
          vendingCommandId: null,
        }
      : contractTest
        ? {
            saleCorrelationId,
            orderId: readOption("--order-id"),
            paymentId: readOption("--payment-id"),
            vendingCommandId: null,
          }
        : runSaleCommand(
            readCommandJson("--sale-prepare-command-json"),
            "prepare",
          );
    const scannerDescriptor = createScannerCodeDescriptor(scannerCode);
    injectRequest = requestFor({
      operation: "inject-scanner-code",
      runId,
      targetIdentity,
      lifecycleReference,
      approvedRuntimeBase,
      session,
      scannerDescriptor,
      saleCorrelationId,
      saleBinding: preparedSale,
    });
    inject = await runVmHostAdapter({
      request: injectRequest,
      workDirectory,
      environment,
      scannerCode,
    });
    const injectReportDigest = commitRunnerOperation(
      runnerEvidence,
      "inject",
      inject,
    );
    completedSale = contractTest
      ? {
          ...preparedSale,
          vendingCommandId: readOption("--vending-command-id"),
        }
      : runSaleCommand(
          readCommandJson("--sale-complete-command-json"),
          "complete",
        );
    if (
      completedSale.orderId !== preparedSale.orderId ||
      completedSale.paymentId !== preparedSale.paymentId
    )
      throw new Error(
        "completed scanner sale does not bind the prepared order and payment IDs",
      );
    collectRequest = requestFor({
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
      operationEvidence: {
        runnerChallenge: serialRunnerChallenge,
        startReportDigest,
        injectReportDigest,
      },
    });
    collect = await runVmHostAdapter({
      request: collectRequest,
      workDirectory,
      environment,
    });
    commitRunnerOperation(runnerEvidence, "collect", collect);
    firstStopRequest = requestFor({
      operation: "stop-serial-session",
      runId,
      targetIdentity,
      lifecycleReference,
      approvedRuntimeBase,
      session,
      saleCorrelationId,
      saleBinding: completedSale,
    });
    firstStop = await runVmHostAdapter({
      request: firstStopRequest,
      workDirectory,
      environment,
    });
    repeatedStopRequest = requestFor({
      operation: "stop-serial-session",
      runId,
      targetIdentity,
      lifecycleReference,
      approvedRuntimeBase,
      session,
      saleCorrelationId,
      saleBinding: completedSale,
      idempotencyCheck: true,
    });
    repeatedStop = await runVmHostAdapter({
      request: repeatedStopRequest,
      workDirectory,
      environment,
    });
    if (!repeatedStop.serialSession.simulatorCleanup.idempotencyVerified)
      throw new Error("adapter did not prove repeated serial stop idempotency");
    failureMatrix = customerUiSale
      ? undefined
      : contractTest
        ? (
            await runFailureMatrix({
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
          ).map((entry) =>
            entry.failureMode === "swapped-roles" ||
            entry.failureMode === "missing-device"
              ? {
                  ...entry,
                  recovery: {
                    runtimeReady: "passed",
                    hardwareOnline: true,
                    scannerOnline: true,
                    ready: true,
                  },
                }
              : entry,
          )
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
            failureCommands: readFailureMatrixCommands(
              readOption("--failure-matrix-commands-json"),
            ),
          });
    if (failureMatrixArtifactPaths)
      writeFailureMatrixArtifacts(failureMatrix, failureMatrixArtifactPaths);
  } catch (error) {
    primaryError = error;
  } finally {
    if (session && !repeatedStop && !startOnly) {
      try {
        recoveryStopRequest = requestFor({
          operation: "stop-serial-session",
          runId,
          targetIdentity,
          lifecycleReference,
          approvedRuntimeBase,
          session,
          saleCorrelationId,
          saleBinding: completedSale ?? preparedSale ?? null,
          idempotencyCheck: true,
        });
        recoveryStop = await runVmHostAdapter({
          request: recoveryStopRequest,
          workDirectory,
          environment,
        });
      } catch (error) {
        if (!primaryError) primaryError = error;
      }
    }
    if (!startOnly) {
      const conformance = {
        schemaVersion: "vem-vm-host-adapter-serial-conformance/v1",
        runId,
        ...(customerUiSale
          ? {
              profile: "installed-kiosk-sale",
              customerUiSale: {
                orderId: customerUiSale.orderId,
                paymentId: customerUiSale.paymentId,
                orderNo: customerUiSale.orderNo,
                scenarioSha256: customerUiSale.scenarioSha256,
              },
            }
          : {}),
        requests: {
          start: startRequest,
          inject: injectRequest,
          collect: collectRequest,
          firstStop: firstStopRequest,
          repeatedStop: repeatedStopRequest,
          recoveryStop: recoveryStopRequest,
        },
        runnerEvidence: {
          publicKey: runnerEvidence.publicKey,
          runnerChallenge: serialRunnerChallenge,
          operations: runnerEvidence.operations,
        },
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
        ...(failureMatrix === undefined ? {} : { failureMatrix }),
      };
      commitRunnerConformance(runnerEvidence, conformance);
      writeFileSync(out, `${JSON.stringify(conformance, null, 2)}\n`, {
        mode: 0o600,
      });
      if (!primaryError)
        validateSerialConformanceReport(conformance, {
          expectedRunnerPublicKey: runnerEvidence.expectedRunnerPublicKey,
          expectedAdapterIdentity: contractTest
            ? start?.adapter?.identity
            : process.env.VEM_VM_HOST_EXPECTED_ADAPTER_IDENTITY,
        });
    }
  }
  if (primaryError) throw primaryError;
}

function readCommandJson(option) {
  let command;
  try {
    command = JSON.parse(readOption(option));
  } catch {
    throw new Error(`${option} must be a JSON command array`);
  }
  if (!Array.isArray(command) || command.length < 2)
    throw new Error(`${option} must be a JSON command array`);
  return command;
}

function runSaleCommand(command, expectedPhase) {
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
  let output = JSON.parse(result.stdout || "null");
  const outputOptionIndex = command.lastIndexOf("--out");
  if (
    outputOptionIndex >= 0 &&
    typeof command[outputOptionIndex + 1] === "string"
  ) {
    try {
      output = JSON.parse(
        readFileSync(resolve(command[outputOptionIndex + 1]), "utf8"),
      );
    } catch {
      // Commands without a durable output file retain their stdout contract.
    }
  }
  const sale = output?.simulatedHardwareSaleFlow?.sale;
  if (
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

export function runFailedDispenseCommand(
  command,
  saleCorrelationId = readOption("--sale-correlation-id"),
) {
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
    saleCorrelationId,
    orderId: sale.orderId,
    paymentId: sale.paymentId,
    vendingCommandId: sale.vendingCommandId,
  };
}

function adapterSessionEvidence(startReport) {
  return {
    serialSessionId: startReport.serialSession.serialSessionId,
    startOperationReference: startReport.serialSession.startOperationReference,
    deviceMappingDigest: startReport.serialSession.deviceMappingDigest,
    faultStartedAt: startReport.timestamps.startedAt,
  };
}

function runBlockedSaleCommand(command, failureMode, runId, startReport) {
  if (!Array.isArray(command) || command.length < 2)
    throw new Error(`${failureMode} blocked-sale command must be a JSON array`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VEM_VM_HOST_FAULT_SESSION_ID: startReport.serialSession.serialSessionId,
      VEM_VM_HOST_FAULT_START_OPERATION_REFERENCE:
        startReport.serialSession.startOperationReference,
      VEM_VM_HOST_FAULT_DEVICE_MAPPING_DIGEST:
        startReport.serialSession.deviceMappingDigest,
      VEM_VM_HOST_FAULT_STARTED_AT: startReport.timestamps.startedAt,
    },
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
    expectedAdapterSession: adapterSessionEvidence(startReport),
  });
}

function runRuntimeRecoveryCommand(command, failureMode) {
  if (!Array.isArray(command) || command.length < 2)
    throw new Error(`${failureMode} recovery command must be a JSON array`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  let output;
  try {
    output = JSON.parse(result.stdout || "null");
  } catch {
    throw new Error(`${failureMode} recovery command returned invalid JSON`);
  }
  const report = output?.runtimeAcceptanceReport;
  if (
    result.status !== 0 ||
    output?.ok !== true ||
    report?.result?.runtimeReady?.status !== "passed" ||
    report?.daemonRuntime?.healthz?.hardwareOnline !== true ||
    report?.daemonRuntime?.healthz?.scannerOnline !== true ||
    report?.daemonRuntime?.readyz?.ready !== true
  )
    throw new Error(
      `${failureMode} did not restore healthy daemon runtime after serial stop`,
    );
  return {
    runtimeReady: "passed",
    hardwareOnline: true,
    scannerOnline: true,
    ready: true,
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertBlockedSaleEvidence({
  commandExitStatus,
  output,
  failureMode,
  runId,
  expectedAdapterSession = null,
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
    (expectedAdapterSession !== null &&
      JSON.stringify(mappingFault?.adapterSession) !==
        JSON.stringify(expectedAdapterSession)) ||
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
    adapterSession: mappingFault.adapterSession ?? null,
    readinessBlockingCodes,
    responseBlockingCodes,
    transactionEntry,
    saleBindingCreated: false,
  };
}

export function observedMappingFailureCase({
  failureMode,
  startRequest,
  startReport,
  expectedDiagnosticCode,
  daemonFailClosed,
  recovery,
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
    !isNonEmptyString(serialSession?.deviceMappingDigest) ||
    !isNonEmptyString(startReport?.timestamps?.startedAt) ||
    JSON.stringify(daemonFailClosed?.adapterSession) !==
      JSON.stringify(adapterSessionEvidence(startReport)) ||
    recovery?.runtimeReady !== "passed" ||
    recovery?.hardwareOnline !== true ||
    recovery?.scannerOnline !== true ||
    recovery?.ready !== true
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
    recovery,
    source: {
      start: { request: startRequest, report: startReport },
      fault: { request: startRequest, report: startReport },
    },
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
    let failureCase;
    let recovery;
    try {
      const faultEnvironment = {
        ...options.environment,
        VEM_VM_HOST_SERIAL_CONFORMANCE_FAULT: failureMode,
      };
      const startRequest = requestFor({
        operation: "start-serial-session",
        ...options,
        saleBinding: null,
      });
      const start = await runVmHostAdapter({
        request: startRequest,
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
        options.failureCommands[failureMode].salePrepareCommand,
        failureMode,
        options.runId,
        start,
      );
      failureCase = {
        failureMode,
        startRequest,
        startReport: start,
        expectedDiagnosticCode: diagnosticCode,
        daemonFailClosed: failClosed,
      };
    } finally {
      if (mappingSession) {
        await stopFailureSession(
          options,
          mappingSession,
          options.successfulSaleBinding,
        );
        recovery = runRuntimeRecoveryCommand(
          options.failureCommands[failureMode].runtimeRecoveryCommand,
          failureMode,
        );
      }
    }
    cases.push(observedMappingFailureCase({ ...failureCase, recovery }));
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
    pendingSale = runSaleCommand(
      options.failureCommands["scanner-timeout"].salePrepareCommand,
      "prepare",
    );
    const scannerTimeoutRequest = requestFor({
      operation: "inject-scanner-code",
      ...options,
      session: scannerSession,
      scannerDescriptor: createScannerCodeDescriptor(options.scannerCode),
      saleBinding: pendingSale,
    });
    const scannerTimeout = await runVmHostAdapter({
      request: scannerTimeoutRequest,
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
        source: {
          fault: { request: scannerTimeoutRequest, report: scannerTimeout },
        },
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
    failedSale = runFailedDispenseCommand(
      options.failureCommands["dispense-failed"].saleCompleteCommand,
    );
    if (
      failedSale.orderId !== pendingSale.orderId ||
      failedSale.paymentId !== pendingSale.paymentId
    )
      throw new Error("dispense-failed sale changed the pending business IDs");
    const dispenseFailureRequest = requestFor({
      operation: "collect-serial-evidence",
      ...options,
      session: dispenseSession,
      scannerDescriptor: {
        operationNonce: dispenseInject.request.operationNonce,
        ...createScannerCodeDescriptor(options.scannerCode),
      },
      saleBinding: failedSale,
    });
    const dispenseFailure = await runVmHostAdapter({
      request: dispenseFailureRequest,
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
        source: {
          fault: { request: dispenseFailureRequest, report: dispenseFailure },
        },
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
  source,
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
    source,
  };
}

function contractMappingFailureCase({
  failureMode,
  startRequest,
  startReport,
  faultRequest,
  faultReport,
  adapterResult,
  diagnosticCode,
}) {
  const startSerialSession = {
    serialSessionId: startReport.serialSession.serialSessionId,
    startOperationReference: startReport.serialSession.startOperationReference,
    deviceMappingDigest: startReport.serialSession.deviceMappingDigest,
  };
  const blockingCodes = ["LOWER_CONTROLLER_UNAVAILABLE"];
  return {
    failureMode,
    operation: "prepare-sale-with-faulted-mapping",
    result: "observed_failure",
    adapterResult,
    diagnosticCode,
    startSerialSession,
    daemonFailClosed: {
      commandExitStatus: 1,
      simulatedHardwareReady: "failed",
      daemonHealthObserved: true,
      hardwareOnline: false,
      scannerOnline: false,
      readyzObserved: true,
      adapterSession: {
        ...startSerialSession,
        faultStartedAt: startReport.timestamps.startedAt,
      },
      readinessBlockingCodes: blockingCodes,
      responseBlockingCodes: blockingCodes,
      transactionEntry: {
        endpoint: "/v1/intents/create-order",
        attempted: true,
        rejected: true,
        statusCode: 400,
        responseCode: "create_order_blocked",
        readinessBlockingCodes: blockingCodes,
        orderId: null,
        paymentId: null,
        vendingCommandId: null,
      },
      saleBindingCreated: false,
    },
    source: {
      start: { request: startRequest, report: startReport },
      fault: { request: faultRequest, report: faultReport },
    },
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
    const mappingFailure = ["swapped-roles", "missing-device"].includes(
      failureMode,
    );
    const failureSaleBinding = mappingFailure
      ? null
      : failureMode === "scanner-timeout"
        ? { ...saleBinding, vendingCommandId: null }
        : saleBinding;
    let session;
    try {
      const startRequest = requestFor({
        operation: "start-serial-session",
        runId,
        targetIdentity,
        lifecycleReference,
        approvedRuntimeBase,
        saleCorrelationId,
        saleBinding: failureSaleBinding,
      });
      const start = await runVmHostAdapter({
        request: startRequest,
        workDirectory,
        environment: ["swapped-roles", "missing-device"].includes(failureMode)
          ? {
              ...environment,
              VEM_VM_HOST_SERIAL_CONFORMANCE_FAULT: failureMode,
            }
          : environment,
      });
      session = start.serialSession;
      if (mappingFailure) {
        const diagnosticCode = assertObservedDeviceFault(
          start,
          failureMode,
          expectedCode,
          null,
        );
        cases.push(
          contractMappingFailureCase({
            failureMode,
            startRequest,
            startReport: start,
            faultRequest: startRequest,
            faultReport: start,
            adapterResult: start.result,
            diagnosticCode,
          }),
        );
        continue;
      }
      const scannerDescriptor = createScannerCodeDescriptor(scannerCode);
      const injectRequest = requestFor({
        operation: "inject-scanner-code",
        runId,
        targetIdentity,
        lifecycleReference,
        approvedRuntimeBase,
        session,
        scannerDescriptor,
        saleCorrelationId,
        saleBinding: failureSaleBinding,
      });
      const inject = await runVmHostAdapter({
        request: injectRequest,
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
      const observationRequest =
        failureMode === "scanner-timeout"
          ? injectRequest
          : requestFor({
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
              saleBinding: failureSaleBinding,
            });
      const observation =
        failureMode === "scanner-timeout"
          ? inject
          : await runVmHostAdapter({
              request: observationRequest,
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
        failureSaleBinding,
      );
      const failureCase = observedFailureCase({
        failureMode,
        operation:
          failureMode === "scanner-timeout"
            ? "inject-scanner-code"
            : "collect-serial-evidence",
        report: observation,
        saleBinding: failureSaleBinding,
        diagnosticCode,
        source: {
          fault: { request: observationRequest, report: observation },
        },
      });
      if (failureMode === "scanner-timeout")
        delete failureCase.vendingCommandId;
      cases.push(failureCase);
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
          mappingFailure ? saleBinding : failureSaleBinding,
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
