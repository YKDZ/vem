import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { finalizePrecutoverAiForTest } from "./precutover-ai.mjs";
import { parseWindowsProofGhClaimsForTest } from "./precutover-windows-proof.mjs";

const roots = [];
const repoRoot = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const workflowSha = "4b345b29c581af078ed1ec36edcac080cca0e7fd";
const sourceCommit = "a".repeat(40);
const sourceRef = "refs/tags/v1.2.3-rc.1";

afterEach(() => {
  while (roots.length > 0)
    rmSync(roots.pop(), { recursive: true, force: true });
});

function canonical(value) {
  const sort = (item) => {
    if (Array.isArray(item)) return item.map(sort);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(
        Object.keys(item)
          .sort()
          .map((key) => [key, sort(item[key])]),
      );
    }
    return item;
  };
  return `${JSON.stringify(sort(value))}\n`;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vem-windows-proof-test-"));
  roots.push(root);
  const input = join(root, "windows-proof");
  mkdirSync(input);
  const proof = {
    candidate: {
      attestationBundleSha256: "1".repeat(64),
      embeddedManifestSha256: "2".repeat(64),
      sourceCommit,
      subjectSha256: "3".repeat(64),
      trustedBuilderEvidenceSha256: "f".repeat(64),
      workerExecutableSha256: "4".repeat(64),
      workerMode: "frozen-windows",
    },
    modelPack: {
      archive: { byteSize: 123, sha256: "5".repeat(64) },
      descriptorSha256: "6".repeat(64),
      sourceRevision: "7".repeat(40),
    },
    probes: {
      model: {
        catvtonSourceRevision: "7".repeat(40),
        probe: "official-catvton-worker",
        torch: "2.8.0+cpu",
      },
      runtime: {
        catvtonSourceRevision: "7".repeat(40),
        probe: "official-catvton-worker-runtime",
        torch: "2.8.0+cpu",
      },
    },
    resources: {
      aiLockSha256: "8".repeat(64),
      runtimeDescriptorSha256: "9".repeat(64),
      sourceDescriptorSha256: "b".repeat(64),
    },
    companion: {
      archiveSha256: "c".repeat(64),
      descriptorSha256: "d".repeat(64),
      sourceCommit: "e".repeat(40),
    },
    schemaVersion: "vending-vision-precutover-proof/v2",
  };
  const proofText = canonical(proof);
  const bundleText = canonical({ testOwned: "deterministic claim fixture" });
  const evidence = {
    attestation: { sha256: digest(bundleText) },
    companion: {
      archiveSha256: "c".repeat(64),
      descriptorSha256: "d".repeat(64),
      sourceCommit: "e".repeat(40),
    },
    inputIdentity: {
      candidate: {
        attestationSha256: proof.candidate.attestationBundleSha256,
        trustedBuilderEvidenceSha256: "f".repeat(64),
        manifestSha256: proof.candidate.embeddedManifestSha256,
        sourceCommit,
        subjectSha256: proof.candidate.subjectSha256,
      },
      modelPack: {
        byteSize: proof.modelPack.archive.byteSize,
        descriptorSha256: proof.modelPack.descriptorSha256,
        sha256: proof.modelPack.archive.sha256,
        sourceRevision: proof.modelPack.sourceRevision,
      },
      resources: {
        aiLockSha256: proof.resources.aiLockSha256,
        runtimeDescriptorSha256: proof.resources.runtimeDescriptorSha256,
        sourceDescriptorSha256: proof.resources.sourceDescriptorSha256,
        workerExecutableSha256: proof.candidate.workerExecutableSha256,
      },
      schemaVersion: "vending-vision-trusted-precutover-inputs/v1",
    },
    proof: {
      byteSize: Buffer.byteLength(proofText),
      sha256: digest(proofText),
    },
    schemaVersion: "vending-vision-trusted-precutover-proof-evidence/v1",
    workflow: {
      repository: "hbhjt/vending-vision",
      sha: workflowSha,
      workflow: ".github/workflows/trusted-precutover-companion-proof.yml",
    },
  };
  writeFileSync(join(input, "precutover-ai-proof.json"), proofText);
  writeFileSync(join(input, "precutover-ai-proof.sigstore.json"), bundleText);
  writeFileSync(
    join(input, "trusted-precutover-proof-evidence.json"),
    canonical(evidence).trimEnd(),
  );
  const output = join(root, "precutover-ai-final.json");
  return { evidence, input, output, proof, proofText, root };
}

function runtimeProof(value) {
  return {
    receipt: {
      identityRoot: {
        approvedPrecutoverSha256: `sha256:${"0".repeat(64)}`,
        releaseApprovalSha256: `sha256:${"1".repeat(64)}`,
        releaseSetSha256: `sha256:${"2".repeat(64)}`,
      },
      vision: {
        attestationBundleSha256: `sha256:${value.proof.candidate.attestationBundleSha256}`,
        archive: {
          byteSize: 456,
          sha256: `sha256:${value.proof.candidate.subjectSha256}`,
        },
        bindings: {
          aiLock: { sha256: `sha256:${value.proof.resources.aiLockSha256}` },
          modelPackDescriptor: {
            sha256: `sha256:${value.proof.modelPack.descriptorSha256}`,
          },
          runtimeDescriptor: {
            sha256: `sha256:${value.proof.resources.runtimeDescriptorSha256}`,
          },
          sourceDescriptor: {
            sha256: `sha256:${value.proof.resources.sourceDescriptorSha256}`,
          },
          workerExecutable: {
            sha256: `sha256:${value.proof.candidate.workerExecutableSha256}`,
          },
        },
        embeddedManifestSha256: `sha256:${value.proof.candidate.embeddedManifestSha256}`,
        sourceCommit,
        trustedBuilderEvidenceSha256: `sha256:${value.proof.candidate.trustedBuilderEvidenceSha256}`,
      },
    },
    releaseSet: {
      ai: {
        modelDescriptorSha256: `sha256:${value.proof.modelPack.descriptorSha256}`,
        modelPackArchive: {
          byteSize: value.proof.modelPack.archive.byteSize,
          sha256: `sha256:${value.proof.modelPack.archive.sha256}`,
        },
        requirementsLockSha256: `sha256:${value.proof.resources.aiLockSha256}`,
        runtimeDescriptorSha256: `sha256:${value.proof.resources.runtimeDescriptorSha256}`,
      },
      vision: {
        attestationBundleSha256: `sha256:${value.proof.candidate.attestationBundleSha256}`,
        candidateSubjectSha256: `sha256:${value.proof.candidate.subjectSha256}`,
        embeddedManifestSha256: `sha256:${value.proof.candidate.embeddedManifestSha256}`,
        sourceCommit,
        trustedBuilderEvidenceSha256: `sha256:${value.proof.candidate.trustedBuilderEvidenceSha256}`,
      },
    },
  };
}

function ghClaims(proofText) {
  const signer = `https://github.com/hbhjt/vending-vision/.github/workflows/trusted-precutover-companion-proof.yml@${sourceRef}`;
  const certificate = Object.fromEntries(
    [
      "buildConfigDigest",
      "buildConfigURI",
      "buildTrigger",
      "certificateIssuer",
      "githubWorkflowName",
      "githubWorkflowRef",
      "githubWorkflowSHA",
      "githubWorkflowTrigger",
      "runInvocationURI",
      "sourceRepositoryIdentifier",
      "sourceRepositoryOwnerIdentifier",
      "sourceRepositoryOwnerURI",
      "sourceRepositoryVisibilityAtSigning",
    ].map((key) => [key, "fixture"]),
  );
  Object.assign(certificate, {
    buildSignerDigest: workflowSha,
    buildSignerURI: signer,
    githubWorkflowRepository: "hbhjt/vending-vision",
    issuer: "https://token.actions.githubusercontent.com",
    runnerEnvironment: "github-hosted",
    sourceRepositoryDigest: sourceCommit,
    sourceRepositoryRef: sourceRef,
    sourceRepositoryURI: "https://github.com/hbhjt/vending-vision",
    subjectAlternativeName: signer,
  });
  return [
    {
      attestation: { bundle: {}, bundle_url: "fixture", initiator: "fixture" },
      verificationResult: {
        mediaType:
          "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
        signature: { certificate },
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicate: {},
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [
            {
              digest: { sha256: digest(proofText) },
              name: "precutover-ai-proof.json",
            },
          ],
        },
        verifiedIdentity: {
          issuer: { issuer: "fixture", regexp: "fixture" },
          subjectAlternativeName: {
            regexp: "fixture",
            subjectAlternativeName: "fixture",
          },
        },
        verifiedTimestamps: [
          { timestamp: "2026-08-12T00:00:00Z", type: "Tlog", uri: "fixture" },
        ],
      },
    },
  ];
}

describe("pre-cutover Windows proof finalizer", () => {
  it("finalizes on Linux without a model archive, Windows Python, or Vision verifier root", async () => {
    const value = fixture();
    const events = [];
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const result = await finalizePrecutoverAiForTest(
        {
          output: value.output,
          "repo-root": repoRoot,
          "source-commit": sourceCommit,
          "source-ref": sourceRef,
          "windows-proof-input-directory": value.input,
        },
        {
          async proveRuntimeArtifacts() {
            events.push("fresh-linux-runtime-proof");
            return runtimeProof(value);
          },
          async verifyWindowsProofAttestation(context) {
            events.push("trusted-windows-proof-attestation");
            assert.equal(context.subjectSha256, digest(value.proofText));
            return { hostedRunner: true, results: 1 };
          },
        },
      );
      assert.equal(result.schemaVersion, "vem.precutover.ai.v2");
      assert.deepEqual(result.windowsProof.companion, value.proof.companion);
      assert.deepEqual(result.windowsProof.candidate, {
        attestationBundleSha256: value.proof.candidate.attestationBundleSha256,
        trustedBuilderEvidenceSha256:
          value.proof.candidate.trustedBuilderEvidenceSha256,
      });
      assert.equal(
        result.windowsProof.proofAttestationBundleSha256,
        `sha256:${digest(
          canonical({ testOwned: "deterministic claim fixture" }),
        )}`,
      );
      assert.equal(
        result.windowsProof.signedProofSha256,
        `sha256:${digest(value.proofText)}`,
      );
      assert.match(
        result.windowsProof.trustedProofEvidenceSha256,
        /^sha256:[a-f0-9]{64}$/,
      );
      assert.equal("proofSha256" in result.windowsProof, false);
      assert.equal("evidenceSha256" in result.windowsProof, false);
      assert.deepEqual(events, [
        "fresh-linux-runtime-proof",
        "trusted-windows-proof-attestation",
      ]);
    } finally {
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  it("rejects a source exact-three member replaced while attestation is verified", async () => {
    const value = fixture();
    const target = join(value.input, "precutover-ai-proof.json");
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      await assert.rejects(
        finalizePrecutoverAiForTest(
          {
            output: value.output,
            "repo-root": repoRoot,
            "source-ref": sourceRef,
            "windows-proof-input-directory": value.input,
          },
          {
            async proveRuntimeArtifacts() {
              return runtimeProof(value);
            },
            async verifyWindowsProofAttestation() {
              const replacement = `${target}.replacement`;
              writeFileSync(replacement, value.proofText);
              renameSync(replacement, target);
            },
          },
        ),
        /identity changed|content changed/,
      );
      assert.equal(existsSync(value.output), false);
    } finally {
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  it("rejects a source exact-three member rewritten in place while attestation is verified", async () => {
    const value = fixture();
    const target = join(value.input, "precutover-ai-proof.json");
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      await assert.rejects(
        finalizePrecutoverAiForTest(
          {
            output: value.output,
            "repo-root": repoRoot,
            "source-ref": sourceRef,
            "windows-proof-input-directory": value.input,
          },
          {
            async proveRuntimeArtifacts() {
              return runtimeProof(value);
            },
            async verifyWindowsProofAttestation() {
              writeFileSync(target, value.proofText);
            },
          },
        ),
        /identity changed|content changed/,
      );
      assert.equal(existsSync(value.output), false);
    } finally {
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  it("reruns fresh Linux and Windows proofs on replay instead of trusting the old receipt", async () => {
    const first = fixture();
    const second = fixture();
    const events = [];
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      for (const value of [first, second]) {
        await finalizePrecutoverAiForTest(
          {
            output: value.output,
            "repo-root": repoRoot,
            "source-ref": sourceRef,
            "windows-proof-input-directory": value.input,
          },
          {
            async proveRuntimeArtifacts() {
              events.push("fresh-linux");
              return runtimeProof(value);
            },
            async verifyWindowsProofAttestation() {
              events.push("fresh-windows");
            },
          },
        );
      }
      assert.deepEqual(events, [
        "fresh-linux",
        "fresh-windows",
        "fresh-linux",
        "fresh-windows",
      ]);
    } finally {
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  it("rejects Windows model facts that differ from the fresh release-set proof", async () => {
    const value = fixture();
    const fresh = runtimeProof(value);
    fresh.releaseSet.ai.modelPackArchive.byteSize += 1;
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      await assert.rejects(
        finalizePrecutoverAiForTest(
          {
            output: value.output,
            "repo-root": repoRoot,
            "source-ref": sourceRef,
            "windows-proof-input-directory": value.input,
          },
          {
            async proveRuntimeArtifacts() {
              return fresh;
            },
            async verifyWindowsProofAttestation() {
              return { hostedRunner: true, results: 1 };
            },
          },
        ),
        /model archive size does not match fresh Linux proof/,
      );
      assert.equal(existsSync(value.output), false);
    } finally {
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  for (const [label, mutate] of [
    [
      "candidate attestation bundle",
      (fresh) =>
        (fresh.releaseSet.vision.attestationBundleSha256 = `sha256:${"0".repeat(64)}`),
    ],
    [
      "candidate trusted builder evidence",
      (fresh) =>
        (fresh.releaseSet.vision.trustedBuilderEvidenceSha256 = `sha256:${"0".repeat(64)}`),
    ],
    [
      "fresh runtime attestation bundle",
      (fresh) =>
        (fresh.receipt.vision.attestationBundleSha256 = `sha256:${"0".repeat(64)}`),
    ],
    [
      "fresh runtime trusted builder evidence",
      (fresh) =>
        (fresh.receipt.vision.trustedBuilderEvidenceSha256 = `sha256:${"0".repeat(64)}`),
    ],
  ]) {
    it(`rejects a bypassed ${label} identity`, async () => {
      const value = fixture();
      const fresh = runtimeProof(value);
      mutate(fresh);
      const prior = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";
      try {
        await assert.rejects(
          finalizePrecutoverAiForTest(
            {
              output: value.output,
              "repo-root": repoRoot,
              "source-ref": sourceRef,
              "windows-proof-input-directory": value.input,
            },
            {
              async proveRuntimeArtifacts() {
                return fresh;
              },
              async verifyWindowsProofAttestation() {},
            },
          ),
          /does not match fresh Linux proof/,
        );
        assert.equal(existsSync(value.output), false);
      } finally {
        if (prior === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prior;
      }
    });
  }

  it("accepts exactly one hosted GitHub result from the pinned B1 workflow", () => {
    const value = fixture();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      assert.doesNotThrow(() =>
        parseWindowsProofGhClaimsForTest({
          output: JSON.stringify(ghClaims(value.proofText)),
          sourceCommit,
          sourceRef,
          subjectSha256: digest(value.proofText),
        }),
      );
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  for (const [name, mutate] of [
    [
      "subject",
      (claim) =>
        (claim.verificationResult.statement.subject[0].digest.sha256 =
          "0".repeat(64)),
    ],
    [
      "repository",
      (claim) =>
        (claim.verificationResult.signature.certificate.githubWorkflowRepository =
          "attacker/repo"),
    ],
    [
      "workflow",
      (claim) =>
        (claim.verificationResult.signature.certificate.buildSignerURI =
          "https://github.com/attacker/repo/workflow.yml@refs/tags/v1"),
    ],
    [
      "signer digest",
      (claim) =>
        (claim.verificationResult.signature.certificate.buildSignerDigest =
          "0".repeat(40)),
    ],
    [
      "source ref",
      (claim) =>
        (claim.verificationResult.signature.certificate.sourceRepositoryRef =
          "refs/heads/main"),
    ],
    [
      "source digest",
      (claim) =>
        (claim.verificationResult.signature.certificate.sourceRepositoryDigest =
          "0".repeat(40)),
    ],
    [
      "hosted runner",
      (claim) =>
        (claim.verificationResult.signature.certificate.runnerEnvironment =
          "self-hosted"),
    ],
  ]) {
    it(`rejects a wrong GitHub ${name} claim`, () => {
      const value = fixture();
      const claims = ghClaims(value.proofText);
      mutate(claims[0]);
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";
      try {
        assert.throws(() =>
          parseWindowsProofGhClaimsForTest({
            output: JSON.stringify(claims),
            sourceCommit,
            sourceRef,
            subjectSha256: digest(value.proofText),
          }),
        );
      } finally {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
      }
    });
  }

  it("rejects zero or multiple GitHub proof results", () => {
    const value = fixture();
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      for (const claims of [
        [],
        [ghClaims(value.proofText)[0], ghClaims(value.proofText)[0]],
      ]) {
        assert.throws(() =>
          parseWindowsProofGhClaimsForTest({
            output: JSON.stringify(claims),
            sourceCommit,
            sourceRef,
            subjectSha256: digest(value.proofText),
          }),
        );
      }
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  for (const mutation of [
    {
      name: "an extra member",
      apply(value) {
        writeFileSync(join(value.input, "extra.json"), "{}\n");
      },
      error: /exactly three members/,
    },
    {
      name: "a case-variant member",
      apply(value) {
        const from = join(value.input, "precutover-ai-proof.json");
        const to = join(value.input, "PRECUTOVER-AI-PROOF.JSON");
        renameSync(from, to);
      },
      error: /exactly three members/,
    },
    {
      name: "noncanonical proof JSON",
      apply(value) {
        writeFileSync(
          join(value.input, "precutover-ai-proof.json"),
          JSON.stringify(value.proof, null, 2),
        );
      },
      error: /not canonical JSON/,
    },
    {
      name: "a proof digest not bound by the signed evidence",
      apply(value) {
        value.proof.resources.aiLockSha256 = "0".repeat(64);
        writeFileSync(
          join(value.input, "precutover-ai-proof.json"),
          canonical(value.proof),
        );
      },
      error: /binding mismatch/,
    },
    {
      name: "companion evidence rewritten beside the signed proof",
      apply(value) {
        value.evidence.companion.archiveSha256 = "0".repeat(64);
        writeFileSync(
          join(value.input, "trusted-precutover-proof-evidence.json"),
          canonical(value.evidence).trimEnd(),
        );
      },
      error: /binding mismatch/,
    },
    {
      name: "builder evidence identity rewritten beside the signed proof",
      apply(value) {
        value.evidence.inputIdentity.candidate.trustedBuilderEvidenceSha256 =
          "0".repeat(64);
        writeFileSync(
          join(value.input, "trusted-precutover-proof-evidence.json"),
          canonical(value.evidence).trimEnd(),
        );
      },
      error: /binding mismatch/,
    },
  ]) {
    it(`rejects ${mutation.name} before accepting attestation claims`, async () => {
      const value = fixture();
      mutation.apply(value);
      let attestationCalls = 0;
      const prior = process.env.NODE_ENV;
      process.env.NODE_ENV = "test";
      try {
        await assert.rejects(
          finalizePrecutoverAiForTest(
            {
              output: value.output,
              "repo-root": repoRoot,
              "source-ref": sourceRef,
              "windows-proof-input-directory": value.input,
            },
            {
              async proveRuntimeArtifacts() {
                return runtimeProof(value);
              },
              async verifyWindowsProofAttestation() {
                attestationCalls += 1;
              },
            },
          ),
          mutation.error,
        );
      } finally {
        if (prior === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = prior;
      }
      assert.equal(attestationCalls, 0);
    });
  }
});
