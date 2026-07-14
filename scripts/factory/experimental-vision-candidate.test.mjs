import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { createPreapprovalDeliveryManifest } from "./experimental-vision-candidate.mjs";
import { canonicalJson } from "./factory-manifest.mjs";

const digest = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

describe("experimental Vision preapproval delivery", () => {
  it("includes the diagnostic redactor in finalized Factory installer media and hash evidence", () => {
    const source = readFileSync(
      "scripts/factory/experimental-vision-candidate.mjs",
      "utf8",
    );

    assert.match(
      source,
      /for \(const script of \[[\s\S]*?"vision-diagnostic-redaction\.psm1"[\s\S]*?\]\)/,
    );
    assert.match(
      source,
      /stage\(\s*`VISION-INSTALLER\/\$\{script\}`,\s*readFileSync\(/,
    );
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
