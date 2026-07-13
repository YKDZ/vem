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
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import { admitFactoryAcceptance } from "../factory/factory-acceptance-admission.mjs";
import {
  createVmHostAdapterRequest,
  runVmHostAdapter,
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
  exactKeys(input.endpoint, ["expectedTestbedUser"], "endpoint");
  nonEmpty(input.endpoint.expectedTestbedUser, "endpoint.expectedTestbedUser");
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

function adapterRequest(input, operation, assets, factoryMedia = null) {
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
  return createVmHostAdapterRequest({
    schemaVersion: "vem-vm-host-adapter-request/v1",
    kind: "vm-host-adapter-request",
    operation,
    runId: input.runId,
    operationNonce: nonce,
    operationReference: `vm-operation://${nonce}`,
    lifecycleReference: lifecycleReference(input),
    cancelOperationReference: null,
    target: { identity: input.targetIdentity },
    factoryMedia,
    audioCapture: null,
    assets,
    requestedCapabilities: capabilities,
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

function endpointArgument(endpoint) {
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
  return JSON.stringify(endpoint);
}

function verifierOutput(input, name) {
  return join(input.evidence.root, "verifier", name);
}

function commonVerifierArgs(
  input,
  endpoint,
  { ephemeralPlatform = true } = {},
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
    endpointArgument(endpoint),
  ];
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

export function buildFactoryPreclaimVerifyInvocation(input, endpoint) {
  const accepted = validateFactoryImageAcceptanceInput(input);
  return [
    "node",
    "scripts/testbed/win10-vem-e2e.mjs",
    "--mode",
    "factory-preclaim-verify",
    ...commonVerifierArgs(accepted, endpoint, { ephemeralPlatform: false }),
    "--out",
    verifierOutput(accepted, "factory-preclaim-verify.json"),
  ];
}

export function buildFactoryMachineClaimInvocation(input, endpoint) {
  const accepted = validateFactoryImageAcceptanceInput(input);
  return [
    "node",
    "scripts/testbed/win10-vem-e2e.mjs",
    "--mode",
    "provision",
    ...commonVerifierArgs(accepted, endpoint),
    "--out",
    verifierOutput(accepted, "machine-claim.json"),
  ];
}

export function buildFactoryRuntimeAcceptanceInvocation(input, endpoint) {
  const accepted = validateFactoryImageAcceptanceInput(input);
  return [
    "node",
    "scripts/testbed/win10-vem-e2e.mjs",
    "--mode",
    "runtime-acceptance",
    ...commonVerifierArgs(accepted, endpoint),
    "--out",
    verifierOutput(accepted, "runtime-acceptance.json"),
  ];
}

function runExact(command, failureMessage) {
  const result = spawnSync(command[0], command.slice(1), {
    stdio: "inherit",
    env: process.env,
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
    report?.checks?.absentMachineIdentity?.asserted !== true
  ) {
    throw new Error(
      "Factory preclaim verification did not prove installed runtime and absent machine identity",
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
    runtime.result?.runtimeReady?.asserted !== true
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
  const exportDirectory = absolutePath(
    process.env.VEM_VM_HOST_EVIDENCE_EXPORT_DIR,
    "VEM_VM_HOST_EVIDENCE_EXPORT_DIR",
  );
  const source = resolve(exportDirectory, evidence.fileName);
  if (!source.startsWith(`${resolve(exportDirectory)}${sep}`)) {
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

async function runAdapter(input, operation, assets, media = null) {
  return runVmHostAdapter({
    request: adapterRequest(input, operation, assets, media),
    workDirectory: join(
      process.env.RUNNER_TEMP ?? ".",
      "factory-image-acceptance",
    ),
    environment: adapterEnvironment(operation),
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

export async function runAdmittedFactoryImageAcceptanceLifecycle(
  input,
  admission,
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
    const claim = buildFactoryMachineClaimInvocation(input, endpoint);
    runExact(claim, "Machine Claim failed");
    reports.machineClaim = verifyClaimResult(
      verifierOutput(input, "machine-claim.json"),
      input,
    );
    const runtime = buildFactoryRuntimeAcceptanceInvocation(input, endpoint);
    runExact(runtime, "runtime acceptance failed");
    reports.runtimeAcceptance = verifyRuntimeResult(
      verifierOutput(input, "runtime-acceptance.json"),
    );
    const display = await runAdapter(input, "capture-display", [base]);
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
