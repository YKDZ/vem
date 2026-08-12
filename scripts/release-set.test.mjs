import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

function canonicalText(value) {
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
      trustedBuilderEvidenceSha256: digest("4"),
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
    precutover: {
      database: {
        backup: { byteSize: 654321, sha256: digest("a") },
        receiptSha256: digest("b"),
        source: {
          databaseName: "vem_production",
          migrationChainSha256: repository.database.migrationChainSha256,
          systemIdentifier: "7654321098765432109",
        },
      },
      managedMedia: {
        assetCount: 2,
        assetsSetSha256: digest("c"),
        generation: "catalog-generation-42",
        receiptSha256: digest("d"),
      },
    },
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

  it("rejects a generated V2 file that no longer matches its manifest", () => {
    const temporary = mkdtempSync(join(tmpdir(), "vem-release-bundle-"));
    try {
      cpSync(
        join(repoRoot, "packages/shared/generated/vision-v2"),
        join(temporary, "packages/shared/generated/vision-v2"),
        { recursive: true },
      );
      cpSync(
        join(repoRoot, "packages/db/drizzle"),
        join(temporary, "packages/db/drizzle"),
        { recursive: true },
      );
      const schemaPath = join(
        temporary,
        "packages/shared/generated/vision-v2/vision-v2.client.schema.json",
      );
      writeFileSync(schemaPath, `${readFileSync(schemaPath, "utf8")} `);
      assert.throws(
        () => readReleaseRepositoryFacts(temporary),
        /generated Vision V2 file digest mismatch/,
      );
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("rejects noncanonical metadata, a forged bundle digest, and extra bundle files", () => {
    for (const kind of ["pretty", "digest", "extra"]) {
      const temporary = mkdtempSync(join(tmpdir(), `vem-release-${kind}-`));
      try {
        const bundleRoot = join(
          temporary,
          "packages/shared/generated/vision-v2",
        );
        cpSync(
          join(repoRoot, "packages/shared/generated/vision-v2"),
          bundleRoot,
          {
            recursive: true,
          },
        );
        cpSync(
          join(repoRoot, "packages/db/drizzle"),
          join(temporary, "packages/db/drizzle"),
          { recursive: true },
        );
        const manifestPath = join(bundleRoot, "manifest.json");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        if (kind === "pretty") {
          writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
        } else if (kind === "digest") {
          manifest.bundleDigest = "0".repeat(64);
          writeFileSync(manifestPath, canonicalText(manifest));
        } else {
          writeFileSync(join(bundleRoot, "extra.schema.json"), "{}\n");
        }
        assert.throws(() => readReleaseRepositoryFacts(temporary));
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    }
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

  it("strictly rejects the retired Vision supplier evidence field", () => {
    const evidence = componentEvidence();
    const retired = "supplier" + "EvidenceSha256";
    evidence.vision[retired] = evidence.vision.trustedBuilderEvidenceSha256;
    delete evidence.vision.trustedBuilderEvidenceSha256;
    assert.throws(
      () => generateReleaseSet({ evidence, repoRoot }),
      /component evidence\.vision must contain exactly/,
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
      [["vision", "trustedBuilderEvidenceSha256"], digest("0")],
      [["visionV2Bundle", "bundleSha256"], digest("0")],
      [["ai", "runtimeDescriptorSha256"], digest("0")],
      [["ai", "requirementsLockSha256"], digest("0")],
      [["ai", "modelDescriptorSha256"], digest("0")],
      [["ai", "modelPackArchive", "byteSize"], 123457],
      [["ai", "modelPackArchive", "sha256"], digest("0")],
      [["database", "migrationTarget"], "20990101000000_wrong"],
      [["database", "migrationCount"], 44],
      [["database", "migrationChainSha256"], digest("0")],
      [["precutover", "database", "receiptSha256"], digest("0")],
      [["precutover", "database", "backup", "byteSize"], 654322],
      [["precutover", "database", "backup", "sha256"], digest("0")],
      [["precutover", "database", "source", "databaseName"], "other_database"],
      [["precutover", "database", "source", "systemIdentifier"], "123"],
      [
        ["precutover", "database", "source", "migrationChainSha256"],
        digest("0"),
      ],
      [["precutover", "managedMedia", "receiptSha256"], digest("0")],
      [["precutover", "managedMedia", "generation"], "other-generation"],
      [["precutover", "managedMedia", "assetCount"], 3],
      [["precutover", "managedMedia", "assetsSetSha256"], digest("0")],
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

  it("provides generation but rejects caller-selected digest verification", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-release-set-"));
    try {
      const evidencePath = join(directory, "evidence.json");
      const manifestPath = join(directory, "release-set.json");
      const evidence = componentEvidence();
      writeFileSync(evidencePath, canonicalText(evidence));
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
      const selfAuthorized = spawnSync(
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
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.notEqual(selfAuthorized.status, 0);
      assert.match(selfAuthorized.stderr, /production verification requires/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects every noncanonical or unsafe evidence spelling at the CLI boundary", () => {
    const directory = mkdtempSync(join(tmpdir(), "vem-release-evidence-"));
    try {
      const evidencePath = join(directory, "evidence.json");
      const outputPath = join(directory, "release-set.json");
      const value = componentEvidence();
      const exact = canonicalText(value);
      const variants = [
        `${JSON.stringify(value, null, 2)}\n`,
        exact.replace(
          '"schemaVersion":"vem.release-set.component-evidence.v1"',
          '"schemaVersion":"vem.release-set.component-evidence.v1","schemaVersion":"vem.release-set.component-evidence.v1"',
        ),
        exact.replace('"schemaVersion"', '"schema\\u0056ersion"'),
        exact.replace('"byteSize":123456', '"byteSize":1.23456e5'),
        exact.replace('"byteSize":123456', '"byteSize":9007199254740992'),
      ];
      for (const variant of variants) {
        rmSync(outputPath, { force: true });
        writeFileSync(evidencePath, variant);
        const result = spawnSync(
          process.execPath,
          [
            "scripts/release-set.mjs",
            "generate",
            "--evidence",
            evidencePath,
            "--output",
            outputPath,
            "--repo-root",
            repoRoot,
          ],
          { cwd: repoRoot, encoding: "utf8" },
        );
        assert.notEqual(result.status, 0, `accepted evidence: ${variant}`);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
