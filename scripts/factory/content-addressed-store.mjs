import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";

import { digestFromIdentity } from "./factory-manifest.mjs";

const CACHEABLE_ROLES = new Set([
  "openssh-installer",
  "wireguard-installer",
  "vem-daemon",
  "vem-machine-ui",
  "webview2-loader",
  "vision-release",
  "factory-iso",
]);
const READ_FLAGS =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const COPY_CHUNK_BYTES = 1024 * 1024;

export class AssetDigestMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssetDigestMismatchError";
  }
}

function digestHash(digest) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(digest);
  if (!match)
    throw new AssetDigestMismatchError(`unsupported asset digest: ${digest}`);
  return match[1];
}

function assertAssetReference(asset) {
  if (!asset || typeof asset !== "object") {
    throw new AssetDigestMismatchError("asset reference must be an object");
  }
  const expectedDigest = digestFromIdentity(asset.identity);
  if (asset.digest !== expectedDigest) {
    throw new AssetDigestMismatchError(
      "asset identity and digest do not match",
    );
  }
  return expectedDigest;
}

async function openRegular(path, label) {
  let handle;
  try {
    handle = await open(path, READ_FLAGS);
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw new AssetDigestMismatchError(`${label} must not be a symlink`);
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) {
      throw new AssetDigestMismatchError(`${label} must be a regular file`);
    }
    return { handle, bytes: fileStat.size, mtimeMs: fileStat.mtimeMs };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function hashHandle(handle) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let bytes = 0;
  while (true) {
    const read = await handle.read(buffer, 0, buffer.length, bytes);
    if (read.bytesRead === 0) break;
    hash.update(buffer.subarray(0, read.bytesRead));
    bytes += read.bytesRead;
  }
  return { digest: `sha256:${hash.digest("hex")}`, bytes };
}

async function readHandle(handle) {
  const chunks = [];
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let position = 0;
  while (true) {
    const read = await handle.read(buffer, 0, buffer.length, position);
    if (read.bytesRead === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read.bytesRead)));
    position += read.bytesRead;
  }
  return Buffer.concat(chunks);
}

async function copyHandle(handle, destination, mode = 0o444) {
  const output = await open(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600,
  );
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
  let position = 0;
  try {
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, position);
      if (read.bytesRead === 0) break;
      const chunk = buffer.subarray(0, read.bytesRead);
      await output.write(chunk, 0, chunk.length, position);
      hash.update(chunk);
      position += chunk.length;
    }
    await output.sync();
    await output.chmod(mode);
    await output.sync();
  } finally {
    await output.close();
  }
  return { digest: `sha256:${hash.digest("hex")}`, bytes: position };
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function processIsDead(owner) {
  if (owner.hostname !== hostname() || !Number.isInteger(owner.pid))
    return false;
  try {
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    return error?.code === "ESRCH";
  }
}

export class ContentAddressedAssetStore {
  constructor(
    root,
    {
      lockTimeoutMs = 30_000,
      lockPollMs = 25,
      staleLockMs = Math.max(lockTimeoutMs * 2, 60_000),
      heartbeatMs = Math.max(10, Math.min(Math.floor(staleLockMs / 3), 5_000)),
      onSourceOpened,
    } = {},
  ) {
    this.root = root;
    this.lockTimeoutMs = lockTimeoutMs;
    this.lockPollMs = lockPollMs;
    this.staleLockMs = staleLockMs;
    this.heartbeatMs = heartbeatMs;
    this.onSourceOpened = onSourceOpened;
  }

  cachePath(asset) {
    const digest = assertAssetReference(asset);
    return join(this.root, "sha256", digestHash(digest));
  }

  async resolve(asset) {
    const digest = assertAssetReference(asset);
    const assetPath = this.cachePath(asset);
    let opened;
    try {
      opened = await openRegular(assetPath, "content-addressed cache entry");
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          status: "miss",
          evidence: this.#evidence(asset, digest, "miss", null),
        };
      }
      throw error;
    }
    try {
      const actual = await hashHandle(opened.handle);
      if (actual.digest !== digest) {
        throw new AssetDigestMismatchError(
          `cached asset digest mismatch: expected ${digest}, got ${actual.digest}`,
        );
      }
      return {
        status: "hit",
        evidence: this.#evidence(asset, digest, "hit", actual.bytes),
      };
    } finally {
      await opened.handle.close();
    }
  }

  async readVerified(asset) {
    const digest = assertAssetReference(asset);
    const opened = await openRegular(
      this.cachePath(asset),
      "content-addressed cache entry",
    );
    try {
      const bytes = await readHandle(opened.handle);
      const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      if (actual !== digest) {
        throw new AssetDigestMismatchError(
          `cached asset digest mismatch: expected ${digest}, got ${actual}`,
        );
      }
      return bytes;
    } finally {
      await opened.handle.close();
    }
  }

  async stageVerified(asset, destination) {
    const digest = assertAssetReference(asset);
    const opened = await openRegular(
      this.cachePath(asset),
      "content-addressed cache entry",
    );
    try {
      const copied = await copyHandle(opened.handle, destination);
      if (copied.digest !== digest) {
        await rm(destination, { force: true });
        throw new AssetDigestMismatchError(
          `cached asset digest mismatch: expected ${digest}, got ${copied.digest}`,
        );
      }
      return copied;
    } finally {
      await opened.handle.close();
    }
  }

  async ensure(asset, sourcePath) {
    if (asset?.role === "windows-source-iso") {
      throw new AssetDigestMismatchError(
        "Windows source media must be verified from the restricted source store and never cached",
      );
    }
    if (!CACHEABLE_ROLES.has(asset?.role)) {
      throw new AssetDigestMismatchError(
        "ordinary CAS accepts only declared non-secret asset roles",
      );
    }
    const digest = assertAssetReference(asset);
    let source;
    if (typeof sourcePath === "string" && sourcePath.length > 0) {
      source = await openRegular(sourcePath, "source asset");
      await this.onSourceOpened?.();
      const actual = await hashHandle(source.handle);
      if (actual.digest !== digest) {
        await source.handle.close();
        throw new AssetDigestMismatchError(
          `source asset digest mismatch: expected ${digest}, got ${actual.digest}`,
        );
      }
    }

    try {
      const existing = await this.resolve(asset);
      if (existing.status === "hit") return existing;
      if (!source) {
        throw new AssetDigestMismatchError(
          "cache miss requires a runner-local population source",
        );
      }

      const assetPath = this.cachePath(asset);
      const assetDirectory = dirname(assetPath);
      await mkdir(assetDirectory, { recursive: true });
      const lock = await this.#acquireLock(`${assetPath}.lock`);
      try {
        const afterLock = await this.resolve(asset);
        if (afterLock.status === "hit") return afterLock;

        const temporaryPath = join(
          assetDirectory,
          `.${basename(assetPath)}.${randomUUID()}.tmp`,
        );
        try {
          const copied = await copyHandle(source.handle, temporaryPath);
          if (copied.digest !== digest) {
            throw new AssetDigestMismatchError(
              "asset changed while being populated",
            );
          }
          await lock.assertOwner();
          await rename(temporaryPath, assetPath);
          await syncDirectory(assetDirectory);
        } finally {
          await rm(temporaryPath, { force: true });
        }
        const published = await this.resolve(asset);
        return { ...published, status: "miss" };
      } finally {
        await lock.release();
      }
    } finally {
      await source?.handle.close();
    }
  }

  async verifyUncached(asset, sourcePath) {
    if (asset?.role !== "windows-source-iso") {
      throw new AssetDigestMismatchError(
        "only Windows source media may use uncached verification",
      );
    }
    const digest = assertAssetReference(asset);
    if (typeof sourcePath !== "string" || sourcePath.length === 0) {
      throw new AssetDigestMismatchError(
        "Windows source media requires a restricted source-store file",
      );
    }
    const opened = await openRegular(sourcePath, "Windows source media");
    try {
      const actual = await hashHandle(opened.handle);
      if (actual.digest !== digest) {
        throw new AssetDigestMismatchError(
          `source asset digest mismatch: expected ${digest}, got ${actual.digest}`,
        );
      }
      return {
        status: "uncached",
        evidence: this.#evidence(asset, digest, "uncached", actual.bytes),
      };
    } finally {
      await opened.handle.close();
    }
  }

  async stageUncachedVerified(asset, sourcePath, destination) {
    if (asset?.role !== "windows-source-iso") {
      throw new AssetDigestMismatchError(
        "only Windows source media may use uncached verification",
      );
    }
    const digest = assertAssetReference(asset);
    const opened = await openRegular(sourcePath, "Windows source media");
    try {
      const copied = await copyHandle(opened.handle, destination);
      if (copied.digest !== digest) {
        await rm(destination, { force: true });
        throw new AssetDigestMismatchError(
          `source asset digest mismatch: expected ${digest}, got ${copied.digest}`,
        );
      }
      return copied;
    } finally {
      await opened.handle.close();
    }
  }

  #evidence(asset, digest, status, bytes) {
    return {
      identity: asset.identity,
      digest,
      status,
      ...(bytes === null ? {} : { bytes }),
    };
  }

  async #acquireLock(lockPath) {
    const started = Date.now();
    while (true) {
      try {
        const handle = await open(
          lockPath,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        const owner = {
          schemaVersion: "vem-cas-lock/v1",
          token: randomUUID(),
          pid: process.pid,
          hostname: hostname(),
          startedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
        };
        const writeOwner = async () => {
          const bytes = Buffer.from(`${JSON.stringify(owner)}\n`);
          await handle.write(bytes, 0, bytes.length, 0);
          await handle.truncate(bytes.length);
          await handle.sync();
        };
        await writeOwner();
        await syncDirectory(dirname(lockPath));
        let heartbeatRunning = false;
        const heartbeat = setInterval(async () => {
          if (heartbeatRunning) return;
          heartbeatRunning = true;
          try {
            const now = new Date();
            owner.heartbeatAt = now.toISOString();
            await handle.utimes(now, now);
            await handle.sync();
          } catch {
            // Ownership is checked synchronously before publication.
          } finally {
            heartbeatRunning = false;
          }
        }, this.heartbeatMs);
        heartbeat.unref();

        const readCurrentOwner = async () => {
          try {
            return JSON.parse(await readFile(lockPath, "utf8"));
          } catch {
            return null;
          }
        };
        return {
          assertOwner: async () => {
            const current = await readCurrentOwner();
            if (current?.token !== owner.token) {
              throw new AssetDigestMismatchError(
                "content-addressed cache lock ownership was lost",
              );
            }
          },
          release: async () => {
            clearInterval(heartbeat);
            await handle.close();
            const current = await readCurrentOwner();
            if (current?.token === owner.token) {
              await rm(lockPath, { force: true });
              await syncDirectory(dirname(lockPath));
            }
          },
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await this.#recoverAbandonedLock(lockPath);
        if (Date.now() - started >= this.lockTimeoutMs) {
          throw new AssetDigestMismatchError(
            "timed out waiting for content-addressed cache lock",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, this.lockPollMs));
      }
    }
  }

  async #recoverAbandonedLock(lockPath) {
    let owner;
    let lockMtimeMs;
    try {
      const opened = await openRegular(
        lockPath,
        "content-addressed cache lock",
      );
      try {
        owner = JSON.parse((await readHandle(opened.handle)).toString("utf8"));
        lockMtimeMs = opened.mtimeMs;
      } finally {
        await opened.handle.close();
      }
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const stale =
      !Number.isFinite(lockMtimeMs) ||
      Date.now() - lockMtimeMs > this.staleLockMs;
    if (!stale && !processIsDead(owner)) return;

    const recovered = `${lockPath}.recovered.${randomUUID()}`;
    try {
      await rename(lockPath, recovered);
      await rm(recovered, { force: true });
      await syncDirectory(dirname(lockPath));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
