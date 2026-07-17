import { constants } from "node:fs";
import { access, open, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, normalize, resolve } from "node:path";

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
  const vm = object(config.vm, "vm");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{1,62}$/.test(string(vm.name, "vm.name"))) {
    throw new Error("vm.name must be a portable libvirt domain name");
  }
  string(vm.networkName, "vm.networkName");
  if (!/^52:54:00(?::[0-9a-f]{2}){3}$/i.test(string(vm.macAddress, "vm.macAddress"))) {
    throw new Error("vm.macAddress must be a stable libvirt locally administered MAC");
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
  for (const key of ["systemDiskGiB", "cacheDiskGiB", "minimumFreeGiB"]) {
    integer(storage[key], `storage.${key}`);
  }
  const media = object(config.media, "media");
  absolutePath(media.windowsIsoPath, "media.windowsIsoPath");
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
  absolutePath(runner.registrationTokenFile, "runner.registrationTokenFile");
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

export function evaluateHostPreflight(config, observed) {
  validateBaselineBuildConfig(config);
  object(observed, "host observation");
  const profile = runtimeProfileForConfig(config);
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
    !Number.isFinite(storage.baseline) || !Number.isFinite(storage.cache) ||
    storage.baseline < requiredStorageBytes || storage.cache < requiredStorageBytes
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
    const cidr = fields.find((field) => /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/.test(field));
    if (cidr) return cidr.split("/", 1)[0];
  }
  return null;
}

export function readJsonWithBom(value) {
  return JSON.parse(String(value).replace(/^\uFEFF/, ""));
}

// Reverts every destination when a later replacement or callback fails.
export async function replaceFilesTransaction(entries, afterReplace = async () => {}) {
  const changes = [];
  try {
    for (const entry of entries) {
      const stagedPath = absolutePath(entry.stagedPath, "stagedPath");
      const destinationPath = absolutePath(entry.destinationPath, "destinationPath");
      if (!(await stat(stagedPath)).isFile()) throw new Error("staged transaction file must be regular");
      if ((await stat(dirname(stagedPath))).dev !== (await stat(dirname(destinationPath))).dev) {
        throw new Error("transaction staging and destination must share a filesystem");
      }
      const backupPath = `${destinationPath}.rollback-${process.pid}-${changes.length}`;
      let hadDestination = false;
      try {
        await rename(destinationPath, backupPath);
        hadDestination = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      try {
        await rename(stagedPath, destinationPath);
      } catch (error) {
        if (hadDestination) await rename(backupPath, destinationPath);
        throw error;
      }
      changes.push({ destinationPath, backupPath, hadDestination });
      await afterReplace(entry, changes.length);
    }
    await Promise.all(changes.filter((change) => change.hadDestination).map((change) => rm(change.backupPath, { force: true })));
  } catch (error) {
    for (const change of changes.reverse()) {
      await rm(change.destinationPath, { force: true });
      if (change.hadDestination) await rename(change.backupPath, change.destinationPath);
    }
    throw error;
  }
}

export async function promoteVerifiedBaseline({
  stagedPath,
  baselinePath,
  verified,
}) {
  if (verified !== true)
    throw new Error("baseline verification must pass before promotion");
  const staged = absolutePath(stagedPath, "stagedPath");
  const baseline = absolutePath(baselinePath, "baselinePath");
  const stagedStat = await stat(staged);
  if (!stagedStat.isFile())
    throw new Error("staged baseline must be a regular file");
  const stagedParent = await stat(dirname(staged));
  const baselineParent = await stat(dirname(baseline));
  if (stagedParent.dev !== baselineParent.dev) {
    throw new Error(
      "staged baseline must share a filesystem with the published baseline",
    );
  }
  const stagedHandle = await open(staged, constants.O_RDONLY);
  try {
    await stagedHandle.sync();
  } finally {
    await stagedHandle.close();
  }
  await rename(staged, baseline);
  const parentHandle = await open(dirname(baseline), constants.O_RDONLY);
  try {
    await parentHandle.sync();
  } finally {
    await parentHandle.close();
  }
}

export async function assertReadableRegularFile(path, label) {
  const value = absolutePath(path, label);
  await access(value, constants.R_OK);
  const metadata = await stat(value);
  if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
  return value;
}

export { REQUIRED_COMMANDS };
