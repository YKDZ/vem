import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { buildMeasurementAiAcceptanceInputManifest } from "./ai-acceptance-input-manifest.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function put(root, name, content) {
  const path = join(root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

test("builds measurement v4 identities from production host inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-measurement-manifest-"));
  try {
    const sourceCommit = "a".repeat(40);
    const candidateInputDirectory = join(root, "candidate");
    const windowsProofInputDirectory = join(root, "proof");
    const materializedModelPackRoot = join(root, "models");
    mkdirSync(candidateInputDirectory);
    mkdirSync(windowsProofInputDirectory);
    mkdirSync(materializedModelPackRoot);
    const runtime = put(candidateInputDirectory, "candidate.zip", "runtime");
    put(candidateInputDirectory, "candidate-manifest.json", "manifest");
    put(
      candidateInputDirectory,
      "github-build-provenance.sigstore.json",
      "candidate-attestation",
    );
    put(
      candidateInputDirectory,
      "trusted-builder-evidence.json",
      "candidate-evidence",
    );
    put(windowsProofInputDirectory, "precutover-ai-proof.json", "proof");
    put(
      windowsProofInputDirectory,
      "precutover-ai-proof.sigstore.json",
      "proof-attestation",
    );
    put(
      windowsProofInputDirectory,
      "trusted-precutover-proof-evidence.json",
      "proof-evidence",
    );
    put(materializedModelPackRoot, "weights/model.bin", "model");
    put(materializedModelPackRoot, "manifest.json", "model-manifest");
    const fixture = put(root, "fixtures.zip", "fixtures");
    const modelArchive = put(root, "model-pack.zip", "model-archive");
    const authority = put(
      root,
      "authority.json",
      `${JSON.stringify({
        candidate: { sourceCommit },
        visionCore: {
          recordedFixtureArchive: { sourceCommit },
          runtimeArchive: { sourceCommit },
        },
      })}\n`,
    );

    const manifest = await buildMeasurementAiAcceptanceInputManifest({
      acceptanceAuthorityReceipt: authority,
      candidateInputDirectory,
      installedVisionRuntimeArchive: runtime,
      materializedModelPackRoot,
      modelPackArchive: modelArchive,
      recordedFixtureArchive: fixture,
      windowsProofInputDirectory,
    });

    assert.equal(manifest.schemaVersion, "vem-runtime-testbed-ai-input/v4");
    assert.equal(manifest.phase, "measurement");
    assert.deepEqual(manifest.modelPack.delivery, {
      kind: "host-local-cache",
    });
    assert.equal(
      manifest.installedVisionRuntimeArchive.sourceCommit,
      sourceCommit,
    );
    assert.equal(manifest.recordedFixtureArchive.sourceCommit, sourceCommit);
    assert.equal(
      manifest.installedVisionRuntimeArchive.sha256,
      digest("runtime"),
    );
    assert.equal(manifest.modelPack.archive.sha256, digest("model-archive"));
    assert.deepEqual(
      manifest.candidateInput.members.map((entry) => entry.name),
      [
        "candidate-manifest.json",
        "candidate.zip",
        "github-build-provenance.sigstore.json",
        "trusted-builder-evidence.json",
      ],
    );
    assert.deepEqual(
      manifest.modelPack.materializedRoot.members.map((entry) => entry.name),
      ["manifest.json", "weights/model.bin"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
