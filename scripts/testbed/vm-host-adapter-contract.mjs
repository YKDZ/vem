import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

import { inspectExportedDefaultAudioCapture } from "./default-audio-evidence.mjs";
import { inspectExportedDisplayCapture } from "./display-evidence.mjs";

const CONTRACT_VERSION = "vem-vm-host-adapter-contract/v2";
const REQUEST_SCHEMA_VERSION = "vem-vm-host-adapter-request/v2";
const REPORT_SCHEMA_VERSION = "vem-vm-host-adapter-report/v2";
const DIAGNOSTIC_SCHEMA_VERSION = "vem-vm-host-adapter-diagnostic/v2";
const ASSET_IDENTITY = /^factory-cas:\/\/sha256\/([a-f0-9]{64})$/;
const EVIDENCE_IDENTITY = /^factory-evidence:\/\/sha256\/([a-f0-9]{64})$/;
const TARGET_IDENTITY = /^vm-target:\/\/[a-z0-9][a-z0-9.-]{0,127}$/;
const OPERATION_NONCE = /^op-[a-f0-9]{16,64}$/;
const OPERATION_REFERENCE = /^vm-operation:\/\/op-[a-f0-9]{16,64}$/;
const LIFECYCLE_REFERENCE = /^vm-lifecycle:\/\/[a-z0-9][a-z0-9.-]{2,127}$/;
const SERIAL_SESSION_ID = /^serial-session:\/\/sha256-[a-f0-9]{64}$/;
const SERIAL_SESSION_BINDING_TOKEN =
  /^serial-session-binding:\/\/sha256-[a-f0-9]{64}$/;
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const LOGICAL_IDENTITY =
  /^[a-z][a-z0-9-]{0,31}:\/\/[a-z0-9][a-z0-9._:@-]{0,191}$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AUDIO_ENCODING = new Set([
  "pcm_u8",
  "pcm_s16le",
  "pcm_s24le",
  "pcm_s32le",
]);

export const VM_HOST_ADAPTER_REQUEST_SCHEMA_VERSION = REQUEST_SCHEMA_VERSION;
export const VM_HOST_ADAPTER_REPORT_SCHEMA_VERSION = REPORT_SCHEMA_VERSION;
export const VM_HOST_ADAPTER_CONTRACT_VERSION = CONTRACT_VERSION;

export const VM_HOST_ADAPTER_OPERATIONS = new Set([
  "clean-install",
  "capture-approved-base",
  "restore-approved-base",
  "create-disposable-overlay",
  "capture-display",
  "capture-default-audio",
  "start-serial-session",
  "inject-scanner-code",
  "collect-serial-evidence",
  "stop-serial-session",
  "cleanup",
  "cancel",
]);

export const VM_HOST_ADAPTER_CAPABILITIES = new Set([
  "clean-install",
  "approved-base-capture",
  "approved-base-restore",
  "disposable-overlay",
  "display-capture",
  "serial:lower-controller",
  "serial:scanner",
  "serial-session",
  "serial:scanner-injection",
  "serial:evidence",
  "default-audio-capture",
  "cancellation",
  "cleanup",
]);

const REQUIRED_CAPABILITY_BY_OPERATION = {
  "clean-install": "clean-install",
  "capture-approved-base": "approved-base-capture",
  "restore-approved-base": "approved-base-restore",
  "create-disposable-overlay": "disposable-overlay",
  "capture-display": "display-capture",
  "capture-default-audio": "default-audio-capture",
  "start-serial-session": "serial-session",
  "inject-scanner-code": "serial:scanner-injection",
  "collect-serial-evidence": "serial:evidence",
  "stop-serial-session": "serial-session",
  cleanup: "cleanup",
  cancel: "cancellation",
};

const REQUIRED_ASSET_ROLES_BY_OPERATION = {
  "clean-install": ["factory-iso", "factory-personalization-media"],
  "capture-approved-base": ["factory-iso"],
  "restore-approved-base": ["approved-runtime-base"],
  "create-disposable-overlay": ["approved-runtime-base"],
  "capture-display": ["approved-runtime-base"],
  "capture-default-audio": ["approved-runtime-base"],
  "start-serial-session": ["approved-runtime-base"],
  "inject-scanner-code": ["approved-runtime-base"],
  "collect-serial-evidence": ["approved-runtime-base"],
  "stop-serial-session": ["approved-runtime-base"],
  cleanup: ["approved-runtime-base", "factory-iso"],
  cancel: ["approved-runtime-base", "factory-iso"],
};

const REQUIRED_CAPABILITIES_BY_SERIAL_OPERATION = {
  "start-serial-session": [
    "serial-session",
    "serial:lower-controller",
    "serial:scanner",
  ],
  "inject-scanner-code": [
    "serial-session",
    "serial:lower-controller",
    "serial:scanner",
    "serial:scanner-injection",
  ],
  "collect-serial-evidence": [
    "serial-session",
    "serial:lower-controller",
    "serial:scanner",
    "serial:evidence",
  ],
  "stop-serial-session": [
    "serial-session",
    "serial:lower-controller",
    "serial:scanner",
    "cleanup",
  ],
};

const SANITIZED_DIAGNOSTIC_CODES = new Set([
  "adapter_completed",
  "adapter_failed",
  "adapter_timed_out",
  "adapter_cancelled",
  "adapter_rejected",
  "adapter_unavailable",
  "guest_unreachable",
  "evidence_invalid",
  "cleanup_failed",
]);

const TERMINAL_RESULTS = new Set([
  "succeeded",
  "failed",
  "timed_out",
  "cancelled",
]);

const SERIAL_SESSION_OPERATIONS = new Set([
  "start-serial-session",
  "inject-scanner-code",
  "collect-serial-evidence",
  "stop-serial-session",
]);
const SERIAL_DEVICE_ROLES = ["lower-controller", "scanner"];
const SALE_EVIDENCE_ROLES = new Set([...SERIAL_DEVICE_ROLES, "payment"]);
const SCANNER_CODE_SUFFIX = /^[a-f0-9]{8}$/;
const SALE_CORRELATION_ID =
  /^sale-correlation:\/\/[a-z0-9][a-z0-9._:@-]{2,191}$/;
const BUSINESS_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{2,191}$/;

export class VmHostAdapterContractError extends Error {
  constructor(issues) {
    super(
      `invalid VM Host Adapter contract: ${issues.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`,
    );
    this.name = "VmHostAdapterContractError";
    this.issues = issues;
  }
}

export class VmHostAdapterExecutionError extends Error {
  constructor(message, diagnostic) {
    super(message);
    this.name = "VmHostAdapterExecutionError";
    this.diagnostic = diagnostic;
  }
}

function issue(issues, path, message) {
  issues.push({ path, message });
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value, keys, path, issues) {
  if (!isRecord(value)) {
    issue(issues, path, "must be an object");
    return false;
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) issue(issues, `${path}.${key}`, "is not permitted");
  }
  for (const key of keys) {
    if (!(key in value)) issue(issues, `${path}.${key}`, "is required");
  }
  return true;
}

function assertNoHostReference(value, path, issues) {
  if (typeof value !== "string") return;
  if (
    /(?:^|[^a-z0-9-])\/(?:mnt|home|tmp|var|opt|users)(?:\/|$)|(?:^|[^a-z0-9-])[a-z]:[\\/]|\\\\|retired-host:\/\//i.test(
      value,
    )
  ) {
    issue(
      issues,
      path,
      "must not contain a host filesystem path or platform URI",
    );
  }
}

function assertLogicalIdentity(value, path, issues) {
  if (
    typeof value !== "string" ||
    (!LOGICAL_IDENTITY.test(value) && !ASSET_IDENTITY.test(value))
  ) {
    issue(issues, path, "must be a logical identity");
    return;
  }
  assertNoHostReference(value, path, issues);
}

function assertAsset(asset, index, issues, pathPrefix = "assets") {
  const path = `${pathPrefix}[${index}]`;
  if (!assertExactKeys(asset, ["role", "identity", "digest"], path, issues))
    return;
  if (
    typeof asset.role !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(asset.role)
  ) {
    issue(issues, `${path}.role`, "must be a logical asset role");
  }
  const identity =
    typeof asset.identity === "string"
      ? asset.identity.match(ASSET_IDENTITY)
      : null;
  if (!identity)
    issue(issues, `${path}.identity`, "must be a factory-cas SHA-256 identity");
  if (
    typeof asset.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
  ) {
    issue(issues, `${path}.digest`, "must be a lowercase SHA-256 digest");
  } else if (identity && identity[1] !== asset.digest.slice(7)) {
    issue(
      issues,
      path,
      "identity and digest must name the same immutable asset",
    );
  }
  assertNoHostReference(asset.identity, `${path}.identity`, issues);
}

function assertUniqueRoles(entries, path, issues) {
  const roles = new Set();
  entries.forEach((entry, index) => {
    if (roles.has(entry?.role))
      issue(issues, `${path}[${index}].role`, "must not be duplicated");
    roles.add(entry?.role);
  });
}

function sameValues(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameAssets(left, right) {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every(
      (asset, index) =>
        asset?.role === right[index]?.role &&
        asset?.identity === right[index]?.identity &&
        asset?.digest === right[index]?.digest,
    )
  );
}

function isV2Request(request) {
  return request?.schemaVersion === REQUEST_SCHEMA_VERSION;
}

function isSerialSessionOperation(operation) {
  return SERIAL_SESSION_OPERATIONS.has(operation);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function createScannerCodeDescriptor(scannerCode) {
  const bytes = Buffer.isBuffer(scannerCode)
    ? Buffer.from(scannerCode)
    : Buffer.from(String(scannerCode ?? ""), "utf8");
  if (bytes.length < 1 || bytes.length > 256)
    throw new Error("scanner input must contain 1 through 256 bytes");
  const digest = sha256(bytes);
  return {
    scannerCodeDigest: `sha256:${digest}`,
    scannerCodeByteLength: bytes.length,
    scannerCodeSuffix: digest.slice(-8),
  };
}

export function deriveSerialSessionBinding({
  runId,
  lifecycleReference,
  targetIdentity,
  startOperationReference,
}) {
  const input = [
    "vem-vm-host-adapter-serial-session/v2",
    runId,
    lifecycleReference,
    targetIdentity,
    startOperationReference,
  ].join("\n");
  return {
    serialSessionId: `serial-session://sha256-${sha256(`id\n${input}`)}`,
    sessionBindingToken: `serial-session-binding://sha256-${sha256(`binding\n${input}`)}`,
  };
}

export function deriveSerialDeviceMappingDigest(deviceMappings) {
  const canonical = deviceMappings.map((mapping) => ({
    role: mapping?.role,
    guestDeviceIdentity: mapping?.guestDeviceIdentity,
    simulatorProcessIdentity: mapping?.simulatorProcessIdentity,
    simulatorSocketIdentity: mapping?.simulatorSocketIdentity,
  }));
  return `sha256:${sha256(JSON.stringify(canonical))}`;
}

function expectedSerialBinding(request, session) {
  return deriveSerialSessionBinding({
    runId: request.runId,
    lifecycleReference: request.lifecycleReference,
    targetIdentity: request.target.identity,
    startOperationReference:
      request.operation === "start-serial-session"
        ? request.operationReference
        : session.startOperationReference,
  });
}

function assertScannerInjection(injection, path, request, issues) {
  if (
    !assertExactKeys(
      injection,
      [
        "operationNonce",
        "scannerCodeDigest",
        "scannerCodeByteLength",
        "scannerCodeSuffix",
      ],
      path,
      issues,
    )
  )
    return;
  if (
    typeof injection.operationNonce !== "string" ||
    !OPERATION_NONCE.test(injection.operationNonce)
  )
    issue(issues, `${path}.operationNonce`, "must be an operation nonce");
  if (!SHA256_DIGEST.test(injection.scannerCodeDigest ?? ""))
    issue(issues, `${path}.scannerCodeDigest`, "must be a SHA-256 digest");
  if (
    !Number.isInteger(injection.scannerCodeByteLength) ||
    injection.scannerCodeByteLength < 1 ||
    injection.scannerCodeByteLength > 256
  )
    issue(
      issues,
      `${path}.scannerCodeByteLength`,
      "must be a bounded scanner input byte length",
    );
  if (!SCANNER_CODE_SUFFIX.test(injection.scannerCodeSuffix ?? ""))
    issue(
      issues,
      `${path}.scannerCodeSuffix`,
      "must be an eight-character redacted digest suffix",
    );
  if (
    request.operation === "inject-scanner-code" &&
    injection.operationNonce !== request.operationNonce
  )
    issue(
      issues,
      `${path}.operationNonce`,
      "must bind the scanner injection to this operation nonce",
    );
}

function assertSerialSessionRequest(session, request, issues) {
  if (!isV2Request(request)) return;
  const carriesSession =
    isSerialSessionOperation(request.operation) ||
    ["cleanup", "cancel"].includes(request.operation);
  if (!carriesSession) {
    if (session !== null)
      issue(
        issues,
        "request.serialSession",
        "must be null outside serial lifecycle operations",
      );
    return;
  }
  if (session === null) {
    if (isSerialSessionOperation(request.operation))
      issue(
        issues,
        "request.serialSession",
        "must bind serial-session operations",
      );
    return;
  }
  if (
    !assertExactKeys(
      session,
      [
        "serialSessionId",
        "sessionBindingToken",
        "startOperationReference",
        "deviceMappingDigest",
        "deviceRoles",
        "scannerInjection",
        "saleCorrelationIds",
        "saleBindings",
        "idempotencyCheck",
      ],
      "request.serialSession",
      issues,
    )
  )
    return;
  if (!sameValues(session.deviceRoles, SERIAL_DEVICE_ROLES))
    issue(
      issues,
      "request.serialSession.deviceRoles",
      "must require canonical serial roles",
    );
  const isStart = request.operation === "start-serial-session";
  if (isStart) {
    for (const key of [
      "serialSessionId",
      "sessionBindingToken",
      "startOperationReference",
      "deviceMappingDigest",
    ])
      if (session[key] !== null)
        issue(
          issues,
          `request.serialSession.${key}`,
          "must be null when starting a serial session",
        );
  } else {
    const isRecoveryCleanup =
      ["cleanup", "cancel"].includes(request.operation) &&
      session.deviceMappingDigest === null;
    const expected = expectedSerialBinding(request, session);
    if (
      typeof session.startOperationReference !== "string" ||
      !OPERATION_REFERENCE.test(session.startOperationReference)
    )
      issue(
        issues,
        "request.serialSession.startOperationReference",
        "must identify the start operation",
      );
    if (session.serialSessionId !== expected.serialSessionId)
      issue(
        issues,
        "request.serialSession.serialSessionId",
        "must be derived from this run lifecycle target and start operation",
      );
    if (session.sessionBindingToken !== expected.sessionBindingToken)
      issue(
        issues,
        "request.serialSession.sessionBindingToken",
        "must bind the derived serial session",
      );
    if (
      !isRecoveryCleanup &&
      !SHA256_DIGEST.test(session.deviceMappingDigest ?? "")
    )
      issue(
        issues,
        "request.serialSession.deviceMappingDigest",
        "must bind serial device mappings",
      );
  }
  const usesInjection = [
    "inject-scanner-code",
    "collect-serial-evidence",
  ].includes(request.operation);
  if (usesInjection) {
    if (session.scannerInjection === null)
      issue(
        issues,
        "request.serialSession.scannerInjection",
        "must bind protected scanner input",
      );
    else
      assertScannerInjection(
        session.scannerInjection,
        "request.serialSession.scannerInjection",
        request,
        issues,
      );
  } else if (session.scannerInjection !== null)
    issue(
      issues,
      "request.serialSession.scannerInjection",
      "must be null for this operation",
    );
  if (!Array.isArray(session.saleCorrelationIds))
    issue(
      issues,
      "request.serialSession.saleCorrelationIds",
      "must be an array",
    );
  else {
    const seen = new Set();
    session.saleCorrelationIds.forEach((value, index) => {
      if (typeof value !== "string" || !SALE_CORRELATION_ID.test(value))
        issue(
          issues,
          `request.serialSession.saleCorrelationIds[${index}]`,
          "must be a logical sale correlation identity",
        );
      if (seen.has(value))
        issue(
          issues,
          `request.serialSession.saleCorrelationIds[${index}]`,
          "must not be duplicated",
        );
      seen.add(value);
    });
    if (session.saleCorrelationIds.length === 0)
      issue(
        issues,
        "request.serialSession.saleCorrelationIds",
        "must bind at least one logical sale correlation identity",
      );
  }
  if (!Array.isArray(session.saleBindings))
    issue(
      issues,
      "request.serialSession.saleBindings",
      "must bind concrete observed business identifiers",
    );
  else {
    if (session.saleBindings.length !== session.saleCorrelationIds?.length)
      issue(
        issues,
        "request.serialSession.saleBindings",
        "must bind every requested sale correlation identity",
      );
    session.saleBindings.forEach((binding, index) => {
      const path = `request.serialSession.saleBindings[${index}]`;
      if (
        !assertExactKeys(
          binding,
          ["saleCorrelationId", "orderId", "paymentId", "vendingCommandId"],
          path,
          issues,
        )
      )
        return;
      if (binding.saleCorrelationId !== session.saleCorrelationIds?.[index])
        issue(
          issues,
          `${path}.saleCorrelationId`,
          "must match its requested sale correlation identity",
        );
      for (const key of ["orderId", "paymentId", "vendingCommandId"])
        if (
          typeof binding[key] !== "string" ||
          !BUSINESS_IDENTIFIER.test(binding[key])
        )
          issue(
            issues,
            `${path}.${key}`,
            "must be a concrete observed business identifier",
          );
    });
  }
  if (typeof session.idempotencyCheck !== "boolean")
    issue(
      issues,
      "request.serialSession.idempotencyCheck",
      "must be a boolean",
    );
  else if (
    request.operation !== "stop-serial-session" &&
    session.idempotencyCheck
  )
    issue(
      issues,
      "request.serialSession.idempotencyCheck",
      "must be false outside stop-serial-session",
    );
}

function assertSerialSessionMapping(mapping, index, guestMappings, issues) {
  const path = `report.serialSession.deviceMappings[${index}]`;
  if (
    !assertExactKeys(
      mapping,
      [
        "role",
        "guestDeviceIdentity",
        "simulatorProcessIdentity",
        "simulatorSocketIdentity",
        "connectionState",
      ],
      path,
      issues,
    )
  )
    return;
  if (!SERIAL_DEVICE_ROLES.includes(mapping.role))
    issue(issues, `${path}.role`, "must be a supported serial role");
  for (const key of [
    "guestDeviceIdentity",
    "simulatorProcessIdentity",
    "simulatorSocketIdentity",
  ])
    assertLogicalIdentity(mapping[key], `${path}.${key}`, issues);
  if (!new Set(["connected", "disconnected"]).has(mapping.connectionState))
    issue(
      issues,
      `${path}.connectionState`,
      "must be connected or disconnected",
    );
  const guestMapping = guestMappings.find(
    (entry) => entry?.role === mapping.role,
  );
  if (
    !guestMapping ||
    guestMapping.guestDeviceIdentity !== mapping.guestDeviceIdentity
  )
    issue(
      issues,
      `${path}.guestDeviceIdentity`,
      "must bind the reported guest device mapping",
    );
}

function assertSemanticRecord(record, index, request, issues) {
  const path = `report.serialEvidence.records[${index}]`;
  if (
    !assertExactKeys(
      record,
      [
        "role",
        "event",
        "operationNonce",
        "sessionBindingToken",
        "deviceMappingDigest",
        "scannerCodeDigest",
        "scannerCodeByteLength",
        "scannerCodeSuffix",
        "saleCorrelationId",
        "saleBinding",
        "capturedFrame",
      ],
      path,
      issues,
    )
  )
    return;
  if (!SALE_EVIDENCE_ROLES.has(record.role))
    issue(issues, `${path}.role`, "must be a supported serial evidence role");
  if (
    assertExactKeys(
      record.capturedFrame,
      ["source", "sequence", "digest", "byteLength"],
      `${path}.capturedFrame`,
      issues,
    )
  ) {
    if (record.capturedFrame.source !== "guest-serial-session")
      issue(
        issues,
        `${path}.capturedFrame.source`,
        "must be captured from the guest serial session, not a synthetic sidecar",
      );
    if (
      !Number.isInteger(record.capturedFrame.sequence) ||
      record.capturedFrame.sequence < 1
    )
      issue(
        issues,
        `${path}.capturedFrame.sequence`,
        "must be a positive frame sequence",
      );
    if (!SHA256_DIGEST.test(record.capturedFrame.digest ?? ""))
      issue(
        issues,
        `${path}.capturedFrame.digest`,
        "must be a SHA-256 frame digest",
      );
    if (
      !Number.isInteger(record.capturedFrame.byteLength) ||
      record.capturedFrame.byteLength < 1
    )
      issue(
        issues,
        `${path}.capturedFrame.byteLength`,
        "must be a positive frame byte length",
      );
  }
  const expectedSaleBinding = request.serialSession.saleBindings?.find(
    (binding) => binding.saleCorrelationId === record.saleCorrelationId,
  );
  if (record.saleCorrelationId === null) {
    if (record.saleBinding !== null)
      issue(issues, `${path}.saleBinding`, "must be null when no sale applies");
  } else if (
    JSON.stringify(record.saleBinding) !== JSON.stringify(expectedSaleBinding)
  )
    issue(
      issues,
      `${path}.saleBinding`,
      "must bind the observed order, payment, and vending command for this sale",
    );
  if (record.sessionBindingToken !== request.serialSession.sessionBindingToken)
    issue(
      issues,
      `${path}.sessionBindingToken`,
      "must bind the serial session token",
    );
  if (record.deviceMappingDigest !== request.serialSession.deviceMappingDigest)
    issue(
      issues,
      `${path}.deviceMappingDigest`,
      "must bind the serial device mappings",
    );
  const lowerEvents = new Set([
    "handshake",
    "health",
    "dispense-request",
    "dispense-ack",
    "dispense-result",
  ]);
  if (record.role === "lower-controller") {
    if (!lowerEvents.has(record.event))
      issue(
        issues,
        `${path}.event`,
        "must be a required lower-controller semantic event",
      );
    if (record.operationNonce !== request.operationNonce)
      issue(
        issues,
        `${path}.operationNonce`,
        "must bind this evidence operation nonce",
      );
    for (const key of [
      "scannerCodeDigest",
      "scannerCodeByteLength",
      "scannerCodeSuffix",
    ])
      if (record[key] !== null)
        issue(
          issues,
          `${path}.${key}`,
          "must be null for lower-controller evidence",
        );
    const isDispense = record.event.startsWith("dispense-");
    if (isDispense) {
      if (
        !request.serialSession.saleCorrelationIds.includes(
          record.saleCorrelationId,
        )
      )
        issue(
          issues,
          `${path}.saleCorrelationId`,
          "must bind a requested sale correlation identity",
        );
    } else if (record.saleCorrelationId !== null)
      issue(
        issues,
        `${path}.saleCorrelationId`,
        "must be null when no sale correlation applies",
      );
  } else if (record.role === "scanner") {
    if (record.event !== "scanner-injection")
      issue(issues, `${path}.event`, "must be scanner-injection");
    const injection = request.serialSession.scannerInjection;
    if (record.operationNonce !== injection?.operationNonce)
      issue(
        issues,
        `${path}.operationNonce`,
        "must bind the scanner injection operation nonce",
      );
    for (const key of [
      "scannerCodeDigest",
      "scannerCodeByteLength",
      "scannerCodeSuffix",
    ])
      if (record[key] !== injection?.[key])
        issue(
          issues,
          `${path}.${key}`,
          "must bind the protected scanner input descriptor",
        );
    if (
      !request.serialSession.saleCorrelationIds.includes(
        record.saleCorrelationId,
      )
    )
      issue(
        issues,
        `${path}.saleCorrelationId`,
        "must bind the scanner injection to a requested sale correlation identity",
      );
  } else {
    if (
      !new Set(["payment-request", "payment-ack", "payment-result"]).has(
        record.event,
      )
    )
      issue(
        issues,
        `${path}.event`,
        "must be a required payment semantic event",
      );
    if (record.operationNonce !== request.operationNonce)
      issue(
        issues,
        `${path}.operationNonce`,
        "must bind this evidence operation nonce",
      );
    for (const key of [
      "scannerCodeDigest",
      "scannerCodeByteLength",
      "scannerCodeSuffix",
    ])
      if (record[key] !== null)
        issue(issues, `${path}.${key}`, "must be null for payment evidence");
    if (
      !request.serialSession.saleCorrelationIds.includes(
        record.saleCorrelationId,
      )
    )
      issue(
        issues,
        `${path}.saleCorrelationId`,
        "must bind a requested sale correlation identity",
      );
  }
}

function assertSerialEvidence(report, request, issues) {
  if (!isV2Request(request)) return;
  const evidence = report.serialEvidence;
  if (request.operation !== "collect-serial-evidence") {
    if (evidence !== null)
      issue(
        issues,
        "report.serialEvidence",
        "must be null outside collect-serial-evidence",
      );
    return;
  }
  if (report.result !== "succeeded") {
    if (evidence !== null)
      issue(
        issues,
        "report.serialEvidence",
        "must be null when collection fails",
      );
    return;
  }
  if (
    !assertExactKeys(
      evidence,
      [
        "serialSessionId",
        "sessionBindingToken",
        "deviceMappingDigest",
        "records",
      ],
      "report.serialEvidence",
      issues,
    )
  )
    return;
  for (const key of [
    "serialSessionId",
    "sessionBindingToken",
    "deviceMappingDigest",
  ])
    if (evidence[key] !== request.serialSession[key])
      issue(
        issues,
        `report.serialEvidence.${key}`,
        "must bind the requested serial session",
      );
  if (!Array.isArray(evidence.records)) {
    issue(issues, "report.serialEvidence.records", "must be an array");
    return;
  }
  evidence.records.forEach((record, index) =>
    assertSemanticRecord(record, index, request, issues),
  );
  const lowerEvents = new Set(
    evidence.records
      .filter((record) => record?.role === "lower-controller")
      .map((record) => record?.event),
  );
  for (const event of [
    "handshake",
    "health",
    "dispense-request",
    "dispense-ack",
    "dispense-result",
  ])
    if (!lowerEvents.has(event))
      issue(
        issues,
        "report.serialEvidence.records",
        `must include lower-controller ${event}`,
      );
  if (
    !evidence.records.some(
      (record) =>
        record?.role === "scanner" && record?.event === "scanner-injection",
    )
  )
    issue(
      issues,
      "report.serialEvidence.records",
      "must include scanner injection evidence",
    );
  for (const saleCorrelationId of request.serialSession.saleCorrelationIds) {
    const eventsForSale = new Set(
      evidence.records
        .filter((record) => record?.saleCorrelationId === saleCorrelationId)
        .map((record) => `${record.role}:${record.event}`),
    );
    for (const event of [
      "scanner:scanner-injection",
      "payment:payment-request",
      "payment:payment-ack",
      "payment:payment-result",
      "lower-controller:dispense-request",
      "lower-controller:dispense-ack",
      "lower-controller:dispense-result",
    ])
      if (!eventsForSale.has(event))
        issue(
          issues,
          "report.serialEvidence.records",
          `must bind ${event} to every requested sale correlation identity`,
        );
  }
}

function assertSerialSessionReport(report, request, issues) {
  if (!isV2Request(request)) return;
  const expectsSession =
    isSerialSessionOperation(request.operation) ||
    request.serialSession !== null;
  if (!expectsSession) {
    if (report.serialSession !== null)
      issue(
        issues,
        "report.serialSession",
        "must be null without a serial session request",
      );
    return;
  }
  const session = report.serialSession;
  if (report.result !== "succeeded" && session === null) return;
  if (
    !assertExactKeys(
      session,
      [
        "serialSessionId",
        "sessionBindingToken",
        "startOperationReference",
        "deviceMappingDigest",
        "state",
        "deviceMappings",
        "scannerAcknowledgement",
        "simulatorCleanup",
      ],
      "report.serialSession",
      issues,
    )
  )
    return;
  const expected = expectedSerialBinding(
    request,
    request.serialSession ?? session,
  );
  for (const key of ["serialSessionId", "sessionBindingToken"])
    if (session[key] !== expected[key])
      issue(
        issues,
        `report.serialSession.${key}`,
        "must be derived from the requested session binding",
      );
  const expectedStartReference =
    request.operation === "start-serial-session"
      ? request.operationReference
      : request.serialSession?.startOperationReference;
  if (session.startOperationReference !== expectedStartReference)
    issue(
      issues,
      "report.serialSession.startOperationReference",
      "must bind the initiating operation",
    );
  const expectedState =
    request.operation === "stop-serial-session"
      ? "stopped"
      : ["cleanup", "cancel"].includes(request.operation)
        ? "cleaned"
        : "active";
  if (session.state !== expectedState)
    issue(
      issues,
      "report.serialSession.state",
      `must be ${expectedState} for this operation`,
    );
  if (!Array.isArray(session.deviceMappings))
    issue(issues, "report.serialSession.deviceMappings", "must be an array");
  else {
    session.deviceMappings.forEach((mapping, index) =>
      assertSerialSessionMapping(
        mapping,
        index,
        report.guest?.deviceMappings ?? [],
        issues,
      ),
    );
    if (
      !sameValues(
        session.deviceMappings.map((mapping) => mapping?.role),
        SERIAL_DEVICE_ROLES,
      )
    )
      issue(
        issues,
        "report.serialSession.deviceMappings",
        "must provide canonical serial mappings",
      );
    const expectedConnection =
      expectedState === "active" ? "connected" : "disconnected";
    for (const mapping of session.deviceMappings)
      if (mapping?.connectionState !== expectedConnection)
        issue(
          issues,
          "report.serialSession.deviceMappings",
          `must be ${expectedConnection} for this state`,
        );
    const derivedDigest = deriveSerialDeviceMappingDigest(
      session.deviceMappings,
    );
    if (session.deviceMappingDigest !== derivedDigest)
      issue(
        issues,
        "report.serialSession.deviceMappingDigest",
        "must bind the reported simulator mappings",
      );
    if (
      request.operation !== "start-serial-session" &&
      request.serialSession?.deviceMappingDigest !== null &&
      session.deviceMappingDigest !== request.serialSession?.deviceMappingDigest
    )
      issue(
        issues,
        "report.serialSession.deviceMappingDigest",
        "must match the requested session mapping digest",
      );
  }
  if (request.operation === "inject-scanner-code") {
    const acknowledgement = session.scannerAcknowledgement;
    if (
      !assertExactKeys(
        acknowledgement,
        [
          "scannerCodeDigest",
          "scannerCodeByteLength",
          "scannerCodeSuffix",
          "accepted",
        ],
        "report.serialSession.scannerAcknowledgement",
        issues,
      )
    ) {
      // Exact-key diagnostics are sufficient when this object is malformed.
    } else {
      for (const key of [
        "scannerCodeDigest",
        "scannerCodeByteLength",
        "scannerCodeSuffix",
      ])
        if (
          acknowledgement[key] !== request.serialSession.scannerInjection?.[key]
        )
          issue(
            issues,
            `report.serialSession.scannerAcknowledgement.${key}`,
            "must bind protected scanner input",
          );
      if (acknowledgement.accepted !== true)
        issue(
          issues,
          "report.serialSession.scannerAcknowledgement.accepted",
          "must be true",
        );
    }
  } else if (session.scannerAcknowledgement !== null)
    issue(
      issues,
      "report.serialSession.scannerAcknowledgement",
      "must be null outside scanner injection",
    );
  const needsCleanup = ["stop-serial-session", "cleanup", "cancel"].includes(
    request.operation,
  );
  if (needsCleanup) {
    const cleanup = session.simulatorCleanup;
    if (
      !assertExactKeys(
        cleanup,
        [
          "cleanupAttemptCount",
          "idempotencyVerified",
          "survivingProcessCount",
          "survivingSocketCount",
        ],
        "report.serialSession.simulatorCleanup",
        issues,
      )
    ) {
      // Exact-key diagnostics are sufficient when this object is malformed.
    } else {
      if (
        !Number.isInteger(cleanup.cleanupAttemptCount) ||
        cleanup.cleanupAttemptCount < 1
      )
        issue(
          issues,
          "report.serialSession.simulatorCleanup.cleanupAttemptCount",
          "must count cleanup attempts",
        );
      if (
        cleanup.survivingProcessCount !== 0 ||
        cleanup.survivingSocketCount !== 0
      )
        issue(
          issues,
          "report.serialSession.simulatorCleanup",
          "must prove no simulator resources survive",
        );
      const requiresIdempotencyProof =
        request.operation === "stop-serial-session" &&
        request.serialSession.idempotencyCheck;
      if (
        requiresIdempotencyProof &&
        (cleanup.cleanupAttemptCount < 2 ||
          cleanup.idempotencyVerified !== true)
      )
        issue(
          issues,
          "report.serialSession.simulatorCleanup",
          "must prove a repeated stop was idempotent",
        );
      if (!requiresIdempotencyProof && cleanup.idempotencyVerified !== false)
        issue(
          issues,
          "report.serialSession.simulatorCleanup.idempotencyVerified",
          "must be false until a repeated stop is checked",
        );
    }
  } else if (session.simulatorCleanup !== null)
    issue(
      issues,
      "report.serialSession.simulatorCleanup",
      "must be null outside serial cleanup",
    );
}

function assertTimestamp(value, path, issues) {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    issue(issues, path, "must be a canonical ISO-8601 UTC timestamp");
  }
}

function assertActiveKioskSession(value, path, issues) {
  if (!assertExactKeys(value, ["sessionUser", "sessionId"], path, issues))
    return;
  if (value.sessionUser !== "VEMKiosk")
    issue(issues, `${path}.sessionUser`, "must bind the VEMKiosk session");
  if (!Number.isInteger(value.sessionId) || value.sessionId < 1)
    issue(
      issues,
      `${path}.sessionId`,
      "must be an active positive Windows session id",
    );
}

function assertTauriRoute(value, path, issues) {
  try {
    const url = new URL(value);
    if (
      url.protocol === "http:" &&
      url.host === "tauri.localhost" &&
      url.hash.startsWith("#/")
    )
      return;
  } catch {}
  issue(issues, path, "must be a strict tauri.localhost hash route");
}

function assertDisplayCaptureRequest(value, path, issues) {
  if (
    !assertExactKeys(value, ["activeKioskSession", "tauriRoute"], path, issues)
  )
    return;
  assertActiveKioskSession(
    value.activeKioskSession,
    `${path}.activeKioskSession`,
    issues,
  );
  assertTauriRoute(value.tauriRoute, `${path}.tauriRoute`, issues);
  if (value.tauriRoute !== "http://tauri.localhost/#/")
    issue(
      issues,
      `${path}.tauriRoute`,
      "must request the exact customer sale route",
    );
}

function assertAudioCaptureRequest(value, path, issues) {
  if (
    !assertExactKeys(
      value,
      ["schemaVersion", "activeKioskSession", "nativeCue", "threshold"],
      path,
      issues,
    )
  )
    return;
  if (value.schemaVersion !== "vm-default-audio-capture-request/v1")
    issue(
      issues,
      `${path}.schemaVersion`,
      "must be vm-default-audio-capture-request/v1",
    );
  assertActiveKioskSession(
    value.activeKioskSession,
    `${path}.activeKioskSession`,
    issues,
  );
  if (
    assertExactKeys(
      value.nativeCue,
      ["source", "command", "challenge"],
      `${path}.nativeCue`,
      issues,
    )
  ) {
    if (value.nativeCue.source !== "tauri_native_audio")
      issue(
        issues,
        `${path}.nativeCue.source`,
        "must require the Tauri native audio path",
      );
    if (value.nativeCue.command !== "play_machine_audio")
      issue(
        issues,
        `${path}.nativeCue.command`,
        "must use the existing native audio command",
      );
    if (
      typeof value.nativeCue.challenge !== "string" ||
      !/^[a-f0-9]{32,128}$/.test(value.nativeCue.challenge)
    )
      issue(
        issues,
        `${path}.nativeCue.challenge`,
        "must be a high-entropy cue challenge",
      );
  }
  if (
    assertExactKeys(
      value.threshold,
      [
        "minimumPeakAbsoluteSample",
        "minimumNonSilentFrames",
        "minimumDurationMs",
        "minimumDistinctNonSilentSampleMagnitudes",
      ],
      `${path}.threshold`,
      issues,
    )
  ) {
    for (const key of [
      "minimumPeakAbsoluteSample",
      "minimumNonSilentFrames",
      "minimumDurationMs",
      "minimumDistinctNonSilentSampleMagnitudes",
    ]) {
      if (!Number.isInteger(value.threshold[key]) || value.threshold[key] <= 0)
        issue(issues, `${path}.threshold.${key}`, "must be a positive integer");
    }
  }
}

function assertAudioCaptureResult(value, request, report, issues) {
  const path = "report.defaultAudioCapture";
  if (request.operation !== "capture-default-audio") {
    if (value !== null)
      issue(issues, path, "must be null outside capture-default-audio");
    return;
  }
  if (report.result !== "succeeded") {
    if (value !== null)
      issue(
        issues,
        path,
        "must be null when default-audio capture did not succeed",
      );
    return;
  }
  if (
    !assertExactKeys(
      value,
      [
        "schemaVersion",
        "runId",
        "lifecycleReference",
        "captureOperationReference",
        "activeKioskSession",
        "endpoint",
        "nativeCue",
        "capture",
      ],
      path,
      issues,
    )
  )
    return;
  if (value.schemaVersion !== "vm-default-audio-capture-result/v1")
    issue(
      issues,
      `${path}.schemaVersion`,
      "must be vm-default-audio-capture-result/v1",
    );
  if (value.runId !== request.runId)
    issue(issues, `${path}.runId`, "must bind the adapter run identity");
  if (value.lifecycleReference !== request.lifecycleReference)
    issue(
      issues,
      `${path}.lifecycleReference`,
      "must bind the active overlay lifecycle",
    );
  if (value.captureOperationReference !== request.operationReference)
    issue(
      issues,
      `${path}.captureOperationReference`,
      "must bind the capture operation",
    );
  assertActiveKioskSession(
    value.activeKioskSession,
    `${path}.activeKioskSession`,
    issues,
  );
  if (
    JSON.stringify(value.activeKioskSession) !==
    JSON.stringify(request.audioCapture?.activeKioskSession)
  )
    issue(
      issues,
      `${path}.activeKioskSession`,
      "must match the requested active kiosk session",
    );
  if (
    assertExactKeys(
      value.endpoint,
      ["status", "identity"],
      `${path}.endpoint`,
      issues,
    )
  ) {
    if (value.endpoint.status !== "selected")
      issue(
        issues,
        `${path}.endpoint.status`,
        "must attest the selected Windows default render endpoint",
      );
    if (value.endpoint.identity !== report.guest?.defaultAudioIdentity)
      issue(
        issues,
        `${path}.endpoint.identity`,
        "must bind the observed default audio endpoint",
      );
  }
  if (
    assertExactKeys(
      value.nativeCue,
      ["status", "source", "command", "challenge", "emittedAt"],
      `${path}.nativeCue`,
      issues,
    )
  ) {
    if (value.nativeCue.status !== "emitted")
      issue(
        issues,
        `${path}.nativeCue.status`,
        "must attest a native cue emitted from the kiosk session",
      );
    if (
      value.nativeCue.source !== request.audioCapture?.nativeCue?.source ||
      value.nativeCue.command !== request.audioCapture?.nativeCue?.command ||
      value.nativeCue.challenge !== request.audioCapture?.nativeCue?.challenge
    )
      issue(
        issues,
        `${path}.nativeCue`,
        "must match the requested Tauri native audio cue",
      );
    assertTimestamp(
      value.nativeCue.emittedAt,
      `${path}.nativeCue.emittedAt`,
      issues,
    );
  }
  if (
    !assertExactKeys(
      value.capture,
      [
        "artifact",
        "format",
        "encoding",
        "sampleRateHz",
        "channels",
        "frameCount",
        "durationMs",
        "threshold",
        "nonSilentFrameCount",
        "peakAbsoluteSample",
        "distinctNonSilentSampleMagnitudes",
        "startedAt",
        "completedAt",
      ],
      `${path}.capture`,
      issues,
    )
  )
    return;
  if (value.capture.artifact !== report.evidence?.[0]?.identity)
    issue(
      issues,
      `${path}.capture.artifact`,
      "must bind the exported default-audio-capture evidence artifact",
    );
  if (value.capture.format !== "wav_pcm")
    issue(issues, `${path}.capture.format`, "must be wav_pcm");
  if (!AUDIO_ENCODING.has(value.capture.encoding))
    issue(
      issues,
      `${path}.capture.encoding`,
      "must be a supported PCM encoding",
    );
  for (const key of [
    "sampleRateHz",
    "channels",
    "frameCount",
    "nonSilentFrameCount",
    "peakAbsoluteSample",
    "distinctNonSilentSampleMagnitudes",
  ]) {
    const minimum = ["nonSilentFrameCount", "peakAbsoluteSample"].includes(key)
      ? 0
      : 1;
    if (!Number.isInteger(value.capture[key]) || value.capture[key] < minimum)
      issue(
        issues,
        `${path}.capture.${key}`,
        "must be a valid PCM measurement",
      );
  }
  if (
    !Number.isFinite(value.capture.durationMs) ||
    value.capture.durationMs <= 0
  )
    issue(
      issues,
      `${path}.capture.durationMs`,
      "must be a positive finite PCM duration",
    );
  if (
    JSON.stringify(value.capture.threshold) !==
    JSON.stringify(request.audioCapture?.threshold)
  )
    issue(
      issues,
      `${path}.capture.threshold`,
      "must use the requested non-silence threshold",
    );
  if (
    value.capture.nonSilentFrameCount <
      value.capture.threshold?.minimumNonSilentFrames ||
    value.capture.peakAbsoluteSample <
      value.capture.threshold?.minimumPeakAbsoluteSample ||
    value.capture.durationMs < value.capture.threshold?.minimumDurationMs ||
    value.capture.distinctNonSilentSampleMagnitudes <
      value.capture.threshold?.minimumDistinctNonSilentSampleMagnitudes
  )
    issue(
      issues,
      `${path}.capture`,
      "must contain non-silent frames above the declared threshold",
    );
  assertTimestamp(value.capture.startedAt, `${path}.capture.startedAt`, issues);
  assertTimestamp(
    value.capture.completedAt,
    `${path}.capture.completedAt`,
    issues,
  );
  const started = Date.parse(value.capture.startedAt);
  const emitted = Date.parse(value.nativeCue?.emittedAt);
  const completed = Date.parse(value.capture.completedAt);
  if (
    Number.isFinite(started) &&
    Number.isFinite(emitted) &&
    Number.isFinite(completed) &&
    !(started <= emitted && emitted <= completed)
  )
    issue(
      issues,
      path,
      "must capture the Tauri cue within one synchronized PCM interval",
    );
}

function assertDisplayCaptureResult(value, request, report, issues) {
  const path = "report.displayCapture";
  if (request.operation !== "capture-display") {
    if (value !== null)
      issue(issues, path, "must be null outside capture-display");
    return;
  }
  if (report.result !== "succeeded") {
    if (value !== null)
      issue(issues, path, "must be null when display capture did not succeed");
    return;
  }
  if (
    !assertExactKeys(
      value,
      [
        "schemaVersion",
        "runId",
        "lifecycleReference",
        "captureOperationReference",
        "activeKioskSession",
        "tauriRoute",
        "cdpProbe",
        "capture",
      ],
      path,
      issues,
    )
  )
    return;
  if (value.schemaVersion !== "vm-display-capture-result/v1")
    issue(
      issues,
      `${path}.schemaVersion`,
      "must be vm-display-capture-result/v1",
    );
  if (value.runId !== request.runId)
    issue(issues, `${path}.runId`, "must bind the adapter run identity");
  if (value.lifecycleReference !== request.lifecycleReference)
    issue(
      issues,
      `${path}.lifecycleReference`,
      "must bind the active overlay lifecycle",
    );
  if (value.captureOperationReference !== request.operationReference)
    issue(
      issues,
      `${path}.captureOperationReference`,
      "must bind the capture operation",
    );
  assertActiveKioskSession(
    value.activeKioskSession,
    `${path}.activeKioskSession`,
    issues,
  );
  if (
    JSON.stringify(value.activeKioskSession) !==
    JSON.stringify(request.displayCapture?.activeKioskSession)
  )
    issue(
      issues,
      `${path}.activeKioskSession`,
      "must match the requested active kiosk session",
    );
  assertTauriRoute(value.tauriRoute, `${path}.tauriRoute`, issues);
  if (value.tauriRoute !== "http://tauri.localhost/#/")
    issue(
      issues,
      `${path}.tauriRoute`,
      "must prove the exact customer sale route",
    );
  if (value.tauriRoute !== request.displayCapture?.tauriRoute)
    issue(issues, `${path}.tauriRoute`, "must bind the requested kiosk route");
  if (
    assertExactKeys(
      value.cdpProbe,
      ["endpoint", "targetUrl", "appVisible", "appTextLength", "domNodeCount"],
      `${path}.cdpProbe`,
      issues,
    )
  ) {
    if (value.cdpProbe.endpoint !== "http://127.0.0.1:9222/json")
      issue(
        issues,
        `${path}.cdpProbe.endpoint`,
        "must use the local WebView CDP endpoint",
      );
    if (value.cdpProbe.targetUrl !== value.tauriRoute)
      issue(
        issues,
        `${path}.cdpProbe.targetUrl`,
        "must bind the captured route",
      );
    if (value.cdpProbe.appVisible !== true)
      issue(
        issues,
        `${path}.cdpProbe.appVisible`,
        "must prove #app is visible",
      );
    for (const key of ["appTextLength", "domNodeCount"])
      if (!Number.isInteger(value.cdpProbe[key]) || value.cdpProbe[key] < 1)
        issue(
          issues,
          `${path}.cdpProbe.${key}`,
          "must prove a non-empty #app DOM",
        );
  }
  if (
    !assertExactKeys(
      value.capture,
      [
        "artifact",
        "format",
        "widthPx",
        "heightPx",
        "pixelCount",
        "nonTransparentPixelCount",
        "distinctPixelCount",
      ],
      `${path}.capture`,
      issues,
    )
  )
    return;
  if (value.capture.artifact !== report.evidence?.[0]?.identity)
    issue(
      issues,
      `${path}.capture.artifact`,
      "must bind the exported display-capture evidence artifact",
    );
  if (value.capture.format !== "png")
    issue(issues, `${path}.capture.format`, "must be png");
  for (const key of [
    "widthPx",
    "heightPx",
    "pixelCount",
    "nonTransparentPixelCount",
    "distinctPixelCount",
  ]) {
    if (!Number.isInteger(value.capture[key]) || value.capture[key] < 1)
      issue(
        issues,
        `${path}.capture.${key}`,
        "must be a positive decoded PNG measurement",
      );
  }
  if (value.capture.widthPx !== 1080 || value.capture.heightPx !== 1920)
    issue(
      issues,
      `${path}.capture`,
      "must be an exact 1080x1920 kiosk framebuffer capture",
    );
}

function assertGuestMaintenanceEndpoint(endpoint, path, issues) {
  if (
    !assertExactKeys(
      endpoint,
      ["protocol", "host", "port", "reachability"],
      path,
      issues,
    )
  )
    return;
  if (endpoint.protocol !== "ssh")
    issue(issues, `${path}.protocol`, "must be ssh");
  if (
    typeof endpoint.host !== "string" ||
    endpoint.host.length === 0 ||
    endpoint.host.length > 253 ||
    /[\\/\s]/.test(endpoint.host)
  )
    issue(issues, `${path}.host`, "must be a discovered SSH host");
  else assertNoHostReference(endpoint.host, `${path}.host`, issues);
  if (
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535
  )
    issue(issues, `${path}.port`, "must be a valid TCP port");
  if (
    !new Set(["discovered", "authenticated", "unavailable"]).has(
      endpoint.reachability,
    )
  )
    issue(
      issues,
      `${path}.reachability`,
      "must be a supported reachability state",
    );
}

function assertCleanupObservation(observed, path, issues) {
  if (
    !assertExactKeys(
      observed,
      ["overlay", "runDirectory", "personalizationMedia"],
      path,
      issues,
    )
  )
    return;
  for (const key of ["overlay", "runDirectory"]) {
    if (!new Set(["present", "removed", "unknown"]).has(observed[key]))
      issue(issues, `${path}.${key}`, "must be a supported observed state");
  }
  if (
    !new Set(["not-mounted", "mounted", "removed", "unknown"]).has(
      observed.personalizationMedia,
    )
  )
    issue(
      issues,
      `${path}.personalizationMedia`,
      "must be a supported observed state",
    );
}

function isPostCleanupIdempotentCapture(request, report) {
  const observed = report.cleanup?.observed;
  return (
    request.operation === "capture-approved-base" &&
    report.result === "succeeded" &&
    report.cleanup?.status === "completed" &&
    report.cleanup?.overlayDisposition === "removed" &&
    observed?.overlay === "removed" &&
    observed?.runDirectory === "removed" &&
    observed?.personalizationMedia === "removed"
  );
}

function assertSanitizedDiagnostic(
  diagnostic,
  index,
  issues,
  pathPrefix = "report.diagnostics",
) {
  const path = `${pathPrefix}[${index}]`;
  if (!assertExactKeys(diagnostic, ["code"], path, issues)) return;
  if (!SANITIZED_DIAGNOSTIC_CODES.has(diagnostic.code))
    issue(
      issues,
      `${path}.code`,
      "must be an allowlisted sanitized diagnostic code",
    );
}

function requestEcho(request) {
  return {
    contractVersion: request.contractVersion,
    runId: request.runId,
    operation: request.operation,
    operationNonce: request.operationNonce,
    operationReference: request.operationReference,
    lifecycleReference: request.lifecycleReference,
    cancelOperationReference: request.cancelOperationReference,
    targetIdentity: request.target.identity,
    factoryMedia: request.factoryMedia,
    displayCapture: request.displayCapture,
    audioCapture: request.audioCapture,
    requestedCapabilities: [...request.requestedCapabilities],
    ...(isV2Request(request) ? { serialSession: request.serialSession } : {}),
  };
}

function reconstructRequest(request) {
  return {
    contractVersion: request.contractVersion,
    schemaVersion: request.schemaVersion,
    kind: request.kind,
    operation: request.operation,
    runId: request.runId,
    operationNonce: request.operationNonce,
    operationReference: request.operationReference,
    lifecycleReference: request.lifecycleReference,
    cancelOperationReference: request.cancelOperationReference,
    target: { identity: request.target?.identity },
    factoryMedia: request.factoryMedia,
    displayCapture: request.displayCapture,
    audioCapture: request.audioCapture,
    assets: request.assets?.map((asset) => ({
      role: asset?.role,
      identity: asset?.identity,
      digest: asset?.digest,
    })),
    requestedCapabilities: [...(request.requestedCapabilities ?? [])],
    ...(isV2Request(request) ? { serialSession: request.serialSession } : {}),
  };
}

function lifecycleSourceAsset(request) {
  if (
    request.operation === "clean-install" ||
    request.operation === "capture-approved-base"
  )
    return request.assets.find((asset) => asset.role === "factory-iso");
  if (["cleanup", "cancel"].includes(request.operation))
    return (
      request.assets.find((asset) => asset.role === "factory-iso") ??
      request.assets.find((asset) => asset.role === "approved-runtime-base")
    );
  return request.assets.find((asset) => asset.role === "approved-runtime-base");
}

export function validateVmHostAdapterRequest(input) {
  const request = structuredClone(input);
  const issues = [];
  assertExactKeys(
    request,
    [
      "contractVersion",
      "schemaVersion",
      "kind",
      "operation",
      "runId",
      "operationNonce",
      "operationReference",
      "lifecycleReference",
      "cancelOperationReference",
      "target",
      "factoryMedia",
      "displayCapture",
      "audioCapture",
      "assets",
      "requestedCapabilities",
      ...(isV2Request(request) ? ["serialSession"] : []),
    ],
    "request",
    issues,
  );
  if (request.contractVersion !== CONTRACT_VERSION)
    issue(issues, "request.contractVersion", `must be ${CONTRACT_VERSION}`);
  if (request.schemaVersion !== REQUEST_SCHEMA_VERSION)
    issue(issues, "request.schemaVersion", `must be ${REQUEST_SCHEMA_VERSION}`);
  if (request.kind !== "vm-host-adapter-request")
    issue(issues, "request.kind", "must be vm-host-adapter-request");
  if (!VM_HOST_ADAPTER_OPERATIONS.has(request.operation))
    issue(issues, "request.operation", "must be a supported operation");
  if (isSerialSessionOperation(request.operation) && !isV2Request(request))
    issue(
      issues,
      "request.serialSession",
      "must bind serial-session operations",
    );
  if (
    typeof request.runId !== "string" ||
    !/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(request.runId)
  )
    issue(issues, "request.runId", "must be an uppercase logical run identity");
  if (
    typeof request.operationNonce !== "string" ||
    !OPERATION_NONCE.test(request.operationNonce)
  )
    issue(
      issues,
      "request.operationNonce",
      "must be a high-entropy operation nonce",
    );
  if (
    request.operationReference !== `vm-operation://${request.operationNonce}` ||
    !OPERATION_REFERENCE.test(request.operationReference ?? "")
  )
    issue(
      issues,
      "request.operationReference",
      "must canonically identify this operation nonce",
    );
  if (
    typeof request.lifecycleReference !== "string" ||
    !LIFECYCLE_REFERENCE.test(request.lifecycleReference)
  )
    issue(
      issues,
      "request.lifecycleReference",
      "must be a logical overlay lifecycle reference",
    );
  if (request.operation === "cancel") {
    if (
      typeof request.cancelOperationReference !== "string" ||
      !OPERATION_REFERENCE.test(request.cancelOperationReference) ||
      request.cancelOperationReference === request.operationReference
    )
      issue(
        issues,
        "request.cancelOperationReference",
        "must identify a distinct operation to cancel",
      );
  } else if (request.cancelOperationReference !== null) {
    issue(
      issues,
      "request.cancelOperationReference",
      "must be null outside cancel",
    );
  }
  if (isV2Request(request) || isSerialSessionOperation(request.operation))
    assertSerialSessionRequest(request.serialSession, request, issues);
  if (assertExactKeys(request.target, ["identity"], "request.target", issues)) {
    if (
      typeof request.target.identity !== "string" ||
      !TARGET_IDENTITY.test(request.target.identity)
    )
      issue(
        issues,
        "request.target.identity",
        "must be a logical VM target identity",
      );
    else
      assertNoHostReference(
        request.target.identity,
        "request.target.identity",
        issues,
      );
  }
  if (
    request.operation === "clean-install" ||
    request.operation === "capture-approved-base"
  ) {
    if (
      !assertExactKeys(
        request.factoryMedia,
        [
          "assemblyMode",
          "targetFirmware",
          "manifestIdentity",
          "provenanceIdentity",
          "provenanceDigest",
          "outputIdentity",
          "outputDigest",
        ],
        "request.factoryMedia",
        issues,
      )
    ) {
      // Exact-key diagnostics are sufficient when this object is malformed.
    } else {
      if (request.factoryMedia.assemblyMode !== "windows-serviced-iso")
        issue(
          issues,
          "request.factoryMedia.assemblyMode",
          "must be windows-serviced-iso",
        );
      if (!new Set(["bios", "uefi"]).has(request.factoryMedia.targetFirmware))
        issue(
          issues,
          "request.factoryMedia.targetFirmware",
          "must be bios or uefi",
        );
      if (
        !/^sha256:[a-f0-9]{64}$/.test(
          request.factoryMedia.manifestIdentity ?? "",
        )
      )
        issue(
          issues,
          "request.factoryMedia.manifestIdentity",
          "must be a Factory Manifest SHA-256 identity",
        );
      if (
        !/^factory-evidence:\/\/sha256\/[a-f0-9]{64}$/.test(
          request.factoryMedia.provenanceIdentity ?? "",
        )
      )
        issue(
          issues,
          "request.factoryMedia.provenanceIdentity",
          "must be a Factory provenance identity",
        );
      assertLogicalIdentity(
        request.factoryMedia.outputIdentity,
        "request.factoryMedia.outputIdentity",
        issues,
      );
      for (const key of ["provenanceDigest", "outputDigest"]) {
        if (!/^sha256:[a-f0-9]{64}$/.test(request.factoryMedia[key] ?? ""))
          issue(
            issues,
            `request.factoryMedia.${key}`,
            "must be a lowercase SHA-256 digest",
          );
      }
      const source = request.assets?.find(
        (asset) => asset.role === "factory-iso",
      );
      if (
        source &&
        (request.factoryMedia.outputIdentity !== source.identity ||
          request.factoryMedia.outputDigest !== source.digest)
      )
        issue(
          issues,
          "request.factoryMedia",
          "must bind the requested factory-iso identity and digest",
        );
      if (
        request.factoryMedia.provenanceIdentity !==
        `factory-evidence://${request.factoryMedia.provenanceDigest?.replace(":", "/")}`
      )
        issue(
          issues,
          "request.factoryMedia.provenanceIdentity",
          "must bind provenanceDigest",
        );
    }
  } else if (request.factoryMedia !== null) {
    issue(
      issues,
      "request.factoryMedia",
      "must be null outside Factory ISO operations",
    );
  }
  if (request.operation === "capture-default-audio") {
    assertAudioCaptureRequest(
      request.audioCapture,
      "request.audioCapture",
      issues,
    );
  } else if (request.audioCapture !== null) {
    issue(
      issues,
      "request.audioCapture",
      "must be null outside capture-default-audio",
    );
  }
  if (request.operation === "capture-display") {
    assertDisplayCaptureRequest(
      request.displayCapture,
      "request.displayCapture",
      issues,
    );
  } else if (request.displayCapture !== null) {
    issue(
      issues,
      "request.displayCapture",
      "must be null outside capture-display",
    );
  }
  if (!Array.isArray(request.assets) || request.assets.length === 0)
    issue(issues, "request.assets", "must contain immutable operation assets");
  else {
    request.assets.forEach((asset, index) => assertAsset(asset, index, issues));
    assertUniqueRoles(request.assets, "request.assets", issues);
    if (["cleanup", "cancel"].includes(request.operation)) {
      const base = request.assets.find(
        (asset) => asset.role === "approved-runtime-base",
      );
      const iso = request.assets.find((asset) => asset.role === "factory-iso");
      if (
        base &&
        iso &&
        (base.identity !== iso.identity || base.digest !== iso.digest)
      )
        issue(
          issues,
          "request.assets",
          "must bind cleanup and cancel to one unambiguous lifecycle source",
        );
    }
  }
  if (
    !Array.isArray(request.requestedCapabilities) ||
    request.requestedCapabilities.length === 0
  )
    issue(
      issues,
      "request.requestedCapabilities",
      "must contain requested capabilities",
    );
  else {
    const seen = new Set();
    request.requestedCapabilities.forEach((capability, index) => {
      if (!VM_HOST_ADAPTER_CAPABILITIES.has(capability))
        issue(
          issues,
          `request.requestedCapabilities[${index}]`,
          "is not supported",
        );
      if (seen.has(capability))
        issue(
          issues,
          `request.requestedCapabilities[${index}]`,
          "must not be duplicated",
        );
      seen.add(capability);
    });
    const requiredCapability =
      REQUIRED_CAPABILITY_BY_OPERATION[request.operation];
    if (requiredCapability && !seen.has(requiredCapability))
      issue(
        issues,
        "request.requestedCapabilities",
        `must include ${requiredCapability}`,
      );
    for (const capability of REQUIRED_CAPABILITIES_BY_SERIAL_OPERATION[
      request.operation
    ] ?? [])
      if (!seen.has(capability))
        issue(
          issues,
          "request.requestedCapabilities",
          `must include ${capability}`,
        );
  }
  const requiredRoles =
    REQUIRED_ASSET_ROLES_BY_OPERATION[request.operation] ?? [];
  const hasRequiredRole =
    request.operation === "cleanup" || request.operation === "cancel"
      ? requiredRoles.some((role) =>
          request.assets?.some((asset) => asset?.role === role),
        )
      : requiredRoles.every((role) =>
          request.assets?.some((asset) => asset?.role === role),
        );
  if (!hasRequiredRole) {
    for (const role of requiredRoles) {
      if (request.assets?.some((asset) => asset?.role === role)) continue;
      issue(issues, "request.assets", `must include ${role}`);
      if (request.operation === "cleanup" || request.operation === "cancel")
        break;
    }
  }
  if (issues.length > 0) throw new VmHostAdapterContractError(issues);
  return reconstructRequest(request);
}

export function createVmHostAdapterRequest(input) {
  return validateVmHostAdapterRequest(input);
}

export function validateVmHostAdapterReport(input, requestInput) {
  const report = structuredClone(input);
  const request = validateVmHostAdapterRequest(requestInput);
  const issues = [];
  assertExactKeys(
    report,
    [
      "contractVersion",
      "schemaVersion",
      "kind",
      "adapter",
      "request",
      "result",
      "negotiatedCapabilities",
      "completedOperations",
      "observed",
      "consumedAssets",
      "guest",
      "evidence",
      "timestamps",
      "cleanup",
      "diagnostics",
      "displayCapture",
      "defaultAudioCapture",
      ...(isV2Request(request) ? ["serialSession", "serialEvidence"] : []),
    ],
    "report",
    issues,
  );
  if (report.contractVersion !== CONTRACT_VERSION)
    issue(issues, "report.contractVersion", `must be ${CONTRACT_VERSION}`);
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION)
    issue(issues, "report.schemaVersion", `must be ${REPORT_SCHEMA_VERSION}`);
  if (report.kind !== "vm-host-adapter-report")
    issue(issues, "report.kind", "must be vm-host-adapter-report");
  if (
    assertExactKeys(
      report.adapter,
      ["identity", "version", "contractVersion"],
      "report.adapter",
      issues,
    )
  ) {
    assertLogicalIdentity(
      report.adapter.identity,
      "report.adapter.identity",
      issues,
    );
    if (
      typeof report.adapter.version !== "string" ||
      !SEMVER.test(report.adapter.version)
    )
      issue(
        issues,
        "report.adapter.version",
        "must be a strict semantic version",
      );
    if (report.adapter.contractVersion !== CONTRACT_VERSION)
      issue(
        issues,
        "report.adapter.contractVersion",
        `must be ${CONTRACT_VERSION}`,
      );
  }
  if (
    assertExactKeys(
      report.request,
      [
        "contractVersion",
        "runId",
        "operation",
        "operationNonce",
        "operationReference",
        "lifecycleReference",
        "cancelOperationReference",
        "targetIdentity",
        "factoryMedia",
        "displayCapture",
        "audioCapture",
        "requestedCapabilities",
        ...(isV2Request(request) ? ["serialSession"] : []),
      ],
      "report.request",
      issues,
    )
  ) {
    for (const [key, expected] of Object.entries(requestEcho(request))) {
      if (JSON.stringify(report.request[key]) !== JSON.stringify(expected))
        issue(issues, `report.request.${key}`, "does not match request");
    }
  }
  if (!TERMINAL_RESULTS.has(report.result))
    issue(issues, "report.result", "must be a supported terminal result");
  if (!Array.isArray(report.negotiatedCapabilities))
    issue(issues, "report.negotiatedCapabilities", "must be an array");
  else {
    const requested = new Set(request.requestedCapabilities);
    const seen = new Set();
    report.negotiatedCapabilities.forEach((capability, index) => {
      if (!requested.has(capability))
        issue(
          issues,
          `report.negotiatedCapabilities[${index}]`,
          "was not requested",
        );
      if (seen.has(capability))
        issue(
          issues,
          `report.negotiatedCapabilities[${index}]`,
          "must not be duplicated",
        );
      seen.add(capability);
    });
    if (
      report.result === "succeeded" &&
      !seen.has(REQUIRED_CAPABILITY_BY_OPERATION[request.operation])
    )
      issue(
        issues,
        "report.negotiatedCapabilities",
        "must include the completed operation capability",
      );
    if (
      report.result === "succeeded" &&
      request.requestedCapabilities.some((capability) => !seen.has(capability))
    )
      issue(
        issues,
        "report.negotiatedCapabilities",
        "must include the complete requested capability set for a successful operation",
      );
  }
  if (!Array.isArray(report.completedOperations))
    issue(issues, "report.completedOperations", "must be an array");
  else if (
    report.result === "succeeded" &&
    !sameValues(report.completedOperations, [request.operation])
  )
    issue(
      issues,
      "report.completedOperations",
      "must contain only the requested completed operation",
    );
  else if (
    report.result !== "succeeded" &&
    report.completedOperations.length !== 0
  )
    issue(
      issues,
      "report.completedOperations",
      "must be empty when the operation did not succeed",
    );
  if (
    assertExactKeys(
      report.observed,
      [
        "vmIdentity",
        "targetBinding",
        "baseIdentity",
        "overlayIdentity",
        "factoryProvenanceDigest",
        "firmwareMode",
      ],
      "report.observed",
      issues,
    )
  ) {
    assertLogicalIdentity(
      report.observed.vmIdentity,
      "report.observed.vmIdentity",
      issues,
    );
    assertLogicalIdentity(
      report.observed.baseIdentity,
      "report.observed.baseIdentity",
      issues,
    );
    assertLogicalIdentity(
      report.observed.overlayIdentity,
      "report.observed.overlayIdentity",
      issues,
    );
    if (
      assertExactKeys(
        report.observed.targetBinding,
        ["relation", "targetIdentity"],
        "report.observed.targetBinding",
        issues,
      )
    ) {
      if (report.observed.targetBinding.relation !== "host-target-mapping/v1")
        issue(
          issues,
          "report.observed.targetBinding.relation",
          "must attest the documented host target mapping",
        );
      if (
        report.observed.targetBinding.targetIdentity !== request.target.identity
      )
        issue(
          issues,
          "report.observed.targetBinding.targetIdentity",
          "does not bind the observed VM to the requested target",
        );
    }
    const observedSource = lifecycleSourceAsset(request);
    if (
      observedSource &&
      request.operation !== "capture-approved-base" &&
      report.observed.baseIdentity !== observedSource.identity
    )
      issue(
        issues,
        "report.observed.baseIdentity",
        "does not match the requested operation source asset",
      );
    const expectedProvenance =
      request.operation === "clean-install" ||
      request.operation === "capture-approved-base"
        ? request.factoryMedia.provenanceDigest
        : null;
    if (report.observed.factoryProvenanceDigest !== expectedProvenance)
      issue(
        issues,
        "report.observed.factoryProvenanceDigest",
        "must bind the requested Factory provenance digest for clean install and be null otherwise",
      );
    if (!new Set(["bios", "uefi"]).has(report.observed.firmwareMode))
      issue(issues, "report.observed.firmwareMode", "must attest bios or uefi");
    if (
      request.factoryMedia &&
      report.observed.firmwareMode !== request.factoryMedia.targetFirmware
    )
      issue(
        issues,
        "report.observed.firmwareMode",
        "must match the requested Factory target firmware",
      );
  }
  if (!Array.isArray(report.consumedAssets))
    issue(issues, "report.consumedAssets", "must be an array");
  else {
    report.consumedAssets.forEach((asset, index) =>
      assertAsset(asset, index, issues, "report.consumedAssets"),
    );
    assertUniqueRoles(report.consumedAssets, "report.consumedAssets", issues);
    if (!sameAssets(report.consumedAssets, request.assets))
      issue(
        issues,
        "report.consumedAssets",
        "must exactly match requested immutable assets",
      );
  }
  if (
    assertExactKeys(
      report.guest,
      [
        "maintenanceEndpointIdentity",
        "maintenanceEndpoint",
        "deviceMappings",
        "defaultAudioIdentity",
      ],
      "report.guest",
      issues,
    )
  ) {
    assertLogicalIdentity(
      report.guest.maintenanceEndpointIdentity,
      "report.guest.maintenanceEndpointIdentity",
      issues,
    );
    assertGuestMaintenanceEndpoint(
      report.guest.maintenanceEndpoint,
      "report.guest.maintenanceEndpoint",
      issues,
    );
    if (
      report.result === "succeeded" &&
      !["cleanup", "cancel"].includes(request.operation) &&
      !isPostCleanupIdempotentCapture(request, report) &&
      !["discovered", "authenticated"].includes(
        report.guest.maintenanceEndpoint?.reachability,
      )
    )
      issue(
        issues,
        "report.guest.maintenanceEndpoint.reachability",
        "must be discovered by the host or authenticated by the workflow before a successful operation is accepted",
      );
    assertLogicalIdentity(
      report.guest.defaultAudioIdentity,
      "report.guest.defaultAudioIdentity",
      issues,
    );
    if (!Array.isArray(report.guest.deviceMappings))
      issue(issues, "report.guest.deviceMappings", "must be an array");
    else {
      report.guest.deviceMappings.forEach((mapping, index) => {
        const path = `report.guest.deviceMappings[${index}]`;
        if (
          !assertExactKeys(
            mapping,
            ["role", "guestDeviceIdentity"],
            path,
            issues,
          )
        )
          return;
        if (!new Set(["lower-controller", "scanner"]).has(mapping.role))
          issue(issues, `${path}.role`, "must be a supported serial role");
        assertLogicalIdentity(
          mapping.guestDeviceIdentity,
          `${path}.guestDeviceIdentity`,
          issues,
        );
      });
      assertUniqueRoles(
        report.guest.deviceMappings,
        "report.guest.deviceMappings",
        issues,
      );
      const mappings = new Set(
        report.guest.deviceMappings.map((mapping) => mapping?.role),
      );
      for (const [capability, role] of [
        ["serial:lower-controller", "lower-controller"],
        ["serial:scanner", "scanner"],
      ]) {
        if (
          report.result === "succeeded" &&
          request.requestedCapabilities.includes(capability) &&
          !mappings.has(role)
        )
          issue(issues, "report.guest.deviceMappings", `must include ${role}`);
      }
    }
  }
  assertSerialSessionReport(report, request, issues);
  assertSerialEvidence(report, request, issues);
  if (!Array.isArray(report.evidence))
    issue(issues, "report.evidence", "must be an array");
  else {
    report.evidence.forEach((entry, index) => {
      const path = `report.evidence[${index}]`;
      const entryKeys =
        entry?.role === "display-capture" ||
        entry?.role === "default-audio-capture"
          ? ["role", "identity", "digest", "fileName"]
          : ["role", "identity", "digest"];
      if (!assertExactKeys(entry, entryKeys, path, issues)) return;
      if (
        !new Set(["display-capture", "default-audio-capture"]).has(entry.role)
      )
        issue(issues, `${path}.role`, "must be a supported evidence role");
      const identity =
        typeof entry.identity === "string"
          ? entry.identity.match(EVIDENCE_IDENTITY)
          : null;
      if (!identity)
        issue(
          issues,
          `${path}.identity`,
          "must be a content-addressed evidence identity",
        );
      if (
        typeof entry.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(entry.digest)
      )
        issue(issues, `${path}.digest`, "must be a lowercase SHA-256 digest");
      else if (identity && identity[1] !== entry.digest.slice(7))
        issue(issues, path, "identity and digest must name the same evidence");
      if (
        entry.role === "display-capture" ||
        entry.role === "default-audio-capture"
      ) {
        const expectedFileName = `${entry.digest?.slice(7)}.`;
        const extension = entry.role === "display-capture" ? "png" : "wav";
        if (
          typeof entry.fileName !== "string" ||
          !new RegExp(`^[a-f0-9]{64}\\.${extension}$`).test(entry.fileName) ||
          !entry.fileName.startsWith(expectedFileName)
        )
          issue(
            issues,
            `${path}.fileName`,
            "must be a digest-bound relative evidence file name",
          );
      }
    });
    assertUniqueRoles(report.evidence, "report.evidence", issues);
    const expectedEvidenceRole =
      request.operation === "capture-display"
        ? "display-capture"
        : request.operation === "capture-default-audio"
          ? "default-audio-capture"
          : null;
    if (
      expectedEvidenceRole &&
      report.result === "succeeded" &&
      (!sameValues(
        report.evidence.map((entry) => entry?.role),
        [expectedEvidenceRole],
      ) ||
        !sameValues(report.completedOperations, [request.operation]))
    )
      issue(
        issues,
        "report.evidence",
        "must be produced only by its completed capture operation",
      );
    if (!expectedEvidenceRole && report.evidence.length !== 0)
      issue(
        issues,
        "report.evidence",
        "must be empty before or after non-capture operations",
      );
  }
  if (
    assertExactKeys(
      report.timestamps,
      ["startedAt", "completedAt"],
      "report.timestamps",
      issues,
    )
  ) {
    assertTimestamp(
      report.timestamps.startedAt,
      "report.timestamps.startedAt",
      issues,
    );
    assertTimestamp(
      report.timestamps.completedAt,
      "report.timestamps.completedAt",
      issues,
    );
    if (
      Date.parse(report.timestamps.completedAt) <
      Date.parse(report.timestamps.startedAt)
    )
      issue(issues, "report.timestamps", "must be ordered");
  }
  assertDisplayCaptureResult(report.displayCapture, request, report, issues);
  assertAudioCaptureResult(report.defaultAudioCapture, request, report, issues);
  if (
    assertExactKeys(
      report.cleanup,
      ["status", "overlayDisposition", "observed"],
      "report.cleanup",
      issues,
    )
  ) {
    assertCleanupObservation(
      report.cleanup.observed,
      "report.cleanup.observed",
      issues,
    );
    const state = `${report.cleanup.status}/${report.cleanup.overlayDisposition}`;
    const cleaned =
      report.cleanup.observed?.overlay === "removed" &&
      report.cleanup.observed?.runDirectory === "removed" &&
      report.cleanup.observed?.personalizationMedia === "removed";
    const active =
      report.cleanup.observed?.overlay === "present" &&
      report.cleanup.observed?.runDirectory === "present" &&
      ["not-mounted", "mounted"].includes(
        report.cleanup.observed?.personalizationMedia,
      );
    const completedCaptureAfterCleanup = isPostCleanupIdempotentCapture(
      request,
      report,
    );
    const expected =
      report.result === "failed" ||
      ["cleanup", "cancel"].includes(request.operation)
        ? "completed/removed with observed removal"
        : "not-run/active with observed active resources";
    if (
      (report.result === "failed" ||
        ["cleanup", "cancel"].includes(request.operation)) &&
      (state !== "completed/removed" || !cleaned)
    )
      issue(
        issues,
        "report.cleanup",
        `must be ${expected} for this lifecycle operation`,
      );
    if (
      report.result !== "failed" &&
      !["cleanup", "cancel"].includes(request.operation) &&
      !completedCaptureAfterCleanup &&
      (state !== "not-run/active" || !active)
    )
      issue(
        issues,
        "report.cleanup",
        request.operation === "capture-approved-base"
          ? "must be not-run/active with observed active resources or completed/removed with observed removal for an idempotent capture"
          : `must be ${expected} for this lifecycle operation`,
      );
  }
  if (!Array.isArray(report.diagnostics))
    issue(issues, "report.diagnostics", "must be an array");
  else
    report.diagnostics.forEach((diagnostic, index) =>
      assertSanitizedDiagnostic(diagnostic, index, issues),
    );
  if (issues.length > 0) throw new VmHostAdapterContractError(issues);
  return {
    contractVersion: report.contractVersion,
    schemaVersion: report.schemaVersion,
    kind: report.kind,
    adapter: {
      identity: report.adapter.identity,
      version: report.adapter.version,
      contractVersion: report.adapter.contractVersion,
    },
    request: requestEcho(request),
    result: report.result,
    negotiatedCapabilities: [...report.negotiatedCapabilities],
    completedOperations: [...report.completedOperations],
    observed: {
      vmIdentity: report.observed.vmIdentity,
      targetBinding: {
        relation: report.observed.targetBinding.relation,
        targetIdentity: report.observed.targetBinding.targetIdentity,
      },
      baseIdentity: report.observed.baseIdentity,
      overlayIdentity: report.observed.overlayIdentity,
      factoryProvenanceDigest: report.observed.factoryProvenanceDigest,
      firmwareMode: report.observed.firmwareMode,
    },
    consumedAssets: report.consumedAssets.map((asset) => ({
      role: asset.role,
      identity: asset.identity,
      digest: asset.digest,
    })),
    guest: {
      maintenanceEndpointIdentity: report.guest.maintenanceEndpointIdentity,
      maintenanceEndpoint: {
        protocol: report.guest.maintenanceEndpoint.protocol,
        host: report.guest.maintenanceEndpoint.host,
        port: report.guest.maintenanceEndpoint.port,
        reachability: report.guest.maintenanceEndpoint.reachability,
      },
      deviceMappings: report.guest.deviceMappings.map((mapping) => ({
        role: mapping.role,
        guestDeviceIdentity: mapping.guestDeviceIdentity,
      })),
      defaultAudioIdentity: report.guest.defaultAudioIdentity,
    },
    evidence: report.evidence.map((entry) => ({
      role: entry.role,
      identity: entry.identity,
      digest: entry.digest,
      ...(["display-capture", "default-audio-capture"].includes(entry.role)
        ? { fileName: entry.fileName }
        : {}),
    })),
    timestamps: {
      startedAt: report.timestamps.startedAt,
      completedAt: report.timestamps.completedAt,
    },
    displayCapture: report.displayCapture,
    defaultAudioCapture: report.defaultAudioCapture,
    cleanup: {
      status: report.cleanup.status,
      overlayDisposition: report.cleanup.overlayDisposition,
      observed: {
        overlay: report.cleanup.observed.overlay,
        runDirectory: report.cleanup.observed.runDirectory,
        personalizationMedia: report.cleanup.observed.personalizationMedia,
      },
    },
    diagnostics: report.diagnostics.map((diagnostic) => ({
      code: diagnostic.code,
    })),
    ...(isV2Request(request)
      ? {
          serialSession:
            report.serialSession === null
              ? null
              : {
                  serialSessionId: report.serialSession.serialSessionId,
                  sessionBindingToken: report.serialSession.sessionBindingToken,
                  startOperationReference:
                    report.serialSession.startOperationReference,
                  deviceMappingDigest: report.serialSession.deviceMappingDigest,
                  state: report.serialSession.state,
                  deviceMappings: report.serialSession.deviceMappings.map(
                    (mapping) => ({
                      role: mapping.role,
                      guestDeviceIdentity: mapping.guestDeviceIdentity,
                      simulatorProcessIdentity:
                        mapping.simulatorProcessIdentity,
                      simulatorSocketIdentity: mapping.simulatorSocketIdentity,
                      connectionState: mapping.connectionState,
                    }),
                  ),
                  scannerAcknowledgement:
                    report.serialSession.scannerAcknowledgement === null
                      ? null
                      : {
                          scannerCodeDigest:
                            report.serialSession.scannerAcknowledgement
                              .scannerCodeDigest,
                          scannerCodeByteLength:
                            report.serialSession.scannerAcknowledgement
                              .scannerCodeByteLength,
                          scannerCodeSuffix:
                            report.serialSession.scannerAcknowledgement
                              .scannerCodeSuffix,
                          accepted:
                            report.serialSession.scannerAcknowledgement
                              .accepted,
                        },
                  simulatorCleanup:
                    report.serialSession.simulatorCleanup === null
                      ? null
                      : {
                          cleanupAttemptCount:
                            report.serialSession.simulatorCleanup
                              .cleanupAttemptCount,
                          idempotencyVerified:
                            report.serialSession.simulatorCleanup
                              .idempotencyVerified,
                          survivingProcessCount:
                            report.serialSession.simulatorCleanup
                              .survivingProcessCount,
                          survivingSocketCount:
                            report.serialSession.simulatorCleanup
                              .survivingSocketCount,
                        },
                },
          serialEvidence:
            report.serialEvidence === null
              ? null
              : {
                  serialSessionId: report.serialEvidence.serialSessionId,
                  sessionBindingToken:
                    report.serialEvidence.sessionBindingToken,
                  deviceMappingDigest:
                    report.serialEvidence.deviceMappingDigest,
                  records: report.serialEvidence.records.map((record) => ({
                    role: record.role,
                    event: record.event,
                    operationNonce: record.operationNonce,
                    sessionBindingToken: record.sessionBindingToken,
                    deviceMappingDigest: record.deviceMappingDigest,
                    scannerCodeDigest: record.scannerCodeDigest,
                    scannerCodeByteLength: record.scannerCodeByteLength,
                    scannerCodeSuffix: record.scannerCodeSuffix,
                    saleCorrelationId: record.saleCorrelationId,
                    saleBinding: record.saleBinding,
                    capturedFrame: record.capturedFrame,
                  })),
                },
        }
      : {}),
  };
}

export function createVmHostAdapterDiagnostic({
  request: requestInput,
  result,
  code,
  startedAt,
  completedAt,
  cleanup,
  scannerCode,
}) {
  const request = validateVmHostAdapterRequest(requestInput);
  const diagnostic = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    kind: "vm-host-adapter-diagnostic",
    request: requestEcho(request),
    result,
    timestamps: { startedAt, completedAt },
    diagnostics: [{ code }],
    cleanup,
  };
  const issues = [];
  assertExactKeys(
    diagnostic.cleanup,
    ["attempted", "status", "observed"],
    "diagnostic.cleanup",
    issues,
  );
  if (!new Set(["failed", "timed_out", "cancelled"]).has(result))
    issue(issues, "diagnostic.result", "must be a failed terminal result");
  assertTimestamp(startedAt, "diagnostic.timestamps.startedAt", issues);
  assertTimestamp(completedAt, "diagnostic.timestamps.completedAt", issues);
  if (Date.parse(completedAt) < Date.parse(startedAt))
    issue(issues, "diagnostic.timestamps", "must be ordered");
  if (!SANITIZED_DIAGNOSTIC_CODES.has(code))
    issue(issues, "diagnostic.diagnostics[0].code", "must be allowlisted");
  if (
    typeof cleanup?.attempted !== "boolean" ||
    !new Set(["completed", "failed", "not-required"]).has(cleanup?.status)
  )
    issue(issues, "diagnostic.cleanup", "must be a sanitized cleanup outcome");
  assertCleanupObservation(
    cleanup?.observed,
    "diagnostic.cleanup.observed",
    issues,
  );
  const observedRemoval =
    cleanup?.observed?.overlay === "removed" &&
    cleanup?.observed?.runDirectory === "removed" &&
    cleanup?.observed?.personalizationMedia === "removed";
  if (
    (cleanup?.status === "completed" &&
      (!cleanup?.attempted || !observedRemoval)) ||
    (cleanup?.status === "not-required" && cleanup?.attempted)
  )
    issue(
      issues,
      "diagnostic.cleanup",
      "must truthfully bind its status to observed cleanup state",
    );
  if (issues.length > 0) throw new VmHostAdapterContractError(issues);
  return redactScannerCode(diagnostic, scannerCode);
}

export function redactScannerCode(value, scannerCode) {
  if (typeof scannerCode !== "string" || scannerCode.length === 0)
    return structuredClone(value);
  const redact = (entry) => {
    if (typeof entry === "string")
      return entry.replaceAll(scannerCode, "[redacted-scanner-code]");
    if (Array.isArray(entry)) return entry.map(redact);
    if (!isRecord(entry)) return entry;
    return Object.fromEntries(
      Object.entries(entry).map(([key, item]) => [key, redact(item)]),
    );
  };
  return redact(value);
}

function adapterExecutable(environment) {
  const value = String(environment.VEM_VM_HOST_ADAPTER ?? "").trim();
  if (!value)
    throw new Error(
      "VEM_VM_HOST_ADAPTER must be configured by the runner service",
    );
  return value;
}

function evidenceExportDirectory(value) {
  const directory = String(value ?? "").trim();
  if (!isAbsolute(directory))
    throw new Error(
      "VEM_VM_HOST_EVIDENCE_EXPORT_DIR must be an absolute runner-owned directory",
    );
  return directory;
}

function scopedEvidenceExportDirectory({
  request,
  environment,
  evidenceDirectory,
}) {
  const base = evidenceExportDirectory(
    evidenceDirectory ?? environment.VEM_VM_HOST_EVIDENCE_EXPORT_DIR,
  );
  const scope = join(
    resolve(base),
    request.runId,
    request.operationReference.slice("vm-operation://".length),
  );
  if (
    !scope.startsWith(
      `${resolve(base)}${process.platform === "win32" ? "\\" : "/"}`,
    )
  )
    throw new Error(
      "VM Host Adapter evidence export escaped its runner-owned scope",
    );
  mkdirSync(scope, { recursive: true, mode: 0o700 });
  return scope;
}

function assertScannerCodeNotPersisted(directory, scannerCode) {
  if (typeof scannerCode !== "string" || scannerCode.length === 0) return;
  const visit = (path) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile() && readFileSync(child).includes(scannerCode))
        throw new Error(
          "protected scanner input must not persist in adapter work directories or sidecars",
        );
    }
  };
  try {
    if (lstatSync(directory).isDirectory()) visit(directory);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function processGroupExists(child) {
  if (!Number.isInteger(child.pid)) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(child, signal) {
  if (!Number.isInteger(child.pid)) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
  }
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminate(child) {
  signalProcessGroup(child, "SIGTERM");
  const gracefulDeadline = Date.now() + 250;
  while (processGroupExists(child) && Date.now() < gracefulDeadline)
    await wait(20);
  if (!processGroupExists(child)) return;

  signalProcessGroup(child, "SIGKILL");
  while (processGroupExists(child)) await wait(20);
}

async function invokeAdapter({
  request,
  workDirectory,
  environment,
  timeoutMs,
  signal,
  onInterrupted,
  onStarted,
  scannerCode,
  allowTestAdapter,
}) {
  const executable = adapterExecutable(environment);
  const requestPath = join(
    workDirectory,
    `${request.operationReference.slice("vm-operation://".length)}.request.json`,
  );
  const reportPath = join(
    workDirectory,
    `${request.operationReference.slice("vm-operation://".length)}.report.json`,
  );
  const scannerInputPath =
    scannerCode === undefined
      ? null
      : join(
          workDirectory,
          `${request.operationReference.slice("vm-operation://".length)}.scanner-input`,
        );
  const startedAt = new Date().toISOString();
  writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  if (scannerInputPath)
    writeFileSync(scannerInputPath, scannerCode, { mode: 0o600, flag: "wx" });
  try {
    const outcome = await new Promise((resolve) => {
      const command = executable.endsWith(".mjs")
        ? process.execPath
        : executable;
      const args = executable.endsWith(".mjs")
        ? [
            executable,
            "--request",
            requestPath,
            "--report",
            reportPath,
            ...(scannerInputPath
              ? ["--scanner-code-file", scannerInputPath]
              : []),
          ]
        : [
            "--request",
            requestPath,
            "--report",
            reportPath,
            ...(scannerInputPath
              ? ["--scanner-code-file", scannerInputPath]
              : []),
          ];
      const {
        VEM_VM_HOST_SCANNER_CODE: _inheritedProtectedScannerCode,
        ...processEnvironment
      } = process.env;
      const {
        VEM_VM_HOST_SCANNER_CODE: _configuredProtectedScannerCode,
        ...configuredEnvironment
      } = environment;
      const child = spawn(command, args, {
        detached: process.platform !== "win32",
        stdio: "ignore",
        cwd: workDirectory,
        env: {
          ...processEnvironment,
          ...configuredEnvironment,
        },
      });
      onStarted?.(request);
      let reason = null;
      let settled = false;
      let termination = null;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const terminateFor = (nextReason) => {
        reason ??= nextReason;
        termination ??= Promise.resolve(onInterrupted?.(reason))
          .catch(() => undefined)
          .then(() => terminate(child));
        return termination;
      };
      const timer = setTimeout(() => {
        void terminateFor("timed_out").then(() => {
          finish({ code: child.exitCode, reason });
        });
      }, timeoutMs);
      const onAbort = () => {
        void terminateFor("cancelled").then(() => {
          finish({ code: child.exitCode, reason });
        });
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.once("error", () => {
        reason ??= "failed";
        finish({ code: null, reason });
      });
      child.on("close", (code) => {
        if (termination) {
          void termination.then(() => finish({ code, reason }));
          return;
        }
        finish({ code, reason });
      });
    });
    const completedAt = new Date().toISOString();
    if (outcome.reason === "timed_out" || outcome.reason === "cancelled")
      return {
        result: outcome.reason,
        code: `adapter_${outcome.reason}`,
        startedAt,
        completedAt,
        report: null,
      };
    if (outcome.code !== 0)
      return {
        result: "failed",
        code: "adapter_failed",
        startedAt,
        completedAt,
        report: null,
      };
    let report;
    try {
      report = validateVmHostAdapterReport(
        JSON.parse(readFileSync(reportPath, "utf8")),
        request,
      );
      if (
        !allowTestAdapter &&
        report.adapter.identity === "vm-host-adapter://deterministic-fake@1.0.0"
      )
        throw new Error(
          "deterministic fake adapter is restricted to contract unit tests",
        );
    } catch {
      return {
        result: "failed",
        code: "evidence_invalid",
        startedAt,
        completedAt,
        report: null,
      };
    }
    return {
      result: report.result,
      code:
        report.diagnostics[0]?.code ??
        (report.result === "succeeded"
          ? "adapter_completed"
          : `adapter_${report.result}`),
      startedAt,
      completedAt,
      report,
    };
  } finally {
    if (scannerInputPath) rmSync(scannerInputPath, { force: true });
    rmSync(requestPath, { force: true });
    rmSync(reportPath, { force: true });
  }
}

function serialSessionForRecovery(request) {
  if (request.serialSession === null) return null;
  if (request.operation !== "start-serial-session") {
    return {
      ...request.serialSession,
      scannerInjection: null,
      idempotencyCheck: false,
    };
  }
  const binding = deriveSerialSessionBinding({
    runId: request.runId,
    lifecycleReference: request.lifecycleReference,
    targetIdentity: request.target.identity,
    startOperationReference: request.operationReference,
  });
  return {
    serialSessionId: binding.serialSessionId,
    sessionBindingToken: binding.sessionBindingToken,
    startOperationReference: request.operationReference,
    // A timed out start has a stable session identity but no mapping receipt yet.
    deviceMappingDigest: null,
    deviceRoles: [...SERIAL_DEVICE_ROLES],
    scannerInjection: null,
    saleCorrelationIds: [...request.serialSession.saleCorrelationIds],
    saleBindings: structuredClone(request.serialSession.saleBindings),
    idempotencyCheck: false,
  };
}

function cleanupRequestFor(request) {
  const nonce = `op-${randomBytes(16).toString("hex")}`;
  return createVmHostAdapterRequest({
    ...request,
    operation: "cleanup",
    operationNonce: nonce,
    operationReference: `vm-operation://${nonce}`,
    cancelOperationReference: null,
    factoryMedia: null,
    displayCapture: null,
    audioCapture: null,
    requestedCapabilities: ["cleanup", "cancellation"],
    ...(isV2Request(request)
      ? {
          serialSession: serialSessionForRecovery(request),
        }
      : {}),
  });
}

function cancelRequestFor(request) {
  const nonce = `op-${randomBytes(16).toString("hex")}`;
  return createVmHostAdapterRequest({
    ...request,
    operation: "cancel",
    operationNonce: nonce,
    operationReference: `vm-operation://${nonce}`,
    cancelOperationReference: request.operationReference,
    factoryMedia: null,
    displayCapture: null,
    audioCapture: null,
    requestedCapabilities: ["cancellation", "cleanup"],
    ...(isV2Request(request)
      ? {
          serialSession: serialSessionForRecovery(request),
        }
      : {}),
  });
}

export async function runVmHostAdapter({
  request: requestInput,
  workDirectory,
  environment = process.env,
  evidenceDirectory,
  timeoutMs = Number(environment.VEM_VM_HOST_ADAPTER_TIMEOUT_MS ?? 600000),
  signal,
  onOperationStarted,
  scannerCode,
  allowTestAdapter = false,
}) {
  const testAdapterAllowed =
    allowTestAdapter ||
    process.env.VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY === "1";
  const request = validateVmHostAdapterRequest(requestInput);
  if (request.operation === "inject-scanner-code") {
    if (typeof scannerCode !== "string")
      throw new Error("inject-scanner-code requires protected scanner input");
    const descriptor = createScannerCodeDescriptor(scannerCode);
    if (
      JSON.stringify(descriptor) !==
      JSON.stringify({
        scannerCodeDigest:
          request.serialSession.scannerInjection.scannerCodeDigest,
        scannerCodeByteLength:
          request.serialSession.scannerInjection.scannerCodeByteLength,
        scannerCodeSuffix:
          request.serialSession.scannerInjection.scannerCodeSuffix,
      })
    )
      throw new Error(
        "protected scanner input does not match the request digest",
      );
  } else if (scannerCode !== undefined) {
    throw new Error(
      "protected scanner input is permitted only for inject-scanner-code",
    );
  }
  if (typeof workDirectory !== "string" || !workDirectory)
    throw new Error(
      "VM Host Adapter client requires a runner-local work directory",
    );
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("VM Host Adapter timeout must be a positive integer");
  const adapterWorkDirectory = join(resolve(workDirectory), "adapter-work");
  const scopedEvidenceDirectory =
    request.operation === "capture-display" ||
    request.operation === "capture-default-audio"
      ? scopedEvidenceExportDirectory({
          request,
          workDirectory,
          environment,
          evidenceDirectory,
        })
      : null;
  if (
    request.operation === "capture-display" ||
    request.operation === "capture-default-audio"
  )
    mkdirSync(scopedEvidenceDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(adapterWorkDirectory, { recursive: true, mode: 0o700 });
  const adapterEnvironment = {
    ...environment,
    VEM_VM_HOST_ADAPTER_CONTRACT_VERSION: CONTRACT_VERSION,
    ...(scopedEvidenceDirectory
      ? { VEM_VM_HOST_EVIDENCE_EXPORT_DIR: scopedEvidenceDirectory }
      : {}),
  };
  let cancellation;
  const cancelInFlightOperation = async () => {
    if (cancellation) return cancellation;
    cancellation = await invokeAdapter({
      request: cancelRequestFor(request),
      workDirectory: adapterWorkDirectory,
      environment: adapterEnvironment,
      timeoutMs: Math.min(timeoutMs, 30000),
      signal: undefined,
      scannerCode: undefined,
      allowTestAdapter: testAdapterAllowed,
    });
    return cancellation;
  };
  let outcome = await invokeAdapter({
    request,
    workDirectory: adapterWorkDirectory,
    environment: adapterEnvironment,
    timeoutMs,
    signal,
    onInterrupted: cancelInFlightOperation,
    onStarted: onOperationStarted,
    scannerCode,
    allowTestAdapter: testAdapterAllowed,
  });
  try {
    assertScannerCodeNotPersisted(resolve(workDirectory), scannerCode);
  } catch {
    outcome = {
      ...outcome,
      result: "failed",
      code: "evidence_invalid",
      report: null,
    };
  }
  if (
    outcome.result === "succeeded" &&
    ["capture-display", "capture-default-audio"].includes(request.operation)
  ) {
    try {
      const evidence = outcome.report.evidence[0];
      if (request.operation === "capture-display")
        inspectExportedDisplayCapture({
          directory: scopedEvidenceDirectory,
          evidence,
          capture: outcome.report.displayCapture.capture,
        });
      else
        inspectExportedDefaultAudioCapture({
          directory: scopedEvidenceDirectory,
          evidence,
          capture: outcome.report.defaultAudioCapture.capture,
        });
    } catch {
      outcome = {
        ...outcome,
        result: "failed",
        code: "evidence_invalid",
        report: null,
      };
    }
  }
  if (outcome.result === "succeeded") return outcome.report;
  let cleanup = {
    attempted: false,
    status: "not-required",
    observed: {
      overlay: "unknown",
      runDirectory: "unknown",
      personalizationMedia: "unknown",
    },
  };
  const requiresCancellation =
    outcome.result === "timed_out" || outcome.result === "cancelled";
  let cancellationOutcome = null;
  if (requiresCancellation) {
    try {
      cancellationOutcome = await cancelInFlightOperation();
    } catch {
      cancellationOutcome = { result: "failed", report: null };
    }
  }
  let recovery;
  try {
    recovery = await invokeAdapter({
      request: cleanupRequestFor(request),
      workDirectory: adapterWorkDirectory,
      environment: adapterEnvironment,
      timeoutMs: Math.min(timeoutMs, 30000),
      signal: undefined,
      scannerCode: undefined,
      allowTestAdapter: testAdapterAllowed,
    });
  } catch {
    recovery = { result: "failed", report: null };
  }
  const recovered =
    recovery.result === "succeeded" &&
    recovery.report?.cleanup.status === "completed" &&
    recovery.report.cleanup.overlayDisposition === "removed";
  cleanup = {
    attempted: true,
    status:
      (!cancellationOutcome || cancellationOutcome.result === "succeeded") &&
      recovered
        ? "completed"
        : "failed",
    observed: recovery.report?.cleanup.observed ?? {
      overlay: "unknown",
      runDirectory: "unknown",
      personalizationMedia: "unknown",
    },
  };
  const diagnostic = createVmHostAdapterDiagnostic({
    request,
    result: outcome.result,
    code: outcome.code,
    startedAt: outcome.startedAt,
    completedAt: new Date().toISOString(),
    cleanup,
    scannerCode,
  });
  rmSync(adapterWorkDirectory, { recursive: true, force: true });
  throw new VmHostAdapterExecutionError(
    `VM Host Adapter reported ${outcome.result}`,
    diagnostic,
  );
}
