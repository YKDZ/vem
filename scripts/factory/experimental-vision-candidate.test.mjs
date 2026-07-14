import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createPreapprovalDeliveryManifest,
  FACTORY_VISION_INSTALLER_FILES,
  stageFactoryVisionInstaller,
  stagePreapprovalDeliveryUnit,
} from "./experimental-vision-candidate.mjs";
import { canonicalJson } from "./factory-manifest.mjs";

const digest = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

describe("experimental Vision preapproval delivery", () => {
  it("stages every finalizer script through the actual Factory producer", () => {
    const staged = new Map();
    stageFactoryVisionInstaller((relative, bytes) => staged.set(relative, bytes));
    assert.deepEqual(FACTORY_VISION_INSTALLER_FILES, [
      "install-vision-release.ps1",
      "provision-vision-factory-release.ps1",
      "vision-release-materialization.psm1",
      "vision-diagnostic-redaction.psm1",
    ]);
    assert.deepEqual([...staged.keys()].sort(), [
      "VISION-INSTALLER/install-vision-release.ps1",
      "VISION-INSTALLER/provision-vision-factory-release.ps1",
      "VISION-INSTALLER/vision-diagnostic-redaction.psm1",
      "VISION-INSTALLER/vision-release-materialization.psm1",
    ]);
    for (const [relative, bytes] of staged) {
      assert.equal(
        digest(bytes),
        digest(readFileSync(`scripts/windows/${relative.split("/").at(-1)}`)),
      );
    }
  });

  it("writes a self-contained, byte-pinned preapproval producer output", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-preapproval-"));
    try {
      const bundle = Buffer.from("candidate bundle");
      const descriptor = Buffer.from('{"descriptor":true}\n');
      const result = stagePreapprovalDeliveryUnit({
        outputDirectory: root,
        candidate: { bundle, documents: { descriptor } },
        verified: { bundleDigest: digest(bundle) },
      });
      const manifest = JSON.parse(
        readFileSync(join(result.root, "preapproval-manifest.json"), "utf8"),
      );
      assert.deepEqual(Object.keys(manifest.files).sort(), [
        "bundle.bin",
        "test-vision-candidate.ps1",
        "vision-diagnostic-redaction.psm1",
        "vision-release-descriptor.json",
        "vision-release-materialization.psm1",
      ]);
      for (const [name, expected] of Object.entries(manifest.files)) {
        assert.equal(digest(readFileSync(join(result.root, name))), expected);
      }
      assert.equal(existsSync(join(result.root, "SHA256SUMS")), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes the exact candidate and every executed script hash-addressable", () => {
    const bundle = Buffer.from("exact candidate bundle");
    const descriptor = Buffer.from('{"descriptor":true}\n');
    const manifest = createPreapprovalDeliveryManifest({
      bundle,
      descriptor,
      expectedBundleDigest: digest(bundle),
      testEntry: Buffer.from("candidate entry"),
      materializer: Buffer.from("materializer"),
      redactor: Buffer.from("redactor"),
    });

    assert.equal(manifest.expectedDigest, digest(bundle));
    assert.equal(manifest.descriptorDigest, digest(descriptor));
    assert.deepEqual(Object.keys(manifest.files).sort(), [
      "bundle.bin",
      "test-vision-candidate.ps1",
      "vision-diagnostic-redaction.psm1",
      "vision-release-descriptor.json",
      "vision-release-materialization.psm1",
    ]);
    const { identity, ...unsigned } = manifest;
    assert.equal(identity, digest(Buffer.from(`${canonicalJson(unsigned)}\n`)));
  });

  it("does not produce a delivery manifest for a mismatched ExpectedDigest", () => {
    assert.throws(
      () =>
        createPreapprovalDeliveryManifest({
          bundle: Buffer.from("candidate"),
          descriptor: Buffer.from("descriptor"),
          expectedBundleDigest: `sha256:${"0".repeat(64)}`,
          testEntry: Buffer.from("entry"),
          materializer: Buffer.from("materializer"),
          redactor: Buffer.from("redactor"),
        }),
      /ExpectedDigest/,
    );
  });
});
