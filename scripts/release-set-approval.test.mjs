import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  TRUSTED_RELEASE_SET_WORKFLOW_SHA,
  createReleaseSetApproval,
  parseTrustedGhAttestationVerification,
  verifyReleaseSetApprovalBinding,
} from "./release-set-approval.mjs";
import {
  generateReleaseSet,
  readReleaseRepositoryFacts,
} from "./release-set.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const workflowSha = "abcdef0123456789abcdef0123456789abcdef01";
const sourceRef = "refs/tags/v1.2.3-rc.1";
const digest = (character) => `sha256:${character.repeat(64)}`;
const sha256 = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

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

function evidence() {
  const facts = readReleaseRepositoryFacts(repoRoot);
  return {
    adminContracts: { evidenceSha256: digest("9") },
    ai: {
      modelDescriptorSha256: digest("7"),
      modelPackArchive: { byteSize: 123456, sha256: digest("8") },
      requirementsLockSha256: digest("6"),
      runtimeDescriptorSha256: digest("5"),
    },
    backend: {
      adminUi: {
        image: `registry.example/vem-admin-ui@${digest("c")}`,
        provenanceSha256: digest("d"),
        sourceCommit,
      },
      serviceApi: {
        image: `registry.example/vem-service-api@${digest("a")}`,
        provenanceSha256: digest("b"),
        sourceCommit,
      },
    },
    database: facts.database,
    schemaVersion: "vem.release-set.component-evidence.v1",
    vem: { sourceCommit },
    vision: {
      attestationBundleSha256: digest("2"),
      candidateSubjectSha256: digest("1"),
      embeddedManifestSha256: digest("3"),
      sourceCommit: "89abcdef0123456789abcdef0123456789abcdef",
      supplierEvidenceSha256: digest("4"),
    },
    visionV2Bundle: facts.visionV2Bundle,
    windowsRuntime: {
      archiveSha256: digest("e"),
      descriptorSha256: digest("f"),
      sourceCommit,
    },
  };
}

function ghVerificationFixture(approvalText) {
  const signerUri =
    "https://github.com/YKDZ/vem/.github/workflows/trusted-release-set-attester.yml@refs/heads/main";
  return [
    {
      attestation: {
        bundle: {},
        bundle_url: "",
        initiator: "",
      },
      verificationResult: {
        mediaType:
          "application/vnd.dev.sigstore.verificationresult+json;version=0.1",
        signature: {
          certificate: {
            buildConfigDigest: sourceCommit,
            buildConfigURI:
              "https://github.com/YKDZ/vem/.github/workflows/approve-release-set.yml@refs/heads/main",
            buildSignerDigest: TRUSTED_RELEASE_SET_WORKFLOW_SHA,
            buildSignerURI: signerUri,
            buildTrigger: "workflow_dispatch",
            certificateIssuer: "CN=sigstore-intermediate,O=sigstore.dev",
            githubWorkflowName: "Approve release set",
            githubWorkflowRef: sourceRef,
            githubWorkflowRepository: "YKDZ/vem",
            githubWorkflowSHA: sourceCommit,
            githubWorkflowTrigger: "workflow_dispatch",
            issuer: "https://token.actions.githubusercontent.com",
            runInvocationURI:
              "https://github.com/YKDZ/vem/actions/runs/1/attempts/1",
            runnerEnvironment: "github-hosted",
            sourceRepositoryDigest: sourceCommit,
            sourceRepositoryIdentifier: "123456",
            sourceRepositoryOwnerIdentifier: "7890",
            sourceRepositoryOwnerURI: "https://github.com/YKDZ",
            sourceRepositoryRef: sourceRef,
            sourceRepositoryURI: "https://github.com/YKDZ/vem",
            sourceRepositoryVisibilityAtSigning: "private",
            subjectAlternativeName: signerUri,
          },
        },
        statement: {
          _type: "https://in-toto.io/Statement/v1",
          predicate: { buildDefinition: {}, runDetails: {} },
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [
            {
              digest: {
                sha256: sha256(approvalText).slice("sha256:".length),
              },
              name: "release-set-approval.json",
            },
          ],
        },
        verifiedIdentity: {
          issuer: { issuer: "", regexp: ".*" },
          subjectAlternativeName: {
            regexp: "(?i)^https://github.com/YKDZ/vem/",
            subjectAlternativeName: "",
          },
        },
        verifiedTimestamps: [
          {
            timestamp: "2026-08-11T00:00:00Z",
            type: "Tlog",
            uri: "https://rekor.sigstore.dev",
          },
        ],
      },
    },
  ];
}

describe("trusted release-set approval", () => {
  it("tracks the minimized official gh 2.95 JSON claim structure", () => {
    const fixture = JSON.parse(
      readFileSync(
        join(
          repoRoot,
          "scripts/fixtures/gh-attestation-verification-v2.95.0.min.json",
        ),
        "utf8",
      ),
    );
    assert.deepEqual(Object.keys(fixture[0]).sort(), [
      "attestation",
      "verificationResult",
    ]);
    assert.equal(
      fixture[0].verificationResult.statement.subject[0].digest.sha256,
      "25d1e4729e8808c9ed3d613e96ebd3f3e44446f2d368c89d878a71a36ddb3d8c",
    );
    assert.equal(
      fixture[0].verificationResult.signature.certificate.runnerEnvironment,
      "github-hosted",
    );
  });

  it("creates a separate canonical approval binding manifest and evidence bytes", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-release-approval-"));
    try {
      const input = join(directory, "input");
      const output = join(directory, "release-set-approval.json");
      const componentEvidence = evidence();
      const evidenceText = canonical(componentEvidence);
      const manifestText = generateReleaseSet({
        evidence: componentEvidence,
        repoRoot,
      });
      mkdirSync(input);
      writeFileSync(join(input, "component-evidence.json"), evidenceText);
      writeFileSync(join(input, "release-set.json"), manifestText);
      createReleaseSetApproval({
        attesterWorkflowSha: workflowSha,
        inputDirectory: input,
        outputPath: output,
        repoRoot,
        sourceCommit,
        sourceRef: "refs/tags/v1.2.3-rc.1",
      });
      const approvalText = readFileSync(output, "utf8");
      const approval = verifyReleaseSetApprovalBinding({
        approvalText,
        componentEvidenceText: evidenceText,
        manifestText,
        sourceCommit,
        sourceRef: "refs/tags/v1.2.3-rc.1",
        trustedWorkflowSha: workflowSha,
      });
      assert.equal(approval.manifestSha256, sha256(manifestText));
      assert.equal(approval.componentEvidenceSha256, sha256(evidenceText));
      assert.notEqual(approvalText, manifestText);
      assert.equal(approvalText, canonical(JSON.parse(approvalText)));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects extra, nested, and symlink members after artifact extraction", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-release-members-"));
    try {
      const componentEvidence = evidence();
      const evidenceText = canonical(componentEvidence);
      const manifestText = generateReleaseSet({
        evidence: componentEvidence,
        repoRoot,
      });
      for (const kind of ["extra", "nested", "symlink"]) {
        const input = join(directory, kind);
        mkdirSync(input);
        writeFileSync(join(input, "component-evidence.json"), evidenceText);
        writeFileSync(join(input, "release-set.json"), manifestText);
        if (kind === "extra") writeFileSync(join(input, "extra.json"), "{}\n");
        if (kind === "nested") mkdirSync(join(input, "nested"));
        if (kind === "symlink") {
          rmSync(join(input, "release-set.json"));
          symlinkSync(
            "component-evidence.json",
            join(input, "release-set.json"),
          );
        }
        assert.throws(
          () =>
            createReleaseSetApproval({
              attesterWorkflowSha: workflowSha,
              inputDirectory: input,
              outputPath: join(directory, `${kind}.json`),
              repoRoot,
              sourceCommit,
              sourceRef: "refs/tags/v1.2.3-rc.1",
            }),
          /exactly two members|must be regular files/,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a locally generated approval without a valid GitHub attestation", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-release-fake-approval-"));
    try {
      const input = join(directory, "input");
      mkdirSync(input);
      const componentEvidence = evidence();
      const evidenceText = canonical(componentEvidence);
      const manifestText = generateReleaseSet({
        evidence: componentEvidence,
        repoRoot,
      });
      const evidencePath = join(input, "component-evidence.json");
      const manifestPath = join(input, "release-set.json");
      const approvalPath = join(directory, "release-set-approval.json");
      const bundlePath = join(directory, "fake.sigstore.json");
      writeFileSync(evidencePath, evidenceText);
      writeFileSync(manifestPath, manifestText);
      writeFileSync(bundlePath, "{}\n");
      createReleaseSetApproval({
        attesterWorkflowSha: workflowSha,
        inputDirectory: input,
        outputPath: approvalPath,
        repoRoot,
        sourceCommit,
        sourceRef: "refs/tags/v1.2.3-rc.1",
      });
      const result = spawnSync(
        process.execPath,
        [
          "scripts/release-set-approval.mjs",
          "verify",
          "--approval",
          approvalPath,
          "--attestation-bundle",
          bundlePath,
          "--evidence",
          evidencePath,
          "--gh-binary",
          "/usr/bin/gh",
          "--manifest",
          manifestPath,
          "--repo-root",
          repoRoot,
          "--source-commit",
          sourceCommit,
          "--source-ref",
          "refs/tags/v1.2.3-rc.1",
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /GitHub attestation verification failed/);
      assert.doesNotMatch(result.stderr, /production approval verified/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("never resolves production attestation verification through PATH", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-release-fake-path-"));
    try {
      const fakeDirectory = join(directory, "bin");
      const input = join(directory, "input");
      mkdirSync(fakeDirectory);
      mkdirSync(input);
      const marker = join(directory, "fake-gh-ran");
      const fakeGh = join(fakeDirectory, "gh");
      writeFileSync(fakeGh, '#!/bin/sh\n: > "$FAKE_GH_MARKER"\nexit 0\n');
      chmodSync(fakeGh, 0o755);
      const componentEvidence = evidence();
      const evidenceText = canonical(componentEvidence);
      const manifestText = generateReleaseSet({
        evidence: componentEvidence,
        repoRoot,
      });
      const evidencePath = join(input, "component-evidence.json");
      const manifestPath = join(input, "release-set.json");
      const approvalPath = join(directory, "release-set-approval.json");
      const bundlePath = join(directory, "fake.sigstore.json");
      writeFileSync(evidencePath, evidenceText);
      writeFileSync(manifestPath, manifestText);
      writeFileSync(bundlePath, "{}\n");
      createReleaseSetApproval({
        attesterWorkflowSha: workflowSha,
        inputDirectory: input,
        outputPath: approvalPath,
        repoRoot,
        sourceCommit,
        sourceRef: "refs/tags/v1.2.3-rc.1",
      });
      const result = spawnSync(
        process.execPath,
        [
          "scripts/release-set-approval.mjs",
          "verify",
          "--approval",
          approvalPath,
          "--attestation-bundle",
          bundlePath,
          "--evidence",
          evidencePath,
          "--manifest",
          manifestPath,
          "--repo-root",
          repoRoot,
          "--source-commit",
          sourceCommit,
          "--source-ref",
          "refs/tags/v1.2.3-rc.1",
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_GH_MARKER: marker,
            PATH: `${fakeDirectory}:${process.env.PATH}`,
          },
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /--gh-binary is required/);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a fake absolute gh binary before executing it", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-release-fake-gh-"));
    try {
      const fakeGh = join(directory, "gh");
      const marker = join(directory, "fake-gh-ran");
      writeFileSync(fakeGh, '#!/bin/sh\n: > "$FAKE_GH_MARKER"\nexit 0\n');
      chmodSync(fakeGh, 0o755);
      const result = spawnSync(
        process.execPath,
        [
          "scripts/release-set-approval.mjs",
          "verify",
          "--approval",
          join(directory, "missing-approval.json"),
          "--attestation-bundle",
          join(directory, "missing-bundle.json"),
          "--evidence",
          join(directory, "missing-evidence.json"),
          "--gh-binary",
          fakeGh,
          "--manifest",
          join(directory, "missing-manifest.json"),
          "--repo-root",
          repoRoot,
          "--source-commit",
          sourceCommit,
          "--source-ref",
          sourceRef,
        ],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, FAKE_GH_MARKER: marker },
        },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /trusted gh binary size or digest mismatch/);
      assert.equal(existsSync(marker), false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts only the exact official gh JSON result and trusted claims", () => {
    const approvalText = canonical({ approved: true });
    const valid = ghVerificationFixture(approvalText);
    assert.doesNotThrow(() =>
      parseTrustedGhAttestationVerification({
        approvalText,
        output: JSON.stringify(valid),
        sourceCommit,
        sourceRef,
      }),
    );
    const mutations = [
      "",
      "verified\n",
      "[]",
      JSON.stringify({}),
      JSON.stringify([{ ...valid[0], extra: true }]),
      JSON.stringify([
        {
          ...valid[0],
          verificationResult: {
            ...valid[0].verificationResult,
            extra: true,
          },
        },
      ]),
      JSON.stringify([
        {
          ...valid[0],
          verificationResult: {
            ...valid[0].verificationResult,
            signature: {
              certificate: {
                ...valid[0].verificationResult.signature.certificate,
                unexpectedClaim: "attacker-controlled",
              },
            },
          },
        },
      ]),
      JSON.stringify([
        {
          ...valid[0],
          verificationResult: {
            ...valid[0].verificationResult,
            signature: {
              certificate: {
                ...valid[0].verificationResult.signature.certificate,
                githubWorkflowRepository: "attacker/fork",
              },
            },
          },
        },
      ]),
      JSON.stringify([
        {
          ...valid[0],
          verificationResult: {
            ...valid[0].verificationResult,
            signature: {
              certificate: {
                ...valid[0].verificationResult.signature.certificate,
                buildSignerDigest: "0".repeat(40),
              },
            },
          },
        },
      ]),
      JSON.stringify([
        {
          ...valid[0],
          verificationResult: {
            ...valid[0].verificationResult,
            signature: {
              certificate: {
                ...valid[0].verificationResult.signature.certificate,
                sourceRepositoryDigest: "0".repeat(40),
              },
            },
          },
        },
      ]),
      JSON.stringify([
        {
          ...valid[0],
          verificationResult: {
            ...valid[0].verificationResult,
            signature: {
              certificate: {
                ...valid[0].verificationResult.signature.certificate,
                sourceRepositoryRef: "refs/heads/unapproved",
              },
            },
          },
        },
      ]),
      JSON.stringify([
        {
          ...valid[0],
          verificationResult: {
            ...valid[0].verificationResult,
            signature: {
              certificate: {
                ...valid[0].verificationResult.signature.certificate,
                runnerEnvironment: "self-hosted",
              },
            },
          },
        },
      ]),
      JSON.stringify([
        {
          ...valid[0],
          verificationResult: {
            ...valid[0].verificationResult,
            statement: {
              ...valid[0].verificationResult.statement,
              subject: [
                {
                  digest: { sha256: "0".repeat(64) },
                  name: "release-set-approval.json",
                },
              ],
            },
          },
        },
      ]),
    ];
    for (const output of mutations) {
      assert.throws(() =>
        parseTrustedGhAttestationVerification({
          approvalText,
          output,
          sourceCommit,
          sourceRef,
        }),
      );
    }
  });
});
