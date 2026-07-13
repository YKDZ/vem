import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const REQUEST_SCHEMA_VERSION = "vem-vm-host-adapter-request/v1";
const REPORT_SCHEMA_VERSION = "vem-vm-host-adapter-report/v1";
const DIAGNOSTIC_SCHEMA_VERSION = "vem-vm-host-adapter-diagnostic/v1";
const ASSET_IDENTITY = /^factory-cas:\/\/sha256\/([a-f0-9]{64})$/;
const EVIDENCE_IDENTITY = /^factory-evidence:\/\/sha256\/([a-f0-9]{64})$/;
const TARGET_IDENTITY = /^vm-target:\/\/[a-z0-9][a-z0-9.-]{0,127}$/;
const OPERATION_NONCE = /^op-[a-f0-9]{16,64}$/;
const OPERATION_REFERENCE = /^vm-operation:\/\/op-[a-f0-9]{16,64}$/;
const LIFECYCLE_REFERENCE = /^vm-lifecycle:\/\/[a-z0-9][a-z0-9.-]{2,127}$/;
const LOGICAL_IDENTITY =
  /^[a-z][a-z0-9-]{0,31}:\/\/[a-z0-9][a-z0-9._:@-]{0,191}$/;
const SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const VM_HOST_ADAPTER_REQUEST_SCHEMA_VERSION = REQUEST_SCHEMA_VERSION;
export const VM_HOST_ADAPTER_REPORT_SCHEMA_VERSION = REPORT_SCHEMA_VERSION;

export const VM_HOST_ADAPTER_OPERATIONS = new Set([
  "clean-install",
  "capture-approved-base",
  "restore-approved-base",
  "create-disposable-overlay",
  "capture-display",
  "capture-default-audio",
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
  cleanup: ["approved-runtime-base", "factory-iso"],
  cancel: ["approved-runtime-base"],
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
    /(?:^|[^a-z0-9-])\/(?:mnt|home|tmp|var|opt|users)(?:\/|$)|(?:^|[^a-z0-9-])[a-z]:[\\/]|\\\\|unraid:\/\//i.test(
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
    runId: request.runId,
    operation: request.operation,
    operationNonce: request.operationNonce,
    operationReference: request.operationReference,
    lifecycleReference: request.lifecycleReference,
    cancelOperationReference: request.cancelOperationReference,
    targetIdentity: request.target.identity,
    factoryMedia: request.factoryMedia,
    requestedCapabilities: [...request.requestedCapabilities],
  };
}

function reconstructRequest(request) {
  return {
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
    assets: request.assets?.map((asset) => ({
      role: asset?.role,
      identity: asset?.identity,
      digest: asset?.digest,
    })),
    requestedCapabilities: [...(request.requestedCapabilities ?? [])],
  };
}

export function validateVmHostAdapterRequest(input) {
  const request = structuredClone(input);
  const issues = [];
  assertExactKeys(
    request,
    [
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
      "assets",
      "requestedCapabilities",
    ],
    "request",
    issues,
  );
  if (request.schemaVersion !== REQUEST_SCHEMA_VERSION)
    issue(issues, "request.schemaVersion", `must be ${REQUEST_SCHEMA_VERSION}`);
  if (request.kind !== "vm-host-adapter-request")
    issue(issues, "request.kind", "must be vm-host-adapter-request");
  if (!VM_HOST_ADAPTER_OPERATIONS.has(request.operation))
    issue(issues, "request.operation", "must be a supported operation");
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
    issue(issues, "request.factoryMedia", "must be null outside clean-install");
  }
  if (!Array.isArray(request.assets) || request.assets.length === 0)
    issue(issues, "request.assets", "must contain immutable operation assets");
  else {
    request.assets.forEach((asset, index) => assertAsset(asset, index, issues));
    assertUniqueRoles(request.assets, "request.assets", issues);
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
  }
  const requiredRoles =
    REQUIRED_ASSET_ROLES_BY_OPERATION[request.operation] ?? [];
  const hasRequiredRole =
    request.operation === "cleanup"
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
      if (request.operation === "cleanup") break;
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
    ],
    "report",
    issues,
  );
  if (report.schemaVersion !== REPORT_SCHEMA_VERSION)
    issue(issues, "report.schemaVersion", `must be ${REPORT_SCHEMA_VERSION}`);
  if (report.kind !== "vm-host-adapter-report")
    issue(issues, "report.kind", "must be vm-host-adapter-report");
  if (
    assertExactKeys(
      report.adapter,
      ["identity", "version"],
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
  }
  if (
    assertExactKeys(
      report.request,
      [
        "runId",
        "operation",
        "operationNonce",
        "operationReference",
        "lifecycleReference",
        "cancelOperationReference",
        "targetIdentity",
        "factoryMedia",
        "requestedCapabilities",
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
    const observedSource = request.assets.find(
      (asset) =>
        asset.role ===
        (request.operation === "clean-install" ||
        (request.operation === "cleanup" &&
          request.assets.some((asset) => asset.role === "factory-iso"))
          ? "factory-iso"
          : "approved-runtime-base"),
    );
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
  if (!Array.isArray(report.evidence))
    issue(issues, "report.evidence", "must be an array");
  else {
    report.evidence.forEach((entry, index) => {
      const path = `report.evidence[${index}]`;
      const entryKeys =
        entry?.role === "display-capture"
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
      if (entry.role === "display-capture") {
        const expectedFileName = `${entry.digest?.slice(7)}.`;
        if (
          typeof entry.fileName !== "string" ||
          !/^[a-f0-9]{64}\.(?:png|jpg|jpeg|webp)$/.test(entry.fileName) ||
          !entry.fileName.startsWith(expectedFileName)
        )
          issue(
            issues,
            `${path}.fileName`,
            "must be a digest-bound relative image file name",
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
    const completedCaptureAfterCleanup =
      request.operation === "capture-approved-base" &&
      report.result === "succeeded" &&
      state === "completed/removed" &&
      cleaned;
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
    schemaVersion: report.schemaVersion,
    kind: report.kind,
    adapter: {
      identity: report.adapter.identity,
      version: report.adapter.version,
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
      ...(entry.role === "display-capture" ? { fileName: entry.fileName } : {}),
    })),
    timestamps: {
      startedAt: report.timestamps.startedAt,
      completedAt: report.timestamps.completedAt,
    },
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
  };
}

export function createVmHostAdapterDiagnostic({
  request: requestInput,
  result,
  code,
  startedAt,
  completedAt,
  cleanup,
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
  return structuredClone(diagnostic);
}

function adapterExecutable(environment) {
  const value = String(environment.VEM_VM_HOST_ADAPTER ?? "").trim();
  if (!value)
    throw new Error(
      "VEM_VM_HOST_ADAPTER must be configured by the runner service",
    );
  return value;
}

function evidenceExportDirectory(environment) {
  const value = String(
    environment.VEM_VM_HOST_EVIDENCE_EXPORT_DIR ?? "",
  ).trim();
  if (!isAbsolute(value))
    throw new Error(
      "VEM_VM_HOST_EVIDENCE_EXPORT_DIR must be an absolute runner-owned directory",
    );
  return value;
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
  const startedAt = new Date().toISOString();
  writeFileSync(requestPath, `${JSON.stringify(request)}\n`, { mode: 0o600 });
  try {
    const outcome = await new Promise((resolve) => {
      const command = executable.endsWith(".mjs")
        ? process.execPath
        : executable;
      const args = executable.endsWith(".mjs")
        ? [executable, "--request", requestPath, "--report", reportPath]
        : ["--request", requestPath, "--report", reportPath];
      const child = spawn(command, args, {
        detached: process.platform !== "win32",
        stdio: "ignore",
        env: { ...process.env, ...environment },
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
    rmSync(requestPath, { force: true });
    rmSync(reportPath, { force: true });
  }
}

function cleanupRequestFor(request) {
  const nonce = `op-${randomBytes(16).toString("hex")}`;
  return createVmHostAdapterRequest({
    ...request,
    operation: "cleanup",
    operationNonce: nonce,
    operationReference: `vm-operation://${nonce}`,
    cancelOperationReference: null,
    requestedCapabilities: ["cleanup", "cancellation"],
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
    requestedCapabilities: ["cancellation", "cleanup"],
  });
}

export async function runVmHostAdapter({
  request: requestInput,
  workDirectory,
  environment = process.env,
  timeoutMs = Number(environment.VEM_VM_HOST_ADAPTER_TIMEOUT_MS ?? 600000),
  signal,
  onOperationStarted,
}) {
  const request = validateVmHostAdapterRequest(requestInput);
  if (typeof workDirectory !== "string" || !workDirectory)
    throw new Error(
      "VM Host Adapter client requires a runner-local work directory",
    );
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1)
    throw new Error("VM Host Adapter timeout must be a positive integer");
  if (request.operation === "capture-display")
    evidenceExportDirectory(environment);
  mkdirSync(workDirectory, { recursive: true, mode: 0o700 });
  let cancellation;
  const cancelInFlightOperation = async () => {
    if (cancellation) return cancellation;
    cancellation = await invokeAdapter({
      request: cancelRequestFor(request),
      workDirectory,
      environment,
      timeoutMs: Math.min(timeoutMs, 30000),
      signal: undefined,
    });
    return cancellation;
  };
  const outcome = await invokeAdapter({
    request,
    workDirectory,
    environment,
    timeoutMs,
    signal,
    onInterrupted: cancelInFlightOperation,
    onStarted: onOperationStarted,
  });
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
  const cancellationOutcome = requiresCancellation
    ? await cancelInFlightOperation()
    : null;
  const recovery = await invokeAdapter({
    request: cleanupRequestFor(request),
    workDirectory,
    environment,
    timeoutMs: Math.min(timeoutMs, 30000),
    signal: undefined,
  });
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
  });
  throw new VmHostAdapterExecutionError(
    `VM Host Adapter reported ${outcome.result}`,
    diagnostic,
  );
}
