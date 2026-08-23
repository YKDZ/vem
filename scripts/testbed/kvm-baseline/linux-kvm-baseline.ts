import { createHash, randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
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
import type { Readable } from "node:stream";

import { createRuntimeProfile } from "./libvirt-runtime-profile.ts";

const GiB = 1024 ** 3;

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const REQUIRED_COMMANDS = [
  "virsh",
  "virt-install",
  "qemu-img",
  "xorriso",
  "ssh",
  "scp",
  "flock",
  "Xvfb",
  "openbox",
  "xtigervncviewer",
  "setpriv",
  "socat",
];

const RELEASE_MANIFEST_SCHEMA = "win10-kvm-baseline-release/v1";
const CURRENT_MANIFEST_SCHEMA = "win10-kvm-baseline-current/v1";
export const VNC_ACTIVATOR_METADATA_FILE = ".vnc-activator.json";
const VNC_ACTIVATOR_METADATA_SCHEMA = "win10-kvm-vnc-activator/v3";
const VNC_ACTIVATOR_LEGACY_SCHEMAS = new Set([
  "win10-kvm-vnc-activator/v1",
  "win10-kvm-vnc-activator/v2",
]);
const VNC_ACTIVATOR_ROLES = Object.freeze(["xvfb", "window-manager", "viewer"]);
const VNC_LAUNCH_SUPERVISOR_READY = "VEM_VNC_LAUNCH_SUPERVISOR_READY/v1";
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
targetChild = spawn(
  "setpriv",
  ["--pdeathsig", "SIGKILL", "--", target.command, ...target.arguments],
  {
  env: targetEnvironment,
  stdio: ["ignore", "inherit", "inherit"],
  },
);
const targetRegistrationDelayMs = Number(
  process.env.VEM_VNC_SUPERVISOR_TARGET_REGISTRATION_DELAY_MS ?? "0",
);
if (
  Number.isFinite(targetRegistrationDelayMs) &&
  targetRegistrationDelayMs > 0
) {
  await new Promise((resolveDelay) =>
    setTimeout(resolveDelay, targetRegistrationDelayMs),
  );
}
await module.publishVncActivatorTargetIdentity({
  ...registration,
  pid: targetChild.pid,
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

export interface BaselineBuildConfig {
  schemaVersion?: unknown;
  host: {
    address: unknown;
    libvirtUri: unknown;
    lockPath: unknown;
    largeFileRoot: unknown;
  };
  vm: { name: unknown; networkName: unknown; macAddress: unknown };
  storage: {
    baselinePath: unknown;
    cacheDiskPath: unknown;
    systemDiskGiB: unknown;
    cacheDiskGiB: unknown;
    minimumFreeGiB: unknown;
  };
  media: {
    windowsIsoPath: unknown;
    virtioWinIsoPath: unknown;
    windowsImageIndex: unknown;
    webView2InstallerUri: unknown;
    runnerArchivePath: unknown;
    runnerArchiveSha256: unknown;
  };
  guest: {
    administratorPasswordFile: unknown;
    authorizedKeysFile: unknown;
    sshPrivateKeyFile: unknown;
    sshUser: unknown;
    desktopScalePercent: unknown;
  };
  runner: {
    url: unknown;
    registrationTokenProvider: { command: unknown; arguments?: unknown[] };
    name: unknown;
    labels: unknown[];
  };
  testbed: {
    reconstructCommand: unknown;
    admitGuestCommand: unknown;
    guest: {
      host: unknown;
      user: unknown;
      identityFile: unknown;
      knownHostsFile: unknown;
      stagingPath: unknown;
      cacheRoot: unknown;
    };
  };
  runtime?: { vcpus?: unknown; memoryMiB?: unknown };
}

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

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function absolutePath(value: unknown, label: string): string {
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

function absoluteWindowsPath(value: unknown, label: string): string {
  const path = string(value, label);
  if (!/^[A-Za-z]:\\/.test(path) || path.includes("\0")) {
    throw new Error(`${label} must be an absolute Windows path`);
  }
  return path;
}

function commandArray(value: unknown, label: string): string[] {
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

function hostnameOrAddress(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,253}$/.test(result)) {
    throw new Error(`${label} must be a hostname or IP address`);
  }
  return result;
}

function pathInside(path: string, root: string): boolean {
  if (root === "/") return path.startsWith("/") && path !== "/";
  return path.startsWith(`${root}/`);
}

function sha256(value: unknown, label: string): string {
  const result = string(value, label).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest`);
  }
  return result;
}

function releaseId(value: unknown): string {
  const result = string(value, "releaseId");
  if (!/^[a-z0-9][a-z0-9-]{7,127}$/i.test(result)) {
    throw new Error("releaseId must be a portable release identifier");
  }
  return result;
}

function hostIdentityMatches(address: unknown, identity: unknown): boolean {
  const configured = hostnameOrAddress(address, "host.address").toLowerCase();
  const observed = object(identity, "host observation.hostIdentity");
  const hostnameValues = Array.isArray(observed.hostnames)
    ? (observed.hostnames as unknown[])
    : [];
  const addressValues = Array.isArray(observed.addresses)
    ? (observed.addresses as unknown[])
    : [];
  const resolvedAddressValues = Array.isArray(
    observed.resolvedConfiguredAddresses,
  )
    ? (observed.resolvedConfiguredAddresses as unknown[])
    : [];
  const hostnames = new Set(
    hostnameValues.map((value) => String(value).toLowerCase()),
  );
  const addresses = new Set(
    addressValues.map((value) => String(value).toLowerCase()),
  );
  const resolvedAddresses = new Set(
    resolvedAddressValues.map((value) => String(value).toLowerCase()),
  );
  return (
    hostnames.has(configured) ||
    addresses.has(configured) ||
    [...resolvedAddresses].some((value) => addresses.has(value))
  );
}

export function validateBaselineBuildConfig(
  input: unknown,
): BaselineBuildConfig {
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
  if (string(guest.sshUser, "guest.sshUser") !== "VEMKiosk") {
    throw new Error(
      "guest.sshUser must be the production machine user VEMKiosk",
    );
  }
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
  if (!runner.labels.includes("vem-runtime")) {
    throw new Error("runner.labels must include the vem-runtime label");
  }
  const testbed = object(config.testbed, "testbed");
  commandArray(testbed.reconstructCommand, "testbed.reconstructCommand");
  commandArray(testbed.admitGuestCommand, "testbed.admitGuestCommand");
  const testbedGuest = object(testbed.guest, "testbed.guest");
  hostnameOrAddress(testbedGuest.host, "testbed.guest.host");
  string(testbedGuest.user, "testbed.guest.user");
  absolutePath(testbedGuest.identityFile, "testbed.guest.identityFile");
  absolutePath(testbedGuest.knownHostsFile, "testbed.guest.knownHostsFile");
  absoluteWindowsPath(testbedGuest.stagingPath, "testbed.guest.stagingPath");
  absoluteWindowsPath(testbedGuest.cacheRoot, "testbed.guest.cacheRoot");
  return config as unknown as BaselineBuildConfig;
}

export function runtimeProfileForConfig(
  config: BaselineBuildConfig,
): ReturnType<typeof createRuntimeProfile> {
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

export function baselinePublicationLayout(
  config: BaselineBuildConfig,
): Record<string, string> {
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

export function runtimeProfileForPublishedRelease(
  config: BaselineBuildConfig,
  id: unknown,
): ReturnType<typeof createRuntimeProfile> {
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

export function evaluateHostPreflight(
  config: BaselineBuildConfig,
  observed: unknown,
): { ok: true } {
  validateBaselineBuildConfig(config);
  const observation = object(observed, "host observation");
  const profile = runtimeProfileForConfig(config);
  if (!hostIdentityMatches(config.host.address, observation.hostIdentity)) {
    throw new Error(
      "host.address must identify the executing host by hostname or resolved address",
    );
  }
  if (observation.kvmAvailable !== true) throw new Error("KVM is not available");
  if (observation.libvirtAvailable !== true)
    throw new Error("libvirt is not available");
  const commands = new Set(
    Array.isArray(observation.commands) ? observation.commands : [],
  );
  const missing = REQUIRED_COMMANDS.filter((command) => !commands.has(command));
  if (missing.length)
    throw new Error(`missing host tools: ${missing.join(", ")}`);
  if (
    typeof observation.cpuCount !== "number" ||
    !Number.isInteger(observation.cpuCount) ||
    observation.cpuCount < profile.vcpus
  ) {
    throw new Error(`host CPU count must satisfy ${profile.vcpus} vCPUs`);
  }
  if (
    typeof observation.availableMemoryMiB !== "number" ||
    !Number.isInteger(observation.availableMemoryMiB) ||
    observation.availableMemoryMiB < profile.memoryMiB
  ) {
    throw new Error(`host memory must satisfy ${profile.memoryMiB} MiB`);
  }
  const storage = (
    observation.storageAvailableBytes ?? {}
  ) as Record<string, unknown>;
  const filesystemIds = (
    observation.storageFilesystemIds ?? {}
  ) as Record<string, unknown>;
  const requestedDiskBytes: Record<string, number> = {
    baseline: Number(config.storage.systemDiskGiB) * GiB,
    cache: Number(config.storage.cacheDiskGiB) * GiB,
  };
  const filesystems = new Map<
    string,
    { availableBytes: number; requestedBytes: number }
  >();
  for (const storageKind of ["baseline", "cache"]) {
    const availableBytes = storage[storageKind];
    const filesystemId = filesystemIds[storageKind];
    if (
      typeof availableBytes !== "number" ||
      !Number.isFinite(availableBytes) ||
      availableBytes < 0 ||
      typeof filesystemId !== "string" ||
      filesystemId.trim() === ""
    ) {
      throw new Error(
        `host storage observation for ${storageKind} must include free bytes and a filesystem identity`,
      );
    }
    const filesystem = filesystems.get(filesystemId as string) ?? {
      availableBytes,
      requestedBytes: 0,
    };
    filesystem.availableBytes = Math.min(
      filesystem.availableBytes,
      availableBytes,
    );
    filesystem.requestedBytes += requestedDiskBytes[storageKind];
    filesystems.set(filesystemId as string, filesystem);
  }
  for (const [filesystemId, filesystem] of filesystems) {
    const requiredBytes =
      filesystem.requestedBytes + Number(config.storage.minimumFreeGiB) * GiB;
    if (filesystem.availableBytes < requiredBytes) {
      throw new Error(
        `shared storage filesystem ${filesystemId} must provide ${requiredBytes / GiB} GiB free for requested disks plus minimum reserve`,
      );
    }
  }
  const installationMedia = observation.installationMedia as
    | Record<string, unknown>
    | undefined;
  if (installationMedia?.windowsIso !== true) {
    throw new Error(
      "Windows installation media must be a readable regular file",
    );
  }
  if (installationMedia?.virtioWinIso !== true) {
    throw new Error(
      "VirtIO Windows driver media must be a readable regular file",
    );
  }
  if (installationMedia?.runnerArchive !== true) {
    throw new Error(
      "runner archive must be a readable regular file with the configured SHA-256",
    );
  }
  if (observation.networkActive !== true) {
    throw new Error("configured libvirt network is not active");
  }
  return { ok: true };
}

export function parseGuestAddress(
  domifaddrOutput: unknown,
  macAddress: unknown,
): string | null {
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

export function parseLibvirtVncDisplay(value: unknown): string {
  const display = string(value, "libvirt VNC display").trim();
  const match = /^(?:(127\.0\.0\.1|localhost))?:(\d+)$/.exec(display);
  if (!match) {
    throw new Error("libvirt VNC display must use a loopback listener");
  }
  return `127.0.0.1:${match[2]}`;
}

function firstLine(stream: Readable, timeoutMs: number): Promise<string> {
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
    const onData = (chunk: Buffer) => {
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
    const onError = (error: Error) => {
      cleanup();
      rejectLine(error);
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function settlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<boolean> {
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

function processStartTime(statValue: string): string {
  const closingName = statValue.lastIndexOf(")");
  if (closingName < 0) throw new Error("Linux process stat is malformed");
  const fields = statValue
    .slice(closingName + 2)
    .trim()
    .split(/\s+/);
  const startTimeTicks = fields[19];
  if (!/^\d+$/.test(startTimeTicks ?? "")) {
    throw new Error("Linux process start time is unavailable");
  }
  return startTimeTicks;
}

export async function readLinuxProcessIdentity(pid: number): Promise<{
  pid: number;
  startTimeTicks: string;
  executable: string;
  commandLineSha256: string;
}> {
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

function processIdentityShape(identity: unknown): boolean {
  const record = identity as Record<string, unknown> | null | undefined;
  return (
    record !== null &&
    typeof record === "object" &&
    typeof record.pid === "number" &&
    Number.isInteger(record.pid) &&
    record.pid > 0 &&
    /^\d+$/.test(String(record.startTimeTicks ?? "")) &&
    typeof record.executable === "string" &&
    isAbsolute(record.executable) &&
    /^[0-9a-f]{64}$/.test(String(record.commandLineSha256 ?? ""))
  );
}

async function processIdentityMatches(identity: unknown): Promise<boolean> {
  if (!processIdentityShape(identity)) return false;
  const record = identity as {
    pid: number;
    startTimeTicks: string;
    executable: string;
    commandLineSha256: string;
  };
  try {
    const observed = await readLinuxProcessIdentity(record.pid);
    return (
      observed.startTimeTicks === record.startTimeTicks &&
      observed.executable === record.executable &&
      observed.commandLineSha256 === record.commandLineSha256
    );
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") || isNodeErrorCode(error, "ESRCH")) {
      return false;
    }
    throw error;
  }
}

async function waitForProcessIdentityExit(
  identity: unknown,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await processIdentityMatches(identity))) return true;
    await delay(25);
  }
  return !(await processIdentityMatches(identity));
}

export async function terminateExactProcessIdentity(
  identity: unknown,
  {
    killTimeoutMs = 2_000,
    termTimeoutMs = 2_000,
  }: { killTimeoutMs?: number; termTimeoutMs?: number } = {},
): Promise<boolean> {
  if (!(await processIdentityMatches(identity))) return false;
  const record = identity as {
    pid: number;
    startTimeTicks: string;
    executable: string;
    commandLineSha256: string;
  };
  try {
    process.kill(record.pid, "SIGTERM");
  } catch (error) {
    if (isNodeErrorCode(error, "ESRCH")) return false;
    throw error;
  }
  if (await waitForProcessIdentityExit(identity, termTimeoutMs)) return true;
  if (!(await processIdentityMatches(identity))) return true;
  try {
    process.kill(record.pid, "SIGKILL");
  } catch (error) {
    if (isNodeErrorCode(error, "ESRCH")) return true;
    throw error;
  }
  if (!(await waitForProcessIdentityExit(identity, killTimeoutMs))) {
    throw new Error(`process ${record.pid} survived SIGKILL`);
  }
  return true;
}

function ownerMatches(
  observed: unknown,
  expected: Record<string, unknown>,
): boolean {
  const record = observed as Record<string, unknown> | null | undefined;
  return (
    record !== null &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.keys(record).length === Object.keys(expected).length &&
    Object.keys(expected).every((key) => record[key] === expected[key])
  );
}

async function removeActivatorMetadata(metadataPath: string): Promise<void> {
  await rm(metadataPath, { force: true });
  await fsyncDirectory(dirname(metadataPath));
}

export async function recoverHeadlessVncActivator({
  metadataPath,
  owner,
  termination = {},
}: {
  metadataPath: unknown;
  owner: Record<string, unknown>;
  termination?: { killTimeoutMs?: number; termTimeoutMs?: number };
}): Promise<{ present: boolean; recovered: boolean }> {
  let metadata: Record<string, unknown>;
  try {
    metadata = JSON.parse(
      await readFile(absolutePath(metadataPath, "metadataPath"), "utf8"),
    ) as Record<string, unknown>;
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT")) {
      return { present: false, recovered: true };
    }
    return { present: true, recovered: false };
  }
  const legacy = VNC_ACTIVATOR_LEGACY_SCHEMAS.has(
    String(metadata.schemaVersion),
  );
  if (
    (!legacy && metadata.schemaVersion !== VNC_ACTIVATOR_METADATA_SCHEMA) ||
    !ownerMatches(metadata.owner, owner) ||
    !metadata.processes ||
    Object.keys(metadata.processes as Record<string, unknown>).some(
      (role) => !VNC_ACTIVATOR_ROLES.includes(role),
    ) ||
    Object.values(metadata.processes as Record<string, unknown>).some(
      (identity) => !processIdentityShape(identity),
    )
  ) {
    return { present: true, recovered: false };
  }
  if (!legacy) {
    if (
      !metadata.targets ||
      Object.keys(metadata.targets as Record<string, unknown>).some(
        (role) => !VNC_ACTIVATOR_ROLES.includes(role),
      ) ||
      Object.values(metadata.targets as Record<string, unknown>).some(
        (identity) => !processIdentityShape(identity),
      )
    ) {
      return { present: true, recovered: false };
    }
    for (const role of ["viewer", "window-manager", "xvfb"]) {
      const identity = (metadata.targets as Record<string, unknown>)[role];
      if (identity) await terminateExactProcessIdentity(identity, termination);
    }
  }
  for (const role of ["viewer", "window-manager", "xvfb"]) {
    const identity = (metadata.processes as Record<string, unknown>)[role];
    if (identity) await terminateExactProcessIdentity(identity, termination);
  }
  await removeActivatorMetadata(absolutePath(metadataPath, "metadataPath"));
  return { present: true, recovered: true };
}

export async function publishVncActivatorSupervisorIdentity({
  metadataPath,
  owner,
  pid,
  role,
}: {
  metadataPath: unknown;
  owner: Record<string, unknown>;
  pid: unknown;
  role: unknown;
}): Promise<Record<string, unknown>> {
  const normalizedRole = string(role, "role");
  if (!VNC_ACTIVATOR_ROLES.includes(normalizedRole)) {
    throw new Error("VNC activator supervisor role is invalid");
  }
  const expectedMetadataPath = resolve(
    string(owner?.systemStagingPath, "owner.systemStagingPath"),
    VNC_ACTIVATOR_METADATA_FILE,
  );
  if (absolutePath(metadataPath, "metadataPath") !== expectedMetadataPath) {
    throw new Error("VNC activator metadata must use its owned staging path");
  }
  let metadata: Record<string, unknown> = {
    schemaVersion: VNC_ACTIVATOR_METADATA_SCHEMA,
    owner,
    processes: {},
    targets: {},
  };
  try {
    metadata = JSON.parse(
      await readFile(absolutePath(metadataPath, "metadataPath"), "utf8"),
    ) as Record<string, unknown>;
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT")) throw error;
  }
  if (
    metadata.schemaVersion !== VNC_ACTIVATOR_METADATA_SCHEMA ||
    !ownerMatches(metadata.owner, owner) ||
    !metadata.processes ||
    Object.keys(metadata.processes as Record<string, unknown>).some(
      (observedRole) => !VNC_ACTIVATOR_ROLES.includes(observedRole),
    ) ||
    Object.values(metadata.processes as Record<string, unknown>).some(
      (identity) => !processIdentityShape(identity),
    ) ||
    !metadata.targets ||
    Object.keys(metadata.targets as Record<string, unknown>).some(
      (observedRole) => !VNC_ACTIVATOR_ROLES.includes(observedRole),
    ) ||
    Object.values(metadata.targets as Record<string, unknown>).some(
      (identity) => !processIdentityShape(identity),
    ) ||
    (metadata.processes as Record<string, unknown>)[normalizedRole]
  ) {
    throw new Error("VNC activator metadata cannot register this supervisor");
  }
  const identity = await readLinuxProcessIdentity(
    integer(pid, "pid"),
  );
  await writeJsonAtomicallyDurably(absolutePath(metadataPath, "metadataPath"), {
    ...metadata,
    processes: {
      ...(metadata.processes as Record<string, unknown>),
      [normalizedRole]: identity,
    },
  });
  return identity;
}

export async function publishVncActivatorTargetIdentity({
  metadataPath,
  owner,
  pid,
  role,
}: {
  metadataPath: unknown;
  owner: Record<string, unknown>;
  pid: unknown;
  role: unknown;
}): Promise<Record<string, unknown>> {
  const normalizedRole = string(role, "role");
  if (!VNC_ACTIVATOR_ROLES.includes(normalizedRole)) {
    throw new Error("VNC activator target role is invalid");
  }
  const expectedMetadataPath = resolve(
    string(owner?.systemStagingPath, "owner.systemStagingPath"),
    VNC_ACTIVATOR_METADATA_FILE,
  );
  if (absolutePath(metadataPath, "metadataPath") !== expectedMetadataPath) {
    throw new Error("VNC activator metadata must use its owned staging path");
  }
  const metadata = JSON.parse(
    await readFile(absolutePath(metadataPath, "metadataPath"), "utf8"),
  ) as Record<string, unknown>;
  if (
    metadata.schemaVersion !== VNC_ACTIVATOR_METADATA_SCHEMA ||
    !ownerMatches(metadata.owner, owner) ||
    !processIdentityShape(
      (metadata.processes as Record<string, unknown> | undefined)?.[
        normalizedRole
      ],
    ) ||
    !metadata.targets ||
    (metadata.targets as Record<string, unknown>)[normalizedRole]
  ) {
    throw new Error("VNC activator metadata cannot register this target");
  }
  const identity = await readLinuxProcessIdentity(integer(pid, "pid"));
  await writeJsonAtomicallyDurably(absolutePath(metadataPath, "metadataPath"), {
    ...metadata,
    targets: {
      ...(metadata.targets as Record<string, unknown>),
      [normalizedRole]: identity,
    },
  });
  return identity;
}

function encodedSupervisorValue(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

async function registeredSupervisorIdentity(
  handle: { child: ChildProcess },
  metadataPath: string,
  role: string,
): Promise<Record<string, unknown>> {
  const stdout = handle.child.stdout;
  if (stdout === null) {
    throw new Error(`${role} launch supervisor stdout is unavailable`);
  }
  const ready = await firstLine(stdout, 10_000);
  if (ready !== VNC_LAUNCH_SUPERVISOR_READY) {
    throw new Error(`${role} launch supervisor did not register durably`);
  }
  const metadata = JSON.parse(
    await readFile(metadataPath, "utf8"),
  ) as Record<string, unknown>;
  const identity = (metadata.processes as Record<string, unknown> | undefined)?.[
    role
  ];
  if (
    !processIdentityShape(identity) ||
    (identity as { pid?: unknown }).pid !== handle.child.pid ||
    !(await processIdentityMatches(identity))
  ) {
    throw new Error(`${role} launch supervisor identity is invalid`);
  }
  return identity as Record<string, unknown>;
}

async function registeredTargetIdentity(
  metadataPath: string,
  role: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const metadata = JSON.parse(
        await readFile(metadataPath, "utf8"),
      ) as Record<string, unknown>;
      const identity = (metadata.targets as Record<string, unknown> | undefined)?.[
        role
      ];
      if (processIdentityShape(identity)) {
        return identity as Record<string, unknown>;
      }
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
    }
    await delay(25);
  }
  throw new Error(`${role} target identity was not registered durably`);
}

function releaseSupervisor(
  handle: { child: ChildProcess },
  timeoutMs = 2_000,
): Promise<void> {
  return new Promise((resolveRelease, rejectRelease) => {
    const timeout = setTimeout(
      () => rejectRelease(new Error("VNC launch supervisor release timed out")),
      timeoutMs,
    );
    if (handle.child.stdin === null) {
      clearTimeout(timeout);
      resolveRelease();
      return;
    }
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

async function stopProcess(
  handle: VncHandle | null | undefined,
  identity: unknown,
  termination: { killTimeoutMs?: number; termTimeoutMs?: number },
): Promise<void> {
  if (!handle) return;
  const childExit = new Promise<void>((resolveExit) => {
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

interface VncHandle {
  child: ChildProcess;
  completion: Promise<unknown>;
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
}: {
  commands?: Record<string, unknown>;
  domainName: unknown;
  environment?: NodeJS.ProcessEnv;
  libvirtUri: unknown;
  metadataPath: unknown;
  owner: Record<string, unknown>;
  readinessDelayMs?: number;
  runCommand: (
    command: string,
    args: string[],
    options?: { allowFailure?: boolean },
  ) => Promise<{ stdout: unknown; stderr?: unknown }>;
  startProcess: (
    command: string,
    args: string[],
    options: Record<string, unknown>,
  ) => VncHandle;
  termination?: { killTimeoutMs?: number; termTimeoutMs?: number };
}): Promise<{
  endpoint: string;
  failure: Promise<never>;
  runWhileActive: <T>(work: () => Promise<T> | T) => Promise<T>;
  stop: () => Promise<void>;
}> {
  const normalizedDomainName = string(domainName, "domainName");
  const normalizedLibvirtUri = string(libvirtUri, "libvirtUri");
  const normalizedMetadataPath = absolutePath(
    metadataPath,
    "metadataPath",
  );
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
  if (normalizedMetadataPath !== expectedMetadataPath) {
    throw new Error("VNC activator metadata must use its owned staging path");
  }
  const display = await runCommand("virsh", [
    "--connect",
    normalizedLibvirtUri,
    "vncdisplay",
    normalizedDomainName,
  ]);
  const endpoint = parseLibvirtVncDisplay(display.stdout);
  const width = Number(commands.width ?? 1080);
  const height = Number(commands.height ?? 1920);
  const xvfbCommand = String(commands.xvfb ?? "Xvfb");
  const windowManagerCommand = String(commands.windowManager ?? "openbox");
  const viewerCommand = String(commands.viewer ?? "xtigervncviewer");
  const viewerArguments =
    Array.isArray(commands.viewerArguments)
      ? (commands.viewerArguments as string[])
      : commands.viewer !== undefined
        ? []
        : ["-RemoteResize=0", "-ViewOnly=1"];
  let xvfb: VncHandle | null = null;
  let windowManager: VncHandle | null = null;
  let viewer: VncHandle | null = null;
  let xvfbIdentity: Record<string, unknown> | null = null;
  let windowManagerIdentity: Record<string, unknown> | null = null;
  let viewerIdentity: Record<string, unknown> | null = null;
  let stopping = false;
  let rejectFailure!: (error: Error) => void;
  const failure = new Promise<never>((_, reject) => {
    rejectFailure = reject;
  });
  void failure.catch(() => undefined);
  const monitor = (handle: VncHandle, label: string): void => {
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
  const startSupervisor = (
    role: string,
    command: string,
    arguments_: string[],
    targetEnvironment: NodeJS.ProcessEnv,
  ) =>
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
            metadataPath: normalizedMetadataPath,
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
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (!stopPromise) {
      stopping = true;
      stopPromise = (async () => {
        await stopProcess(viewer, viewerIdentity, termination);
        await stopProcess(windowManager, windowManagerIdentity, termination);
        await stopProcess(xvfb, xvfbIdentity, termination);
        const recovered = await recoverHeadlessVncActivator({
          metadataPath: normalizedMetadataPath,
          owner,
          termination,
        });
        if (!recovered.recovered) {
          throw new Error("VNC activator metadata could not be recovered");
        }
      })();
    }
    return stopPromise;
  };

  try {
    xvfb = startSupervisor(
      "xvfb",
      xvfbCommand,
      [
        ...((commands.xvfbArguments as string[] | undefined) ?? []),
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
      normalizedMetadataPath,
      "xvfb",
    );
    const xvfbStdout = xvfb.child.stdout;
    if (xvfbStdout === null) {
      throw new Error("Xvfb stdout stream is unavailable");
    }
    const displayLine = firstLine(xvfbStdout, 10_000);
    await releaseSupervisor(xvfb);
    const displayNumber = await displayLine;
    if (!/^\d+$/.test(displayNumber)) {
      throw new Error("Xvfb returned an invalid display number");
    }
    await registeredTargetIdentity(normalizedMetadataPath, "xvfb");
    windowManager = startSupervisor(
      "window-manager",
      windowManagerCommand,
      [
        ...((commands.windowManagerArguments as string[] | undefined) ?? []),
      ],
      { ...environment, DISPLAY: `:${displayNumber}` },
    );
    monitor(windowManager, "openbox");
    windowManagerIdentity = await registeredSupervisorIdentity(
      windowManager,
      normalizedMetadataPath,
      "window-manager",
    );
    await releaseSupervisor(windowManager);
    await registeredTargetIdentity(normalizedMetadataPath, "window-manager");
    viewer = startSupervisor(
      "viewer",
      viewerCommand,
      [...viewerArguments, endpoint],
      { ...environment, DISPLAY: `:${displayNumber}` },
    );
    monitor(viewer, "TigerVNC viewer");
    viewerIdentity = await registeredSupervisorIdentity(
      viewer,
      normalizedMetadataPath,
      "viewer",
    );
    await releaseSupervisor(viewer);
    await registeredTargetIdentity(normalizedMetadataPath, "viewer");
    await Promise.race([
      failure,
      new Promise((resolveReady) => setTimeout(resolveReady, readinessDelayMs)),
    ]);
    return {
      endpoint,
      failure,
      runWhileActive: <T>(work: () => Promise<T> | T) =>
        Promise.race([Promise.resolve().then(work), failure]),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export function readJsonWithBom(value: unknown): unknown {
  return JSON.parse(String(value).replace(/^\uFEFF/, ""));
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeJsonDurably(
  path: string,
  value: unknown,
): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await fsyncFile(path);
}

async function writeJsonAtomicallyDurably(
  path: string,
  value: unknown,
): Promise<void> {
  const pendingPath = `${path}.pending-${process.pid}-${randomUUID()}`;
  await writeJsonDurably(pendingPath, value);
  await rename(pendingPath, path);
  await fsyncDirectory(dirname(path));
}

async function assertRegularFile(path: string, label: string): Promise<void> {
  const metadata = await stat(path);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function releasePaths(
  layout: Record<string, string>,
  id: unknown,
): {
  releaseId: string;
  directory: string;
  cacheDirectory: string;
  manifestPath: string;
  systemPath: string;
  cachePath: string;
  domainXmlPath: string;
  diagnosticPath: string;
} {
  const normalizedId = releaseId(id);
  const directory = resolve(layout.systemReleaseRoot, normalizedId);
  const cacheDirectory = resolve(layout.cacheReleaseRoot, normalizedId);
  return {
    releaseId: normalizedId,
    directory,
    cacheDirectory,
    manifestPath: `${directory}/release.json`,
    systemPath: `${directory}/${RELEASE_ARTIFACTS.system}`,
    cachePath: `${cacheDirectory}/${RELEASE_ARTIFACTS.cache}`,
    domainXmlPath: `${directory}/${RELEASE_ARTIFACTS.domainXml}`,
    diagnosticPath: `${directory}/${RELEASE_ARTIFACTS.diagnostic}`,
  };
}

function releaseManifest(
  config: BaselineBuildConfig,
  paths: ReturnType<typeof releasePaths>,
  profile: unknown,
): Record<string, unknown> {
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

function currentManifest(
  config: BaselineBuildConfig,
  paths: ReturnType<typeof releasePaths>,
): Record<string, unknown> {
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

async function readCompleteRelease(
  config: BaselineBuildConfig,
  layout: Record<string, string>,
  id: unknown,
): Promise<ReturnType<typeof releasePaths> & { manifest: Record<string, unknown> }> {
  const paths = releasePaths(layout, id);
  const manifest = JSON.parse(
    await readFile(paths.manifestPath, "utf8"),
  ) as Record<string, unknown>;
  if (
    manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA ||
    manifest.releaseId !== paths.releaseId ||
    JSON.stringify(manifest.artifacts) !== JSON.stringify(RELEASE_ARTIFACTS) ||
    (manifest.destinations as Record<string, unknown> | undefined)
      ?.baselinePath !== config.storage.baselinePath ||
    (manifest.destinations as Record<string, unknown> | undefined)
      ?.cacheDiskPath !== config.storage.cacheDiskPath
  ) {
    throw new Error("published baseline release manifest is invalid");
  }
  await Promise.all(
    [
      [paths.systemPath, "published system disk"],
      [paths.cachePath, "published cache disk"],
      [paths.domainXmlPath, "published domain XML"],
      [paths.diagnosticPath, "published diagnostic"],
    ].map(([path, label]) =>
      assertRegularFile(path as string, label as string),
    ),
  );
  return { ...paths, manifest };
}

async function readCurrentRelease(
  config: BaselineBuildConfig,
  layout: Record<string, string>,
): Promise<ReturnType<typeof releasePaths> & {
  manifest: Record<string, unknown>;
  current: Record<string, unknown>;
}> {
  const current = JSON.parse(
    await readFile(layout.currentManifestPath, "utf8"),
  ) as Record<string, unknown>;
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

async function removeInterruptedPublicationFiles(
  layout: Record<string, string>,
): Promise<void> {
  for (const releaseRoot of [
    layout.systemReleaseRoot,
    layout.cacheReleaseRoot,
  ]) {
    let releaseEntries: Array<import("node:fs").Dirent> = [];
    try {
      releaseEntries = await readdir(releaseRoot, { withFileTypes: true });
    } catch (error) {
      if (!isNodeErrorCode(error, "ENOENT")) throw error;
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
  config: BaselineBuildConfig,
  layout: Record<string, string>,
  id: unknown,
  {
    onStaged,
    onRenamed,
    syncDirectory = fsyncDirectory,
  }: {
    onStaged?: () => unknown;
    onRenamed?: () => unknown;
    syncDirectory?: (path: string) => Promise<void>;
  } = {},
): Promise<void> {
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
function publicationJournal(
  previousRelease: { releaseId?: unknown } | null | undefined,
  nextRelease: { releaseId: unknown },
  phase: string,
): Record<string, unknown> {
  return {
    schemaVersion: PUBLICATION_JOURNAL_SCHEMA,
    previousReleaseId: previousRelease?.releaseId ?? null,
    releaseId: nextRelease.releaseId,
    phase,
  };
}

function previousReleasePointer(
  previousRelease: { releaseId: unknown },
  nextRelease: { releaseId: unknown },
): Record<string, unknown> {
  return {
    schemaVersion: PREVIOUS_RELEASE_SCHEMA,
    previousReleaseId: previousRelease.releaseId,
    releaseId: nextRelease.releaseId,
  };
}

function validPreviousReleasePointer(value: unknown): boolean {
  const record = value as Record<string, unknown> | null | undefined;
  if (
    !record ||
    record.schemaVersion !== PREVIOUS_RELEASE_SCHEMA ||
    typeof record.previousReleaseId !== "string" ||
    typeof record.releaseId !== "string"
  ) {
    return false;
  }
  try {
    releaseId(record.previousReleaseId);
    releaseId(record.releaseId);
    return true;
  } catch {
    return false;
  }
}

function validPublicationJournal(value: unknown): boolean {
  const record = value as Record<string, unknown> | null | undefined;
  if (
    !record ||
    record.schemaVersion !== PUBLICATION_JOURNAL_SCHEMA ||
    (record.previousReleaseId !== null &&
      typeof record.previousReleaseId !== "string") ||
    typeof record.releaseId !== "string" ||
    !PUBLICATION_JOURNAL_PHASES.has(String(record.phase))
  ) {
    return false;
  }
  try {
    releaseId(record.releaseId);
    if (record.previousReleaseId !== null) {
      releaseId(record.previousReleaseId);
    }
    return true;
  } catch {
    return false;
  }
}

async function readPublicationJournal(
  layout: Record<string, string>,
): Promise<
  | { kind: "valid"; journal: Record<string, unknown> }
  | { kind: "invalid" }
  | { kind: "absent" }
> {
  try {
    const journal = JSON.parse(
      await readFile(layout.publicationJournalPath, "utf8"),
    ) as Record<string, unknown>;
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
    if (isNodeErrorCode(error, "ENOENT")) return { kind: "absent" };
    return { kind: "invalid" };
  }
}

async function writePublicationJournal(
  layout: Record<string, string>,
  journal: Record<string, unknown>,
): Promise<void> {
  if (!validPublicationJournal(journal)) {
    throw new Error("baseline publication journal is invalid");
  }
  await writeJsonAtomicallyDurably(layout.publicationJournalPath, journal);
}

async function removePublicationJournal(
  layout: Record<string, string>,
): Promise<void> {
  await rm(layout.publicationJournalPath, { force: true });
  await fsyncDirectory(dirname(layout.publicationJournalPath));
}

async function writePreviousReleasePointer(
  layout: Record<string, string>,
  previousRelease: { releaseId: unknown } | null,
  nextRelease: { releaseId: unknown },
): Promise<void> {
  if (!previousRelease) {
    await removePreviousReleasePointer(layout);
    return;
  }
  await writeJsonAtomicallyDurably(
    layout.previousReleasePath,
    previousReleasePointer(previousRelease, nextRelease),
  );
}

async function readPreviousReleasePointer(
  layout: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  try {
    const pointer = JSON.parse(
      await readFile(layout.previousReleasePath, "utf8"),
    );
    return validPreviousReleasePointer(pointer) ? pointer : null;
  } catch {
    return null;
  }
}

async function removePreviousReleasePointer(
  layout: Record<string, string>,
): Promise<void> {
  await rm(layout.previousReleasePath, { force: true });
  await fsyncDirectory(dirname(layout.previousReleasePath));
}

async function removeRelease(
  layout: Record<string, string>,
  id: unknown,
): Promise<void> {
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

async function releaseDirectoryIds(
  layout: Record<string, string>,
): Promise<Set<string>> {
  const entriesFor = async (
    root: string,
  ): Promise<Array<import("node:fs").Dirent>> => {
    try {
      return await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (isNodeErrorCode(error, "ENOENT")) return [];
      throw error;
    }
  };
  const [systemEntries, cacheEntries] = await Promise.all([
    entriesFor(layout.systemReleaseRoot),
    entriesFor(layout.cacheReleaseRoot),
  ]);
  const ids = new Set<string>();
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

async function cleanupUnselectedReleaseSidecars(
  config: BaselineBuildConfig,
  layout: Record<string, string>,
  selectedId: string | null,
): Promise<void> {
  const ids = await releaseDirectoryIds(layout);
  for (const id of ids) {
    if (id !== selectedId) await removeRelease(layout, id);
  }
}

async function readCurrentReleaseOrNull(
  config: BaselineBuildConfig,
  layout: Record<string, string>,
): Promise<Awaited<ReturnType<typeof readCurrentRelease>> | null> {
  try {
    return await readCurrentRelease(config, layout);
  } catch (error) {
    if (isNodeErrorCode(error, "ENOENT") || error instanceof SyntaxError) {
      return null;
    }
    if (
      /^(published baseline (current|release) manifest|published (system|cache|domain XML|diagnostic)|releaseId must)/.test(
        errorMessage(error),
      )
    ) {
      return null;
    }
    throw error;
  }
}

async function removeInvalidCurrentManifest(
  layout: Record<string, string>,
): Promise<void> {
  await rm(layout.currentManifestPath, { force: true });
  await fsyncDirectory(dirname(layout.currentManifestPath));
}

async function readCompleteReleaseOrNull(
  config: BaselineBuildConfig,
  layout: Record<string, string>,
  id: unknown,
): Promise<Awaited<ReturnType<typeof readCompleteRelease>> | null> {
  try {
    return await readCompleteRelease(config, layout, id);
  } catch {
    return null;
  }
}

type DefinitionRecovery = (
  release: Record<string, unknown>,
  previous: Record<string, unknown> | null,
) => unknown;

type DefinitionRollback = (
  release: Record<string, unknown> | null,
) => unknown;

function requireDefinitionRecovery({
  recoverDefinition,
  rollbackDefinition,
}: {
  recoverDefinition?: DefinitionRecovery;
  rollbackDefinition?: DefinitionRollback;
}): {
  recoverDefinition: DefinitionRecovery;
  rollbackDefinition: DefinitionRollback;
} {
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
  return { recoverDefinition, rollbackDefinition };
}

async function finalizeRecoveredRelease({
  config,
  layout,
  current,
  selected,
  removeJournal,
}: {
  config: BaselineBuildConfig;
  layout: Record<string, string>;
  current: Awaited<ReturnType<typeof readCurrentRelease>> | null;
  selected: Awaited<ReturnType<typeof readCompleteRelease>>;
  removeJournal: boolean;
}): Promise<Awaited<ReturnType<typeof readCompleteRelease>>> {
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
  config: BaselineBuildConfig,
  {
    recoverDefinition,
    rollbackDefinition,
  }: {
    recoverDefinition?: DefinitionRecovery;
    rollbackDefinition?: DefinitionRollback;
  } = {},
): Promise<Awaited<ReturnType<typeof readCompleteRelease>> | null> {
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
        const definitionRecovery = requireDefinitionRecovery({
          recoverDefinition,
          rollbackDefinition,
        });
        await definitionRecovery.recoverDefinition(current, null);
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
      const definitionRecovery = requireDefinitionRecovery({
        recoverDefinition,
        rollbackDefinition,
      });
      await definitionRecovery.recoverDefinition(pointerPrevious, null);
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

  const definitionRecovery = requireDefinitionRecovery({
    recoverDefinition,
    rollbackDefinition,
  });
  if (journalState.kind === "invalid") {
    if (!current && !pointerPrevious) {
      throw new Error(
        "incomplete baseline publication has no verifiable selected release",
      );
    }

    const selected = current ?? pointerPrevious;
    if (selected === null) {
      throw new Error(
        "incomplete baseline publication has no verifiable selected release",
      );
    }
    let fallback: Awaited<ReturnType<typeof readCompleteRelease>> | null = null;
    if (current !== null && pointerPrevious !== null) {
      if (pointerPrevious.releaseId !== current.releaseId) {
        fallback = pointerPrevious;
      }
    }
    try {
      await definitionRecovery.recoverDefinition(selected, null);
    } catch (error) {
      if (!fallback) throw error;
      try {
        await definitionRecovery.rollbackDefinition(fallback);
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

  const journal = journalState.journal;
  const candidate = await readCompleteReleaseOrNull(
    config,
    layout,
    journal.releaseId,
  );
  const previous =
    journal.previousReleaseId === null
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
    await definitionRecovery.rollbackDefinition(null);
    if (hasCurrentManifest) await removeInvalidCurrentManifest(layout);
    await cleanupUnselectedReleaseSidecars(config, layout, null);
    await removePublicationJournal(layout);
    await removePreviousReleasePointer(layout);
    return null;
  }

  const fallback = selected.releaseId === journal.releaseId ? previous : null;
  try {
    await definitionRecovery.recoverDefinition(selected, journal);
  } catch (error) {
    if (fallback) {
      try {
        await definitionRecovery.rollbackDefinition(fallback);
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
      await definitionRecovery.rollbackDefinition(null);
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

export async function resolvePublishedBaselineRelease(
  config: BaselineBuildConfig,
): Promise<Awaited<ReturnType<typeof readCompleteRelease>>> {
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
}: {
  config: BaselineBuildConfig;
  releaseId?: string;
  stagedSystemPath: unknown;
  stagedCachePath: unknown;
  stagedDomainXmlPath: unknown;
  stagedDiagnosticPath: unknown;
  profile: unknown;
  verified: unknown;
  commitDefinition: (paths: ReturnType<typeof releasePaths>) => unknown;
  rollbackDefinition: (
    release: Awaited<ReturnType<typeof readCurrentRelease>> | null,
  ) => unknown;
  onStage?: (stage: string) => unknown;
  syncCurrentManifestDirectory?: (path: string) => Promise<void>;
}): Promise<Awaited<ReturnType<typeof readCompleteRelease>>> {
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
  const sources: Array<
    [
      string,
      string,
      string,
      string,
      string,
      string,
      string,
    ]
  > = [
    [
      absolutePath(stagedSystemPath, "stagedSystemPath"),
      RELEASE_ARTIFACTS.system,
      "staged system disk",
      "system-staged",
      systemStagingDirectory,
      layout.systemReleaseRoot,
      "system",
    ],
    [
      absolutePath(stagedCachePath, "stagedCachePath"),
      RELEASE_ARTIFACTS.cache,
      "staged cache disk",
      "cache-staged",
      cacheStagingDirectory,
      layout.cacheReleaseRoot,
      "cache",
    ],
    [
      absolutePath(stagedDomainXmlPath, "stagedDomainXmlPath"),
      RELEASE_ARTIFACTS.domainXml,
      "staged domain XML",
      "domain-xml-staged",
      systemStagingDirectory,
      layout.systemReleaseRoot,
      "system",
    ],
    [
      absolutePath(stagedDiagnosticPath, "stagedDiagnosticPath"),
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
  let previousRelease: Awaited<ReturnType<typeof readCurrentRelease>> | null =
    null;
  try {
    previousRelease = await readCurrentRelease(config, layout);
  } catch (error) {
    if (!isNodeErrorCode(error, "ENOENT") && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
  await mkdir(systemStagingDirectory, { mode: 0o700 });
  await mkdir(cacheStagingDirectory, { mode: 0o700 });
  await onStage("release-staging-created");
  let definitionAttempted = false;
  let currentManifestRenamed = false;
  let journal: Record<string, unknown> | null = null;
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
    return await readCompleteRelease(config, layout, id);
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

export async function assertReadableRegularFile(
  path: unknown,
  label: string,
): Promise<string> {
  const value = absolutePath(path, label);
  await access(value, constants.R_OK);
  const metadata = await stat(value);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  return value;
}

export async function assertFileSha256(
  path: unknown,
  expectedHash: unknown,
  label: string,
): Promise<string> {
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
