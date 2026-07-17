import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, resolve } from "node:path";

import { createRuntimeProfile } from "./libvirt-runtime-profile.mjs";

const GiB = 1024 ** 3;
const REQUIRED_COMMANDS = [
  "virsh",
  "virt-install",
  "qemu-img",
  "xorriso",
  "ssh",
  "scp",
  "flock",
];

const RELEASE_MANIFEST_SCHEMA = "win10-kvm-baseline-release/v1";
const CURRENT_MANIFEST_SCHEMA = "win10-kvm-baseline-current/v1";
const RELEASE_ARTIFACTS = Object.freeze({
  system: "system.qcow2",
  cache: "cache.qcow2",
  domainXml: "runtime-profile.xml",
  diagnostic: "diagnostic.json",
});
export const BASELINE_PUBLICATION_STAGES = Object.freeze([
  "release-staging-created",
  "system-staged",
  "cache-staged",
  "domain-xml-staged",
  "diagnostic-staged",
  "release-manifest-staged",
  "release-directory-published",
  "current-manifest-staged",
  "current-manifest-published",
]);

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function integer(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function absolutePath(value, label) {
  const path = string(value, label);
  if (
    !isAbsolute(path) ||
    path.includes("\0") ||
    normalize(path) !== resolve(path)
  ) {
    throw new Error(`${label} must be a canonical absolute Unix path`);
  }
  return path;
}

function hostnameOrAddress(value, label) {
  const result = string(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/.test(result)) {
    throw new Error(`${label} must be a hostname or IP address`);
  }
  return result;
}

function pathInside(path, root) {
  return path.startsWith(`${root}/`);
}

function releaseId(value) {
  const result = string(value, "releaseId");
  if (!/^[a-z0-9][a-z0-9-]{7,127}$/i.test(result)) {
    throw new Error("releaseId must be a portable release identifier");
  }
  return result;
}

function hostIdentityMatches(address, identity) {
  const configured = hostnameOrAddress(address, "host.address").toLowerCase();
  const observed = object(identity, "host observation.hostIdentity");
  const hostnames = new Set(
    (observed.hostnames ?? []).map((value) => String(value).toLowerCase()),
  );
  const addresses = new Set(
    (observed.addresses ?? []).map((value) => String(value).toLowerCase()),
  );
  const resolvedAddresses = new Set(
    (observed.resolvedConfiguredAddresses ?? []).map((value) =>
      String(value).toLowerCase(),
    ),
  );
  return (
    hostnames.has(configured) ||
    addresses.has(configured) ||
    [...resolvedAddresses].some((value) => addresses.has(value))
  );
}

export function validateBaselineBuildConfig(input) {
  const config = object(input, "baseline config");
  if (config.schemaVersion !== "win10-kvm-baseline/v1") {
    throw new Error("schemaVersion must be win10-kvm-baseline/v1");
  }
  const host = object(config.host, "host");
  hostnameOrAddress(host.address, "host.address");
  if (host.libvirtUri !== "qemu:///system") {
    throw new Error("host.libvirtUri must be qemu:///system");
  }
  absolutePath(host.lockPath, "host.lockPath");
  const largeFileRoot = absolutePath(host.largeFileRoot, "host.largeFileRoot");
  const vm = object(config.vm, "vm");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,62}$/.test(string(vm.name, "vm.name"))) {
    throw new Error("vm.name must be a portable libvirt domain name");
  }
  string(vm.networkName, "vm.networkName");
  if (
    !/^52:54:00(?::[0-9a-f]{2}){3}$/i.test(
      string(vm.macAddress, "vm.macAddress"),
    )
  ) {
    throw new Error(
      "vm.macAddress must be a stable libvirt locally administered MAC",
    );
  }

  const storage = object(config.storage, "storage");
  const baselinePath = absolutePath(
    storage.baselinePath,
    "storage.baselinePath",
  );
  const cacheDiskPath = absolutePath(
    storage.cacheDiskPath,
    "storage.cacheDiskPath",
  );
  if (baselinePath === cacheDiskPath) {
    throw new Error("storage baseline and persistent cache disks must differ");
  }
  if (
    !pathInside(baselinePath, largeFileRoot) ||
    !pathInside(cacheDiskPath, largeFileRoot)
  ) {
    throw new Error(
      "storage baseline and persistent cache disks must stay under host.largeFileRoot",
    );
  }
  for (const key of ["systemDiskGiB", "cacheDiskGiB", "minimumFreeGiB"]) {
    integer(storage[key], `storage.${key}`);
  }
  const media = object(config.media, "media");
  const windowsIsoPath = absolutePath(
    media.windowsIsoPath,
    "media.windowsIsoPath",
  );
  if (!pathInside(windowsIsoPath, largeFileRoot)) {
    throw new Error("media.windowsIsoPath must stay under host.largeFileRoot");
  }
  // Seed this caller-owned local file from the pinned 0.141 release:
  // https://www.spice-space.org/download/windows/spice-guest-tools/spice-guest-tools-0.141/spice-guest-tools-0.141.exe
  const spiceGuestToolsInstallerPath = absolutePath(
    media.spiceGuestToolsInstallerPath,
    "media.spiceGuestToolsInstallerPath",
  );
  if (!pathInside(spiceGuestToolsInstallerPath, largeFileRoot)) {
    throw new Error(
      "media.spiceGuestToolsInstallerPath must stay under host.largeFileRoot",
    );
  }
  integer(media.windowsImageIndex, "media.windowsImageIndex");
  for (const key of ["webView2InstallerUri", "runnerArchiveUri"]) {
    const value = string(media[key], `media.${key}`);
    if (!/^https:\/\//.test(value))
      throw new Error(`media.${key} must use HTTPS`);
  }
  const guest = object(config.guest, "guest");
  for (const key of [
    "administratorPasswordFile",
    "authorizedKeysFile",
    "sshPrivateKeyFile",
  ]) {
    absolutePath(guest[key], `guest.${key}`);
  }
  string(guest.sshUser, "guest.sshUser");
  integer(guest.desktopScalePercent, "guest.desktopScalePercent");
  const runner = object(config.runner, "runner");
  if (!/^https:\/\/github\.com\//.test(string(runner.url, "runner.url"))) {
    throw new Error("runner.url must be a GitHub HTTPS URL");
  }
  const registrationTokenProvider = object(
    runner.registrationTokenProvider,
    "runner.registrationTokenProvider",
  );
  absolutePath(
    registrationTokenProvider.command,
    "runner.registrationTokenProvider.command",
  );
  if (
    registrationTokenProvider.arguments !== undefined &&
    (!Array.isArray(registrationTokenProvider.arguments) ||
      registrationTokenProvider.arguments.some(
        (argument) => typeof argument !== "string",
      ))
  ) {
    throw new Error(
      "runner.registrationTokenProvider.arguments must be an array of strings",
    );
  }
  string(runner.name, "runner.name");
  return config;
}

export function runtimeProfileForConfig(config) {
  validateBaselineBuildConfig(config);
  return createRuntimeProfile({
    vmName: config.vm.name,
    systemDiskPath: config.storage.baselinePath,
    cacheDiskPath: config.storage.cacheDiskPath,
    networkName: config.vm.networkName,
    macAddress: config.vm.macAddress,
    vcpus: config.runtime?.vcpus,
    memoryMiB: config.runtime?.memoryMiB,
    display: { scalePercent: config.guest.desktopScalePercent },
  });
}

export function baselinePublicationLayout(config) {
  validateBaselineBuildConfig(config);
  const baselinePath = config.storage.baselinePath;
  return {
    releaseRoot: `${baselinePath}.releases`,
    currentManifestPath: `${baselinePath}.current.json`,
  };
}

export function runtimeProfileForPublishedRelease(config, id) {
  const layout = baselinePublicationLayout(config);
  const directory = resolve(layout.releaseRoot, releaseId(id));
  return createRuntimeProfile({
    vmName: config.vm.name,
    systemDiskPath: `${directory}/${RELEASE_ARTIFACTS.system}`,
    cacheDiskPath: `${directory}/${RELEASE_ARTIFACTS.cache}`,
    networkName: config.vm.networkName,
    macAddress: config.vm.macAddress,
    vcpus: config.runtime?.vcpus,
    memoryMiB: config.runtime?.memoryMiB,
    display: { scalePercent: config.guest.desktopScalePercent },
  });
}

export function evaluateHostPreflight(config, observed) {
  validateBaselineBuildConfig(config);
  object(observed, "host observation");
  const profile = runtimeProfileForConfig(config);
  if (!hostIdentityMatches(config.host.address, observed.hostIdentity)) {
    throw new Error(
      "host.address must identify the executing host by hostname or resolved address",
    );
  }
  if (observed.kvmAvailable !== true) throw new Error("KVM is not available");
  if (observed.libvirtAvailable !== true)
    throw new Error("libvirt is not available");
  const commands = new Set(observed.commands ?? []);
  const missing = REQUIRED_COMMANDS.filter((command) => !commands.has(command));
  if (missing.length)
    throw new Error(`missing host tools: ${missing.join(", ")}`);
  if (
    !Number.isInteger(observed.cpuCount) ||
    observed.cpuCount < profile.vcpus
  ) {
    throw new Error(`host CPU count must satisfy ${profile.vcpus} vCPUs`);
  }
  if (
    !Number.isInteger(observed.availableMemoryMiB) ||
    observed.availableMemoryMiB < profile.memoryMiB
  ) {
    throw new Error(`host memory must satisfy ${profile.memoryMiB} MiB`);
  }
  const requiredStorageBytes = config.storage.minimumFreeGiB * GiB;
  const storage = observed.storageAvailableBytes ?? {};
  if (
    !Number.isFinite(storage.baseline) ||
    !Number.isFinite(storage.cache) ||
    storage.baseline < requiredStorageBytes ||
    storage.cache < requiredStorageBytes
  ) {
    throw new Error(
      `both baseline and cache storage must provide ${config.storage.minimumFreeGiB} GiB free`,
    );
  }
  if (observed.installationMedia?.windowsIso !== true) {
    throw new Error(
      "Windows installation media must be a readable regular file",
    );
  }
  if (observed.installationMedia?.spiceGuestToolsInstaller !== true) {
    throw new Error(
      "SPICE guest tools installer must be a readable regular file",
    );
  }
  if (observed.networkActive !== true) {
    throw new Error("configured libvirt network is not active");
  }
  return { ok: true };
}

export function parseGuestAddress(domifaddrOutput, macAddress) {
  const wanted = string(macAddress, "macAddress").toLowerCase();
  for (const line of String(domifaddrOutput).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (!fields.some((field) => field.toLowerCase() === wanted)) continue;
    const cidr = fields.find((field) =>
      /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(field),
    );
    if (cidr) return cidr.split("/", 1)[0];
  }
  return null;
}

export function readJsonWithBom(value) {
  return JSON.parse(String(value).replace(/^\uFEFF/, ""));
}

async function fsyncFile(path) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonDurably(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fsyncFile(path);
}

async function assertRegularFile(path, label) {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function releasePaths(layout, id) {
  const directory = resolve(layout.releaseRoot, releaseId(id));
  return {
    releaseId: id,
    directory,
    manifestPath: `${directory}/release.json`,
    systemPath: `${directory}/${RELEASE_ARTIFACTS.system}`,
    cachePath: `${directory}/${RELEASE_ARTIFACTS.cache}`,
    domainXmlPath: `${directory}/${RELEASE_ARTIFACTS.domainXml}`,
    diagnosticPath: `${directory}/${RELEASE_ARTIFACTS.diagnostic}`,
  };
}

function releaseManifest(config, paths, profile) {
  return {
    schemaVersion: RELEASE_MANIFEST_SCHEMA,
    releaseId: paths.releaseId,
    artifacts: RELEASE_ARTIFACTS,
    destinations: {
      baselinePath: config.storage.baselinePath,
      cacheDiskPath: config.storage.cacheDiskPath,
    },
    profile,
    publishedAt: new Date().toISOString(),
  };
}

function currentManifest(config, paths) {
  return {
    schemaVersion: CURRENT_MANIFEST_SCHEMA,
    releaseId: paths.releaseId,
    destinations: {
      baselinePath: config.storage.baselinePath,
      cacheDiskPath: config.storage.cacheDiskPath,
    },
    artifacts: {
      systemPath: paths.systemPath,
      cachePath: paths.cachePath,
      domainXmlPath: paths.domainXmlPath,
      diagnosticPath: paths.diagnosticPath,
    },
  };
}

async function readCompleteRelease(config, layout, id) {
  const paths = releasePaths(layout, id);
  const manifest = JSON.parse(await readFile(paths.manifestPath, "utf8"));
  if (
    manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA ||
    manifest.releaseId !== paths.releaseId ||
    JSON.stringify(manifest.artifacts) !== JSON.stringify(RELEASE_ARTIFACTS) ||
    manifest.destinations?.baselinePath !== config.storage.baselinePath ||
    manifest.destinations?.cacheDiskPath !== config.storage.cacheDiskPath
  ) {
    throw new Error("published baseline release manifest is invalid");
  }
  await Promise.all(
    [
      [paths.systemPath, "published system disk"],
      [paths.cachePath, "published cache disk"],
      [paths.domainXmlPath, "published domain XML"],
      [paths.diagnosticPath, "published diagnostic"],
    ].map(([path, label]) => assertRegularFile(path, label)),
  );
  return { ...paths, manifest };
}

async function readCurrentRelease(config, layout) {
  const current = JSON.parse(
    await readFile(layout.currentManifestPath, "utf8"),
  );
  if (current.schemaVersion !== CURRENT_MANIFEST_SCHEMA) {
    throw new Error("published baseline current manifest schema is invalid");
  }
  const paths = await readCompleteRelease(config, layout, current.releaseId);
  if (
    JSON.stringify(current) !== JSON.stringify(currentManifest(config, paths))
  ) {
    throw new Error("published baseline current manifest is invalid");
  }
  return { ...paths, current };
}

async function removeInterruptedPublicationFiles(layout) {
  let releaseEntries = [];
  try {
    releaseEntries = await readdir(layout.releaseRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await Promise.all(
    releaseEntries
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith(".staging-"),
      )
      .map((entry) =>
        rm(`${layout.releaseRoot}/${entry.name}`, {
          recursive: true,
          force: true,
        }),
      ),
  );
  const parent = dirname(layout.currentManifestPath);
  const currentName = basename(layout.currentManifestPath);
  const parentEntries = await readdir(parent, { withFileTypes: true });
  await Promise.all(
    parentEntries
      .filter((entry) => entry.name.startsWith(`${currentName}.pending-`))
      .map((entry) => rm(`${parent}/${entry.name}`, { force: true })),
  );
}

async function newestCompleteRelease(config, layout) {
  const entries = await readdir(layout.releaseRoot, { withFileTypes: true });
  const releases = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const complete = await readCompleteRelease(config, layout, entry.name);
      const metadata = await stat(complete.directory);
      releases.push({ complete, modifiedAt: metadata.mtimeMs });
    } catch {
      // A release directory becomes visible only before its current manifest is
      // switched. Leave an invalid one unreachable and remove it on the next
      // intentionally refreshed baseline.
    }
  }
  releases.sort((left, right) => right.modifiedAt - left.modifiedAt);
  return releases[0]?.complete ?? null;
}

async function writeCurrentRelease(config, layout, id) {
  const paths = releasePaths(layout, id);
  const pendingPath = `${layout.currentManifestPath}.pending-${process.pid}-${randomUUID()}`;
  await writeJsonDurably(pendingPath, currentManifest(config, paths));
  await rename(pendingPath, layout.currentManifestPath);
  await fsyncDirectory(dirname(layout.currentManifestPath));
}

// A current-manifest rename is the sole publication point. A process death
// before it leaves the prior complete release selected; after it, the new
// release directory was already synced and is complete.
export async function recoverPublishedBaseline(config) {
  const layout = baselinePublicationLayout(config);
  await mkdir(layout.releaseRoot, { recursive: true, mode: 0o700 });
  await removeInterruptedPublicationFiles(layout);
  try {
    return await readCurrentRelease(config, layout);
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) {
      // A pointer to an incomplete release must not remain usable. Select a
      // complete immutable release instead of exposing a mixed destination.
    }
  }
  const recovered = await newestCompleteRelease(config, layout);
  if (!recovered) return null;
  await writeCurrentRelease(config, layout, recovered.releaseId);
  return recovered;
}

export async function resolvePublishedBaselineRelease(config) {
  const recovered = await recoverPublishedBaseline(config);
  if (!recovered) throw new Error("no published baseline release is available");
  return recovered;
}

export async function publishVerifiedBaselineRelease({
  config,
  releaseId: requestedReleaseId = `release-${randomUUID()}`,
  stagedSystemPath,
  stagedCachePath,
  stagedDomainXmlPath,
  stagedDiagnosticPath,
  profile,
  verified,
  onStage = async () => {},
}) {
  if (verified !== true)
    throw new Error("baseline verification must pass before publication");
  const layout = baselinePublicationLayout(config);
  const id = releaseId(requestedReleaseId);
  const finalPaths = releasePaths(layout, id);
  const stagingDirectory = `${layout.releaseRoot}/.staging-${id}-${process.pid}-${randomUUID()}`;
  const sources = [
    [
      stagedSystemPath,
      RELEASE_ARTIFACTS.system,
      "staged system disk",
      "system-staged",
    ],
    [
      stagedCachePath,
      RELEASE_ARTIFACTS.cache,
      "staged cache disk",
      "cache-staged",
    ],
    [
      stagedDomainXmlPath,
      RELEASE_ARTIFACTS.domainXml,
      "staged domain XML",
      "domain-xml-staged",
    ],
    [
      stagedDiagnosticPath,
      RELEASE_ARTIFACTS.diagnostic,
      "staged diagnostic",
      "diagnostic-staged",
    ],
  ];
  await mkdir(layout.releaseRoot, { recursive: true, mode: 0o700 });
  if (await pathExists(finalPaths.directory)) {
    throw new Error(`baseline release already exists: ${id}`);
  }
  await mkdir(stagingDirectory, { mode: 0o700 });
  await onStage("release-staging-created");
  for (const [source, artifact, label, stage] of sources) {
    await assertRegularFile(source, label);
    if (
      (await stat(dirname(source))).dev !== (await stat(layout.releaseRoot)).dev
    ) {
      throw new Error(
        "staged baseline artifacts must share the release filesystem",
      );
    }
    await fsyncFile(source);
    await rename(source, `${stagingDirectory}/${artifact}`);
    await onStage(stage);
  }
  await writeJsonDurably(
    `${stagingDirectory}/release.json`,
    releaseManifest(config, finalPaths, profile),
  );
  await fsyncDirectory(stagingDirectory);
  await onStage("release-manifest-staged");
  await rename(stagingDirectory, finalPaths.directory);
  await fsyncDirectory(layout.releaseRoot);
  await onStage("release-directory-published");
  const pendingPath = `${layout.currentManifestPath}.pending-${process.pid}-${randomUUID()}`;
  await writeJsonDurably(pendingPath, currentManifest(config, finalPaths));
  await onStage("current-manifest-staged");
  await rename(pendingPath, layout.currentManifestPath);
  await fsyncDirectory(dirname(layout.currentManifestPath));
  await onStage("current-manifest-published");
  return readCompleteRelease(config, layout, id);
}

export async function assertReadableRegularFile(path, label) {
  const value = absolutePath(path, label);
  await access(value, constants.R_OK);
  const metadata = await stat(value);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  return value;
}

export { hostIdentityMatches, RELEASE_ARTIFACTS, REQUIRED_COMMANDS };
