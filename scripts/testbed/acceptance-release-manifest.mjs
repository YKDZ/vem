import { createHash } from "node:crypto";

const SCHEMA_VERSION = "vem-runtime-testbed-acceptance-release/v1";
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

export function canonicalAcceptanceReleaseManifest(value) {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function required(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`acceptance release ${label} is required`);
  }
  return value;
}

function digest(value, label) {
  if (!SHA256.test(value ?? "")) {
    throw new Error(`acceptance release ${label} SHA-256 is invalid`);
  }
  return value;
}

function commit(value, label) {
  if (!COMMIT.test(value ?? "")) {
    throw new Error(`acceptance release ${label} commit is invalid`);
  }
  return value;
}

function buildIdentity(value, label) {
  const build = required(value.build, `${label} build`);
  digest(build.sha256, `${label} build`);
  if (
    !Number.isSafeInteger(build.byteSize) ||
    build.byteSize <= 0 ||
    !Number.isSafeInteger(build.fileCount) ||
    build.fileCount <= 0
  ) {
    throw new Error(`acceptance release ${label} build facts are invalid`);
  }
}

function validateIdentity(identity) {
  commit(identity.githubSha, "VEM source");
  const backend = required(identity.backend, "backend identity");
  buildIdentity(required(backend.serviceApi, "Service API"), "Service API");
  buildIdentity(required(backend.adminUi, "Admin UI"), "Admin UI");
  const serviceRuntime = required(
    backend.serviceApi.runtime,
    "Service API runtime",
  );
  if (
    serviceRuntime.health !== "ready" ||
    serviceRuntime.database !== "ok" ||
    serviceRuntime.entrypoint !== "main.js" ||
    serviceRuntime.mqtt !== "connected"
  ) {
    throw new Error("acceptance release Service API runtime facts are invalid");
  }
  const adminDelivery = required(backend.adminUi.delivery, "Admin UI delivery");
  if (
    adminDelivery.buildVerified !== true ||
    adminDelivery.entrypoint !== "index.html"
  ) {
    throw new Error("acceptance release Admin UI delivery facts are invalid");
  }
  const runtime = required(
    identity.runtimeArtifacts,
    "Windows runtime identity",
  );
  if (commit(runtime.commit, "Windows runtime") !== identity.githubSha) {
    throw new Error(
      "acceptance release Windows runtime commit drifted from VEM",
    );
  }
  digest(runtime.sourceDigest, "Windows runtime source");
  const runtimeArtifacts = required(
    runtime.artifacts,
    "Windows runtime artifacts",
  );
  for (const key of ["daemon", "machine", "webViewLoader"]) {
    digest(runtimeArtifacts[key]?.sha256, `Windows runtime ${key}`);
  }
  const vision = required(identity.visionCore, "Vision identity");
  digest(vision.sha256, "Vision aggregate");
  for (const key of ["runtimeArchive", "recordedFixtureArchive"]) {
    const artifact = required(vision[key], `Vision ${key}`);
    digest(artifact.sha256, `Vision ${key}`);
    commit(artifact.sourceCommit, `Vision ${key}`);
    if (!Number.isSafeInteger(artifact.byteSize) || artifact.byteSize <= 0) {
      throw new Error(`acceptance release Vision ${key} size is invalid`);
    }
  }
  if (
    vision.runtimeArchive.sourceCommit !==
    vision.recordedFixtureArchive.sourceCommit
  ) {
    throw new Error("acceptance release Vision source commits drifted");
  }
  const ai = required(identity.aiVirtualTryOn, "AI identity");
  const authority = required(ai.authority, "AI authority");
  const candidate = required(authority.candidate, "AI candidate");
  if (
    commit(candidate.sourceCommit, "AI candidate") !==
      vision.runtimeArchive.sourceCommit ||
    digest(candidate.subjectSha256, "AI candidate subject") !==
      vision.runtimeArchive.sha256
  ) {
    throw new Error(
      "acceptance release AI candidate drifted from Vision runtime",
    );
  }
  const contractIdentity = required(authority.contract, "Vision V2 contract");
  digest(contractIdentity.bundleDigest, "Vision V2 contract bundle");
  digest(contractIdentity.manifestSha256, "Vision V2 contract manifest");
  if (contractIdentity.protocol !== "vem.vision.v2") {
    throw new Error("acceptance release Vision V2 protocol is invalid");
  }
  const resources = required(authority.resources, "AI environment");
  for (const key of [
    "aiLockSha256",
    "runtimeDescriptorSha256",
    "sourceDescriptorSha256",
    "workerExecutableSha256",
  ]) {
    digest(resources[key], `AI environment ${key}`);
  }
  const model = required(authority.modelPack, "model pack authority");
  const modelArchive = required(model.archive, "model pack archive");
  digest(modelArchive.sha256, "model pack archive");
  digest(model.descriptorSha256, "model pack descriptor");
  commit(model.sourceRevision, "model pack source");
  if (
    !Number.isSafeInteger(modelArchive.byteSize) ||
    modelArchive.byteSize <= 0
  ) {
    throw new Error("acceptance release model pack archive size is invalid");
  }
  const input = required(ai.input, "AI input identity");
  digest(input.manifestSha256, "AI input manifest");
  const inputModelArchive = required(
    input.modelPackArchive,
    "AI input model archive",
  );
  if (
    inputModelArchive.sha256 !== modelArchive.sha256 ||
    inputModelArchive.byteSize !== modelArchive.byteSize
  ) {
    throw new Error("acceptance release model archive drifted from authority");
  }
  const materialized = required(
    input.materializedModelPackRoot,
    "materialized model pack",
  );
  digest(materialized.sha256, "materialized model pack");
  if (
    !Number.isSafeInteger(materialized.byteSize) ||
    materialized.byteSize <= 0 ||
    !Array.isArray(materialized.members) ||
    materialized.members.length === 0
  ) {
    throw new Error("acceptance release materialized model pack is invalid");
  }
}

export function buildAcceptanceReleaseManifest(identity) {
  required(identity, "workflow identity");
  validateIdentity(identity);
  const runtime = required(
    identity.runtimeArtifacts,
    "Windows runtime identity",
  );
  return canonical({
    aiVirtualTryOn: required(identity.aiVirtualTryOn, "AI identity"),
    backend: required(identity.backend, "backend identity"),
    schemaVersion: SCHEMA_VERSION,
    vem: { sourceCommit: identity.githubSha },
    vision: required(identity.visionCore, "Vision identity"),
    windowsRuntime: {
      artifacts: required(runtime.artifacts, "Windows runtime artifacts"),
      commit: runtime.commit,
      sourceDigest: runtime.sourceDigest,
    },
  });
}

export function bindAcceptanceReleaseManifest(passAIdentity, passBIdentity) {
  const manifest = buildAcceptanceReleaseManifest(passAIdentity);
  const raw = canonicalAcceptanceReleaseManifest(manifest);
  const second = canonicalAcceptanceReleaseManifest(
    buildAcceptanceReleaseManifest(passBIdentity),
  );
  if (raw !== second) {
    throw new Error("acceptance release pass 2 drifted from pass 1");
  }
  return {
    manifest,
    raw,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}
