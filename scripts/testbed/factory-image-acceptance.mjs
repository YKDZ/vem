#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { admitFactoryAcceptance } from "../factory/factory-acceptance-admission.mjs";
import { validateFactoryMaintenanceRelayAttestation } from "./factory-maintenance-relay-attestation.mjs";
import {
  createVmHostAdapterRequest,
  runVmHostAdapter,
  VM_HOST_ADAPTER_CONTRACT_VERSION,
} from "./vm-host-adapter-contract.mjs";

const INPUT_SCHEMA_VERSION = "vem-factory-image-acceptance-input/v1";
const ARTIFACT_DIRECTORIES = new Set([
  "lifecycle",
  "verifier",
  "tauri",
  "screenshots",
]);
const SENSITIVE_KEY =
  /claim[-_]?code|token|secret|password|passwd|credential|api[-_]?key|private[-_]?key/i;
const ABSOLUTE_HOST_PATH =
  /(?:^|[^a-z0-9-])\/(?:mnt|home|tmp|var|opt|users|runner|workspace|workspaces)(?:\/|$)|(?:^|[^a-z0-9-])[a-z]:[\\/]|\\\\/i;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WIREGUARD_PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
const PAYMENT_BARRIER_ALLOWED_ROUTES = ["/payment", "/dispensing", "/result"];
const FACTORY_ROUTE_COMPETITION_CASES = new Set([
  "catalog_refresh",
  "readiness_refresh",
]);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} must contain exactly: ${expected.join(", ")}`);
  }
}

function nonEmpty(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function absolutePath(value, label) {
  const path = nonEmpty(value, label);
  if (!path.startsWith("/"))
    throw new Error(`${label} must be an absolute path`);
  return path;
}

function factoryCasIdentity(value, label) {
  if (!/^factory-cas:\/\/sha256\/[a-f0-9]{64}$/.test(nonEmpty(value, label))) {
    throw new Error(`${label} must be a factory-cas SHA-256 identity`);
  }
  return value;
}

function sha256(value, label) {
  if (!/^sha256:[a-f0-9]{64}$/.test(nonEmpty(value, label))) {
    throw new Error(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function readAndHashRegularFile(path, label) {
  const pathMetadata = lstatSync(path);
  if (!pathMetadata.isFile() || pathMetadata.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symbolic-link file`);
  }
  const descriptor = openSync(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error(`${label} must be a regular file`);
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size
    ) {
      throw new Error(`${label} changed while it was being read`);
    }
    return {
      bytes,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  } finally {
    closeSync(descriptor);
  }
}

function factoryEvidenceIdentity(value, label) {
  if (
    !/^factory-evidence:\/\/sha256\/[a-f0-9]{64}$/.test(nonEmpty(value, label))
  ) {
    throw new Error(`${label} must be a Factory evidence identity`);
  }
  return value;
}

function maintenanceRelaySession(value, label) {
  exactKeys(
    value,
    ["sessionId", "relayPeer", "sourceTunnelAddress", "endpointTunnelAddress"],
    label,
  );
  if (typeof value.sessionId !== "string" || !UUID.test(value.sessionId))
    throw new Error(`${label}.sessionId must be a maintenance session UUID`);
  exactKeys(
    value.relayPeer,
    ["publicKey", "tunnelAddress"],
    `${label}.relayPeer`,
  );
  if (
    !WIREGUARD_PUBLIC_KEY.test(
      nonEmpty(value.relayPeer.publicKey, `${label}.relayPeer.publicKey`),
    )
  )
    throw new Error(
      `${label}.relayPeer.publicKey must be a WireGuard public key`,
    );
  if (isIP(value.relayPeer.tunnelAddress) !== 4)
    throw new Error(
      `${label}.relayPeer.tunnelAddress must be an IPv4 tunnel address`,
    );
  for (const key of ["sourceTunnelAddress", "endpointTunnelAddress"])
    if (isIP(value[key]) !== 4)
      throw new Error(`${label}.${key} must be an IPv4 tunnel address`);
  return value;
}

export function validateFactoryImageAcceptanceInput(input) {
  exactKeys(
    input,
    [
      "schemaVersion",
      "kind",
      "runId",
      "targetIdentity",
      "factory",
      "endpoint",
      "ephemeralPlatform",
      "ssh",
      "maintenanceRelayAttestation",
      "evidence",
    ],
    "factory image acceptance input",
  );
  if (input.schemaVersion !== INPUT_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${INPUT_SCHEMA_VERSION}`);
  }
  if (input.kind !== "factory-image-acceptance-input") {
    throw new Error("kind must be factory-image-acceptance-input");
  }
  if (!/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(nonEmpty(input.runId, "runId"))) {
    throw new Error("runId must be an uppercase logical run identity");
  }
  validateFactoryMaintenanceRelayAttestation(input.maintenanceRelayAttestation);
  if (
    !/^vm-target:\/\/[a-z0-9][a-z0-9.-]{0,127}$/.test(
      nonEmpty(input.targetIdentity, "targetIdentity"),
    )
  ) {
    throw new Error("targetIdentity must be a logical VM target identity");
  }
  exactKeys(
    input.factory,
    [
      "assemblyMode",
      "targetFirmware",
      "isoIdentity",
      "manifestIdentity",
      "provenanceIdentity",
      "provenanceDigest",
      "manifestPath",
      "provenancePath",
      "isoPath",
      "udfExtractorPath",
      "udfWriterPath",
      "wimlibPath",
    ],
    "factory",
  );
  if (input.factory.assemblyMode !== "windows-serviced-iso") {
    throw new Error("factory.assemblyMode must be windows-serviced-iso");
  }
  if (!new Set(["bios", "uefi"]).has(input.factory.targetFirmware)) {
    throw new Error("factory.targetFirmware must be bios or uefi");
  }
  factoryCasIdentity(input.factory.isoIdentity, "factory.isoIdentity");
  sha256(input.factory.manifestIdentity, "factory.manifestIdentity");
  factoryEvidenceIdentity(
    input.factory.provenanceIdentity,
    "factory.provenanceIdentity",
  );
  sha256(input.factory.provenanceDigest, "factory.provenanceDigest");
  if (
    input.factory.provenanceIdentity !==
    `factory-evidence://${input.factory.provenanceDigest.replace(":", "/")}`
  ) {
    throw new Error(
      "factory.provenanceIdentity must exactly bind factory.provenanceDigest",
    );
  }
  for (const key of [
    "manifestPath",
    "provenancePath",
    "isoPath",
    "udfExtractorPath",
    "udfWriterPath",
    "wimlibPath",
  ]) {
    absolutePath(input.factory[key], `factory.${key}`);
  }
  exactKeys(
    input.endpoint,
    ["expectedTestbedUser", "maintenanceRelaySession"],
    "endpoint",
  );
  nonEmpty(input.endpoint.expectedTestbedUser, "endpoint.expectedTestbedUser");
  maintenanceRelaySession(
    input.endpoint.maintenanceRelaySession,
    "endpoint.maintenanceRelaySession",
  );
  const attestedSession = input.maintenanceRelayAttestation.session;
  if (
    input.endpoint.maintenanceRelaySession.sessionId !== attestedSession.id ||
    input.endpoint.maintenanceRelaySession.relayPeer.publicKey !==
      attestedSession.relay.publicKey ||
    input.endpoint.maintenanceRelaySession.relayPeer.tunnelAddress !==
      attestedSession.relay.tunnelAddress ||
    input.endpoint.maintenanceRelaySession.sourceTunnelAddress !==
      attestedSession.sourcePeer.tunnelAddress ||
    input.endpoint.maintenanceRelaySession.endpointTunnelAddress !==
      attestedSession.targetMachine.tunnelAddress
  ) {
    throw new Error(
      "adapter endpoint session must match the runner-owned Relay attestation",
    );
  }
  exactKeys(
    input.ephemeralPlatform,
    ["evidencePath", "platformTarget", "machineCode"],
    "ephemeralPlatform",
  );
  absolutePath(
    input.ephemeralPlatform.evidencePath,
    "ephemeralPlatform.evidencePath",
  );
  if (
    !/^VEM-TESTBED-[A-Z0-9-]+$/.test(
      nonEmpty(
        input.ephemeralPlatform.machineCode,
        "ephemeralPlatform.machineCode",
      ),
    )
  ) {
    throw new Error(
      "ephemeralPlatform.machineCode must be a testbed machine identity",
    );
  }
  nonEmpty(
    input.ephemeralPlatform.platformTarget,
    "ephemeralPlatform.platformTarget",
  );
  exactKeys(input.ssh, ["identityPath", "certificatePath"], "ssh");
  absolutePath(input.ssh.identityPath, "ssh.identityPath");
  absolutePath(input.ssh.certificatePath, "ssh.certificatePath");
  exactKeys(
    input.evidence,
    ["root", "lifecycleReport", "sanitizedUpload"],
    "evidence",
  );
  for (const key of ["root", "lifecycleReport", "sanitizedUpload"]) {
    absolutePath(input.evidence[key], `evidence.${key}`);
  }
  const root = resolve(input.evidence.root);
  for (const key of ["lifecycleReport", "sanitizedUpload"]) {
    if (!resolve(input.evidence[key]).startsWith(`${root}${sep}`)) {
      throw new Error(`evidence.${key} must remain inside evidence.root`);
    }
  }
  return structuredClone(input);
}

function readProtectedInput() {
  if (process.argv.length > 2 && process.argv[2] !== "--cleanup-only") {
    throw new Error("factory image acceptance accepts only --cleanup-only");
  }
  const path = absolutePath(
    process.env.VEM_FACTORY_IMAGE_ACCEPTANCE_INPUT_PATH,
    "VEM_FACTORY_IMAGE_ACCEPTANCE_INPUT_PATH",
  );
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(
      "VEM_FACTORY_IMAGE_ACCEPTANCE_INPUT_PATH must be a regular file",
    );
  }
  return validateFactoryImageAcceptanceInput(
    JSON.parse(readFileSync(path, "utf8")),
  );
}

function asset(role, identity) {
  const digest = factoryCasIdentity(identity, role).replace(
    "factory-cas://",
    "",
  );
  return { role, identity, digest: `sha256:${digest.slice("sha256/".length)}` };
}

function lifecycleReference(input) {
  const seed = createHash("sha256")
    .update(`${input.runId}\n${input.targetIdentity}`)
    .digest("hex")
    .slice(0, 32);
  return `vm-lifecycle://${input.runId.toLowerCase()}.${seed}`;
}

function adapterRequest(
  input,
  operation,
  assets,
  factoryMedia = null,
  displayBinding = null,
) {
  const nonce = `op-${randomBytes(16).toString("hex")}`;
  const capabilities = {
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
    "create-disposable-overlay": [
      "disposable-overlay",
      "serial:lower-controller",
      "serial:scanner",
      "cancellation",
      "cleanup",
    ],
    "capture-display": ["display-capture", "cancellation", "cleanup"],
    cleanup: ["cleanup", "cancellation"],
  }[operation];
  const visualChallenge =
    operation === "capture-display"
      ? {
          token: randomBytes(32).toString("hex"),
          colorRgb: [...randomBytes(3)].map((component) => component || 1),
          region: {
            x: randomBytes(1)[0] % 1033,
            y: randomBytes(1)[0] % 1897,
            width: 48,
            height: 24,
          },
        }
      : null;
  return createVmHostAdapterRequest({
    contractVersion: VM_HOST_ADAPTER_CONTRACT_VERSION,
    schemaVersion: "vem-vm-host-adapter-request/v2",
    kind: "vm-host-adapter-request",
    operation,
    runId: input.runId,
    operationNonce: nonce,
    operationReference: `vm-operation://${nonce}`,
    lifecycleReference: lifecycleReference(input),
    cancelOperationReference: null,
    target: { identity: input.targetIdentity },
    factoryMedia,
    displayCapture:
      operation === "capture-display"
        ? {
            activeKioskSession: displayBinding.activeKioskSession,
            tauriRoute: displayBinding.tauriRoute,
            cdpTargetId: displayBinding.cdpTargetId,
            visualChallenge,
          }
        : null,
    audioCapture: null,
    assets,
    requestedCapabilities: capabilities,
    maintenanceRelaySession: input.endpoint.maintenanceRelaySession,
    serialSession: null,
  });
}

function factoryMedia(input) {
  return {
    assemblyMode: input.factory.assemblyMode,
    targetFirmware: input.factory.targetFirmware,
    manifestIdentity: input.factory.manifestIdentity,
    provenanceIdentity: input.factory.provenanceIdentity,
    provenanceDigest: input.factory.provenanceDigest,
    outputIdentity: input.factory.isoIdentity,
    outputDigest: asset("factory-iso", input.factory.isoIdentity).digest,
  };
}

async function admitFactoryInput(input) {
  return admitFactoryAcceptance({
    manifestPath: input.factory.manifestPath,
    provenancePath: input.factory.provenancePath,
    outputIsoPath: input.factory.isoPath,
    manifestIdentity: input.factory.manifestIdentity,
    provenanceDigest: input.factory.provenanceDigest,
    outputIdentity: input.factory.isoIdentity,
    outputDigest: asset("factory-iso", input.factory.isoIdentity).digest,
    udfExtractorPath: input.factory.udfExtractorPath,
    udfWriterPath: input.factory.udfWriterPath,
    wimlibPath: input.factory.wimlibPath,
  });
}

function endpointArgument(endpoint, expectedRelaySession) {
  if (
    endpoint?.protocol !== "ssh" ||
    typeof endpoint.host !== "string" ||
    !endpoint.host ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port < 1 ||
    endpoint.port > 65535 ||
    !["discovered", "authenticated"].includes(endpoint.reachability)
  ) {
    throw new Error(
      "adapter must return a discovered authenticated SSH guest endpoint",
    );
  }
  const proof = endpoint.relayProof;
  if (
    !proof ||
    JSON.stringify({
      sessionId: proof.sessionId,
      relayPeer: proof.relayPeer,
      sourceTunnelAddress: proof.sourceTunnelAddress,
      endpointTunnelAddress: proof.endpointTunnelAddress,
    }) !== JSON.stringify(expectedRelaySession) ||
    endpoint.host !== expectedRelaySession.endpointTunnelAddress ||
    proof.endpointAllowedIp !== `${endpoint.host}/32` ||
    proof.endpointRoute !== `${endpoint.host}/32` ||
    !Number.isInteger(proof.handshakeUnixSeconds) ||
    proof.handshakeUnixSeconds < 1
  ) {
    throw new Error(
      "adapter endpoint must prove the exact maintenance-session Relay peer and endpoint /32 route",
    );
  }
  return JSON.stringify(endpoint);
}

function verifierOutput(input, name) {
  return join(input.evidence.root, "verifier", name);
}

function routeFromTauriUrl(value) {
  const url = new URL(nonEmpty(value, "tauri route"));
  if (url.protocol !== "http:" || url.host !== "tauri.localhost" || !url.hash)
    throw new Error("tauri route must be a strict Machine UI hash URL");
  return url.hash;
}

function routePath(value) {
  const route = nonEmpty(value, "route").startsWith("#")
    ? nonEmpty(value, "route")
    : `#${nonEmpty(value, "route")}`;
  const url = new URL(`http://tauri.localhost/${route}`);
  return url.hash.slice(1).split("?")[0].replace(/\/+$/, "") || "/";
}

function isPaymentBarrierRoute(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  const actual = routePath(value);
  return PAYMENT_BARRIER_ALLOWED_ROUTES.some((allowed) => {
    const allowedPath = routePath(allowed);
    return actual === allowedPath || actual.startsWith(`${allowedPath}/`);
  });
}

function commonVerifierArgs(
  input,
  endpoint,
  { ephemeralPlatform = true, sshKnownHostsPath = null } = {},
) {
  const args = [
    "--run-id",
    input.runId,
    "--machine-code",
    input.ephemeralPlatform.machineCode,
    "--expected-testbed-user",
    input.endpoint.expectedTestbedUser,
    "--identity",
    input.ssh.identityPath,
    "--certificate",
    input.ssh.certificatePath,
    "--factory-guest-endpoint-json",
    endpointArgument(endpoint, input.endpoint.maintenanceRelaySession),
  ];
  if (sshKnownHostsPath) {
    args.push("--ssh-known-hosts-path", sshKnownHostsPath);
  }
  if (ephemeralPlatform) {
    args.splice(
      4,
      0,
      "--platform-target",
      input.ephemeralPlatform.platformTarget,
      "--ephemeral-platform-evidence",
      input.ephemeralPlatform.evidencePath,
    );
  }
  return args;
}

export function buildFactoryPreclaimVerifyInvocation(
  input,
  endpoint,
  sshKnownHostsPath = null,
) {
  const accepted = validateFactoryImageAcceptanceInput(input);
  return [
    "node",
    "scripts/testbed/win10-vem-e2e.mjs",
    "--mode",
    "factory-preclaim-verify",
    ...commonVerifierArgs(accepted, endpoint, {
      ephemeralPlatform: false,
      sshKnownHostsPath,
    }),
    "--out",
    verifierOutput(accepted, "factory-preclaim-verify.json"),
  ];
}

export function buildFactoryMachineClaimInvocation(
  input,
  endpoint,
  sshKnownHostsPath = null,
) {
  const accepted = validateFactoryImageAcceptanceInput(input);
  return [
    "node",
    "scripts/testbed/win10-vem-e2e.mjs",
    "--mode",
    "provision",
    ...commonVerifierArgs(accepted, endpoint, { sshKnownHostsPath }),
    "--out",
    verifierOutput(accepted, "machine-claim.json"),
  ];
}

export function buildFactoryRuntimeAcceptanceInvocation(
  input,
  endpoint,
  sshKnownHostsPath = null,
) {
  const accepted = validateFactoryImageAcceptanceInput(input);
  return [
    "node",
    "scripts/testbed/win10-vem-e2e.mjs",
    "--mode",
    "runtime-acceptance",
    ...commonVerifierArgs(accepted, endpoint, { sshKnownHostsPath }),
    "--out",
    verifierOutput(accepted, "runtime-acceptance.json"),
  ];
}

export function buildFactoryInstalledKioskSaleInvocation(
  input,
  endpoint,
  runtimeAcceptance,
  sshKnownHostsPath = null,
) {
  const accepted = validateFactoryImageAcceptanceInput(input);
  const displayBinding = runtimeAcceptance?.displayBinding;
  if (
    displayBinding?.activeKioskSession?.sessionUser !== "VEMKiosk" ||
    !Number.isInteger(displayBinding.activeKioskSession.sessionId) ||
    displayBinding.activeKioskSession.sessionId < 1 ||
    typeof displayBinding.cdpTargetId !== "string" ||
    displayBinding.cdpTargetId.length === 0
  ) {
    throw new Error(
      "installed kiosk sale acceptance requires VEMKiosk runtime display binding",
    );
  }
  return [
    "node",
    "scripts/testbed/installed-kiosk-sale-acceptance.mjs",
    ...commonVerifierArgs(accepted, endpoint, { sshKnownHostsPath }),
    "--runtime-acceptance-report",
    verifierOutput(accepted, "runtime-acceptance.json"),
    "--adapter",
    process.env.VEM_VM_HOST_ADAPTER ?? "runner-service-adapter",
    "--target-identity",
    accepted.targetIdentity,
    "--approved-runtime-base",
    accepted.factory.isoIdentity,
    "--profile",
    "factory-route-competition",
    "--already-claimed",
    "--out",
    verifierOutput(accepted, "customer-ui-sale-scenario.json"),
  ];
}

function runExact(command, failureMessage, env) {
  const childEnvironment = env ? { ...env } : { ...process.env };
  delete childEnvironment.VEM_FACTORY_EPHEMERAL_DATABASE_URL;
  delete childEnvironment.VEM_INSTALLED_KIOSK_SALE_DATABASE_URL;
  if (env?.VEM_INSTALLED_KIOSK_SALE_DATABASE_URL) {
    childEnvironment.VEM_INSTALLED_KIOSK_SALE_DATABASE_URL =
      env.VEM_INSTALLED_KIOSK_SALE_DATABASE_URL;
  }
  const result = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    env: childEnvironment,
  });
  if (result.status !== 0) throw new Error(failureMessage);
}

function verifyClaimResult(path, input) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const claim = report?.provisioning?.actions?.find(
    (action) => action?.name === "daemon IPC provisioning claim",
  );
  const evidence = claim?.evidence;
  if (
    report?.ok !== true ||
    !["passed", "succeeded"].includes(claim?.status) ||
    evidence?.runId !== input.runId ||
    evidence?.expectedMachineCode !== input.ephemeralPlatform.machineCode ||
    evidence?.platformTarget !== input.ephemeralPlatform.platformTarget
  ) {
    throw new Error(
      "Machine Claim did not produce successful same-run daemon IPC evidence",
    );
  }
  return { status: "passed", claim: "daemon-ipc", runId: input.runId };
}

function verifyPreclaimResult(path, input) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  if (
    report?.schemaVersion !== "factory-preclaim-verification/v1" ||
    report?.kind !== "factory-preclaim-verification" ||
    report?.runId !== input.runId ||
    report?.expectedUnclaimedMachineCode !==
      input.ephemeralPlatform.machineCode ||
    report?.readOnly !== true ||
    report?.ok !== true ||
    report?.checks?.factoryRuntime?.ok !== true ||
    report?.checks?.absentMachineIdentity?.asserted !== true ||
    report?.checks?.oobeComplete?.asserted !== true ||
    report?.checks?.oobeComplete?.cleanupPhase !== "complete" ||
    report?.checks?.oobeComplete?.cleanupTaskPresent !== false ||
    report?.checks?.oobeComplete?.postRebootBootIdentityChanged !== true ||
    report?.checks?.oobeComplete?.activeVemKioskConsoleSession !== true
  ) {
    throw new Error(
      "Factory preclaim verification did not prove post-reboot OOBE cleanup, installed runtime, and absent machine identity",
    );
  }
  return { status: "passed", readOnly: true, verifier: "factory-runtime" };
}

function verifyRuntimeResult(path) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const runtime = report.runtimeAcceptanceReport;
  if (
    report.ok !== true ||
    runtime?.schemaVersion !== "runtime-acceptance-report/v1" ||
    runtime.result?.runtimeReady?.asserted !== true ||
    runtime.kioskRuntime?.sessionUser !== "VEMKiosk" ||
    !Number.isInteger(runtime.kioskRuntime?.sessionId) ||
    runtime.kioskRuntime.sessionId < 1 ||
    !/^http:\/\/tauri\.localhost\/#\//.test(runtime.kioskRuntime?.url ?? "") ||
    typeof runtime.kioskRuntime?.cdpTargetId !== "string" ||
    runtime.kioskRuntime.cdpTargetId.length === 0
  ) {
    throw new Error(
      "runtime acceptance did not produce a runtime-ready assertion",
    );
  }
  return {
    status: "passed",
    runtimeReady: {
      status: runtime.result.runtimeReady.status,
      asserted: true,
    },
    displayBinding: {
      activeKioskSession: {
        sessionUser: runtime.kioskRuntime.sessionUser,
        sessionId: runtime.kioskRuntime.sessionId,
      },
      tauriRoute: runtime.kioskRuntime.url,
      cdpTargetId: runtime.kioskRuntime.cdpTargetId,
    },
  };
}

function assertPhysicalInputActivations(report) {
  const activations =
    report.evidence?.filter((entry) => entry?.type === "customer-activation") ??
    [];
  if (
    activations.length < 1 ||
    report.execution?.planned?.customerActivations !==
      report.execution?.executed?.customerActivations ||
    report.execution.executed.customerActivations < 1 ||
    activations.some(
      (entry) =>
        typeof entry.input?.method !== "string" ||
        !entry.input.method.startsWith("Input.") ||
        entry.input.released !== true,
    )
  ) {
    throw new Error(
      "installed kiosk sale scenario must prove physical Input activations",
    );
  }
}

function hasOneObservedIdentity(observation, expected) {
  return (
    Array.isArray(observation?.occurrences) &&
    observation.occurrences.length === 1 &&
    Array.isArray(observation?.unique) &&
    observation.unique.length === 1 &&
    observation.unique[0] === expected &&
    observation.count === 1
  );
}

function hasReservationExactOnce(reservation, observation, count, orderId) {
  if (
    !reservation ||
    typeof reservation.source !== "string" ||
    !Number.isSafeInteger(reservation.rawRecordCount) ||
    typeof reservation.reservationId !== "string" ||
    typeof reservation.orderId !== "string" ||
    typeof reservation.orderItemId !== "string" ||
    typeof reservation.inventoryId !== "string" ||
    !Number.isSafeInteger(reservation.quantity)
  ) {
    return false;
  }
  return (
    reservation.exposed === true &&
    reservation.source ===
      "authoritative_ephemeral_platform.inventory_reservations" &&
    reservation.rawRecordCount === 1 &&
    reservation.orderId === orderId &&
    reservation.quantity === 1 &&
    reservation.status === "confirmed" &&
    count === 1 &&
    hasOneObservedIdentity(observation, reservation.reservationId)
  );
}

function hasOrderItemExactOnce(orderItem, observation, count, orderId) {
  return (
    typeof orderItem?.id === "string" &&
    typeof orderItem?.inventoryId === "string" &&
    typeof orderItem?.slotId === "string" &&
    orderItem.orderId === orderId &&
    orderItem.quantity === 1 &&
    count === 1 &&
    hasOneObservedIdentity(observation, orderItem.id)
  );
}

export function verifyInstalledKioskSaleScenarioResult(
  path,
  input,
  runtimeAcceptance,
) {
  const report = JSON.parse(readFileSync(path, "utf8"));
  const displayBinding = runtimeAcceptance.displayBinding;
  const session = displayBinding.activeKioskSession;
  const scenario = report?.machineUiCdpScenario;
  const runtime = report?.runtimeBinding;
  const correlation = report?.correlation;
  const exactOnce = correlation?.exactOnce;
  const observations = correlation?.platform?.observations;
  const orderItem = correlation?.platform?.orderItem;
  const reservation = correlation?.platform?.reservation;
  const continuousEvidence = scenario?.evidence?.filter(
    (entry) => entry?.type === "checkpoint" && entry?.label === "continuous",
  );
  const barrierIndex = scenario?.evidence?.findIndex(
    (entry) => entry?.type === "route-barrier",
  );
  const barrier =
    barrierIndex != null && barrierIndex >= 0
      ? scenario?.evidence?.[barrierIndex]
      : null;
  const barrierArmBaseline = barrier?.armBaseline;
  const routesAfterBarrier = scenario?.evidence
    ?.slice((barrierIndex ?? -1) + 1)
    .flatMap((entry) => [
      entry?.identity?.route,
      entry?.routeBefore,
      entry?.routeAfter,
    ])
    .filter((route) => typeof route === "string");
  const nonPaymentRouteAfterBarrier = routesAfterBarrier?.some(
    (route) => !isPaymentBarrierRoute(route),
  );
  if (
    report?.schemaVersion !== "installed-kiosk-sale-acceptance/v2" ||
    report.status !== "passed" ||
    report.profile !== "factory-route-competition" ||
    scenario?.schemaVersion !== "machine-ui-cdp-sale-scenario/v3" ||
    scenario.status !== "passed" ||
    runtime?.normal?.sessionUser !== "VEMKiosk" ||
    runtime.normal.sessionId !== session.sessionId ||
    runtime.normal.url !== displayBinding.tauriRoute ||
    runtime.normal.normalTargetId !== displayBinding.cdpTargetId ||
    runtime?.prelaunch?.executablePath !== "C:\\VEM\\bringup\\machine.exe" ||
    runtime.prelaunch.sessionId !== session.sessionId ||
    !String(runtime.prelaunch.principal ?? "").endsWith("\\VEMKiosk") ||
    runtime?.debug?.machine?.executablePath !==
      runtime.prelaunch.executablePath ||
    runtime.debug.machine.sessionId !== runtime.prelaunch.sessionId ||
    runtime.debug.machine.principal !== runtime.prelaunch.principal ||
    scenario.target?.id !== runtime.debug.targetId ||
    scenario.target?.attestation?.observed?.cdpTarget?.id !==
      runtime.debug.targetId ||
    !Array.isArray(continuousEvidence) ||
    continuousEvidence.length < 1 ||
    barrierIndex == null ||
    barrierIndex < 0 ||
    barrier?.armedBeforeInput !== true ||
    barrierArmBaseline?.route !== "#/checkout" ||
    barrierArmBaseline?.identity?.route !== "#/checkout" ||
    !Array.isArray(barrier?.allowedRoutes) ||
    JSON.stringify([...barrier.allowedRoutes].sort()) !==
      JSON.stringify([...PAYMENT_BARRIER_ALLOWED_ROUTES].sort()) ||
    !scenario.evidence?.some(
      (entry) =>
        entry?.type === "route-action" &&
        entry.stimulus === "history-back" &&
        isPaymentBarrierRoute(entry.routeBefore) &&
        isPaymentBarrierRoute(entry.routeAfter) &&
        entry.triggerAcknowledged === true,
    ) ||
    nonPaymentRouteAfterBarrier ||
    exactOnce?.orderCount !== 1 ||
    exactOnce.paymentCount !== 1 ||
    exactOnce.orderNoCount !== 1 ||
    !hasOrderItemExactOnce(
      orderItem,
      observations?.orderItemIds,
      exactOnce?.orderItemCount,
      correlation?.rendered?.orderId,
    ) ||
    !hasReservationExactOnce(
      reservation,
      observations?.reservationIds,
      exactOnce?.reservationCount,
      correlation?.rendered?.orderId,
    ) ||
    exactOnce.commandCount !== 1 ||
    exactOnce.movementCount !== 1 ||
    exactOnce.stockDelta !== -1 ||
    exactOnce.serialSaleBindingCount?.injected !== 1 ||
    exactOnce.serialSaleBindingCount?.collected !== 1 ||
    !hasOneObservedIdentity(
      observations?.orderIds,
      correlation?.rendered?.orderId,
    ) ||
    !hasOneObservedIdentity(
      observations?.paymentIds,
      correlation?.rendered?.paymentId,
    ) ||
    !hasOneObservedIdentity(
      observations?.orderNos,
      correlation?.rendered?.orderNo,
    ) ||
    !hasOneObservedIdentity(
      observations?.commandIds,
      correlation?.rendered?.commandId,
    ) ||
    !hasOneObservedIdentity(
      observations?.movementIds,
      correlation?.platform?.stockMovementId,
    )
  ) {
    throw new Error(
      "installed kiosk sale acceptance did not prove the v2 VEMKiosk, route-barrier, and exact-once contract",
    );
  }
  assertPhysicalInputActivations(scenario);
  if (
    correlation.rendered?.orderId !== correlation.platform?.orderId ||
    correlation.rendered?.paymentId !== correlation.platform?.paymentId ||
    correlation.rendered?.orderNo !== correlation.platform?.orderNo ||
    correlation.rendered?.commandId !== correlation.platform?.commandId ||
    correlation.platform?.stockDelta !== -1 ||
    correlation.platform?.status !== "accepted" ||
    correlation.serial?.collected?.orderId !== correlation.rendered.orderId ||
    correlation.serial?.collected?.paymentId !==
      correlation.rendered.paymentId ||
    correlation.serial?.collected?.vendingCommandId !==
      correlation.rendered.commandId
  ) {
    throw new Error(
      "installed kiosk sale acceptance did not correlate rendered payment, serial command, and stock movement",
    );
  }
  return {
    status: "passed",
    schemaVersion: report.schemaVersion,
    target: {
      id: runtime.debug.targetId,
      route: scenario.target.route,
      sessionUser: "VEMKiosk",
      sessionId: session.sessionId,
    },
    linkedSale: {
      orderId: correlation.rendered.orderId,
      paymentId: correlation.rendered.paymentId,
      orderNo: correlation.rendered.orderNo,
      orderItem,
      reservation: correlation.platform.reservation,
      commandId: correlation.rendered.commandId,
      stockMovementId: correlation.platform.stockMovementId,
    },
    routeCompetitionCase: "catalog_during_payment",
  };
}

export function sanitizeFactoryAcceptanceEvidence(value) {
  if (value === null || value === undefined || typeof value === "boolean")
    return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    return ABSOLUTE_HOST_PATH.test(value)
      ? "[REDACTED]"
      : value.replace(
          /\b(claimCode|token|secret|password|credential|apiKey)\b\s*[:=]\s*[^\s,;}]+/gi,
          "$1=[REDACTED]",
        );
  }
  if (Array.isArray(value)) return value.map(sanitizeFactoryAcceptanceEvidence);
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SENSITIVE_KEY.test(key))
      .map(([key, item]) => [key, sanitizeFactoryAcceptanceEvidence(item)]),
  );
}

function assertUploadValue(value, label = "evidence") {
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (typeof value === "string") {
    if (ABSOLUTE_HOST_PATH.test(value))
      throw new Error(`${label} contains an absolute host path`);
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i.test(value)) {
      throw new Error(`${label} contains private material`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      assertUploadValue(item, `${label}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object")
    throw new Error(`${label} is unsupported`);
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key))
      throw new Error(`${label} contains a credential field: ${key}`);
    assertUploadValue(item, `${label}.${key}`);
  }
}

function artifactFiles(root, current = root) {
  const files = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink())
      throw new Error("sanitized upload rejects symbolic links");
    if (metadata.isDirectory()) files.push(...artifactFiles(root, path));
    else if (metadata.isFile()) files.push(relative(root, path));
    else throw new Error("sanitized upload accepts regular files only");
  }
  return files;
}

export function prepareSanitizedFactoryAcceptanceUpload({ source, upload }) {
  const sourceRoot = resolve(source);
  const uploadRoot = resolve(upload);
  rmSync(uploadRoot, { recursive: true, force: true });
  if (!existsSync(sourceRoot)) return [];
  const copied = [];
  for (const file of artifactFiles(sourceRoot)) {
    const parts = file.split(sep);
    if (!ARTIFACT_DIRECTORIES.has(parts[0])) {
      throw new Error(
        `sanitized upload rejects artifact outside allowlist: ${file}`,
      );
    }
    const extension = basename(file).split(".").at(-1)?.toLowerCase();
    if (!["json", "png", "jpg", "jpeg", "webp"].includes(extension)) {
      throw new Error(`sanitized upload rejects artifact type: ${file}`);
    }
    const sourcePath = join(sourceRoot, file);
    const targetPath = join(uploadRoot, file);
    mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
    if (extension === "json") {
      const sanitized = sanitizeFactoryAcceptanceEvidence(
        JSON.parse(readFileSync(sourcePath, "utf8")),
      );
      assertUploadValue(sanitized, file);
      writeFileSync(targetPath, `${JSON.stringify(sanitized, null, 2)}\n`, {
        mode: 0o600,
      });
    } else {
      copyFileSync(sourcePath, targetPath, 0);
    }
    copied.push(file);
  }
  return copied.sort();
}

function assertCleanup(report) {
  const cleanup = report?.cleanup;
  if (
    cleanup?.status !== "completed" ||
    cleanup.overlayDisposition !== "removed" ||
    cleanup.observed?.overlay !== "removed" ||
    cleanup.observed?.runDirectory !== "removed" ||
    cleanup.observed?.personalizationMedia !== "removed"
  ) {
    throw new Error(
      "adapter cleanup did not prove overlay and personalization removal",
    );
  }
}

export function materializeFactoryDisplayEvidence(input, report) {
  const evidence = report.evidence?.find(
    (entry) => entry.role === "display-capture",
  );
  if (!evidence?.fileName) {
    throw new Error(
      "display capture report did not name materialized evidence",
    );
  }
  const exportDirectory = join(input.evidence.root, "adapter-export");
  const operationDirectory = join(
    exportDirectory,
    report.request.runId,
    report.request.operationReference.slice("vm-operation://".length),
  );
  const source = resolve(operationDirectory, evidence.fileName);
  if (!source.startsWith(`${resolve(operationDirectory)}${sep}`)) {
    throw new Error(
      "display evidence fileName escapes runner export directory",
    );
  }
  const sourceEvidence = readAndHashRegularFile(
    source,
    "display evidence export",
  );
  if (sourceEvidence.digest !== evidence.digest) {
    throw new Error("display evidence export does not match adapter digest");
  }
  const target = join(input.evidence.root, "screenshots", evidence.fileName);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target, 0);
  if (
    readAndHashRegularFile(target, "materialized display evidence").digest !==
    evidence.digest
  ) {
    throw new Error(
      "materialized display evidence does not match adapter digest",
    );
  }
  return {
    status: "copied",
    role: evidence.role,
    identity: evidence.identity,
    digest: evidence.digest,
    fileName: evidence.fileName,
  };
}

function assertSameBase(expected, report) {
  const actual = asset("approved-runtime-base", report.observed.baseIdentity);
  if (
    actual.identity !== expected.identity ||
    actual.digest !== expected.digest
  ) {
    throw new Error("post-cleanup approved base identity or digest changed");
  }
}

export function adapterEnvironment(operation, environment = process.env) {
  const timeout = environment.VEM_FACTORY_CLEAN_INSTALL_ADAPTER_TIMEOUT_MS;
  if (operation !== "clean-install" || timeout === undefined)
    return environment;
  return { ...environment, VEM_VM_HOST_ADAPTER_TIMEOUT_MS: timeout };
}

async function runAdapter(
  input,
  operation,
  assets,
  media = null,
  displayBinding = null,
) {
  return runVmHostAdapter({
    request: adapterRequest(input, operation, assets, media, displayBinding),
    workDirectory: join(
      process.env.RUNNER_TEMP ?? ".",
      "factory-image-acceptance",
    ),
    environment: adapterEnvironment(operation),
    evidenceDirectory: join(input.evidence.root, "adapter-export"),
  });
}

async function runCleanupOnly(input) {
  const iso = asset("factory-iso", input.factory.isoIdentity);
  const report = await runAdapter(input, "cleanup", [
    asset("approved-runtime-base", input.factory.isoIdentity),
    iso,
  ]);
  assertCleanup(report);
  mkdirSync(dirname(input.evidence.lifecycleReport), {
    recursive: true,
    mode: 0o700,
  });
  writeFileSync(
    join(dirname(input.evidence.lifecycleReport), "adapter-cleanup.json"),
    `${JSON.stringify(sanitizeFactoryAcceptanceEvidence({ status: "passed", cleanup: report.cleanup }), null, 2)}\n`,
    { mode: 0o600 },
  );
  prepareSanitizedFactoryAcceptanceUpload({
    source: input.evidence.root,
    upload: input.evidence.sanitizedUpload,
  });
}

async function runAdmittedFactoryImageAcceptanceLifecycleWithSshTrust(
  input,
  admission,
  sshKnownHostsPath,
) {
  const iso = asset("factory-iso", input.factory.isoIdentity);
  const personalisation = asset(
    "factory-personalization-media",
    process.env.VEM_VM_HOST_FACTORY_PERSONALIZATION_MEDIA_ID ?? "",
  );
  mkdirSync(join(input.evidence.root, "verifier"), {
    recursive: true,
    mode: 0o700,
  });
  const reports = { admission: { status: "passed", ...admission } };
  let approvedBase = input.factory.isoIdentity;
  let capturedBase = null;
  let preclaimEvidence = null;
  try {
    reports.cleanInstall = await runAdapter(
      input,
      "clean-install",
      [iso, personalisation],
      factoryMedia(input),
    );
    const preclaim = buildFactoryPreclaimVerifyInvocation(
      input,
      reports.cleanInstall.guest.maintenanceEndpoint,
      sshKnownHostsPath,
    );
    runExact(preclaim, "Factory preclaim verification failed");
    const preclaimPath = verifierOutput(input, "factory-preclaim-verify.json");
    reports.preclaimVerify = verifyPreclaimResult(preclaimPath, input);
    preclaimEvidence = readAndHashRegularFile(
      preclaimPath,
      "Factory preclaim verifier evidence",
    );
    reports.preclaimVerify.evidenceDigest = preclaimEvidence.digest;
    reports.captureApprovedBase = await runAdapter(
      input,
      "capture-approved-base",
      [iso],
      factoryMedia(input),
    );
    approvedBase = reports.captureApprovedBase.observed.baseIdentity;
    const base = asset("approved-runtime-base", approvedBase);
    capturedBase = base;
    reports.overlay = await runAdapter(input, "create-disposable-overlay", [
      base,
    ]);
    reports.ephemeralPlatform = {
      status: existsSync(input.ephemeralPlatform.evidencePath)
        ? "bound"
        : "missing",
    };
    if (reports.ephemeralPlatform.status !== "bound") {
      throw new Error(
        "ephemeral platform evidence is unavailable before Machine Claim",
      );
    }
    const endpoint = reports.overlay.guest.maintenanceEndpoint;
    const claim = buildFactoryMachineClaimInvocation(
      input,
      endpoint,
      sshKnownHostsPath,
    );
    runExact(claim, "Machine Claim failed");
    reports.machineClaim = verifyClaimResult(
      verifierOutput(input, "machine-claim.json"),
      input,
    );
    const runtime = buildFactoryRuntimeAcceptanceInvocation(
      input,
      endpoint,
      sshKnownHostsPath,
    );
    runExact(runtime, "runtime acceptance failed");
    reports.runtimeAcceptance = verifyRuntimeResult(
      verifierOutput(input, "runtime-acceptance.json"),
    );
    const customerSale = buildFactoryInstalledKioskSaleInvocation(
      input,
      endpoint,
      reports.runtimeAcceptance,
      sshKnownHostsPath,
    );
    const databaseUrl = nonEmpty(
      process.env.VEM_FACTORY_EPHEMERAL_DATABASE_URL,
      "VEM_FACTORY_EPHEMERAL_DATABASE_URL",
    );
    runExact(
      customerSale,
      "installed kiosk customer UI sale acceptance failed",
      {
        ...process.env,
        VEM_INSTALLED_KIOSK_SALE_DATABASE_URL: databaseUrl,
      },
    );
    reports.customerUiSale = verifyInstalledKioskSaleScenarioResult(
      verifierOutput(input, "customer-ui-sale-scenario.json"),
      input,
      reports.runtimeAcceptance,
    );
    const display = await runAdapter(
      input,
      "capture-display",
      [base],
      null,
      reports.runtimeAcceptance.displayBinding,
    );
    reports.display = {
      ...display,
      materializedEvidence: materializeFactoryDisplayEvidence(input, display),
    };
  } finally {
    try {
      reports.cleanup = await runAdapter(input, "cleanup", [
        asset("approved-runtime-base", approvedBase),
      ]);
      assertCleanup(reports.cleanup);
    } finally {
      if (capturedBase && preclaimEvidence) {
        try {
          const recapture = await runAdapter(
            input,
            "capture-approved-base",
            [iso],
            factoryMedia(input),
          );
          assertSameBase(capturedBase, recapture);
          const rehashedPreclaimEvidence = readAndHashRegularFile(
            verifierOutput(input, "factory-preclaim-verify.json"),
            "Factory preclaim verifier evidence",
          );
          if (rehashedPreclaimEvidence.digest !== preclaimEvidence.digest) {
            throw new Error(
              "Factory preclaim verifier evidence changed after cleanup",
            );
          }
          reports.postCleanup = {
            captureApprovedBase: recapture,
            preclaimEvidence: {
              digest: rehashedPreclaimEvidence.digest,
              unchanged: true,
            },
          };
        } finally {
          reports.postCleanup ??= {};
          reports.postCleanup.finalCleanup = await runAdapter(
            input,
            "cleanup",
            [capturedBase],
          );
          assertCleanup(reports.postCleanup.finalCleanup);
        }
      }
      mkdirSync(dirname(input.evidence.lifecycleReport), {
        recursive: true,
        mode: 0o700,
      });
      writeFileSync(
        input.evidence.lifecycleReport,
        `${JSON.stringify(sanitizeFactoryAcceptanceEvidence({ schemaVersion: "factory-image-acceptance-lifecycle/v1", runId: input.runId, reports }), null, 2)}\n`,
        { mode: 0o600 },
      );
      prepareSanitizedFactoryAcceptanceUpload({
        source: input.evidence.root,
        upload: input.evidence.sanitizedUpload,
      });
    }
  }
}

export async function runAdmittedFactoryImageAcceptanceLifecycle(
  input,
  admission,
) {
  const tempRoot = process.env.RUNNER_TEMP ?? tmpdir();
  mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
  const sshTrustDirectory = mkdtempSync(join(tempRoot, "factory-ssh-trust-"));
  try {
    return await runAdmittedFactoryImageAcceptanceLifecycleWithSshTrust(
      input,
      admission,
      join(sshTrustDirectory, "known_hosts"),
    );
  } finally {
    rmSync(sshTrustDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const input = readProtectedInput();
  if (process.argv[2] === "--cleanup-only") await runCleanupOnly(input);
  else
    await runAdmittedFactoryImageAcceptanceLifecycle(
      input,
      await admitFactoryInput(input),
    );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Factory image acceptance failed",
    );
    process.exitCode = 1;
  });
}
