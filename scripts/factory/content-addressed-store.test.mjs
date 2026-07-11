import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  AssetDigestMismatchError,
  ContentAddressedAssetStore,
} from "./content-addressed-store.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "vem-factory-cas-"));
  const source = join(root, "source.bin");
  const bytes = Buffer.from("fixture asset\n", "utf8");
  await writeFile(source, bytes);
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    root,
    source,
    asset: {
      role: "vem-daemon",
      identity: `factory-cas://sha256/${hash}`,
      digest: `sha256:${hash}`,
    },
  };
}

describe("runner-local content-addressed asset store", () => {
  it("reports a miss, atomically populates, and returns a verified hit without path evidence", async () => {
    const data = await fixture();
    try {
      const store = new ContentAddressedAssetStore(data.root);
      assert.equal((await store.resolve(data.asset)).status, "miss");

      const populated = await store.ensure(data.asset, data.source);
      assert.equal(populated.status, "miss");
      const hit = await store.ensure(data.asset, data.source);
      assert.equal(hit.status, "hit");
      assert.deepEqual(hit.evidence, {
        identity: data.asset.identity,
        digest: data.asset.digest,
        status: "hit",
        bytes: 14,
      });
      assert.equal(Object.hasOwn(hit.evidence, "path"), false);
      assert.equal(
        (await store.readVerified(data.asset)).toString(),
        "fixture asset\n",
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects a source digest mismatch and never makes mismatched bytes available", async () => {
    const data = await fixture();
    try {
      const store = new ContentAddressedAssetStore(data.root);
      await writeFile(data.source, "tampered\n");
      await assert.rejects(
        store.ensure(data.asset, data.source),
        AssetDigestMismatchError,
      );
      assert.equal((await store.resolve(data.asset)).status, "miss");
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects corrupted cached bytes and converges concurrent population", async () => {
    const data = await fixture();
    try {
      const store = new ContentAddressedAssetStore(data.root);
      const results = await Promise.all(
        Array.from({ length: 6 }, () => store.ensure(data.asset, data.source)),
      );
      assert.equal(
        results.filter((result) => result.status === "miss").length,
        1,
      );
      assert.equal(
        results.filter((result) => result.status === "hit").length,
        5,
      );

      // CAS publishes immutable blobs. Make this adversarial fixture writable
      // explicitly so it behaves the same under root and non-root test runners.
      await chmod(store.cachePath(data.asset), 0o600);
      await writeFile(store.cachePath(data.asset), "corrupted\n");
      await assert.rejects(store.resolve(data.asset), AssetDigestMismatchError);
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects Windows source media in the ordinary cache", async () => {
    const data = await fixture();
    try {
      const store = new ContentAddressedAssetStore(data.root);
      const source = { ...data.asset, role: "windows-source-iso" };
      await assert.rejects(
        store.ensure(source, data.source),
        /restricted source store and never cached/,
      );
      const verified = await store.verifyUncached(source, data.source);
      assert.equal(verified.status, "uncached");
      assert.equal((await store.resolve(source)).status, "miss");
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("always verifies a supplied downloaded source even when the CAS is a hit", async () => {
    const data = await fixture();
    try {
      const store = new ContentAddressedAssetStore(data.root);
      await store.ensure(data.asset, data.source);
      await writeFile(data.source, "tampered download\n");
      await assert.rejects(
        store.ensure(data.asset, data.source),
        /source asset digest mismatch/,
      );
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("rejects symlink and non-regular source or cache entries", async () => {
    const data = await fixture();
    try {
      const store = new ContentAddressedAssetStore(data.root);
      const linkedSource = join(data.root, "linked-source.bin");
      await symlink(data.source, linkedSource);
      await assert.rejects(
        store.ensure(data.asset, linkedSource),
        /symlink|regular file/i,
      );

      await mkdir(join(data.root, "sha256"), { recursive: true });
      await symlink(data.source, store.cachePath(data.asset));
      await assert.rejects(store.resolve(data.asset), /symlink|regular file/i);
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("publishes bytes from the verified open source when its pathname is swapped", async () => {
    const data = await fixture();
    try {
      const good = Buffer.alloc(16 * 1024 * 1024, 0x41);
      await writeFile(data.source, good);
      const hash = createHash("sha256").update(good).digest("hex");
      data.asset.identity = `factory-cas://sha256/${hash}`;
      data.asset.digest = `sha256:${hash}`;
      const replacement = join(data.root, "replacement.bin");
      await writeFile(replacement, Buffer.alloc(good.length, 0x42));

      let swap;
      const store = new ContentAddressedAssetStore(data.root, {
        onSourceOpened: async () => {
          swap ??= rename(replacement, data.source);
          await swap;
        },
      });
      await store.ensure(data.asset, data.source);
      assert.deepEqual(await store.readVerified(data.asset), good);
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("stages Windows source bytes from the verified open handle when its pathname is swapped", async () => {
    const data = await fixture();
    try {
      const good = Buffer.alloc(2 * 1024 * 1024, 0x41);
      await writeFile(data.source, good);
      const hash = createHash("sha256").update(good).digest("hex");
      const source = {
        ...data.asset,
        role: "windows-source-iso",
        identity: `factory-cas://sha256/${hash}`,
        digest: `sha256:${hash}`,
      };
      const replacement = join(data.root, "replacement.iso");
      await writeFile(replacement, Buffer.alloc(good.length, 0x42));
      let swapped = false;
      const store = new ContentAddressedAssetStore(data.root, {
        onSourceOpened: async () => {
          if (!swapped) {
            swapped = true;
            await rename(replacement, data.source);
          }
        },
      });
      const staged = join(data.root, "verified-source.iso");
      await store.stageUncachedVerified(source, data.source, staged);
      assert.deepEqual(await readFile(staged), good);
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });

  it("recovers stale and dead-owner locks without deleting a live owner lock", async () => {
    const data = await fixture();
    try {
      const store = new ContentAddressedAssetStore(data.root, {
        lockTimeoutMs: 200,
        lockPollMs: 5,
        staleLockMs: 1_000,
      });
      await mkdir(join(data.root, "sha256"), { recursive: true });
      const lockPath = `${store.cachePath(data.asset)}.lock`;
      await writeFile(
        lockPath,
        JSON.stringify({
          schemaVersion: "vem-cas-lock/v1",
          token: "abandoned",
          pid: 99999999,
          hostname: hostname(),
          startedAt: new Date(0).toISOString(),
          heartbeatAt: new Date(0).toISOString(),
        }),
      );
      const recovered = await store.ensure(data.asset, data.source);
      assert.equal(recovered.status, "miss");

      await rm(store.cachePath(data.asset));
      await writeFile(
        lockPath,
        JSON.stringify({
          schemaVersion: "vem-cas-lock/v1",
          token: "stale-remote-owner",
          pid: 1,
          hostname: "different-runner",
          startedAt: new Date(0).toISOString(),
          heartbeatAt: new Date(0).toISOString(),
        }),
      );
      await utimes(lockPath, new Date(0), new Date(0));
      const staleRecovered = await store.ensure(data.asset, data.source);
      assert.equal(staleRecovered.status, "miss");

      await rm(store.cachePath(data.asset));
      await writeFile(
        lockPath,
        JSON.stringify({
          schemaVersion: "vem-cas-lock/v1",
          token: "live",
          pid: process.pid,
          hostname: hostname(),
          startedAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
        }),
      );
      await assert.rejects(
        store.ensure(data.asset, data.source),
        /timed out waiting/,
      );
      assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, "live");
    } finally {
      await rm(data.root, { recursive: true, force: true });
    }
  });
});
