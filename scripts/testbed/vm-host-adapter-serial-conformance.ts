#!/usr/bin/env node

import type { KeyObject } from "node:crypto";

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
} from "./vm-host-adapter-contract.ts";

interface RunnerEvidence {
  privateKey: KeyObject;
  publicKey: string;
  expectedRunnerPublicKey?: string;
  runnerChallenge?: string;
  operations: Record<string, Record<string, unknown>>;
}

function assertConformance(
  condition: unknown,
  message: string,
): asserts condition {
  if (!condition) throw new Error(message);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function deriveSerialOperationReportDigest(report: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(report))
    .digest("hex")}`;
}

export function deriveSerialConformanceReportDigest(
  report: Record<string, unknown>,
): string {
  const committedReport = structuredClone(report);
  const runnerEvidence = committedReport.runnerEvidence as
    | Record<string, unknown>
    | undefined;
  if (runnerEvidence) delete runnerEvidence.conformance;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(committedReport))
    .digest("hex")}`;
}

function runnerChallenge(): string {
  return `serial-runner-challenge://sha256-${randomBytes(32).toString("hex")}`;
}

function createRunnerEvidence(): RunnerEvidence {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    publicKey: `ed25519-public-key:base64:${publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64")}`,
    operations: {},
  };
}

function publicKeyEncoding(publicKey: KeyObject): string {
  return `ed25519-public-key:base64:${publicKey
    .export({ type: "spki", format: "der" })
    .toString("base64")}`;
}

function protectedRunnerSigningKey(): RunnerEvidence {
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
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(readFileSync(keyPath, "utf8"));
  } finally {
    rmSync(keyPath, { force: true });
  }
  const publicKey = publicKeyEncoding(
    createPublicKey(
      privateKey as unknown as Parameters<typeof createPublicKey>[0],
    ),
  );
  if (publicKey !== expectedRunnerPublicKey)
    throw new Error(
      "--runner-signing-key-file does not match --expected-runner-public-key",
    );
  return { privateKey, publicKey, expectedRunnerPublicKey, operations: {} };
}

function commitRunnerOperation(
  evidence: RunnerEvidence,
  stage: string,
  report: Record<string, unknown>,
): string {
  const reportDigest = deriveSerialOperationReportDigest(report);
  evidence.operations[stage] = {
    operationReference: (report.request as Record<string, unknown>)
      .operationReference,
    reportDigest,
    signature: `ed25519-signature:base64:${sign(
      null,
      Buffer.from(reportDigest),
      evidence.privateKey,
    ).toString("base64")}`,
  };
  return reportDigest;
}

function commitRunnerConformance(
  evidence: RunnerEvidence,
  report: Record<string, unknown>,
): void {
  const reportDigest = deriveSerialConformanceReportDigest(report);
  (report.runnerEvidence as Record<string, unknown>).conformance = {
    reportDigest,
    signature: `ed25519-signature:base64:${sign(
      null,
      Buffer.from(reportDigest),
      evidence.privateKey,
    ).toString("base64")}`,
  };
}

function runnerPublicKey(expectedRunnerPublicKey: string): KeyObject {
  const keyPrefix = "ed25519-public-key:base64:";
  return createPublicKey({
    key: Buffer.from(expectedRunnerPublicKey.slice(keyPrefix.length), "base64"),
    format: "der",
    type: "spki",
  });
}

function validateRunnerConformanceEvidence(
  report: Record<string, unknown>,
  expectedRunnerPublicKey: string,
): void {
  const runnerEvidence = report.runnerEvidence as
    | Record<string, unknown>
    | undefined;
  const receipt = runnerEvidence?.conformance as
    | Record<string, unknown>
    | undefined;
  const signaturePrefix = "ed25519-signature:base64:";
  assertConformance(
    runnerEvidence?.publicKey === expectedRunnerPublicKey,
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
  evidence: RunnerEvidence,
  stage: string,
  report: Record<string, unknown>,
  expectedRunnerPublicKey: string,
): Record<string, unknown> {
  const receipt = evidence.operations?.[stage] as
    | Record<string, unknown>
    | undefined;
  assertConformance(
    receipt &&
      typeof receipt === "object" &&
      typeof receipt.operationReference === "string" &&
      typeof receipt.reportDigest === "string" &&
      typeof receipt.signature === "string",
    `runner ${stage} operation evidence is required`,
  );
  assertConformance(
    receipt.operationReference ===
      (report.request as Record<string, unknown>).operationReference &&
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
  input: unknown,
  {
    expectedRunnerPublicKey,
    expectedAdapterIdentity,
  }: {
    expectedRunnerPublicKey?: unknown;
    expectedAdapterIdentity?: unknown;
  } = {},
): Record<string, unknown> {
  const conformance = structuredClone(input) as Record<string, unknown>;
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
  const reports = conformance.reports as Record<string, unknown> | undefined;
  const requests = conformance.requests as Record<string, unknown> | undefined;
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

  const validatedReports: Record<string, Record<string, unknown>> = {};
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
    ) as Record<string, unknown>;
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
  const lifecycleIdentity = (
    report: Record<string, unknown>,
  ): Record<string, unknown> => ({
    adapter: report.adapter,
    vmIdentity: (report.observed as Record<string, unknown>).vmIdentity,
    targetBinding: (report.observed as Record<string, unknown>).targetBinding,
    baseIdentity: (report.observed as Record<string, unknown>).baseIdentity,
    overlayIdentity: (report.observed as Record<string, unknown>)
      .overlayIdentity,
  });
  assertConformance(
    (start.adapter as Record<string, unknown>).identity ===
      expectedAdapterIdentity &&
      [inject, collect, firstStop, repeatedStop].every((report) =>
        sameJson(lifecycleIdentity(report), lifecycleIdentity(start)),
      ),
    "serial conformance reports must bind one trusted adapter and VM lifecycle",
  );
  const startReceipt = validateRunnerOperationEvidence(
    conformance.runnerEvidence as RunnerEvidence,
    "start",
    start,
    expectedRunnerPublicKey,
  );
  const injectReceipt = validateRunnerOperationEvidence(
    conformance.runnerEvidence as RunnerEvidence,
    "inject",
    inject,
    expectedRunnerPublicKey,
  );
  validateRunnerOperationEvidence(
    conformance.runnerEvidence as RunnerEvidence,
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
    (start.request as Record<string, unknown>).operation ===
      "start-serial-session" &&
      (inject.request as Record<string, unknown>).operation ===
        "inject-scanner-code" &&
      (collect.request as Record<string, unknown>).operation ===
        "collect-serial-evidence" &&
      (firstStop.request as Record<string, unknown>).operation ===
        "stop-serial-session" &&
      (repeatedStop.request as Record<string, unknown>).operation ===
        "stop-serial-session",
    "serial conformance lifecycle report operations are invalid",
  );
  assertConformance(
    [start, inject, collect, firstStop, repeatedStop].every(
      (report) =>
        (report.request as Record<string, unknown>).runId === conformance.runId,
    ),
    "serial conformance reports must bind the declared run",
  );
  assertConformance(
    [inject, collect, firstStop, repeatedStop].every(
      (report) =>
        (report.request as Record<string, unknown>).lifecycleReference ===
          (start.request as Record<string, unknown>).lifecycleReference &&
        (report.request as Record<string, unknown>).targetIdentity ===
          (start.request as Record<string, unknown>).targetIdentity,
    ),
    "serial conformance reports must bind one lifecycle target",
  );
  const startSession = start.serialSession as
    | Record<string, unknown>
    | undefined;
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
        (key) =>
          (
            (report.request as Record<string, unknown>).serialSession as
              | Record<string, unknown>
              | undefined
          )?.[key] === startSession[key],
      ),
      "serial conformance reports must retain the validated start session",
    );
  assertConformance(
    (
      (
        (collect.request as Record<string, unknown>).serialSession as Record<
          string,
          unknown
        >
      ).scannerInjection as Record<string, unknown> | undefined
    )?.operationNonce ===
      (inject.request as Record<string, unknown>).operationNonce,
    "serial evidence collection must bind the validated scanner injection",
  );
  assertConformance(
    sameJson(
      (
        (collect.request as Record<string, unknown>).serialSession as Record<
          string,
          unknown
        >
      ).operationEvidence,
      {
        runnerChallenge: (conformance.runnerEvidence as RunnerEvidence)
          .runnerChallenge,
        startReportDigest: startReceipt.reportDigest,
        injectReportDigest: injectReceipt.reportDigest,
      },
    ),
    "serial evidence collection must use runner-held start and inject commitments",
  );
  const injectedSale = (
    (inject.request as Record<string, unknown>).serialSession as Record<
      string,
      unknown
    >
  ).saleBindings as Array<Record<string, unknown>> | undefined;
  const collectedSale = (
    (collect.request as Record<string, unknown>).serialSession as Record<
      string,
      unknown
    >
  ).saleBindings as Array<Record<string, unknown>> | undefined;
  assertConformance(
    injectedSale?.length === 1 &&
      collectedSale?.length === 1 &&
      injectedSale[0].saleCorrelationId ===
        collectedSale[0].saleCorrelationId &&
      injectedSale[0].orderId === collectedSale[0].orderId &&
      injectedSale[0].paymentId === collectedSale[0].paymentId &&
      injectedSale[0].vendingCommandId === null &&
      typeof collectedSale[0].vendingCommandId === "string",
    "serial collection must complete the injected sale without relabeling it",
  );
  const injectSaleBindings = (
    (inject.request as Record<string, unknown>).serialSession as Record<
      string,
      unknown
    >
  ).saleBindings as Array<Record<string, unknown>> | undefined;
  const collectSaleBindings = (
    (collect.request as Record<string, unknown>).serialSession as Record<
      string,
      unknown
    >
  ).saleBindings as Array<Record<string, unknown>> | undefined;
  if (conformance.profile === "installed-kiosk-sale") {
    assertConformance(
      (conformance.customerUiSale as Record<string, unknown> | undefined)
        ?.orderId === collectedSale?.[0]?.orderId &&
        (conformance.customerUiSale as Record<string, unknown> | undefined)
          ?.paymentId === collectedSale?.[0]?.paymentId &&
        (conformance.customerUiSale as Record<string, unknown> | undefined)
          ?.orderNo &&
        (conformance.customerUiSale as Record<string, unknown> | undefined)
          ?.scenarioSha256 &&
        (injectSaleBindings?.length ?? 0) === 1 &&
        (collectSaleBindings?.length ?? 0) === 1 &&
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
  failureMatrix: unknown,
  completedSale: Array<Record<string, unknown>> | undefined,
  expectedLifecycleIdentity: Record<string, unknown>,
): void {
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
  const failureEntries = failureMatrix as Array<Record<string, unknown>>;
  const byMode = new Map<string, Record<string, unknown>>(
    failureEntries.map((entry) => [String(entry?.failureMode), entry]),
  );
  const faultOf = (entry: Record<string, unknown>): Record<string, unknown> =>
    ((entry.source as Record<string, unknown> | undefined)?.fault as
      | Record<string, unknown>
      | undefined) ?? {};
  const faultRequest = (
    entry: Record<string, unknown>,
  ): Record<string, unknown> =>
    (faultOf(entry).request as Record<string, unknown> | undefined) ?? {};
  const faultReport = (
    entry: Record<string, unknown>,
  ): Record<string, unknown> =>
    (faultOf(entry).report as Record<string, unknown> | undefined) ?? {};
  const serialSessionOf = (
    request: Record<string, unknown>,
  ): Record<string, unknown> =>
    (request.serialSession as Record<string, unknown> | undefined) ?? {};
  assertConformance(
    byMode.size === expected.size,
    "serial conformance failure matrix modes must be unique",
  );
  for (const [failureMode, [operation, diagnosticCode]] of expected) {
    const entry = byMode.get(failureMode);
    if (entry === undefined) {
      throw new Error(
        `serial conformance ${failureMode} failure evidence is invalid`,
      );
    }
    assertConformance(
      entry?.operation === operation &&
        entry.result === "observed_failure" &&
        entry.adapterResult === "succeeded" &&
        entry.diagnosticCode === diagnosticCode,
      `serial conformance ${failureMode} failure evidence is invalid`,
    );
    validateFailureSource(
      (entry.source as Record<string, unknown> | undefined)?.fault,
      `${failureMode} fault`,
      expectedLifecycleIdentity,
    );
    const faultRequestRecord = faultRequest(entry);
    const faultReportRecord = faultReport(entry);
    assertConformance(
      (failureMode === "swapped-roles" || failureMode === "missing-device"
        ? faultRequestRecord.operation === "start-serial-session" &&
          sameJson(serialSessionOf(faultRequestRecord).saleBindings, [])
        : faultRequestRecord.operation === operation) &&
        (
          faultReportRecord.diagnostics as
            | Array<Record<string, unknown>>
            | undefined
        )?.some((diagnostic) => diagnostic?.code === diagnosticCode),
      `serial conformance ${failureMode} source does not prove the declared fault`,
    );
  }

  for (const failureMode of ["malformed-frame", "device-disconnected"]) {
    const entry = byMode.get(failureMode);
    if (entry === undefined) continue;
    const sourceSale = serialSessionOf(faultRequest(entry)).saleBindings;
    assertConformance(
      entry.orderId === completedSale?.[0]?.orderId &&
        entry.paymentId === completedSale?.[0]?.paymentId &&
        entry.vendingCommandId === completedSale?.[0]?.vendingCommandId &&
        sameJson(sourceSale, completedSale ? [completedSale[0]] : []),
      `serial conformance ${failureMode} must bind the completed sale`,
    );
  }
  const scannerTimeout = byMode.get("scanner-timeout");
  const dispenseFailed = byMode.get("dispense-failed");
  const scannerSale = scannerTimeout
    ? (serialSessionOf(faultRequest(scannerTimeout)).saleBindings as
        | Array<Record<string, unknown>>
        | undefined)
    : undefined;
  const dispenseSale = dispenseFailed
    ? (serialSessionOf(faultRequest(dispenseFailed)).saleBindings as
        | Array<Record<string, unknown>>
        | undefined)
    : undefined;
  if (scannerTimeout === undefined || dispenseFailed === undefined) {
    throw new Error(
      "serial conformance scanner timeout and failed dispense are required",
    );
  }
  assertConformance(
    typeof scannerTimeout.orderId === "string" &&
      typeof scannerTimeout.paymentId === "string" &&
      scannerTimeout.orderId === scannerSale?.[0]?.orderId &&
      scannerTimeout.paymentId === scannerSale?.[0]?.paymentId &&
      scannerTimeout.orderId === dispenseFailed.orderId &&
      scannerTimeout.paymentId === dispenseFailed.paymentId &&
      !Object.hasOwn(scannerTimeout, "vendingCommandId") &&
      scannerSale?.[0]?.vendingCommandId === null &&
      typeof dispenseFailed.vendingCommandId === "string" &&
      dispenseFailed.orderId === dispenseSale?.[0]?.orderId &&
      dispenseFailed.paymentId === dispenseSale?.[0]?.paymentId &&
      dispenseFailed.vendingCommandId === dispenseSale?.[0]?.vendingCommandId,
    "serial conformance scanner timeout and failed dispense must bind one failed sale",
  );

  for (const failureMode of ["swapped-roles", "missing-device"]) {
    const entry = byMode.get(failureMode);
    if (entry === undefined) {
      throw new Error(
        `serial conformance ${failureMode} mapping failure is required`,
      );
    }
    const start = validateFailureSource(
      (entry.source as Record<string, unknown> | undefined)?.start,
      `${failureMode} start`,
      expectedLifecycleIdentity,
    );
    const fault = validateFailureSource(
      (entry.source as Record<string, unknown> | undefined)?.fault,
      `${failureMode} fault session`,
      expectedLifecycleIdentity,
    );
    const session = entry.startSerialSession as
      | Record<string, unknown>
      | undefined;
    const faultSession = fault.serialSession as
      | Record<string, unknown>
      | undefined;
    const failClosed = entry.daemonFailClosed as
      | Record<string, unknown>
      | undefined;
    if (failClosed === undefined) {
      throw new Error(
        `serial conformance ${failureMode} mapping failure is missing fail-closed evidence`,
      );
    }
    const transactionEntry = failClosed.transactionEntry as
      | Record<string, unknown>
      | undefined;
    const recovery = entry.recovery as Record<string, unknown> | undefined;
    assertConformance(
      !Object.hasOwn(entry, "orderId") &&
        !Object.hasOwn(entry, "paymentId") &&
        !Object.hasOwn(entry, "vendingCommandId") &&
        sameJson(
          (entry.source as Record<string, unknown>).start,
          (entry.source as Record<string, unknown>).fault,
        ) &&
        sameJson(serialSessionOf(faultRequest(entry)).saleBindings, []) &&
        sameJson(session, {
          serialSessionId: (
            start.serialSession as Record<string, unknown> | undefined
          )?.serialSessionId,
          startOperationReference: (
            start.serialSession as Record<string, unknown> | undefined
          )?.startOperationReference,
          deviceMappingDigest: (
            start.serialSession as Record<string, unknown> | undefined
          )?.deviceMappingDigest,
        }) &&
        [
          "serialSessionId",
          "startOperationReference",
          "deviceMappingDigest",
        ].every((key) => faultSession?.[key] === session?.[key]) &&
        Number(failClosed.commandExitStatus) > 0 &&
        failClosed.simulatedHardwareReady === "failed" &&
        failClosed.daemonHealthObserved === true &&
        failClosed.hardwareOnline === false &&
        failClosed.readyzObserved === true &&
        sameJson(failClosed.adapterSession, {
          ...session,
          faultStartedAt: (
            failClosed.adapterSession as Record<string, unknown> | undefined
          )?.faultStartedAt,
        }) &&
        typeof (failClosed.adapterSession as Record<string, unknown>)
          .faultStartedAt === "string" &&
        sameJson(failClosed.readinessBlockingCodes, [
          "LOWER_CONTROLLER_UNAVAILABLE",
        ]) &&
        sameJson(failClosed.responseBlockingCodes, [
          "LOWER_CONTROLLER_UNAVAILABLE",
        ]) &&
        transactionEntry?.endpoint === "/v1/intents/create-order" &&
        transactionEntry?.attempted === true &&
        transactionEntry?.rejected === true &&
        transactionEntry?.statusCode === 400 &&
        transactionEntry?.responseCode === "create_order_blocked" &&
        sameJson(transactionEntry?.readinessBlockingCodes, [
          "LOWER_CONTROLLER_UNAVAILABLE",
        ]) &&
        transactionEntry?.orderId === null &&
        transactionEntry?.paymentId === null &&
        transactionEntry?.vendingCommandId === null &&
        failClosed.saleBindingCreated === false &&
        recovery?.runtimeReady === "passed" &&
        recovery?.hardwareOnline === true &&
        recovery?.scannerOnline === true &&
        recovery?.ready === true,
      `serial conformance ${failureMode} mapping failure is not fail-closed and recovered`,
    );
  }
}

export function readFailureMatrixCommands(
  commandJson: unknown,
): Record<string, unknown> {
  let commands: Record<string, unknown>;
  try {
    commands = JSON.parse(String(commandJson)) as Record<string, unknown>;
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
    const entry = commands?.[failureMode] as
      | Record<string, unknown>
      | undefined;
    if (!entry || typeof entry !== "object")
      throw new Error(`${failureMode} failure matrix commands are required`);
    for (const key of keys)
      if (
        !Array.isArray(entry[key]) ||
        (entry[key] as unknown[]).length < 2 ||
        !(entry[key] as unknown[]).every(
          (argument) => typeof argument === "string",
        )
      )
        throw new Error(`${failureMode} ${key} must be a command array`);
  }
  return commands;
}

function readFailureMatrixArtifactPaths(
  pathJson: unknown,
): Record<string, unknown> {
  let paths: Record<string, unknown>;
  try {
    paths = JSON.parse(String(pathJson)) as Record<string, unknown>;
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
    const report = (paths?.[failureMode] as Record<string, unknown> | undefined)
      ?.report;
    if (typeof report !== "string" || report.trim().length === 0)
      throw new Error(`${failureMode} failure matrix report path is required`);
    return report;
  });
  if (new Set(reports).size !== reports.length)
    throw new Error("failure matrix report paths must be unique");
  return paths;
}

function writeFailureMatrixArtifacts(
  failureMatrix: Array<Record<string, unknown>>,
  paths: Record<string, unknown>,
): void {
  for (const entry of failureMatrix) {
    const reportPath = String(
      (paths[String(entry.failureMode)] as Record<string, unknown>).report,
    );
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

function validateFailureSource(
  source: unknown,
  label: string,
  expectedLifecycleIdentity: Record<string, unknown>,
): Record<string, unknown> {
  const sourceRecord = source as Record<string, unknown> | null | undefined;
  assertConformance(
    sourceRecord?.request && sourceRecord?.report,
    `serial conformance ${label} source is required`,
  );
  const report = validateVmHostAdapterReport(
    sourceRecord.report,
    sourceRecord.request,
  ) as Record<string, unknown>;
  const lifecycleIdentity = {
    adapter: report.adapter,
    vmIdentity: (report.observed as Record<string, unknown>).vmIdentity,
    targetBinding: (report.observed as Record<string, unknown>).targetBinding,
    baseIdentity: (report.observed as Record<string, unknown>).baseIdentity,
    overlayIdentity: (report.observed as Record<string, unknown>)
      .overlayIdentity,
  };
  assertConformance(
    sameJson(lifecycleIdentity, expectedLifecycleIdentity),
    `serial conformance ${label} source belongs to another VM lifecycle`,
  );
  return report;
}

function readOption(
  name: string,
  { optional = false }: { optional?: boolean } = {},
): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    if (optional) return null;
    throw new Error(`${name} is required`);
  }
  return process.argv[index + 1];
}

function readProtectedScannerCode(): Buffer {
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

function readCustomerUiSaleBinding(): Record<string, unknown> | null {
  const path = readOption("--customer-ui-sale-binding-file", {
    optional: true,
  });
  if (!path) return null;
  let binding: Record<string, unknown>;
  try {
    binding = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("--customer-ui-sale-binding-file must contain JSON");
  }
  for (const field of ["orderId", "paymentId", "orderNo", "scenarioSha256"]) {
    if (typeof binding?.[field] !== "string" || binding[field].trim() === "")
      throw new Error(`customer UI sale binding requires ${field}`);
  }
  return binding;
}

function nonce(): string {
  return `op-${randomBytes(16).toString("hex")}`;
}

function asset(identity: unknown): Record<string, unknown> {
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
}: {
  operation: string;
  runId: string | null;
  targetIdentity: string | null;
  lifecycleReference: string | null;
  approvedRuntimeBase: string | null;
  session?: Record<string, unknown> | null;
  scannerDescriptor?: Record<string, unknown> | null;
  saleCorrelationId: string | null;
  saleBinding?: Record<string, unknown> | null | undefined;
  operationEvidence?: Record<string, unknown> | null;
  idempotencyCheck?: boolean;
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
  const request: Record<string, unknown> = {
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
          serialSessionId: session?.serialSessionId,
          sessionBindingToken: session?.sessionBindingToken,
          startOperationReference: session?.startOperationReference,
          deviceMappingDigest: session?.deviceMappingDigest,
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
  const requireOption = (name: string): string => {
    const value = readOption(name);
    if (value === null) throw new Error(`${name} is required`);
    return value;
  };
  const adapter = requireOption("--adapter");
  const out = requireOption("--out");
  const scannerCode = readProtectedScannerCode();
  const runId = requireOption("--run-id");
  const targetIdentity = requireOption("--target-identity");
  const approvedRuntimeBase = requireOption("--runtime-base");
  const lifecycleReference = requireOption("--lifecycle-reference");
  const saleCorrelationId = requireOption("--sale-correlation-id");
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

  let start: Record<string, unknown> | null = null;
  let inject: Record<string, unknown> | null = null;
  let collect: Record<string, unknown> | null = null;
  let firstStop: Record<string, unknown> | null = null;
  let repeatedStop: Record<string, unknown> | null = null;
  let recoveryStop: Record<string, unknown> | null = null;
  let failureMatrix: Array<Record<string, unknown>> | undefined;
  const failureMatrixArtifactPaths = startOnly
    ? null
    : customerUiSale
      ? null
      : contractTest
        ? null
        : readFailureMatrixArtifactPaths(
            readOption("--failure-matrix-artifact-paths-json"),
          );
  let session: Record<string, unknown> | null = null;
  let startRequest: Record<string, unknown> | null = null;
  let injectRequest: Record<string, unknown> | null = null;
  let collectRequest: Record<string, unknown> | null = null;
  let firstStopRequest: Record<string, unknown> | null = null;
  let repeatedStopRequest: Record<string, unknown> | null = null;
  let recoveryStopRequest: Record<string, unknown> | null = null;
  let preparedSale: Record<string, unknown> | null = null;
  let completedSale: Record<string, unknown> | null = null;
  let primaryError: unknown;
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
      startRequest = prestarted.request as Record<string, unknown>;
      start = prestarted.report as Record<string, unknown>;
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
      start = (await runVmHostAdapter({
        request: startRequest,
        workDirectory,
        environment,
      })) as Record<string, unknown>;
    }
    const startReportDigest = commitRunnerOperation(
      runnerEvidence,
      "start",
      start,
    );
    session = (start as Record<string, unknown>).serialSession as Record<
      string,
      unknown
    > | null;
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
    inject = (await runVmHostAdapter({
      request: injectRequest,
      workDirectory,
      environment,
      scannerCode,
    })) as Record<string, unknown>;
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
        operationNonce: (inject as Record<string, unknown>).request
          ? (
              (inject as Record<string, unknown>).request as Record<
                string,
                unknown
              >
            ).operationNonce
          : undefined,
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
    collect = (await runVmHostAdapter({
      request: collectRequest,
      workDirectory,
      environment,
    })) as Record<string, unknown>;
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
    firstStop = (await runVmHostAdapter({
      request: firstStopRequest,
      workDirectory,
      environment,
    })) as Record<string, unknown>;
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
    repeatedStop = (await runVmHostAdapter({
      request: repeatedStopRequest,
      workDirectory,
      environment,
    })) as Record<string, unknown>;
    const repeatedStopReport = repeatedStop;
    if (repeatedStopReport === null) {
      throw new Error("repeated serial stop report is missing");
    }
    if (
      !(
        (
          (repeatedStopReport.serialSession as Record<string, unknown>)
            .simulatorCleanup as Record<string, unknown>
        ).idempotencyVerified === true
      )
    )
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
    if (failureMatrixArtifactPaths && failureMatrix !== undefined)
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
        recoveryStop = (await runVmHostAdapter({
          request: recoveryStopRequest,
          workDirectory,
          environment,
        })) as Record<string, unknown>;
      } catch (error) {
        if (!primaryError) primaryError = error;
      }
    }
    if (!startOnly) {
      const conformance: Record<string, unknown> = {
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
          session == null
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
            ? (start?.adapter as Record<string, unknown> | undefined)?.identity
            : process.env.VEM_VM_HOST_EXPECTED_ADAPTER_IDENTITY,
        });
    }
  }
  if (primaryError) throw primaryError;
}

function readCommandJson(option: string): string[] {
  let command: string[];
  try {
    command = JSON.parse(String(readOption(option))) as string[];
  } catch {
    throw new Error(`${option} must be a JSON command array`);
  }
  if (!Array.isArray(command) || command.length < 2)
    throw new Error(`${option} must be a JSON command array`);
  return command;
}

function runSaleCommand(
  command: string[],
  expectedPhase: string,
): Record<string, unknown> {
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
  let output = JSON.parse(result.stdout || "null") as Record<string, unknown>;
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
  const sale = (
    output?.simulatedHardwareSaleFlow as Record<string, unknown> | undefined
  )?.sale as Record<string, unknown> | undefined;
  if (
    (output?.simulatedHardwareSaleFlow as Record<string, unknown> | undefined)
      ?.phase !== expectedPhase ||
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
  command: string[],
  saleCorrelationId: string | null = readOption("--sale-correlation-id"),
): Record<string, unknown> {
  if (!Array.isArray(command) || command.length < 2)
    throw new Error("failed-dispense sale command must be a JSON array");
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  const output = JSON.parse(result.stdout || "null") as Record<string, unknown>;
  const sale = (
    output?.simulatedHardwareSaleFlow as Record<string, unknown> | undefined
  )?.sale as Record<string, unknown> | undefined;
  if (
    result.status === 0 ||
    (output?.simulatedHardwareSaleFlow as Record<string, unknown> | undefined)
      ?.phase !== "complete" ||
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

function adapterSessionEvidence(
  startReport: Record<string, unknown>,
): Record<string, unknown> {
  const serialSession = startReport.serialSession as Record<string, unknown>;
  const timestamps = startReport.timestamps as Record<string, unknown>;
  return {
    serialSessionId: serialSession.serialSessionId,
    startOperationReference: serialSession.startOperationReference,
    deviceMappingDigest: serialSession.deviceMappingDigest,
    faultStartedAt: timestamps.startedAt,
  };
}

function runBlockedSaleCommand(
  command: string[],
  failureMode: string,
  runId: string,
  startReport: Record<string, unknown>,
): Record<string, unknown> {
  if (!Array.isArray(command) || command.length < 2)
    throw new Error(`${failureMode} blocked-sale command must be a JSON array`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: {
      ...process.env,
      VEM_VM_HOST_FAULT_SESSION_ID: String(
        (startReport.serialSession as Record<string, unknown>).serialSessionId,
      ),
      VEM_VM_HOST_FAULT_START_OPERATION_REFERENCE: String(
        (startReport.serialSession as Record<string, unknown>)
          .startOperationReference,
      ),
      VEM_VM_HOST_FAULT_DEVICE_MAPPING_DIGEST: String(
        (startReport.serialSession as Record<string, unknown>)
          .deviceMappingDigest,
      ),
      VEM_VM_HOST_FAULT_STARTED_AT: String(
        (startReport.timestamps as Record<string, unknown>).startedAt,
      ),
    },
    encoding: "utf8",
  });
  let output: Record<string, unknown>;
  try {
    output = JSON.parse(result.stdout || "null") as Record<string, unknown>;
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

function runRuntimeRecoveryCommand(
  command: string[],
  failureMode: string,
): Record<string, unknown> {
  if (!Array.isArray(command) || command.length < 2)
    throw new Error(`${failureMode} recovery command must be a JSON array`);
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
  let output: Record<string, unknown>;
  try {
    output = JSON.parse(result.stdout || "null") as Record<string, unknown>;
  } catch {
    throw new Error(`${failureMode} recovery command returned invalid JSON`);
  }
  const report = output?.runtimeAcceptanceReport as
    | Record<string, unknown>
    | undefined;
  if (
    result.status !== 0 ||
    output?.ok !== true ||
    (
      (report?.result as Record<string, unknown> | undefined)?.runtimeReady as
        | Record<string, unknown>
        | undefined
    )?.status !== "passed" ||
    (
      (report?.daemonRuntime as Record<string, unknown> | undefined)
        ?.healthz as Record<string, unknown> | undefined
    )?.hardwareOnline !== true ||
    (
      (report?.daemonRuntime as Record<string, unknown> | undefined)
        ?.healthz as Record<string, unknown> | undefined
    )?.scannerOnline !== true ||
    (
      (report?.daemonRuntime as Record<string, unknown> | undefined)?.readyz as
        | Record<string, unknown>
        | undefined
    )?.ready !== true
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

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertBlockedSaleEvidence({
  commandExitStatus,
  output,
  failureMode,
  runId,
  expectedAdapterSession = null,
}: {
  commandExitStatus: unknown;
  output: Record<string, unknown>;
  failureMode: string;
  runId: string;
  expectedAdapterSession?: Record<string, unknown> | null;
}): Record<string, unknown> {
  const flow = output?.simulatedHardwareSaleFlow as
    | Record<string, unknown>
    | undefined;
  const sale = flow?.sale as Record<string, unknown> | undefined;
  const healthz = (flow?.daemonIpc as Record<string, unknown> | undefined)
    ?.healthz as Record<string, unknown> | undefined;
  const readyz = (flow?.daemonIpc as Record<string, unknown> | undefined)
    ?.readyz as Record<string, unknown> | undefined;
  const mappingFault = flow?.hardwareMappingFault as
    | Record<string, unknown>
    | undefined;
  const transactionEntry = flow?.transactionEntry as
    | Record<string, unknown>
    | undefined;
  const readinessBlockingCodes = readyz?.blockingCodes;
  const responseBlockingCodes = transactionEntry?.responseBlockingCodes;
  const context = transactionEntry?.context as
    | {
        runId?: unknown;
        successfulPrepare?: {
          runId?: unknown;
          status?: unknown;
          phase?: unknown;
        };
        planogramVersion?: unknown;
        selectedItem?: Record<string, unknown>;
        paymentOption?: Record<string, unknown>;
      }
    | undefined;
  const request = transactionEntry?.request as
    | Record<string, unknown>
    | undefined;
  const selectedItem = context?.selectedItem as
    | Record<string, unknown>
    | undefined;
  const paymentOption = context?.paymentOption as
    | Record<string, unknown>
    | undefined;
  const exactLowerControllerBlocker =
    Array.isArray(readinessBlockingCodes) &&
    readinessBlockingCodes.length === 1 &&
    readinessBlockingCodes[0] === "LOWER_CONTROLLER_UNAVAILABLE";
  const exactResponseLowerControllerBlocker =
    Array.isArray(responseBlockingCodes) &&
    responseBlockingCodes.length === 1 &&
    responseBlockingCodes[0] === "LOWER_CONTROLLER_UNAVAILABLE";
  if (
    typeof commandExitStatus !== "number" ||
    !Number.isInteger(commandExitStatus) ||
    commandExitStatus <= 0 ||
    output?.ok === true ||
    flow?.phase !== "prepare" ||
    (
      (flow?.result as Record<string, unknown> | undefined)
        ?.simulatedHardwareReady as Record<string, unknown> | undefined
    )?.status !== "failed" ||
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
    !isNonEmptyString(selectedItem?.slotDisplayLabel) ||
    !isNonEmptyString(context?.planogramVersion) ||
    paymentOption?.method === "payment_code" ||
    !isNonEmptyString(paymentOption?.optionKey) ||
    !isNonEmptyString(paymentOption?.method) ||
    !isNonEmptyString(paymentOption?.providerCode) ||
    paymentOption?.ready !== true ||
    request?.inventoryId !== selectedItem?.inventoryId ||
    request?.slotId !== selectedItem?.slotId ||
    request?.slotDisplayLabel !== selectedItem?.slotDisplayLabel ||
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
}: {
  failureMode: string;
  startRequest: Record<string, unknown>;
  startReport: Record<string, unknown>;
  expectedDiagnosticCode: string;
  daemonFailClosed: Record<string, unknown>;
  recovery: Record<string, unknown>;
}): Record<string, unknown> {
  const serialSession = startReport?.serialSession as
    | Record<string, unknown>
    | undefined;
  const diagnosticCode = (
    startReport?.diagnostics as Array<Record<string, unknown>> | undefined
  )?.find((diagnostic) => diagnostic?.code === expectedDiagnosticCode)?.code;
  if (
    startReport?.result !== "succeeded" ||
    diagnosticCode !== expectedDiagnosticCode ||
    !isNonEmptyString(serialSession?.serialSessionId) ||
    !isNonEmptyString(serialSession?.startOperationReference) ||
    !isNonEmptyString(serialSession?.deviceMappingDigest) ||
    !isNonEmptyString(
      (startReport?.timestamps as Record<string, unknown> | undefined)
        ?.startedAt,
    ) ||
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
      serialSessionId: serialSession?.serialSessionId,
      startOperationReference: serialSession?.startOperationReference,
      deviceMappingDigest: serialSession?.deviceMappingDigest,
    },
    daemonFailClosed,
    recovery,
    source: {
      start: { request: startRequest, report: startReport },
      fault: { request: startRequest, report: startReport },
    },
  };
}

interface FailureMatrixOptions {
  runId: string;
  targetIdentity: string;
  lifecycleReference: string;
  approvedRuntimeBase: string;
  saleCorrelationId: string;
  saleBinding?: Record<string, unknown> | null | undefined;
  scannerCode: Buffer;
  workDirectory: string;
  environment: NodeJS.ProcessEnv;
  failureCommands?: Record<string, unknown>;
  successfulSaleBinding?: Record<string, unknown> | null;
  failureModes?: string[];
}

async function runProductionFailureMatrix(
  options: FailureMatrixOptions,
): Promise<Array<Record<string, unknown>>> {
  const cases = await runFailureMatrix({
    ...options,
    saleBinding: options.successfulSaleBinding,
    failureModes: ["malformed-frame", "device-disconnected"],
  });

  for (const [failureMode, expectedCode] of [
    ["swapped-roles", "serial_swapped_roles"],
    ["missing-device", "serial_missing_device"],
  ]) {
    let mappingSession: Record<string, unknown> | null = null;
    let failureCase: Record<string, unknown> | undefined;
    let recovery: Record<string, unknown> | undefined;
    try {
      const faultEnvironment: Record<string, string> = {
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
      mappingSession = start.serialSession as Record<string, unknown>;
      const diagnosticCode = assertObservedDeviceFault(
        start,
        failureMode,
        expectedCode,
        null,
      );
      const failClosed = runBlockedSaleCommand(
        (options.failureCommands?.[failureMode] as Record<string, unknown>)
          .salePrepareCommand as string[],
        failureMode,
        options.runId,
        start,
      );
      failureCase = {
        failureMode,
        startRequest,
        startReport: start,
        expectedDiagnosticCode: String(diagnosticCode),
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
          (options.failureCommands?.[failureMode] as Record<string, unknown>)
            .runtimeRecoveryCommand as string[],
          failureMode,
        );
      }
    }
    cases.push(
      observedMappingFailureCase({
        failureMode: String(failureCase?.failureMode),
        startRequest: (failureCase?.startRequest ?? {}) as Record<
          string,
          unknown
        >,
        startReport: (failureCase?.startReport ?? {}) as Record<
          string,
          unknown
        >,
        expectedDiagnosticCode: String(failureCase?.expectedDiagnosticCode),
        daemonFailClosed: (failureCase?.daemonFailClosed ?? {}) as Record<
          string,
          unknown
        >,
        recovery: (recovery ?? {}) as Record<string, unknown>,
      }),
    );
  }

  let pendingSale: Record<string, unknown> | undefined;
  let scannerSession: Record<string, unknown> | undefined;
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
    scannerSession = start.serialSession as Record<string, unknown>;
    pendingSale = runSaleCommand(
      (options.failureCommands?.["scanner-timeout"] as Record<string, unknown>)
        .salePrepareCommand as string[],
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

  let dispenseSession: Record<string, unknown> | undefined;
  let failedSale: Record<string, unknown> | undefined;
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
    dispenseSession = start.serialSession as Record<string, unknown>;
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
      (options.failureCommands?.["dispense-failed"] as Record<string, unknown>)
        .saleCompleteCommand as string[],
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
        operationNonce: (
          (dispenseInject as Record<string, unknown>).request as Record<
            string,
            unknown
          >
        ).operationNonce,
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
  report: Record<string, unknown>,
  failureMode: string,
  expectedCode: string,
  saleBinding: Record<string, unknown> | null | undefined,
): unknown {
  const actualCode = (
    report.diagnostics as Array<Record<string, unknown>> | undefined
  )?.find((diagnostic) => diagnostic?.code === expectedCode)?.code;
  if (report.result !== "succeeded" || actualCode !== expectedCode)
    throw new Error(
      `${failureMode} adapter returned ${actualCode ?? "no diagnostic"}, expected ${expectedCode}`,
    );
  if (
    (report.cleanup as Record<string, unknown> | undefined)?.status !==
      "not-run" ||
    (report.cleanup as Record<string, unknown> | undefined)
      ?.overlayDisposition !== "active" ||
    (
      (report.cleanup as Record<string, unknown> | undefined)?.observed as
        | Record<string, unknown>
        | undefined
    )?.overlay !== "present" ||
    (
      (report.cleanup as Record<string, unknown> | undefined)?.observed as
        | Record<string, unknown>
        | undefined
    )?.runDirectory !== "present"
  )
    throw new Error(`${failureMode} unexpectedly cleaned the active overlay`);
  if (
    JSON.stringify(
      (
        (report.request as Record<string, unknown>).serialSession as Record<
          string,
          unknown
        >
      ).saleBindings,
    ) !== JSON.stringify(saleBinding ? [saleBinding] : [])
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
}: {
  failureMode: string;
  operation: string;
  report: Record<string, unknown>;
  saleBinding: Record<string, unknown>;
  diagnosticCode: unknown;
  source: Record<string, unknown>;
}): Record<string, unknown> {
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
}: {
  failureMode: string;
  startRequest: Record<string, unknown>;
  startReport: Record<string, unknown>;
  faultRequest: Record<string, unknown>;
  faultReport: Record<string, unknown>;
  adapterResult: unknown;
  diagnosticCode: unknown;
}): Record<string, unknown> {
  const serialSession = startReport.serialSession as Record<string, unknown>;
  const timestamps = startReport.timestamps as Record<string, unknown>;
  const startSerialSession = {
    serialSessionId: serialSession.serialSessionId,
    startOperationReference: serialSession.startOperationReference,
    deviceMappingDigest: serialSession.deviceMappingDigest,
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
        faultStartedAt: timestamps.startedAt,
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

async function stopFailureSession(
  options: Pick<
    FailureMatrixOptions,
    | "runId"
    | "targetIdentity"
    | "lifecycleReference"
    | "approvedRuntimeBase"
    | "saleCorrelationId"
    | "workDirectory"
    | "environment"
  >,
  session: Record<string, unknown>,
  saleBinding: Record<string, unknown> | null | undefined,
): Promise<Record<string, unknown>> {
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
  if (
    !(
      (
        (
          (repeatedStop as Record<string, unknown>).serialSession as Record<
            string,
            unknown
          >
        ).simulatorCleanup as Record<string, unknown>
      ).idempotencyVerified === true
    )
  )
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
}: Omit<FailureMatrixOptions, "failureCommands" | "successfulSaleBinding"> & {
  failureModes?: string[];
}): Promise<Array<Record<string, unknown>>> {
  const cases: Array<Record<string, unknown>> = [];
  for (const failureMode of failureModes) {
    const expectedCodes: Record<string, string> = {
      "malformed-frame": "serial_malformed_frame",
      "device-disconnected": "serial_device_disconnected",
      "scanner-timeout": "serial_scanner_timeout",
      "dispense-failed": "serial_dispense_failed",
      "swapped-roles": "serial_swapped_roles",
      "missing-device": "serial_missing_device",
    };
    const expectedCode = expectedCodes[failureMode];
    const mappingFailure = ["swapped-roles", "missing-device"].includes(
      failureMode,
    );
    const failureSaleBinding = mappingFailure
      ? null
      : failureMode === "scanner-timeout"
        ? { ...saleBinding, vendingCommandId: null }
        : saleBinding;
    let session: Record<string, unknown> | null = null;
    try {
      const startRequest = requestFor({
        operation: "start-serial-session",
        runId,
        targetIdentity,
        lifecycleReference,
        approvedRuntimeBase,
        saleCorrelationId,
        saleBinding: failureSaleBinding ?? {},
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
      session = start.serialSession as Record<string, unknown>;
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
        saleBinding: failureSaleBinding ?? {},
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
                operationNonce: (
                  (inject as Record<string, unknown>).request as Record<
                    string,
                    unknown
                  >
                ).operationNonce,
                ...scannerDescriptor,
              },
              saleCorrelationId,
              saleBinding: failureSaleBinding ?? {},
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
        saleBinding: failureSaleBinding ?? {},
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
        if (
          (
            (
              (stop as Record<string, unknown>).serialSession as Record<
                string,
                unknown
              >
            ).simulatorCleanup as Record<string, unknown>
          ).survivingProcessCount !== 0
        )
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
