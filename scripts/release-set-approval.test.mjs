import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
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
  createReleaseSetApproval,
  verifyReleaseSetApprovalBinding,
} from "./release-set-approval.mjs";
import {
  generateReleaseSet,
  readReleaseRepositoryFacts,
} from "./release-set.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const workflowSha = "abcdef0123456789abcdef0123456789abcdef01";
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

describe("trusted release-set approval", () => {
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
});
