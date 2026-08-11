import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";

export const TRUSTED_GH_DESCRIPTOR_PATH = new URL(
  "../trusted-gh-cli-linux-amd64.json",
  import.meta.url,
).pathname;

function exactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...keys].sort())
  ) {
    throw new Error(`${label} keys are not exact`);
  }
  return value;
}

export function loadTrustedGhDescriptor(path = TRUSTED_GH_DESCRIPTOR_PATH) {
  const raw = readFileSync(path, "utf8");
  let descriptor;
  try {
    descriptor = JSON.parse(raw);
  } catch {
    throw new Error("trusted gh descriptor is invalid JSON");
  }
  if (`${JSON.stringify(descriptor, null, 2)}\n` !== raw) {
    throw new Error("trusted gh descriptor is not canonical");
  }
  exactObject(
    descriptor,
    ["archive", "binary", "platform", "schemaVersion", "version"],
    "trusted gh descriptor",
  );
  exactObject(
    descriptor.binary,
    ["byteSize", "relativeMember", "sha256", "versionOutput"],
    "trusted gh binary descriptor",
  );
  if (
    descriptor.schemaVersion !== "vem.trusted-gh-cli.v1" ||
    descriptor.platform !== "linux-amd64" ||
    descriptor.version !== "2.95.0"
  ) {
    throw new Error("trusted gh descriptor identity mismatch");
  }
  return descriptor;
}

function hashFile(path) {
  const descriptor = openSync(path, "r");
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let byteSize = 0;
  try {
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (count === 0) break;
      byteSize += count;
      digest.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  return { byteSize, sha256: digest.digest("hex") };
}

export function verifyTrustedGhBinary(binaryPath) {
  if (!isAbsolute(binaryPath)) {
    throw new Error("trusted gh binary path must be absolute");
  }
  const resolved = realpathSync(binaryPath);
  if (resolved !== resolve(binaryPath)) {
    throw new Error("trusted gh binary path must be a non-symlink realpath");
  }
  if (!lstatSync(binaryPath).isFile()) {
    throw new Error("trusted gh binary must be a regular file");
  }
  const descriptor = loadTrustedGhDescriptor();
  const identity = hashFile(binaryPath);
  if (
    identity.byteSize !== descriptor.binary.byteSize ||
    identity.sha256 !== descriptor.binary.sha256
  ) {
    throw new Error("trusted gh binary size or digest mismatch");
  }
  const probeRoot = mkdtempSync(`${tmpdir()}/vem-gh-version-`);
  try {
    const probe = spawnSync(binaryPath, ["--version"], {
      encoding: "utf8",
      env: {
        GH_CONFIG_DIR: `${probeRoot}/config`,
        HOME: probeRoot,
        LANG: "C.UTF-8",
        XDG_STATE_HOME: `${probeRoot}/state`,
      },
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    if (
      probe.status !== 0 ||
      probe.stderr !== "" ||
      probe.stdout !== descriptor.binary.versionOutput
    ) {
      throw new Error("trusted gh binary version mismatch");
    }
  } finally {
    rmSync(probeRoot, { force: true, recursive: true });
  }
  return descriptor;
}
