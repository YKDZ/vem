import Ajv2020 from "ajv/dist/2020.js";
import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { readFileSync } from "node:fs";

import { canonicalJson } from "./factory-manifest.mjs";

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const EVIDENCE_IDENTITY = /^factory-evidence:\/\/sha256\/([a-f0-9]{64})$/;
const SEMVER =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SAFE_RELATIVE_PATH =
  /^(?![\\/])(?!.*(?:^|[\\/])\.\.(?:[\\/]|$))[A-Za-z0-9][A-Za-z0-9._-]*(?:[\\/][A-Za-z0-9][A-Za-z0-9._-]*)*$/;

const schemaValidator = new Ajv2020({ allErrors: true, strict: true });
const visionSchemas = Object.fromEntries(
  [
    ["descriptor", "vision-release-descriptor-v1.schema.json"],
    ["attestation", "vision-artifact-attestation-v1.schema.json"],
    ["approval", "vision-release-approval-v1.schema.json"],
    ["conformance", "vision-conformance-v1.schema.json"],
    ["trustPolicy", "vision-release-trust-policy-v1.schema.json"],
  ].map(([name, file]) => [
    name,
    schemaValidator.compile(
      JSON.parse(
        readFileSync(new URL(`../../public/${file}`, import.meta.url), "utf8"),
      ),
    ),
  ]),
);

function validateSchema(name, value) {
  const validate = visionSchemas[name];
  if (!validate(value)) {
    throw new Error(
      `Vision ${name} schema is invalid: ${schemaValidator.errorsText(validate.errors)}`,
    );
  }
}

function digestJson(value) {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function verifyDocumentSignature({
  role,
  bytes,
  signature,
  approvedIdentities,
}) {
  exactKeys(signature, ["signer", "signature"], `${role} signature`);
  exactKeys(signature.signer, ["identity", "publicKey"], `${role} signer`);
  const publicKeyDer = Buffer.from(signature.signer.publicKey, "base64");
  const identity = `spki-sha256:${createHash("sha256").update(publicKeyDer).digest("hex")}`;
  if (identity !== signature.signer.identity) {
    throw new Error(`${role} signer identity does not match its public key`);
  }
  if (!approvedIdentities?.[role]?.includes(identity)) {
    throw new Error(`${role} is not signed by an approved identity`);
  }
  const statement = Buffer.from(
    canonicalJson({ role, digest: digestBytes(bytes) }),
  );
  const publicKey = createPublicKey({
    key: publicKeyDer,
    format: "der",
    type: "spki",
  });
  if (
    !verifySignature(
      null,
      statement,
      publicKey,
      Buffer.from(signature.signature, "base64"),
    )
  ) {
    throw new Error(`${role} signature verification failed`);
  }
  return identity;
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((key, index) => key !== wanted[index])
  ) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

function assertDigest(value, label) {
  if (!DIGEST.test(value ?? "")) {
    throw new Error(`${label} must be a lowercase sha256 digest`);
  }
}

function assertEvidenceReference(value, label) {
  if (!EVIDENCE_IDENTITY.test(value?.identity ?? "")) {
    throw new Error(
      `${label}.identity must be a content-addressed evidence identity`,
    );
  }
  assertDigest(value.digest, `${label}.digest`);
  if (
    value.identity !== `factory-evidence://${value.digest.replace(":", "/")}`
  ) {
    throw new Error(`${label} identity and digest must match`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function validateDescriptorCore(descriptor) {
  exactKeys(
    descriptor,
    [
      "schemaVersion",
      "kind",
      "identity",
      "releaseVersion",
      "bundle",
      "entrypoint",
      "lifecycle",
      "configuration",
      "health",
      "protocol",
      "sbom",
      "provenance",
    ],
    "Vision release descriptor",
  );
  if (descriptor.schemaVersion !== "vem-vision-release-descriptor/v1") {
    throw new Error("Vision release descriptor schemaVersion is invalid");
  }
  if (descriptor.kind !== "vision-release-descriptor") {
    throw new Error("Vision release descriptor kind is invalid");
  }
  if (!SEMVER.test(descriptor.releaseVersion ?? "")) {
    throw new Error(
      "Vision release descriptor releaseVersion must be a strict semantic version",
    );
  }
  exactKeys(
    descriptor.bundle,
    ["digest", "bytes", "platform", "format", "extractor"],
    "Vision bundle",
  );
  assertDigest(descriptor.bundle.digest, "Vision bundle.digest");
  if (
    !Number.isSafeInteger(descriptor.bundle.bytes) ||
    descriptor.bundle.bytes < 1
  ) {
    throw new Error("Vision bundle.bytes must be a positive safe integer");
  }
  exactKeys(
    descriptor.bundle.platform,
    ["os", "architecture"],
    "Vision bundle.platform",
  );
  if (descriptor.bundle.platform.os !== "windows") {
    throw new Error("Vision bundle.platform.os must be windows");
  }
  if (!["x86_64", "arm64"].includes(descriptor.bundle.platform.architecture)) {
    throw new Error("Vision bundle.platform.architecture is unsupported");
  }
  if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(descriptor.bundle.format ?? "")) {
    throw new Error("Vision bundle.format must be a declared immutable format");
  }
  exactKeys(
    descriptor.bundle.extractor,
    ["contractVersion", "handler"],
    "Vision bundle.extractor",
  );
  if (
    descriptor.bundle.extractor.contractVersion !== "vem-vision-extractor/v1" ||
    !["zip-safe-v1", "vendor-installer-v1"].includes(
      descriptor.bundle.extractor.handler,
    )
  ) {
    throw new Error("Vision bundle extractor contract is unsupported");
  }

  exactKeys(
    descriptor.entrypoint,
    ["command", "arguments"],
    "Vision entrypoint",
  );
  if (!SAFE_RELATIVE_PATH.test(descriptor.entrypoint.command ?? "")) {
    throw new Error("Vision entrypoint.command must be a safe relative path");
  }
  if (
    !Array.isArray(descriptor.entrypoint.arguments) ||
    !descriptor.entrypoint.arguments.every(
      (argument) => typeof argument === "string" && argument.length <= 1024,
    )
  ) {
    throw new Error("Vision entrypoint.arguments must be bounded strings");
  }

  exactKeys(
    descriptor.lifecycle,
    ["requiresInteractiveSession", "shutdownTimeoutMs"],
    "Vision lifecycle",
  );
  if (descriptor.lifecycle.requiresInteractiveSession !== true) {
    throw new Error(
      "Vision lifecycle must require the established interactive session",
    );
  }
  if (
    !Number.isSafeInteger(descriptor.lifecycle.shutdownTimeoutMs) ||
    descriptor.lifecycle.shutdownTimeoutMs < 100 ||
    descriptor.lifecycle.shutdownTimeoutMs > 120000
  ) {
    throw new Error("Vision lifecycle.shutdownTimeoutMs is invalid");
  }

  exactKeys(
    descriptor.configuration,
    ["format", "schemaVersion", "argument"],
    "Vision configuration",
  );
  if (!["json", "yaml", "toml"].includes(descriptor.configuration.format)) {
    throw new Error("Vision configuration.format is unsupported");
  }
  assertNonEmptyString(
    descriptor.configuration.schemaVersion,
    "Vision configuration.schemaVersion",
  );
  if (
    !/^--[A-Za-z0-9][A-Za-z0-9-]*$/.test(
      descriptor.configuration.argument ?? "",
    )
  ) {
    throw new Error("Vision configuration.argument must be one safe option");
  }

  exactKeys(
    descriptor.health,
    ["port", "path", "expectedStatus", "timeoutMs"],
    "Vision health",
  );
  if (
    !Number.isSafeInteger(descriptor.health.port) ||
    descriptor.health.port < 1 ||
    descriptor.health.port > 65535
  ) {
    throw new Error("Vision health.port must be a loopback TCP port");
  }
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(descriptor.health.path ?? "")) {
    throw new Error("Vision health.path must be a loopback-relative path");
  }
  if (
    !Number.isSafeInteger(descriptor.health.expectedStatus) ||
    descriptor.health.expectedStatus < 200 ||
    descriptor.health.expectedStatus > 299
  ) {
    throw new Error(
      "Vision health.expectedStatus must be a success HTTP status",
    );
  }
  if (
    !Number.isSafeInteger(descriptor.health.timeoutMs) ||
    descriptor.health.timeoutMs < 100 ||
    descriptor.health.timeoutMs > 120000
  ) {
    throw new Error("Vision health.timeoutMs is invalid");
  }

  exactKeys(
    descriptor.protocol,
    ["version", "webSocketPath"],
    "Vision protocol",
  );
  if (descriptor.protocol.version !== "vem.vision.v1") {
    throw new Error("Vision protocol.version must be vem.vision.v1");
  }
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(descriptor.protocol.webSocketPath ?? "")) {
    throw new Error(
      "Vision protocol.webSocketPath must be a loopback-relative path",
    );
  }
  exactKeys(descriptor.sbom, ["identity", "digest", "format"], "Vision SBOM");
  assertEvidenceReference(descriptor.sbom, "Vision SBOM");
  if (!["spdx-json", "cyclonedx-json"].includes(descriptor.sbom.format)) {
    throw new Error("Vision SBOM format is unsupported");
  }
  exactKeys(
    descriptor.provenance,
    ["identity", "digest", "predicateType"],
    "Vision provenance",
  );
  assertEvidenceReference(descriptor.provenance, "Vision provenance");
  if (
    descriptor.provenance.predicateType !== "https://slsa.dev/provenance/v1"
  ) {
    throw new Error("Vision provenance predicateType is invalid");
  }
}

export function createVisionReleaseDescriptor(input) {
  const descriptor = {
    schemaVersion: "vem-vision-release-descriptor/v1",
    kind: "vision-release-descriptor",
    ...structuredClone(input),
  };
  delete descriptor.identity;
  descriptor.identity = digestJson(descriptor);
  return validateVisionReleaseDescriptor(descriptor);
}

export function validateVisionReleaseDescriptor(descriptor) {
  const candidate = structuredClone(descriptor);
  validateSchema("descriptor", candidate);
  validateDescriptorCore(candidate);
  const withoutIdentity = { ...candidate };
  delete withoutIdentity.identity;
  if (candidate.identity !== digestJson(withoutIdentity)) {
    throw new Error(
      "Vision release descriptor identity does not match canonical content",
    );
  }
  return candidate;
}

export function validateVisionArtifactAttestation(attestation, descriptor) {
  const candidate = structuredClone(attestation);
  validateSchema("attestation", candidate);
  exactKeys(
    candidate,
    [
      "schemaVersion",
      "kind",
      "bundleDigest",
      "descriptorDigest",
      "sbomDigest",
      "provenanceDigest",
      "signerIdentity",
    ],
    "Vision artifact attestation",
  );
  if (
    candidate.schemaVersion !== "vem-vision-artifact-attestation/v1" ||
    candidate.kind !== "vision-artifact-attestation"
  ) {
    throw new Error("Vision artifact attestation contract is invalid");
  }
  for (const key of [
    "bundleDigest",
    "descriptorDigest",
    "sbomDigest",
    "provenanceDigest",
  ]) {
    assertDigest(candidate[key], `Vision artifact attestation.${key}`);
  }
  if (!/^spki-sha256:[a-f0-9]{64}$/.test(candidate.signerIdentity ?? "")) {
    throw new Error("Vision artifact attestation signerIdentity is invalid");
  }
  if (
    candidate.bundleDigest !== descriptor.bundle.digest ||
    candidate.descriptorDigest !== descriptor.identity ||
    candidate.sbomDigest !== descriptor.sbom.digest ||
    candidate.provenanceDigest !== descriptor.provenance.digest
  ) {
    throw new Error(
      "Vision artifact attestation does not match the release descriptor",
    );
  }
  return candidate;
}

export function createVisionReleaseApproval(input) {
  const approval = {
    schemaVersion: "vem-vision-release-approval/v1",
    kind: "vision-release-approval",
    ...structuredClone(input),
  };
  delete approval.identity;
  approval.identity = digestJson(approval);
  return validateVisionReleaseApproval(approval);
}

export function validateVisionReleaseApproval(approval) {
  const candidate = structuredClone(approval);
  validateSchema("approval", candidate);
  exactKeys(
    candidate,
    [
      "schemaVersion",
      "kind",
      "identity",
      "releaseVersion",
      "bundleDigest",
      "descriptorDigest",
      "attestationDigest",
      "conformanceEvidenceDigest",
      "approverIdentity",
    ],
    "Vision release approval",
  );
  if (
    candidate.schemaVersion !== "vem-vision-release-approval/v1" ||
    candidate.kind !== "vision-release-approval"
  ) {
    throw new Error("Vision release approval contract is invalid");
  }
  if (!SEMVER.test(candidate.releaseVersion ?? ""))
    throw new Error("Vision release approval releaseVersion is invalid");
  for (const key of [
    "identity",
    "bundleDigest",
    "descriptorDigest",
    "attestationDigest",
    "conformanceEvidenceDigest",
  ]) {
    assertDigest(candidate[key], `Vision release approval.${key}`);
  }
  if (
    !/^vem-release-approval:[a-z0-9-]+$/.test(candidate.approverIdentity ?? "")
  ) {
    throw new Error("Vision release approval approverIdentity is invalid");
  }
  const withoutIdentity = { ...candidate };
  delete withoutIdentity.identity;
  if (candidate.identity !== digestJson(withoutIdentity)) {
    throw new Error(
      "Vision release approval identity does not match canonical content",
    );
  }
  return candidate;
}

export function validateVisionReleaseTrustPolicy(policy) {
  const candidate = structuredClone(policy);
  validateSchema("trustPolicy", candidate);
  exactKeys(
    candidate,
    ["schemaVersion", "kind", "verifierDigest", "approvedIdentities"],
    "Vision release trust policy",
  );
  assertDigest(
    candidate.verifierDigest,
    "Vision release trust policy verifier",
  );
  for (const role of [
    "descriptor",
    "attestation",
    "sbom",
    "provenance",
    "conformance",
    "approval",
  ]) {
    const identities = candidate.approvedIdentities[role];
    if (
      !Array.isArray(identities) ||
      identities.length === 0 ||
      !identities.every((identity) =>
        /^spki-sha256:[a-f0-9]{64}$/.test(identity),
      )
    ) {
      throw new Error(
        `Vision release trust policy ${role} identities are invalid`,
      );
    }
  }
  return candidate;
}

export function verifyVisionReleaseSelection({
  manifestAsset,
  descriptor,
  attestation,
  approval,
}) {
  const selected = validateVisionReleaseDescriptor(descriptor);
  const verifiedAttestation = validateVisionArtifactAttestation(
    attestation,
    selected,
  );
  const attestationDigest = digestJson(verifiedAttestation);
  const approved = validateVisionReleaseApproval(approval);
  exactKeys(
    manifestAsset,
    ["role", "digest", "version", "release"],
    "Factory Manifest Vision release selection",
  );
  if (manifestAsset.role !== "vision-release")
    throw new Error("Factory Manifest selection role is invalid");
  assertDigest(manifestAsset.digest, "Factory Manifest selection.digest");
  if (
    manifestAsset.version !== selected.releaseVersion ||
    manifestAsset.digest !== selected.bundle.digest
  ) {
    throw new Error(
      "Factory Manifest Vision release version or digest does not match descriptor",
    );
  }
  exactKeys(
    manifestAsset.release,
    [
      "descriptorIdentity",
      "descriptorDigest",
      "attestationIdentity",
      "attestationDigest",
      "approvalIdentity",
      "approvalDigest",
      "conformanceEvidenceIdentity",
      "conformanceEvidenceDigest",
    ],
    "Factory Manifest Vision release evidence",
  );
  const release = manifestAsset.release;
  for (const [name, value] of Object.entries(release)) {
    if (name.endsWith("Identity")) {
      if (!EVIDENCE_IDENTITY.test(value ?? ""))
        throw new Error(`Factory Manifest ${name} is invalid`);
    } else {
      assertDigest(value, `Factory Manifest ${name}`);
    }
  }
  const pairs = [
    [release.descriptorIdentity, release.descriptorDigest],
    [release.attestationIdentity, release.attestationDigest],
    [release.approvalIdentity, release.approvalDigest],
    [release.conformanceEvidenceIdentity, release.conformanceEvidenceDigest],
  ];
  if (
    pairs.some(
      ([identity, value]) =>
        identity !== `factory-evidence://${value.replace(":", "/")}`,
    )
  ) {
    throw new Error(
      "Factory Manifest Vision release evidence identities do not match digests",
    );
  }
  if (
    release.descriptorDigest !== selected.identity ||
    release.attestationDigest !== attestationDigest ||
    release.approvalDigest !== approved.identity ||
    release.conformanceEvidenceDigest !== approved.conformanceEvidenceDigest ||
    approved.releaseVersion !== selected.releaseVersion ||
    approved.bundleDigest !== selected.bundle.digest ||
    approved.descriptorDigest !== selected.identity ||
    approved.attestationDigest !== attestationDigest
  ) {
    throw new Error(
      "Vision approval, attestation, descriptor, and Factory Manifest selection must match",
    );
  }
  return {
    releaseVersion: selected.releaseVersion,
    bundleDigest: selected.bundle.digest,
    descriptorDigest: selected.identity,
    approvalDigest: approved.identity,
    attestationDigest,
  };
}

/**
 * Verifies the exact published JSON bytes and detached signatures used to
 * select a Vision release. The factory builder calls this before staging the
 * bundle; no metadata-only selection is accepted.
 */
export function verifySignedVisionReleaseEvidence({
  manifestAsset,
  documents,
  signatures,
  approvedIdentities,
}) {
  const required = [
    "descriptor",
    "attestation",
    "sbom",
    "provenance",
    "conformance",
    "approval",
  ];
  if (!documents || !signatures || !approvedIdentities) {
    throw new Error(
      "signed Vision release evidence and approved identities are required",
    );
  }
  const parsed = {};
  const identities = {};
  for (const role of required) {
    const bytes = documents[role];
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length < 2 ||
      bytes.length > 16 * 1024 * 1024
    ) {
      throw new Error(`${role} bytes are invalid`);
    }
    identities[role] = verifyDocumentSignature({
      role,
      bytes,
      signature: signatures[role],
      approvedIdentities,
    });
    try {
      parsed[role] = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`${role} bytes are not JSON`);
    }
  }
  const descriptor = validateVisionReleaseDescriptor(parsed.descriptor);
  if (
    digestBytes(documents.sbom) !== descriptor.sbom.digest ||
    digestBytes(documents.provenance) !== descriptor.provenance.digest
  ) {
    throw new Error(
      "descriptor evidence references do not match exact published bytes",
    );
  }
  validateSchema("conformance", parsed.conformance);
  exactKeys(
    parsed.conformance,
    [
      "schemaVersion",
      "kind",
      "bundleDigest",
      "descriptorDigest",
      "protocolVersion",
    ],
    "Vision conformance evidence",
  );
  if (
    parsed.conformance.schemaVersion !== "vem-vision-conformance/v1" ||
    parsed.conformance.kind !== "vision-release-conformance" ||
    parsed.conformance.bundleDigest !== descriptor.bundle.digest ||
    parsed.conformance.descriptorDigest !== descriptor.identity ||
    parsed.conformance.protocolVersion !== descriptor.protocol.version
  ) {
    throw new Error(
      "Vision conformance evidence does not bind the release protocol",
    );
  }
  const approval = validateVisionReleaseApproval(parsed.approval);
  if (
    approval.conformanceEvidenceDigest !== digestBytes(documents.conformance)
  ) {
    throw new Error("approval does not bind exact conformance bytes");
  }
  const selection = verifyVisionReleaseSelection({
    manifestAsset,
    descriptor,
    attestation: parsed.attestation,
    approval,
  });
  if (
    manifestAsset.release.attestationDigest !==
    digestBytes(documents.attestation)
  ) {
    throw new Error(
      "Factory Manifest attestation selection does not match exact bytes",
    );
  }
  if (
    manifestAsset.release.conformanceEvidenceDigest !==
    digestBytes(documents.conformance)
  ) {
    throw new Error(
      "Factory Manifest conformance selection does not match exact bytes",
    );
  }
  return { ...selection, identities };
}

export function assessVisionReleaseCandidate(candidate) {
  const missing = [];
  assertDigest(candidate?.bundleDigest, "Vision candidate bundleDigest");
  if (
    !Number.isSafeInteger(candidate?.bundleBytes) ||
    candidate.bundleBytes < 1
  ) {
    throw new Error(
      "Vision candidate bundleBytes must be a positive safe integer",
    );
  }
  const required = [
    ["descriptor", "descriptor"],
    ["attestation", "attestation"],
    ["sbom", "sbom"],
    ["provenance", "provenance"],
    ["conformanceEvidence", "conformance"],
    ["approval", "approval"],
  ];
  const documents = {};
  for (const [candidateKey, documentKey] of required) {
    const value = candidate?.[candidateKey];
    if (
      !Buffer.isBuffer(value) ||
      value.length < 2 ||
      value.length > 16 * 1024 * 1024
    ) {
      missing.push(candidateKey);
      continue;
    }
    try {
      documents[documentKey] = JSON.parse(value.toString("utf8"));
    } catch {
      missing.push(candidateKey);
    }
  }
  if (missing.length === 0) {
    try {
      const descriptor = validateVisionReleaseDescriptor(documents.descriptor);
      validateVisionArtifactAttestation(documents.attestation, descriptor);
      validateSchema("conformance", documents.conformance);
      validateVisionReleaseApproval(documents.approval);
      if (
        descriptor.bundle.digest !== candidate.bundleDigest ||
        descriptor.bundle.bytes !== candidate.bundleBytes
      ) {
        missing.push("descriptor");
      }
    } catch {
      missing.push("invalid-release-metadata");
    }
  }
  return {
    bundleDigest: candidate.bundleDigest,
    bundleBytes: candidate.bundleBytes,
    // Inventory is not a trust decision. Only signed verification may approve.
    approved: false,
    missing,
  };
}

export async function runVisionReleaseConformance({
  selection,
  descriptor,
  httpProbe,
  webSocketProbe,
}) {
  const release = validateVisionReleaseDescriptor(descriptor);
  exactKeys(
    selection,
    ["bundleDigest", "descriptorDigest"],
    "Vision release selection",
  );
  if (
    selection.bundleDigest !== release.bundle.digest ||
    selection.descriptorDigest !== release.identity
  ) {
    throw new Error(
      "Vision conformance selection does not match the exact release digest",
    );
  }
  if (typeof httpProbe !== "function" || typeof webSocketProbe !== "function") {
    throw new Error("Vision conformance requires HTTP and WebSocket probes");
  }
  const health = await httpProbe({
    port: release.health.port,
    path: release.health.path,
    timeoutMs: release.health.timeoutMs,
  });
  if (health?.status !== release.health.expectedStatus) {
    throw new Error("Vision health conformance failed");
  }
  const hello = {
    protocol: "vem.vision.v1",
    type: "vision.hello",
    messageId: "factory-conformance-hello",
    timestamp: "2026-01-01T00:00:00.000Z",
    payload: {
      clientRole: "machine",
      machineCode: null,
      protocolVersion: 1,
      capabilities: [
        "profile_push",
        "presence_status",
        "person_departed",
        "ambient_light",
      ],
    },
  };
  const webSocket = await webSocketProbe({
    port: release.health.port,
    path: release.protocol.webSocketPath,
    protocolVersion: release.protocol.version,
    timeoutMs: release.health.timeoutMs,
    hello,
  });
  const ready = webSocket?.ready;
  if (
    webSocket?.open !== true ||
    !ready ||
    ready.protocol !== "vem.vision.v1" ||
    ready.type !== "vision.ready" ||
    typeof ready.messageId !== "string" ||
    ready.messageId.length < 1 ||
    typeof ready.timestamp !== "string" ||
    !ready.payload ||
    typeof ready.payload.serverName !== "string" ||
    ready.payload.serverName.length < 1 ||
    typeof ready.payload.serverVersion !== "string" ||
    typeof ready.payload.cameraReady !== "boolean" ||
    typeof ready.payload.modelReady !== "boolean" ||
    !Array.isArray(ready.payload.capabilities) ||
    !ready.payload.capabilities.every(
      (capability) => typeof capability === "string" && capability.length > 0,
    )
  ) {
    throw new Error("Vision WebSocket conformance failed");
  }
  return sanitizeVisionReleaseEvidence({
    bundleDigest: release.bundle.digest,
    installedDigest: selection.bundleDigest,
    descriptorDigest: release.identity,
  });
}

export function sanitizeVisionReleaseEvidence(value) {
  const result = { redacted: true };
  for (const key of [
    "bundleDigest",
    "installedDigest",
    "previousDigest",
    "descriptorDigest",
    "approvalDigest",
  ]) {
    if (DIGEST.test(value?.[key] ?? "")) result[key] = value[key];
  }
  if (typeof value?.error === "string" && value.error.length > 0) {
    result.failure = value.error
      .replace(
        /(?:[A-Za-z]:[\\/][^\s;,'"<>)]*|\\\\[^\\/\s;,'"<>]+\\[^\s;,'"<>]+(?:\\[^\s;,'"<>]+)*|\/\/[^/\s;,'"<>]+\/[^\s;,'"<>]+(?:\/[^\s;,'"<>]+)*|\/(?:[^\s/;,'"<>]+\/)+[^\s;,'"<>]+)/g,
        "[redacted-path]",
      )
      .replace(
        /\s+(?:for\s+)?(?:token|password|secret|api[_-]?key)\s*[=:].*$/i,
        "",
      )
      .slice(0, 240);
  }
  return result;
}
