import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildMeasurementAiAcceptanceInputManifest,
  createMeasurementAiAcceptanceInputManifest,
} from "./ai-acceptance-input-manifest.mjs";
import { canonicalAiAcceptanceInputManifest } from "./ai-acceptance-input-provisioning.mjs";

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function put(root, name, content) {
  const path = join(root, name);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function canonical(value) {
  const sort = (entry) =>
    Array.isArray(entry)
      ? entry.map(sort)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.keys(entry)
              .sort()
              .map((key) => [key, sort(entry[key])]),
          )
        : entry;
  return `${JSON.stringify(sort(value))}\n`;
}

function inputs(root) {
  const sourceCommit = "a".repeat(40);
  const candidateInputDirectory = join(root, "candidate");
  const windowsProofInputDirectory = join(root, "proof");
  const materializedModelPackRoot = join(root, "models");
  mkdirSync(candidateInputDirectory);
  mkdirSync(windowsProofInputDirectory);
  mkdirSync(materializedModelPackRoot);
  const runtimeContent = "runtime";
  const manifestContent = "manifest";
  const candidateAttestation = "candidate-attestation";
  const candidateEvidence = "candidate-evidence";
  const proofContent = "proof";
  const proofAttestation = "proof-attestation";
  const proofEvidence = "proof-evidence";
  const runtime = put(candidateInputDirectory, "candidate.zip", runtimeContent);
  put(candidateInputDirectory, "candidate-manifest.json", manifestContent);
  put(
    candidateInputDirectory,
    "github-build-provenance.sigstore.json",
    candidateAttestation,
  );
  put(
    candidateInputDirectory,
    "trusted-builder-evidence.json",
    candidateEvidence,
  );
  put(windowsProofInputDirectory, "precutover-ai-proof.json", proofContent);
  put(
    windowsProofInputDirectory,
    "precutover-ai-proof.sigstore.json",
    proofAttestation,
  );
  put(
    windowsProofInputDirectory,
    "trusted-precutover-proof-evidence.json",
    proofEvidence,
  );
  put(materializedModelPackRoot, "weights/model.bin", "model");
  put(materializedModelPackRoot, "manifest.json", "model-manifest");
  const fixtureContent = "fixtures";
  const modelArchiveContent = "model-archive";
  const fixture = put(root, "fixtures.zip", fixtureContent);
  const modelArchive = put(root, "model-pack.zip", modelArchiveContent);
  const authority = put(
    root,
    "authority.json",
    canonical({
      candidate: {
        attestationBundleSha256: digest(candidateAttestation),
        embeddedManifestSha256: digest(manifestContent),
        sourceCommit,
        subjectSha256: digest(runtimeContent),
        trustedBuilderEvidenceSha256: digest(candidateEvidence),
      },
      contract: {
        bundleDigest: "b".repeat(64),
        manifestSha256: "c".repeat(64),
        protocol: "vem.vision.v2",
      },
      modelPack: {
        archive: {
          byteSize: Buffer.byteLength(modelArchiveContent),
          sha256: digest(modelArchiveContent),
        },
        descriptorSha256: "d".repeat(64),
        sourceRevision: "e".repeat(40),
      },
      proofCompanion: {
        archiveSha256: "f".repeat(64),
        descriptorSha256: "1".repeat(64),
        sourceCommit: "2".repeat(40),
      },
      resources: {
        aiLockSha256: "3".repeat(64),
        runtimeDescriptorSha256: "4".repeat(64),
        sourceDescriptorSha256: "5".repeat(64),
        workerExecutableSha256: "6".repeat(64),
      },
      schemaVersion: "vem.testbed.ai-acceptance-authority/v1",
      scope: "installed_windows_acceptance",
      trustStatus: "verified_for_acceptance",
      visionCore: {
        recordedFixtureArchive: {
          format: "vending-vision-main-artifacts/v1",
          sha256: digest(fixtureContent),
          sourceCommit,
        },
        runtimeArchive: {
          format: "vending-vision-candidate-artifact/v3",
          sha256: digest(runtimeContent),
          sourceCommit,
        },
      },
      windowsProof: {
        authorityDescriptorSha256: `sha256:${"7".repeat(64)}`,
        proofAttestationBundleSha256: digest(proofAttestation),
        signedProofSha256: digest(proofContent),
        trustedProofEvidenceSha256: digest(proofEvidence),
        workflowSha: "8".repeat(40),
      },
    }),
  );
  return {
    acceptanceAuthorityReceipt: authority,
    candidateInputDirectory,
    installedVisionRuntimeArchive: runtime,
    materializedModelPackRoot,
    modelPackArchive: modelArchive,
    recordedFixtureArchive: fixture,
    sourceCommit,
    windowsProofInputDirectory,
  };
}

test("builds measurement v4 identities from production host inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-measurement-manifest-"));
  try {
    const options = inputs(root);
    const manifest = await buildMeasurementAiAcceptanceInputManifest(options);

    assert.equal(manifest.schemaVersion, "vem-runtime-testbed-ai-input/v4");
    assert.equal(manifest.phase, "measurement");
    assert.deepEqual(manifest.modelPack.delivery, {
      kind: "host-local-cache",
    });
    assert.equal(
      manifest.installedVisionRuntimeArchive.sourceCommit,
      options.sourceCommit,
    );
    assert.equal(
      manifest.recordedFixtureArchive.sourceCommit,
      options.sourceCommit,
    );
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

test("creates canonical measurement manifest once through the public writer", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-measurement-create-"));
  try {
    const outputPath = join(root, "out", "measurement.json");
    const options = { ...inputs(root), outputPath };
    await createMeasurementAiAcceptanceInputManifest(options);
    const raw = readFileSync(outputPath, "utf8");
    assert.equal(raw, canonicalAiAcceptanceInputManifest(JSON.parse(raw)));
    await assert.rejects(
      createMeasurementAiAcceptanceInputManifest(options),
      /EEXIST/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects output inside every measured input directory before mutation", async () => {
  for (const key of [
    "candidateInputDirectory",
    "windowsProofInputDirectory",
    "materializedModelPackRoot",
  ]) {
    const root = mkdtempSync(join(tmpdir(), "vem-ai-measurement-overlap-"));
    try {
      const options = inputs(root);
      const before = readdirSync(options[key], { recursive: true }).sort();
      await assert.rejects(
        createMeasurementAiAcceptanceInputManifest({
          ...options,
          outputPath: join(options[key], "nested", "measurement.json"),
        }),
        /output must remain outside candidate, proof, and model input directories/,
      );
      assert.deepEqual(
        readdirSync(options[key], { recursive: true }).sort(),
        before,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});
