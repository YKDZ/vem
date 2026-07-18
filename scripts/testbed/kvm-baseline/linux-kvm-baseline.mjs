import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
  access,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
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
  "Xvfb",
  "gvncviewer",
];

const RELEASE_MANIFEST_SCHEMA = "win10-kvm-baseline-release/v1";
const CURRENT_MANIFEST_SCHEMA = "win10-kvm-baseline-current/v1";
export const VNC_ACTIVATOR_METADATA_FILE = ".vnc-activator.json";
const VNC_ACTIVATOR_METADATA_SCHEMA = "win10-kvm-vnc-activator/v1";
const VNC_LAUNCH_SUPERVISOR_READY =
  "VEM_VNC_LAUNCH_SUPERVISOR_READY/v1";
const VNC_LAUNCH_SUPERVISOR_SOURCE = String.raw`
import { spawn } from "node:child_process";

const module = await import(process.env.VEM_VNC_SUPERVISOR_MODULE);
const registration = JSON.parse(
  Buffer.from(
    process.env.VEM_VNC_SUPERVISOR_REGISTRATION,
    "base64",
  ).toString("utf8"),
);
const target = JSON.parse(
  Buffer.from(process.env.VEM_VNC_SUPERVISOR_TARGET, "base64").toString(
    "utf8",
  ),
);
const terminationGraceMs = Number(process.env.VEM_VNC_SUPERVISOR_GRACE_MS);
await module.publishVncActivatorSupervisorIdentity({
  ...registration,
  pid: process.pid,
});
process.stdout.on("error", (error) => {
  if (error.code !== "EPIPE") throw error;
});
process.stdout.write("VEM_VNC_LAUNCH_SUPERVISOR_READY/v1\n");

let input = "";
let targetChild = null;
let stopping = false;
const keepAlive = setInterval(() => {}, 1_000);
const startRequested = new Promise((resolveStart) => {
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (input.split(/\r?\n/, 1)[0] === "start") resolveStart();
  });
});

const stop = async () => {
  if (stopping) return;
  stopping = true;
  if (!targetChild) process.exit(0);
  const targetExit = new Promise((resolveExit) =>
    targetChild.once("exit", resolveExit),
  );
  if (targetChild.exitCode === null && targetChild.signalCode === null) {
    targetChild.kill("SIGTERM");
  }
  const killTimer = setTimeout(() => {
    if (targetChild.exitCode === null && targetChild.signalCode === null) {
      targetChild.kill("SIGKILL");
    }
  }, terminationGraceMs);
  await targetExit;
  clearTimeout(killTimer);
  process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());

await startRequested;
clearInterval(keepAlive);
const targetEnvironment = { ...process.env };
for (const key of Object.keys(targetEnvironment)) {
  if (key.startsWith("VEM_VNC_SUPERVISOR_")) delete targetEnvironment[key];
}
targetChild = spawn(target.command, target.arguments, {
  env: targetEnvironment,
  stdio: ["ignore", "inherit", "inherit"],
});
targetChild.once("error", () => process.exit(1));
targetChild.once("exit", (code, signal) => {
  if (!stopping) process.exit(code ?? (signal ? 1 : 0));
});
`;
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
  "publication-journal-prepared",
  "cache-release-directory-renamed",
  "cache-release-directory-published",
  "system-release-directory-renamed",
  "system-release-directory-published",
  "definition-intent-staged",
  "libvirt-definition-mutated",
  "libvirt-definition-committed",
  "current-manifest-staged",
  "current-manifest-renamed",
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

function absoluteWindowsPath(value, label) {
  const path = string(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path;
}

function commandArray(value, label) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((part) => typeof part !== "string" || part.trim() === "")
  ) {
    throw new Error(`${label} must be a non-empty command array`);
  }
  absolutePath(value[0], `${label}[0]`);
  return value;
}

function hostnameOrAddress(value, label) {
  const result = string(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/.test(result)) {
    throw new Error(`${label} must be a hostname or IP address`);
  }
  return result;
}

function pathInside(path, root) {
  if (root === "/") return path.startsWith("/") && path !== "/";
  return path.startsWith(`${root}/`);
}

function sha256(value, label) {
  const result = string(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return result;
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
  const virtioWinIsoPath = absolutePath(
    media.virtioWinIsoPath,
    "media.virtioWinIsoPath",
  );
  if (!pathInside(virtioWinIsoPath, largeFileRoot)) {
    throw new Error(
      "media.virtioWinIsoPath must stay under host.largeFileRoot",
    );
  }
  integer(media.windowsImageIndex, "media.windowsImageIndex");
  const webView2InstallerUri = string(
    media.webView2InstallerUri,
    "media.webView2InstallerUri",
  );
  if (!/^https:\/\//.test(webView2InstallerUri)) {
    throw new Error("media.webView2InstallerUri must use HTTPS");
  }
  const runnerArchivePath = absolutePath(
    media.runnerArchivePath,
    "media.runnerArchivePath",
  );
  if (!pathInside(runnerArchivePath, largeFileRoot)) {
    throw new Error(
      "media.runnerArchivePath must stay under host.largeFileRoot",
    );
  }
  sha256(media.runnerArchiveSha256, "media.runnerArchiveSha256");
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
  if (
    !Array.isArray(runner.labels) ||
    runner.labels.length === 0 ||
    runner.labels.some(
      (label) =>
        typeof label !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(label),
    )
  ) {
    throw new Error(
      "runner.labels must be a non-empty array of GitHub runner labels",
    );
  }
  const testbed = object(config.testbed, "testbed");
  commandArray(testbed.reconstructCommand, "testbed.reconstructCommand");
  commandArray(testbed.admitRunnerCommand, "testbed.admitRunnerCommand");
  const testbedGuest = object(testbed.guest, "testbed.guest");
  hostnameOrAddress(testbedGuest.host, "testbed.guest.host");
  string(testbedGuest.user, "testbed.guest.user");
  absolutePath(testbedGuest.identityFile, "testbed.guest.identityFile");
  absolutePath(testbedGuest.knownHostsFile, "testbed.guest.knownHostsFile");
  absoluteWindowsPath(testbedGuest.stagingPath, "testbed.guest.stagingPath");
  absoluteWindowsPath(testbedGuest.cacheRoot, "testbed.guest.cacheRoot");
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
  const cacheDiskPath = config.storage.cacheDiskPath;
  return {
    // Keep this alias while callers move to the explicit system/cache roots.
    releaseRoot: `${baselinePath}.releases`,
    systemReleaseRoot: `${baselinePath}.releases`,
    cacheReleaseRoot: `${cacheDiskPath}.releases`,
    currentManifestPath: `${baselinePath}.current.json`,
    publicationJournalPath: `${baselinePath}.publication-intent.json`,
    previousReleasePath: `${baselinePath}.previous-release.json`,
  };
}

export function runtimeProfileForPublishedRelease(config, id) {
  const layout = baselinePublicationLayout(config);
  const directory = resolve(layout.releaseRoot, releaseId(id));
  return createRuntimeProfile({
    vmName: config.vm.name,
    systemDiskPath: `${directory}/${RELEASE_ARTIFACTS.system}`,
    cacheDiskPath: `${resolve(
      layout.cacheReleaseRoot,
      releaseId(id),
    )}/${RELEASE_ARTIFACTS.cache}`,
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
  if (observed.installationMedia?.virtioWinIso !== true) {
    throw new Error(
      "VirtIO Windows driver media must be a readable regular file",
    );
  }
  if (observed.installationMedia?.runnerArchive !== true) {
    throw new Error(
      "runner archive must be a readable regular file with the configured SHA-256",
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

export function parseLibvirtVncDisplay(value) {
  const display = string(value, "libvirt VNC display").trim();
  const match = /^(?:(127\.0\.0\.1|localhost))?:(\d+)$/.exec(display);
  if (!match) {
    throw new Error("libvirt VNC display must use a loopback listener");
  }
  return `127.0.0.1:${match[2]}`;
}

function firstLine(stream, timeoutMs) {
  return new Promise((resolveLine, rejectLine) => {
    let output = "";
    const timeout = setTimeout(() => {
      cleanup();
      rejectLine(new Error("Xvfb did not allocate a display before timeout"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
    };
    const onData = (chunk) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline === -1) return;
      cleanup();
      resolveLine(output.slice(0, newline).trim());
    };
    const onEnd = () => {
      cleanup();
      rejectLine(new Error("Xvfb exited before allocating a display"));
    };
    const onError = (error) => {
      cleanup();
      rejectLine(error);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function settlesWithin(promise, timeoutMs) {
  return new Promise((resolveWait) => {
    const timeout = setTimeout(() => resolveWait(false), timeoutMs);
    void promise.then(
      () => {
        clearTimeout(timeout);
        resolveWait(true);
      },
      () => {
        clearTimeout(timeout);
        resolveWait(true);
      },
    );
  });
}

function processStartTime(statValue) {
  const closingName = statValue.lastIndexOf(")");
  if (closingName < 0) throw new Error("Linux process stat is malformed");
  const fields = statValue.slice(closingName + 2).trim().split(/\s+/);
  const startTimeTicks = fields[19];
  if (!/^\d+$/.test(startTimeTicks ?? "")) {
    throw new Error("Linux process start time is unavailable");
  }
  return startTimeTicks;
}

export async function readLinuxProcessIdentity(pid) {
  if (!Number.isInteger(pid) || pid < 1) {
    throw new Error("process PID must be a positive integer");
  }
  const procRoot = `/proc/${pid}`;
  const [statValue, executable, commandLine] = await Promise.all([
    readFile(`${procRoot}/stat`, "utf8"),
    readlink(`${procRoot}/exe`),
    readFile(`${procRoot}/cmdline`),
  ]);
  return {
    pid,
    startTimeTicks: processStartTime(statValue),
    executable,
    commandLineSha256: createHash("sha256").update(commandLine).digest("hex"),
  };
}

function processIdentityShape(identity) {
  return (
    identity &&
    Number.isInteger(identity.pid) &&
    identity.pid > 0 &&
    /^\d+$/.test(identity.startTimeTicks ?? "") &&
    typeof identity.executable === "string" &&
    isAbsolute(identity.executable) &&
    /^[0-9a-f]{64}$/.test(identity.commandLineSha256 ?? "")
  );
}

async function processIdentityMatches(identity) {
  if (!processIdentityShape(identity)) return false;
  try {
    const observed = await readLinuxProcessIdentity(identity.pid);
    return (
      observed.startTimeTicks === identity.startTimeTicks &&
      observed.executable === identity.executable &&
      observed.commandLineSha256 === identity.commandLineSha256
    );
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForProcessIdentityExit(identity, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processIdentityMatches(identity))) return true;
    await delay(25);
  }
  return !(await processIdentityMatches(identity));
}

export async function terminateExactProcessIdentity(
  identity,
  { killTimeoutMs = 2_000, termTimeoutMs = 2_000 } = {},
) {
  if (!(await processIdentityMatches(identity))) return false;
  try {
    process.kill(identity.pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
  if (await waitForProcessIdentityExit(identity, termTimeoutMs)) return true;
  if (!(await processIdentityMatches(identity))) return true;
  try {
    process.kill(identity.pid, "SIGKILL");
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
  if (!(await waitForProcessIdentityExit(identity, killTimeoutMs))) {
    throw new Error(`process ${identity.pid} survived SIGKILL`);
  }
  return true;
}

function ownerMatches(observed, expected) {
  return (
    observed &&
    typeof observed === "object" &&
    !Array.isArray(observed) &&
    Object.keys(observed).length === Object.keys(expected).length &&
    Object.keys(expected).every((key) => observed[key] === expected[key])
  );
}

async function removeActivatorMetadata(metadataPath) {
  await rm(metadataPath, { force: true });
  await fsyncDirectory(dirname(metadataPath));
}

export async function recoverHeadlessVncActivator({
  metadataPath,
  owner,
  termination = {},
}) {
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { present: false, recovered: true };
    return { present: true, recovered: false };
  }
  if (
    metadata.schemaVersion !== VNC_ACTIVATOR_METADATA_SCHEMA ||
    !ownerMatches(metadata.owner, owner) ||
    !metadata.processes ||
    Object.keys(metadata.processes).some(
      (role) => !["xvfb", "viewer"].includes(role),
    ) ||
    Object.values(metadata.processes).some(
      (identity) => !processIdentityShape(identity),
    )
  ) {
    return { present: true, recovered: false };
  }
  for (const role of ["viewer", "xvfb"]) {
    const identity = metadata.processes[role];
    if (identity) await terminateExactProcessIdentity(identity, termination);
  }
  await removeActivatorMetadata(metadataPath);
  return { present: true, recovered: true };
}

export async function publishVncActivatorSupervisorIdentity({
  metadataPath,
  owner,
  pid,
  role,
}) {
  if (!["xvfb", "viewer"].includes(role)) {
    throw new Error("VNC activator supervisor role is invalid");
  }
  const expectedMetadataPath = resolve(
    string(owner?.systemStagingPath, "owner.systemStagingPath"),
    VNC_ACTIVATOR_METADATA_FILE,
  );
  if (absolutePath(metadataPath, "metadataPath") !== expectedMetadataPath) {
    throw new Error("VNC activator metadata must use its owned staging path");
  }
  let metadata = {
    schemaVersion: VNC_ACTIVATOR_METADATA_SCHEMA,
    owner,
    processes: {},
  };
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (
    metadata.schemaVersion !== VNC_ACTIVATOR_METADATA_SCHEMA ||
    !ownerMatches(metadata.owner, owner) ||
    !metadata.processes ||
    Object.keys(metadata.processes).some(
      (observedRole) => !["xvfb", "viewer"].includes(observedRole),
    ) ||
    Object.values(metadata.processes).some(
      (identity) => !processIdentityShape(identity),
    ) ||
    metadata.processes[role]
  ) {
    throw new Error("VNC activator metadata cannot register this supervisor");
  }
  const identity = await readLinuxProcessIdentity(pid);
  await writeJsonAtomicallyDurably(metadataPath, {
    ...metadata,
    processes: { ...metadata.processes, [role]: identity },
  });
  return identity;
}

function encodedSupervisorValue(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

async function registeredSupervisorIdentity(handle, metadataPath, role) {
  const ready = await firstLine(handle.child.stdout, 10_000);
  if (ready !== VNC_LAUNCH_SUPERVISOR_READY) {
    throw new Error(`${role} launch supervisor did not register durably`);
  }
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const identity = metadata.processes?.[role];
  if (
    !processIdentityShape(identity) ||
    identity.pid !== handle.child.pid ||
    !(await processIdentityMatches(identity))
  ) {
    throw new Error(`${role} launch supervisor identity is invalid`);
  }
  return identity;
}

function releaseSupervisor(handle, timeoutMs = 2_000) {
  return new Promise((resolveRelease, rejectRelease) => {
    const timeout = setTimeout(
      () => rejectRelease(new Error("VNC launch supervisor release timed out")),
      timeoutMs,
    );
    handle.child.stdin.write("start\n", (error) => {
      clearTimeout(timeout);
      if (error) {
        rejectRelease(error);
        return;
      }
      resolveRelease();
    });
  });
}

async function stopProcess(handle, identity, termination) {
  if (!handle) return;
  const childExit = new Promise((resolveExit) => {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
      resolveExit();
      return;
    }
    handle.child.once("exit", resolveExit);
    handle.child.once("error", resolveExit);
  });
  if (identity) {
    await terminateExactProcessIdentity(identity, termination);
    const exitTimeoutMs = termination.killTimeoutMs ?? 2_000;
    const exited = await settlesWithin(childExit, exitTimeoutMs);
    if (
      !exited &&
      handle.child.exitCode === null &&
      handle.child.signalCode === null
    ) {
      throw new Error(`child ${handle.child.pid} exit was not observed`);
    }
  } else {
    if (handle.child.exitCode === null && handle.child.signalCode === null) {
      handle.child.kill("SIGTERM");
    }
    const termTimeoutMs = termination.termTimeoutMs ?? 2_000;
    const exitedAfterTerm = await settlesWithin(childExit, termTimeoutMs);
    if (
      !exitedAfterTerm &&
      handle.child.exitCode === null &&
      handle.child.signalCode === null
    ) {
      handle.child.kill("SIGKILL");
    }
    const killTimeoutMs = termination.killTimeoutMs ?? 2_000;
    if (!exitedAfterTerm && !(await settlesWithin(childExit, killTimeoutMs))) {
      throw new Error(`child ${handle.child.pid} did not exit after SIGKILL`);
    }
  }
  handle.child.stdin?.destroy();
  handle.child.stdout?.destroy();
  handle.child.stderr?.destroy();
  void handle.completion.catch(() => undefined);
}

export async function startHeadlessVncActivator({
  commands = {},
  domainName,
  environment = process.env,
  libvirtUri,
  metadataPath,
  owner,
  readinessDelayMs = 500,
  runCommand,
  startProcess,
  termination = {},
}) {
  string(domainName, "domainName");
  string(libvirtUri, "libvirtUri");
  if (typeof runCommand !== "function") {
    throw new Error("runCommand must be a function");
  }
  if (typeof startProcess !== "function") {
    throw new Error("startProcess must be a function");
  }
  const expectedMetadataPath = resolve(
    string(owner?.systemStagingPath, "owner.systemStagingPath"),
    VNC_ACTIVATOR_METADATA_FILE,
  );
  if (absolutePath(metadataPath, "metadataPath") !== expectedMetadataPath) {
    throw new Error("VNC activator metadata must use its owned staging path");
  }
  const display = await runCommand("virsh", [
    "--connect",
    libvirtUri,
    "vncdisplay",
    domainName,
  ]);
  const endpoint = parseLibvirtVncDisplay(display.stdout);
  const width = commands.width ?? 1080;
  const height = commands.height ?? 1920;
  const xvfbCommand = commands.xvfb ?? "Xvfb";
  const viewerCommand = commands.viewer ?? "gvncviewer";
  let xvfb;
  let viewer;
  let xvfbIdentity;
  let viewerIdentity;
  let stopping = false;
  let rejectFailure;
  const failure = new Promise((_, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => undefined);
  const monitor = (handle, label) => {
    handle.child.once("exit", () => {
      if (!stopping) {
        rejectFailure(new Error(`${label} exited during VNC activation`));
      }
    });
    handle.child.once("error", (error) => {
      if (!stopping) {
        rejectFailure(
          new Error(`${label} failed during VNC activation: ${error.message}`),
        );
      }
    });
  };
  const startSupervisor = (role, command, arguments_, targetEnvironment) =>
    startProcess(
      process.execPath,
      ["--input-type=module", "--eval", VNC_LAUNCH_SUPERVISOR_SOURCE],
      {
        env: {
          ...targetEnvironment,
          VEM_VNC_SUPERVISOR_GRACE_MS: String(
            Math.max(1, Math.floor((termination.termTimeoutMs ?? 2_000) / 2)),
          ),
          VEM_VNC_SUPERVISOR_MODULE: import.meta.url,
          VEM_VNC_SUPERVISOR_REGISTRATION: encodedSupervisorValue({
            metadataPath,
            owner,
            role,
          }),
          VEM_VNC_SUPERVISOR_TARGET: encodedSupervisorValue({
            command,
            arguments: arguments_,
          }),
        },
      },
    );
  let stopPromise;
  const stop = () => {
    if (!stopPromise) {
      stopping = true;
      stopPromise = (async () => {
        await stopProcess(viewer, viewerIdentity, termination);
        await stopProcess(xvfb, xvfbIdentity, termination);
        await removeActivatorMetadata(metadataPath);
      })();
    }
    return stopPromise;
  };

  try {
    xvfb = startSupervisor(
      "xvfb",
      xvfbCommand,
      [
        ...(commands.xvfbArguments ?? []),
        "-displayfd",
        "1",
        "-screen",
        "0",
        `${width}x${height}x24`,
        "-nolisten",
        "tcp",
      ],
      environment,
    );
    monitor(xvfb, "Xvfb");
    xvfbIdentity = await registeredSupervisorIdentity(
      xvfb,
      metadataPath,
      "xvfb",
    );
    const displayLine = firstLine(xvfb.child.stdout, 10_000);
    await releaseSupervisor(xvfb);
    const displayNumber = await displayLine;
    if (!/^\d+$/.test(displayNumber)) {
      throw new Error("Xvfb returned an invalid display number");
    }
    viewer = startSupervisor(
      "viewer",
      viewerCommand,
      [...(commands.viewerArguments ?? []), endpoint],
      { ...environment, DISPLAY: `:${displayNumber}` },
    );
    monitor(viewer, "gvncviewer");
    viewerIdentity = await registeredSupervisorIdentity(
      viewer,
      metadataPath,
      "viewer",
    );
    await releaseSupervisor(viewer);
    await Promise.race([
      failure,
      new Promise((resolveReady) =>
        setTimeout(resolveReady, readinessDelayMs),
      ),
    ]);
    return {
      endpoint,
      failure,
      runWhileActive: (work) =>
        Promise.race([Promise.resolve().then(work), failure]),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
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

async function writeJsonAtomicallyDurably(path, value) {
  const pendingPath = `${path}.pending-${process.pid}-${randomUUID()}`;
  await writeJsonDurably(pendingPath, value);
  await rename(pendingPath, path);
  await fsyncDirectory(dirname(path));
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
  const normalizedId = releaseId(id);
  const directory = resolve(layout.systemReleaseRoot, normalizedId);
  const cacheDirectory = resolve(layout.cacheReleaseRoot, normalizedId);
  return {
    releaseId: id,
    directory,
    cacheDirectory,
    manifestPath: `${directory}/release.json`,
    systemPath: `${directory}/${RELEASE_ARTIFACTS.system}`,
    cachePath: `${cacheDirectory}/${RELEASE_ARTIFACTS.cache}`,
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
    profile: runtimeProfileForPublishedRelease(config, paths.releaseId),
    testbed: config.testbed,
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
  for (const releaseRoot of [
    layout.systemReleaseRoot,
    layout.cacheReleaseRoot,
  ]) {
    let releaseEntries = [];
    try {
      releaseEntries = await readdir(releaseRoot, { withFileTypes: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await Promise.all(
      releaseEntries
        .filter(
          (entry) => entry.isDirectory() && entry.name.startsWith(".staging-"),
        )
        .map((entry) =>
          rm(`${releaseRoot}/${entry.name}`, {
            recursive: true,
            force: true,
          }),
        ),
    );
  }
  const parent = dirname(layout.currentManifestPath);
  const currentName = basename(layout.currentManifestPath);
  const journalName = basename(layout.publicationJournalPath);
  const parentEntries = await readdir(parent, { withFileTypes: true });
  await Promise.all(
    parentEntries
      .filter(
        (entry) =>
          entry.name.startsWith(`${currentName}.pending-`) ||
          entry.name.startsWith(`${journalName}.pending-`),
      )
      .map((entry) => rm(`${parent}/${entry.name}`, { force: true })),
  );
}

async function writeCurrentRelease(
  config,
  layout,
  id,
  { onStaged, onRenamed, syncDirectory = fsyncDirectory } = {},
) {
  const paths = releasePaths(layout, id);
  const pendingPath = `${layout.currentManifestPath}.pending-${process.pid}-${randomUUID()}`;
  await writeJsonDurably(pendingPath, currentManifest(config, paths));
  if (onStaged) await onStaged();
  await rename(pendingPath, layout.currentManifestPath);
  if (onRenamed) await onRenamed();
  await syncDirectory(dirname(layout.currentManifestPath));
}

const PUBLICATION_JOURNAL_SCHEMA = "win10-kvm-baseline-publication-journal/v2";
const PREVIOUS_RELEASE_SCHEMA = "win10-kvm-baseline-previous-release/v1";
const PUBLICATION_JOURNAL_PHASES = new Set([
  "prepared",
  "cache-release-directory-published",
  "system-release-directory-published",
  "definition-intent-staged",
  "libvirt-definition-committed",
  "current-manifest-staged",
  "current-manifest-published",
]);
function publicationJournal(previousRelease, nextRelease, phase) {
  return {
    schemaVersion: PUBLICATION_JOURNAL_SCHEMA,
    previousReleaseId: previousRelease?.releaseId ?? null,
    releaseId: nextRelease.releaseId,
    phase,
  };
}

function previousReleasePointer(previousRelease, nextRelease) {
  return {
    schemaVersion: PREVIOUS_RELEASE_SCHEMA,
    previousReleaseId: previousRelease.releaseId,
    releaseId: nextRelease.releaseId,
  };
}

function validPreviousReleasePointer(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.schemaVersion !== PREVIOUS_RELEASE_SCHEMA ||
    typeof value.previousReleaseId !== "string" ||
    typeof value.releaseId !== "string"
  ) {
    return false;
  }
  try {
    releaseId(value.previousReleaseId);
    releaseId(value.releaseId);
    return true;
  } catch {
    return false;
  }
}

function validPublicationJournal(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.schemaVersion !== PUBLICATION_JOURNAL_SCHEMA ||
    (value.previousReleaseId !== null &&
      typeof value.previousReleaseId !== "string") ||
    typeof value.releaseId !== "string" ||
    !PUBLICATION_JOURNAL_PHASES.has(value.phase)
  ) {
    return false;
  }
  try {
    releaseId(value.releaseId);
    if (value.previousReleaseId !== null) releaseId(value.previousReleaseId);
    return true;
  } catch {
    return false;
  }
}

async function readPublicationJournal(layout) {
  try {
    const journal = JSON.parse(
      await readFile(layout.publicationJournalPath, "utf8"),
    );
    if (validPublicationJournal(journal)) return { kind: "valid", journal };

    // Release v1 wrote the same intent immediately before a definition commit.
    // Treat it as the equivalent v2 phase rather than publishing an unknown
    // release before its libvirt definition has been recovered and verified.
    if (
      journal?.schemaVersion === "win10-kvm-baseline-publication-intent/v1" &&
      (journal.previousReleaseId === null ||
        typeof journal.previousReleaseId === "string") &&
      typeof journal.releaseId === "string"
    ) {
      return {
        kind: "valid",
        journal: {
          ...journal,
          schemaVersion: PUBLICATION_JOURNAL_SCHEMA,
          phase: "definition-intent-staged",
        },
      };
    }
    return { kind: "invalid" };
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "absent" };
    return { kind: "invalid" };
  }
}

async function writePublicationJournal(layout, journal) {
  if (!validPublicationJournal(journal)) {
    throw new Error("baseline publication journal is invalid");
  }
  await writeJsonAtomicallyDurably(layout.publicationJournalPath, journal);
}

async function removePublicationJournal(layout) {
  await rm(layout.publicationJournalPath, { force: true });
  await fsyncDirectory(dirname(layout.publicationJournalPath));
}

async function writePreviousReleasePointer(
  layout,
  previousRelease,
  nextRelease,
) {
  if (!previousRelease) {
    await removePreviousReleasePointer(layout);
    return;
  }
  await writeJsonAtomicallyDurably(
    layout.previousReleasePath,
    previousReleasePointer(previousRelease, nextRelease),
  );
}

async function readPreviousReleasePointer(layout) {
  try {
    const pointer = JSON.parse(
      await readFile(layout.previousReleasePath, "utf8"),
    );
    return validPreviousReleasePointer(pointer) ? pointer : null;
  } catch {
    return null;
  }
}

async function removePreviousReleasePointer(layout) {
  await rm(layout.previousReleasePath, { force: true });
  await fsyncDirectory(dirname(layout.previousReleasePath));
}

async function removeRelease(layout, id) {
  const paths = releasePaths(layout, id);
  await Promise.all([
    rm(paths.directory, { recursive: true, force: true }),
    rm(paths.cacheDirectory, { recursive: true, force: true }),
  ]);
  await Promise.all([
    fsyncDirectory(layout.systemReleaseRoot),
    fsyncDirectory(layout.cacheReleaseRoot),
  ]);
}

async function releaseDirectoryIds(layout) {
  const entriesFor = async (root) => {
    try {
      return await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  const [systemEntries, cacheEntries] = await Promise.all([
    entriesFor(layout.systemReleaseRoot),
    entriesFor(layout.cacheReleaseRoot),
  ]);
  const ids = new Set();
  for (const entry of [...systemEntries, ...cacheEntries]) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      ids.add(releaseId(entry.name));
    } catch {
      // Release directories are created only from validated identifiers. Leave
      // unrelated operator files outside this publisher's ownership boundary.
    }
  }
  return ids;
}

async function cleanupUnselectedReleaseSidecars(config, layout, selectedId) {
  const ids = await releaseDirectoryIds(layout);
  for (const id of ids) {
    if (id !== selectedId) await removeRelease(layout, id);
  }
}

async function readCurrentReleaseOrNull(config, layout) {
  try {
    return await readCurrentRelease(config, layout);
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
    if (
      /^(published baseline (current|release) manifest|published (system|cache|domain XML|diagnostic)|releaseId must)/.test(
        error.message,
      )
    ) {
      return null;
    }
    throw error;
  }
}

async function removeInvalidCurrentManifest(layout) {
  await rm(layout.currentManifestPath, { force: true });
  await fsyncDirectory(dirname(layout.currentManifestPath));
}

async function readCompleteReleaseOrNull(config, layout, id) {
  try {
    return await readCompleteRelease(config, layout, id);
  } catch {
    return null;
  }
}

function requireDefinitionRecovery({ recoverDefinition, rollbackDefinition }) {
  if (typeof recoverDefinition !== "function") {
    throw new Error(
      "incomplete baseline publication recovery requires a libvirt definition verifier",
    );
  }
  if (typeof rollbackDefinition !== "function") {
    throw new Error(
      "incomplete baseline publication recovery requires a libvirt definition rollback",
    );
  }
}

async function finalizeRecoveredRelease({
  config,
  layout,
  current,
  selected,
  removeJournal,
}) {
  if (!current || current.releaseId !== selected.releaseId) {
    await writeCurrentRelease(config, layout, selected.releaseId);
  }
  await cleanupUnselectedReleaseSidecars(config, layout, selected.releaseId);
  if (removeJournal) await removePublicationJournal(layout);
  await removePreviousReleasePointer(layout);
  return selected;
}

// Current remains authoritative after publication. During an incomplete
// replacement, the durable previous pointer proves the sole rollback target
// even when the journal itself is unreadable.
export async function recoverPublishedBaseline(
  config,
  { recoverDefinition, rollbackDefinition } = {},
) {
  const layout = baselinePublicationLayout(config);
  await mkdir(layout.systemReleaseRoot, { recursive: true, mode: 0o700 });
  await mkdir(layout.cacheReleaseRoot, { recursive: true, mode: 0o700 });
  await removeInterruptedPublicationFiles(layout);
  const journalState = await readPublicationJournal(layout);
  const current = await readCurrentReleaseOrNull(config, layout);
  const hasCurrentManifest = await pathExists(layout.currentManifestPath);
  const previousPointer = await readPreviousReleasePointer(layout);
  const pointerPrevious = previousPointer
    ? await readCompleteReleaseOrNull(
        config,
        layout,
        previousPointer.previousReleaseId,
      )
    : null;

  if (journalState.kind === "absent") {
    if (current) {
      if (typeof recoverDefinition === "function") {
        requireDefinitionRecovery({ recoverDefinition, rollbackDefinition });
        await recoverDefinition(current, null);
      }
      return finalizeRecoveredRelease({
        config,
        layout,
        current,
        selected: current,
        removeJournal: false,
      });
    }

    if (pointerPrevious) {
      requireDefinitionRecovery({ recoverDefinition, rollbackDefinition });
      await recoverDefinition(pointerPrevious, null);
      return finalizeRecoveredRelease({
        config,
        layout,
        current,
        selected: pointerPrevious,
        removeJournal: false,
      });
    }

    if (hasCurrentManifest || (await releaseDirectoryIds(layout)).size > 0) {
      throw new Error(
        "incomplete baseline publication has no verifiable selected release",
      );
    }
    await cleanupUnselectedReleaseSidecars(config, layout, null);
    await removePreviousReleasePointer(layout);
    return null;
  }

  requireDefinitionRecovery({ recoverDefinition, rollbackDefinition });
  if (journalState.kind === "invalid") {
    if (!current && !pointerPrevious) {
      throw new Error(
        "incomplete baseline publication has no verifiable selected release",
      );
    }

    const selected = current ?? pointerPrevious;
    const fallback =
      current &&
      pointerPrevious &&
      previousPointer.releaseId === current.releaseId &&
      pointerPrevious.releaseId !== current.releaseId
        ? pointerPrevious
        : null;
    try {
      await recoverDefinition(selected, null);
    } catch (error) {
      if (!fallback) throw error;
      try {
        await rollbackDefinition(fallback);
      } catch {
        throw error;
      }
      await finalizeRecoveredRelease({
        config,
        layout,
        current,
        selected: fallback,
        removeJournal: true,
      });
      throw error;
    }

    return finalizeRecoveredRelease({
      config,
      layout,
      current,
      selected,
      removeJournal: true,
    });
  }

  const journal = journalState.kind === "valid" ? journalState.journal : null;
  const candidate = journal
    ? await readCompleteReleaseOrNull(config, layout, journal.releaseId)
    : null;
  const previous =
    journal?.previousReleaseId === null || !journal
      ? null
      : await readCompleteReleaseOrNull(
          config,
          layout,
          journal.previousReleaseId,
        );
  const selected = current ?? previous ?? candidate;
  const canDiscardAll =
    !current &&
    !previous &&
    !hasCurrentManifest &&
    journal.previousReleaseId === null;

  if (!selected) {
    if (!canDiscardAll) {
      throw new Error(
        "incomplete baseline publication has no verifiable selected release",
      );
    }
    await rollbackDefinition(null);
    if (hasCurrentManifest) await removeInvalidCurrentManifest(layout);
    await cleanupUnselectedReleaseSidecars(config, layout, null);
    await removePublicationJournal(layout);
    await removePreviousReleasePointer(layout);
    return null;
  }

  const fallback = selected.releaseId === journal.releaseId ? previous : null;
  try {
    await recoverDefinition(selected, journal);
  } catch (error) {
    if (fallback) {
      try {
        await rollbackDefinition(fallback);
      } catch {
        throw error;
      }
      await finalizeRecoveredRelease({
        config,
        layout,
        current,
        selected: fallback,
        removeJournal: true,
      });
    } else if (canDiscardAll) {
      await rollbackDefinition(null);
      if (hasCurrentManifest) await removeInvalidCurrentManifest(layout);
      await cleanupUnselectedReleaseSidecars(config, layout, null);
      await removePublicationJournal(layout);
      await removePreviousReleasePointer(layout);
    }
    throw error;
  }

  return finalizeRecoveredRelease({
    config,
    layout,
    current,
    selected,
    removeJournal: true,
  });
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
  commitDefinition,
  rollbackDefinition,
  onStage = async () => {},
  syncCurrentManifestDirectory = fsyncDirectory,
}) {
  if (verified !== true)
    throw new Error("baseline verification must pass before publication");
  if (typeof commitDefinition !== "function") {
    throw new Error(
      "baseline publication requires a final libvirt definition commit",
    );
  }
  if (typeof rollbackDefinition !== "function") {
    throw new Error(
      "baseline publication requires a libvirt definition rollback",
    );
  }
  const layout = baselinePublicationLayout(config);
  const id = releaseId(requestedReleaseId);
  const finalPaths = releasePaths(layout, id);
  const stagingSuffix = `${id}-${process.pid}-${randomUUID()}`;
  const systemStagingDirectory = `${layout.systemReleaseRoot}/.staging-${stagingSuffix}`;
  const cacheStagingDirectory = `${layout.cacheReleaseRoot}/.staging-${stagingSuffix}`;
  const sources = [
    [
      stagedSystemPath,
      RELEASE_ARTIFACTS.system,
      "staged system disk",
      "system-staged",
      systemStagingDirectory,
      layout.systemReleaseRoot,
      "system",
    ],
    [
      stagedCachePath,
      RELEASE_ARTIFACTS.cache,
      "staged cache disk",
      "cache-staged",
      cacheStagingDirectory,
      layout.cacheReleaseRoot,
      "cache",
    ],
    [
      stagedDomainXmlPath,
      RELEASE_ARTIFACTS.domainXml,
      "staged domain XML",
      "domain-xml-staged",
      systemStagingDirectory,
      layout.systemReleaseRoot,
      "system",
    ],
    [
      stagedDiagnosticPath,
      RELEASE_ARTIFACTS.diagnostic,
      "staged diagnostic",
      "diagnostic-staged",
      systemStagingDirectory,
      layout.systemReleaseRoot,
      "system",
    ],
  ];
  await mkdir(layout.systemReleaseRoot, { recursive: true, mode: 0o700 });
  await mkdir(layout.cacheReleaseRoot, { recursive: true, mode: 0o700 });
  if (
    (await pathExists(finalPaths.directory)) ||
    (await pathExists(finalPaths.cacheDirectory))
  ) {
    throw new Error(`baseline release already exists: ${id}`);
  }
  let previousRelease = null;
  try {
    previousRelease = await readCurrentRelease(config, layout);
  } catch (error) {
    if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  await mkdir(systemStagingDirectory, { mode: 0o700 });
  await mkdir(cacheStagingDirectory, { mode: 0o700 });
  await onStage("release-staging-created");
  let definitionAttempted = false;
  let currentManifestRenamed = false;
  let journal = null;
  try {
    for (const [
      source,
      artifact,
      label,
      stage,
      destinationDirectory,
      destinationRoot,
      destinationName,
    ] of sources) {
      await assertRegularFile(source, label);
      if (
        (await stat(dirname(source))).dev !== (await stat(destinationRoot)).dev
      ) {
        throw new Error(
          `staged ${destinationName} artifact must share ${destinationName} publication filesystem`,
        );
      }
      await fsyncFile(source);
      await rename(source, `${destinationDirectory}/${artifact}`);
      await onStage(stage);
    }
    await writeJsonDurably(
      `${systemStagingDirectory}/release.json`,
      releaseManifest(config, finalPaths, profile),
    );
    await fsyncDirectory(systemStagingDirectory);
    await fsyncDirectory(cacheStagingDirectory);
    await onStage("release-manifest-staged");
    journal = publicationJournal(previousRelease, finalPaths, "prepared");
    await writePublicationJournal(layout, journal);
    await writePreviousReleasePointer(layout, previousRelease, finalPaths);
    await onStage("publication-journal-prepared");
    await rename(cacheStagingDirectory, finalPaths.cacheDirectory);
    await fsyncDirectory(layout.cacheReleaseRoot);
    await onStage("cache-release-directory-renamed");
    journal = { ...journal, phase: "cache-release-directory-published" };
    await writePublicationJournal(layout, journal);
    await onStage("cache-release-directory-published");
    await rename(systemStagingDirectory, finalPaths.directory);
    await fsyncDirectory(layout.systemReleaseRoot);
    await onStage("system-release-directory-renamed");
    journal = { ...journal, phase: "system-release-directory-published" };
    await writePublicationJournal(layout, journal);
    await onStage("system-release-directory-published");
    journal = { ...journal, phase: "definition-intent-staged" };
    await writePublicationJournal(layout, journal);
    await onStage("definition-intent-staged");
    definitionAttempted = true;
    await commitDefinition(finalPaths);
    await onStage("libvirt-definition-mutated");
    journal = { ...journal, phase: "libvirt-definition-committed" };
    await writePublicationJournal(layout, journal);
    await onStage("libvirt-definition-committed");
    await writeCurrentRelease(config, layout, id, {
      onStaged: async () => onStage("current-manifest-staged"),
      onRenamed: async () => {
        currentManifestRenamed = true;
        await onStage("current-manifest-renamed");
      },
      syncDirectory: syncCurrentManifestDirectory,
    });
    journal = { ...journal, phase: "current-manifest-published" };
    await writePublicationJournal(layout, journal);
    await cleanupUnselectedReleaseSidecars(config, layout, id);
    await removePublicationJournal(layout);
    await removePreviousReleasePointer(layout);
    await onStage("current-manifest-published");
    return readCompleteRelease(config, layout, id);
  } catch (error) {
    if (!currentManifestRenamed && definitionAttempted) {
      await rollbackDefinition(previousRelease);
      await removeRelease(layout, id);
      await rm(systemStagingDirectory, { recursive: true, force: true });
      await rm(cacheStagingDirectory, { recursive: true, force: true });
      await removePublicationJournal(layout);
      await removePreviousReleasePointer(layout);
    } else if (!currentManifestRenamed) {
      await removeRelease(layout, id);
      await rm(systemStagingDirectory, { recursive: true, force: true });
      await rm(cacheStagingDirectory, { recursive: true, force: true });
      if (journal) await removePublicationJournal(layout);
      await removePreviousReleasePointer(layout);
    }
    throw error;
  }
}

export async function assertReadableRegularFile(path, label) {
  const value = absolutePath(path, label);
  await access(value, constants.R_OK);
  const metadata = await stat(value);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  return value;
}

export async function assertFileSha256(path, expectedHash, label) {
  const value = await assertReadableRegularFile(path, label);
  const expected = sha256(expectedHash, `${label} SHA-256`);
  const actual = await new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(value);
    stream.on("error", rejectHash);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 does not match the configured digest`);
  }
  return value;
}

export { hostIdentityMatches, RELEASE_ARTIFACTS, REQUIRED_COMMANDS };
