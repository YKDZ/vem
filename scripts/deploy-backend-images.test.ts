import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { BundleRecord } from "./deploy-backend-images.ts";

import {
  resolveBundle,
  validateBundleRecord,
} from "./deploy-backend-images.ts";

const commit = "c".repeat(40);
const serviceDigest = `sha256:${"a".repeat(64)}`;
const adminDigest = `sha256:${"b".repeat(64)}`;

test("bundle record must bind the requested commit with both repo digests", () => {
  const record = {
    schemaVersion: "vem-backend-image-bundle/v1",
    requestedCommit: commit,
    repoDigests: { serviceApi: serviceDigest, adminUi: adminDigest },
    bundle: "backend-images.tar.gz",
  };
  assert.equal(validateBundleRecord(record, commit), record);
  assert.throws(
    () =>
      validateBundleRecord(
        { ...record, requestedCommit: "d".repeat(40) },
        commit,
      ),
    /does not bind the requested commit/,
  );
  assert.throws(
    () =>
      validateBundleRecord(
        {
          ...record,
          repoDigests: { serviceApi: serviceDigest },
        } as unknown as BundleRecord,
        commit,
      ),
    /does not bind the requested commit/,
  );
});

test("resolveBundle unwraps the CI zip and exposes its bundle record", () => {
  const root = mkdtempSync(join(tmpdir(), "vem-backend-bundle-test-"));
  const source = join(root, "source");
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "backend-images.tar.gz"), "fake-gzip");
  writeFileSync(
    join(source, "backend-images.json"),
    `${JSON.stringify({
      schemaVersion: "vem-backend-image-bundle/v1",
      requestedCommit: commit,
      repoDigests: { serviceApi: serviceDigest, adminUi: adminDigest },
      bundle: "backend-images.tar.gz",
    })}\n`,
  );
  const zipPath = join(root, "bundle.zip");
  execFileSync("bsdtar", ["-a", "-cf", zipPath, "-C", source, "."], {
    stdio: "pipe",
  });
  const resolved = resolveBundle(zipPath);
  assert.match(resolved.archive, /backend-images\.tar\.gz$/);
  assert.equal(resolved.record?.requestedCommit, commit);
  assert.equal(resolved.record?.repoDigests.serviceApi, serviceDigest);
  assert.equal(
    resolveBundle(join(source, "backend-images.tar.gz")).record,
    null,
  );
});
