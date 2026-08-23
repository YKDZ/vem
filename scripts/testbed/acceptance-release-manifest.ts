import { createHash } from "node:crypto";

const SCHEMA_VERSION = "vem-runtime-testbed-acceptance-release/v1";
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}

export function canonicalAcceptanceReleaseManifest(value: unknown): string {
  return `${JSON.stringify(canonical(value), null, 2)}\n`;
}

function required(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`acceptance release ${label} is required`);
  }
  return recordValue(value);
}

function digest(value: unknown, label: string): string {
  if (!SHA256.test(String(value ?? ""))) {
    throw new Error(`acceptance release ${label} SHA-256 is invalid`);
  }
  return String(value);
}

function commit(value: unknown, label: string): string {
  if (!COMMIT.test(String(value ?? ""))) {
    throw new Error(`acceptance release ${label} commit is invalid`);
  }
  return String(value);
}

function buildIdentity(value: unknown, label: string): void {
  const build = required(recordValue(value).build, `${label} build`);
  digest(build.sha256, `${label} build`);
  if (
    !Number.isSafeInteger(Number(build.byteSize)) ||
    Number(build.byteSize) <= 0 ||
    !Number.isSafeInteger(Number(build.fileCount)) ||
    Number(build.fileCount) <= 0
  ) {
    throw new Error(`acceptance release ${label} build facts are invalid`);
  }
}

function validateIdentity(identity: JsonRecord): void {
  commit(identity.githubSha, "VEM source");
  const backend = required(identity.backend, "backend identity");
  const serviceApi = recordValue(backend.serviceApi);
  const adminUi = recordValue(backend.adminUi);
  buildIdentity(required(serviceApi, "Service API"), "Service API");
  buildIdentity(required(adminUi, "Admin UI"), "Admin UI");
  const serviceRuntime = recordValue(
    required(serviceApi.runtime, "Service API runtime"),
  );
  if (
    serviceRuntime.health !== "ready" ||
    serviceRuntime.database !== "ok" ||
    serviceRuntime.entrypoint !== "main.js" ||
    serviceRuntime.mqtt !== "connected"
  ) {
    throw new Error("acceptance release Service API runtime facts are invalid");
  }
  const adminDelivery = recordValue(
    required(adminUi.delivery, "Admin UI delivery"),
  );
  const adminHttp = recordValue(
    required(adminDelivery.observedHttp, "Admin UI HTTP observation"),
  );
  if (
    adminDelivery.entrypoint !== "index.html" ||
    adminHttp.method !== "GET" ||
    adminHttp.status !== 200 ||
    !Number.isSafeInteger(Number(adminHttp.byteSize)) ||
    Number(adminHttp.byteSize) <= 0
  ) {
    throw new Error("acceptance release Admin UI delivery facts are invalid");
  }
  digest(adminHttp.responseSha256, "Admin UI HTTP response");
  const runtime = recordValue(
    required(identity.runtimeArtifacts, "Windows runtime identity"),
  );
  if (commit(runtime.commit, "Windows runtime") !== identity.githubSha) {
    throw new Error(
      "acceptance release Windows runtime commit drifted from VEM",
    );
  }
  digest(runtime.sourceDigest, "Windows runtime source");
  const runtimeArtifacts = recordValue(
    required(runtime.artifacts, "Windows runtime artifacts"),
  );
  for (const key of ["daemon", "machine", "webViewLoader"]) {
    digest(
      recordValue(runtimeArtifacts[key]).sha256,
      `Windows runtime ${key}`,
    );
  }
  const vision = recordValue(required(identity.visionCore, "Vision identity"));
  digest(vision.sha256, "Vision aggregate");
  for (const key of ["runtimeArchive", "recordedFixtureArchive"]) {
    const artifact = recordValue(required(vision[key], `Vision ${key}`));
    digest(artifact.sha256, `Vision ${key}`);
    commit(artifact.sourceCommit, `Vision ${key}`);
    if (
      !Number.isSafeInteger(Number(artifact.byteSize)) ||
      Number(artifact.byteSize) <= 0
    ) {
      throw new Error(`acceptance release Vision ${key} size is invalid`);
    }
  }
  if (
    recordValue(vision.runtimeArchive).sourceCommit !==
    recordValue(vision.recordedFixtureArchive).sourceCommit
  ) {
    throw new Error("acceptance release Vision source commits drifted");
  }
}

export function buildAcceptanceReleaseManifest(identity: JsonRecord): JsonRecord {
  required(identity, "workflow identity");
  validateIdentity(identity);
  const runtime = recordValue(
    required(identity.runtimeArtifacts, "Windows runtime identity"),
  );
  return canonical({
    backend: recordValue(required(identity.backend, "backend identity")),
    schemaVersion: SCHEMA_VERSION,
    vem: { sourceCommit: identity.githubSha },
    vision: recordValue(required(identity.visionCore, "Vision identity")),
    windowsRuntime: {
      artifacts: recordValue(
        required(runtime.artifacts, "Windows runtime artifacts"),
      ),
      commit: runtime.commit,
      sourceDigest: runtime.sourceDigest,
    },
  }) as JsonRecord;
}

export function bindAcceptanceReleaseManifest(
  passAIdentity: JsonRecord,
  passBIdentity: JsonRecord,
): JsonRecord {
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
