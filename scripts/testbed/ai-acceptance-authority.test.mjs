import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  verifyAiAcceptanceAuthorityForTest,
  verifyVisionCoreDelivery,
} from "./ai-acceptance-authority.mjs";

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
    builderWorkflowSha: "691b5056e8b9bf2667bc527b2170780b05863946",
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
  const recordedFixtureArchive = join(root, "recorded-fixtures.zip");
  writeFileSync(recordedFixtureArchive, "recorded fixture\n");
  return {
    candidate,
    candidateDirectory,
    contract,
    contractPath,
    recordedFixtureArchive,
    windows,
  };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

test("separates the proof companion from the installable candidate runtime and recorded fixture", async () => {
  const value = fixture();
  process.env.NODE_ENV = "test";
  const receipt = await verifyAiAcceptanceAuthorityForTest(
    {
      candidateInputDirectory: value.candidateDirectory,
      contractManifest: value.contractPath,
      ghBinaryPath: "/trusted/gh",
      gitBinaryPath: "/trusted/git",
      recordedFixtureArchive: value.recordedFixtureArchive,
      repoRoot: "/repo",
      unzipBinaryPath: "/trusted/unzip",
      visionRepositoryPath: "/trusted/vision.git",
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
      verifyVisionCoreDelivery: async (input) => {
        assert.equal(input.candidate.sourceCommit, sourceCommit);
        assert.equal(
          input.candidate.subjectSha256,
          value.candidate.subjectSha256,
        );
        assert.equal(
          input.recordedFixtureArchive,
          value.recordedFixtureArchive,
        );
        return {
          runtimeArchive: {
            format: "vending-vision-candidate-artifact/v3",
            sha256: value.candidate.subjectSha256,
            sourceCommit,
          },
          recordedFixtureArchive: {
            format: "vending-vision-main-artifacts/v1",
            sha256: digest("recorded fixture\n"),
            sourceCommit,
          },
        };
      },
    },
  );
  assert.equal(receipt.schemaVersion, "vem.testbed.ai-acceptance-authority/v1");
  assert.equal(receipt.scope, "installed_windows_acceptance");
  assert.equal(receipt.trustStatus, "verified_for_acceptance");
  assert.equal(receipt.contract.bundleDigest, value.contract.bundleDigest);
  assert.equal(receipt.resources.workerExecutableSha256, "c".repeat(64));
  assert.deepEqual(receipt.proofCompanion, value.windows.proof.companion);
  assert.notEqual(
    receipt.visionCore.recordedFixtureArchive.sha256,
    receipt.proofCompanion.archiveSha256,
  );
  assert.equal(
    receipt.visionCore.runtimeArchive.sha256,
    receipt.candidate.subjectSha256,
  );
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
        gitBinaryPath: "/trusted/git",
        recordedFixtureArchive: value.recordedFixtureArchive,
        repoRoot: "/repo",
        unzipBinaryPath: "/trusted/unzip",
        visionRepositoryPath: "/trusted/vision.git",
        visionSourceRef: "refs/tags/v1.2.3-rc.1",
        windowsProofInputDirectory: "/windows-proof",
      },
      {
        verifyCandidateAttestation: async () => {},
        verifyWindowsProof: async (_input, consume) =>
          consume(value.windows, () => {}),
        verifyVisionCoreDelivery: async () => ({
          runtimeArchive: {
            format: "vending-vision-candidate-artifact/v3",
            sha256: value.candidate.subjectSha256,
            sourceCommit,
          },
          recordedFixtureArchive: {
            format: "vending-vision-main-artifacts/v1",
            sha256: digest("recorded fixture\n"),
            sourceCommit,
          },
        }),
      },
    ),
    /candidate subject does not match Windows proof/,
  );
});

test("binds the recorded fixture archive to the attested candidate source tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-fixture-authority-"));
  roots.push(root);
  const repository = join(root, "vision");
  const fixtureSource = join(repository, "fixtures", "recorded-video");
  mkdirSync(fixtureSource, { recursive: true });
  for (const [name, content] of [
    ["README.md", "recorded fixture\n"],
    ["expected-results.json", "{}\n"],
    ["front.mp4", "front\n"],
    ["top.mp4", "top\n"],
  ])
    writeFileSync(join(fixtureSource, name), content);
  execFileSync("/usr/bin/git", ["init", "-q", repository]);
  execFileSync("/usr/bin/git", ["-C", repository, "add", "."]);
  execFileSync("/usr/bin/git", [
    "-C",
    repository,
    "-c",
    "user.name=VEM Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  const commit = execFileSync("/usr/bin/git", [
    "-C",
    repository,
    "rev-parse",
    "HEAD",
  ])
    .toString("utf8")
    .trim();
  const stage = join(root, "stage");
  cpSync(fixtureSource, join(stage, "recorded-video"), { recursive: true });
  writeFileSync(
    join(stage, "vision-artifact.json"),
    JSON.stringify({
      schemaVersion: "vending-vision-main-artifacts/v1",
      commit,
      runtimeArchive: "vending-vision-windows-x86_64.zip",
      fixtureArchive: "vending-vision-test-fixtures.zip",
    }),
  );
  const archive = join(root, "recorded-fixtures.zip");
  execFileSync(
    "/usr/bin/zip",
    [
      "-q",
      archive,
      ...["README.md", "expected-results.json", "front.mp4", "top.mp4"].map(
        (name) => `recorded-video/${name}`,
      ),
      "vision-artifact.json",
    ],
    { cwd: stage },
  );
  const candidate = {
    sourceCommit: commit,
    subjectSha256: "a".repeat(64),
  };
  const delivery = await verifyVisionCoreDelivery({
    candidate,
    candidateArchive: join(root, "candidate.zip"),
    gitBinaryPath: "/usr/bin/git",
    recordedFixtureArchive: archive,
    unzipBinaryPath: "/usr/bin/unzip",
    visionRepositoryPath: repository,
  });
  assert.equal(delivery.runtimeArchive.sha256, candidate.subjectSha256);
  assert.equal(
    delivery.recordedFixtureArchive.sha256,
    digest(
      await import("node:fs").then(({ readFileSync }) => readFileSync(archive)),
    ),
  );
  writeFileSync(join(stage, "recorded-video", "top.mp4"), "forged\n");
  const forgedArchive = join(root, "forged-recorded-fixtures.zip");
  execFileSync(
    "/usr/bin/zip",
    [
      "-q",
      forgedArchive,
      ...["README.md", "expected-results.json", "front.mp4", "top.mp4"].map(
        (name) => `recorded-video/${name}`,
      ),
      "vision-artifact.json",
    ],
    { cwd: stage },
  );
  await assert.rejects(
    verifyVisionCoreDelivery({
      candidate,
      candidateArchive: join(root, "candidate.zip"),
      gitBinaryPath: "/usr/bin/git",
      recordedFixtureArchive: forgedArchive,
      unzipBinaryPath: "/usr/bin/unzip",
      visionRepositoryPath: repository,
    }),
    /top\.mp4 does not match trusted source commit/,
  );
});
