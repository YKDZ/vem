import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  generateReleaseSet,
  readReleaseRepositoryFacts,
  verifyReleaseSet,
} from "./release-set.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
const vemCommit = "0123456789abcdef0123456789abcdef01234567";
const visionCommit = "89abcdef0123456789abcdef0123456789abcdef";
const digest = (character) => `sha256:${character.repeat(64)}`;
const hashText = (text) =>
  `sha256:${createHash("sha256").update(text).digest("hex")}`;

function componentEvidence() {
  const repository = readReleaseRepositoryFacts(repoRoot);
  return {
    schemaVersion: "vem.release-set.component-evidence.v1",
    vem: { sourceCommit: vemCommit },
    backend: {
      serviceApi: {
        image: `registry.example/vem-service-api@${digest("a")}`,
        provenanceSha256: digest("b"),
        sourceCommit: vemCommit,
      },
      adminUi: {
        image: `registry.example/vem-admin-ui@${digest("c")}`,
        provenanceSha256: digest("d"),
        sourceCommit: vemCommit,
      },
    },
    windowsRuntime: {
      archiveSha256: digest("e"),
      descriptorSha256: digest("f"),
      sourceCommit: vemCommit,
    },
    vision: {
      sourceCommit: visionCommit,
      candidateSubjectSha256: digest("1"),
      attestationBundleSha256: digest("2"),
      embeddedManifestSha256: digest("3"),
      supplierEvidenceSha256: digest("4"),
    },
    visionV2Bundle: {
      bundleSha256: repository.visionV2Bundle.bundleSha256,
    },
    ai: {
      runtimeDescriptorSha256: digest("5"),
      requirementsLockSha256: digest("6"),
      modelDescriptorSha256: digest("7"),
      modelPackArchive: { byteSize: 123456, sha256: digest("8") },
    },
    database: repository.database,
    adminContracts: { evidenceSha256: digest("9") },
  };
}

function setPath(value, path, replacement) {
  const copy = structuredClone(value);
  let owner = copy;
  for (const key of path.slice(0, -1)) owner = owner[key];
  owner[path.at(-1)] = replacement;
  return copy;
}

describe("canonical release-set identity", () => {
  it("generates and verifies one exact manifest against external trust", () => {
    const evidence = componentEvidence();
    const manifestText = generateReleaseSet({ evidence, repoRoot });
    const manifest = verifyReleaseSet({
      componentEvidence: evidence,
      expectedManifestSha256: hashText(manifestText),
      manifestText,
      repoRoot,
    });

    assert.equal(manifest.schemaVersion, "vem.release-set.v1");
    assert.equal(manifest.vem.sourceCommit, vemCommit);
    assert.equal(manifest.backend.serviceApi.sourceCommit, vemCommit);
    assert.equal(manifest.backend.adminUi.sourceCommit, vemCommit);
    assert.equal(
      manifest.visionV2Bundle.bundleSha256,
      evidence.visionV2Bundle.bundleSha256,
    );
    assert.equal(manifest.database.migrationCount, 45);
    assert.match(manifestText, /\n$/);
  });

  it("rejects mixed backend commits through the release-set verifier", () => {
    const evidence = componentEvidence();
    evidence.backend.adminUi.sourceCommit = "f".repeat(40);
    assert.throws(
      () => generateReleaseSet({ evidence, repoRoot }),
      /backend release components must use the VEM source commit/,
    );
  });

  it("binds generated contracts and the database chain to repository facts", () => {
    const wrongBundle = componentEvidence();
    wrongBundle.visionV2Bundle.bundleSha256 = digest("0");
    assert.throws(
      () => generateReleaseSet({ evidence: wrongBundle, repoRoot }),
      /does not match the generated VEM bundle/,
    );

    const wrongDatabase = componentEvidence();
    wrongDatabase.database.migrationCount -= 1;
    assert.throws(
      () => generateReleaseSet({ evidence: wrongDatabase, repoRoot }),
      /does not match the VEM migration chain/,
    );
  });

  it("requires an externally supplied exact manifest digest", () => {
    const evidence = componentEvidence();
    const manifestText = generateReleaseSet({ evidence, repoRoot });
    assert.throws(
      () =>
        verifyReleaseSet({
          componentEvidence: evidence,
          manifestText,
          repoRoot,
        }),
      /external expected manifest SHA-256 is required/,
    );
    assert.throws(
      () =>
        verifyReleaseSet({
          componentEvidence: evidence,
          expectedManifestSha256: digest("0"),
          manifestText,
          repoRoot,
        }),
      /release-set manifest digest mismatch/,
    );
  });

  it("rejects unknown, missing, duplicate, and noncanonical manifest fields", () => {
    const evidence = componentEvidence();
    const manifestText = generateReleaseSet({ evidence, repoRoot });
    const parsed = JSON.parse(manifestText);
    const variants = [
      JSON.stringify({ ...parsed, identity: digest("a") }) + "\n",
      JSON.stringify({ ...parsed, adminContracts: undefined }) + "\n",
      manifestText.replace(
        '"schemaVersion":"vem.release-set.v1"',
        '"schemaVersion":"vem.release-set.v1","schemaVersion":"vem.release-set.v1"',
      ),
      JSON.stringify(parsed, null, 2) + "\n",
    ];
    for (const variant of variants) {
      assert.throws(() =>
        verifyReleaseSet({
          componentEvidence: evidence,
          expectedManifestSha256: hashText(variant),
          manifestText: variant,
          repoRoot,
        }),
      );
    }
  });

  it("rejects unknown and missing component evidence before generation", () => {
    const evidence = componentEvidence();
    assert.throws(
      () =>
        generateReleaseSet({
          evidence: { ...evidence, manifestSha256: digest("a") },
          repoRoot,
        }),
      /component evidence must contain exactly/,
    );
    const missing = structuredClone(evidence);
    delete missing.ai.requirementsLockSha256;
    assert.throws(
      () => generateReleaseSet({ evidence: missing, repoRoot }),
      /component evidence.ai must contain exactly/,
    );
  });

  it("rejects every component field mutation even when its digest is self-recomputed", () => {
    const evidence = componentEvidence();
    const manifest = JSON.parse(generateReleaseSet({ evidence, repoRoot }));
    const mutations = [
      [["vem", "sourceCommit"], "f".repeat(40)],
      [
        ["backend", "serviceApi", "image"],
        `registry.example/other@${digest("a")}`,
      ],
      [["backend", "serviceApi", "provenanceSha256"], digest("0")],
      [["backend", "serviceApi", "sourceCommit"], "f".repeat(40)],
      [
        ["backend", "adminUi", "image"],
        `registry.example/other@${digest("c")}`,
      ],
      [["backend", "adminUi", "provenanceSha256"], digest("0")],
      [["backend", "adminUi", "sourceCommit"], "f".repeat(40)],
      [["windowsRuntime", "archiveSha256"], digest("0")],
      [["windowsRuntime", "descriptorSha256"], digest("0")],
      [["windowsRuntime", "sourceCommit"], "f".repeat(40)],
      [["vision", "sourceCommit"], "f".repeat(40)],
      [["vision", "candidateSubjectSha256"], digest("0")],
      [["vision", "attestationBundleSha256"], digest("0")],
      [["vision", "embeddedManifestSha256"], digest("0")],
      [["vision", "supplierEvidenceSha256"], digest("0")],
      [["visionV2Bundle", "bundleSha256"], digest("0")],
      [["ai", "runtimeDescriptorSha256"], digest("0")],
      [["ai", "requirementsLockSha256"], digest("0")],
      [["ai", "modelDescriptorSha256"], digest("0")],
      [["ai", "modelPackArchive", "byteSize"], 123457],
      [["ai", "modelPackArchive", "sha256"], digest("0")],
      [["database", "migrationTarget"], "20990101000000_wrong"],
      [["database", "migrationCount"], 44],
      [["database", "migrationChainSha256"], digest("0")],
      [["adminContracts", "evidenceSha256"], digest("0")],
    ];

    for (const [path, replacement] of mutations) {
      const changed = setPath(manifest, path, replacement);
      const changedText = `${JSON.stringify(changed)}\n`;
      assert.throws(
        () =>
          verifyReleaseSet({
            componentEvidence: evidence,
            expectedManifestSha256: hashText(changedText),
            manifestText: changedText,
            repoRoot,
          }),
        `accepted mutation at ${path.join(".")}`,
      );
    }
  });

  it("does not accept the candidate manifest as synonymous component evidence", () => {
    const evidence = componentEvidence();
    const manifestText = generateReleaseSet({ evidence, repoRoot });
    assert.throws(
      () =>
        verifyReleaseSet({
          componentEvidence: JSON.parse(manifestText),
          expectedManifestSha256: hashText(manifestText),
          manifestText,
          repoRoot,
        }),
      /component evidence schemaVersion/,
    );
  });

  it("provides generate and verify CLI commands without deriving expected trust", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-release-set-"));
    try {
      const evidencePath = join(directory, "evidence.json");
      const manifestPath = join(directory, "release-set.json");
      const evidence = componentEvidence();
      writeFileSync(evidencePath, `${JSON.stringify(evidence)}\n`);
      execFileSync(
        process.execPath,
        [
          "scripts/release-set.mjs",
          "generate",
          "--evidence",
          evidencePath,
          "--output",
          manifestPath,
          "--repo-root",
          repoRoot,
        ],
        { cwd: repoRoot },
      );
      const manifestText = readFileSync(manifestPath, "utf8");
      execFileSync(
        process.execPath,
        [
          "scripts/release-set.mjs",
          "verify",
          "--evidence",
          evidencePath,
          "--expected-sha256",
          hashText(manifestText),
          "--manifest",
          manifestPath,
          "--repo-root",
          repoRoot,
        ],
        { cwd: repoRoot },
      );
      const withoutExpected = spawnSync(
        process.execPath,
        [
          "scripts/release-set.mjs",
          "verify",
          "--evidence",
          evidencePath,
          "--manifest",
          manifestPath,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.notEqual(withoutExpected.status, 0);
      assert.match(withoutExpected.stderr, /--expected-sha256 is required/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
