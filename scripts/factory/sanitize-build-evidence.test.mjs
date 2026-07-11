import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  validateFactoryEvidencePayload,
  validateFactoryEvidenceUploadDirectory,
} from "./sanitize-build-evidence.mjs";

function provenance() {
  return {
    schemaVersion: "vem-factory-provenance/v1",
    kind: "factory-media-provenance",
    manifest: {},
    inputs: [],
    effectiveInputs: [],
    toolchain: {},
    output: {},
    evidence: {
      policy: {
        sourceWindowsMediaUploaded: false,
        personalizationMediaUploaded: false,
        secretsCached: false,
        privateKeysCached: false,
        hostPathsIncluded: false,
      },
    },
    reproducibility: {},
  };
}

function result() {
  return {
    schemaVersion: "vem-factory-build-result/v1",
    kind: "factory-build-result",
    manifestIdentity: `sha256:${"a".repeat(64)}`,
    isoIdentity: `factory-cas://sha256/${"b".repeat(64)}`,
    isoDigest: `sha256:${"b".repeat(64)}`,
    isoFileName: `vem-factory-${"a".repeat(64)}.iso`,
    provenanceFileName: "factory-provenance.json",
    provenanceIdentity: `factory-evidence://sha256/${"c".repeat(64)}`,
    provenanceDigest: `sha256:${"c".repeat(64)}`,
    reproducibility: {},
  };
}

describe("Factory evidence upload sanitizer", () => {
  it("rejects paths, encoded paths, file URIs, and secret-like values anywhere", () => {
    for (const attack of [
      "file:///restricted/windows.iso",
      "C:\\factory\\windows.iso",
      "failure at /var/lib/vem/windows.iso",
      "%2Fvar%2Flib%2Fvem%2Fwindows.iso",
      "Authorization%3A%20Bearer%20abcdefghijklmnopqrstuvwx",
    ]) {
      const payload = provenance();
      payload.output.note = attack;
      assert.throws(
        () =>
          validateFactoryEvidencePayload("factory-provenance.json", payload),
        /path|file URI|secret/i,
        attack,
      );
    }
  });

  it("does not trust policy flags and rejects unknown upload payload fields", () => {
    const payload = provenance();
    payload.evidence.policy.hostPathsIncluded = true;
    assert.throws(
      () => validateFactoryEvidencePayload("factory-provenance.json", payload),
      /policy flag/i,
    );
    const buildResult = result();
    buildResult.stagedPath = "/tmp/factory.iso";
    assert.throws(
      () =>
        validateFactoryEvidencePayload(
          "factory-build-result.json",
          buildResult,
        ),
      /unknown|path/i,
    );
  });

  it("accepts only two bounded regular JSON files", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-evidence-upload-"));
    try {
      await writeFile(
        join(root, "factory-provenance.json"),
        JSON.stringify(provenance()),
      );
      await writeFile(
        join(root, "factory-build-result.json"),
        JSON.stringify(result()),
      );
      await validateFactoryEvidenceUploadDirectory(root);

      await writeFile(join(root, "source.iso"), "not allowed");
      await assert.rejects(
        validateFactoryEvidenceUploadDirectory(root),
        /allowlist|unexpected/i,
      );
      await rm(join(root, "source.iso"));
      await rm(join(root, "factory-provenance.json"));
      await symlink(
        join(root, "factory-build-result.json"),
        join(root, "factory-provenance.json"),
      );
      await assert.rejects(
        validateFactoryEvidenceUploadDirectory(root),
        /regular file|symlink/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
