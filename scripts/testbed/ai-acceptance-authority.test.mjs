import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { verifyAiAcceptanceAuthorityForTest } from "./ai-acceptance-authority.mjs";

const roots = [];
const sourceCommit = "a".repeat(40);

function canonical(value, newline = true) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (item && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sort(item[key])]),
      );
    }
    return item;
  };
  return `${JSON.stringify(sort(value))}${newline ? "\n" : ""}`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-authority-"));
  roots.push(root);
  const candidateDirectory = join(root, "candidate");
  mkdirSync(candidateDirectory);
  const contract = {
    bundleDigest: "b".repeat(64),
    bundleVersion: "1",
    files: {},
    protocol: "vem.vision.v2",
    schemaVersion: "vem-vision-v2-contract-bundle/v1",
  };
  const contractPath = join(root, "contract-manifest.json");
  const contractRaw = canonical(contract, false);
  writeFileSync(contractPath, contractRaw);
  const candidateManifest = {
    bindings: {},
    files: [
      {
        path: "vending-vision/_internal/contracts/vem_vision_v2/manifest.json",
        sha256: digest(contractRaw),
        size: Buffer.byteLength(contractRaw),
      },
    ],
    layout: {},
    schemaVersion: "vending-vision-candidate-artifact/v3",
    sourceCommit,
  };
  const manifestRaw = canonical(candidateManifest, false);
  const archive = Buffer.from("candidate archive\n");
  const attestation = Buffer.from("candidate attestation\n");
  const evidence = canonical({
    attestationBundleSha256: digest(attestation),
    builderRepository: "hbhjt/vending-vision",
    builderWorkflow: ".github/workflows/trusted-ai-candidate-builder.yml",
    builderWorkflowSha: "c90a965d117fea49f318b18e0fcd50aa047bc41f",
    embeddedManifestSha256: digest(manifestRaw),
    schemaVersion: "vending-vision-trusted-builder-evidence/v1",
    sourceCommit,
    subjectSha256: digest(archive),
  });
  writeFileSync(join(candidateDirectory, "candidate.zip"), archive);
  writeFileSync(
    join(candidateDirectory, "candidate-manifest.json"),
    manifestRaw,
  );
  writeFileSync(
    join(candidateDirectory, "github-build-provenance.sigstore.json"),
    attestation,
  );
  writeFileSync(
    join(candidateDirectory, "trusted-builder-evidence.json"),
    evidence,
  );
  const candidate = {
    attestationBundleSha256: digest(attestation),
    embeddedManifestSha256: digest(manifestRaw),
    sourceCommit,
    subjectSha256: digest(archive),
    trustedBuilderEvidenceSha256: digest(evidence),
  };
  const proof = {
    candidate: {
      ...candidate,
      workerExecutableSha256: "c".repeat(64),
    },
    companion: {
      archiveSha256: "d".repeat(64),
      descriptorSha256: "e".repeat(64),
      sourceCommit: "f".repeat(40),
    },
    modelPack: {
      archive: { byteSize: 42, sha256: "1".repeat(64) },
      descriptorSha256: "2".repeat(64),
      sourceRevision: "3".repeat(40),
    },
    resources: {
      aiLockSha256: "4".repeat(64),
      runtimeDescriptorSha256: "5".repeat(64),
      sourceDescriptorSha256: "6".repeat(64),
    },
  };
  const windows = {
    authority: {
      descriptorSha256: `sha256:${"7".repeat(64)}`,
      workflowSha: "8".repeat(40),
    },
    files: {
      bundle: { sha256: `sha256:${"9".repeat(64)}` },
      evidence: { sha256: `sha256:${"0".repeat(64)}` },
      proof: { sha256: `sha256:${"a".repeat(64)}` },
    },
    proof,
  };
  return { candidate, candidateDirectory, contract, contractPath, windows };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

test("issues installed-Windows-only authority after cross-binding candidate and companion proof", async () => {
  const value = fixture();
  process.env.NODE_ENV = "test";
  const receipt = await verifyAiAcceptanceAuthorityForTest(
    {
      candidateInputDirectory: value.candidateDirectory,
      contractManifest: value.contractPath,
      ghBinaryPath: "/trusted/gh",
      repoRoot: "/repo",
      visionSourceRef: "refs/tags/v1.2.3-rc.1",
      windowsProofInputDirectory: "/windows-proof",
    },
    {
      verifyCandidateAttestation: async (input) => {
        assert.equal(input.sourceCommit, sourceCommit);
        assert.equal(input.subjectSha256, value.candidate.subjectSha256);
      },
      verifyWindowsProof: async (_input, consume) =>
        consume(value.windows, () => {}),
    },
  );
  assert.equal(receipt.schemaVersion, "vem.testbed.ai-acceptance-authority/v1");
  assert.equal(receipt.scope, "installed_windows_acceptance");
  assert.equal(receipt.trustStatus, "verified_for_acceptance");
  assert.equal(receipt.contract.bundleDigest, value.contract.bundleDigest);
  assert.equal(receipt.resources.workerExecutableSha256, "c".repeat(64));
});

test("rejects a candidate whose trusted proof does not bind its model worker identity", async () => {
  const value = fixture();
  process.env.NODE_ENV = "test";
  value.windows.proof.candidate.subjectSha256 = "0".repeat(64);
  await assert.rejects(
    verifyAiAcceptanceAuthorityForTest(
      {
        candidateInputDirectory: value.candidateDirectory,
        contractManifest: value.contractPath,
        ghBinaryPath: "/trusted/gh",
        repoRoot: "/repo",
        visionSourceRef: "refs/tags/v1.2.3-rc.1",
        windowsProofInputDirectory: "/windows-proof",
      },
      {
        verifyCandidateAttestation: async () => {},
        verifyWindowsProof: async (_input, consume) =>
          consume(value.windows, () => {}),
      },
    ),
    /candidate subject does not match Windows proof/,
  );
});
