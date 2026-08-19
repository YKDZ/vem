import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SHA256 = /^[a-f0-9]{64}$/;
const GUEST_ROOT = "D:\\runtime-cache\\v1\\acceptance-inputs";

function fail(message) {
  throw new Error(`AI functional acceptance input ${message}`);
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0)
    fail(`${label} is required`);
  return value;
}

function sha256(value, label) {
  const checked = string(value, label);
  if (!SHA256.test(checked)) fail(`${label} must be lowercase SHA-256`);
  return checked;
}

function byteSize(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

function hostPath(value, label) {
  const path = string(value, label);
  if (!isAbsolute(path)) fail(`${label} must be absolute`);
  return resolve(path);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalAiAcceptanceInputManifest(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

async function describeFileContent(path) {
  const hash = createHash("sha256");
  let byteSize = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    byteSize += chunk.length;
  }
  return { byteSize, sha256: hash.digest("hex") };
}

function memberName(value, label, nested) {
  const name = string(value, label);
  if (
    name.startsWith("/") ||
    name.includes("\\") ||
    name
      .split("/")
      .some((part) => part === "" || part === "." || part === "..") ||
    (!nested && name.includes("/"))
  ) {
    fail(`${label} is not a canonical relative file name`);
  }
  return name;
}

function directoryDigest(members) {
  return createHash("sha256")
    .update(
      members
        .map(
          (member) => `${member.name}\0${member.sha256}\0${member.byteSize}\n`,
        )
        .join(""),
    )
    .digest("hex");
}

async function collectDirectoryMembers(root, nested, label) {
  let rootEntry;
  try {
    rootEntry = await lstat(root);
  } catch {
    fail(`${label} is missing`);
  }
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    fail(`${label} must be a regular directory`);
  }
  const members = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = `${directory}${sep}${entry.name}`;
      const name = relative(root, path).split(sep).join("/");
      if (entry.isSymbolicLink()) fail(`${label} must not contain symlinks`);
      if (entry.isDirectory()) {
        if (!nested) fail(`${label} must contain regular files only`);
        await visit(path);
      } else if (entry.isFile()) {
        const content = await describeFileContent(path);
        members.push({
          name,
          sha256: content.sha256,
          byteSize: content.byteSize,
        });
      } else {
        fail(`${label} must contain regular files only`);
      }
    }
  }
  await visit(root);
  return members.sort((left, right) => left.name.localeCompare(right.name));
}

export async function describeAiAcceptanceInputDirectory(
  path,
  label,
  { nested = false } = {},
) {
  const hostPathValue = hostPath(path, label);
  const members = await collectDirectoryMembers(hostPathValue, nested, label);
  if (members.length === 0) fail(`${label} must not be empty`);
  return {
    hostPath: hostPathValue,
    sha256: directoryDigest(members),
    byteSize: members.reduce((sum, member) => sum + member.byteSize, 0),
    members,
  };
}

function windowsJoin(...parts) {
  return parts.join("\\");
}

async function describeFunctionalFile(path, label, { sourceCommit } = {}) {
  const hostPathValue = hostPath(path, label);
  let entry;
  try {
    entry = await lstat(hostPathValue);
  } catch {
    fail(`${label} is missing`);
  }
  if (!entry.isFile() || entry.isSymbolicLink())
    fail(`${label} must be a regular file`);
  const content = await describeFileContent(hostPathValue);
  return {
    hostPath: hostPathValue,
    sha256: content.sha256,
    byteSize: content.byteSize,
    ...(sourceCommit ? { sourceCommit } : {}),
  };
}

function pickFile(value, sourceCommit = false) {
  return {
    sha256: value.sha256,
    byteSize: value.byteSize,
    ...(sourceCommit ? { sourceCommit: value.sourceCommit } : {}),
  };
}

function pickDirectory(value) {
  return {
    sha256: value.sha256,
    byteSize: value.byteSize,
    members: value.members,
  };
}

export async function buildFunctionalAiAcceptanceGuestInput(config) {
  const runtime = await describeFunctionalFile(
    config.visionCoreArtifacts.runtimeArchive.hostPath,
    "functional installed Vision runtime archive",
    {
      sourceCommit: config.visionCoreArtifacts.runtimeArchive.sourceCommit,
    },
  );
  const fixture = await describeFunctionalFile(
    config.visionCoreArtifacts.recordedFixtureArchive.hostPath,
    "functional recorded Vision fixture archive",
    {
      sourceCommit:
        config.visionCoreArtifacts.recordedFixtureArchive.sourceCommit,
    },
  );
  const modelConfig = config.aiVirtualTryOnFunctional;
  const modelPack = await describeFunctionalFile(
    modelConfig.modelPackArchive,
    "functional official model pack archive",
  );
  if (
    modelPack.sha256 !== modelConfig.modelPackSha256 ||
    modelPack.byteSize !== modelConfig.modelPackByteSize
  ) {
    fail("functional official model pack identity is invalid");
  }
  const materializedRoot = await describeAiAcceptanceInputDirectory(
    modelConfig.materializedModelPackRoot,
    "functional materialized official model pack",
    { nested: true },
  );
  const identity = {
    schemaVersion: "vem-runtime-testbed-ai-functional-input/v1",
    installedVisionRuntimeArchive: pickFile(runtime, true),
    recordedFixtureArchive: pickFile(fixture, true),
    modelPackArchive: pickFile(modelPack),
    materializedModelPackRoot: pickDirectory(materializedRoot),
  };
  const manifestSha256 = createHash("sha256")
    .update(canonicalAiAcceptanceInputManifest(identity))
    .digest("hex");
  const root = windowsJoin(GUEST_ROOT, "functional", manifestSha256);
  const guestInput = {
    schemaVersion: "vem-local-testbed-ai-virtual-try-on-input/v2",
    inputRoot: root,
    phase: "measurement",
    functional: true,
    keepAiActive: true,
    skipAiRss: true,
    installedVisionRuntimeArchive: windowsJoin(
      GUEST_ROOT,
      "files",
      runtime.sha256,
      "vision-runtime.zip",
    ),
    recordedFixtureArchive: windowsJoin(
      GUEST_ROOT,
      "files",
      fixture.sha256,
      "recorded-fixtures.zip",
    ),
    modelPackArchive: windowsJoin(
      GUEST_ROOT,
      "files",
      modelPack.sha256,
      "model-pack.zip",
    ),
    materializedModelPackRoot: windowsJoin(
      GUEST_ROOT,
      "directories",
      materializedRoot.sha256,
    ),
    modelPackSource: "host-local-cache",
    modelPackSha256: modelPack.sha256,
    modelPackByteSize: modelPack.byteSize,
    identities: {
      manifestSha256,
      installedVisionRuntimeArchive: pickFile(runtime, true),
      recordedFixtureArchive: pickFile(fixture, true),
      modelPackArchive: pickFile(modelPack),
      materializedModelPackRoot: pickDirectory(materializedRoot),
    },
  };
  const transfers = [
    { ...runtime, guestPath: guestInput.installedVisionRuntimeArchive },
    { ...fixture, guestPath: guestInput.recordedFixtureArchive },
    { ...modelPack, guestPath: guestInput.modelPackArchive },
    { ...materializedRoot, guestPath: guestInput.materializedModelPackRoot },
  ];
  return {
    manifestSha256,
    artifactDigests: guestInput.identities,
    guestInput,
    phase: "measurement",
    transfers,
  };
}

export function identicalAiAcceptanceInputSnapshot(left, right) {
  return (
    Boolean(left && right) &&
    left.manifestSha256 === right.manifestSha256 &&
    JSON.stringify(left.artifactDigests) ===
      JSON.stringify(right.artifactDigests)
  );
}
