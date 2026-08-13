import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { derivePrecutoverEvidence } from "./precutover-receipts.mjs";
import {
  TRUSTED_RELEASE_SET_WORKFLOW_SHA,
  TRUSTED_VISION_BUILDER_SHA,
  TRUSTED_VISION_BUILDER_WORKFLOW,
  TRUSTED_VISION_REPOSITORY,
  createReleaseSetApproval,
  parseTrustedGhAttestationVerification,
  validateApprovedPrecutoverReceiptText,
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
const currentVisionBuilderSha = "691b5056e8b9bf2667bc527b2170780b05863946";

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

it("pins release approval to the current full Vision candidate-builder revision", () => {
  assert.equal(TRUSTED_VISION_BUILDER_SHA, currentVisionBuilderSha);
});

function pendingReceiptTexts() {
  const facts = readReleaseRepositoryFacts(repoRoot);
  const migration = {
    chainSha256: facts.database.migrationChainSha256,
    count: facts.database.migrationCount,
    target: facts.database.migrationTarget,
  };
  const catalogData = {
    associationCount: 1,
    garmentCount: 1,
    mediaAssetCount: 2,
    productCount: 1,
    sha256: digest("a"),
    variantCount: 1,
  };
  const databaseReceiptText = canonical({
    backup: {
      byteSize: 4096,
      format: "postgresql-custom",
      sha256: digest("b"),
    },
    restoreProof: {
      catalogData,
      constraintsSha256: digest("c"),
      databaseName: "vem_precutover_restore_123_abcdef012345",
      legacyResidue: {
        columns: 0,
        constraints: 0,
        indexes: 0,
        purposeRows: 0,
        storageReferences: 0,
      },
      migration,
      verifiedAt: "2026-08-11T00:00:01.000Z",
    },
    schemaVersion: "vem.precutover.database-backup.v1",
    source: {
      catalogData,
      currentLsn: "0/16B6C50",
      databaseName: "vem_production",
      migration,
      snapshotId: "00000003-0000001B-1",
      snapshotTime: "2026-08-11T00:00:00.000Z",
      systemIdentifier: "7654321098765432109",
    },
    toolchain: {
      docker: {
        byteSize: 123456,
        path: "/usr/bin/docker",
        sha256: digest("d"),
        version: "Docker version 28.0.0, build test",
      },
      image:
        "postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20",
      imageId: digest("e"),
      pgDump: { path: "/usr/bin/pg_dump", version: "16.10" },
      pgRestore: { path: "/usr/bin/pg_restore", version: "16.10" },
      psql: { path: "/usr/bin/psql", version: "16.10" },
      serverVersion: "160010",
    },
    trustStatus: "pending_release_set_approval",
  });
  const managedMediaReceiptText = canonical({
    assets: [
      {
        assetRevision: null,
        byteSize: 68,
        catalogRevision: "catalog-42",
        contentType: "image/png",
        digest: digest("f"),
        grantSha256: digest("1"),
        id: "00000000-0000-4000-8000-000000000001",
        loopbackPath: `/media/${digest("f")}`,
        purpose: "product_display_image",
        reference:
          "/api/media-assets/00000000-0000-4000-8000-000000000001/content",
      },
      {
        assetRevision: "garment-1",
        byteSize: 70,
        catalogRevision: "catalog-42",
        contentType: "image/png",
        digest: digest("2"),
        grantSha256: digest("3"),
        id: "00000000-0000-4000-8000-000000000002",
        loopbackPath: `/media/${digest("2")}`,
        purpose: "try_on_garment",
        reference:
          "/api/media-assets/00000000-0000-4000-8000-000000000002/content",
      },
    ],
    generation: "catalog-42",
    observedAt: "2026-08-11T00:00:02.000Z",
    origin: "http://127.0.0.1:4312",
    planogramVersion: "planogram-9",
    schemaVersion: "vem.precutover.managed-media.v1",
    trustStatus: "pending_release_set_approval",
  });
  return { databaseReceiptText, managedMediaReceiptText };
}

function writeApprovalInput(input, evidenceText, manifestText) {
  const receipts = pendingReceiptTexts();
  writeFileSync(join(input, "component-evidence.json"), evidenceText);
  writeFileSync(
    join(input, "database-backup-receipt.json"),
    receipts.databaseReceiptText,
  );
  writeFileSync(
    join(input, "managed-media-receipt.json"),
    receipts.managedMediaReceiptText,
  );
  writeFileSync(join(input, "release-set.json"), manifestText);
  return receipts;
}

function productionVerifyArgs({
  approvalPath,
  bundlePath,
  directory,
  ghBinary,
  inputDirectory,
}) {
  return [
    "scripts/release-set-approval.mjs",
    "verify",
    "--approval",
    approvalPath,
    "--attestation-bundle",
    bundlePath,
    "--database-backup",
    join(directory, "database.dump"),
    "--docker-binary",
    "/usr/bin/docker",
    "--expected-docker-byte-size",
    "1",
    "--expected-docker-sha256",
    digest("0"),
    "--expected-docker-version",
    "Docker version test",
    ...(ghBinary ? ["--gh-binary", ghBinary] : []),
    "--input-directory",
    inputDirectory,
    "--managed-media-origin",
    "http://127.0.0.1:4312",
    "--managed-media-token",
    "test-owned-token",
    "--output",
    join(directory, "approved.json"),
    "--postgres-container",
    "test-postgres",
    "--postgres-user",
    "postgres",
    "--repo-root",
    repoRoot,
    "--source-commit",
    sourceCommit,
    "--source-ref",
    sourceRef,
  ];
}

function evidence() {
  const facts = readReleaseRepositoryFacts(repoRoot);
  const receipts = pendingReceiptTexts();
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
    precutover: derivePrecutoverEvidence(
      receipts.databaseReceiptText,
      receipts.managedMediaReceiptText,
    ),
    schemaVersion: "vem.release-set.component-evidence.v1",
    vem: { sourceCommit },
    vision: {
      attestationBundleSha256: digest("2"),
      candidateSubjectSha256: digest("1"),
      embeddedManifestSha256: digest("3"),
      sourceCommit: "89abcdef0123456789abcdef0123456789abcdef",
      trustedBuilderEvidenceSha256: digest("4"),
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
  it("accepts only an exact canonical approved precutover receipt", () => {
    const stableMediaProof = {
      assetCount: 2,
      assetsSetSha256: digest("4"),
      generation: "catalog-42",
      planogramVersion: "planogram-9",
    };
    const emptyLegacyResidue = {
      columns: 0,
      constraints: 0,
      indexes: 0,
      purposeRows: 0,
      storageReferences: 0,
    };
    const receipt = {
      database: {
        backup: {
          byteSize: 4096,
          format: "postgresql-custom",
          sha256: digest("1"),
        },
        catalogDataSha256: digest("2"),
        constraintsSha256: digest("3"),
        legacyResidueSha256: sha256(canonical(emptyLegacyResidue)),
        migration: {
          chainSha256: digest("5"),
          count: 45,
          target: "20260810000000_hard_delete_legacy_try_on_data",
        },
        receiptSha256: digest("3"),
      },
      managedMedia: {
        assetCount: 2,
        assetsSetSha256: digest("4"),
        generation: "catalog-42",
        planogramVersion: "planogram-9",
        receiptSha256: digest("6"),
        stableMediaProofSha256: sha256(canonical(stableMediaProof)),
      },
      releaseApprovalSha256: digest("7"),
      releaseSetSha256: digest("8"),
      schemaVersion: "vem.precutover.approved.v1",
      sourceCommit,
      sourceRef,
    };
    assert.deepEqual(
      validateApprovedPrecutoverReceiptText(canonical(receipt)),
      receipt,
    );
    const legacyLiveProof = structuredClone(receipt);
    delete legacyLiveProof.managedMedia.stableMediaProofSha256;
    legacyLiveProof.managedMedia.liveProofSha256 = digest("5");
    for (const mutation of [
      { ...receipt, extra: true },
      { ...receipt, releaseApprovalSha256: digest("x") },
      legacyLiveProof,
      {
        ...receipt,
        managedMedia: { ...receipt.managedMedia, assetCount: 1.5 },
      },
      {
        ...receipt,
        managedMedia: {
          ...receipt.managedMedia,
          generation: "attacker-generation",
        },
      },
    ]) {
      assert.throws(() =>
        validateApprovedPrecutoverReceiptText(canonical(mutation)),
      );
    }
    assert.throws(() =>
      validateApprovedPrecutoverReceiptText(
        `${JSON.stringify(receipt, null, 2)}\n`,
      ),
    );
  });

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
      const receipts = writeApprovalInput(input, evidenceText, manifestText);
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
        databaseReceiptText: receipts.databaseReceiptText,
        managedMediaReceiptText: receipts.managedMediaReceiptText,
        manifestText,
        sourceCommit,
        sourceRef: "refs/tags/v1.2.3-rc.1",
        trustedWorkflowSha: workflowSha,
      });
      assert.equal(
        approval.inputArtifact.members["release-set.json"],
        sha256(manifestText),
      );
      assert.equal(
        approval.inputArtifact.members["component-evidence.json"],
        sha256(evidenceText),
      );
      assert.equal(
        approval.inputArtifact.members["database-backup-receipt.json"],
        sha256(receipts.databaseReceiptText),
      );
      assert.equal(
        approval.inputArtifact.members["managed-media-receipt.json"],
        sha256(receipts.managedMediaReceiptText),
      );
      assert.equal(
        approval.inputArtifact.aggregateSha256,
        sha256(canonical(approval.inputArtifact.members)),
      );
      assert.notEqual(approvalText, manifestText);
      assert.equal(approvalText, canonical(JSON.parse(approvalText)));
      assert.throws(() =>
        createReleaseSetApproval({
          attesterWorkflowSha: workflowSha,
          inputDirectory: input,
          outputPath: output,
          repoRoot,
          sourceCommit,
          sourceRef: "refs/tags/v1.2.3-rc.1",
        }),
      );
      assert.equal(readFileSync(output, "utf8"), approvalText);
      assert.deepEqual(
        readdirSync(directory).filter((name) => name.endsWith(".tmp")),
        [],
      );
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
      for (const kind of ["extra", "missing", "nested", "symlink"]) {
        const input = join(directory, kind);
        mkdirSync(input);
        writeApprovalInput(input, evidenceText, manifestText);
        if (kind === "extra") writeFileSync(join(input, "extra.json"), "{}\n");
        if (kind === "missing") {
          rmSync(join(input, "database-backup-receipt.json"));
        }
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
          /exactly four members|must be regular files/,
        );
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects rewritten, noncanonical, and raw-secret pending receipts", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "vem-release-receipt-tamper-"),
    );
    try {
      const componentEvidence = evidence();
      const evidenceText = canonical(componentEvidence);
      const manifestText = generateReleaseSet({
        evidence: componentEvidence,
        repoRoot,
      });
      for (const kind of [
        "rewritten",
        "unknown",
        "duplicate",
        "noncanonical",
        "unsafe-number",
        "unsafe-path",
        "raw-grant",
        "raw-token",
      ]) {
        const input = join(directory, kind);
        mkdirSync(input);
        writeApprovalInput(input, evidenceText, manifestText);
        const databasePath = join(input, "database-backup-receipt.json");
        const mediaPath = join(input, "managed-media-receipt.json");
        if (kind === "rewritten") {
          const receipt = JSON.parse(readFileSync(databasePath, "utf8"));
          receipt.backup.byteSize += 1;
          writeFileSync(databasePath, canonical(receipt));
        } else if (kind === "unknown") {
          const receipt = JSON.parse(readFileSync(databasePath, "utf8"));
          receipt.untrusted = true;
          writeFileSync(databasePath, canonical(receipt));
        } else if (kind === "duplicate") {
          const raw = readFileSync(databasePath, "utf8");
          writeFileSync(
            databasePath,
            raw.replace(
              '"schemaVersion":"vem.precutover.database-backup.v1"',
              '"schemaVersion":"vem.precutover.database-backup.v1","schemaVersion":"vem.precutover.database-backup.v1"',
            ),
          );
        } else if (kind === "noncanonical") {
          const receipt = JSON.parse(readFileSync(databasePath, "utf8"));
          writeFileSync(databasePath, `${JSON.stringify(receipt, null, 2)}\n`);
        } else if (kind === "unsafe-number") {
          const receipt = JSON.parse(readFileSync(databasePath, "utf8"));
          receipt.backup.byteSize = Number.MAX_SAFE_INTEGER + 1;
          writeFileSync(databasePath, canonical(receipt));
        } else if (kind === "unsafe-path") {
          const receipt = JSON.parse(readFileSync(databasePath, "utf8"));
          receipt.toolchain.docker.path = "./docker";
          writeFileSync(databasePath, canonical(receipt));
        } else {
          const receipt = JSON.parse(readFileSync(mediaPath, "utf8"));
          receipt.assets[0].loopbackPath +=
            kind === "raw-token" ? "?token=raw-secret" : "?grant=raw-secret";
          writeFileSync(mediaPath, canonical(receipt));
        }
        assert.throws(() =>
          createReleaseSetApproval({
            attesterWorkflowSha: workflowSha,
            inputDirectory: input,
            outputPath: join(directory, `${kind}-approval.json`),
            repoRoot,
            sourceCommit,
            sourceRef,
          }),
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
      const approvalPath = join(directory, "release-set-approval.json");
      const bundlePath = join(directory, "fake.sigstore.json");
      writeApprovalInput(input, evidenceText, manifestText);
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
        productionVerifyArgs({
          approvalPath,
          bundlePath,
          directory,
          ghBinary: "/usr/bin/gh",
          inputDirectory: input,
        }),
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /GitHub attestation verification failed/);
      assert.doesNotMatch(result.stderr, /production approval verified/);
      assert.equal(existsSync(join(directory, "approved.json")), false);
      assert.deepEqual(
        readdirSync(directory).filter((name) =>
          name.includes("approved-precutover.tmp"),
        ),
        [],
      );
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
      const approvalPath = join(directory, "release-set-approval.json");
      const bundlePath = join(directory, "fake.sigstore.json");
      writeApprovalInput(input, evidenceText, manifestText);
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
        productionVerifyArgs({
          approvalPath,
          bundlePath,
          directory,
          inputDirectory: input,
        }),
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
        productionVerifyArgs({
          approvalPath: join(directory, "missing-approval.json"),
          bundlePath: join(directory, "missing-bundle.json"),
          directory,
          ghBinary: fakeGh,
          inputDirectory: join(directory, "missing-input"),
        }),
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

  it("applies the same exact gh claim parser to the Vision builder authority", () => {
    const visionCommit = "89abcdef0123456789abcdef0123456789abcdef";
    const subjectSha256 = "1".repeat(64);
    const valid = ghVerificationFixture(canonical({ unused: true }));
    const certificate = valid[0].verificationResult.signature.certificate;
    const signerUri = `https://github.com/${TRUSTED_VISION_REPOSITORY}/${TRUSTED_VISION_BUILDER_WORKFLOW}@refs/heads/main`;
    Object.assign(certificate, {
      buildSignerDigest: TRUSTED_VISION_BUILDER_SHA,
      buildSignerURI: signerUri,
      githubWorkflowRepository: TRUSTED_VISION_REPOSITORY,
      issuer: "https://token.actions.githubusercontent.com",
      runnerEnvironment: "github-hosted",
      sourceRepositoryDigest: visionCommit,
      sourceRepositoryRef: sourceRef,
      sourceRepositoryURI: `https://github.com/${TRUSTED_VISION_REPOSITORY}`,
      subjectAlternativeName: signerUri,
    });
    valid[0].verificationResult.statement.subject = [
      {
        digest: { sha256: subjectSha256 },
        name: "vending-vision-1.2.3-rc.1-windows-x86_64.zip",
      },
    ];
    const authority = {
      repository: TRUSTED_VISION_REPOSITORY,
      subjectName: "vending-vision-1.2.3-rc.1-windows-x86_64.zip",
      subjectSha256,
      workflow: TRUSTED_VISION_BUILDER_WORKFLOW,
      workflowSha: TRUSTED_VISION_BUILDER_SHA,
    };
    assert.doesNotThrow(() =>
      parseTrustedGhAttestationVerification({
        authority,
        output: JSON.stringify(valid),
        sourceCommit: visionCommit,
        sourceRef,
      }),
    );
    for (const [claim, replacement] of [
      ["githubWorkflowRepository", "attacker/fork"],
      ["buildSignerDigest", "0".repeat(40)],
      ["sourceRepositoryDigest", "0".repeat(40)],
      ["sourceRepositoryRef", "refs/heads/unapproved"],
      ["runnerEnvironment", "self-hosted"],
    ]) {
      const mutation = structuredClone(valid);
      mutation[0].verificationResult.signature.certificate[claim] = replacement;
      assert.throws(() =>
        parseTrustedGhAttestationVerification({
          authority,
          output: JSON.stringify(mutation),
          sourceCommit: visionCommit,
          sourceRef,
        }),
      );
    }
  });
});
