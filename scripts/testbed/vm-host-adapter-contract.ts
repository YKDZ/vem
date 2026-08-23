import { spawn, type ChildProcess } from "node:child_process";
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

import { inspectExportedDefaultAudioCapture } from "./default-audio-evidence.ts";
import { inspectExportedDisplayCapture } from "./display-evidence.ts";

const CONTRACT_VERSION = "vem-vm-host-adapter-contract/v2";
const REQUEST_SCHEMA_VERSION = "vem-vm-host-adapter-request/v2";
const REPORT_SCHEMA_VERSION = "vem-vm-host-adapter-report/v2";
const DIAGNOSTIC_SCHEMA_VERSION = "vem-vm-host-adapter-diagnostic/v2";
const ASSET_IDENTITY = /^runtime-asset:\/\/sha256\/([a-f0-9]{64})$/;
const RUNTIME_BASE_IDENTITY = /^runtime-base:\/\/sha256\/([a-f0-9]{64})$/;
const EVIDENCE_IDENTITY = /^runtime-evidence:\/\/sha256\/([a-f0-9]{64})$/;
const TARGET_IDENTITY = /^vm-target:\/\/[a-z0-9][a-z0-9.-]{0,127}$/;
const OPERATION_NONCE = /^op-[a-f0-9]{16,64}$/;
const OPERATION_REFERENCE = /^vm-operation:\/\/op-[a-f0-9]{16,64}$/;
const LIFECYCLE_REFERENCE = /^vm-lifecycle:\/\/[a-z0-9][a-z0-9.-]{2,127}$/;
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
const AUDIO_CAPTURE_SOURCE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+){0,15}$/;

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

const REQUIRED_CAPABILITY_BY_OPERATION: Record<string, string> = {
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

const REQUIRED_ASSET_ROLES_BY_OPERATION: Record<string, string[]> = {
  "clean-install": ["runtime-image", "runtime-bootstrap"],
  "capture-approved-base": ["runtime-image"],
  "restore-approved-base": ["approved-runtime-base"],
  "create-disposable-overlay": ["approved-runtime-base"],
  "capture-display": ["approved-runtime-base"],
  "capture-default-audio": ["approved-runtime-base"],
  "start-serial-session": ["approved-runtime-base"],
  "inject-scanner-code": ["approved-runtime-base"],
  "collect-serial-evidence": ["approved-runtime-base"],
  "stop-serial-session": ["approved-runtime-base"],
  cleanup: ["approved-runtime-base", "runtime-image"],
  cancel: ["approved-runtime-base", "runtime-image"],
};

const REQUIRED_CAPABILITIES_BY_SERIAL_OPERATION: Record<string, string[]> = {
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
  "serial_malformed_frame",
  "serial_device_disconnected",
  "serial_scanner_timeout",
  "serial_dispense_failed",
  "serial_swapped_roles",
  "serial_missing_device",
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
  readonly issues: Array<{ path: string; message: string }>;

  constructor(issues: Array<{ path: string; message: string }>) {
    super(
      `invalid VM Host Adapter contract: ${issues.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`,
    );
    this.name = "VmHostAdapterContractError";
    this.issues = issues;
  }
}

export class VmHostAdapterExecutionError extends Error {
  readonly diagnostic: unknown;

  constructor(message: string, diagnostic: unknown) {
    super(message);
    this.name = "VmHostAdapterExecutionError";
    this.diagnostic = diagnostic;
  }
}

function issue(
  issues: Array<{ path: string; message: string }>,
  path: string,
  message: string,
): void {
  issues.push({ path, message });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: unknown,
  keys: string[],
  path: string,
  issues: Array<{ path: string; message: string }>,
): boolean {
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

function assertNoHostReference(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
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

function assertLogicalIdentity(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  if (
    typeof value !== "string" ||
    (!LOGICAL_IDENTITY.test(value) &&
      !ASSET_IDENTITY.test(value) &&
      !RUNTIME_BASE_IDENTITY.test(value))
  ) {
    issue(issues, path, "must be a logical identity");
    return;
  }
  assertNoHostReference(value, path, issues);
}

function assertAsset(
  asset: unknown,
  index: number,
  issues: Array<{ path: string; message: string }>,
  pathPrefix = "assets",
): void {
  const path = `${pathPrefix}[${index}]`;
  if (!assertExactKeys(asset, ["role", "identity", "digest"], path, issues))
    return;
  const record = asset as Record<string, unknown>;
  if (
    typeof record.role !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(record.role)
  ) {
    issue(issues, `${path}.role`, "must be a logical asset role");
  }
  const identityPattern =
    record.role === "approved-runtime-base"
      ? RUNTIME_BASE_IDENTITY
      : ASSET_IDENTITY;
  const identity =
    typeof record.identity === "string"
      ? record.identity.match(identityPattern)
      : null;
  if (!identity)
    issue(
      issues,
      `${path}.identity`,
      record.role === "approved-runtime-base"
        ? "must be a runtime-base SHA-256 identity"
        : "must be a runtime-asset SHA-256 identity",
    );
  if (
    typeof record.digest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(record.digest)
  ) {
    issue(issues, `${path}.digest`, "must be a lowercase SHA-256 digest");
  } else if (identity && identity[1] !== String(record.digest).slice(7)) {
    issue(
      issues,
      path,
      "identity and digest must name the same immutable asset",
    );
  }
  assertNoHostReference(record.identity, `${path}.identity`, issues);
}

function assertUniqueRoles(
  entries: Array<Record<string, unknown>>,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  const roles = new Set<string>();
  entries.forEach((entry: Record<string, unknown>, index: number) => {
    if (roles.has(String(entry?.role)))
      issue(issues, `${path}[${index}].role`, "must not be duplicated");
    roles.add(String(entry?.role));
  });
}

function sameValues(left: unknown, right: unknown): boolean {
  return (
    Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameAssets(left: unknown, right: unknown): boolean {
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

function isV2Request(
  request: Record<string, unknown> | null | undefined,
): boolean {
  return request?.schemaVersion === REQUEST_SCHEMA_VERSION;
}

function isSerialSessionOperation(operation: unknown): boolean {
  return SERIAL_SESSION_OPERATIONS.has(String(operation));
}

function sha256(value: string | Buffer | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createScannerCodeDescriptor(
  scannerCode: unknown,
): Record<string, unknown> {
  const bytes = normalizeScannerInput(scannerCode);
  if (bytes.length < 1 || bytes.length > 256)
    throw new Error("scanner input must contain 1 through 256 bytes");
  const digest = sha256(bytes);
  return {
    scannerCodeDigest: `sha256:${digest}`,
    scannerCodeByteLength: bytes.length,
    scannerCodeSuffix: digest.slice(-8),
  };
}

function normalizeScannerInput(scannerCode: unknown): Buffer {
  if (Buffer.isBuffer(scannerCode)) return Buffer.from(scannerCode);
  if (typeof scannerCode === "string") return Buffer.from(scannerCode, "utf8");
  throw new Error("scanner input must be a string or Buffer");
}

export function deriveSerialFrameCaptureBindingDigest({
  request,
  record,
  previousCaptureBindingDigest = null,
}: {
  request?: Record<string, unknown>;
  record?: Record<string, unknown>;
  previousCaptureBindingDigest?: string | null;
}): string {
  const frame = (record?.capturedFrame ?? {}) as Record<string, unknown>;
  const sale = record?.saleBinding as Record<string, unknown> | undefined;
  const material = {
    schemaVersion: "vem-serial-frame-capture-binding/v1",
    runId: request?.runId ?? null,
    lifecycleReference: request?.lifecycleReference ?? null,
    targetIdentity:
      (request?.target as Record<string, unknown> | undefined)?.identity ?? null,
    operationReference: request?.operationReference ?? null,
    serialSessionId:
      (request?.serialSession as Record<string, unknown> | undefined)
        ?.serialSessionId ?? null,
    sessionBindingToken:
      (request?.serialSession as Record<string, unknown> | undefined)
        ?.sessionBindingToken ?? null,
    deviceMappingDigest:
      (request?.serialSession as Record<string, unknown> | undefined)
        ?.deviceMappingDigest ?? null,
    operationEvidence:
      (request?.serialSession as Record<string, unknown> | undefined)
        ?.operationEvidence ?? null,
    saleCorrelationId: record?.saleCorrelationId ?? null,
    orderId: sale?.orderId ?? null,
    paymentId: sale?.paymentId ?? null,
    vendingCommandId: sale?.vendingCommandId ?? null,
    role: record?.role ?? null,
    event: record?.event ?? null,
    operationNonce: record?.operationNonce ?? null,
    rawSerialFrame: {
      source: frame.source ?? null,
      sequence: frame.sequence ?? null,
      digest: frame.digest ?? null,
      byteLength: frame.byteLength ?? null,
    },
    previousCaptureBindingDigest,
  };
  return `sha256:${sha256(JSON.stringify(material))}`;
}

export function deriveSerialEvidenceCaptureChainDigest({
  request,
  records,
}: {
  request?: Record<string, unknown>;
  records?: unknown;
}): string {
  const material = {
    schemaVersion: "vem-serial-evidence-capture-chain/v1",
    runId: request?.runId ?? null,
    lifecycleReference: request?.lifecycleReference ?? null,
    targetIdentity:
      (request?.target as Record<string, unknown> | undefined)?.identity ?? null,
    operationReference: request?.operationReference ?? null,
    serialSessionId:
      (request?.serialSession as Record<string, unknown> | undefined)
        ?.serialSessionId ?? null,
    sessionBindingToken:
      (request?.serialSession as Record<string, unknown> | undefined)
        ?.sessionBindingToken ?? null,
    deviceMappingDigest:
      (request?.serialSession as Record<string, unknown> | undefined)
        ?.deviceMappingDigest ?? null,
    operationEvidence:
      (request?.serialSession as Record<string, unknown> | undefined)
        ?.operationEvidence ?? null,
    captureBindingDigests: Array.isArray(records)
      ? records.map((record) => record?.captureBindingDigest ?? null)
      : null,
  };
  return `sha256:${sha256(JSON.stringify(material))}`;
}

export function deriveSerialSessionBinding({
  runId,
  lifecycleReference,
  targetIdentity,
  startOperationReference,
}: {
  runId: unknown;
  lifecycleReference: unknown;
  targetIdentity: unknown;
  startOperationReference: unknown;
}): { serialSessionId: string; sessionBindingToken: string } {
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

export function deriveSerialDeviceMappingDigest(
  deviceMappings: Array<Record<string, unknown>>,
): string {
  const canonical = deviceMappings.map((mapping) => ({
    role: mapping?.role,
    guestDeviceIdentity: mapping?.guestDeviceIdentity,
    guestUsbTopology: mapping?.guestUsbTopology,
    simulatorProcessIdentity: mapping?.simulatorProcessIdentity,
    simulatorSocketIdentity: mapping?.simulatorSocketIdentity,
  }));
  return `sha256:${sha256(JSON.stringify(canonical))}`;
}

function assertGuestUsbTopology(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  if (
    !assertExactKeys(
      value,
      ["alias", "targetPort", "usbBus", "usbPort"],
      path,
      issues,
    )
  )
    return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.alias !== "string" ||
    !/^serial-(?:lower-controller|scanner)$/.test(record.alias)
  )
    issue(
      issues,
      `${path}.alias`,
      "must identify a supported libvirt serial role",
    );
  if (
    typeof record.targetPort !== "number" ||
    !Number.isInteger(record.targetPort) ||
    record.targetPort < 0
  )
    issue(
      issues,
      `${path}.targetPort`,
      "must be a non-negative libvirt target port",
    );
  if (
    typeof record.usbBus !== "number" ||
    !Number.isInteger(record.usbBus) ||
    record.usbBus < 0
  )
    issue(issues, `${path}.usbBus`, "must be a non-negative libvirt USB bus");
  if (
    typeof record.usbPort !== "string" ||
    !/^\d+(?:\.\d+)*$/.test(record.usbPort)
  )
    issue(issues, `${path}.usbPort`, "must be a libvirt USB address port");
}

function expectedSerialBinding(
  request: Record<string, unknown>,
  session: Record<string, unknown>,
): { serialSessionId: string; sessionBindingToken: string } {
  return deriveSerialSessionBinding({
    runId: request.runId,
    lifecycleReference: request.lifecycleReference,
    targetIdentity: (request.target as Record<string, unknown>).identity,
    startOperationReference:
      request.operation === "start-serial-session"
        ? request.operationReference
        : session.startOperationReference,
  });
}

function assertScannerInjection(
  injection: unknown,
  path: string,
  request: Record<string, unknown>,
  issues: Array<{ path: string; message: string }>,
): void {
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
  const record = injection as Record<string, unknown>;
  if (
    typeof record.operationNonce !== "string" ||
    !OPERATION_NONCE.test(record.operationNonce)
  )
    issue(issues, `${path}.operationNonce`, "must be an operation nonce");
  if (!SHA256_DIGEST.test(String(record.scannerCodeDigest ?? "")))
    issue(issues, `${path}.scannerCodeDigest`, "must be a SHA-256 digest");
  if (
    typeof record.scannerCodeByteLength !== "number" ||
    !Number.isInteger(record.scannerCodeByteLength) ||
    record.scannerCodeByteLength < 1 ||
    record.scannerCodeByteLength > 256
  )
    issue(
      issues,
      `${path}.scannerCodeByteLength`,
      "must be a bounded scanner input byte length",
    );
  if (!SCANNER_CODE_SUFFIX.test(String(record.scannerCodeSuffix ?? "")))
    issue(
      issues,
      `${path}.scannerCodeSuffix`,
      "must be an eight-character redacted digest suffix",
    );
  if (
    request.operation === "inject-scanner-code" &&
    record.operationNonce !== request.operationNonce
  )
    issue(
      issues,
      `${path}.operationNonce`,
      "must bind the scanner injection to this operation nonce",
    );
}

function assertSerialSessionRequest(
  session: unknown,
  request: Record<string, unknown>,
  issues: Array<{ path: string; message: string }>,
): void {
  if (!isV2Request(request)) return;
  const sessionRecord = session as Record<string, unknown> | null;
  const carriesSession =
    isSerialSessionOperation(request.operation) ||
    ["cleanup", "cancel"].includes(String(request.operation));
  if (!carriesSession) {
    if (sessionRecord !== null)
      issue(
        issues,
        "request.serialSession",
        "must be null outside serial lifecycle operations",
      );
    return;
  }
  if (sessionRecord === null) {
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
      sessionRecord,
      [
        "serialSessionId",
        "sessionBindingToken",
        "startOperationReference",
        "deviceMappingDigest",
        "deviceRoles",
        "scannerInjection",
        "saleCorrelationIds",
        "saleBindings",
        "operationEvidence",
        "idempotencyCheck",
      ],
      "request.serialSession",
      issues,
    )
  )
    return;
  if (!sameValues(sessionRecord.deviceRoles, SERIAL_DEVICE_ROLES))
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
      if (sessionRecord[key] !== null)
        issue(
          issues,
          `request.serialSession.${key}`,
          "must be null when starting a serial session",
        );
  } else {
    const isRecoveryCleanup =
      ["cleanup", "cancel"].includes(String(request.operation)) &&
      sessionRecord.deviceMappingDigest === null;
    const expected = expectedSerialBinding(request, sessionRecord);
    if (
      typeof sessionRecord.startOperationReference !== "string" ||
      !OPERATION_REFERENCE.test(sessionRecord.startOperationReference)
    )
      issue(
        issues,
        "request.serialSession.startOperationReference",
        "must identify the start operation",
      );
    if (sessionRecord.serialSessionId !== expected.serialSessionId)
      issue(
        issues,
        "request.serialSession.serialSessionId",
        "must be derived from this run lifecycle target and start operation",
      );
    if (sessionRecord.sessionBindingToken !== expected.sessionBindingToken)
      issue(
        issues,
        "request.serialSession.sessionBindingToken",
        "must bind the derived serial session",
      );
    if (
      !isRecoveryCleanup &&
      !SHA256_DIGEST.test(String(sessionRecord.deviceMappingDigest ?? ""))
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
  ].includes(String(request.operation));
  if (usesInjection) {
    if (sessionRecord.scannerInjection === null)
      issue(
        issues,
        "request.serialSession.scannerInjection",
        "must bind protected scanner input",
      );
    else
      assertScannerInjection(
        sessionRecord.scannerInjection,
        "request.serialSession.scannerInjection",
        request,
        issues,
      );
  } else if (sessionRecord.scannerInjection !== null)
    issue(
      issues,
      "request.serialSession.scannerInjection",
      "must be null for this operation",
    );
  if (request.operation === "collect-serial-evidence") {
    const evidence = sessionRecord.operationEvidence as
      | Record<string, unknown>
      | null;
    if (
      !assertExactKeys(
        evidence,
        ["runnerChallenge", "startReportDigest", "injectReportDigest"],
        "request.serialSession.operationEvidence",
        issues,
      )
    ) {
      // Exact-key diagnostics are sufficient when this object is malformed.
    } else if (evidence !== null) {
      if (
        !/^serial-runner-challenge:\/\/sha256-[a-f0-9]{64}$/.test(
          String(evidence.runnerChallenge ?? ""),
        )
      )
        issue(
          issues,
          "request.serialSession.operationEvidence.runnerChallenge",
          "must be a runner-created serial challenge",
        );
      for (const key of ["startReportDigest", "injectReportDigest"])
        if (!SHA256_DIGEST.test(String(evidence[key] ?? "")))
          issue(
            issues,
            `request.serialSession.operationEvidence.${key}`,
            "must reference previously committed operation evidence",
          );
    }
  } else if (
    !["cleanup", "cancel"].includes(String(request.operation)) &&
    sessionRecord.operationEvidence !== null
  )
    issue(
      issues,
      "request.serialSession.operationEvidence",
      "must be null outside serial evidence collection",
    );
  if (!Array.isArray(sessionRecord.saleCorrelationIds))
    issue(
      issues,
      "request.serialSession.saleCorrelationIds",
      "must be an array",
    );
  else {
    const seen = new Set();
    (sessionRecord.saleCorrelationIds as unknown[]).forEach(
      (value: unknown, index: number) => {
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
      },
    );
    if ((sessionRecord.saleCorrelationIds as unknown[]).length === 0)
      issue(
        issues,
        "request.serialSession.saleCorrelationIds",
        "must bind at least one logical sale correlation identity",
      );
  }
  if (!Array.isArray(sessionRecord.saleBindings))
    issue(
      issues,
      "request.serialSession.saleBindings",
      "must bind concrete observed business identifiers",
    );
  else {
    const bindingsRequired = [
      "inject-scanner-code",
      "collect-serial-evidence",
    ].includes(String(request.operation));
    if (
      bindingsRequired &&
      (sessionRecord.saleBindings as unknown[]).length !==
        (sessionRecord.saleCorrelationIds as unknown[])?.length
    )
      issue(
        issues,
        "request.serialSession.saleBindings",
        "must bind every requested sale correlation identity",
      );
    if (
      request.operation === "start-serial-session" &&
      (sessionRecord.saleBindings as unknown[]).length !== 0
    )
      issue(
        issues,
        "request.serialSession.saleBindings",
        "must be empty before the scanner sale creates business identifiers",
      );
    (sessionRecord.saleBindings as unknown[]).forEach(
      (binding: unknown, index: number) => {
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
      const bindingRecord = binding as Record<string, unknown>;
      if (
        bindingRecord.saleCorrelationId !==
        (sessionRecord.saleCorrelationIds as unknown[])?.[index]
      )
        issue(
          issues,
          `${path}.saleCorrelationId`,
          "must match its requested sale correlation identity",
        );
      for (const key of ["orderId", "paymentId", "vendingCommandId"])
        if (
          !(
            request.operation !== "collect-serial-evidence" &&
            key === "vendingCommandId" &&
            bindingRecord[key] === null
          ) &&
          (typeof bindingRecord[key] !== "string" ||
            !BUSINESS_IDENTIFIER.test(bindingRecord[key]))
        )
          issue(
            issues,
            `${path}.${key}`,
            "must be a concrete observed business identifier",
          );
      },
    );
  }
  if (typeof sessionRecord.idempotencyCheck !== "boolean")
    issue(
      issues,
      "request.serialSession.idempotencyCheck",
      "must be a boolean",
    );
  else if (
    request.operation !== "stop-serial-session" &&
    sessionRecord.idempotencyCheck
  )
    issue(
      issues,
      "request.serialSession.idempotencyCheck",
      "must be false outside stop-serial-session",
    );
}

function assertSerialSessionMapping(
  mapping: unknown,
  index: number,
  guestMappings: Array<Record<string, unknown>>,
  issues: Array<{ path: string; message: string }>,
): void {
  const path = `report.serialSession.deviceMappings[${index}]`;
  if (
    !assertExactKeys(
      mapping,
      [
        "role",
        "guestDeviceIdentity",
        "guestUsbTopology",
        "simulatorProcessIdentity",
        "simulatorSocketIdentity",
        "connectionState",
      ],
      path,
      issues,
    )
  )
    return;
  const record = mapping as Record<string, unknown>;
  if (!SERIAL_DEVICE_ROLES.includes(String(record.role)))
    issue(issues, `${path}.role`, "must be a supported serial role");
  for (const key of [
    "guestDeviceIdentity",
    "simulatorProcessIdentity",
    "simulatorSocketIdentity",
  ])
    assertLogicalIdentity(record[key], `${path}.${key}`, issues);
  assertGuestUsbTopology(
    record.guestUsbTopology,
    `${path}.guestUsbTopology`,
    issues,
  );
  if (
    !new Set(["connected", "disconnected"]).has(
      String(record.connectionState),
    )
  )
    issue(
      issues,
      `${path}.connectionState`,
      "must be connected or disconnected",
    );
  const guestMapping = guestMappings.find(
    (entry) => entry?.role === record.role,
  );
  if (
    !guestMapping ||
    guestMapping.guestDeviceIdentity !== record.guestDeviceIdentity ||
    JSON.stringify(guestMapping.guestUsbTopology) !==
      JSON.stringify(record.guestUsbTopology)
  )
    issue(
      issues,
      `${path}.guestDeviceIdentity`,
      "must bind the reported guest device mapping",
    );
}

function assertSemanticRecord(
  record: unknown,
  index: number,
  request: Record<string, unknown>,
  issues: Array<{ path: string; message: string }>,
): void {
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
        "captureBindingDigest",
      ],
      path,
      issues,
    )
  )
    return;
  const recordValue = record as Record<string, unknown>;
  if (!SALE_EVIDENCE_ROLES.has(String(recordValue.role)))
    issue(issues, `${path}.role`, "must be a supported serial evidence role");
  if (!SHA256_DIGEST.test(String(recordValue.captureBindingDigest ?? "")))
    issue(
      issues,
      `${path}.captureBindingDigest`,
      "must bind the frame capture to its sale and serial context",
    );
  if (
    assertExactKeys(
      recordValue.capturedFrame,
      ["source", "sequence", "digest", "byteLength"],
      `${path}.capturedFrame`,
      issues,
    )
  ) {
    if (
      (recordValue.capturedFrame as Record<string, unknown>).source !==
      "guest-serial-session"
    )
      issue(
        issues,
        `${path}.capturedFrame.source`,
        "must be captured from the guest serial session, not a synthetic sidecar",
      );
    if (
      typeof (recordValue.capturedFrame as Record<string, unknown>).sequence !==
        "number" ||
      !Number.isInteger(
        (recordValue.capturedFrame as Record<string, unknown>).sequence,
      ) ||
      Number((recordValue.capturedFrame as Record<string, unknown>).sequence) < 1
    )
      issue(
        issues,
        `${path}.capturedFrame.sequence`,
        "must be a positive frame sequence",
      );
    if (
      !SHA256_DIGEST.test(
        String(
          (recordValue.capturedFrame as Record<string, unknown>).digest ?? "",
        ),
      )
    )
      issue(
        issues,
        `${path}.capturedFrame.digest`,
        "must be a SHA-256 frame digest",
      );
    if (
      typeof (recordValue.capturedFrame as Record<string, unknown>)
        .byteLength !== "number" ||
      !Number.isInteger(
        (recordValue.capturedFrame as Record<string, unknown>).byteLength,
      ) ||
      Number((recordValue.capturedFrame as Record<string, unknown>).byteLength) <
        1
    )
      issue(
        issues,
        `${path}.capturedFrame.byteLength`,
        "must be a positive frame byte length",
      );
  }
  const requestSerialSession = request.serialSession as Record<string, unknown>;
  const expectedSaleBinding = (
    requestSerialSession.saleBindings as Array<Record<string, unknown>> | undefined
  )?.find(
    (binding) => binding.saleCorrelationId === recordValue.saleCorrelationId,
  );
  if (recordValue.saleCorrelationId === null) {
    if (recordValue.saleBinding !== null)
      issue(issues, `${path}.saleBinding`, "must be null when no sale applies");
  } else if (
    JSON.stringify(recordValue.saleBinding) !==
    JSON.stringify(expectedSaleBinding)
  )
    issue(
      issues,
      `${path}.saleBinding`,
      "must bind the observed order, payment, and vending command for this sale",
    );
  if (
    recordValue.sessionBindingToken !==
    requestSerialSession.sessionBindingToken
  )
    issue(
      issues,
      `${path}.sessionBindingToken`,
      "must bind the serial session token",
    );
  if (
    recordValue.deviceMappingDigest !==
    requestSerialSession.deviceMappingDigest
  )
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
  if (recordValue.role === "lower-controller") {
    if (!lowerEvents.has(String(recordValue.event)))
      issue(
        issues,
        `${path}.event`,
        "must be a required lower-controller semantic event",
      );
    if (recordValue.operationNonce !== request.operationNonce)
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
      if (recordValue[key] !== null)
        issue(
          issues,
          `${path}.${key}`,
          "must be null for lower-controller evidence",
        );
    const isDispense = String(recordValue.event).startsWith("dispense-");
    if (isDispense) {
      if (
        !(
          requestSerialSession.saleCorrelationIds as unknown[]
        ).includes(
          recordValue.saleCorrelationId,
        )
      )
        issue(
          issues,
          `${path}.saleCorrelationId`,
          "must bind a requested sale correlation identity",
        );
    } else if (recordValue.saleCorrelationId !== null)
      issue(
        issues,
        `${path}.saleCorrelationId`,
        "must be null when no sale correlation applies",
      );
  } else if (recordValue.role === "scanner") {
    if (recordValue.event !== "scanner-injection")
      issue(issues, `${path}.event`, "must be scanner-injection");
    const injection = requestSerialSession.scannerInjection as
      | Record<string, unknown>
      | undefined;
    if (recordValue.operationNonce !== injection?.operationNonce)
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
      if (recordValue[key] !== injection?.[key])
        issue(
          issues,
          `${path}.${key}`,
          "must bind the protected scanner input descriptor",
        );
    if (
      !(requestSerialSession.saleCorrelationIds as unknown[]).includes(
        recordValue.saleCorrelationId,
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
        String(recordValue.event),
      )
    )
      issue(
        issues,
        `${path}.event`,
        "must be a required payment semantic event",
      );
    if (recordValue.operationNonce !== request.operationNonce)
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
      if (recordValue[key] !== null)
        issue(issues, `${path}.${key}`, "must be null for payment evidence");
    if (
      !(requestSerialSession.saleCorrelationIds as unknown[]).includes(
        recordValue.saleCorrelationId,
      )
    )
      issue(
        issues,
        `${path}.saleCorrelationId`,
        "must bind a requested sale correlation identity",
      );
  }
}

function assertSerialEvidence(
  report: Record<string, unknown>,
  request: Record<string, unknown>,
  issues: Array<{ path: string; message: string }>,
): void {
  if (!isV2Request(request)) return;
  const evidence = report.serialEvidence as Record<string, unknown> | null;
  if (String(request.operation) !== "collect-serial-evidence") {
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
        "operationEvidence",
        "records",
        "captureChainDigest",
      ],
      "report.serialEvidence",
      issues,
    )
  )
    return;
  if (evidence === null) return;
  const requestSerialSession = request.serialSession as Record<string, unknown>;
  for (const key of [
    "serialSessionId",
    "sessionBindingToken",
    "deviceMappingDigest",
  ])
    if (evidence[key] !== requestSerialSession[key])
      issue(
        issues,
        `report.serialEvidence.${key}`,
        "must bind the requested serial session",
      );
  if (
    JSON.stringify(evidence.operationEvidence) !==
    JSON.stringify(requestSerialSession.operationEvidence)
  )
    issue(
      issues,
      "report.serialEvidence.operationEvidence",
      "must retain the runner-held operation evidence references",
    );
  const records = evidence.records as unknown[];
  if (!Array.isArray(records)) {
    issue(issues, "report.serialEvidence.records", "must be an array");
    return;
  }
  records.forEach((record: unknown, index: number) =>
    assertSemanticRecord(record, index, request, issues),
  );
  let previousCaptureBindingDigest: string | null = null;
  records.forEach((record: unknown, index: number) => {
    const recordValue = record as Record<string, unknown>;
    const expectedCaptureBindingDigest = deriveSerialFrameCaptureBindingDigest({
      request,
      record: recordValue,
      previousCaptureBindingDigest,
    });
    if (recordValue.captureBindingDigest !== expectedCaptureBindingDigest)
      issue(
        issues,
        `report.serialEvidence.records[${index}].captureBindingDigest`,
        "must immutably bind the run, sale, and raw serial frame at capture",
      );
    previousCaptureBindingDigest =
      (recordValue.captureBindingDigest as string | undefined) ?? null;
  });
  if (
    evidence.captureChainDigest !==
    deriveSerialEvidenceCaptureChainDigest({
      request,
      records,
    })
  )
    issue(
      issues,
      "report.serialEvidence.captureChainDigest",
      "must commit the complete immutable serial capture chain",
    );
  const capturedFrameSequences = new Set<number>();
  let previousFrameSequence = 0;
  records.forEach((record: unknown, index: number) => {
    const recordValue = record as Record<string, unknown>;
    const capturedFrame = recordValue.capturedFrame as
      | Record<string, unknown>
      | undefined;
    const sequence = capturedFrame?.sequence;
    if (!Number.isInteger(sequence) || (sequence as number) < 1) return;
    if (capturedFrameSequences.has(sequence as number))
      issue(
        issues,
        `report.serialEvidence.records[${index}].capturedFrame.sequence`,
        "must be globally unique across serial evidence",
      );
    if ((sequence as number) <= previousFrameSequence)
      issue(
        issues,
        `report.serialEvidence.records[${index}].capturedFrame.sequence`,
        "must be strictly increasing in evidence order",
      );
    capturedFrameSequences.add(sequence as number);
    previousFrameSequence = sequence as number;
  });
  const lowerEvents = new Set(
    records
      .filter(
        (record) =>
          (record as Record<string, unknown>)?.role === "lower-controller",
      )
      .map((record) =>
        String((record as Record<string, unknown>)?.event ?? ""),
      ),
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
    !records.some(
      (record) =>
        (record as Record<string, unknown>).role === "scanner" &&
        (record as Record<string, unknown>).event === "scanner-injection",
    )
  )
    issue(
      issues,
      "report.serialEvidence.records",
      "must include scanner injection evidence",
    );
  const saleCorrelationIds =
    requestSerialSession.saleCorrelationIds as unknown[];
  for (const saleCorrelationId of saleCorrelationIds) {
    const requiredEvents = [
      "scanner:scanner-injection",
      "payment:payment-request",
      "payment:payment-ack",
      "payment:payment-result",
      "lower-controller:dispense-request",
      "lower-controller:dispense-ack",
      "lower-controller:dispense-result",
    ];
    const recordsForSale = records.filter(
      (record) =>
        (record as Record<string, unknown>).saleCorrelationId ===
        saleCorrelationId,
    );
    const eventsForSale = recordsForSale.map((record) => {
      const recordValue = record as Record<string, unknown>;
      return `${String(recordValue.role)}:${String(recordValue.event)}`;
    });
    for (const event of requiredEvents) {
      const eventCount = eventsForSale.filter(
        (value) => value === event,
      ).length;
      if (eventCount === 0)
        issue(
          issues,
          "report.serialEvidence.records",
          `must bind ${event} to every requested sale correlation identity`,
        );
      else if (eventCount !== 1)
        issue(
          issues,
          "report.serialEvidence.records",
          `must bind ${event} exactly once to ${saleCorrelationId}`,
        );
    }
    if (JSON.stringify(eventsForSale) !== JSON.stringify(requiredEvents))
      issue(
        issues,
        "report.serialEvidence.records",
        `must preserve scanner-to-dispense causal order for ${saleCorrelationId}`,
      );
  }
}

function assertSerialSessionReport(
  report: Record<string, unknown>,
  request: Record<string, unknown>,
  issues: Array<{ path: string; message: string }>,
): void {
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
  const session = report.serialSession as Record<string, unknown> | null;
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
  if (session === null) return;
  const expected = expectedSerialBinding(
    request,
    (request.serialSession as Record<string, unknown> | null) ?? session,
  );
  const expectedBinding = expected as Record<string, unknown>;
  for (const key of ["serialSessionId", "sessionBindingToken"])
    if (session[key] !== expectedBinding[key])
      issue(
        issues,
        `report.serialSession.${key}`,
        "must be derived from the requested session binding",
      );
  const expectedStartReference =
    request.operation === "start-serial-session"
      ? request.operationReference
      : (request.serialSession as Record<string, unknown> | undefined)
          ?.startOperationReference;
  if (session.startOperationReference !== expectedStartReference)
    issue(
      issues,
      "report.serialSession.startOperationReference",
      "must bind the initiating operation",
    );
  const expectedState =
    request.operation === "stop-serial-session"
      ? "stopped"
      : ["cleanup", "cancel"].includes(String(request.operation))
        ? "cleaned"
        : "active";
  if (session.state !== expectedState)
    issue(
      issues,
      "report.serialSession.state",
      `must be ${expectedState} for this operation`,
    );
  const deviceMappings = session.deviceMappings as unknown[];
  const guest = report.guest as Record<string, unknown> | undefined;
  const guestDeviceMappings = (guest?.deviceMappings as unknown[] | undefined) ?? [];
  if (!Array.isArray(deviceMappings))
    issue(issues, "report.serialSession.deviceMappings", "must be an array");
  else {
    deviceMappings.forEach((mapping: unknown, index: number) =>
      assertSerialSessionMapping(
        mapping,
        index,
        guestDeviceMappings as Array<Record<string, unknown>>,
        issues,
      ),
    );
    if (
      !sameValues(
        deviceMappings.map((mapping) =>
          (mapping as Record<string, unknown>)?.role,
        ),
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
    for (const mapping of deviceMappings)
      if (
        (mapping as Record<string, unknown>)?.connectionState !==
        expectedConnection
      )
        issue(
          issues,
          "report.serialSession.deviceMappings",
          `must be ${expectedConnection} for this state`,
        );
    const derivedDigest = deriveSerialDeviceMappingDigest(
      deviceMappings as Array<Record<string, unknown>>,
    );
    if (session.deviceMappingDigest !== derivedDigest)
      issue(
        issues,
        "report.serialSession.deviceMappingDigest",
        "must bind the reported simulator mappings",
      );
    if (
      request.operation !== "start-serial-session" &&
      (request.serialSession as Record<string, unknown> | undefined)
        ?.deviceMappingDigest !== null &&
      session.deviceMappingDigest !==
        (request.serialSession as Record<string, unknown> | undefined)
          ?.deviceMappingDigest
    )
      issue(
        issues,
        "report.serialSession.deviceMappingDigest",
        "must match the requested session mapping digest",
      );
  }
  if (request.operation === "inject-scanner-code") {
    const acknowledgement = session.scannerAcknowledgement as
      | Record<string, unknown>
      | null;
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
    } else if (acknowledgement !== null) {
      const requestSerialSession = request.serialSession as Record<string, unknown>;
      const scannerInjection = requestSerialSession.scannerInjection as
        | Record<string, unknown>
        | undefined;
      for (const key of [
        "scannerCodeDigest",
        "scannerCodeByteLength",
        "scannerCodeSuffix",
      ])
        if (acknowledgement[key] !== scannerInjection?.[key])
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
  const needsCleanup = [
    "stop-serial-session",
    "cleanup",
    "cancel",
  ].includes(String(request.operation));
  if (needsCleanup) {
    const cleanup = session.simulatorCleanup as Record<string, unknown> | null;
    const detailedCleanup =
      Object.hasOwn(cleanup ?? {}, "termination") ||
      Object.hasOwn(cleanup ?? {}, "errors");
    if (
      !assertExactKeys(
        cleanup,
        [
          "cleanupAttemptCount",
          "idempotencyVerified",
          "survivingProcessCount",
          "survivingSocketCount",
          ...(detailedCleanup ? ["termination", "errors"] : []),
        ],
        "report.serialSession.simulatorCleanup",
        issues,
      )
    ) {
      // Exact-key diagnostics are sufficient when this object is malformed.
    } else if (cleanup !== null) {
      if (
        !Number.isInteger(cleanup.cleanupAttemptCount) ||
        (cleanup.cleanupAttemptCount as number) < 1
      )
        issue(
          issues,
          "report.serialSession.simulatorCleanup.cleanupAttemptCount",
          "must count cleanup attempts",
        );
      if (
        cleanup.survivingProcessCount !== 0 ||
        cleanup.survivingSocketCount !== 0 ||
        (detailedCleanup &&
          (!Array.isArray(cleanup.errors) ||
            (cleanup.errors as unknown[]).length !== 0 ||
            !Array.isArray(cleanup.termination)))
      )
        issue(
          issues,
          "report.serialSession.simulatorCleanup",
          "must prove no simulator resources survive",
        );
      const requiresIdempotencyProof =
        request.operation === "stop-serial-session" &&
        (request.serialSession as Record<string, unknown>).idempotencyCheck;
      if (
        requiresIdempotencyProof &&
        ((cleanup.cleanupAttemptCount as number) < 2 ||
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

function assertTimestamp(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  if (
    typeof value !== "string" ||
    !ISO_TIMESTAMP.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  ) {
    issue(issues, path, "must be a canonical ISO-8601 UTC timestamp");
  }
}

function assertActiveKioskSession(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  if (!assertExactKeys(value, ["sessionUser", "sessionId"], path, issues))
    return;
  const record = value as Record<string, unknown>;
  if (record.sessionUser !== "VEMKiosk")
    issue(issues, `${path}.sessionUser`, "must bind the VEMKiosk session");
  if (!Number.isInteger(record.sessionId) || (record.sessionId as number) < 1)
    issue(
      issues,
      `${path}.sessionId`,
      "must be an active positive Windows session id",
    );
}

function assertTauriRoute(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  try {
    const url = new URL(String(value));
    if (
      url.protocol === "http:" &&
      url.host === "tauri.localhost" &&
      url.hash.startsWith("#/")
    )
      return;
  } catch {}
  issue(issues, path, "must be a strict tauri.localhost hash route");
}

function assertCdpTargetId(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{8,256}$/.test(value))
    issue(issues, path, "must be a non-empty CDP target id");
}

function assertVisualChallenge(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  if (!assertExactKeys(value, ["token", "colorRgb", "region"], path, issues))
    return;
  const record = value as Record<string, unknown>;
  if (
    typeof record.token !== "string" ||
    !/^[a-f0-9]{32,128}$/.test(record.token)
  )
    issue(
      issues,
      `${path}.token`,
      "must be a high-entropy visual challenge token",
    );
  if (
    !Array.isArray(record.colorRgb) ||
    (record.colorRgb as unknown[]).length !== 3 ||
    (record.colorRgb as unknown[]).some(
      (component) =>
        !Number.isInteger(component) ||
        (component as number) < 0 ||
        (component as number) > 255,
    ) ||
    (record.colorRgb as unknown[]).every((component) => component === 0)
  )
    issue(issues, `${path}.colorRgb`, "must be a non-black RGB triplet");
  if (
    !assertExactKeys(
      record.region,
      ["x", "y", "width", "height"],
      `${path}.region`,
      issues,
    )
  )
    return;
  const region = record.region as Record<string, unknown>;
  for (const key of ["x", "y", "width", "height"])
    if (!Number.isInteger(region[key]))
      issue(issues, `${path}.region.${key}`, "must be an integer");
  if (
    (region.x as number) < 0 ||
    (region.y as number) < 0 ||
    (region.width as number) < 8 ||
    (region.height as number) < 8 ||
    (region.x as number) + (region.width as number) > 1080 ||
    (region.y as number) + (region.height as number) > 1920
  )
    issue(
      issues,
      `${path}.region`,
      "must remain inside the 1080x1920 foreground framebuffer",
    );
}

function assertDisplayCaptureRequest(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  if (
    !assertExactKeys(
      value,
      ["activeKioskSession", "tauriRoute", "cdpTargetId", "visualChallenge"],
      path,
      issues,
    )
  )
    return;
  const record = value as Record<string, unknown>;
  assertActiveKioskSession(
    record.activeKioskSession,
    `${path}.activeKioskSession`,
    issues,
  );
  assertTauriRoute(record.tauriRoute, `${path}.tauriRoute`, issues);
  assertCdpTargetId(record.cdpTargetId, `${path}.cdpTargetId`, issues);
  assertVisualChallenge(
    record.visualChallenge,
    `${path}.visualChallenge`,
    issues,
  );
}

function assertAudioCaptureRequest(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  if (
    !assertExactKeys(
      value,
      ["schemaVersion", "activeKioskSession", "daemonCalibration", "threshold"],
      path,
      issues,
    )
  )
    return;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== "vm-default-audio-capture-request/v2")
    issue(
      issues,
      `${path}.schemaVersion`,
      "must be vm-default-audio-capture-request/v2",
    );
  assertActiveKioskSession(
    record.activeKioskSession,
    `${path}.activeKioskSession`,
    issues,
  );
  if (
    assertExactKeys(
      record.daemonCalibration,
      ["source", "command", "challenge"],
      `${path}.daemonCalibration`,
      issues,
    )
  ) {
    const calibration = record.daemonCalibration as Record<string, unknown>;
    if (calibration.source !== "vending_daemon_ipc")
      issue(
        issues,
        `${path}.daemonCalibration.source`,
        "must require the daemon IPC audio path",
      );
    if (calibration.command !== "audio_output_calibration")
      issue(
        issues,
        `${path}.daemonCalibration.command`,
        "must use the daemon calibration command",
      );
    if (
      typeof calibration.challenge !== "string" ||
      !/^[a-f0-9]{32,128}$/.test(calibration.challenge)
    )
      issue(
        issues,
        `${path}.daemonCalibration.challenge`,
        "must be a high-entropy cue challenge",
      );
  }
  if (
    assertExactKeys(
      record.threshold,
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
    const threshold = record.threshold as Record<string, unknown>;
    for (const key of [
      "minimumPeakAbsoluteSample",
      "minimumNonSilentFrames",
      "minimumDurationMs",
      "minimumDistinctNonSilentSampleMagnitudes",
    ]) {
      if (
        !Number.isInteger(threshold[key]) ||
        (threshold[key] as number) <= 0
      )
        issue(issues, `${path}.threshold.${key}`, "must be a positive integer");
    }
  }
}

function assertAudioCaptureResult(
  value: unknown,
  request: Record<string, unknown>,
  report: Record<string, unknown>,
  issues: Array<{ path: string; message: string }>,
): void {
  const path = "report.defaultAudioCapture";
  const record = value as Record<string, unknown>;
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
        "defaultOutput",
        "daemonCalibration",
        "capture",
      ],
      path,
      issues,
    )
  )
    return;
  const captureOperationReference = record.captureOperationReference;
  const audioCapture = request.audioCapture as
    | Record<string, unknown>
    | undefined;
  const requestedActiveKioskSession = audioCapture?.activeKioskSession;
  const requestedCalibration = audioCapture?.daemonCalibration as
    | Record<string, unknown>
    | undefined;
  const requestedThreshold = audioCapture?.threshold;
  const defaultOutput = record.defaultOutput as Record<string, unknown>;
  const daemonCalibration = record.daemonCalibration as Record<string, unknown>;
  const capture = record.capture as Record<string, unknown>;
  const captureThreshold = capture.threshold as
    | Record<string, unknown>
    | undefined;
  const reportEvidence = (report.evidence as unknown[] | undefined) ?? [];
  const reportAdapter = report.adapter as Record<string, unknown> | undefined;
  if (record.schemaVersion !== "vm-default-audio-capture-result/v2")
    issue(
      issues,
      `${path}.schemaVersion`,
      "must be vm-default-audio-capture-result/v2",
    );
  if (record.runId !== request.runId)
    issue(issues, `${path}.runId`, "must bind the adapter run identity");
  if (record.lifecycleReference !== request.lifecycleReference)
    issue(
      issues,
      `${path}.lifecycleReference`,
      "must bind the active overlay lifecycle",
    );
  if (captureOperationReference !== request.operationReference)
    issue(
      issues,
      `${path}.captureOperationReference`,
      "must bind the capture operation",
    );
  assertActiveKioskSession(
    record.activeKioskSession,
    `${path}.activeKioskSession`,
    issues,
  );
  if (
    JSON.stringify(record.activeKioskSession) !==
    JSON.stringify(requestedActiveKioskSession)
  )
    issue(
      issues,
      `${path}.activeKioskSession`,
      "must match the requested active kiosk session",
    );
  if (
    !assertExactKeys(
      defaultOutput,
      ["status"],
      `${path}.defaultOutput`,
      issues,
    )
  ) {
    return;
  }
  if (defaultOutput.status !== "active")
    issue(
      issues,
      `${path}.defaultOutput.status`,
      "must attest the active Windows default output",
    );
  if (
    assertExactKeys(
      daemonCalibration,
      [
        "status",
        "source",
        "command",
        "challenge",
        "responseArtifact",
        "responseDigest",
        "responseFileName",
        "startedAt",
        "completedAt",
      ],
      `${path}.daemonCalibration`,
      issues,
    )
  ) {
    if (daemonCalibration.status !== "completed")
      issue(
        issues,
        `${path}.daemonCalibration.status`,
        "must attest a completed daemon calibration",
      );
    if (
      daemonCalibration.source !==
        requestedCalibration?.source ||
      daemonCalibration.command !==
        requestedCalibration?.command ||
      daemonCalibration.challenge !==
        requestedCalibration?.challenge
    )
      issue(
        issues,
        `${path}.daemonCalibration`,
        "must match the requested daemon calibration",
      );
    assertTimestamp(
      daemonCalibration.startedAt,
      `${path}.daemonCalibration.startedAt`,
      issues,
    );
    assertTimestamp(
      daemonCalibration.completedAt,
      `${path}.daemonCalibration.completedAt`,
      issues,
    );
    if (
      !EVIDENCE_IDENTITY.test(
        String(daemonCalibration.responseArtifact ?? ""),
      ) ||
      !SHA256_DIGEST.test(String(daemonCalibration.responseDigest ?? "")) ||
      daemonCalibration.responseArtifact !==
        `runtime-evidence://${String(
          daemonCalibration.responseDigest ?? "",
        ).replace(":", "/")}`
    )
      issue(
        issues,
        `${path}.daemonCalibration.responseArtifact`,
        "must bind the separately persisted raw daemon response",
      );
    const responseEvidence = reportEvidence.find(
      (entry) =>
        (entry as Record<string, unknown>)?.role ===
        "daemon-audio-calibration-response",
    ) as Record<string, unknown> | undefined;
    if (
      daemonCalibration.responseArtifact !== responseEvidence?.identity ||
      daemonCalibration.responseDigest !== responseEvidence?.digest ||
      daemonCalibration.responseFileName !== responseEvidence?.fileName
    )
      issue(
        issues,
        `${path}.daemonCalibration`,
        "must reference the runner-exported raw daemon response evidence",
      );
  }
  if (
    !assertExactKeys(
      capture,
      [
        "source",
        "adapterIdentity",
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
  if (!AUDIO_CAPTURE_SOURCE.test(String(capture.source ?? "")))
    issue(
      issues,
      `${path}.capture.source`,
      "must be a non-empty, lowercase hyphenated capture source",
    );
  if (capture.adapterIdentity !== reportAdapter?.identity)
    issue(
      issues,
      `${path}.capture.adapterIdentity`,
      "must bind the capture to the reporting host adapter",
    );
  if (
    capture.artifact !==
    (reportEvidence[0] as Record<string, unknown> | undefined)?.identity
  )
    issue(
      issues,
      `${path}.capture.artifact`,
      "must bind the exported default-audio-capture evidence artifact",
    );
  if (capture.format !== "wav_pcm")
    issue(issues, `${path}.capture.format`, "must be wav_pcm");
  if (!AUDIO_ENCODING.has(String(capture.encoding)))
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
    if (!Number.isInteger(capture[key]) || (capture[key] as number) < minimum)
      issue(
        issues,
        `${path}.capture.${key}`,
        "must be a valid PCM measurement",
      );
  }
  if (
    !Number.isFinite(capture.durationMs) ||
    (capture.durationMs as number) <= 0
  )
    issue(
      issues,
      `${path}.capture.durationMs`,
      "must be a positive finite PCM duration",
    );
  if (
    JSON.stringify(captureThreshold) !==
    JSON.stringify(requestedThreshold)
  )
    issue(
      issues,
      `${path}.capture.threshold`,
      "must use the requested non-silence threshold",
    );
  if (
    (capture.nonSilentFrameCount as number) <
      Number(captureThreshold?.minimumNonSilentFrames) ||
    (capture.peakAbsoluteSample as number) <
      Number(captureThreshold?.minimumPeakAbsoluteSample) ||
    (capture.durationMs as number) <
      Number(captureThreshold?.minimumDurationMs) ||
    (capture.distinctNonSilentSampleMagnitudes as number) <
      Number(captureThreshold?.minimumDistinctNonSilentSampleMagnitudes)
  )
    issue(
      issues,
      `${path}.capture`,
      "must contain non-silent frames above the declared threshold",
    );
  assertTimestamp(capture.startedAt, `${path}.capture.startedAt`, issues);
  assertTimestamp(
    capture.completedAt,
    `${path}.capture.completedAt`,
    issues,
  );
  const started = Date.parse(String(capture.startedAt ?? ""));
  const calibrationStarted = Date.parse(
    String(daemonCalibration?.startedAt ?? ""),
  );
  const calibrationCompleted = Date.parse(
    String(daemonCalibration?.completedAt ?? ""),
  );
  const completed = Date.parse(String(capture.completedAt ?? ""));
  if (
    Number.isFinite(started) &&
    Number.isFinite(calibrationStarted) &&
    Number.isFinite(calibrationCompleted) &&
    Number.isFinite(completed) &&
    !(
      started <= calibrationStarted &&
      calibrationStarted <= calibrationCompleted &&
      calibrationCompleted <= completed
    )
  )
    issue(
      issues,
      path,
      "must capture the completed daemon calibration within one synchronized PCM interval",
    );
}

function assertDisplayCaptureResult(
  value: unknown,
  request: Record<string, unknown>,
  report: Record<string, unknown>,
  issues: Array<{ path: string; message: string }>,
): void {
  const path = "report.displayCapture";
  const record = value as Record<string, unknown>;
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
        "cdpTargetId",
        "foregroundKiosk",
        "cdpProbe",
        "visualChallenge",
        "capture",
      ],
      path,
      issues,
    )
  )
    return;
  const captureOperationReference = record.captureOperationReference;
  const displayCapture = request.displayCapture as
    | Record<string, unknown>
    | undefined;
  const foregroundKiosk = record.foregroundKiosk as Record<string, unknown>;
  const cdpProbe = record.cdpProbe as Record<string, unknown>;
  const visualChallenge = record.visualChallenge as Record<string, unknown>;
  const capture = record.capture as Record<string, unknown>;
  const visualChallengeRegion = visualChallenge.region as
    | Record<string, unknown>
    | undefined;
  const reportEvidence = (report.evidence as unknown[] | undefined) ?? [];
  const reportAdapter = report.adapter as Record<string, unknown> | undefined;
  if (record.schemaVersion !== "vm-display-capture-result/v1")
    issue(
      issues,
      `${path}.schemaVersion`,
      "must be vm-display-capture-result/v1",
    );
  if (record.runId !== request.runId)
    issue(issues, `${path}.runId`, "must bind the adapter run identity");
  if (record.lifecycleReference !== request.lifecycleReference)
    issue(
      issues,
      `${path}.lifecycleReference`,
      "must bind the active overlay lifecycle",
    );
  if (captureOperationReference !== request.operationReference)
    issue(
      issues,
      `${path}.captureOperationReference`,
      "must bind the capture operation",
    );
  assertActiveKioskSession(
    record.activeKioskSession,
    `${path}.activeKioskSession`,
    issues,
  );
  if (
    JSON.stringify(record.activeKioskSession) !==
    JSON.stringify(displayCapture?.activeKioskSession)
  )
    issue(
      issues,
      `${path}.activeKioskSession`,
      "must match the requested active kiosk session",
    );
  assertTauriRoute(record.tauriRoute, `${path}.tauriRoute`, issues);
  if (record.tauriRoute !== displayCapture?.tauriRoute)
    issue(issues, `${path}.tauriRoute`, "must bind the requested kiosk route");
  assertCdpTargetId(record.cdpTargetId, `${path}.cdpTargetId`, issues);
  if (record.cdpTargetId !== displayCapture?.cdpTargetId)
    issue(issues, `${path}.cdpTargetId`, "must bind the requested CDP target");
  if (
    assertExactKeys(
      foregroundKiosk,
      ["activeKioskSession", "tauriRoute", "cdpTargetId", "visible"],
      `${path}.foregroundKiosk`,
      issues,
    )
  ) {
    if (
      JSON.stringify(foregroundKiosk.activeKioskSession) !==
        JSON.stringify(displayCapture?.activeKioskSession) ||
      foregroundKiosk.tauriRoute !== displayCapture?.tauriRoute ||
      foregroundKiosk.cdpTargetId !==
        displayCapture?.cdpTargetId ||
      foregroundKiosk.visible !== true
    )
      issue(
        issues,
        `${path}.foregroundKiosk`,
        "must prove the requested kiosk session, route, and CDP target are foreground-visible",
      );
  }
  if (
    assertExactKeys(
      cdpProbe,
      [
        "endpoint",
        "targetId",
        "targetUrl",
        "appVisible",
        "appTextLength",
        "domNodeCount",
        "challengeToken",
      ],
      `${path}.cdpProbe`,
      issues,
    )
  ) {
    if (cdpProbe.endpoint !== "http://127.0.0.1:9222/json")
      issue(
        issues,
        `${path}.cdpProbe.endpoint`,
        "must use the local WebView CDP endpoint",
      );
    if (cdpProbe.targetUrl !== record.tauriRoute)
      issue(
        issues,
        `${path}.cdpProbe.targetUrl`,
        "must bind the captured route",
      );
    if (cdpProbe.targetId !== record.cdpTargetId)
      issue(
        issues,
        `${path}.cdpProbe.targetId`,
        "must bind the foreground CDP target",
      );
    if (cdpProbe.appVisible !== true)
      issue(
        issues,
        `${path}.cdpProbe.appVisible`,
        "must prove #app is visible",
      );
    for (const key of ["appTextLength", "domNodeCount"])
      if (
        !Number.isInteger(cdpProbe[key]) ||
        (cdpProbe[key] as number) < 1
      )
        issue(
          issues,
          `${path}.cdpProbe.${key}`,
          "must prove a non-empty #app DOM",
        );
  }
  if (
    assertExactKeys(
      visualChallenge,
      ["token", "colorRgb", "region", "matchingPixelCount"],
      `${path}.visualChallenge`,
      issues,
    )
  ) {
    assertVisualChallenge(
      {
        token: visualChallenge.token,
        colorRgb: visualChallenge.colorRgb,
        region: visualChallengeRegion,
      },
      `${path}.visualChallenge`,
      issues,
    );
    if (
      JSON.stringify({
        token: visualChallenge.token,
        colorRgb: visualChallenge.colorRgb,
        region: visualChallengeRegion,
      }) !== JSON.stringify(displayCapture?.visualChallenge)
    )
      issue(
        issues,
        `${path}.visualChallenge`,
        "must bind the requested visual challenge",
      );
    const requiredPixels =
      Number(visualChallengeRegion?.width) *
      Number(visualChallengeRegion?.height);
    if (
      !Number.isInteger(visualChallenge.matchingPixelCount) ||
      visualChallenge.matchingPixelCount !== requiredPixels
    )
      issue(
        issues,
        `${path}.visualChallenge.matchingPixelCount`,
        "must prove every requested challenge pixel was visible in the framebuffer",
      );
    if (cdpProbe?.challengeToken !== visualChallenge.token)
      issue(
        issues,
        `${path}.cdpProbe.challengeToken`,
        "must prove the CDP target observed the visual challenge token",
      );
  }
  if (
    !assertExactKeys(
      capture,
      [
        "source",
        "adapterIdentity",
        "artifact",
        "format",
        "widthPx",
        "heightPx",
        "pixelCount",
        "nonTransparentPixelCount",
        "nonTransparentPixelRatio",
        "distinctPixelCount",
      ],
      `${path}.capture`,
      issues,
    )
  )
    return;
  const expectedDisplaySource =
    reportAdapter?.identity === "vm-host-adapter://deterministic-fake@1.0.0"
      ? "contract-test-generated-png"
      : "platform-framebuffer";
  if (capture.source !== expectedDisplaySource)
    issue(
      issues,
      `${path}.capture.source`,
      `must be ${expectedDisplaySource} for this adapter`,
    );
  if (capture.adapterIdentity !== reportAdapter?.identity)
    issue(
      issues,
      `${path}.capture.adapterIdentity`,
      "must bind the capture to the reporting host adapter",
    );
  if (
    capture.artifact !==
    (reportEvidence[0] as Record<string, unknown> | undefined)?.identity
  )
    issue(
      issues,
      `${path}.capture.artifact`,
      "must bind the exported display-capture evidence artifact",
    );
  if (capture.format !== "png")
    issue(issues, `${path}.capture.format`, "must be png");
  for (const key of [
    "widthPx",
    "heightPx",
    "pixelCount",
    "nonTransparentPixelCount",
    "distinctPixelCount",
  ]) {
    if (!Number.isInteger(capture[key]) || (capture[key] as number) < 1)
      issue(
        issues,
        `${path}.capture.${key}`,
        "must be a positive decoded PNG measurement",
      );
  }
  if (capture.widthPx !== 1080 || capture.heightPx !== 1920)
    issue(
      issues,
      `${path}.capture`,
      "must be an exact 1080x1920 kiosk framebuffer capture",
    );
  if (
    !Number.isFinite(capture.nonTransparentPixelRatio) ||
    (capture.nonTransparentPixelRatio as number) < 0.95 ||
    (capture.nonTransparentPixelRatio as number) > 1 ||
    capture.nonTransparentPixelRatio !==
      (capture.nonTransparentPixelCount as number) /
        (capture.pixelCount as number)
  )
    issue(
      issues,
      `${path}.capture.nonTransparentPixelRatio`,
      "must prove at least 95% decoded non-transparent framebuffer content",
    );
  if ((capture.distinctPixelCount as number) < 256)
    issue(
      issues,
      `${path}.capture.distinctPixelCount`,
      "must prove non-trivial framebuffer visual complexity",
    );
}

function assertCleanupObservation(
  observed: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  if (
    !assertExactKeys(
      observed,
      ["overlay", "runDirectory", "bootstrapMedia"],
      path,
      issues,
    )
  )
    return;
  const record = observed as Record<string, unknown>;
  for (const key of ["overlay", "runDirectory"]) {
    if (
      !new Set(["present", "removed", "unknown"]).has(
        String(record[key] ?? ""),
      )
    )
      issue(issues, `${path}.${key}`, "must be a supported observed state");
  }
  if (
    !new Set(["not-mounted", "mounted", "removed", "unknown"]).has(
      String(record.bootstrapMedia ?? ""),
    )
  )
    issue(
      issues,
      `${path}.bootstrapMedia`,
      "must be a supported observed state",
    );
}

function isPostCleanupIdempotentCapture(
  request: Record<string, unknown>,
  report: Record<string, unknown>,
): boolean {
  const cleanup = report.cleanup as Record<string, unknown> | undefined;
  const observed = cleanup?.observed as Record<string, unknown> | undefined;
  return (
    request.operation === "capture-approved-base" &&
    report.result === "succeeded" &&
    cleanup?.status === "completed" &&
    cleanup?.overlayDisposition === "removed" &&
    observed?.overlay === "removed" &&
    observed?.runDirectory === "removed" &&
    observed?.bootstrapMedia === "removed"
  );
}

function assertSanitizedDiagnostic(
  diagnostic: unknown,
  index: number,
  issues: Array<{ path: string; message: string }>,
  pathPrefix = "report.diagnostics",
): void {
  const path = `${pathPrefix}[${index}]`;
  if (!assertExactKeys(diagnostic, ["code"], path, issues)) return;
  const record = diagnostic as Record<string, unknown>;
  if (!SANITIZED_DIAGNOSTIC_CODES.has(String(record.code)))
    issue(
      issues,
      `${path}.code`,
      "must be an allowlisted sanitized diagnostic code",
    );
}

function requestEcho(request: Record<string, unknown>): Record<string, unknown> {
  const target = request.target as Record<string, unknown>;
  return {
    contractVersion: request.contractVersion,
    runId: request.runId,
    operation: request.operation,
    operationNonce: request.operationNonce,
    operationReference: request.operationReference,
    lifecycleReference: request.lifecycleReference,
    cancelOperationReference: request.cancelOperationReference,
    targetIdentity: target.identity,
    displayCapture: request.displayCapture,
    audioCapture: request.audioCapture,
    requestedCapabilities: [
      ...(request.requestedCapabilities as unknown[] | undefined ?? []),
    ],
    ...(isV2Request(request) ? { serialSession: request.serialSession } : {}),
  };
}

function reconstructRequest(
  request: Record<string, unknown>,
): Record<string, unknown> {
  const target = request.target as Record<string, unknown> | undefined;
  const assets = request.assets as unknown[] | undefined;
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
    target: { identity: target?.identity },
    displayCapture: request.displayCapture,
    audioCapture: request.audioCapture,
    assets: assets?.map((asset) => {
      const record = asset as Record<string, unknown>;
      return {
        role: record?.role,
        identity: record?.identity,
        digest: record?.digest,
      };
    }),
    requestedCapabilities: [
      ...((request.requestedCapabilities as unknown[] | undefined) ?? []),
    ],
    ...(isV2Request(request) ? { serialSession: request.serialSession } : {}),
  };
}

function lifecycleSourceAsset(
  request: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const assets = (request.assets as Array<Record<string, unknown>> | undefined) ?? [];
  if (
    request.operation === "clean-install" ||
    request.operation === "capture-approved-base"
  )
    return assets.find((asset) => asset.role === "runtime-image");
  if (["cleanup", "cancel"].includes(String(request.operation)))
    return (
      assets.find((asset) => asset.role === "runtime-image") ??
      assets.find((asset) => asset.role === "approved-runtime-base")
    );
  return assets.find((asset) => asset.role === "approved-runtime-base");
}

export function validateVmHostAdapterRequest(
  input: unknown,
): Record<string, unknown> {
  const request = structuredClone(input) as Record<string, unknown>;
  const issues: Array<{ path: string; message: string }> = [];
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
  if (!VM_HOST_ADAPTER_OPERATIONS.has(String(request.operation)))
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
    !OPERATION_REFERENCE.test(String(request.operationReference ?? ""))
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
    const target = request.target as Record<string, unknown>;
    if (
      typeof target.identity !== "string" ||
      !TARGET_IDENTITY.test(target.identity)
    )
      issue(
        issues,
        "request.target.identity",
        "must be a logical VM target identity",
      );
    else
      assertNoHostReference(
        target.identity,
        "request.target.identity",
        issues,
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
  const assets = request.assets as unknown[] | undefined;
  if (!Array.isArray(assets) || assets.length === 0)
    issue(issues, "request.assets", "must contain immutable operation assets");
  else {
    const assetRecords = assets as Array<Record<string, unknown>>;
    assetRecords.forEach((asset: unknown, index: number) =>
      assertAsset(asset, index, issues),
    );
    assertUniqueRoles(assetRecords, "request.assets", issues);
    if (["cleanup", "cancel"].includes(String(request.operation))) {
      const base = assetRecords.find(
        (asset) => asset.role === "approved-runtime-base",
      );
      const runtimeImage = assetRecords.find(
        (asset) => asset.role === "runtime-image",
      );
      if (
        base &&
        runtimeImage &&
        (base.identity !== runtimeImage.identity ||
          base.digest !== runtimeImage.digest)
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
    (request.requestedCapabilities as unknown[]).length === 0
  )
    issue(
      issues,
      "request.requestedCapabilities",
      "must contain requested capabilities",
    );
  else {
    const seen = new Set<unknown>();
    (request.requestedCapabilities as unknown[]).forEach(
      (capability: unknown, index: number) => {
      if (!VM_HOST_ADAPTER_CAPABILITIES.has(String(capability)))
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
      },
    );
    const requiredCapability =
      REQUIRED_CAPABILITY_BY_OPERATION[String(request.operation)];
    if (requiredCapability && !seen.has(requiredCapability))
      issue(
        issues,
        "request.requestedCapabilities",
        `must include ${requiredCapability}`,
      );
    for (const capability of REQUIRED_CAPABILITIES_BY_SERIAL_OPERATION[
      String(request.operation)
    ] ?? [])
      if (!seen.has(capability))
        issue(
          issues,
          "request.requestedCapabilities",
          `must include ${capability}`,
        );
  }
  const requiredRoles =
    REQUIRED_ASSET_ROLES_BY_OPERATION[String(request.operation)] ?? [];
  const hasRequiredRole =
    request.operation === "cleanup" || request.operation === "cancel"
      ? requiredRoles.some((role) =>
          (assets as Array<Record<string, unknown>> | undefined)?.some(
            (asset) => asset?.role === role,
          ),
        )
      : requiredRoles.every((role) =>
          (assets as Array<Record<string, unknown>> | undefined)?.some(
            (asset) => asset?.role === role,
          ),
        );
  if (!hasRequiredRole) {
    for (const role of requiredRoles) {
      if (
        (assets as Array<Record<string, unknown>> | undefined)?.some(
          (asset) => asset?.role === role,
        )
      )
        continue;
      issue(issues, "request.assets", `must include ${role}`);
      if (request.operation === "cleanup" || request.operation === "cancel")
        break;
    }
  }
  if (issues.length > 0) throw new VmHostAdapterContractError(issues);
  return reconstructRequest(request);
}

export function createVmHostAdapterRequest(
  input: unknown,
): Record<string, unknown> {
  return validateVmHostAdapterRequest(input);
}

export function validateVmHostAdapterReport(
  input: unknown,
  requestInput: unknown,
): Record<string, unknown> {
  const report = structuredClone(input) as Record<string, unknown>;
  const request = validateVmHostAdapterRequest(requestInput);
  const issues: Array<{ path: string; message: string }> = [];
  const adapter = report.adapter as Record<string, unknown>;
  const requestEchoValue = report.request as Record<string, unknown>;
  const observed = report.observed as Record<string, unknown>;
  const guest = report.guest as Record<string, unknown>;
  const timestamps = report.timestamps as Record<string, unknown>;
  const cleanup = report.cleanup as Record<string, unknown>;
  const negotiatedCapabilities = report.negotiatedCapabilities as unknown[];
  const completedOperations = report.completedOperations as unknown[];
  const consumedAssets = report.consumedAssets as unknown[];
  const evidence = report.evidence as unknown[];
  const diagnostics = report.diagnostics as unknown[];
  const serialSession = report.serialSession as Record<string, unknown> | null;
  const serialEvidence = report.serialEvidence as Record<string, unknown> | null;
  const displayCapture = report.displayCapture as Record<string, unknown> | null;
  const defaultAudioCapture = report.defaultAudioCapture as
    | Record<string, unknown>
    | null;
  const requestAssets = (request.assets as unknown[] | undefined) ?? [];
  const requestedCapabilities =
    (request.requestedCapabilities as unknown[] | undefined) ?? [];
  const requestTargetIdentity = (request.target as Record<string, unknown>)
    .identity;
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
      adapter,
      ["identity", "version", "contractVersion"],
      "adapter",
      issues,
    )
  ) {
    assertLogicalIdentity(
      adapter.identity,
      "adapter.identity",
      issues,
    );
    if (
      typeof adapter.version !== "string" ||
      !SEMVER.test(adapter.version)
    )
      issue(
        issues,
        "adapter.version",
        "must be a strict semantic version",
      );
    if (adapter.contractVersion !== CONTRACT_VERSION)
      issue(
        issues,
        "adapter.contractVersion",
        `must be ${CONTRACT_VERSION}`,
      );
  }
  if (
    assertExactKeys(
      requestEchoValue,
      [
        "contractVersion",
        "runId",
        "operation",
        "operationNonce",
        "operationReference",
        "lifecycleReference",
        "cancelOperationReference",
        "targetIdentity",
        "displayCapture",
        "audioCapture",
        "requestedCapabilities",
        ...(isV2Request(request) ? ["serialSession"] : []),
      ],
      "requestEchoValue",
      issues,
    )
  ) {
    for (const [key, expected] of Object.entries(requestEcho(request))) {
      if (JSON.stringify(requestEchoValue[key]) !== JSON.stringify(expected))
        issue(issues, `requestEchoValue.${key}`, "does not match request");
    }
  }
  if (!TERMINAL_RESULTS.has(String(report.result)))
    issue(issues, "report.result", "must be a supported terminal result");
  if (!Array.isArray(negotiatedCapabilities))
    issue(issues, "negotiatedCapabilities", "must be an array");
  else {
    const requested = new Set(requestedCapabilities);
    const seen = new Set();
    negotiatedCapabilities.forEach((capability, index) => {
      if (!requested.has(capability))
        issue(
          issues,
          `negotiatedCapabilities[${index}]`,
          "was not requested",
        );
      if (seen.has(capability))
        issue(
          issues,
          `negotiatedCapabilities[${index}]`,
          "must not be duplicated",
        );
      seen.add(capability);
    });
    if (
      report.result === "succeeded" &&
      !seen.has(REQUIRED_CAPABILITY_BY_OPERATION[String(request.operation)])
    )
      issue(
        issues,
        "negotiatedCapabilities",
        "must include the completed operation capability",
      );
    if (
      report.result === "succeeded" &&
      requestedCapabilities.some((capability) => !seen.has(capability))
    )
      issue(
        issues,
        "negotiatedCapabilities",
        "must include the complete requested capability set for a successful operation",
      );
  }
  if (!Array.isArray(completedOperations))
    issue(issues, "completedOperations", "must be an array");
  else if (
    report.result === "succeeded" &&
    !sameValues(completedOperations, [request.operation])
  )
    issue(
      issues,
      "completedOperations",
      "must contain only the requested completed operation",
    );
  else if (
    report.result !== "succeeded" &&
    completedOperations.length !== 0
  )
    issue(
      issues,
      "completedOperations",
      "must be empty when the operation did not succeed",
    );
  if (
    assertExactKeys(
      observed,
      [
        "vmIdentity",
        "targetBinding",
        "baseIdentity",
        "overlayIdentity",
        "firmwareMode",
      ],
      "observed",
      issues,
    )
  ) {
    assertLogicalIdentity(
      observed.vmIdentity,
      "observed.vmIdentity",
      issues,
    );
    assertLogicalIdentity(
      observed.baseIdentity,
      "observed.baseIdentity",
      issues,
    );
    assertLogicalIdentity(
      observed.overlayIdentity,
      "observed.overlayIdentity",
      issues,
    );
    if (
      assertExactKeys(
        observed.targetBinding,
        ["relation", "targetIdentity"],
        "observed.targetBinding",
        issues,
      )
    ) {
      const targetBinding = observed.targetBinding as Record<string, unknown>;
      if (targetBinding.relation !== "host-target-mapping/v1")
        issue(
          issues,
          "observed.targetBinding.relation",
          "must attest the documented host target mapping",
        );
      if (
        targetBinding.targetIdentity !== requestTargetIdentity
      )
        issue(
          issues,
          "observed.targetBinding.targetIdentity",
          "does not bind the observed VM to the requested target",
        );
    }
    const observedSource = lifecycleSourceAsset(request);
    if (
      observedSource &&
      request.operation !== "capture-approved-base" &&
      observed.baseIdentity !== observedSource.identity
    )
      issue(
        issues,
        "observed.baseIdentity",
        "does not match the requested operation source asset",
      );
    if (!new Set(["bios", "uefi"]).has(String(observed.firmwareMode)))
      issue(issues, "observed.firmwareMode", "must attest bios or uefi");
  }
  if (!Array.isArray(consumedAssets))
    issue(issues, "consumedAssets", "must be an array");
  else {
    consumedAssets.forEach((asset: unknown, index: number) =>
      assertAsset(asset, index, issues, "consumedAssets"),
    );
    assertUniqueRoles(
      consumedAssets as Array<Record<string, unknown>>,
      "consumedAssets",
      issues,
    );
    if (!sameAssets(consumedAssets, requestAssets))
      issue(
        issues,
        "consumedAssets",
        "must exactly match requested immutable assets",
      );
  }
  if (
    assertExactKeys(
      guest,
      ["deviceMappings", "defaultAudioIdentity"],
      "guest",
      issues,
    )
  ) {
    assertLogicalIdentity(
      guest.defaultAudioIdentity,
      "guest.defaultAudioIdentity",
      issues,
    );
    if (!Array.isArray(guest.deviceMappings))
      issue(issues, "guest.deviceMappings", "must be an array");
    else {
      guest.deviceMappings.forEach((mapping, index) => {
        const path = `guest.deviceMappings[${index}]`;
        if (
          !assertExactKeys(
            mapping,
            ["role", "guestDeviceIdentity", "guestUsbTopology"],
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
        assertGuestUsbTopology(
          mapping.guestUsbTopology,
          `${path}.guestUsbTopology`,
          issues,
        );
      });
      assertUniqueRoles(
        guest.deviceMappings,
        "guest.deviceMappings",
        issues,
      );
      const mappings = new Set(
        guest.deviceMappings.map((mapping) => mapping?.role),
      );
      for (const [capability, role] of [
        ["serial:lower-controller", "lower-controller"],
        ["serial:scanner", "scanner"],
      ]) {
        if (
          report.result === "succeeded" &&
          requestedCapabilities.includes(capability) &&
          !mappings.has(role)
        )
          issue(issues, "guest.deviceMappings", `must include ${role}`);
      }
    }
  }
  assertSerialSessionReport(report, request, issues);
  assertSerialEvidence(report, request, issues);
  if (!Array.isArray(evidence))
    issue(issues, "evidence", "must be an array");
  else {
    evidence.forEach((entry: unknown, index: number) => {
      const entryRecord = entry as Record<string, unknown>;
      const path = `evidence[${index}]`;
      const entryKeys =
        entryRecord?.role === "display-capture" ||
        entryRecord?.role === "default-audio-capture" ||
        entryRecord?.role === "daemon-audio-calibration-response"
          ? ["role", "identity", "digest", "fileName"]
          : ["role", "identity", "digest"];
      if (!assertExactKeys(entryRecord, entryKeys, path, issues)) return;
      if (
        !new Set([
          "display-capture",
          "default-audio-capture",
          "daemon-audio-calibration-response",
        ]).has(String(entryRecord.role))
      )
        issue(issues, `${path}.role`, "must be a supported evidence role");
      const identity =
        typeof entryRecord.identity === "string"
          ? entryRecord.identity.match(EVIDENCE_IDENTITY)
          : null;
      if (!identity)
        issue(
          issues,
          `${path}.identity`,
          "must be a content-addressed evidence identity",
        );
      if (
        typeof entryRecord.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(entryRecord.digest)
      )
        issue(issues, `${path}.digest`, "must be a lowercase SHA-256 digest");
      else if (identity && identity[1] !== entryRecord.digest.slice(7))
        issue(issues, path, "identity and digest must name the same evidence");
      if (
        entryRecord.role === "display-capture" ||
        entryRecord.role === "default-audio-capture" ||
        entryRecord.role === "daemon-audio-calibration-response"
      ) {
        const expectedFileName = `${String(entryRecord.digest ?? "").slice(7)}.`;
        const extension =
          entryRecord.role === "display-capture"
            ? "png"
            : entryRecord.role === "default-audio-capture"
              ? "wav"
              : "json";
        if (
          typeof entryRecord.fileName !== "string" ||
          !new RegExp(`^[a-f0-9]{64}\\.${extension}$`).test(
            entryRecord.fileName,
          ) ||
          !entryRecord.fileName.startsWith(expectedFileName)
        )
          issue(
            issues,
            `${path}.fileName`,
            "must be a digest-bound relative evidence file name",
          );
      }
    });
    assertUniqueRoles(
      evidence as Array<Record<string, unknown>>,
      "evidence",
      issues,
    );
    const expectedEvidenceRoles =
      request.operation === "capture-display"
        ? ["display-capture"]
        : request.operation === "capture-default-audio"
          ? ["default-audio-capture", "daemon-audio-calibration-response"]
          : null;
    if (
      expectedEvidenceRoles &&
      report.result === "succeeded" &&
      (!sameValues(
        evidence.map((entry) => (entry as Record<string, unknown>)?.role),
        expectedEvidenceRoles,
      ) ||
        !sameValues(completedOperations, [request.operation]))
    )
      issue(
        issues,
        "evidence",
        "must be produced only by its completed capture operation",
      );
    if (!expectedEvidenceRoles && evidence.length !== 0)
      issue(
        issues,
        "evidence",
        "must be empty before or after non-capture operations",
      );
  }
  if (
    assertExactKeys(
      timestamps,
      ["startedAt", "completedAt"],
      "timestamps",
      issues,
    )
  ) {
    assertTimestamp(
      timestamps.startedAt,
      "timestamps.startedAt",
      issues,
    );
    assertTimestamp(
      timestamps.completedAt,
      "timestamps.completedAt",
      issues,
    );
    if (
      Date.parse(String(timestamps.completedAt ?? "")) <
      Date.parse(String(timestamps.startedAt ?? ""))
    )
      issue(issues, "timestamps", "must be ordered");
  }
  assertDisplayCaptureResult(displayCapture, request, report, issues);
  assertAudioCaptureResult(defaultAudioCapture, request, report, issues);
  if (
    assertExactKeys(
      cleanup,
      ["status", "overlayDisposition", "observed"],
      "cleanup",
      issues,
    )
  ) {
    assertCleanupObservation(
      cleanup.observed,
      "cleanup.observed",
      issues,
    );
    const state = `${cleanup.status}/${cleanup.overlayDisposition}`;
    const cleanupObservedValue = cleanup.observed as
      | Record<string, unknown>
      | undefined;
    const cleaned =
      cleanupObservedValue?.overlay === "removed" &&
      cleanupObservedValue?.runDirectory === "removed" &&
      cleanupObservedValue?.bootstrapMedia === "removed";
    const active =
      cleanupObservedValue?.overlay === "present" &&
      cleanupObservedValue?.runDirectory === "present" &&
      ["not-mounted", "mounted"].includes(
        String(cleanupObservedValue?.bootstrapMedia),
      );
    const completedCaptureAfterCleanup = isPostCleanupIdempotentCapture(
      request,
      report,
    );
    const expected =
      report.result === "failed" ||
      ["cleanup", "cancel"].includes(String(request.operation))
        ? "completed/removed with observed removal"
        : "not-run/active with observed active resources";
    if (
      (report.result === "failed" ||
        ["cleanup", "cancel"].includes(String(request.operation))) &&
      (state !== "completed/removed" || !cleaned)
    )
      issue(
        issues,
        "cleanup",
        `must be ${expected} for this lifecycle operation`,
      );
    if (
      report.result !== "failed" &&
      !["cleanup", "cancel"].includes(String(request.operation)) &&
      !completedCaptureAfterCleanup &&
      (state !== "not-run/active" || !active)
    )
      issue(
        issues,
        "cleanup",
        request.operation === "capture-approved-base"
          ? "must be not-run/active with observed active resources or completed/removed with observed removal for an idempotent capture"
          : `must be ${expected} for this lifecycle operation`,
      );
  }
  if (!Array.isArray(diagnostics))
    issue(issues, "diagnostics", "must be an array");
  else
    diagnostics.forEach((diagnostic: unknown, index: number) =>
      assertSanitizedDiagnostic(diagnostic, index, issues),
    );
  if (issues.length > 0) throw new VmHostAdapterContractError(issues);
  const observedTargetBinding = observed.targetBinding as Record<string, unknown>;
  const cleanupObserved = cleanup.observed as Record<string, unknown>;
  const serialSessionDeviceMappings =
    (serialSession?.deviceMappings as unknown[] | undefined) ?? [];
  const serialSessionScannerAcknowledgement = serialSession
    ?.scannerAcknowledgement as Record<string, unknown> | null | undefined;
  const serialSessionSimulatorCleanup = serialSession
    ?.simulatorCleanup as Record<string, unknown> | null | undefined;
  const serialEvidenceRecords =
    (serialEvidence?.records as unknown[] | undefined) ?? [];
  return {
    contractVersion: report.contractVersion,
    schemaVersion: report.schemaVersion,
    kind: report.kind,
    adapter: {
      identity: adapter.identity,
      version: adapter.version,
      contractVersion: adapter.contractVersion,
    },
    request: requestEcho(request),
    result: report.result,
    negotiatedCapabilities: [...negotiatedCapabilities],
    completedOperations: [...completedOperations],
    observed: {
      vmIdentity: observed.vmIdentity,
      targetBinding: {
        relation: observedTargetBinding.relation,
        targetIdentity: observedTargetBinding.targetIdentity,
      },
      baseIdentity: observed.baseIdentity,
      overlayIdentity: observed.overlayIdentity,
      firmwareMode: observed.firmwareMode,
    },
    consumedAssets: consumedAssets.map((asset) => {
      const assetRecord = asset as Record<string, unknown>;
      return {
        role: assetRecord.role,
        identity: assetRecord.identity,
        digest: assetRecord.digest,
      };
    }),
    guest: {
      deviceMappings: (guest.deviceMappings as unknown[]).map(
        (mapping: unknown) => {
          const mappingRecord = mapping as Record<string, unknown>;
          return {
            role: mappingRecord.role,
            guestDeviceIdentity: mappingRecord.guestDeviceIdentity,
            guestUsbTopology: mappingRecord.guestUsbTopology,
          };
        },
      ),
      defaultAudioIdentity: guest.defaultAudioIdentity,
    },
    evidence: evidence.map((entry) => {
      const entryRecord = entry as Record<string, unknown>;
      return {
        role: entryRecord.role,
        identity: entryRecord.identity,
        digest: entryRecord.digest,
        ...([
          "display-capture",
          "default-audio-capture",
          "daemon-audio-calibration-response",
        ].includes(String(entryRecord.role))
          ? { fileName: entryRecord.fileName }
          : {}),
      };
    }),
    timestamps: {
      startedAt: timestamps.startedAt,
      completedAt: timestamps.completedAt,
    },
    displayCapture: displayCapture,
    defaultAudioCapture: defaultAudioCapture,
    cleanup: {
      status: cleanup.status,
      overlayDisposition: cleanup.overlayDisposition,
      observed: {
        overlay: cleanupObserved.overlay,
        runDirectory: cleanupObserved.runDirectory,
        bootstrapMedia: cleanupObserved.bootstrapMedia,
      },
    },
    diagnostics: diagnostics.map((diagnostic) => ({
      code: (diagnostic as Record<string, unknown>).code,
    })),
    ...(isV2Request(request)
      ? {
          serialSession:
            serialSession === null
              ? null
              : {
                  serialSessionId: serialSession.serialSessionId,
                  sessionBindingToken: serialSession.sessionBindingToken,
                  startOperationReference:
                    serialSession.startOperationReference,
                  deviceMappingDigest: serialSession.deviceMappingDigest,
                  state: serialSession.state,
                  deviceMappings: serialSessionDeviceMappings.map(
                    (mapping: unknown) => {
                      const mappingRecord = mapping as Record<string, unknown>;
                      return {
                        role: mappingRecord.role,
                        guestDeviceIdentity: mappingRecord.guestDeviceIdentity,
                        guestUsbTopology: mappingRecord.guestUsbTopology,
                        simulatorProcessIdentity:
                          mappingRecord.simulatorProcessIdentity,
                        simulatorSocketIdentity:
                          mappingRecord.simulatorSocketIdentity,
                        connectionState: mappingRecord.connectionState,
                      };
                    },
                  ),
                  scannerAcknowledgement:
                    serialSessionScannerAcknowledgement == null
                      ? null
                      : {
                          scannerCodeDigest:
                            serialSessionScannerAcknowledgement
                              .scannerCodeDigest,
                          scannerCodeByteLength:
                            serialSessionScannerAcknowledgement
                              .scannerCodeByteLength,
                          scannerCodeSuffix:
                            serialSessionScannerAcknowledgement
                              .scannerCodeSuffix,
                          accepted:
                            serialSessionScannerAcknowledgement
                              .accepted,
                        },
                  simulatorCleanup:
                    serialSessionSimulatorCleanup == null
                      ? null
                      : {
                          cleanupAttemptCount:
                            serialSessionSimulatorCleanup
                              .cleanupAttemptCount,
                          idempotencyVerified:
                            serialSessionSimulatorCleanup
                              .idempotencyVerified,
                          survivingProcessCount:
                            serialSessionSimulatorCleanup
                              .survivingProcessCount,
                          survivingSocketCount:
                            serialSessionSimulatorCleanup
                              .survivingSocketCount,
                          ...(Object.hasOwn(
                            serialSessionSimulatorCleanup,
                            "termination",
                          )
                            ? {
                                termination:
                                  serialSessionSimulatorCleanup
                                    .termination,
                              }
                            : {}),
                          ...(Object.hasOwn(
                            serialSessionSimulatorCleanup,
                            "errors",
                          )
                            ? {
                                errors:
                                  serialSessionSimulatorCleanup.errors,
                              }
                            : {}),
                        },
                },
          serialEvidence:
            serialEvidence === null
              ? null
              : {
                  serialSessionId: serialEvidence.serialSessionId,
                  sessionBindingToken:
                    serialEvidence.sessionBindingToken,
                  deviceMappingDigest:
                    serialEvidence.deviceMappingDigest,
                  operationEvidence: serialEvidence.operationEvidence,
                  captureChainDigest: serialEvidence.captureChainDigest,
                  records: serialEvidenceRecords.map((record: unknown) => {
                    const recordValue = record as Record<string, unknown>;
                    return {
                      role: recordValue.role,
                      event: recordValue.event,
                      operationNonce: recordValue.operationNonce,
                      sessionBindingToken: recordValue.sessionBindingToken,
                      deviceMappingDigest: recordValue.deviceMappingDigest,
                      scannerCodeDigest: recordValue.scannerCodeDigest,
                      scannerCodeByteLength: recordValue.scannerCodeByteLength,
                      scannerCodeSuffix: recordValue.scannerCodeSuffix,
                      saleCorrelationId: recordValue.saleCorrelationId,
                      saleBinding: recordValue.saleBinding,
                      capturedFrame: recordValue.capturedFrame,
                      captureBindingDigest: recordValue.captureBindingDigest,
                    };
                  }),
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
}: {
  request: unknown;
  result: unknown;
  code: unknown;
  startedAt: unknown;
  completedAt: unknown;
  cleanup: Record<string, unknown> | null | undefined;
  scannerCode?: unknown;
}): Record<string, unknown> {
  const request = validateVmHostAdapterRequest(requestInput);
  const diagnostic: Record<string, unknown> = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    kind: "vm-host-adapter-diagnostic",
    request: requestEcho(request),
    result,
    timestamps: { startedAt, completedAt },
    diagnostics: [{ code }],
    cleanup,
  };
  const issues: Array<{ path: string; message: string }> = [];
  assertExactKeys(
    diagnostic.cleanup,
    ["attempted", "status", "observed"],
    "diagnostic.cleanup",
    issues,
  );
  if (!new Set(["failed", "timed_out", "cancelled"]).has(String(result)))
    issue(issues, "diagnostic.result", "must be a failed terminal result");
  assertTimestamp(startedAt, "diagnostic.timestamps.startedAt", issues);
  assertTimestamp(completedAt, "diagnostic.timestamps.completedAt", issues);
  if (
    Date.parse(String(completedAt ?? "")) < Date.parse(String(startedAt ?? ""))
  )
    issue(issues, "diagnostic.timestamps", "must be ordered");
  if (!SANITIZED_DIAGNOSTIC_CODES.has(String(code)))
    issue(issues, "diagnostic.diagnostics[0].code", "must be allowlisted");
  const cleanupRecord = cleanup as Record<string, unknown> | undefined;
  if (
    typeof cleanupRecord?.attempted !== "boolean" ||
    !new Set(["completed", "failed", "not-required"]).has(
      String(cleanupRecord?.status),
    )
  )
    issue(issues, "diagnostic.cleanup", "must be a sanitized cleanup outcome");
  assertCleanupObservation(
    cleanupRecord?.observed,
    "diagnostic.cleanup.observed",
    issues,
  );
  const observed = cleanupRecord?.observed as
    | Record<string, unknown>
    | undefined;
  const observedRemoval =
    observed?.overlay === "removed" &&
    observed?.runDirectory === "removed" &&
    observed?.bootstrapMedia === "removed";
  if (
    (cleanupRecord?.status === "completed" &&
      (!cleanupRecord?.attempted || !observedRemoval)) ||
    (cleanupRecord?.status === "not-required" && cleanupRecord?.attempted)
  )
    issue(
      issues,
      "diagnostic.cleanup",
      "must truthfully bind its status to observed cleanup state",
    );
  if (issues.length > 0) throw new VmHostAdapterContractError(issues);
  return redactScannerCode(diagnostic, scannerCode) as Record<string, unknown>;
}

export function redactScannerCode(
  value: unknown,
  scannerCode: unknown,
): unknown {
  if (typeof scannerCode !== "string" || scannerCode.length === 0)
    return structuredClone(value);
  const redact = (entry: unknown): unknown => {
    if (typeof entry === "string")
      return entry.replaceAll(scannerCode, "[redacted-scanner-code]");
    if (Array.isArray(entry)) return entry.map((item) => redact(item));
    if (!isRecord(entry)) return entry;
    return Object.fromEntries(
      Object.entries(entry).map(([key, item]) => [key, redact(item)]),
    );
  };
  return redact(value);
}

function adapterExecutable(environment: NodeJS.ProcessEnv): string {
  const value = String(environment.VEM_VM_HOST_ADAPTER ?? "").trim();
  if (!value)
    throw new Error(
      "VEM_VM_HOST_ADAPTER must be configured by the runner service",
    );
  return value;
}

function evidenceExportDirectory(value: unknown): string {
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
}: {
  request: Record<string, unknown>;
  environment: NodeJS.ProcessEnv;
  evidenceDirectory?: string;
}): string {
  const base = evidenceExportDirectory(
    evidenceDirectory ?? environment.VEM_VM_HOST_EVIDENCE_EXPORT_DIR,
  );
  const scope = join(
    resolve(base),
    String(request.runId),
    String(request.operationReference).slice("vm-operation://".length),
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

function assertScannerCodeNotPersisted(
  directory: string,
  scannerCode: unknown,
): void {
  if (typeof scannerCode !== "string" || scannerCode.length === 0) return;
  const visit = (path: string): void => {
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
    if ((error as { code?: unknown })?.code !== "ENOENT") throw error;
  }
}

function inspectExportedDaemonCalibrationResponse({
  directory,
  evidence,
  calibration,
  request,
}: {
  directory: string;
  evidence: Record<string, unknown>;
  calibration: Record<string, unknown>;
  request: Record<string, unknown>;
}): Record<string, unknown> {
  if (!evidence || evidence.role !== "daemon-audio-calibration-response")
    throw new Error("daemon calibration response evidence is missing");
  const path = join(directory, String(evidence.fileName ?? ""));
  const bytes = readFileSync(path);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (
    digest !== String(evidence.digest ?? "") ||
    evidence.identity !== `runtime-evidence://${digest.replace(":", "/")}` ||
    calibration.responseArtifact !== evidence.identity ||
    calibration.responseDigest !== evidence.digest ||
    calibration.responseFileName !== evidence.fileName
  )
    throw new Error("daemon calibration response digest binding is invalid");
  const response = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
  const responseKeys = [
    "challenge",
    "configGeneration",
    "configRevision",
    "observationGeneration",
    "observationRevision",
    "proposedSettingsDigest",
    "testEvidenceExpiresAt",
    "testEvidenceToken",
  ];
  const evidenceExpiresAt = Date.parse(
    String(response.testEvidenceExpiresAt ?? ""),
  );
  const calibrationCompletedAt = Date.parse(
    String(calibration.completedAt ?? ""),
  );
  const audioCapture = request.audioCapture as Record<string, unknown>;
  const requestedCalibration = audioCapture.daemonCalibration as
    | Record<string, unknown>
    | undefined;
  if (
    JSON.stringify(Object.keys(response).sort()) !==
      JSON.stringify(responseKeys) ||
    response.challenge !== requestedCalibration?.challenge ||
    typeof response.testEvidenceToken !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      response.testEvidenceToken,
    ) ||
    !Number.isFinite(evidenceExpiresAt) ||
    !Number.isFinite(calibrationCompletedAt) ||
    evidenceExpiresAt <= calibrationCompletedAt ||
    !SHA256_DIGEST.test(String(response.observationRevision ?? "")) ||
    !Number.isInteger(response.observationGeneration) ||
    (response.observationGeneration as number) < 0 ||
    !SHA256_DIGEST.test(String(response.configRevision ?? "")) ||
    !Number.isInteger(response.configGeneration) ||
    (response.configGeneration as number) < 0 ||
    !SHA256_DIGEST.test(String(response.proposedSettingsDigest ?? ""))
  )
    throw new Error("raw daemon calibration response is invalid");
  return response;
}

function processGroupExists(child: ChildProcess): boolean {
  if (child.pid === undefined || !Number.isInteger(child.pid)) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function signalProcessGroup(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (child.pid === undefined || !Number.isInteger(child.pid)) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    if (child.exitCode === null && child.signalCode === null)
      child.kill(signal);
  }
}

function adapterEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        !/^(?:VEM_VM_HOST_SCANNER_CODE|VEM_SERIAL_RUNNER_SIGNING_KEY_FILE|VEM_SERIAL_RUNNER_EXPECTED_PUBLIC_KEY)$/i.test(
          name,
        ) && !/(?:^|_)(?:PRIVATE|SIGNING)_?KEY(?:_|$)/i.test(name),
    ),
  );
}

function terminateWindowsProcessTree(child: ChildProcess): Promise<void> {
  if (!Number.isInteger(child.pid)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const taskkill = spawn(
      "taskkill",
      ["/pid", String(child.pid), "/t", "/f"],
      { stdio: "ignore", windowsHide: true },
    );
    taskkill.once("error", () => resolve());
    taskkill.once("close", () => resolve());
  });
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function terminate(child: ChildProcess): Promise<void> {
  if (process.platform === "win32") {
    await terminateWindowsProcessTree(child);
    return;
  }
  signalProcessGroup(child, "SIGTERM");
  const gracefulDeadline = Date.now() + 250;
  while (processGroupExists(child) && Date.now() < gracefulDeadline)
    await wait(20);
  if (!processGroupExists(child)) return;

  signalProcessGroup(child, "SIGKILL");
  while (processGroupExists(child)) await wait(20);
}

type AdapterInvocationOutcome = {
  result: string;
  code: string;
  startedAt: string;
  completedAt: string;
  report: Record<string, unknown> | null;
  detail?: string;
};

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
}: {
  request: Record<string, unknown>;
  workDirectory: string;
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  onInterrupted?: (reason: string) => unknown;
  onStarted?: (operation: Record<string, unknown>) => unknown;
  scannerCode?: Buffer | string;
  allowTestAdapter: boolean;
}): Promise<AdapterInvocationOutcome> {
  const executable = adapterExecutable(environment);
  const operationReference = String(request.operationReference);
  const requestPath = join(
    workDirectory,
    `${operationReference.slice("vm-operation://".length)}.request.json`,
  );
  const reportPath = join(
    workDirectory,
    `${operationReference.slice("vm-operation://".length)}.report.json`,
  );
  const scannerInputPath =
    scannerCode === undefined
      ? null
      : join(
          workDirectory,
          `${operationReference.slice("vm-operation://".length)}.scanner-input`,
        );
  const startedAt = new Date().toISOString();
  writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  if (scannerInputPath && scannerCode !== undefined)
    writeFileSync(scannerInputPath, scannerCode, { mode: 0o600, flag: "wx" });
  try {
    const outcome = await new Promise<{
      code: number | null;
      reason: string | null;
    }>((resolve) => {
      const command = executable.endsWith(".ts")
        ? process.execPath
        : executable;
      const args = executable.endsWith(".ts")
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
      const processEnvironment = adapterEnvironment(process.env);
      const configuredEnvironment = adapterEnvironment(environment);
      const child = spawn(command, args, {
        detached: true,
        stdio: "ignore",
        cwd: workDirectory,
        env: {
          ...processEnvironment,
          ...configuredEnvironment,
        },
      });
      onStarted?.(request);
      let reason: string | null = null;
      let settled = false;
      let termination: Promise<void> | null = null;
      const finish = (value: { code: number | null; reason: string | null }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(value);
      };
      const terminateFor = (nextReason: string): Promise<void> => {
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
      child.on("close", (code: number | null) => {
        if (termination) {
          void termination.then(() => finish({ code, reason }));
          return;
        }
        void terminate(child).then(() => finish({ code, reason }));
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
    let report: Record<string, unknown>;
    try {
      report = validateVmHostAdapterReport(
        JSON.parse(readFileSync(reportPath, "utf8")),
        request,
      );
      const reportAdapter = report.adapter as Record<string, unknown>;
      if (
        !allowTestAdapter &&
        reportAdapter.identity === "vm-host-adapter://deterministic-fake@1.0.0"
      )
        throw new Error(
          "deterministic fake adapter is restricted to contract unit tests",
        );
    } catch (error) {
      return {
        result: "failed",
        code: "evidence_invalid",
        detail: error instanceof Error ? error.message : String(error),
        startedAt,
        completedAt,
        report: null,
      };
    }
    const firstDiagnostic = (
      report.diagnostics as unknown[] | undefined
    )?.[0] as Record<string, unknown> | undefined;
    return {
      result: String(report.result),
      code: String(
        firstDiagnostic?.code ??
          (String(report.result) === "succeeded"
            ? "adapter_completed"
            : `adapter_${String(report.result)}`),
      ),
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

function serialSessionForRecovery(
  request: Record<string, unknown>,
): Record<string, unknown> | null {
  const serialSession = request.serialSession as Record<string, unknown> | null;
  if (serialSession === null) return null;
  if (request.operation !== "start-serial-session") {
    return {
      ...serialSession,
      scannerInjection: null,
      idempotencyCheck: false,
    };
  }
  const binding = deriveSerialSessionBinding({
    runId: request.runId,
    lifecycleReference: request.lifecycleReference,
    targetIdentity: (request.target as Record<string, unknown>).identity,
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
    saleCorrelationIds: [
      ...(serialSession.saleCorrelationIds as unknown[]),
    ],
    saleBindings: structuredClone(serialSession.saleBindings),
    operationEvidence: null,
    idempotencyCheck: false,
  };
}

function cleanupRequestFor(request: Record<string, unknown>): Record<string, unknown> {
  const nonce = `op-${randomBytes(16).toString("hex")}`;
  return createVmHostAdapterRequest({
    ...request,
    operation: "cleanup",
    operationNonce: nonce,
    operationReference: `vm-operation://${nonce}`,
    cancelOperationReference: null,
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

function cancelRequestFor(request: Record<string, unknown>): Record<string, unknown> {
  const nonce = `op-${randomBytes(16).toString("hex")}`;
  return createVmHostAdapterRequest({
    ...request,
    operation: "cancel",
    operationNonce: nonce,
    operationReference: `vm-operation://${nonce}`,
    cancelOperationReference: request.operationReference,
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
}: {
  request: unknown;
  workDirectory: string;
  environment?: NodeJS.ProcessEnv;
  evidenceDirectory?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  onOperationStarted?: (operation: Record<string, unknown>) => unknown;
  scannerCode?: Buffer;
  allowTestAdapter?: boolean;
}): Promise<Record<string, unknown>> {
  const testAdapterAllowed =
    allowTestAdapter ||
    process.env.VEM_VM_HOST_ADAPTER_CONTRACT_TEST_ONLY === "1";
  const request = validateVmHostAdapterRequest(requestInput);
  if (request.operation === "inject-scanner-code") {
    const scannerInput = normalizeScannerInput(scannerCode);
    const descriptor = createScannerCodeDescriptor(scannerInput);
    const serialSession = request.serialSession as Record<string, unknown>;
    const scannerInjection = serialSession.scannerInjection as
      | Record<string, unknown>
      | undefined;
    if (
      JSON.stringify(descriptor) !==
      JSON.stringify({
        scannerCodeDigest: scannerInjection?.scannerCodeDigest,
        scannerCodeByteLength: scannerInjection?.scannerCodeByteLength,
        scannerCodeSuffix: scannerInjection?.scannerCodeSuffix,
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
          environment,
          evidenceDirectory,
        })
      : null;
  if (scopedEvidenceDirectory)
    mkdirSync(scopedEvidenceDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(adapterWorkDirectory, { recursive: true, mode: 0o700 });
  const adapterEnvironment = {
    ...environment,
    VEM_VM_HOST_ADAPTER_CONTRACT_VERSION: CONTRACT_VERSION,
    ...(scopedEvidenceDirectory
      ? { VEM_VM_HOST_EVIDENCE_EXPORT_DIR: scopedEvidenceDirectory }
      : {}),
  };
  let cancellation: AdapterInvocationOutcome | undefined;
  const cancelInFlightOperation = async (): Promise<AdapterInvocationOutcome> => {
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
  let outcome: AdapterInvocationOutcome = await invokeAdapter({
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
    ["capture-display", "capture-default-audio"].includes(
      String(request.operation),
    )
  ) {
    try {
      const report = outcome.report;
      if (report === null)
        throw new Error(
          "VM Host Adapter succeeded without a report",
        );
      const evidenceDirectory = scopedEvidenceDirectory;
      if (evidenceDirectory === null)
        throw new Error(
          "capture operations require a runner-owned evidence export directory",
        );
      const reportRecord = report as Record<string, unknown>;
      const reportEvidence = reportRecord.evidence as unknown[];
      const displayCapture = reportRecord.displayCapture as
        | Record<string, unknown>
        | undefined;
      const defaultAudioCapture = reportRecord.defaultAudioCapture as
        | Record<string, unknown>
        | undefined;
      const evidence = reportEvidence[0] as Record<string, unknown>;
      if (request.operation === "capture-display") {
        if (displayCapture === undefined)
          throw new Error(
            "display capture result is missing its capture section",
          );
        inspectExportedDisplayCapture({
          directory: evidenceDirectory,
          evidence,
          capture: displayCapture.capture as Record<string, unknown>,
          challenge: displayCapture.visualChallenge as Record<string, unknown>,
        });
      } else {
        if (defaultAudioCapture === undefined)
          throw new Error(
            "default audio capture result is missing its capture section",
          );
        inspectExportedDefaultAudioCapture({
          directory: evidenceDirectory,
          evidence,
          capture: defaultAudioCapture.capture as Record<string, unknown>,
        });
      }
      if (request.operation === "capture-default-audio") {
        const calibrationEvidence = reportEvidence.find(
          (entry) =>
            (entry as Record<string, unknown>).role ===
            "daemon-audio-calibration-response",
        ) as Record<string, unknown>;
        inspectExportedDaemonCalibrationResponse({
          directory: evidenceDirectory,
          evidence: calibrationEvidence,
          calibration: defaultAudioCapture?.daemonCalibration as Record<string, unknown>,
          request,
        });
      }
    } catch {
      outcome = {
        ...outcome,
        result: "failed",
        code: "evidence_invalid",
        report: null,
      };
    }
  }
  if (outcome.result === "succeeded") {
    if (outcome.report === null)
      throw new Error("VM Host Adapter succeeded without a report");
    return outcome.report;
  }
  let cleanup: Record<string, unknown> = {
    attempted: false,
    status: "not-required",
    observed: {
      overlay: "unknown",
      runDirectory: "unknown",
      bootstrapMedia: "unknown",
    },
  };
  const requiresCancellation =
    outcome.result === "timed_out" || outcome.result === "cancelled";
  let cancellationOutcome: {
    result: string;
    report: Record<string, unknown> | null;
  } | null = null;
  if (requiresCancellation) {
    try {
      cancellationOutcome = await cancelInFlightOperation();
    } catch {
      cancellationOutcome = { result: "failed", report: null };
    }
  }
  let recovery: {
    result: string;
    report: Record<string, unknown> | null;
  };
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
  const recoveryReport = recovery.report as Record<string, unknown> | null;
  const recoveryCleanup = recoveryReport?.cleanup as
    | Record<string, unknown>
    | undefined;
  const recovered =
    recovery.result === "succeeded" &&
    recoveryCleanup?.status === "completed" &&
    recoveryCleanup?.overlayDisposition === "removed";
  cleanup = {
    attempted: true,
    status:
      (!cancellationOutcome || cancellationOutcome.result === "succeeded") &&
      recovered
        ? "completed"
        : "failed",
    observed: (recoveryCleanup?.observed as Record<string, unknown> | undefined) ??
      {
        overlay: "unknown",
        runDirectory: "unknown",
        bootstrapMedia: "unknown",
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
    `VM Host Adapter reported ${outcome.result}: ${outcome.code}${outcome.detail ? ` (${outcome.detail})` : ""}`,
    diagnostic,
  );
}
