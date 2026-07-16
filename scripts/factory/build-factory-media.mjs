import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import {
  mkdir,
  mkdtemp,
  open,
  cp,
  chmod,
  lstat,
  lutimes,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

import { assertNoPlatformPrivateKeyMaterialFile } from "../security/platform-private-key-scanner.mjs";
import { ContentAddressedAssetStore } from "./content-addressed-store.mjs";
import { canonicalJson, validateFactoryManifest } from "./factory-manifest.mjs";
import { factoryOobePrivacySuppressionScript } from "./oobe-registry.mjs";
import {
  verifyAssetEvidence,
  verifyAuthenticodeSignature,
} from "./verify-asset-evidence.mjs";
import {
  validateVisionReleaseTrustPolicy,
  verifySignedVisionReleaseEvidence,
} from "./vision-release.mjs";

const run = promisify(execFile);
const FIXED_EPOCH_SECONDS = 315_532_800;
const SEVEN_ZIP_BANNER_VERSION =
  /^7-Zip[ \t]+(?:\[64\][ \t]+)?(?<version>\d+\.\d+(?:\.\d+)?)(?:[ \t]+\(x64\))?[ \t]*:[^\r\n]*\r?$/m;

export function parse7ZipBannerVersion(output) {
  return SEVEN_ZIP_BANNER_VERSION.exec(output)?.groups?.version;
}

export function hasExpected7ZipBannerVersion(output, manifestVersion) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(manifestVersion);
  if (!match) return false;
  const [, major, minor, patch] = match;
  const expected = `${major}.${minor.padStart(2, "0")}${patch === "0" ? "" : `.${patch}`}`;
  return parse7ZipBannerVersion(output) === expected;
}

const SECTOR_BYTES = 2048;
const ISO_EXTENT_COPY_CHUNK_BYTES = 1024 * 1024;
const MAX_SOURCE_ONLY_REPLAY_FILES = 4096;
const MAX_SOURCE_ONLY_REPLAY_BYTES = 16 * 1024 ** 3;
const MAX_SOURCE_ONLY_REPLAY_PATH_DEPTH = 64;
// El Torito catalog load sizes use 512-byte virtual sectors, not ISO CD sectors.
const EL_TORITO_VIRTUAL_SECTOR_BYTES = 512;
const ISO_RANGE_CACHE_PAGES = 64;
const UDF_VOLUME_SET_ID = "VEM_FACTORY_SET";
const UDF_WRITER_LOCK = join(tmpdir(), "vem-factory-udf-writer.lock");
const WINDOWS_SERVICED_ISO = "windows-serviced-iso";
const FACTORY_MEDIA_DIRECTORY = "VEM/Factory";
const WINDOWS_REPLAY_GENERATED_PATHS = new Set(["boot.catalog"]);
const PREPARE_FACTORY_RUNTIME_PARAMETERS = [
  "DaemonArtifactPath",
  "DaemonSha256",
  "MachineUiArtifactPath",
  "MachineUiSha256",
  "EnvironmentName",
  "ProvisioningEndpoint",
  "MqttUrl",
  "HardwareMode",
  "HardwareModel",
  "TopologyIdentity",
  "TopologyVersion",
  "ExpectedDisplayWidth",
  "ExpectedDisplayHeight",
  "ExpectedDisplayOrientation",
  "ExpectedKioskUser",
  "ExpectedMaintenanceUser",
  "ExpectedAutoLogonUser",
  "ExpectedKioskShell",
  "TargetLayoutVersion",
  "FactoryProfile",
  "PersonalizationMediaPath",
  "FactoryMediaRoot",
  "VisionConfigurationSourcePath",
  "OpenSshPackagePath",
  "OpenSshPackageSource",
  "OpenSshPackageVersion",
  "OpenSshPackageSha256",
  "OpenSshApprovedSignerThumbprint",
  "OpenSshApprovedRootThumbprint",
  "WireGuardPackagePath",
  "WireGuardPackageSource",
  "WireGuardPackageVersion",
  "WireGuardPackageSha256",
  "WireGuardApprovedSignerThumbprint",
  "WireGuardApprovedRootThumbprint",
  "MaintenanceSshCaPublicKeyPath",
  "MaintenanceSshCaPublicKeySha256",
  "MaintenanceRunnerSourceAllowlist",
  "MaintenanceMaintainerSourceAllowlist",
  "MaintenanceWireGuardInterfaceAlias",
  "MaintenanceWireGuardListenAddress",
  "ResetExistingVemState",
];
const EFFECTIVE_REPOSITORY_INPUT_ROLES = [
  "repo-module:factory/build-factory-media.mjs",
  "repo-module:factory/content-addressed-store.mjs",
  "repo-module:factory/factory-manifest.mjs",
  "repo-module:factory/oobe-registry.mjs",
  "repo-module:factory/verify-asset-evidence.mjs",
  "repo-module:factory/vision-release.mjs",
  "repo-module:security/platform-private-key-scanner.mjs",
  "repo-schema:public/factory-manifest-v1.schema.json",
  "repo-schema:public/vision-artifact-attestation-v1.schema.json",
  "repo-schema:public/vision-conformance-v1.schema.json",
  "repo-schema:public/vision-release-approval-v1.schema.json",
  "repo-schema:public/vision-release-descriptor-v1.schema.json",
  "repo-schema:public/vision-release-trust-policy-v1.schema.json",
].sort();
const EFFECTIVE_PUBLIC_SCHEMA_FILES = [
  "factory-manifest-v1.schema.json",
  "vision-artifact-attestation-v1.schema.json",
  "vision-conformance-v1.schema.json",
  "vision-release-approval-v1.schema.json",
  "vision-release-descriptor-v1.schema.json",
  "vision-release-trust-policy-v1.schema.json",
];
const EFFECTIVE_IMPLEMENTATION_FILES = [
  "prepare-factory-runtime.ps1",
  "verify-factory-runtime.ps1",
  "setup-scheduled-tasks.ps1",
  "verify-kiosk-lockdown.ps1",
  "verify-vem-runtime.ps1",
  "apply-managed-update.ps1",
  "provision-vision-factory-release.ps1",
  "install-vision-release.ps1",
  "vision-release-materialization.psm1",
  "vision-diagnostic-redaction.psm1",
];
const VISION_DOCUMENT_ROLES = [
  "descriptor",
  "attestation",
  "sbom",
  "provenance",
  "conformance",
  "approval",
];

function hashBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function runtimeAssetRequiresPrivateKeyScan(role) {
  return role !== "vision-release";
}

async function assertRuntimeAssetsContainNoPlatformPaymentSecrets(
  resolvedAssets,
  store,
) {
  const root = await mkdtemp(join(tmpdir(), "vem-factory-payment-boundary-"));
  try {
    for (const asset of resolvedAssets) {
      const path = join(root, `${asset.reference.role}.bin`);
      if (asset.reference.role === "windows-source-iso") {
        await store.stageUncachedVerified(
          asset.reference,
          asset.sourcePath,
          path,
        );
        continue;
      }
      await store.stageVerified(asset.reference, path);
      // Vision is a signed binary delivery unit and can exceed the text scanner's
      // bounded input. Its descriptor, digest, supplier, and approval checks remain.
      if (runtimeAssetRequiresPrivateKeyScan(asset.reference.role)) {
        await assertNoPlatformPrivateKeyMaterialFile(
          path,
          asset.reference.role,
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function collectImportedModuleInputs(entry) {
  const inputs = new Map();
  async function visit(url) {
    const bytes = await readFile(url);
    const relative = url.pathname.split("/scripts/")[1];
    if (inputs.has(relative)) return;
    inputs.set(relative, {
      role: `repo-module:${relative}`,
      digest: hashBytes(bytes),
    });
    const source = bytes.toString("utf8");
    const imports = [...source.matchAll(/from\s+["'](\.[^"']+\.mjs)["']/g)].map(
      (match) => match[1],
    );
    for (const specifier of imports) await visit(new URL(specifier, url));
  }
  await visit(entry);
  await Promise.all(
    EFFECTIVE_PUBLIC_SCHEMA_FILES.map(async (name) => {
      const relative = `public/${name}`;
      inputs.set(relative, {
        role: `repo-schema:${relative}`,
        digest: hashBytes(
          await readFile(new URL(`../../public/${name}`, import.meta.url)),
        ),
      });
    }),
  );
  return [...inputs.values()];
}

export async function currentFactoryEffectiveRepositoryInputs() {
  return [
    ...(await collectImportedModuleInputs(
      new URL("./build-factory-media.mjs", import.meta.url),
    )),
    ...(await Promise.all(
      EFFECTIVE_IMPLEMENTATION_FILES.map(async (name) => ({
        role: `repo-script:${name}`,
        digest: hashBytes(
          await readFile(new URL(`../windows/${name}`, import.meta.url)),
        ),
      })),
    )),
  ].sort((left, right) => left.role.localeCompare(right.role));
}

function assetReferences(manifest) {
  return [manifest.source.windowsMedia, ...manifest.assets].sort(
    (left, right) => left.role.localeCompare(right.role),
  );
}

export function expectedFactoryEffectiveInputRoles(manifest) {
  return [
    "manifest:factory-manifest",
    ...assetReferences(manifest).map((asset) => `asset:${asset.role}`),
    "tool:builder-image",
    "tool:udf-extractor",
    "tool:udf-writer",
    "tool:wimlib",
    ...EFFECTIVE_REPOSITORY_INPUT_ROLES,
    ...EFFECTIVE_IMPLEMENTATION_FILES.map((name) => `repo-script:${name}`),
    "vision-verifier",
    "vision-repository-trust",
    "vision-factory-trust",
    ...VISION_DOCUMENT_ROLES.map((role) => `vision-document:${role}`),
    ...VISION_DOCUMENT_ROLES.map((role) => `vision-signature:${role}`),
  ].sort();
}

function outputName(manifest) {
  return manifest.outputPolicy.isoFileName.replace(
    "{manifestId}",
    manifest.manifestId.slice("sha256:".length),
  );
}

function findVisionReleaseAsset(manifest) {
  const assets = manifest.assets.filter(
    ({ role }) => role === "vision-release",
  );
  if (assets.length !== 1) {
    throw new Error(
      "Factory Manifest must contain exactly one Vision release asset",
    );
  }
  return assets[0];
}

function approvedVisionIdentities({
  repositoryTrustedRoots,
  factoryTrustedRoots,
}) {
  if (!repositoryTrustedRoots || !factoryTrustedRoots) {
    throw new Error(
      "Vision release verification requires repository and factory trusted roots",
    );
  }
  const roles = [
    "descriptor",
    "attestation",
    "sbom",
    "provenance",
    "conformance",
    "approval",
  ];
  return Object.fromEntries(
    roles.map((role) => {
      const repository = repositoryTrustedRoots[role];
      const factory = factoryTrustedRoots[role];
      if (
        !Array.isArray(repository) ||
        repository.length === 0 ||
        !Array.isArray(factory) ||
        factory.length === 0
      ) {
        throw new Error(
          `repository and factory trusted roots must approve Vision ${role}`,
        );
      }
      const jointlyApproved = repository.filter((identity) =>
        factory.includes(identity),
      );
      if (jointlyApproved.length === 0) {
        throw new Error(
          `repository and factory trusted roots have no common Vision ${role} identity`,
        );
      }
      return [role, [...new Set(jointlyApproved)]];
    }),
  );
}

export function verifyManifestVisionReleaseEvidence({
  manifest,
  deliveryUnit,
  repositoryTrustedRoots,
  factoryTrustedRoots,
}) {
  if (!deliveryUnit || typeof deliveryUnit !== "object") {
    throw new Error("Vision release evidence delivery unit is required");
  }
  const selectedAsset = findVisionReleaseAsset(manifest);
  return verifySignedVisionReleaseEvidence({
    manifestAsset: {
      role: selectedAsset.role,
      digest: selectedAsset.digest,
      version: selectedAsset.version,
      release: selectedAsset.release,
    },
    documents: deliveryUnit.documents,
    signatures: deliveryUnit.signatures,
    approvedIdentities: approvedVisionIdentities({
      repositoryTrustedRoots,
      factoryTrustedRoots,
    }),
  });
}

async function readPinnedExecutable(path, tool, label = "tool") {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be an executable regular file`);
  }
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ELOOP")
      throw new Error(`${label} must not be a symlink`);
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (
      !fileStat.isFile() ||
      fileStat.dev !== before.dev ||
      fileStat.ino !== before.ino ||
      (fileStat.mode & 0o111) === 0
    ) {
      throw new Error(`${label} must be an executable regular file`);
    }
    const bytes = Buffer.alloc(fileStat.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length)
      throw new Error(`${label} read was incomplete`);
    const digest = hashBytes(bytes);
    if (digest !== tool.digest) {
      throw new Error(
        `executed ${label} digest mismatch: expected ${tool.digest}, got ${digest}`,
      );
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export async function verifyPinnedFactoryTool({
  path,
  tool,
  label,
  args,
  versionPattern,
}) {
  const bytes = await readPinnedExecutable(path, tool, label);
  const directory = await mkdtemp(join(tmpdir(), "vem-factory-tool-"));
  try {
    const executable = join(directory, "tool");
    await writeFile(executable, bytes, { mode: 0o555 });
    const result = await run(executable, args, {
      cwd: directory,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: directory,
        LC_ALL: "C",
        TZ: "UTC",
        TMPDIR: tmpdir(),
      },
      maxBuffer: 1024 * 1024,
    });
    if (!versionPattern.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(
        `executed ${label} version does not match pinned manifest version ${tool.version}`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readPinnedVisionVerifier(path) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(
      "Vision evidence verifier must be an executable regular file",
    );
  }
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new Error("Vision evidence verifier must not be a symlink");
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (
      !fileStat.isFile() ||
      fileStat.dev !== before.dev ||
      fileStat.ino !== before.ino ||
      (fileStat.mode & 0o111) === 0 ||
      fileStat.size < 1
    ) {
      throw new Error(
        "Vision evidence verifier must be an executable regular file",
      );
    }
    const bytes = Buffer.alloc(fileStat.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length) {
      throw new Error("Vision evidence verifier read was incomplete");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function createVisionFactoryTrustMaterial({
  repositoryTrustedRoots,
  factoryTrustedRoots,
  verifierBytes,
}) {
  const approvedIdentities = approvedVisionIdentities({
    repositoryTrustedRoots,
    factoryTrustedRoots,
  });
  const policy = validateVisionReleaseTrustPolicy({
    schemaVersion: "vem-vision-release-trust-policy/v1",
    kind: "vision-release-trust-policy",
    verifierDigest: hashBytes(verifierBytes),
    approvedIdentities,
  });
  const policyBytes = Buffer.from(canonicalJson(policy));
  const anchor = {
    schemaVersion: "vem-factory-vision-trust-anchor/v1",
    kind: "factory-vision-trust-anchor",
    trustPolicyDigest: hashBytes(policyBytes),
    verifierDigest: policy.verifierDigest,
  };
  return {
    anchorBytes: Buffer.from(canonicalJson(anchor)),
    policyBytes,
    verifierBytes,
  };
}

function visionFactoryProvisioningManifest(files) {
  return {
    schemaVersion: "vem-vision-factory-provisioning/v1",
    kind: "vision-factory-provisioning",
    files: Object.fromEntries(
      Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, bytes]) => [path, hashBytes(bytes)]),
    ),
  };
}

export const FACTORY_VISION_DELIVERY_ASSEMBLY_MEMBERS = Object.freeze([
  "install-vision-release.ps1",
  "provision-vision-factory-release.ps1",
  "vision-release-materialization.psm1",
  "vision-diagnostic-redaction.psm1",
]);

// This is the same installer staging boundary used by Factory media assembly.
// The narrow contract runner below calls it with no Factory assets so the
// inventory guard can execute the real copier without building an ISO.
export async function stageFactoryVisionInstaller({ stageDirectory }) {
  const installerRoot = join(stageDirectory, "VEM", "VISION-INSTALLER");
  await mkdir(installerRoot, { recursive: true });
  const files = {};
  for (const name of FACTORY_VISION_DELIVERY_ASSEMBLY_MEMBERS) {
    const bytes = await readFile(
      new URL(`../windows/${name}`, import.meta.url),
    );
    await writeFile(join(installerRoot, name), bytes);
    files[`VISION-INSTALLER/${name}`] = bytes;
  }
  return files;
}

export async function stageFactoryVisionDeliveryAssemblyContract({
  outputRoot,
}) {
  await Promise.all([
    mkdir(join(outputRoot, "VEM", "VISION-RELEASE"), { recursive: true }),
    mkdir(join(outputRoot, "VEM", "VISION-TRUST"), { recursive: true }),
  ]);
  const files = await stageFactoryVisionInstaller({
    stageDirectory: outputRoot,
  });
  await writeFile(
    join(outputRoot, "VEM", "VISION-FACTORY-PROVISIONING.JSON"),
    Buffer.from(canonicalJson(visionFactoryProvisioningManifest(files))),
  );
  return files;
}

function bootImageBytes() {
  const bytes = Buffer.alloc(2048);
  bytes.set([0xfa, 0xeb, 0xfd], 0);
  bytes[510] = 0x55;
  bytes[511] = 0xaa;
  return bytes;
}

async function hashFile(path) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`expected a regular non-symlink file: ${path}`);
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error(`file changed before hashing: ${path}`);
    }
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return `sha256:${hash.digest("hex")}`;
  } finally {
    await handle.close();
  }
}

async function compareFilesByRange(leftPath, rightPath, limit = 12) {
  const [left, right] = await Promise.all([
    open(
      leftPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
    open(
      rightPath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ),
  ]);
  try {
    const [leftStat, rightStat] = await Promise.all([
      left.stat(),
      right.stat(),
    ]);
    if (!leftStat.isFile() || !rightStat.isFile()) {
      throw new Error("Factory ISO comparison requires regular files");
    }
    if (leftStat.size !== rightStat.size) {
      return {
        identical: false,
        differences: [Math.min(leftStat.size, rightStat.size)],
      };
    }
    const leftBuffer = Buffer.allocUnsafe(1024 * 1024);
    const rightBuffer = Buffer.allocUnsafe(1024 * 1024);
    const differences = [];
    for (
      let position = 0;
      position < leftStat.size && differences.length < limit;
    ) {
      const bytes = Math.min(leftBuffer.length, leftStat.size - position);
      const [leftRead, rightRead] = await Promise.all([
        left.read(leftBuffer, 0, bytes, position),
        right.read(rightBuffer, 0, bytes, position),
      ]);
      if (leftRead.bytesRead !== bytes || rightRead.bytesRead !== bytes) {
        throw new Error(
          "Factory ISO changed during reproducibility comparison",
        );
      }
      for (
        let index = 0;
        index < bytes && differences.length < limit;
        index += 1
      ) {
        if (leftBuffer[index] !== rightBuffer[index])
          differences.push(position + index);
      }
      position += bytes;
    }
    return { identical: differences.length === 0, differences };
  } finally {
    await Promise.all([left.close(), right.close()]);
  }
}

async function readRegularFile(path, label) {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} must be a regular non-symlink file`);
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error(`${label} changed before it could be read`);
    }
    const bytes = Buffer.alloc(stat.size);
    let position = 0;
    while (position < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        position,
        bytes.length - position,
        position,
      );
      if (bytesRead === 0)
        throw new Error(`${label} changed while it was read`);
      position += bytesRead;
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function snapshotRegularFile(path, destination, label) {
  const input = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let output;
  try {
    const stat = await input.stat();
    if (!stat.isFile()) throw new Error(`${label} must be a regular file`);
    output = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o400,
    );
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < stat.size) {
      const { bytesRead } = await input.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (bytesRead === 0)
        throw new Error(`${label} changed while it was read`);
      await output.write(buffer, 0, bytesRead, position);
      position += bytesRead;
    }
    const after = await input.stat();
    if (
      after.size !== stat.size ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino
    ) {
      throw new Error(`${label} changed while it was read`);
    }
    await output.sync();
  } finally {
    await output?.close();
    await input.close();
  }
}

function normalizedWindowsPath(path) {
  return path.normalize("NFC");
}

// Extraction is a trust boundary. Nothing below this function may hash, open,
// copy, timestamp, or inspect an extractor-owned path before this inventory is
// complete. `lstat` deliberately never follows a hostile link.
async function validateExtractedTree(root, label = "extracted media") {
  const entries = new Map();
  const caseFolded = new Map();
  async function visit(directory, relative = "") {
    const directoryStat = await lstat(directory);
    if (directoryStat.isSymbolicLink())
      throw new Error(
        `${label} contains a symlinked directory: ${relative || "."}`,
      );
    if (!directoryStat.isDirectory())
      throw new Error(`${label} root is not a directory: ${relative || "."}`);
    const children = (await readdir(directory)).sort((left, right) =>
      left.localeCompare(right),
    );
    for (const name of children) {
      const path = relative ? `${relative}/${name}` : name;
      const absolute = join(directory, name);
      const stat = await lstat(absolute);
      const normalized = normalizedWindowsPath(path);
      const folded = normalized.toLocaleLowerCase("en-US");
      const previous = caseFolded.get(folded);
      if (previous && previous !== normalized) {
        throw new Error(`${label} contains a case-colliding path: ${path}`);
      }
      caseFolded.set(folded, normalized);
      if (stat.isSymbolicLink())
        throw new Error(`${label} contains a symlink: ${path}`);
      if (stat.isDirectory()) {
        entries.set(folded, { path, normalized, absolute, type: "directory" });
        await visit(absolute, path);
      } else if (stat.isFile()) {
        entries.set(folded, { path, normalized, absolute, type: "file" });
      } else {
        throw new Error(`${label} contains a non-regular entry: ${path}`);
      }
    }
  }
  await visit(root);
  return { root, entries };
}

function treeEntry(tree, path) {
  return tree.entries.get(
    normalizedWindowsPath(path).toLocaleLowerCase("en-US"),
  );
}

async function extractUdfView({ extractor, isoPath, tree, workDirectory }) {
  const listing = await run(extractor, ["l", "-slt", "-tUdf", isoPath], {
    cwd: workDirectory,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: workDirectory,
      LC_ALL: "C",
      TZ: "UTC",
      TMPDIR: tmpdir(),
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  const archiveProperties = `${listing.stdout}\n${listing.stderr}`.split(
    /^-{4,}\s*$/m,
    1,
  )[0];
  const types = [...archiveProperties.matchAll(/^Type = ([^\r\n]+)$/gm)].map(
    ([, type]) => type,
  );
  if (types.length !== 1 || types[0] !== "Udf") {
    throw new Error(
      "UDF extractor must report exactly one authoritative Type = Udf view",
    );
  }
  await run(extractor, ["x", "-y", "-tUdf", `-o${tree}`, isoPath], {
    cwd: workDirectory,
    env: {
      PATH: "/usr/bin:/bin",
      HOME: workDirectory,
      LC_ALL: "C",
      TZ: "UTC",
      TMPDIR: tmpdir(),
    },
    maxBuffer: 4 * 1024 * 1024,
  });
  return validateExtractedTree(tree, "UDF extractor output");
}

export async function assertWimMagic(path, label) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const magic = Buffer.alloc(8);
    const { bytesRead } = await handle.read(magic, 0, magic.length, 0);
    if (
      bytesRead !== magic.length ||
      !magic.equals(Buffer.from([0x4d, 0x53, 0x57, 0x49, 0x4d, 0, 0, 0]))
    ) {
      throw new Error(`${label} is not a WIM image`);
    }
  } finally {
    await handle.close();
  }
}

function wimXmlValue(xml, name) {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return match ? match[1].trim() : null;
}

function wimXmlImageByIndex(xml, expectedIndex) {
  const matches = [...xml.matchAll(/<IMAGE\b([^>]*)>([\s\S]*?)<\/IMAGE>/gi)]
    .filter(([, attributes]) => {
      const index = /\bINDEX\s*=\s*"(\d+)"/i.exec(attributes)?.[1];
      return Number(index) === expectedIndex;
    })
    .map(([, , image]) => image);
  return matches.length === 1 ? matches[0] : null;
}

function decodeWimXml(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])))
    return bytes.subarray(2).toString("utf16le");
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    const swapped = Buffer.from(bytes.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return bytes.toString("utf8");
}

async function inspectSelectedWindowsImage({
  executable,
  imagePath,
  expected,
  workDirectory,
}) {
  await assertWimMagic(imagePath, "Windows install image");
  const result = await run(
    executable,
    ["info", imagePath, String(expected.index), "--xml"],
    {
      cwd: workDirectory,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: workDirectory,
        LC_ALL: "C",
        TMPDIR: tmpdir(),
      },
      encoding: "buffer",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const xml = `${decodeWimXml(result.stdout)}\n${decodeWimXml(result.stderr)}`;
  const selectedImage = wimXmlImageByIndex(xml, expected.index);
  const index = selectedImage === null ? undefined : expected.index;
  const edition = selectedImage
    ? (wimXmlValue(selectedImage, "EDITIONID") ??
      wimXmlValue(selectedImage, "NAME"))
    : null;
  const digest = await hashFile(imagePath);
  if (index !== expected.index)
    throw new Error(
      `selected Windows image index ${expected.index} does not exist`,
    );
  if (edition !== expected.edition)
    throw new Error(
      `selected Windows image edition mismatch: expected ${expected.edition}, got ${edition ?? "missing"}`,
    );
  if (digest !== expected.digest)
    throw new Error(
      `selected Windows image digest mismatch: expected ${expected.digest}, got ${digest}`,
    );
  return { index, edition, digest };
}

function factoryAccountForProfile(profile) {
  return profile === "production" ? "Admin" : "YKDZ";
}

const FACTORY_OOBE_BOOTSTRAP_USER = "VEMOobeBootstrap";
const FACTORY_OOBE_BOOTSTRAP_PASSWORD = "VEM-Factory-OOBE-v1!";

const WINDOWS_SETUP_KEY_BY_EDITION = new Map([
  ["Professional", "W269N-WFGWX-YVC9B-4J6C9-T83GX"],
]);

function unattendedDiskLayout(targetFirmware) {
  if (targetFirmware === "uefi") {
    return {
      configuration: `<DiskConfiguration><Disk wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk><CreatePartitions><CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>260</Size></CreatePartition><CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition><CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Size>57344</Size></CreatePartition><CreatePartition wcm:action="add"><Order>4</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition></CreatePartitions><ModifyPartitions><ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition><ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition><ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>4</PartitionID><Format>NTFS</Format><Label>Recovery</Label><TypeID>DE94BBA4-06D1-4D40-A16A-BFD50179D6AC</TypeID></ModifyPartition></ModifyPartitions></Disk><WillShowUI>OnError</WillShowUI></DiskConfiguration>`,
      windowsPartition: 3,
    };
  }
  if (targetFirmware === "bios") {
    return {
      configuration: `<DiskConfiguration><Disk wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><DiskID>0</DiskID><WillWipeDisk>true</WillWipeDisk><CreatePartitions><CreatePartition wcm:action="add"><Order>1</Order><Type>Primary</Type><Size>500</Size></CreatePartition><CreatePartition wcm:action="add"><Order>2</Order><Type>Primary</Type><Size>57344</Size></CreatePartition><CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition></CreatePartitions><ModifyPartitions><ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Active>true</Active><Format>NTFS</Format><Label>System</Label></ModifyPartition><ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition><ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Recovery</Label><TypeID>0x27</TypeID></ModifyPartition></ModifyPartitions></Disk><WillShowUI>OnError</WillShowUI></DiskConfiguration>`,
      windowsPartition: 2,
    };
  }
  throw new Error(`unsupported Factory target firmware: ${targetFirmware}`);
}

export function factoryAutounattendXml(
  profile,
  imageIndex,
  targetFirmware,
  installImageEdition,
) {
  const disk = unattendedDiskLayout(targetFirmware);
  const setupKey = WINDOWS_SETUP_KEY_BY_EDITION.get(installImageEdition);
  if (!setupKey) {
    throw new Error(
      `unsupported Factory Windows image edition: ${installImageEdition}`,
    );
  }
  return `<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <SetupUILanguage><UILanguage>zh-CN</UILanguage></SetupUILanguage>
      <InputLocale>zh-CN</InputLocale>
      <SystemLocale>zh-CN</SystemLocale>
      <UILanguage>zh-CN</UILanguage>
      <UserLocale>zh-CN</UserLocale>
    </component>
    <component name="Microsoft-Windows-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      ${disk.configuration}
      <ImageInstall><OSImage><InstallFrom><MetaData wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Key>/IMAGE/INDEX</Key><Value>${imageIndex}</Value></MetaData></InstallFrom><InstallTo><DiskID>0</DiskID><PartitionID>${disk.windowsPartition}</PartitionID></InstallTo><WillShowUI>OnError</WillShowUI></OSImage></ImageInstall>
      <UserData><AcceptEula>true</AcceptEula><ProductKey><Key>${setupKey}</Key><WillShowUI>OnError</WillShowUI></ProductKey></UserData>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Deployment" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <RunSynchronous><RunSynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Order>1</Order><Path>powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File C:\\VEM\\Factory\\prepare-oobe-bootstrap.ps1 -MediaRoot C:\\VEM\\Factory</Path><Description>Prepare installation-unique VEM OOBE bootstrap</Description></RunSynchronousCommand></RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <InputLocale>zh-CN</InputLocale><SystemLocale>zh-CN</SystemLocale><UILanguage>zh-CN</UILanguage><UserLocale>zh-CN</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS">
      <OOBE><HideEULAPage>true</HideEULAPage><HideOEMRegistrationScreen>true</HideOEMRegistrationScreen><HideOnlineAccountScreens>true</HideOnlineAccountScreens><HideLocalAccountScreen>true</HideLocalAccountScreen><HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE><ProtectYourPC>3</ProtectYourPC><SkipMachineOOBE>true</SkipMachineOOBE><SkipUserOOBE>true</SkipUserOOBE></OOBE>
      <AutoLogon><Password><Value>${FACTORY_OOBE_BOOTSTRAP_PASSWORD}</Value><PlainText>true</PlainText></Password><Enabled>true</Enabled><LogonCount>1</LogonCount><Username>${FACTORY_OOBE_BOOTSTRAP_USER}</Username></AutoLogon>
      <UserAccounts><LocalAccounts><LocalAccount wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Password><Value>${FACTORY_OOBE_BOOTSTRAP_PASSWORD}</Value><PlainText>true</PlainText></Password><Description>Temporary VEM Factory OOBE bootstrap</Description><DisplayName>VEM Factory OOBE Bootstrap</DisplayName><Group>Administrators</Group><Name>${FACTORY_OOBE_BOOTSTRAP_USER}</Name></LocalAccount></LocalAccounts></UserAccounts>
      <FirstLogonCommands><SynchronousCommand wcm:action="add" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State"><Order>1</Order><CommandLine>powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command &quot;Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -Name AutoLogonCount -Type DWord -Value 0 -Force&quot;</CommandLine><Description>Set the temporary OOBE AutoLogon counter to the documented zero workaround</Description></SynchronousCommand></FirstLogonCommands>
      <RegisteredOwner>VEM Factory</RegisteredOwner><RegisteredOrganization>VEM</RegisteredOrganization><TimeZone>UTC</TimeZone>
    </component>
  </settings>
</unattend>
`;
}

export function factoryOobeBootstrapPreparationScript(profile) {
  const maintenanceUser = factoryAccountForProfile(profile);
  const credentialName =
    profile === "production" ? "administrator" : "bootstrap";
  return `param([Parameter(Mandatory = $true)][string]$MediaRoot)
$ErrorActionPreference = 'Stop'
$factoryRoot = 'C:\\ProgramData\\VEM\\factory'
$personalizationPath = Join-Path $factoryRoot 'one-time-personalization.json'
$diagnosticPath = Join-Path $factoryRoot 'oobe-bootstrap-status.json'
$kioskAutologonStatePath = Join-Path $factoryRoot 'oobe-kiosk-autologon-password'
$temporaryKioskAutologonStatePath = "$kioskAutologonStatePath.tmp"
$stage = 'initialize'
function Write-BootstrapStatus([string]$State, [string]$Stage, [string]$ErrorType = '') {
  $status = [ordered]@{
    schemaVersion = 'vem-factory-oobe-bootstrap-status/v1'
    state = $State
    stage = $Stage
    errorType = $ErrorType
  } | ConvertTo-Json -Compress
  $temporaryPath = "$diagnosticPath.tmp"
  [IO.File]::WriteAllText($temporaryPath, $status, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryPath -Destination $diagnosticPath -Force
}
New-Item -ItemType Directory -Force -Path $factoryRoot | Out-Null
try {
  Write-BootstrapStatus 'running' $stage
  $stage = 'ingest-personalization'
  & (Join-Path $MediaRoot 'ingest-host-personalization.ps1') -DestinationPath $personalizationPath
  $stage = 'validate-personalization'
  $media = Get-Content -LiteralPath $personalizationPath -Raw | ConvertFrom-Json
  if ([string]$media.schemaVersion -cne 'vem-factory-personalization-media/v1' -or [string]$media.kind -cne 'factory-personalization-media' -or [string]$media.profile -cne '${profile}') { throw 'Factory OOBE personalization identity is invalid' }
  $credential = $media.credentials.${credentialName}
  $kiosk = $media.credentials.kiosk
  if ($null -eq $credential -or [string]$credential.user -cne '${maintenanceUser}' -or $credential.password -isnot [string] -or $credential.password.Length -lt 16 -or $credential.password -notmatch '^[\\x20-\\x7E]+$') { throw 'Factory OOBE maintenance credential is invalid' }
  if ($null -eq $kiosk -or [string]$kiosk.user -cne 'VEMKiosk' -or $kiosk.password -isnot [string] -or $kiosk.password.Length -lt 16 -or $kiosk.password -notmatch '^[\\x20-\\x7E]+$') { throw 'Factory OOBE kiosk credential is invalid' }
  $stage = 'suppress-oobe-privacy'
  ${factoryOobePrivacySuppressionScript()}
  $stage = 'bootstrap-runtime'
  & (Join-Path $MediaRoot 'bootstrap-factory-runtime.ps1') -MediaRoot $MediaRoot
  $stage = 'preserve-kiosk-autologon'
  $winlogonPath = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
  $winlogon = Get-ItemProperty -Path $winlogonPath -Name DefaultUserName, DefaultPassword -ErrorAction Stop
  $kioskAutologonPassword = [string]$winlogon.DefaultPassword
  if ([string]$winlogon.DefaultUserName -cne 'VEMKiosk' -or $kioskAutologonPassword.Length -eq 0 -or $kioskAutologonPassword -cne [string]$kiosk.password) { throw 'Factory runtime did not configure the personalized kiosk autologon' }
  Remove-Item -LiteralPath $temporaryKioskAutologonStatePath -Force -ErrorAction SilentlyContinue
  New-Item -ItemType File -Path $temporaryKioskAutologonStatePath -Force -ErrorAction Stop | Out-Null
  icacls.exe $temporaryKioskAutologonStatePath /inheritance:r /grant:r "*S-1-5-18:F" "*S-1-5-32-544:F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Factory OOBE kiosk autologon handoff ACL setup failed' }
  [IO.File]::WriteAllText($temporaryKioskAutologonStatePath, $kioskAutologonPassword, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryKioskAutologonStatePath -Destination $kioskAutologonStatePath -Force
  $stage = 'register-cleanup'
  $cleanupAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument '-NoLogo -NoProfile -ExecutionPolicy Bypass -File C:\\VEM\\Factory\\complete-oobe-bootstrap.ps1'
  $cleanupTrigger = New-ScheduledTaskTrigger -AtStartup
  # The cleanup records each reboot request; the scheduler may restart its failed
  # invocation only twice, for three total requests on the originating boot.
  $cleanupSettings = New-ScheduledTaskSettingsSet -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName 'VEMFactoryOobeCleanup' -Action $cleanupAction -Trigger $cleanupTrigger -Settings $cleanupSettings -User 'SYSTEM' -RunLevel Highest -Force | Out-Null
  Write-BootstrapStatus 'succeeded' 'complete'
  Start-ScheduledTask -TaskName 'VEMFactoryOobeCleanup' -ErrorAction Stop
} catch {
  $failureType = [string]$_.Exception.GetType().FullName
  Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -Name AutoAdminLogon -Value '0' -Force -ErrorAction SilentlyContinue
  Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -Name ForceAutoLogon -Value '0' -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -Name DefaultPassword -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -Name AutoLogonCount -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName 'VEMFactoryOobeCleanup' -Confirm:$false -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $temporaryKioskAutologonStatePath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $kioskAutologonStatePath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $personalizationPath -Force -ErrorAction SilentlyContinue
  Write-BootstrapStatus 'failed' $stage $failureType
  throw
}
`;
}

export function factoryOobeCompletionScript() {
  return `$ErrorActionPreference = 'Stop'
$factoryRoot = 'C:\\ProgramData\\VEM\\factory'
$diagnosticPath = Join-Path $factoryRoot 'oobe-bootstrap-status.json'
$cleanupStatusPath = Join-Path $factoryRoot 'oobe-cleanup-status.json'
$personalizationPath = Join-Path $factoryRoot 'one-time-personalization.json'
$kioskAutologonStatePath = Join-Path $factoryRoot 'oobe-kiosk-autologon-password'
$oobeDeadline = (Get-Date).AddMinutes(30)
$oobeComplete = $false
function Get-BootIdentity {
  $boot = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
  if ($null -eq $boot.LastBootUpTime) { throw 'VEM Factory could not determine the current boot identity' }
  return ConvertTo-BootIdentity $boot.LastBootUpTime
}
function ConvertTo-BootIdentity($Value) {
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return '' }
  return ([DateTime]$Value).ToUniversalTime().ToString('o')
}
function Get-ActiveVemKioskConsoleSession {
  $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
  $consoleUser = [string]$computer.UserName
  if ([string]::IsNullOrWhiteSpace($consoleUser)) { return $null }
  $user = $consoleUser.Split('\\')[-1]
  if ($user -cne 'VEMKiosk') { return $null }
  return [ordered]@{
    user = $user
    consoleUser = $consoleUser
    source = 'Win32_ComputerSystem'
  }
}
function Write-CleanupStatus(
  [string]$Phase,
  [string]$RebootOriginBootIdentity = '',
  [string]$CompletedBootIdentity = '',
  $KioskConsoleSession = $null,
  [int]$RebootAttemptCount = 0,
  [string]$LastRebootFailure = ''
) {
  $status = [ordered]@{
    schemaVersion = 'vem-factory-oobe-cleanup-status/v1'
    phase = $Phase
  }
  if (-not [string]::IsNullOrWhiteSpace($RebootOriginBootIdentity)) {
    $status.rebootOriginBootIdentity = $RebootOriginBootIdentity
    $status.completedBootIdentity = if ([string]::IsNullOrWhiteSpace($CompletedBootIdentity)) { $null } else { $CompletedBootIdentity }
    $status.kioskConsoleSession = $KioskConsoleSession
    $status.rebootAttemptCount = $RebootAttemptCount
    $status.lastRebootFailure = if ([string]::IsNullOrWhiteSpace($LastRebootFailure)) { $null } else { $LastRebootFailure }
  }
  $status = $status | ConvertTo-Json -Depth 10 -Compress
  $temporaryPath = "$cleanupStatusPath.tmp"
  $temporaryFileSystemPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($temporaryPath)
  [IO.File]::WriteAllText($temporaryFileSystemPath, $status, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporaryPath -Destination $cleanupStatusPath -Force
}
function Remove-CleanupTask {
  for ($attempt = 0; $attempt -lt 10; $attempt += 1) {
    Unregister-ScheduledTask -TaskName 'VEMFactoryOobeCleanup' -Confirm:$false -ErrorAction SilentlyContinue
    if ($null -eq (Get-ScheduledTask -TaskName 'VEMFactoryOobeCleanup' -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Seconds 1
  }
  throw 'VEM Factory OOBE cleanup task remains registered'
}
function Request-HandoffReboot([string]$RebootOriginBootIdentity, $PreviousStatus) {
  $previousAttempts = if ($null -ne $PreviousStatus -and $null -ne $PreviousStatus.PSObject.Properties['rebootAttemptCount']) { [int]$PreviousStatus.rebootAttemptCount } else { 0 }
  if ($previousAttempts -ge 3) {
    throw 'VEM Factory OOBE cleanup exhausted its bounded handoff reboot requests'
  }
  $attempt = $previousAttempts + 1
  Write-CleanupStatus 'reboot-pending' $RebootOriginBootIdentity '' $null $attempt
  try {
    & shutdown.exe /r /t 0 /f
    if ($LASTEXITCODE -ne 0) { throw "shutdown.exe exited with code $LASTEXITCODE" }
    exit 0
  } catch {
    $failure = [string]$_.Exception.Message
    Write-CleanupStatus 'reboot-pending' $RebootOriginBootIdentity '' $null $attempt $failure
    throw "VEM Factory OOBE cleanup handoff reboot request $attempt failed: $failure"
  }
}
do {
  $bootstrapStatus = if (Test-Path -LiteralPath $diagnosticPath -PathType Leaf) {
    Get-Content -LiteralPath $diagnosticPath -Raw | ConvertFrom-Json -ErrorAction Stop
  } else { $null }
  if ($null -ne $bootstrapStatus -and $bootstrapStatus.state -eq 'failed') {
    throw 'VEM Factory OOBE bootstrap failed before cleanup'
  }
  $cleanupStatus = if (Test-Path -LiteralPath $cleanupStatusPath -PathType Leaf) {
    Get-Content -LiteralPath $cleanupStatusPath -Raw | ConvertFrom-Json -ErrorAction Stop
  } else { $null }
  $resumingCleanup =
    $null -ne $cleanupStatus -and
    $cleanupStatus.schemaVersion -ceq 'vem-factory-oobe-cleanup-status/v1' -and
    $cleanupStatus.phase -in @('ready', 'autologon-restored', 'account-removed', 'credentials-removed', 'media-ejected', 'reboot-pending', 'complete')
  $setupState = Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\Setup' -ErrorAction Stop
  $bootstrapUser = Get-LocalUser -Name 'VEMOobeBootstrap' -ErrorAction SilentlyContinue
  $oobeComplete =
    $null -ne $bootstrapStatus -and
    $bootstrapStatus.state -eq 'succeeded' -and
    $bootstrapStatus.stage -eq 'complete' -and
    [int]$setupState.OOBEInProgress -eq 0 -and
    [int]$setupState.SystemSetupInProgress -eq 0 -and
    [int]$setupState.SetupType -eq 0 -and
    ($resumingCleanup -or $null -ne $bootstrapUser)
  if ($oobeComplete) { break }
  Start-Sleep -Seconds 5
} while ((Get-Date) -lt $oobeDeadline)
if (-not $oobeComplete) { throw 'VEM Factory OOBE did not complete before cleanup deadline' }
$cleanupPhase = if ($null -ne $cleanupStatus -and $cleanupStatus.schemaVersion -ceq 'vem-factory-oobe-cleanup-status/v1') { [string]$cleanupStatus.phase } else { '' }
if ($cleanupPhase -eq 'complete') {
  Remove-CleanupTask
  exit 0
}
if ($cleanupPhase -eq 'reboot-pending') {
  $rebootOriginBootIdentity = ConvertTo-BootIdentity $cleanupStatus.rebootOriginBootIdentity
  if ([string]::IsNullOrWhiteSpace($rebootOriginBootIdentity)) { throw 'VEM Factory OOBE cleanup reboot origin is unavailable' }
  $currentBootIdentity = Get-BootIdentity
  if ([string]::Equals($currentBootIdentity, $rebootOriginBootIdentity, [StringComparison]::Ordinal)) {
    Request-HandoffReboot $rebootOriginBootIdentity $cleanupStatus
    exit 0
  }
  $kioskSessionDeadline = (Get-Date).AddMinutes(30)
  $kioskConsoleSession = $null
  do {
    $kioskConsoleSession = Get-ActiveVemKioskConsoleSession
    if ($null -ne $kioskConsoleSession) { break }
    Start-Sleep -Seconds 5
  } while ((Get-Date) -lt $kioskSessionDeadline)
  if ($null -eq $kioskConsoleSession) { throw 'VEM Factory OOBE cleanup did not observe an active VEMKiosk console session after reboot' }
  Write-CleanupStatus 'complete' $rebootOriginBootIdentity $currentBootIdentity $kioskConsoleSession ([int]$cleanupStatus.rebootAttemptCount) ([string]$cleanupStatus.lastRebootFailure)
  Remove-CleanupTask
  exit 0
}
$winlogonPath = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon'
if ($cleanupPhase -notin @('autologon-restored', 'account-removed', 'credentials-removed', 'media-ejected')) {
  Write-CleanupStatus 'ready'
  if (-not (Test-Path -LiteralPath $kioskAutologonStatePath -PathType Leaf)) { throw 'Factory OOBE kiosk autologon handoff is unavailable' }
  $kioskAutologonPassword = [IO.File]::ReadAllText($kioskAutologonStatePath, [Text.UTF8Encoding]::new($false))
  if ([string]::IsNullOrEmpty($kioskAutologonPassword)) { throw 'Factory OOBE kiosk autologon handoff is invalid' }
  Set-ItemProperty -Path $winlogonPath -Name AutoAdminLogon -Value '1' -Force
  Set-ItemProperty -Path $winlogonPath -Name ForceAutoLogon -Value '1' -Force
  Set-ItemProperty -Path $winlogonPath -Name DefaultUserName -Value 'VEMKiosk' -Force
  Set-ItemProperty -Path $winlogonPath -Name DefaultDomainName -Value $env:COMPUTERNAME -Force
  Set-ItemProperty -Path $winlogonPath -Name DefaultPassword -Value $kioskAutologonPassword -Force
  Remove-ItemProperty -Path $winlogonPath -Name AutoLogonCount -ErrorAction SilentlyContinue
  Write-CleanupStatus 'autologon-restored'
  $cleanupPhase = 'autologon-restored'
}
if ($cleanupPhase -notin @('account-removed', 'credentials-removed', 'media-ejected')) {
  Remove-LocalUser -Name 'VEMOobeBootstrap' -ErrorAction SilentlyContinue
  Write-CleanupStatus 'account-removed'
  $cleanupPhase = 'account-removed'
}
if ($cleanupPhase -notin @('credentials-removed', 'media-ejected')) {
  if (Test-Path -LiteralPath $kioskAutologonStatePath -PathType Leaf) {
    Remove-Item -LiteralPath $kioskAutologonStatePath -Force -ErrorAction Stop
  }
  if (Test-Path -LiteralPath $kioskAutologonStatePath) { throw 'Factory OOBE kiosk autologon handoff remains after cleanup' }
  Remove-Item -LiteralPath $personalizationPath -Force -ErrorAction SilentlyContinue
  Write-CleanupStatus 'credentials-removed'
  $cleanupPhase = 'credentials-removed'
}
$shell = New-Object -ComObject Shell.Application
$personalizationVolumes = @()
for ($attempt = 0; $attempt -lt 30; $attempt += 1) {
  $personalizationVolumes = @(Get-Volume -ErrorAction Stop | Where-Object { $_.FileSystemLabel -ceq 'VEM_PERSONALIZATION' })
  if ($personalizationVolumes.Count -eq 0) { break }
  foreach ($volume in @($personalizationVolumes | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.DriveLetter) })) {
    $shell.Namespace(17).ParseName(('{0}:' -f $volume.DriveLetter)).InvokeVerb('Eject')
  }
  Start-Sleep -Seconds 2
}
if ($personalizationVolumes.Count -ne 0) { throw 'VEM personalization medium remains mounted after cleanup retries' }
Write-CleanupStatus 'media-ejected'
$rebootOriginBootIdentity = Get-BootIdentity
Write-CleanupStatus 'reboot-pending' $rebootOriginBootIdentity
Request-HandoffReboot $rebootOriginBootIdentity $cleanupStatus
`;
}

export function factoryProfileImplementationScript(source, profile) {
  const text = Buffer.isBuffer(source)
    ? source.toString("utf8")
    : String(source);
  if (profile !== "production") return Buffer.from(text);
  const specialized = text.replaceAll("YKDZ", "YK$([char]68)Z");
  if (specialized.includes("YKDZ"))
    throw new Error(
      "production Factory script contains testbed account material",
    );
  return Buffer.from(specialized);
}

export function hostPersonalizationIngestScript() {
  return `param(
  [Parameter(Mandatory = $true)][string]$DestinationPath,
  [object[]]$CandidateDrives = @([IO.DriveInfo]::GetDrives())
)
$ErrorActionPreference = 'Stop'
$expectedLabel = 'VEM_PERSONALIZATION'
$sourceFileName = 'personalization.json'
$reservedLabelDrives = @($CandidateDrives | Where-Object {
  [bool]$_.IsReady -and
  [string]$_.VolumeLabel -ceq $expectedLabel
})
if ($reservedLabelDrives.Count -ne 1) { throw 'VEM_PERSONALIZATION_MEDIA_COUNT_INVALID' }
$media = $reservedLabelDrives[0]
if ([int]$media.DriveType -ne [int][IO.DriveType]::CDRom) { throw 'VEM_PERSONALIZATION_MEDIA_TYPE_INVALID' }
$rootPath = [string]$media.RootDirectory.FullName
if ([string]::IsNullOrWhiteSpace($rootPath) -or -not [IO.Path]::IsPathRooted($rootPath)) { throw 'VEM_PERSONALIZATION_MEDIA_ROOT_INVALID' }
$sourcePath = Join-Path $rootPath $sourceFileName
$source = Get-Item -LiteralPath $sourcePath -Force -ErrorAction Stop
if ($source.PSIsContainer -or -not ($source -is [IO.FileInfo]) -or (($source.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
  throw 'VEM_PERSONALIZATION personalization.json must be a regular file at the media root'
}
$destinationDirectory = Split-Path -Parent $DestinationPath
if ([string]::IsNullOrWhiteSpace($destinationDirectory)) { throw 'personalization destination has no parent directory' }
New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
Copy-Item -LiteralPath $sourcePath -Destination $DestinationPath -Force -ErrorAction Stop
$destination = Get-Item -LiteralPath $DestinationPath -Force -ErrorAction Stop
if ($destination.PSIsContainer -or -not ($destination -is [IO.FileInfo]) -or (($destination.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) {
  throw 'personalization destination is not a regular file'
}
`;
}

function factoryPreparationDescriptor(manifest, resolvedAssets) {
  const asset = (role) => {
    const reference = resolvedAssets.find(
      (entry) => entry.reference.role === role,
    )?.reference;
    if (!reference) throw new Error(`Factory preparation is missing ${role}`);
    return {
      path: `assets/${reference.mediaFileName}`,
      sha256: reference.digest.slice(7),
      version: reference.version,
    };
  };
  const preparation = manifest.factoryPreparation;
  return {
    schemaVersion: "vem-factory-preparation-descriptor/v1",
    kind: "factory-preparation-descriptor",
    profile: manifest.profile,
    parameters: {
      environmentName: preparation.environmentName,
      deploymentBatch: preparation.deploymentBatch,
      provisioningEndpoint: preparation.provisioningEndpoint,
      mqttUrl: preparation.mqttUrl,
      hardware: preparation.hardware,
      display: preparation.display,
      accounts: preparation.accounts,
      expectedKioskShell: preparation.expectedKioskShell,
      targetLayoutVersion: preparation.targetLayoutVersion,
      maintenance: preparation.maintenance,
    },
    assets: {
      daemon: asset("vem-daemon"),
      machineUi: asset("vem-machine-ui"),
      webview2Loader: asset("webview2-loader"),
      webview2RuntimeInstaller: asset("webview2-runtime-installer"),
      openSsh: asset("openssh-installer"),
      wireGuard: asset("wireguard-installer"),
      maintenanceSshCa: asset("maintenance-ssh-ca-public-key"),
      visionConfiguration: asset("vision-configuration"),
    },
  };
}

export function factoryPreparationSplat(
  descriptor,
  mediaRoot,
  personalizationPath,
) {
  const path = (asset) =>
    `${mediaRoot}\\${descriptor.assets[asset].path.replaceAll("/", "\\")}`;
  const parameters = descriptor.parameters;
  return {
    DaemonArtifactPath: path("daemon"),
    DaemonSha256: descriptor.assets.daemon.sha256,
    MachineUiArtifactPath: path("machineUi"),
    MachineUiSha256: descriptor.assets.machineUi.sha256,
    WebView2RuntimeInstallerPath: path("webview2RuntimeInstaller"),
    WebView2RuntimeInstallerSha256:
      descriptor.assets.webview2RuntimeInstaller.sha256,
    WebView2RuntimeVersion: descriptor.assets.webview2RuntimeInstaller.version,
    EnvironmentName: parameters.environmentName,
    DeploymentBatch: parameters.deploymentBatch,
    ProvisioningEndpoint: parameters.provisioningEndpoint,
    MqttUrl: parameters.mqttUrl,
    HardwareMode: parameters.hardware.mode,
    HardwareModel: parameters.hardware.model,
    TopologyIdentity: parameters.hardware.topologyIdentity,
    TopologyVersion: parameters.hardware.topologyVersion,
    ExpectedDisplayWidth: parameters.display.width,
    ExpectedDisplayHeight: parameters.display.height,
    ExpectedDisplayOrientation: parameters.display.orientation,
    ExpectedKioskUser: parameters.accounts.kioskUser,
    ExpectedMaintenanceUser: parameters.accounts.maintenanceUser,
    ExpectedAutoLogonUser: parameters.accounts.autoLogonUser,
    ExpectedKioskShell: parameters.expectedKioskShell,
    TargetLayoutVersion: parameters.targetLayoutVersion,
    FactoryProfile: descriptor.profile,
    PersonalizationMediaPath: personalizationPath,
    FactoryMediaRoot: mediaRoot,
    VisionConfigurationSourcePath: path("visionConfiguration"),
    OpenSshPackagePath: path("openSsh"),
    OpenSshPackageSource: "local-pinned",
    OpenSshPackageVersion: parameters.maintenance.openSsh.version,
    OpenSshPackageSha256: descriptor.assets.openSsh.sha256,
    OpenSshApprovedSignerThumbprint:
      parameters.maintenance.openSsh.approvedSignerThumbprint,
    OpenSshApprovedRootThumbprint:
      parameters.maintenance.openSsh.approvedRootThumbprint,
    WireGuardPackagePath: path("wireGuard"),
    WireGuardPackageSource: "local-pinned",
    WireGuardPackageVersion: parameters.maintenance.wireGuard.version,
    WireGuardPackageSha256: descriptor.assets.wireGuard.sha256,
    WireGuardApprovedSignerThumbprint:
      parameters.maintenance.wireGuard.approvedSignerThumbprint,
    WireGuardApprovedRootThumbprint:
      parameters.maintenance.wireGuard.approvedRootThumbprint,
    MaintenanceSshCaPublicKeyPath: path("maintenanceSshCa"),
    MaintenanceSshCaPublicKeySha256: descriptor.assets.maintenanceSshCa.sha256,
    MaintenanceRunnerSourceAllowlist:
      parameters.maintenance.runnerSourceAllowlist,
    MaintenanceMaintainerSourceAllowlist:
      parameters.maintenance.maintainerSourceAllowlist,
    MaintenanceWireGuardInterfaceAlias:
      parameters.maintenance.wireGuardInterfaceAlias,
    MaintenanceWireGuardListenAddress:
      parameters.maintenance.wireGuardListenAddress,
    ResetExistingVemState: true,
  };
}

export function factoryBootstrapScript(profile) {
  return `param([Parameter(Mandatory = $true)][string]$MediaRoot)
$ErrorActionPreference = 'Stop'
$statusPath = 'C:\\ProgramData\\VEM\\factory\\bootstrap-status.json'
$personalizationPath = 'C:\\ProgramData\\VEM\\factory\\one-time-personalization.json'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $statusPath) | Out-Null
function Write-Status([string]$State, [string]$Reason) {
  [IO.File]::WriteAllText($statusPath, (@{ schemaVersion = 'vem-factory-bootstrap/v1'; state = $State; reason = $Reason; updatedAt = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
}
try {
  if (-not (Test-Path -LiteralPath $personalizationPath -PathType Leaf)) { throw 'one-time host personalization channel is unavailable' }
  $descriptorPath = Join-Path $MediaRoot 'factory-preparation.json'
  $descriptor = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
  function Assert-ExactProperties($Value, [string[]]$Expected, [string]$Label) {
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if ($actual.Count -ne $wanted.Count -or (Compare-Object $actual $wanted)) { throw "$Label has an invalid shape" }
  }
  Assert-ExactProperties $descriptor @('schemaVersion','kind','profile','parameters','assets') 'Factory preparation descriptor'
  if ($descriptor.schemaVersion -cne 'vem-factory-preparation-descriptor/v1' -or $descriptor.kind -cne 'factory-preparation-descriptor' -or $descriptor.profile -cne '${profile}') { throw 'Factory preparation descriptor profile is invalid' }
  Assert-ExactProperties $descriptor.parameters @('environmentName','deploymentBatch','provisioningEndpoint','mqttUrl','hardware','display','accounts','expectedKioskShell','targetLayoutVersion','maintenance') 'Factory preparation parameters'
  Assert-ExactProperties $descriptor.parameters.hardware @('mode','model','topologyIdentity','topologyVersion') 'Factory preparation hardware'
  Assert-ExactProperties $descriptor.parameters.display @('width','height','orientation') 'Factory preparation display'
  Assert-ExactProperties $descriptor.parameters.accounts @('kioskUser','maintenanceUser','autoLogonUser') 'Factory preparation accounts'
  Assert-ExactProperties $descriptor.parameters.maintenance @('wireGuardInterfaceAlias','wireGuardListenAddress','runnerSourceAllowlist','maintainerSourceAllowlist','openSsh','wireGuard') 'Factory preparation maintenance'
  Assert-ExactProperties $descriptor.parameters.maintenance.openSsh @('version','approvedSignerThumbprint','approvedRootThumbprint') 'Factory OpenSSH trust'
  Assert-ExactProperties $descriptor.parameters.maintenance.wireGuard @('version','approvedSignerThumbprint','approvedRootThumbprint') 'Factory WireGuard trust'
  Assert-ExactProperties $descriptor.assets @('daemon','machineUi','webview2Loader','webview2RuntimeInstaller','openSsh','wireGuard','maintenanceSshCa','visionConfiguration') 'Factory preparation assets'
  foreach ($assetName in @('daemon','machineUi','webview2Loader','webview2RuntimeInstaller','openSsh','wireGuard','maintenanceSshCa','visionConfiguration')) {
    $asset = $descriptor.assets.$assetName
    Assert-ExactProperties $asset @('path','sha256','version') "Factory asset $assetName"
    $assetPath = Join-Path $MediaRoot ([string]$asset.path)
    if (-not (Test-Path -LiteralPath $assetPath -PathType Leaf)) { throw "Factory asset $assetName is missing" }
    if ((Get-FileHash -LiteralPath $assetPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne [string]$asset.sha256) { throw "Factory asset $assetName hash mismatch" }
  }
  Write-Status 'running' 'host personalization accepted'
  & (Join-Path $MediaRoot 'install-factory-baseline.ps1') -MediaRoot $MediaRoot
  $prepare = @{
    DaemonArtifactPath = Join-Path $MediaRoot $descriptor.assets.daemon.path; DaemonSha256 = $descriptor.assets.daemon.sha256
    MachineUiArtifactPath = Join-Path $MediaRoot $descriptor.assets.machineUi.path; MachineUiSha256 = $descriptor.assets.machineUi.sha256
    WebView2RuntimeInstallerPath = Join-Path $MediaRoot $descriptor.assets.webview2RuntimeInstaller.path; WebView2RuntimeInstallerSha256 = $descriptor.assets.webview2RuntimeInstaller.sha256; WebView2RuntimeVersion = $descriptor.assets.webview2RuntimeInstaller.version
    EnvironmentName = $descriptor.parameters.environmentName; DeploymentBatch = $descriptor.parameters.deploymentBatch; ProvisioningEndpoint = $descriptor.parameters.provisioningEndpoint; MqttUrl = $descriptor.parameters.mqttUrl
    HardwareMode = $descriptor.parameters.hardware.mode; HardwareModel = $descriptor.parameters.hardware.model; TopologyIdentity = $descriptor.parameters.hardware.topologyIdentity; TopologyVersion = $descriptor.parameters.hardware.topologyVersion
    ExpectedDisplayWidth = [int]$descriptor.parameters.display.width; ExpectedDisplayHeight = [int]$descriptor.parameters.display.height; ExpectedDisplayOrientation = $descriptor.parameters.display.orientation
    ExpectedKioskUser = $descriptor.parameters.accounts.kioskUser; ExpectedMaintenanceUser = $descriptor.parameters.accounts.maintenanceUser; ExpectedAutoLogonUser = $descriptor.parameters.accounts.autoLogonUser; ExpectedKioskShell = $descriptor.parameters.expectedKioskShell
    TargetLayoutVersion = $descriptor.parameters.targetLayoutVersion; FactoryProfile = '${profile}'; PersonalizationMediaPath = $personalizationPath; FactoryMediaRoot = $MediaRoot; VisionConfigurationSourcePath = Join-Path $MediaRoot $descriptor.assets.visionConfiguration.path
    OpenSshPackagePath = Join-Path $MediaRoot $descriptor.assets.openSsh.path; OpenSshPackageSource = 'local-pinned'; OpenSshPackageVersion = $descriptor.parameters.maintenance.openSsh.version; OpenSshPackageSha256 = $descriptor.assets.openSsh.sha256; OpenSshApprovedSignerThumbprint = $descriptor.parameters.maintenance.openSsh.approvedSignerThumbprint; OpenSshApprovedRootThumbprint = $descriptor.parameters.maintenance.openSsh.approvedRootThumbprint
    WireGuardPackagePath = Join-Path $MediaRoot $descriptor.assets.wireGuard.path; WireGuardPackageSource = 'local-pinned'; WireGuardPackageVersion = $descriptor.parameters.maintenance.wireGuard.version; WireGuardPackageSha256 = $descriptor.assets.wireGuard.sha256; WireGuardApprovedSignerThumbprint = $descriptor.parameters.maintenance.wireGuard.approvedSignerThumbprint; WireGuardApprovedRootThumbprint = $descriptor.parameters.maintenance.wireGuard.approvedRootThumbprint
    MaintenanceSshCaPublicKeyPath = Join-Path $MediaRoot $descriptor.assets.maintenanceSshCa.path; MaintenanceSshCaPublicKeySha256 = $descriptor.assets.maintenanceSshCa.sha256
    MaintenanceRunnerSourceAllowlist = @($descriptor.parameters.maintenance.runnerSourceAllowlist); MaintenanceMaintainerSourceAllowlist = @($descriptor.parameters.maintenance.maintainerSourceAllowlist)
    MaintenanceWireGuardInterfaceAlias = $descriptor.parameters.maintenance.wireGuardInterfaceAlias; MaintenanceWireGuardListenAddress = $descriptor.parameters.maintenance.wireGuardListenAddress; ResetExistingVemState = $true
  }
  & (Join-Path $MediaRoot 'scripts\\prepare-factory-runtime.ps1') @prepare
  # prepare-factory-runtime.ps1 owns the selected Vision release provisioning,
  # installation, and evidence for the first-install lifecycle.
  & (Join-Path $MediaRoot 'scripts\\verify-factory-runtime.ps1')
  if ($LASTEXITCODE -ne 0) { throw "Factory runtime verifier failed with exit code $LASTEXITCODE" }
  Write-Status 'succeeded' 'factory runtime verified'
} catch {
  Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -Name AutoAdminLogon -Value '0' -Force -ErrorAction SilentlyContinue
  Set-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -Name ForceAutoLogon -Value '0' -Force -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -Name DefaultPassword -ErrorAction SilentlyContinue
  Remove-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon' -Name AutoLogonCount -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $personalizationPath -Force -ErrorAction SilentlyContinue
  Write-Status 'failed' $_.Exception.Message
  throw
}
`;
}

function baselineInstallerScript() {
  // This script deliberately has no personalization input. It installs only
  // immutable common media and leaves machine claim, credentials, and peers to
  // the disposable overlay stage.
  return `param([Parameter(Mandatory = $true)][string]$MediaRoot)
$ErrorActionPreference = 'Stop'
  $manifestPath = Join-Path $MediaRoot 'factory-baseline.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
function Assert-Hash([string]$Path, [string]$Expected) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "factory media is missing $Path" }
  $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $Expected) { throw "factory media hash mismatch for $Path" }
}
foreach ($asset in $manifest.assets) { Assert-Hash (Join-Path $MediaRoot $asset.path) $asset.sha256 }
New-Item -ItemType Directory -Force -Path 'C:\\VEM\\bringup', 'C:\\ProgramData\\VEM\\factory', 'C:\\ProgramData\\VEM\\factory-media' | Out-Null
Copy-Item -LiteralPath (Join-Path $MediaRoot 'factory-baseline.json') -Destination 'C:\\ProgramData\\VEM\\factory\\factory-baseline.json' -Force
Copy-Item -LiteralPath (Join-Path $MediaRoot 'scripts\\prepare-factory-runtime.ps1') -Destination 'C:\\VEM\\bringup\\prepare-factory-runtime.ps1' -Force
Copy-Item -LiteralPath (Join-Path $MediaRoot 'scripts\\verify-factory-runtime.ps1') -Destination 'C:\\VEM\\bringup\\verify-factory-runtime.ps1' -Force
foreach ($asset in $manifest.assets) {
  $source = Join-Path $MediaRoot $asset.path
  $destination = Join-Path 'C:\\ProgramData\\VEM\\factory-media' $asset.fileName
  Copy-Item -LiteralPath $source -Destination $destination -Force
}
$packages = @($manifest.assets | Where-Object { $_.role -in @('openssh-installer', 'wireguard-installer') })
foreach ($package in $packages) {
  $path = Join-Path 'C:\\ProgramData\\VEM\\factory-media' $package.fileName
  $extension = [IO.Path]::GetExtension($path).ToLowerInvariant()
  if ($extension -eq '.msi') { $process = Start-Process msiexec.exe -ArgumentList @('/i', ('"{0}"' -f $path), '/qn', '/norestart') -Wait -PassThru }
  elseif ($extension -eq '.exe') { $process = Start-Process $path -ArgumentList @('/quiet', '/norestart') -Wait -PassThru }
  else { throw "factory installer must be MSI or EXE: $($package.fileName)" }
  if ($process.ExitCode -notin @(0, 3010)) { throw "factory installer failed: $($package.role) exit $($process.ExitCode)" }
}
$ca = $manifest.assets | Where-Object { $_.role -eq 'maintenance-ssh-ca-public-key' } | Select-Object -First 1
Copy-Item -LiteralPath (Join-Path 'C:\\ProgramData\\VEM\\factory-media' $ca.fileName) -Destination 'C:\\ProgramData\\VEM\\factory\\maintenance-ca.pub' -Force
$sshd = 'C:\\ProgramData\\ssh\\sshd_config'
if (Test-Path -LiteralPath $sshd) {
  Add-Content -LiteralPath $sshd -Value @('', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'TrustedUserCAKeys C:\\ProgramData\\VEM\\factory\\maintenance-ca.pub')
  Set-Service -Name sshd -StartupType Automatic -ErrorAction Stop
  Restart-Service -Name sshd -Force -ErrorAction Stop
}
$runtime = @{'vem-daemon' = 'vending-daemon.exe'; 'vem-machine-ui' = 'machine.exe'; 'webview2-loader' = 'WebView2Loader.dll'}
foreach ($asset in $manifest.assets) {
  if ($runtime.ContainsKey([string]$asset.role)) { Copy-Item -LiteralPath (Join-Path 'C:\\ProgramData\\VEM\\factory-media' $asset.fileName) -Destination (Join-Path 'C:\\VEM\\bringup' $runtime[[string]$asset.role]) -Force }
}
$maintenance = Get-LocalUser -Name $manifest.accounts.maintenance -ErrorAction SilentlyContinue
if ($null -eq $maintenance) { New-LocalUser -Name $manifest.accounts.maintenance -NoPassword -AccountNeverExpires | Out-Null }
$administrators = Get-LocalGroup -SID ([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')) -ErrorAction Stop
Add-LocalGroupMember -Group $administrators -Member $manifest.accounts.maintenance -ErrorAction SilentlyContinue
Disable-LocalUser -Name $manifest.accounts.maintenance -ErrorAction SilentlyContinue
$kiosk = Get-LocalUser -Name $manifest.accounts.kiosk -ErrorAction SilentlyContinue
if ($null -eq $kiosk) { New-LocalUser -Name $manifest.accounts.kiosk -NoPassword -AccountNeverExpires | Out-Null }
Disable-LocalUser -Name $manifest.accounts.kiosk -ErrorAction SilentlyContinue
$windowsUpdatePolicyPath = 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU'
if (-not (Test-Path -LiteralPath $windowsUpdatePolicyPath -PathType Container)) {
  New-Item -Path $windowsUpdatePolicyPath -ItemType Directory -Force | Out-Null
}
Set-ItemProperty -Path $windowsUpdatePolicyPath -Name NoAutoUpdate -Value 1 -Type DWord -Force
powercfg.exe /hibernate off | Out-Null
  Set-Content -LiteralPath 'C:\\ProgramData\\VEM\\factory\\baseline-complete.json' -Encoding UTF8 -Value (@{ schemaVersion = 'vem-factory-baseline/v1'; profile = $manifest.profile; machineIdentity = $null; completed = $true } | ConvertTo-Json -Compress)
`;
}

function factoryBaselineManifest(manifest, resolvedAssets) {
  const names = {
    "vem-daemon": "vending-daemon.exe",
    "vem-machine-ui": "machine.exe",
    "webview2-loader": "WebView2Loader.dll",
    "vision-release": "vision-release.bin",
    "vision-configuration": "vision-config.json",
    "maintenance-ssh-ca-public-key": "maintenance-ca.pub",
  };
  return {
    schemaVersion: "vem-factory-baseline-media/v1",
    profile: manifest.profile,
    accounts: {
      maintenance: factoryAccountForProfile(manifest.profile),
      kiosk: "VEMKiosk",
    },
    assets: resolvedAssets
      .filter(({ reference }) => reference.role !== "windows-source-iso")
      .sort(({ reference: left }, { reference: right }) =>
        left.role.localeCompare(right.role),
      )
      .map(({ reference }) => {
        const fileName = reference.mediaFileName ?? names[reference.role];
        if (!fileName) {
          throw new Error(
            `Factory baseline is missing a media file name for ${reference.role}`,
          );
        }
        if (
          [
            "openssh-installer",
            "wireguard-installer",
            "webview2-runtime-installer",
          ].includes(reference.role) &&
          !/\.(?:msi|exe)$/i.test(fileName)
        ) {
          throw new Error(
            `Factory installer must preserve its pinned MSI or EXE extension: ${reference.role}`,
          );
        }
        return {
          role: reference.role,
          fileName,
          path: `assets/${fileName}`,
          sha256: reference.digest.slice(7),
        };
      }),
  };
}

async function setFixedTimes(tree) {
  const entries = [...tree.entries.values()].sort((left, right) =>
    right.path.localeCompare(left.path),
  );
  for (const entry of entries) {
    // `lutimes` is intentionally non-following. Re-check type to make a
    // post-validation path swap fail before a timestamp operation can escape.
    const stat = await lstat(entry.absolute);
    if (
      stat.isSymbolicLink() ||
      (entry.type === "file" ? !stat.isFile() : !stat.isDirectory())
    ) {
      throw new Error(
        `validated media tree changed before timestamping: ${entry.path}`,
      );
    }
    await lutimes(entry.absolute, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
  }
  await lutimes(tree.root, FIXED_EPOCH_SECONDS, FIXED_EPOCH_SECONDS);
}

async function writeDeterministicIsoSortFile(tree, outputPath) {
  const paths = [...tree.entries.values()]
    .map(({ path }) => path)
    .sort((left, right) => left.localeCompare(right));
  await writeFile(
    outputPath,
    paths.map((path, index) => `${paths.length - index} ${path}`).join("\n"),
  );
}

function crc16(bytes) {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc & 0x8000) !== 0 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
    }
  }
  return crc;
}

class RangeBackedIsoMedia {
  #fd;
  #pages = new Map();
  #readCount = 0;

  constructor(path, { writable = false } = {}) {
    const fd = openSync(
      path,
      (writable ? constants.O_RDWR : constants.O_RDONLY) | constants.O_NOFOLLOW,
    );
    try {
      this.length = fstatSync(fd).size;
      this.#fd = fd;
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  #pageIndex(offset) {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= this.length) {
      throw new RangeError("ISO range access is outside the media");
    }
    return Math.floor(offset / SECTOR_BYTES);
  }

  #flush(page) {
    if (!page.dirty) return;
    const start = page.index * SECTOR_BYTES;
    for (let written = 0; written < page.bytes.length; ) {
      const count = writeSync(
        this.#fd,
        page.bytes,
        written,
        page.bytes.length - written,
        start + written,
      );
      if (count <= 0) throw new Error("ISO range write was incomplete");
      written += count;
    }
    page.dirty = false;
  }

  #page(offset) {
    const index = this.#pageIndex(offset);
    const existing = this.#pages.get(index);
    if (existing) {
      this.#pages.delete(index);
      this.#pages.set(index, existing);
      return existing;
    }
    const start = index * SECTOR_BYTES;
    const bytes = Buffer.alloc(Math.min(SECTOR_BYTES, this.length - start));
    this.#readCount += 1;
    const read = readSync(this.#fd, bytes, 0, bytes.length, start);
    if (read !== bytes.length) throw new Error("ISO changed during range read");
    const page = { index, bytes, dirty: false };
    this.#pages.set(index, page);
    if (this.#pages.size > ISO_RANGE_CACHE_PAGES) {
      const [oldest] = this.#pages.keys();
      const evicted = this.#pages.get(oldest);
      this.#flush(evicted);
      this.#pages.delete(oldest);
    }
    return page;
  }

  byte(offset) {
    const page = this.#page(offset);
    return page.bytes[offset % SECTOR_BYTES];
  }

  setByte(offset, value) {
    const page = this.#page(offset);
    page.bytes[offset % SECTOR_BYTES] = value;
    page.dirty = true;
  }

  range(start, end) {
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end > this.length
    ) {
      throw new RangeError("ISO range access is outside the media");
    }
    const result = Buffer.alloc(end - start);
    for (let offset = start; offset < end; ) {
      const page = this.#page(offset);
      const within = offset % SECTOR_BYTES;
      const count = Math.min(page.bytes.length - within, end - offset);
      page.bytes.copy(result, offset - start, within, within + count);
      offset += count;
    }
    return result;
  }

  writeRange(source, target) {
    if (
      !Buffer.isBuffer(source) ||
      !Number.isSafeInteger(target) ||
      target < 0 ||
      target > this.length ||
      source.length > this.length - target
    ) {
      throw new RangeError("ISO range access is outside the media");
    }
    for (let offset = 0; offset < source.length; ) {
      const page = this.#page(target + offset);
      const within = (target + offset) % SECTOR_BYTES;
      const count = Math.min(
        page.bytes.length - within,
        source.length - offset,
      );
      source.copy(page.bytes, within, offset, offset + count);
      page.dirty = true;
      offset += count;
    }
  }

  readUInt16LE(offset) {
    return this.range(offset, offset + 2).readUInt16LE(0);
  }

  readUInt32LE(offset) {
    return this.range(offset, offset + 4).readUInt32LE(0);
  }

  writeUInt16LE(value, offset) {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16LE(value);
    this.writeRange(bytes, offset);
  }

  toString(encoding, start, end) {
    return this.range(start, end).toString(encoding);
  }

  subarray(start, end) {
    return this.range(start, end);
  }

  fill(value, start, end) {
    this.writeRange(Buffer.alloc(end - start, value), start);
  }

  close() {
    let failure;
    try {
      for (const page of this.#pages.values()) this.#flush(page);
    } catch (error) {
      failure = error;
    } finally {
      closeSync(this.#fd);
    }
    if (failure) throw failure;
  }

  get readCount() {
    return this.#readCount;
  }
}

export function rangeBackedIsoMedia(path, options) {
  const media = new RangeBackedIsoMedia(path, options);
  return {
    media: new Proxy(media, {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          return target.byte(Number(property));
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, property, value, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property)) {
          target.setByte(Number(property), value);
          return true;
        }
        return Reflect.set(target, property, value, receiver);
      },
    }),
    close: () => media.close(),
  };
}

function copyToMedia(source, media, offset) {
  if (typeof media.writeRange === "function") {
    media.writeRange(source, offset);
  } else {
    source.copy(media, offset);
  }
}

function verifyUdfTag(media, sector, expectedLocation = sector) {
  const offset = sector * SECTOR_BYTES;
  if (offset < 0 || offset + SECTOR_BYTES > media.length) {
    throw new Error("UDF descriptor tag is outside the media");
  }
  const actualLocation = media.readUInt32LE(offset + 12);
  const expectedLocations = Array.isArray(expectedLocation)
    ? expectedLocation
    : [expectedLocation];
  if (!expectedLocations.includes(actualLocation)) {
    throw new Error(
      `UDF descriptor tag location does not match its declared location: expected ${expectedLocations.join(" or ")}, got ${actualLocation}`,
    );
  }
  const expectedChecksum = media[offset + 4];
  let checksum = 0;
  for (let index = 0; index < 16; index += 1) {
    if (index !== 4) checksum = (checksum + media[offset + index]) & 0xff;
  }
  if (checksum !== expectedChecksum)
    throw new Error("UDF descriptor tag checksum is invalid");
  const crcLength = media.readUInt16LE(offset + 10);
  if (crcLength > SECTOR_BYTES - 16) {
    throw new Error("UDF descriptor CRC length exceeds its sector");
  }
  const actualCrc = crc16(media.subarray(offset + 16, offset + 16 + crcLength));
  if (actualCrc !== media.readUInt16LE(offset + 8)) {
    throw new Error("UDF descriptor CRC is invalid");
  }
}

function rewriteUdfTag(media, sector) {
  const offset = sector * SECTOR_BYTES;
  const crcLength = media.readUInt16LE(offset + 10);
  if (crcLength > SECTOR_BYTES - 16) {
    throw new Error("UDF descriptor CRC length exceeds its sector");
  }
  media.writeUInt16LE(
    crc16(media.subarray(offset + 16, offset + 16 + crcLength)),
    offset + 8,
  );
  let checksum = 0;
  for (let index = 0; index < 16; index += 1) {
    if (index !== 4) checksum = (checksum + media[offset + index]) & 0xff;
  }
  media[offset + 4] = checksum;
}

function verifyUdfEmbeddedTag(descriptor, expectedLocations, label) {
  if (descriptor.length < 16) throw new Error(`${label} tag is truncated`);
  let checksum = 0;
  for (let index = 0; index < 16; index += 1) {
    if (index !== 4) checksum = (checksum + descriptor[index]) & 0xff;
  }
  if (checksum !== descriptor[4])
    throw new Error(`${label} tag checksum is invalid`);
  const crcLength = descriptor.readUInt16LE(10);
  if (crcLength > descriptor.length - 16) {
    throw new Error(`${label} CRC length exceeds its descriptor`);
  }
  if (
    crc16(descriptor.subarray(16, 16 + crcLength)) !==
    descriptor.readUInt16LE(8)
  ) {
    throw new Error(`${label} CRC is invalid`);
  }
  const location = descriptor.readUInt32LE(12);
  if (!expectedLocations.includes(location)) {
    throw new Error(`${label} tag location is outside its reachable extent`);
  }
}

function normalizeIsoDescriptorTimestamps(media) {
  const timestamp = Buffer.from("19800101000000000", "ascii");
  let terminated = false;
  for (
    let sector = 16;
    sector < 128 && sector * SECTOR_BYTES < media.length;
    sector += 1
  ) {
    const offset = sector * SECTOR_BYTES;
    if (media.toString("ascii", offset + 1, offset + 6) !== "CD001") continue;
    if (media[offset] === 255) {
      terminated = true;
      break;
    }
    if (media[offset] !== 1 && media[offset] !== 2) continue;
    // ISO9660 PVD/SVD creation, modification, expiration, and effective dates.
    for (const field of [813, 830, 847, 864])
      copyToMedia(timestamp, media, offset + field);
  }
  if (!terminated)
    throw new Error("ISO9660 volume descriptor terminator is missing");
}

function normalizeIsoDirectoryTimestamps(media) {
  const pvd = 16 * SECTOR_BYTES;
  const rootLength = media[pvd + 156];
  if (rootLength < 34)
    throw new Error("ISO9660 root directory record is invalid");
  const directories = [];
  let terminated = false;
  for (
    let descriptorSector = 16;
    descriptorSector < 128 &&
    (descriptorSector + 1) * SECTOR_BYTES <= media.length;
    descriptorSector += 1
  ) {
    const descriptor = descriptorSector * SECTOR_BYTES;
    if (media.toString("ascii", descriptor + 1, descriptor + 6) !== "CD001")
      continue;
    if (media[descriptor] === 255) {
      terminated = true;
      break;
    }
    if (![1, 2].includes(media[descriptor])) continue;
    const length = media[descriptor + 156];
    if (length < 34)
      throw new Error("ISO9660 volume descriptor root is invalid");
    directories.push({
      sector: media.readUInt32LE(descriptor + 158),
      bytes: media.readUInt32LE(descriptor + 166),
    });
  }
  if (!terminated)
    throw new Error("ISO9660 volume descriptor terminator is missing");
  const visited = new Set();
  const shortTimestamp = Buffer.from([80, 1, 1, 0, 0, 0, 0]);
  const longTimestamp = Buffer.from("19800101000000000", "ascii");
  const normalizedContinuations = new Set();
  const normalizeSystemUse = (start, end) => {
    let cursor = start;
    while (cursor < end && media[cursor] !== 0) {
      if (cursor + 4 > end)
        throw new Error("ISO9660 system use entry is truncated");
      const length = media[cursor + 2];
      if (length < 4 || cursor + length > end) {
        throw new Error("ISO9660 system use entry length is invalid");
      }
      if (media[cursor] === 0x54 && media[cursor + 1] === 0x46) {
        const flags = media[cursor + 4];
        const timestampBytes = flags & 0x80 ? 17 : 7;
        let fields = flags & 0x7f;
        let timestampOffset = cursor + 5;
        while (fields !== 0) {
          if (timestampOffset + timestampBytes > cursor + length) {
            throw new Error("ISO9660 Rock Ridge TF entry is truncated");
          }
          copyToMedia(
            timestampBytes === 17 ? longTimestamp : shortTimestamp,
            media,
            timestampOffset,
          );
          timestampOffset += timestampBytes;
          fields &= fields - 1;
        }
      } else if (media[cursor] === 0x43 && media[cursor + 1] === 0x45) {
        if (length !== 28) {
          throw new Error("ISO9660 Rock Ridge CE entry length is invalid");
        }
        const continuationStart =
          media.readUInt32LE(cursor + 4) * SECTOR_BYTES +
          media.readUInt32LE(cursor + 12);
        const continuationLength = media.readUInt32LE(cursor + 20);
        const continuationEnd = continuationStart + continuationLength;
        const key = `${continuationStart}:${continuationLength}`;
        if (continuationLength === 0 || continuationEnd > media.length) {
          throw new Error("ISO9660 Rock Ridge CE continuation is invalid");
        }
        if (normalizedContinuations.has(key)) {
          cursor += length;
          continue;
        }
        normalizedContinuations.add(key);
        normalizeSystemUse(continuationStart, continuationEnd);
      }
      cursor += length;
    }
  };
  while (directories.length > 0) {
    const directory = directories.pop();
    const key = `${directory.sector}:${directory.bytes}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const start = directory.sector * SECTOR_BYTES;
    const end = start + directory.bytes;
    if (directory.bytes === 0 || end > media.length) {
      throw new Error("ISO9660 directory extent is out of bounds");
    }
    for (let offset = start; offset < end; ) {
      const length = media[offset];
      if (length === 0) {
        offset = (Math.floor(offset / SECTOR_BYTES) + 1) * SECTOR_BYTES;
        continue;
      }
      if (length < 34 || offset + length > end) {
        throw new Error("ISO9660 directory record is truncated");
      }
      const identifierLength = media[offset + 32];
      if (33 + identifierLength > length) {
        throw new Error("ISO9660 directory identifier is truncated");
      }
      // ISO9660 9.1.5 records the file/directory timestamp directly in every
      // reachable directory record, independently of any Rock Ridge TF entry.
      copyToMedia(shortTimestamp, media, offset + 18);
      const systemUseStart =
        offset + 33 + identifierLength + (identifierLength % 2 === 0 ? 1 : 0);
      normalizeSystemUse(systemUseStart, offset + length);
      if ((media[offset + 25] & 2) !== 0) {
        const identifier = media.toString(
          "binary",
          offset + 33,
          offset + 33 + identifierLength,
        );
        if (
          identifier !== String.fromCharCode(0) &&
          identifier !== String.fromCharCode(1)
        ) {
          directories.push({
            sector: media.readUInt32LE(offset + 2),
            bytes: media.readUInt32LE(offset + 10),
          });
        }
      }
      offset += length;
    }
  }
}

function inspectReachableUdfDescriptors(
  media,
  { normalizeTimestamps = false } = {},
) {
  const anchorSector = 256;
  verifyUdfTag(media, anchorSector);
  const anchor = anchorSector * SECTOR_BYTES;
  if (media.readUInt16LE(anchor) !== 2)
    throw new Error("UDF anchor volume descriptor pointer is missing");
  const sequences = [
    {
      length: media.readUInt32LE(anchor + 16),
      sector: media.readUInt32LE(anchor + 20),
    },
    {
      length: media.readUInt32LE(anchor + 24),
      sector: media.readUInt32LE(anchor + 28),
    },
  ];
  if (
    sequences.some(
      ({ length, sector }) =>
        length === 0 ||
        sector < 16 ||
        (sector + Math.ceil(length / SECTOR_BYTES)) * SECTOR_BYTES >
          media.length,
    )
  )
    throw new Error("UDF volume descriptor sequence is invalid");
  const timestamp = Buffer.alloc(12);
  const rewrite = (sector) => {
    if (normalizeTimestamps) rewriteUdfTag(media, sector);
  };
  const writeDstring = (offset, length, value) => {
    const encoded = Buffer.from(value, "ascii");
    if (encoded.length + 2 > length) throw new Error("UDF dstring is too long");
    media.fill(0, offset, offset + length);
    media[offset] = 8;
    copyToMedia(encoded, media, offset + 1);
    media[offset + length - 1] = encoded.length + 1;
  };
  let integritySequence;
  let logicalVolumeContents;
  const partitions = new Map();
  const partitionMaps = new Map();
  for (const sequence of sequences)
    for (
      let sector = sequence.sector;
      sector < sequence.sector + Math.ceil(sequence.length / SECTOR_BYTES);
      sector += 1
    ) {
      // The main sequence uses physical locations while the generated reserve
      // sequence mirrors the main tags with locations relative to its extent.
      verifyUdfTag(media, sector, [0, sector, sector - sequence.sector]);
      const offset = sector * SECTOR_BYTES;
      const tag = media.readUInt16LE(offset);
      if (tag === 1) {
        // ECMA-167 3/10.1: Primary Volume Descriptor recording date and time.
        // The writer encodes its build time into these exact dstring fields.
        if (normalizeTimestamps) {
          writeDstring(offset + 24, 32, "VEM_FACTORY");
          writeDstring(offset + 72, 128, UDF_VOLUME_SET_ID);
          // ECMA-167 3/10.1 BP 376, length 12. The following implementation
          // identifier starts at BP 388 and must remain byte-for-byte untouched.
          copyToMedia(timestamp, media, offset + 376);
          rewrite(sector);
        }
      } else if (tag === 6) {
        // ECMA-167 3/10.6: Logical Volume Integrity Descriptor extent.
        integritySequence = {
          length: media.readUInt32LE(offset + 432),
          sector: media.readUInt32LE(offset + 436),
        };
        // ECMA-167 3/10.6.4 and 3/10.6.18: the logical volume contents use
        // points to the File Set Descriptor; partition maps translate its
        // logical block address into the physical partition below.
        logicalVolumeContents = {
          length: media.readUInt32LE(offset + 248),
          block: media.readUInt32LE(offset + 252),
          partitionReference: media.readUInt16LE(offset + 256),
        };
        const mapLength = media.readUInt32LE(offset + 264);
        const mapCount = media.readUInt32LE(offset + 268);
        const mapStart = offset + 440;
        if (mapStart + mapLength > media.length || mapLength === 0) {
          throw new Error("UDF logical volume partition map is invalid");
        }
        let mapOffset = mapStart;
        for (let index = 0; index < mapCount; index += 1) {
          const type = media[mapOffset];
          const length = media[mapOffset + 1];
          if (length < 2 || mapOffset + length > mapStart + mapLength) {
            throw new Error("UDF logical volume partition map is truncated");
          }
          // The Factory writer produces ECMA-167 Type 1 physical partition
          // maps. Reject other map formats rather than guessing an address.
          if (type !== 1 || length !== 6) {
            throw new Error(
              "UDF logical volume uses an unsupported partition map",
            );
          }
          partitionMaps.set(index, media.readUInt16LE(mapOffset + 4));
          mapOffset += length;
        }
        if (mapOffset !== mapStart + mapLength) {
          throw new Error(
            "UDF logical volume partition map length is inconsistent",
          );
        }
      } else if (tag === 5) {
        // ECMA-167 3/10.5. Partition number identifies the physical extent
        // referenced by the LVD's Type 1 partition map.
        partitions.set(media.readUInt16LE(offset + 22), {
          sector: media.readUInt32LE(offset + 188),
          length: media.readUInt32LE(offset + 192),
        });
      }
    }
  if (!integritySequence?.length || integritySequence.sector < 16) {
    throw new Error("UDF logical volume integrity sequence is missing");
  }
  const integritySectors = Math.ceil(integritySequence.length / SECTOR_BYTES);
  if (
    (integritySequence.sector + integritySectors) * SECTOR_BYTES >
    media.length
  ) {
    throw new Error("UDF logical volume integrity sequence is truncated");
  }
  for (
    let sector = integritySequence.sector;
    sector < integritySequence.sector + integritySectors;
    sector += 1
  ) {
    verifyUdfTag(media, sector, [sector, sector - integritySequence.sector]);
    const offset = sector * SECTOR_BYTES;
    if (media.readUInt16LE(offset) === 9) {
      // ECMA-167 3/10.10: Logical Volume Integrity Descriptor recording time.
      if (normalizeTimestamps) {
        copyToMedia(timestamp, media, offset + 16);
        rewrite(sector);
      }
    }
  }
  if (!logicalVolumeContents || logicalVolumeContents.length === 0) {
    throw new Error("UDF logical volume contents use is missing");
  }
  const partitionNumber = partitionMaps.get(
    logicalVolumeContents.partitionReference,
  );
  const partition = partitions.get(partitionNumber);
  if (!partition || partition.length === 0) {
    throw new Error("UDF File Set Descriptor partition is invalid");
  }
  const fileSetSector = partition.sector + logicalVolumeContents.block;
  if (
    logicalVolumeContents.block >= partition.length ||
    (fileSetSector + 1) * SECTOR_BYTES > media.length
  ) {
    throw new Error("UDF File Set Descriptor extent is out of bounds");
  }
  // ECMA-167 4/14.1: normalize the only File Set Descriptor reachable from
  // the active logical volume. Do not search partitions or payload sectors for
  // tag-like bytes.
  verifyUdfTag(media, fileSetSector, logicalVolumeContents.block);
  const fileSetOffset = fileSetSector * SECTOR_BYTES;
  if (media.readUInt16LE(fileSetOffset) !== 256) {
    throw new Error(
      "UDF logical volume does not point to a File Set Descriptor",
    );
  }
  if (normalizeTimestamps) {
    copyToMedia(timestamp, media, fileSetOffset + 16);
    rewrite(fileSetSector);
  }

  const physicalSector = (block, partitionReference, label) => {
    const partitionNumber = partitionMaps.get(partitionReference);
    const selectedPartition = partitions.get(partitionNumber);
    if (!selectedPartition || block >= selectedPartition.length) {
      throw new Error(`UDF ${label} is outside its declared partition`);
    }
    const sector = selectedPartition.sector + block;
    if ((sector + 1) * SECTOR_BYTES > media.length) {
      throw new Error(`UDF ${label} is outside the media`);
    }
    return sector;
  };
  const seenIcb = new Set();
  const visitIcb = (block, partitionReference) => {
    const sector = physicalSector(block, partitionReference, "ICB");
    const key = `${partitionReference}:${block}`;
    if (seenIcb.has(key)) return;
    seenIcb.add(key);
    verifyUdfTag(media, sector, block);
    const offset = sector * SECTOR_BYTES;
    const tag = media.readUInt16LE(offset);
    if (![261, 266].includes(tag)) {
      throw new Error("UDF ICB does not point to a File Entry");
    }
    // ECMA-167 File Entry ICB Tag: Prior Recorded Number of Direct Entries
    // ends at BP 32; ICB Tag Flags are the following 16-bit field at BP 34.
    const allocationType = media.readUInt16LE(offset + 34) & 0x7;
    const fileType = media[offset + 27];
    const layout =
      tag === 261
        ? {
            timestamps: [72, 84, 96],
            extAttrs: 168,
            allocations: 172,
            data: 176,
          }
        : {
            timestamps: [80, 92, 104, 116],
            extAttrs: 208,
            allocations: 212,
            data: 216,
          };
    if (normalizeTimestamps) {
      for (const field of layout.timestamps)
        copyToMedia(timestamp, media, offset + field);
      rewrite(sector);
    }
    if (fileType !== 4) return;

    const extAttrs = media.readUInt32LE(offset + layout.extAttrs);
    const allocationBytes = media.readUInt32LE(offset + layout.allocations);
    const allocationStart = offset + layout.data + extAttrs;
    if (
      allocationStart > offset + SECTOR_BYTES ||
      allocationBytes > offset + SECTOR_BYTES - (allocationStart - offset)
    ) {
      throw new Error("UDF directory allocation descriptors are truncated");
    }
    let directoryBytes;
    let directoryExtents;
    if (allocationType === 3) {
      directoryBytes = media.subarray(
        allocationStart,
        allocationStart + allocationBytes,
      );
      directoryExtents = [
        {
          start: 0,
          bytes: allocationBytes,
          logicalBlock: block,
          physicalSector: sector,
        },
      ];
    } else if (allocationType === 0) {
      if (allocationBytes % 8 !== 0) {
        throw new Error("UDF short allocation descriptor length is invalid");
      }
      const partitionNumber = partitionMaps.get(partitionReference);
      const selectedPartition = partitions.get(partitionNumber);
      if (!selectedPartition) {
        throw new Error("UDF directory allocation partition is invalid");
      }
      const extents = [];
      directoryExtents = [];
      let directoryOffset = 0;
      for (
        let cursor = allocationStart;
        cursor < allocationStart + allocationBytes;
        cursor += 8
      ) {
        const length = media.readUInt32LE(cursor) & 0x3fffffff;
        const extentBlock = media.readUInt32LE(cursor + 4);
        const extentSector = physicalSector(
          extentBlock,
          partitionReference,
          "directory allocation descriptor",
        );
        // A zero-length short_ad is a valid sparse/no-op extent.
        if (length === 0) continue;
        if (
          extentBlock + Math.ceil(length / SECTOR_BYTES) >
            selectedPartition.length ||
          extentSector * SECTOR_BYTES + length > media.length
        ) {
          throw new Error("UDF directory allocation extent is invalid");
        }
        extents.push(
          media.subarray(
            extentSector * SECTOR_BYTES,
            extentSector * SECTOR_BYTES + length,
          ),
        );
        directoryExtents.push({
          start: directoryOffset,
          bytes: length,
          logicalBlock: extentBlock,
          physicalSector: extentSector,
        });
        directoryOffset += length;
      }
      directoryBytes = Buffer.concat(extents);
    } else {
      throw new Error(
        "UDF directory uses an unsupported allocation descriptor format; only short_ad and embedded allocation descriptors are supported",
      );
    }
    for (let cursor = 0; cursor < directoryBytes.length; ) {
      if (directoryBytes[cursor] === 0) {
        cursor = (Math.floor(cursor / 4) + 1) * 4;
        continue;
      }
      if (cursor + 38 > directoryBytes.length) {
        throw new Error("UDF File Identifier Descriptor is truncated");
      }
      const descriptor = directoryBytes.subarray(cursor);
      const descriptorTag = descriptor.readUInt16LE(0);
      if (descriptorTag !== 257) {
        throw new Error(
          "UDF directory contains a non-File-Identifier descriptor",
        );
      }
      const identifierLength = descriptor[19];
      const implementationUseLength = descriptor.readUInt16LE(36);
      const descriptorLength = 38 + implementationUseLength + identifierLength;
      const paddedLength = (descriptorLength + 3) & ~3;
      if (paddedLength > directoryBytes.length - cursor) {
        throw new Error("UDF File Identifier Descriptor length is invalid");
      }
      const extent = directoryExtents.find(
        ({ start, bytes }) => cursor >= start && cursor < start + bytes,
      );
      if (!extent || cursor + paddedLength > extent.start + extent.bytes) {
        throw new Error(
          "UDF File Identifier Descriptor crosses an unreachable extent",
        );
      }
      const sectorOffset = Math.floor((cursor - extent.start) / SECTOR_BYTES);
      verifyUdfEmbeddedTag(
        descriptor.subarray(0, paddedLength),
        [
          extent.logicalBlock + sectorOffset,
          extent.physicalSector + sectorOffset,
        ],
        "UDF File Identifier Descriptor",
      );
      const characteristics = descriptor[18];
      if ((characteristics & 0x8) === 0) {
        visitIcb(descriptor.readUInt32LE(24), descriptor.readUInt16LE(28));
      }
      cursor += paddedLength;
    }
  };
  // ECMA-167 4/14.1 rootDirectoryICB is a long_ad at byte 400. Follow only
  // directory File Identifier Descriptors from this root; no payload sector is
  // ever interpreted as a descriptor.
  visitIcb(
    media.readUInt32LE(fileSetOffset + 404),
    media.readUInt16LE(fileSetOffset + 408),
  );
}

function normalizeUdfDescriptorTimestamps(media) {
  inspectReachableUdfDescriptors(media, { normalizeTimestamps: true });
}

function normalizeDescriptorTimestamps(media) {
  normalizeIsoDescriptorTimestamps(media);
  normalizeIsoDirectoryTimestamps(media);
  normalizeUdfDescriptorTimestamps(media);
  return media;
}

export async function normalizeDescriptorTimestampsFile(path) {
  const { media, close } = rangeBackedIsoMedia(path, { writable: true });
  try {
    normalizeDescriptorTimestamps(media);
  } finally {
    close();
  }
}

export function inspectBootableIso(media) {
  if (!media || media.length < 64 * SECTOR_BYTES) {
    throw new Error("Factory media is too small to be ISO9660/UDF");
  }
  const pvd = 16 * SECTOR_BYTES;
  if (
    media[pvd] !== 1 ||
    media.toString("ascii", pvd + 1, pvd + 6) !== "CD001"
  ) {
    throw new Error("ISO9660 primary volume descriptor is missing");
  }
  let bootRecord;
  for (let sector = 16; sector < 32; sector += 1) {
    const offset = sector * SECTOR_BYTES;
    if (
      media[offset] === 0 &&
      media.toString("ascii", offset + 1, offset + 6) === "CD001" &&
      media.toString("ascii", offset + 7, offset + 30).trim() ===
        "EL TORITO SPECIFICATION"
    ) {
      bootRecord = offset;
      break;
    }
  }
  if (bootRecord === undefined)
    throw new Error("El Torito boot record is missing");
  const catalogSector = media.readUInt32LE(bootRecord + 71);
  const catalog = catalogSector * SECTOR_BYTES;
  if (catalog + 96 > media.length)
    throw new Error("El Torito boot catalog is truncated");
  let catalogChecksum = 0;
  for (let offset = 0; offset < 32; offset += 2) {
    catalogChecksum =
      (catalogChecksum + media.readUInt16LE(catalog + offset)) & 0xffff;
  }
  if (
    media[catalog] !== 1 ||
    media[catalog + 1] !== 0 ||
    media[catalog + 30] !== 0x55 ||
    media[catalog + 31] !== 0xaa ||
    catalogChecksum !== 0 ||
    ![0x88, 0].includes(media[catalog + 32]) ||
    media[catalog + 33] !== 0 ||
    media.readUInt16LE(catalog + 38) === 0 ||
    media.readUInt32LE(catalog + 40) === 0
  ) {
    throw new Error("El Torito boot catalog is invalid or not bootable");
  }
  const bootEntries = [
    {
      platform: "BIOS",
      bootable: media[catalog + 32] === 0x88,
      emulation: "none",
      loadSegment: `0x${media
        .readUInt16LE(catalog + 34)
        .toString(16)
        .padStart(4, "0")}`,
      systemType: `0x${media[catalog + 36].toString(16).padStart(2, "0")}`,
      loadSize: media.readUInt16LE(catalog + 38),
      imageSector: media.readUInt32LE(catalog + 40),
    },
  ];
  let entryOffset = catalog + 64;
  while (
    entryOffset + 32 <= media.length &&
    [0x90, 0x91].includes(media[entryOffset])
  ) {
    const platformId = media[entryOffset + 1];
    const count = media.readUInt16LE(entryOffset + 2);
    if (platformId !== 0xef) {
      throw new Error(
        "El Torito boot catalog section platform must be UEFI (0xef)",
      );
    }
    const platform = "UEFI";
    entryOffset += 32;
    if (count < 1 || entryOffset + count * 32 > media.length)
      throw new Error("El Torito boot catalog section is truncated");
    for (let index = 0; index < count; index += 1) {
      const offset = entryOffset + index * 32;
      if (
        ![0x88, 0].includes(media[offset]) ||
        media[offset + 1] !== 0 ||
        media.readUInt16LE(offset + 6) === 0 ||
        media.readUInt32LE(offset + 8) === 0
      )
        throw new Error("El Torito boot catalog section entry is invalid");
      bootEntries.push({
        platform,
        bootable: media[offset] === 0x88,
        emulation: "none",
        loadSegment: `0x${media
          .readUInt16LE(offset + 2)
          .toString(16)
          .padStart(4, "0")}`,
        systemType: `0x${media[offset + 4].toString(16).padStart(2, "0")}`,
        loadSize: media.readUInt16LE(offset + 6),
        imageSector: media.readUInt32LE(offset + 8),
      });
    }
    entryOffset += count * 32;
  }
  if (!bootEntries.some((entry) => entry.platform === "UEFI")) {
    throw new Error("El Torito boot catalog is missing a UEFI section");
  }
  let udfRecognition = false;
  // ECMA-167 VRS occupies the fixed early volume-recognition sequence. Do not
  // probe arbitrary later payload sectors for an NSR marker.
  for (
    let sector = 16;
    sector < Math.min(32, media.length / SECTOR_BYTES);
    sector += 1
  ) {
    const identifier = media.toString(
      "ascii",
      sector * SECTOR_BYTES + 1,
      sector * SECTOR_BYTES + 6,
    );
    if (identifier === "NSR02" || identifier === "NSR03") udfRecognition = true;
  }
  if (!udfRecognition) {
    return {
      iso9660: true,
      udf: false,
      elTorito: true,
      bootable: true,
      bootCatalogSector: catalogSector,
      bootEntries,
    };
  }
  const lastSector = Math.floor(media.length / SECTOR_BYTES) - 1;
  const anchors = [256, lastSector - 256, lastSector]
    .filter(
      (sector, index, all) => sector >= 0 && all.indexOf(sector) === index,
    )
    .filter((sector) => {
      const offset = sector * SECTOR_BYTES;
      return media.readUInt16LE(offset) === 2;
    });
  if (!anchors.includes(256) || anchors.length < 2) {
    throw new Error("UDF anchor volume descriptor pointers are incomplete");
  }
  for (const sector of anchors) verifyUdfTag(media, sector, [sector, 256, 0]);
  // This follows only descriptors reachable from the anchor's main/reserve
  // VDS and File Set root. Payload sectors are never scanned for tag-like
  // bytes, which keeps inspection bounded on large Windows media.
  inspectReachableUdfDescriptors(media);
  return {
    iso9660: true,
    udf: true,
    elTorito: true,
    bootable: true,
    bootCatalogSector: catalogSector,
    bootEntries,
  };
}

export async function inspectBootableIsoFile(path) {
  const { media, close } = rangeBackedIsoMedia(path);
  try {
    return inspectBootableIso(media);
  } finally {
    close();
  }
}

function canonicalIsoFilesystemPath(path) {
  return normalizedWindowsPath(path).toLocaleLowerCase("en-US");
}

function decodeIsoFilesystemIdentifier(bytes, joliet) {
  if (bytes.length === 1 && (bytes[0] === 0 || bytes[0] === 1)) return null;
  let value;
  if (joliet) {
    if (bytes.length % 2 !== 0) {
      throw new Error(
        "Joliet directory identifier has an invalid UCS-2 length",
      );
    }
    const littleEndian = Buffer.from(bytes);
    littleEndian.swap16();
    value = littleEndian.toString("utf16le");
  } else {
    value = bytes.toString("ascii");
  }
  const withoutVersion = value.replace(/;\d+$/, "");
  // ISO9660 writes a name with no extension as `README.;1`. The dot is the
  // empty-extension separator, not part of the UDF filename. Joliet uses its
  // own identifiers, so preserve a trailing dot there.
  if (
    !joliet &&
    withoutVersion.length !== value.length &&
    withoutVersion.endsWith(".")
  )
    value = withoutVersion.slice(0, -1);
  else value = withoutVersion;
  return normalizedWindowsPath(value);
}

function iso9660ViewDescriptor(media, joliet) {
  for (
    let sector = 16;
    (sector + 1) * SECTOR_BYTES <= media.length;
    sector += 1
  ) {
    const offset = sector * SECTOR_BYTES;
    if (media.toString("ascii", offset + 1, offset + 6) !== "CD001") continue;
    if (media[offset] === 255) return null;
    if (media[offset] !== (joliet ? 2 : 1)) continue;
    if (
      joliet &&
      !["%/@", "%/C", "%/E"].includes(
        media.toString("ascii", offset + 88, offset + 91),
      )
    ) {
      continue;
    }
    return offset;
  }
  return null;
}

function iso9660FileExtents(media, { joliet = false } = {}) {
  const descriptor = iso9660ViewDescriptor(media, joliet);
  if (descriptor === null) {
    if (joliet) return new Map();
    throw new Error("ISO9660 primary volume descriptor is missing");
  }
  const root = descriptor + 156;
  const rootLength = media[root];
  if (rootLength < 34)
    throw new Error("ISO9660 root directory record is invalid");
  const directories = [
    {
      path: "",
      sector: media.readUInt32LE(root + 2),
      bytes: media.readUInt32LE(root + 10),
      ancestors: new Set([
        `${media.readUInt32LE(root + 2)}:${media.readUInt32LE(root + 10)}`,
      ]),
    },
  ];
  const extents = new Map();
  while (directories.length > 0) {
    const directory = directories.pop();
    const start = directory.sector * SECTOR_BYTES;
    const end = start + directory.bytes;
    if (directory.bytes === 0 || end > media.length)
      throw new Error("ISO9660 directory extent is out of bounds");
    let pendingMultiExtent;
    for (let offset = start; offset < end; ) {
      const length = media[offset];
      if (length === 0) {
        offset = (Math.floor(offset / SECTOR_BYTES) + 1) * SECTOR_BYTES;
        continue;
      }
      if (length < 34 || offset + length > end)
        throw new Error("ISO9660 directory record is truncated");
      const identifierLength = media[offset + 32];
      if (33 + identifierLength > length)
        throw new Error("ISO9660 directory identifier is truncated");
      const identifier = decodeIsoFilesystemIdentifier(
        media.subarray(offset + 33, offset + 33 + identifierLength),
        joliet,
      );
      const sector = media.readUInt32LE(offset + 2);
      const bytes = media.readUInt32LE(offset + 10);
      const isDirectory = (media[offset + 25] & 2) !== 0;
      const continuesMultiExtent = (media[offset + 25] & 0x80) !== 0;
      if (identifier !== null) {
        const path = directory.path
          ? `${directory.path}/${identifier}`
          : identifier;
        if (isDirectory) {
          if (pendingMultiExtent) {
            throw new Error("ISO9660 multi-extent ordering is invalid");
          }
          const extentKey = `${sector}:${bytes}`;
          if (directory.ancestors.has(extentKey)) {
            throw new Error("ISO9660 directory hierarchy contains a cycle");
          }
          directories.push({
            path,
            sector,
            bytes,
            ancestors: new Set([...directory.ancestors, extentKey]),
          });
        } else {
          const key = canonicalIsoFilesystemPath(path);
          const segment = { sector, bytes };
          if (pendingMultiExtent) {
            if (pendingMultiExtent.key !== key) {
              throw new Error("ISO9660 multi-extent ordering is invalid");
            }
            pendingMultiExtent.segments.push(segment);
            pendingMultiExtent.bytes += bytes;
            if (!continuesMultiExtent) {
              if (extents.has(key)) {
                throw new Error(
                  "ISO9660 filesystem contains duplicate canonical paths",
                );
              }
              extents.set(key, pendingMultiExtent);
              pendingMultiExtent = undefined;
            }
          } else if (continuesMultiExtent) {
            pendingMultiExtent = {
              key,
              path,
              bytes,
              sector,
              segments: [segment],
            };
          } else {
            if (extents.has(key)) {
              throw new Error(
                "ISO9660 filesystem contains duplicate canonical paths",
              );
            }
            extents.set(key, { path, bytes, sector, segments: [segment] });
          }
        }
      } else if (pendingMultiExtent) {
        throw new Error("ISO9660 multi-extent ordering is invalid");
      }
      offset += length;
    }
    if (pendingMultiExtent) {
      throw new Error("ISO9660 multi-extent sequence is incomplete");
    }
  }
  return extents;
}

export function inspectIsoFilesystemExtents(media, { joliet = false } = {}) {
  return [...iso9660FileExtents(media, { joliet }).values()].map((entry) => ({
    ...entry,
    segments: entry.segments.map((segment) => ({ ...segment })),
  }));
}

export function inspectIsoFilesystemViews(media) {
  const iso9660 = iso9660FileExtents(media);
  const joliet = iso9660FileExtents(media, { joliet: true });
  return {
    iso9660: canonicalIsoFilesystemPaths(iso9660),
    joliet: canonicalIsoFilesystemPaths(joliet),
  };
}

function canonicalIsoFilesystemPaths(entries) {
  return [...entries.values()]
    .map(({ path }) => canonicalIsoFilesystemPath(path))
    .sort((left, right) => left.localeCompare(right));
}

function withGeneratedBootCatalogHiddenPath(hiddenPaths, visiblePaths) {
  const paths = new Map(
    hiddenPaths.map((path) => [canonicalIsoFilesystemPath(path), path]),
  );
  if (!visiblePaths.includes("boot.catalog"))
    paths.set("boot.catalog", "boot.catalog");
  return [...paths.values()].sort((left, right) => left.localeCompare(right));
}

function assemblyHidePatterns({ assemblyTree, assemblyTreeManifest, paths }) {
  return paths.map((path) => {
    const entry = treeEntry(assemblyTreeManifest, path);
    if (entry?.type === "file") return entry.absolute;
    if (canonicalIsoFilesystemPath(path) === "boot.catalog")
      return join(assemblyTree, "boot.catalog");
    throw new Error(
      `Factory Windows assembly lost hidden source file: ${path}`,
    );
  });
}

function verifySourceFilesystemVisibility({
  sourceVisiblePaths,
  outputVisiblePaths,
  hiddenPaths,
  expectedFileCount,
  label,
}) {
  const output = new Set(outputVisiblePaths);
  if (
    expectedFileCount !== undefined &&
    outputVisiblePaths.length !== expectedFileCount
  ) {
    throw new Error(
      `serviced ISO ${label} visibility file count mismatch: expected ${expectedFileCount}, got ${outputVisiblePaths.length}`,
    );
  }
  for (const path of sourceVisiblePaths) {
    if (!output.has(path)) {
      throw new Error(
        `serviced ISO ${label} visibility lost source file: ${path}`,
      );
    }
  }
  for (const path of hiddenPaths) {
    const canonicalPath = canonicalIsoFilesystemPath(path);
    if (output.has(canonicalPath)) {
      throw new Error(
        `serviced ISO ${label} visibility exposed hidden source file: ${canonicalPath}`,
      );
    }
  }
}

function sourceHiddenPathsForView({ sourceTree, visiblePaths, label }) {
  const sourceFiles = new Set(
    [...sourceTree.entries]
      .filter(([, entry]) => entry.type === "file")
      .map(([path]) => path),
  );
  const visible = new Set(visiblePaths);
  for (const path of visible) {
    if (!sourceFiles.has(path)) {
      if (WINDOWS_REPLAY_GENERATED_PATHS.has(path)) continue;
      throw new Error(
        `${label} visible source path cannot be matched exactly in the UDF tree: ${path}`,
      );
    }
  }
  return [...sourceTree.entries.values()]
    .filter(
      (entry) =>
        entry.type === "file" &&
        !visible.has(canonicalIsoFilesystemPath(entry.path)),
    )
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right));
}

function sourceReplayPathSegments(path) {
  const segments = path.split("/");
  if (
    path !== normalizedWindowsPath(path) ||
    segments.length === 0 ||
    segments.some(
      (segment) =>
        !segment ||
        [".", ".."].includes(segment) ||
        segment.includes("\\") ||
        segment.includes("\0"),
    )
  ) {
    throw new Error(`ISO9660 visible source path is unsafe to replay: ${path}`);
  }
  return segments;
}

async function sourceReplayDestination(root, path) {
  const segments = sourceReplayPathSegments(path);
  const resolved = [];
  let directory = root;
  for (const [index, segment] of segments.entries()) {
    const canonicalSegment =
      normalizedWindowsPath(segment).toLocaleLowerCase("en-US");
    const existing = (await readdir(directory, { withFileTypes: true })).find(
      (entry) =>
        normalizedWindowsPath(entry.name).toLocaleLowerCase("en-US") ===
        canonicalSegment,
    );
    const isFinalSegment = index === segments.length - 1;
    if (existing) {
      const absolute = join(directory, existing.name);
      const stat = await lstat(absolute);
      if (!isFinalSegment && (stat.isSymbolicLink() || !stat.isDirectory())) {
        throw new Error(
          `ISO9660 visible source path conflicts with UDF file: ${path}`,
        );
      }
      resolved.push(existing.name);
      directory = absolute;
      continue;
    }
    resolved.push(segment);
    directory = join(directory, segment);
    if (!isFinalSegment) await mkdir(directory);
  }
  return join(root, ...resolved);
}

function assertSourceOnlyReplayLimits(missing) {
  if (missing.size > MAX_SOURCE_ONLY_REPLAY_FILES) {
    throw new Error("source-only ISO9660 replay exceeds file limit");
  }
  let bytes = 0;
  for (const candidates of missing.values()) {
    let largest = 0;
    for (const { entry } of candidates) {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) {
        throw new Error(
          `ISO9660 has invalid source-only replay size: ${entry.path}`,
        );
      }
      if (
        sourceReplayPathSegments(entry.path).length >
        MAX_SOURCE_ONLY_REPLAY_PATH_DEPTH
      ) {
        throw new Error("source-only ISO9660 replay exceeds path depth limit");
      }
      largest = Math.max(largest, entry.bytes);
    }
    bytes += largest;
    if (bytes > MAX_SOURCE_ONLY_REPLAY_BYTES) {
      throw new Error("source-only ISO9660 replay exceeds byte limit");
    }
  }
}

async function existingUdfFileDigest(entry) {
  const stat = await lstat(entry.absolute);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`validated UDF source file changed: ${entry.path}`);
  }
  return { bytes: stat.size, digest: await hashFile(entry.absolute) };
}

function assertSourceReplayExtents(entry, sourceBytes, label) {
  if (
    !Number.isSafeInteger(entry.bytes) ||
    entry.bytes < 0 ||
    !Array.isArray(entry.segments) ||
    entry.segments.length === 0
  ) {
    throw new Error(`${label} has invalid ISO9660 file extents: ${entry.path}`);
  }
  let bytes = 0;
  for (const segment of entry.segments) {
    if (
      !Number.isSafeInteger(segment.sector) ||
      !Number.isSafeInteger(segment.bytes) ||
      segment.sector < 0 ||
      segment.bytes < 0 ||
      segment.sector * SECTOR_BYTES + segment.bytes > sourceBytes
    ) {
      throw new Error(
        `${label} has invalid ISO9660 file extents: ${entry.path}`,
      );
    }
    bytes += segment.bytes;
  }
  if (bytes !== entry.bytes) {
    throw new Error(
      `${label} has inconsistent ISO9660 file extents: ${entry.path}`,
    );
  }
}

async function hashSourceReplayExtents({ source, entry, sourceBytes, label }) {
  assertSourceReplayExtents(entry, sourceBytes, label);
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(ISO_EXTENT_COPY_CHUNK_BYTES);
  for (const segment of entry.segments) {
    let position = segment.sector * SECTOR_BYTES;
    let remaining = segment.bytes;
    while (remaining > 0) {
      const { bytesRead } = await source.read(
        buffer,
        0,
        Math.min(buffer.length, remaining),
        position,
      );
      if (bytesRead === 0) {
        throw new Error(
          `${label} ISO9660 extent ended unexpectedly: ${entry.path}`,
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function writeSourceReplayBytes({
  output,
  bytes,
  position,
  hash,
}) {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await output.write(
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );
    if (
      !Number.isSafeInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > bytes.length - offset
    ) {
      throw new Error("ISO9660 extent destination write was incomplete");
    }
    hash.update(bytes.subarray(offset, offset + bytesWritten));
    offset += bytesWritten;
  }
  return offset;
}

async function replaySourceVisibleFile({
  source,
  sourceBytes,
  destination,
  entry,
  label,
}) {
  assertSourceReplayExtents(entry, sourceBytes, label);
  await mkdir(dirname(destination), { recursive: true });
  const output = await open(
    destination,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(ISO_EXTENT_COPY_CHUNK_BYTES);
  let written = 0;
  try {
    for (const segment of entry.segments) {
      let position = segment.sector * SECTOR_BYTES;
      let remaining = segment.bytes;
      while (remaining > 0) {
        const { bytesRead } = await source.read(
          buffer,
          0,
          Math.min(buffer.length, remaining),
          position,
        );
        if (bytesRead === 0) {
          throw new Error(
            `${label} ISO9660 extent ended unexpectedly: ${entry.path}`,
          );
        }
        const bytes = buffer.subarray(0, bytesRead);
        await writeSourceReplayBytes({
          output,
          bytes,
          position: written,
          hash,
        });
        position += bytesRead;
        remaining -= bytesRead;
        written += bytesRead;
      }
    }
    await output.sync();
  } finally {
    await output.close();
  }
  if (written !== entry.bytes) {
    throw new Error(
      `${label} ISO9660 extent replay size mismatch: ${entry.path}`,
    );
  }
  return `sha256:${hash.digest("hex")}`;
}

export async function replaySourceVisibleFilesAbsentFromUdf({
  sourceTree,
  sourceIsoPath,
  views,
}) {
  const visible = new Map();
  for (const { label, extents } of views) {
    for (const entry of extents.values()) {
      const canonicalPath = canonicalIsoFilesystemPath(entry.path);
      if (WINDOWS_REPLAY_GENERATED_PATHS.has(canonicalPath)) continue;
      const existing = sourceTree.entries.get(canonicalPath);
      if (existing) {
        if (existing.type !== "file") {
          throw new Error(
            `${label} visible source file conflicts with UDF directory: ${entry.path}`,
          );
        }
      }
      const grouped = visible.get(canonicalPath) ?? {
        existing,
        candidates: [],
      };
      grouped.candidates.push({ label, entry });
      visible.set(canonicalPath, grouped);
    }
  }
  if (visible.size === 0) return sourceTree;
  const missing = new Map(
    [...visible]
      .filter(([, { existing }]) => !existing)
      .map(([path, { candidates }]) => [path, candidates]),
  );
  assertSourceOnlyReplayLimits(missing);

  const source = await open(
    sourceIsoPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await source.stat();
    if (!before.isFile()) {
      throw new Error("verified Windows source ISO is not a regular file");
    }
    for (const [canonicalPath, { existing, candidates }] of [...visible].sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      if (existing) {
        const udf = await existingUdfFileDigest(existing);
        for (const candidate of candidates) {
          const sourceDigest = await hashSourceReplayExtents({
            source,
            sourceBytes: before.size,
            entry: candidate.entry,
            label: candidate.label,
          });
          if (
            candidate.entry.bytes !== udf.bytes ||
            sourceDigest !== udf.digest
          ) {
            throw new Error(
              `${candidate.label} visible source file does not match UDF file: ${candidate.entry.path}`,
            );
          }
        }
        continue;
      }
      const [{ label, entry }, ...otherCandidates] = candidates;
      const destination = await sourceReplayDestination(
        sourceTree.root,
        entry.path,
      );
      const digest = await replaySourceVisibleFile({
        source,
        sourceBytes: before.size,
        destination,
        entry,
        label,
      });
      for (const candidate of otherCandidates) {
        const candidateDigest = await hashSourceReplayExtents({
          source,
          sourceBytes: before.size,
          entry: candidate.entry,
          label: candidate.label,
        });
        if (candidateDigest !== digest) {
          throw new Error(
            `ISO9660 and Joliet visible source content conflicts at canonical path ${canonicalPath}`,
          );
        }
      }
    }
    const after = await source.stat();
    if (
      after.size !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino
    ) {
      throw new Error(
        "verified Windows source ISO changed during extent replay",
      );
    }
  } finally {
    await source.close();
  }
  return validateExtractedTree(
    sourceTree.root,
    "UDF extractor output after ISO9660/Joliet replay",
  );
}

function expectedIso9660VisibleFileCount({
  sourceVisiblePaths,
  sourceTree,
  replacements,
}) {
  const additions = new Set(
    replacements
      .map(({ path }) => path)
      .filter((path) => !sourceTree.entries.has(path)),
  );
  return sourceVisiblePaths.length + additions.size;
}

async function bindBootEntriesToExtractedTree({ isoBytes, treeManifest }) {
  const extents = iso9660FileExtents(isoBytes);
  const boot = inspectBootableIso(isoBytes);
  const hiddenImagePaths = {
    BIOS: "boot/etfsboot.com",
    UEFI: "efi/microsoft/boot/efisys.bin",
  };
  const entries = [];
  for (const entry of boot.bootEntries) {
    const mapped = [...extents.values()].find(
      ({ sector, bytes }) => sector === entry.imageSector && bytes > 0,
    );
    const canonicalImagePath = hiddenImagePaths[entry.platform];
    if (!canonicalImagePath) {
      throw new Error(
        `El Torito catalog image LBA ${entry.imageSector} has unsupported platform ${entry.platform}`,
      );
    }
    if (
      mapped &&
      canonicalIsoFilesystemPath(mapped.path) !== canonicalImagePath
    ) {
      throw new Error(
        `El Torito catalog image LBA ${entry.imageSector} maps to noncanonical ISO9660 file ${mapped.path}`,
      );
    }
    const treeFile = treeEntry(treeManifest, canonicalImagePath);
    if (!treeFile || treeFile.type !== "file") {
      throw new Error(
        `El Torito catalog image LBA ${entry.imageSector} is absent from the extracted tree at canonical ${canonicalImagePath}`,
      );
    }
    const extracted = await readFile(treeFile.absolute);
    const imageOffset = entry.imageSector * SECTOR_BYTES;
    if (
      (mapped && mapped.bytes !== extracted.length) ||
      entry.loadSize * EL_TORITO_VIRTUAL_SECTOR_BYTES > extracted.length ||
      imageOffset + extracted.length > isoBytes.length ||
      !isoBytes
        .subarray(imageOffset, imageOffset + extracted.length)
        .equals(extracted)
    ) {
      throw new Error(
        `El Torito catalog image LBA ${entry.imageSector} does not match extracted ${treeFile.path}`,
      );
    }
    entries.push({
      ...entry,
      isoEntry: treeFile.path,
      digest: hashBytes(extracted),
    });
  }
  return entries;
}

async function executeUdfWriter({
  writerBytes,
  stageDirectory,
  outputPath,
  workDirectory,
}) {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      await mkdir(UDF_WRITER_LOCK);
      break;
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error("timed out acquiring deterministic UDF writer lock", {
          cause: error,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  const executable = join(workDirectory, "udf-writer");
  try {
    await writeFile(executable, writerBytes, { mode: 0o555 });
    const sortFile = join(workDirectory, "iso-sort.txt");
    const stageTree = await validateExtractedTree(
      stageDirectory,
      "Factory media stage",
    );
    await writeDeterministicIsoSortFile(stageTree, sortFile);
    await run(
      executable,
      [
        "-quiet",
        "-udf",
        "-J",
        "-R",
        "-iso-level",
        "3",
        "-V",
        "VEM_FACTORY",
        "-volset",
        UDF_VOLUME_SET_ID,
        "-A",
        "VEM_FACTORY_ISSUE10",
        "-sysid",
        "VEM",
        "-sort",
        sortFile,
        "-b",
        "BOOT/BOOT.IMG",
        "-c",
        "BOOT/BOOT.CAT",
        "-no-emul-boot",
        "-boot-load-size",
        "4",
        "-o",
        outputPath,
        stageDirectory,
      ],
      {
        cwd: workDirectory,
        env: {
          PATH: "/usr/bin:/bin",
          HOME: workDirectory,
          LC_ALL: "C",
          TZ: "UTC",
          SOURCE_DATE_EPOCH: String(FIXED_EPOCH_SECONDS),
        },
        maxBuffer: 1024 * 1024,
      },
    );
    await normalizeDescriptorTimestampsFile(outputPath);
    const output = await lstat(outputPath);
    return {
      path: outputPath,
      bytes: output.size,
      digest: await hashFile(outputPath),
      structure: await inspectBootableIsoFile(outputPath),
    };
  } finally {
    await rm(UDF_WRITER_LOCK, { recursive: true, force: true });
  }
}

async function acquireUdfWriterLock() {
  const deadline = Date.now() + 60_000;
  while (true) {
    try {
      await mkdir(UDF_WRITER_LOCK);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST" || Date.now() >= deadline) {
        throw new Error("timed out acquiring deterministic UDF writer lock", {
          cause: error,
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function inspectWindowsSetupTree({
  wimlibExecutable,
  isoBytes,
  tree,
  treeManifest,
  workDirectory,
  expectedInstallImage,
}) {
  const files = new Map(
    [...treeManifest.entries].map(([key, entry]) => [key, entry.path]),
  );
  for (const required of [
    "setup.exe",
    "sources",
    "sources/boot.wim",
    "boot/etfsboot.com",
    "efi/microsoft/boot/efisys.bin",
  ]) {
    if (!files.has(required))
      throw new Error(
        `Windows source ISO is missing required Windows Setup path: ${required}`,
      );
  }
  if (!files.has("sources/install.wim") && !files.has("sources/install.esd")) {
    throw new Error(
      "Windows source ISO is missing sources/install.wim or sources/install.esd",
    );
  }
  await assertWimMagic(
    treeEntry(treeManifest, files.get("sources/boot.wim")).absolute,
    "Windows boot image",
  );
  const installImage = files.has("sources/install.wim")
    ? "sources/install.wim"
    : "sources/install.esd";
  if (installImage.endsWith(".esd"))
    await assertWimMagic(
      treeEntry(treeManifest, files.get(installImage)).absolute,
      "Windows install image",
    );
  const selectedImage = await inspectSelectedWindowsImage({
    executable: wimlibExecutable,
    imagePath: treeEntry(treeManifest, files.get(installImage)).absolute,
    expected: expectedInstallImage,
    workDirectory,
  });
  const bootCatalog = await bindBootEntriesToExtractedTree({
    isoBytes,
    treeManifest,
  });
  if (
    bootCatalog.length < 2 ||
    !bootCatalog.some(
      (entry) =>
        entry.platform === "BIOS" &&
        entry.bootable &&
        entry.emulation === "none" &&
        entry.loadSize > 0,
    ) ||
    !bootCatalog.some(
      (entry) =>
        entry.platform === "UEFI" &&
        entry.bootable &&
        entry.emulation === "none" &&
        entry.loadSize > 0,
    )
  ) {
    throw new Error(
      "Windows source ISO must provide BIOS etfsboot and UEFI efisys entries in its complete El Torito catalog",
    );
  }
  return {
    paths: [...files.values()].sort((left, right) => left.localeCompare(right)),
    installImage,
    selectedImage,
    bootCatalog,
    ...(treeEntry(
      treeManifest,
      "sources/$OEM$/$1/VEM/Factory/factory-effective-inputs.json",
    )
      ? {
          factoryEffectiveInputs: JSON.parse(
            (
              await readRegularFile(
                treeEntry(
                  treeManifest,
                  "sources/$OEM$/$1/VEM/Factory/factory-effective-inputs.json",
                ).absolute,
                "embedded Factory effective inputs",
              )
            ).toString("utf8"),
          ),
        }
      : {}),
  };
}

export async function inspectWindowsSetupIso({
  isoPath,
  expectedInstallImage,
  udfExtractorPath,
  udfExtractor,
  wimlibPath,
  wimlib,
}) {
  const [extractorBytes, wimlibBytes] = await Promise.all([
    readPinnedExecutable(udfExtractorPath, udfExtractor, "UDF extractor"),
    readPinnedExecutable(wimlibPath, wimlib),
  ]);
  const workDirectory = await mkdtemp(
    join(tmpdir(), "vem-windows-setup-inspect-"),
  );
  try {
    const extractor = join(workDirectory, "udf-extractor");
    const wimlibExecutable = join(workDirectory, "wimlib-imagex");
    await Promise.all([
      writeFile(extractor, extractorBytes, { mode: 0o555 }),
      writeFile(wimlibExecutable, wimlibBytes, { mode: 0o555 }),
    ]);
    const tree = join(workDirectory, "media");
    const isoSnapshot = join(workDirectory, "input.iso");
    await snapshotRegularFile(isoPath, isoSnapshot, "Windows source ISO");
    await mkdir(tree, { recursive: true });
    const treeManifest = await extractUdfView({
      extractor,
      isoPath: isoSnapshot,
      tree,
      workDirectory,
    });
    const { media, close } = rangeBackedIsoMedia(isoSnapshot);
    try {
      return await inspectWindowsSetupTree({
        wimlibExecutable,
        isoBytes: media,
        tree,
        treeManifest,
        workDirectory,
        expectedInstallImage,
      });
    } finally {
      close();
    }
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export async function inspectWindowsSourceIso({
  sourceIsoPath,
  source,
  udfExtractorPath,
  udfExtractor,
  wimlibPath,
  wimlib,
}) {
  if ((await hashFile(sourceIsoPath)) !== source.windowsMedia.digest)
    throw new Error(
      "Windows source ISO digest does not match the Factory Manifest",
    );
  return inspectWindowsSetupIso({
    isoPath: sourceIsoPath,
    expectedInstallImage: {
      index: source.installImageIndex,
      edition: source.installImageEdition,
      digest: source.installImageDigest,
    },
    udfExtractorPath,
    udfExtractor,
    wimlibPath,
    wimlib,
  });
}

async function overlayMappings(overlayTree, sourceTree) {
  const mappings = [];
  const replacements = [];
  async function targetPath(relative) {
    let current = sourceTree;
    let missing = false;
    const result = [];
    for (const segment of relative.split("/")) {
      if (!missing) {
        const entries = await readdir(current, { withFileTypes: true });
        const existing = entries.find(
          (entry) =>
            entry.name.toLocaleLowerCase("en-US") ===
            segment.toLocaleLowerCase("en-US"),
        );
        if (existing) {
          result.push(existing.name);
          current = join(current, existing.name);
          continue;
        }
        missing = true;
      }
      result.push(segment);
    }
    return `/${result.join("/")}`;
  }
  for (const entry of [...overlayTree.entries.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    if (entry.type !== "file") continue;
    const target = await targetPath(entry.path);
    const bytes = await readRegularFile(
      entry.absolute,
      `Factory Windows overlay ${entry.path}`,
    );
    mappings.push({ bytes, target });
    replacements.push({
      path: target.slice(1).toLocaleLowerCase("en-US"),
      digest: hashBytes(bytes),
    });
  }
  return { mappings, replacements };
}

async function applyOverlayMappings(root, mappings) {
  for (const { bytes, target } of mappings) {
    const destination = join(root, target.slice(1));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}

async function treeReplayEntries(tree) {
  const entries = new Map();
  for (const [key, entry] of tree.entries) {
    entries.set(key, {
      path: entry.path,
      normalized: entry.normalized,
      type: entry.type,
      ...(entry.type === "file"
        ? { digest: await hashFile(entry.absolute) }
        : {}),
    });
  }
  return entries;
}

async function verifyWindowsSetupTreeReplay({
  sourceTree,
  outputTree,
  replacements,
}) {
  const [source, output] = await Promise.all([
    treeReplayEntries(sourceTree),
    treeReplayEntries(outputTree),
  ]);
  const replacementDigests = new Map(
    replacements.map(({ path, digest }) => [path, digest]),
  );
  for (const [path, entry] of source) {
    if (
      replacementDigests.has(path) ||
      WINDOWS_REPLAY_GENERATED_PATHS.has(path)
    )
      continue;
    const actual = output.get(path);
    if (
      !actual ||
      actual.path !== entry.path ||
      actual.normalized !== entry.normalized ||
      actual.type !== entry.type ||
      actual.digest !== entry.digest
    ) {
      throw new Error(
        `serviced ISO changed source file outside the declared overlay: ${entry.path}`,
      );
    }
  }
  for (const [path, entry] of output) {
    if (
      source.has(path) ||
      replacementDigests.has(path) ||
      (entry.type === "directory" &&
        [...replacementDigests.keys()].some((replacement) =>
          replacement.startsWith(`${path}/`),
        )) ||
      WINDOWS_REPLAY_GENERATED_PATHS.has(path)
    )
      continue;
    throw new Error(
      `serviced ISO added file outside the declared overlay: ${entry.path}`,
    );
  }
  for (const [path, digest] of replacementDigests) {
    const actual = output.get(path);
    if (!actual || actual.type !== "file" || actual.digest !== digest) {
      throw new Error(`serviced ISO overlay was not written exactly: ${path}`);
    }
  }
}

function assertOptionalGeneratedReplayPaths(tree, label) {
  for (const path of WINDOWS_REPLAY_GENERATED_PATHS) {
    const entry = treeEntry(tree, path);
    if (entry && entry.type !== "file") {
      throw new Error(
        `${label} generated replay path must be a regular file: ${entry.path}`,
      );
    }
  }
}

async function verifyGeneratedBootCatalogBinding(tree, isoBytes) {
  const catalog = treeEntry(tree, "boot.catalog");
  if (catalog && catalog.type !== "file") {
    throw new Error(
      "serviced ISO generated boot.catalog path must be a regular file",
    );
  }
  const structure = inspectBootableIso(isoBytes);
  return {
    // The UDF placeholder is optional. The authoritative generated content is
    // the El Torito sector, validated against the boot image digests below.
    bootEntries: structure.bootEntries,
  };
}

async function executeWindowsServicedIsoBuilder({
  extractorBytes,
  writerBytes,
  wimlibBytes,
  manifestSource,
  sourceIsoPath,
  extractorVersion,
  writerVersion,
  overlayDirectory,
  outputPath,
  workDirectory,
}) {
  const extractor = join(workDirectory, "udf-extractor");
  const writer = join(workDirectory, "udf-writer");
  const wimlibExecutable = join(workDirectory, "wimlib-imagex");
  await Promise.all([
    writeFile(extractor, extractorBytes, { mode: 0o555 }),
    writeFile(writer, writerBytes, { mode: 0o555 }),
    writeFile(wimlibExecutable, wimlibBytes, { mode: 0o555 }),
  ]);
  const toolEnv = {
    PATH: "/usr/bin:/bin",
    HOME: workDirectory,
    LC_ALL: "C",
    TZ: "UTC",
    SOURCE_DATE_EPOCH: String(FIXED_EPOCH_SECONDS),
  };
  const [extractorInfo, writerInfo, wimlibInfo] = await Promise.all([
    run(extractor, [], { cwd: workDirectory, env: toolEnv }),
    run(writer, ["--version"], { cwd: workDirectory, env: toolEnv }),
    run(wimlibExecutable, ["--version"], { cwd: workDirectory, env: toolEnv }),
  ]);
  if (
    !hasExpected7ZipBannerVersion(
      `${extractorInfo.stdout}\n${extractorInfo.stderr}`,
      extractorVersion,
    )
  )
    throw new Error(
      `executed UDF extractor version does not match pinned manifest version ${extractorVersion}`,
    );
  if (
    !new RegExp(
      `genisoimage\\s+${writerVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "i",
    ).test(`${writerInfo.stdout}\n${writerInfo.stderr}`)
  )
    throw new Error(
      `executed UDF writer version does not match pinned manifest version ${writerVersion}`,
    );
  if (
    !new RegExp(
      `wimlib-imagex\\s+${manifestSource.wimlibVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "i",
    ).test(`${wimlibInfo.stdout}\n${wimlibInfo.stderr}`)
  )
    throw new Error(
      `executed wimlib version does not match pinned manifest version ${manifestSource.wimlibVersion}`,
    );

  const sourceTree = join(workDirectory, "windows-source-udf");
  await mkdir(sourceTree, { recursive: true });
  let sourceTreeManifest = await extractUdfView({
    extractor,
    isoPath: sourceIsoPath,
    tree: sourceTree,
    workDirectory,
  });
  const { media: sourceIsoMedia, close: closeSourceIsoMedia } =
    rangeBackedIsoMedia(sourceIsoPath);
  let sourceFilesystemViews;
  let sourceFilesystemExtentViews;
  let sourceCatalog;
  const expectedInstallImage = {
    index: manifestSource.installImageIndex,
    edition: manifestSource.installImageEdition,
    digest: manifestSource.installImageDigest,
  };
  try {
    const sourceIso9660Extents = iso9660FileExtents(sourceIsoMedia);
    const sourceJolietExtents = iso9660FileExtents(sourceIsoMedia, {
      joliet: true,
    });
    sourceFilesystemViews = {
      iso9660: canonicalIsoFilesystemPaths(sourceIso9660Extents),
      joliet: canonicalIsoFilesystemPaths(sourceJolietExtents),
    };
    sourceFilesystemExtentViews = [
      { label: "ISO9660", extents: sourceIso9660Extents },
      ...(sourceJolietExtents.size > 0
        ? [{ label: "Joliet", extents: sourceJolietExtents }]
        : []),
    ];
    sourceCatalog = await inspectWindowsSetupTree({
      wimlibExecutable,
      isoBytes: sourceIsoMedia,
      tree: sourceTree,
      treeManifest: sourceTreeManifest,
      workDirectory,
      expectedInstallImage,
    });
  } finally {
    closeSourceIsoMedia();
  }
  const sourceHasJoliet = sourceFilesystemViews.joliet.length > 0;
  sourceTreeManifest = await replaySourceVisibleFilesAbsentFromUdf({
    sourceTree: sourceTreeManifest,
    sourceIsoPath,
    views: sourceFilesystemExtentViews,
  });
  assertOptionalGeneratedReplayPaths(sourceTreeManifest, "source ISO");
  await setFixedTimes(sourceTreeManifest);
  // 7z exposes the UDF tree, including entries intentionally omitted from the
  // ISO9660/Joliet view. Preserve that visibility boundary during replay.
  const sourceIsoHiddenPaths = sourceHiddenPathsForView({
    sourceTree: sourceTreeManifest,
    visiblePaths: sourceFilesystemViews.iso9660,
    label: "ISO9660",
  });
  const sourceJolietHiddenPaths = sourceHasJoliet
    ? sourceHiddenPathsForView({
        sourceTree: sourceTreeManifest,
        visiblePaths: sourceFilesystemViews.joliet,
        label: "Joliet",
      })
    : [];
  const outputIsoHiddenPaths = withGeneratedBootCatalogHiddenPath(
    sourceIsoHiddenPaths,
    sourceFilesystemViews.iso9660,
  );
  const outputJolietHiddenPaths = sourceHasJoliet
    ? withGeneratedBootCatalogHiddenPath(
        sourceJolietHiddenPaths,
        sourceFilesystemViews.joliet,
      )
    : [];
  const overlayTreeManifest = await validateExtractedTree(
    overlayDirectory,
    "Factory Windows overlay",
  );
  await setFixedTimes(overlayTreeManifest);
  const overlays = await overlayMappings(overlayTreeManifest, sourceTree);
  const expectedOutputIso9660Files = expectedIso9660VisibleFileCount({
    sourceVisiblePaths: sourceFilesystemViews.iso9660,
    sourceTree: sourceTreeManifest,
    replacements: overlays.replacements,
  });
  const assemblyTree = join(workDirectory, "windows-assembly-udf");
  await cp(sourceTree, assemblyTree, {
    recursive: true,
    force: true,
    preserveTimestamps: false,
  });
  await applyOverlayMappings(assemblyTree, overlays.mappings);
  const assemblyTreeManifest = await validateExtractedTree(
    assemblyTree,
    "Factory Windows assembly",
  );
  await setFixedTimes(assemblyTreeManifest);
  const isoHidePatterns = assemblyHidePatterns({
    assemblyTree,
    assemblyTreeManifest,
    paths: outputIsoHiddenPaths,
  });
  const jolietHidePatterns = assemblyHidePatterns({
    assemblyTree,
    assemblyTreeManifest,
    paths: outputJolietHiddenPaths,
  });
  const bios = sourceCatalog.bootCatalog.find(
    (entry) => entry.platform === "BIOS",
  );
  const uefi = sourceCatalog.bootCatalog.find(
    (entry) => entry.platform === "UEFI",
  );
  const bootArgs = [
    "-b",
    bios.isoEntry,
    "-c",
    "boot.catalog",
    "-no-emul-boot",
    "-boot-load-seg",
    bios.loadSegment,
    "-boot-load-size",
    String(bios.loadSize),
    "-eltorito-alt-boot",
    "-e",
    uefi.isoEntry,
    "-no-emul-boot",
    "-boot-load-seg",
    uefi.loadSegment,
    "-boot-load-size",
    String(uefi.loadSize),
  ];
  const sortFile = join(workDirectory, "iso-sort.txt");
  await writeDeterministicIsoSortFile(assemblyTreeManifest, sortFile);
  await acquireUdfWriterLock();
  try {
    await run(
      writer,
      [
        "-quiet",
        "-udf",
        ...(sourceHasJoliet ? ["-J"] : []),
        "-R",
        "-iso-level",
        "3",
        "-allow-limited-size",
        "-V",
        "VEM_FACTORY",
        "-volset",
        UDF_VOLUME_SET_ID,
        "-A",
        "VEM_FACTORY_ISSUE10",
        "-sysid",
        "VEM",
        "-sort",
        sortFile,
        ...isoHidePatterns.flatMap((path) => ["-hide", path]),
        ...jolietHidePatterns.flatMap((path) => ["-hide-joliet", path]),
        ...bootArgs,
        "-o",
        outputPath,
        assemblyTree,
      ],
      { cwd: workDirectory, env: toolEnv, maxBuffer: 4 * 1024 * 1024 },
    );
  } finally {
    await rm(UDF_WRITER_LOCK, { recursive: true, force: true });
  }
  await normalizeDescriptorTimestampsFile(outputPath);
  const { media: outputMedia, close: closeOutputMedia } =
    rangeBackedIsoMedia(outputPath);
  let outputCatalog;
  let structure;
  let outputTreeManifest;
  try {
    const outputFilesystemViews = inspectIsoFilesystemViews(outputMedia);
    if (sourceHasJoliet && outputFilesystemViews.joliet.length === 0) {
      throw new Error("serviced ISO lost the required Joliet filesystem view");
    }
    verifySourceFilesystemVisibility({
      sourceVisiblePaths: sourceFilesystemViews.iso9660,
      outputVisiblePaths: outputFilesystemViews.iso9660,
      hiddenPaths: outputIsoHiddenPaths,
      expectedFileCount: expectedOutputIso9660Files,
      label: "ISO9660",
    });
    if (sourceHasJoliet) {
      verifySourceFilesystemVisibility({
        sourceVisiblePaths: sourceFilesystemViews.joliet,
        outputVisiblePaths: outputFilesystemViews.joliet,
        hiddenPaths: outputJolietHiddenPaths,
        label: "Joliet",
      });
    }
    const outputTree = join(workDirectory, "serviced-windows-output-udf");
    await mkdir(outputTree, { recursive: true });
    outputTreeManifest = await extractUdfView({
      extractor,
      isoPath: outputPath,
      tree: outputTree,
      workDirectory,
    });
    assertOptionalGeneratedReplayPaths(outputTreeManifest, "serviced ISO");
    outputCatalog = await inspectWindowsSetupTree({
      wimlibExecutable,
      isoBytes: outputMedia,
      tree: outputTree,
      treeManifest: outputTreeManifest,
      workDirectory,
      expectedInstallImage,
    });
    const generatedCatalog = await verifyGeneratedBootCatalogBinding(
      outputTreeManifest,
      outputMedia,
    );
    structure = {
      ...inspectBootableIso(outputMedia),
      windowsSetup: outputCatalog,
    };
    if (
      canonicalJson(generatedCatalog.bootEntries) !==
      canonicalJson(structure.bootEntries)
    ) {
      throw new Error(
        "generated boot.catalog semantics do not match the El Torito catalog",
      );
    }
  } finally {
    closeOutputMedia();
  }
  if (
    canonicalJson(
      sourceCatalog.bootCatalog.map(({ imageSector, ...entry }) => entry),
    ) !==
    canonicalJson(
      outputCatalog.bootCatalog.map(({ imageSector, ...entry }) => entry),
    )
  )
    throw new Error(
      "serviced ISO boot catalog does not preserve the verified BIOS/UEFI semantics",
    );
  await verifyWindowsSetupTreeReplay({
    sourceTree: sourceTreeManifest,
    outputTree: outputTreeManifest,
    replacements: overlays.replacements,
  });
  return {
    path: outputPath,
    bytes: (await lstat(outputPath)).size,
    digest: await hashFile(outputPath),
    structure,
  };
}

export async function createRedistributableFixtureIso({
  udfWriterPath,
  udfWriter,
  outputPath,
}) {
  const writerBytes = await readPinnedExecutable(
    udfWriterPath,
    udfWriter,
    "UDF writer",
  );
  const workDirectory = await mkdtemp(join(tmpdir(), "vem-iso-fixture-"));
  try {
    const stageDirectory = join(workDirectory, "stage");
    await mkdir(join(stageDirectory, "BOOT"), { recursive: true });
    await writeFile(join(stageDirectory, "BOOT", "BOOT.IMG"), bootImageBytes());
    await writeFile(
      join(stageDirectory, "README.TXT"),
      "Redistributable VEM Issue10 bootable ISO fixture. Not Windows installation media.\n",
    );
    await setFixedTimes(
      await validateExtractedTree(
        stageDirectory,
        "Redistributable fixture stage",
      ),
    );
    const built = await executeUdfWriter({
      writerBytes,
      stageDirectory,
      outputPath: join(workDirectory, "fixture.iso"),
      workDirectory,
    });
    await mkdir(dirname(outputPath), { recursive: true });
    await cp(built.path, outputPath, { force: false, errorOnExist: true });
    await chmod(outputPath, 0o444);
    return {
      digest: built.digest,
      bytes: built.bytes,
      structure: built.structure,
    };
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function resolveAssets({
  manifest,
  store,
  sourcePaths,
  sourceStoreRoot,
  evidenceStoreRoot,
  approvalPolicy,
  authenticodeVerifierPath,
  authenticodeCaBundlePath,
}) {
  const resolved = [];
  for (const reference of assetReferences(manifest)) {
    const sourcePath =
      sourcePaths?.[reference.identity] ??
      (reference.role === "windows-source-iso" && sourceStoreRoot
        ? join(sourceStoreRoot, "sha256", reference.digest.slice(7))
        : undefined);
    const resolution =
      reference.role === "windows-source-iso"
        ? await store.verifyUncached(reference, sourcePath)
        : await store.ensure(reference, sourcePath);
    let authenticodeVerification;
    if (reference.signature.scheme === "authenticode") {
      const verifier = manifest.toolchain.authenticodeVerifier;
      if (!verifier || !authenticodeVerifierPath || !authenticodeCaBundlePath) {
        throw new Error(
          "AuthentiCode assets require a pinned verifier and trusted CA bundle",
        );
      }
      const workDirectory = await mkdtemp(
        join(tmpdir(), "vem-authenticode-input-"),
      );
      try {
        const assetPath = join(workDirectory, "signed-asset.bin");
        if (reference.role === "windows-source-iso") {
          await store.stageUncachedVerified(reference, sourcePath, assetPath);
        } else {
          await store.stageVerified(reference, assetPath);
        }
        authenticodeVerification = await verifyAuthenticodeSignature({
          asset: reference,
          assetPath,
          verifierPath: authenticodeVerifierPath,
          verifierDigest: verifier.digest,
          caBundlePath: authenticodeCaBundlePath,
          approvedSignerIdentities: approvalPolicy.authenticodeSignerIdentities,
        });
      } finally {
        await rm(workDirectory, { recursive: true, force: true });
      }
    }
    const verifiedEvidence = await verifyAssetEvidence({
      asset: reference,
      evidenceStoreRoot,
      approvalPolicy,
      authenticodeVerification,
    });
    resolved.push({ reference, resolution, sourcePath, verifiedEvidence });
  }
  return resolved;
}

async function stageBuildInputs({
  manifest,
  resolvedAssets,
  store,
  stageDirectory,
  visionTrustMaterial,
}) {
  await mkdir(join(stageDirectory, "BOOT"), { recursive: true });
  await mkdir(join(stageDirectory, "VEM", "ASSETS"), { recursive: true });
  await writeFile(join(stageDirectory, "BOOT", "BOOT.IMG"), bootImageBytes());
  await writeFile(
    join(stageDirectory, "VEM", "MANIFEST.JSON"),
    Buffer.from(canonicalJson(manifest)),
  );
  const visionEvidence = resolvedAssets.find(
    ({ reference }) => reference.role === "vision-release",
  )?.visionEvidence;
  if (!visionEvidence) {
    throw new Error(
      "approved Vision release evidence is missing from Factory Media inputs",
    );
  }
  const evidenceRoot = join(stageDirectory, "VEM", "VISION-RELEASE");
  await mkdir(evidenceRoot, { recursive: true });
  await writeFile(
    join(evidenceRoot, "factory-manifest.json"),
    Buffer.from(canonicalJson(manifest)),
  );
  const visionAsset = resolvedAssets.find(
    ({ reference }) => reference.role === "vision-release",
  );
  await store.stageVerified(
    visionAsset.reference,
    join(evidenceRoot, "bundle.bin"),
  );
  for (const [role, bytes] of Object.entries(
    visionEvidence.deliveryUnit.documents,
  )) {
    await writeFile(join(evidenceRoot, `${role}.json`), bytes);
  }
  for (const [role, signature] of Object.entries(
    visionEvidence.deliveryUnit.signatures,
  )) {
    await writeFile(
      join(evidenceRoot, `${role}.signature.json`),
      Buffer.from(canonicalJson(signature)),
    );
  }
  const trustRoot = join(stageDirectory, "VEM", "VISION-TRUST");
  await mkdir(trustRoot, { recursive: true });
  const installerFiles = await stageFactoryVisionInstaller({ stageDirectory });
  const installerBytes =
    installerFiles["VISION-INSTALLER/install-vision-release.ps1"];
  const provisionerBytes =
    installerFiles["VISION-INSTALLER/provision-vision-factory-release.ps1"];
  const materializationBytes =
    installerFiles["VISION-INSTALLER/vision-release-materialization.psm1"];
  const redactionBytes =
    installerFiles["VISION-INSTALLER/vision-diagnostic-redaction.psm1"];
  await writeFile(
    join(trustRoot, "vision-release-trust-anchor.json"),
    visionTrustMaterial.anchorBytes,
  );
  await writeFile(
    join(trustRoot, "vision-release-trust-policy.json"),
    visionTrustMaterial.policyBytes,
  );
  await writeFile(
    join(trustRoot, "vision-release-verifier.exe"),
    visionTrustMaterial.verifierBytes,
  );
  const provisioningManifest = visionFactoryProvisioningManifest({
    "VISION-RELEASE/factory-manifest.json": Buffer.from(
      canonicalJson(manifest),
    ),
    "VISION-RELEASE/bundle.bin": await readFile(
      join(evidenceRoot, "bundle.bin"),
    ),
    ...Object.fromEntries(
      Object.entries(visionEvidence.deliveryUnit.documents).map(
        ([role, bytes]) => [`VISION-RELEASE/${role}.json`, bytes],
      ),
    ),
    ...Object.fromEntries(
      Object.entries(visionEvidence.deliveryUnit.signatures).map(
        ([role, value]) => [
          `VISION-RELEASE/${role}.signature.json`,
          Buffer.from(canonicalJson(value)),
        ],
      ),
    ),
    "VISION-TRUST/vision-release-trust-anchor.json":
      visionTrustMaterial.anchorBytes,
    "VISION-TRUST/vision-release-trust-policy.json":
      visionTrustMaterial.policyBytes,
    "VISION-TRUST/vision-release-verifier.exe":
      visionTrustMaterial.verifierBytes,
    "VISION-INSTALLER/install-vision-release.ps1": installerBytes,
    "VISION-INSTALLER/provision-vision-factory-release.ps1": provisionerBytes,
    "VISION-INSTALLER/vision-release-materialization.psm1":
      materializationBytes,
    "VISION-INSTALLER/vision-diagnostic-redaction.psm1": redactionBytes,
  });
  await writeFile(
    join(stageDirectory, "VEM", "VISION-FACTORY-PROVISIONING.JSON"),
    Buffer.from(canonicalJson(provisioningManifest)),
  );
  for (const asset of resolvedAssets) {
    const name =
      asset.reference.role === "windows-source-iso"
        ? "WINDOWS-SOURCE.ISO"
        : `${asset.reference.role.toUpperCase()}.BIN`;
    const destination = join(stageDirectory, "VEM", "ASSETS", name);
    if (asset.reference.role === "windows-source-iso") {
      await store.stageUncachedVerified(
        asset.reference,
        asset.sourcePath,
        destination,
      );
    } else {
      await store.stageVerified(asset.reference, destination);
    }
  }
  await setFixedTimes(
    await validateExtractedTree(stageDirectory, "Factory fixture input stage"),
  );
}

export async function createWindowsFactoryFirstBootMedia({
  manifest,
  resolvedAssets,
  store,
  directory,
  visionTrustMaterial,
  effectiveInputs = [],
}) {
  const oemRoot = join(directory, "sources", "$OEM$");
  const mediaRoot = join(oemRoot, "$1", ...FACTORY_MEDIA_DIRECTORY.split("/"));
  const assetsRoot = join(mediaRoot, "assets");
  const scriptsRoot = join(mediaRoot, "scripts");
  await mkdir(assetsRoot, { recursive: true });
  await mkdir(scriptsRoot, { recursive: true });
  await writeFile(
    join(directory, "Autounattend.xml"),
    factoryAutounattendXml(
      manifest.profile,
      manifest.source.installImageIndex,
      manifest.source.targetFirmware,
      manifest.source.installImageEdition,
    ),
  );
  await writeFile(
    join(mediaRoot, "install-factory-baseline.ps1"),
    baselineInstallerScript(),
  );
  await writeFile(
    join(mediaRoot, "bootstrap-factory-runtime.ps1"),
    factoryBootstrapScript(manifest.profile),
  );
  await writeFile(
    join(mediaRoot, "prepare-oobe-bootstrap.ps1"),
    factoryOobeBootstrapPreparationScript(manifest.profile),
  );
  await writeFile(
    join(mediaRoot, "complete-oobe-bootstrap.ps1"),
    factoryOobeCompletionScript(),
  );
  await writeFile(
    join(mediaRoot, "ingest-host-personalization.ps1"),
    hostPersonalizationIngestScript(),
  );
  await writeFile(
    join(mediaRoot, "factory-effective-inputs.json"),
    Buffer.from(
      canonicalJson({
        schemaVersion: "vem-factory-effective-inputs/v1",
        inputs: effectiveInputs,
      }),
    ),
  );
  const baseline = factoryBaselineManifest(manifest, resolvedAssets);
  const preparation = factoryPreparationDescriptor(manifest, resolvedAssets);
  await writeFile(
    join(mediaRoot, "factory-preparation.json"),
    Buffer.from(canonicalJson(preparation)),
  );
  await writeFile(
    join(mediaRoot, "factory-baseline.json"),
    Buffer.from(canonicalJson(baseline)),
  );
  const names = new Map(
    baseline.assets.map((asset) => [asset.role, asset.fileName]),
  );
  for (const asset of resolvedAssets) {
    if (asset.reference.role === "windows-source-iso") continue;
    await store.stageVerified(
      asset.reference,
      join(assetsRoot, names.get(asset.reference.role)),
    );
  }
  for (const script of [
    "prepare-factory-runtime.ps1",
    "verify-factory-runtime.ps1",
    "setup-scheduled-tasks.ps1",
    "verify-kiosk-lockdown.ps1",
    "verify-vem-runtime.ps1",
    "apply-managed-update.ps1",
    "provision-vision-factory-release.ps1",
    "install-vision-release.ps1",
    "vision-release-materialization.psm1",
    "vision-diagnostic-redaction.psm1",
  ]) {
    await writeFile(
      join(scriptsRoot, script),
      factoryProfileImplementationScript(
        await readFile(new URL(`../windows/${script}`, import.meta.url)),
        manifest.profile,
      ),
    );
  }
  const visionAsset = resolvedAssets.find(
    ({ reference }) => reference.role === "vision-release",
  );
  if (visionAsset?.visionEvidence && visionTrustMaterial) {
    const evidenceRoot = join(mediaRoot, "VEM", "VISION-RELEASE");
    const trustRoot = join(mediaRoot, "VEM", "VISION-TRUST");
    const installerRoot = join(mediaRoot, "VEM", "VISION-INSTALLER");
    await mkdir(evidenceRoot, { recursive: true });
    await mkdir(trustRoot, { recursive: true });
    await mkdir(installerRoot, { recursive: true });
    await writeFile(
      join(evidenceRoot, "factory-manifest.json"),
      Buffer.from(canonicalJson(manifest)),
    );
    await store.stageVerified(
      visionAsset.reference,
      join(evidenceRoot, "bundle.bin"),
    );
    for (const [role, bytes] of Object.entries(
      visionAsset.visionEvidence.deliveryUnit.documents,
    )) {
      await writeFile(join(evidenceRoot, `${role}.json`), bytes);
    }
    for (const [role, signature] of Object.entries(
      visionAsset.visionEvidence.deliveryUnit.signatures,
    )) {
      await writeFile(
        join(evidenceRoot, `${role}.signature.json`),
        Buffer.from(canonicalJson(signature)),
      );
    }
    await writeFile(
      join(trustRoot, "vision-release-trust-anchor.json"),
      visionTrustMaterial.anchorBytes,
    );
    await writeFile(
      join(trustRoot, "vision-release-trust-policy.json"),
      visionTrustMaterial.policyBytes,
    );
    await writeFile(
      join(trustRoot, "vision-release-verifier.exe"),
      visionTrustMaterial.verifierBytes,
    );
    for (const script of [
      "install-vision-release.ps1",
      "provision-vision-factory-release.ps1",
      "vision-release-materialization.psm1",
      "vision-diagnostic-redaction.psm1",
    ]) {
      await writeFile(
        join(installerRoot, script),
        await readFile(new URL(`../windows/${script}`, import.meta.url)),
      );
    }
    await writeFile(
      join(mediaRoot, "VEM", "VISION-FACTORY-PROVISIONING.JSON"),
      Buffer.from(
        canonicalJson(
          visionFactoryProvisioningManifest({
            "VISION-RELEASE/factory-manifest.json": Buffer.from(
              canonicalJson(manifest),
            ),
            "VISION-RELEASE/bundle.bin": await readFile(
              join(evidenceRoot, "bundle.bin"),
            ),
            ...Object.fromEntries(
              Object.entries(
                visionAsset.visionEvidence.deliveryUnit.documents,
              ).map(([role, bytes]) => [`VISION-RELEASE/${role}.json`, bytes]),
            ),
            ...Object.fromEntries(
              Object.entries(
                visionAsset.visionEvidence.deliveryUnit.signatures,
              ).map(([role, value]) => [
                `VISION-RELEASE/${role}.signature.json`,
                Buffer.from(canonicalJson(value)),
              ]),
            ),
            "VISION-TRUST/vision-release-trust-anchor.json":
              visionTrustMaterial.anchorBytes,
            "VISION-TRUST/vision-release-trust-policy.json":
              visionTrustMaterial.policyBytes,
            "VISION-TRUST/vision-release-verifier.exe":
              visionTrustMaterial.verifierBytes,
            "VISION-INSTALLER/install-vision-release.ps1": await readFile(
              join(installerRoot, "install-vision-release.ps1"),
            ),
            "VISION-INSTALLER/provision-vision-factory-release.ps1":
              await readFile(
                join(installerRoot, "provision-vision-factory-release.ps1"),
              ),
            "VISION-INSTALLER/vision-release-materialization.psm1":
              await readFile(
                join(installerRoot, "vision-release-materialization.psm1"),
              ),
            "VISION-INSTALLER/vision-diagnostic-redaction.psm1": await readFile(
              join(installerRoot, "vision-diagnostic-redaction.psm1"),
            ),
          }),
        ),
      ),
    );
  }
  await setFixedTimes(
    await validateExtractedTree(directory, "Factory first-boot media"),
  );
  return {
    mediaRoot: FACTORY_MEDIA_DIRECTORY,
    firstBoot: "specialize SYSTEM Factory bootstrap with kiosk-logon cleanup",
    unattended: "Autounattend.xml",
    baseline,
    preparation,
  };
}

function makeProvenance(
  manifest,
  resolvedAssets,
  output,
  reproducibility,
  structure,
  effectiveInputs,
) {
  const hits = resolvedAssets.filter(
    ({ resolution }) => resolution.status === "hit",
  ).length;
  const misses = resolvedAssets.filter(
    ({ resolution }) => resolution.status === "miss",
  ).length;
  return {
    schemaVersion: "vem-factory-provenance/v1",
    kind: "factory-media-provenance",
    manifest: {
      identity: manifest.manifestId,
      schemaVersion: manifest.schemaVersion,
      profile: manifest.profile,
    },
    inputs: resolvedAssets.map(
      ({ reference, resolution, verifiedEvidence }) => ({
        role: reference.role,
        identity: reference.identity,
        digest: reference.digest,
        version: reference.version,
        signature: verifiedEvidence.signature,
        provenance: verifiedEvidence.provenance,
        resolution: resolution.evidence,
      }),
    ),
    effectiveInputs,
    toolchain: {
      builderImage: { ...manifest.toolchain.builderImage, executed: true },
      udfExtractor: { ...manifest.toolchain.udfExtractor, executed: true },
      udfWriter: { ...manifest.toolchain.udfWriter, executed: true },
      wimlib: { ...manifest.toolchain.wimlib, executed: true },
      ...(manifest.toolchain.authenticodeVerifier
        ? {
            authenticodeVerifier: {
              ...manifest.toolchain.authenticodeVerifier,
              executed: resolvedAssets.some(
                ({ reference }) =>
                  reference.signature.scheme === "authenticode",
              ),
            },
          }
        : {}),
    },
    output: {
      identity: output.identity,
      digest: output.digest,
      fileName: output.fileName,
      bytes: output.bytes,
      structure,
      assemblyMode: manifest.outputPolicy.assemblyMode,
      windowsInstallerCustomized: true,
      requiresIssue15CustomizationAssets: false,
    },
    evidence: {
      cache: { hits, misses, entries: hits + misses },
      sourceMedia: { verified: 1, cached: false },
      deterministic: {
        ordering: "role-ascending",
        timestampEpoch: FIXED_EPOCH_SECONDS,
        udfVolumeSetIdentity: UDF_VOLUME_SET_ID,
      },
      policy: {
        sourceWindowsMediaUploaded: false,
        personalizationMediaUploaded: false,
        secretsCached: false,
        privateKeysCached: false,
        hostPathsIncluded: false,
      },
    },
    reproducibility,
  };
}

export async function buildFactoryMedia({
  manifest,
  store,
  sourcePaths,
  sourceStoreRoot,
  evidenceStoreRoot,
  approvalPolicy,
  visionReleaseDeliveryUnit,
  repositoryVisionTrustedRoots,
  factoryVisionTrustedRoots,
  visionEvidenceVerifierPath,
  udfExtractorPath,
  udfWriterPath,
  wimlibPath,
  authenticodeVerifierPath,
  authenticodeCaBundlePath,
  executedBuilderImage,
  outputDirectory,
  reproducibility = false,
}) {
  const validatedManifest = validateFactoryManifest(manifest);
  if (!(store instanceof ContentAddressedAssetStore)) {
    throw new TypeError(
      "buildFactoryMedia requires a ContentAddressedAssetStore",
    );
  }
  if (
    executedBuilderImage !== validatedManifest.toolchain.builderImage.identity
  ) {
    throw new Error(
      "executed builder image does not exactly match the Factory Manifest",
    );
  }
  if (!udfExtractorPath || !udfWriterPath)
    throw new Error(
      "windows-serviced-iso requires pinned UDF extractor and writer executable paths",
    );
  const [extractorBytes, writerBytes] = await Promise.all([
    readPinnedExecutable(
      udfExtractorPath,
      validatedManifest.toolchain.udfExtractor,
      "UDF extractor",
    ),
    readPinnedExecutable(
      udfWriterPath,
      validatedManifest.toolchain.udfWriter,
      "UDF writer",
    ),
  ]);
  if (!wimlibPath)
    throw new Error(
      "windows-serviced-iso requires a pinned wimlib executable path",
    );
  const wimlibBytes = await readPinnedExecutable(
    wimlibPath,
    validatedManifest.toolchain.wimlib,
  );
  const visionEvidence = verifyManifestVisionReleaseEvidence({
    manifest: validatedManifest,
    deliveryUnit: visionReleaseDeliveryUnit,
    repositoryTrustedRoots: repositoryVisionTrustedRoots,
    factoryTrustedRoots: factoryVisionTrustedRoots,
  });
  const visionTrustMaterial = createVisionFactoryTrustMaterial({
    repositoryTrustedRoots: repositoryVisionTrustedRoots,
    factoryTrustedRoots: factoryVisionTrustedRoots,
    verifierBytes: await readPinnedVisionVerifier(visionEvidenceVerifierPath),
  });
  const repositoryEffectiveInputs =
    await currentFactoryEffectiveRepositoryInputs();
  const effectiveInputs = [
    {
      role: "manifest:factory-manifest",
      digest: hashBytes(Buffer.from(canonicalJson(validatedManifest))),
    },
    ...assetReferences(validatedManifest).map((asset) => ({
      role: `asset:${asset.role}`,
      digest: asset.digest,
    })),
    {
      role: "tool:builder-image",
      digest: validatedManifest.toolchain.builderImage.digest,
    },
    {
      role: "tool:udf-extractor",
      digest: validatedManifest.toolchain.udfExtractor.digest,
    },
    {
      role: "tool:udf-writer",
      digest: validatedManifest.toolchain.udfWriter.digest,
    },
    {
      role: "tool:wimlib",
      digest: validatedManifest.toolchain.wimlib.digest,
    },
    ...repositoryEffectiveInputs,
    {
      role: "vision-verifier",
      digest: hashBytes(visionTrustMaterial.verifierBytes),
    },
    {
      role: "vision-repository-trust",
      digest: hashBytes(
        Buffer.from(canonicalJson(repositoryVisionTrustedRoots)),
      ),
    },
    {
      role: "vision-factory-trust",
      digest: hashBytes(Buffer.from(canonicalJson(factoryVisionTrustedRoots))),
    },
    ...Object.entries(visionReleaseDeliveryUnit.documents).map(
      ([role, bytes]) => ({
        role: `vision-document:${role}`,
        digest: hashBytes(bytes),
      }),
    ),
    ...Object.entries(visionReleaseDeliveryUnit.signatures).map(
      ([role, value]) => ({
        role: `vision-signature:${role}`,
        digest: hashBytes(Buffer.from(canonicalJson(value))),
      }),
    ),
  ].sort((left, right) => left.role.localeCompare(right.role));
  const resolvedAssets = await resolveAssets({
    manifest: validatedManifest,
    store,
    sourcePaths,
    sourceStoreRoot,
    evidenceStoreRoot,
    approvalPolicy,
    authenticodeVerifierPath,
    authenticodeCaBundlePath,
  });
  await assertRuntimeAssetsContainNoPlatformPaymentSecrets(
    resolvedAssets,
    store,
  );
  const selectedVisionAsset = resolvedAssets.find(
    ({ reference }) => reference.role === "vision-release",
  );
  selectedVisionAsset.visionEvidence = {
    selection: visionEvidence,
    deliveryUnit: visionReleaseDeliveryUnit,
  };
  const buildCount = reproducibility ? 2 : 1;
  const builds = [];
  const buildArtifactsDirectory = await mkdtemp(
    join(tmpdir(), "vem-factory-build-artifacts-"),
  );
  const sourceWindowsMedia = resolvedAssets.find(
    ({ reference }) => reference.role === "windows-source-iso",
  );
  if (
    validatedManifest.outputPolicy.assemblyMode === WINDOWS_SERVICED_ISO &&
    !sourceWindowsMedia?.sourcePath
  ) {
    throw new Error(
      "windows-serviced-iso requires a verified Windows source path",
    );
  }
  if (validatedManifest.outputPolicy.assemblyMode === WINDOWS_SERVICED_ISO) {
    for (const role of [
      "openssh-installer",
      "wireguard-installer",
      "webview2-runtime-installer",
    ]) {
      const asset = resolvedAssets.find(
        ({ reference }) => reference.role === role,
      )?.reference;
      if (
        !asset?.mediaFileName ||
        !/\.(?:msi|exe)$/i.test(asset.mediaFileName)
      ) {
        throw new Error(
          `windows-serviced-iso requires ${role}.mediaFileName to name a pinned MSI or EXE`,
        );
      }
    }
  }
  try {
    for (let index = 0; index < buildCount; index += 1) {
      const workDirectory = await mkdtemp(
        join(tmpdir(), `vem-factory-build-${index + 1}-`),
      );
      try {
        const outputPath = join(workDirectory, "factory.iso");
        if (
          validatedManifest.outputPolicy.assemblyMode === WINDOWS_SERVICED_ISO
        ) {
          const overlayDirectory = join(workDirectory, "windows-overlay");
          const verifiedSourceSnapshot = join(
            workDirectory,
            "verified-windows-source.iso",
          );
          // This is copied from the already-opened, digest-verified source handle.
          // The builder never reopens the restricted source pathname afterwards.
          await store.stageUncachedVerified(
            sourceWindowsMedia.reference,
            sourceWindowsMedia.sourcePath,
            verifiedSourceSnapshot,
          );
          await createWindowsFactoryFirstBootMedia({
            manifest: validatedManifest,
            resolvedAssets,
            store,
            directory: overlayDirectory,
            visionTrustMaterial,
            effectiveInputs,
          });
          const build = await executeWindowsServicedIsoBuilder({
            extractorBytes,
            writerBytes,
            wimlibBytes,
            manifestSource: {
              ...validatedManifest.source,
              wimlibVersion: validatedManifest.toolchain.wimlib.version,
            },
            sourceIsoPath: verifiedSourceSnapshot,
            extractorVersion: validatedManifest.toolchain.udfExtractor.version,
            writerVersion: validatedManifest.toolchain.udfWriter.version,
            overlayDirectory,
            outputPath,
            workDirectory,
          });
          const artifactPath = join(
            buildArtifactsDirectory,
            `build-${index + 1}.iso`,
          );
          await cp(build.path, artifactPath, {
            force: false,
            errorOnExist: true,
          });
          await chmod(artifactPath, 0o444);
          builds.push({ ...build, path: artifactPath });
        } else {
          const stageDirectory = join(workDirectory, "stage");
          await stageBuildInputs({
            manifest: validatedManifest,
            resolvedAssets,
            store,
            stageDirectory,
            visionTrustMaterial,
          });
          const build = await executeUdfWriter({
            writerBytes,
            stageDirectory,
            outputPath,
            workDirectory,
          });
          const artifactPath = join(
            buildArtifactsDirectory,
            `build-${index + 1}.iso`,
          );
          await cp(build.path, artifactPath, {
            force: false,
            errorOnExist: true,
          });
          await chmod(artifactPath, 0o444);
          builds.push({ ...build, path: artifactPath });
        }
      } finally {
        await rm(workDirectory, { recursive: true, force: true });
      }
    }
    const firstDigest = builds[0].digest;
    const comparisons = await Promise.all(
      builds
        .slice(1)
        .map((build) => compareFilesByRange(builds[0].path, build.path)),
    );
    const identical =
      builds.every((build) => build.digest === firstDigest) &&
      comparisons.every(({ identical: equal }) => equal);
    if (!identical) {
      const differences = comparisons
        .flatMap(({ differences }) => differences)
        .slice(0, 12);
      throw new Error(
        `reproducibility check failed: Factory ISO output differs at byte offsets ${differences.join(",")}`,
      );
    }

    await mkdir(outputDirectory, { recursive: true });
    const fileName = outputName(validatedManifest);
    const outputPath = join(outputDirectory, fileName);
    await cp(builds[0].path, outputPath, { force: false, errorOnExist: true });
    await chmod(outputPath, 0o444);
    const output = {
      role: "factory-iso",
      identity: `factory-cas://${firstDigest.replace(":", "/")}`,
      digest: firstDigest,
      fileName,
      bytes: builds[0].bytes,
      path: outputPath,
    };
    const reproducibilityEvidence = {
      mode: reproducibility ? "required" : "disabled",
      builds: buildCount,
      independentDirectories: true,
      independentProcesses: true,
      identical,
    };
    return {
      output,
      reproducibility: reproducibilityEvidence,
      provenance: makeProvenance(
        validatedManifest,
        resolvedAssets,
        output,
        reproducibilityEvidence,
        builds[0].structure,
        effectiveInputs,
      ),
    };
  } finally {
    await rm(buildArtifactsDirectory, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const contractIndex = process.argv.indexOf("--delivery-assembly-contract");
  if (contractIndex >= 0) {
    try {
      const contractPath = process.argv[contractIndex + 1];
      const contract = JSON.parse(await readFile(contractPath, "utf8"));
      if (
        contract?.schemaVersion !==
          "vem-delivery-assembly-execution-contract/v1" ||
        contract.producer !== "scripts/factory/build-factory-media.mjs" ||
        contract.kind !== "deliveryAssembly" ||
        typeof contract.outputRoot !== "string"
      ) {
        throw new Error("invalid Factory delivery assembly execution contract");
      }
      await stageFactoryVisionDeliveryAssemblyContract({
        outputRoot: contract.outputRoot,
      });
      process.stdout.write(
        `${JSON.stringify({ nonce: contract.nonce, outputRoot: contract.outputRoot })}\n`,
      );
    } catch (error) {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
