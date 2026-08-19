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
  const adminHttp = required(
    adminDelivery.observedHttp,
    "Admin UI HTTP observation",
  );
  if (
    adminDelivery.entrypoint !== "index.html" ||
    adminHttp.method !== "GET" ||
    adminHttp.status !== 200 ||
    !Number.isSafeInteger(adminHttp.byteSize) ||
    adminHttp.byteSize <= 0
  ) {
    throw new Error("acceptance release Admin UI delivery facts are invalid");
  }
  digest(adminHttp.responseSha256, "Admin UI HTTP response");
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
  const input = required(ai.input, "AI input identity");
  digest(input.manifestSha256, "AI input manifest");
  const inputModelArchive = required(
    input.modelPackArchive,
    "AI input model archive",
  );
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
