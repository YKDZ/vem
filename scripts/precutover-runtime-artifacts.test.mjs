import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  validateRuntimeArtifactsReceiptTextForTest,
  verifyRuntimeArtifactsForTest,
} from "./precutover-runtime-artifacts.mjs";
import {
  buildApprovedPrecutoverReceiptText,
  verifyTrustedVisionCandidateAttestation,
} from "./release-set-approval.mjs";
import {
  generateReleaseSet,
  readReleaseRepositoryFacts,
} from "./release-set.mjs";
import {
  createRuntimeArtifactDescriptor,
  writeRuntimeArtifactDescriptor,
} from "./windows/runtime-artifact-descriptor.mjs";

const repoRoot = realpathSync(new URL("..", import.meta.url).pathname);
const python = "/usr/bin/python3.11";
const archiveHelper = join(
  repoRoot,
  "scripts/lib/verify_vem_runtime_archive.py",
);
const productionCli = join(
  repoRoot,
  "scripts/precutover-runtime-artifacts.mjs",
);
const visionRoot = "/workspaces/vending-vision";
const trustedVisionVerifierSha = "6f598fe01f1fb9af76ec6985fdc2df8fbbe95710";
const trustedVisionVerifierBuilderSha =
  "c90a965d117fea49f318b18e0fcd50aa047bc41";
const nextTrustedVisionVerifierSha =
  "af9f7bb766e8a467e8c9a24396a76b616fd68188";
const nextTrustedVisionVerifierBuilderSha =
  "3fe9e00c98d9df59c71ce9be5b980a713ddd3110";
const vemCommit = "a".repeat(40);
const visionCommit = "b".repeat(40);
const sourceRef = "refs/tags/v1.2.3-rc.1";
const temporaryRoots = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
});

function writeZip(path, members) {
  const program = String.raw`
import base64, json, stat, sys, zipfile
path, encoded = sys.argv[1:]
members = json.loads(base64.b64decode(encoded))
with zipfile.ZipFile(path, "w", allowZip64=True) as archive:
    for item in members:
        info = zipfile.ZipInfo(item["name"], date_time=(1980,1,1,0,0,0))
        info.compress_type = item.get("compression", zipfile.ZIP_STORED)
        info.create_system = 3
        info.external_attr = (item.get("mode", stat.S_IFREG | 0o644)) << 16
        payload = bytes(item["repeatedBytes"]) if "repeatedBytes" in item else base64.b64decode(item["bytes"])
        archive.writestr(info, payload)
`;
  const encoded = Buffer.from(JSON.stringify(members)).toString("base64");
  const result = spawnSync(python, ["-c", program, path, encoded], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

function member(name, contents) {
  return { name, bytes: Buffer.from(contents).toString("base64") };
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

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

function managedMediaReceiptText(observedAt) {
  const mediaDigest = `sha256:${"a".repeat(64)}`;
  return canonical({
    assets: [
      {
        assetRevision: null,
        byteSize: 1,
        catalogRevision: "catalog-1",
        contentType: "image/png",
        digest: mediaDigest,
        grantSha256: `sha256:${"b".repeat(64)}`,
        id: "00000000-0000-4000-8000-000000000001",
        loopbackPath: `/media/${mediaDigest}`,
        purpose: "product_display_image",
        reference:
          "/api/media-assets/00000000-0000-4000-8000-000000000001/content",
      },
    ],
    generation: "catalog-1",
    observedAt,
    origin: "http://127.0.0.1:4312",
    planogramVersion: "planogram-1",
    schemaVersion: "vem.precutover.managed-media.v1",
    trustStatus: "pending_release_set_approval",
  });
}

async function buildFixture(root) {
  const trustedVisionRoot = join(root, "trusted-vision-builder");
  mkdirSync(join(trustedVisionRoot, "scripts"), { recursive: true });
  for (const script of [
    "candidate_artifact_manifest.py",
    "verify_trusted_candidate_inputs.py",
  ]) {
    writeFileSync(
      join(trustedVisionRoot, "scripts", script),
      execFileSync("git", [
        "-C",
        visionRoot,
        "show",
        `${trustedVisionVerifierSha}:scripts/${script}`,
      ]),
    );
  }
  const runtimeDirectory = join(root, "runtime-directory");
  mkdirSync(runtimeDirectory);
  for (const [name, bytes] of [
    ["vending-daemon.exe", "test daemon"],
    ["machine.exe", "test machine"],
    ["WebView2Loader.dll", "test webview"],
  ]) {
    writeFileSync(join(runtimeDirectory, name), bytes);
  }
  const runtimeDescriptor = await createRuntimeArtifactDescriptor({
    runtimeDirectory,
    commit: vemCommit,
    artifactName: "vem-runtime-test",
    workflowRunIdentity: "github-actions://YKDZ/vem/actions/runs/1/attempts/1",
    toolchain: {
      runnerImage: "windows-2022",
      runnerImageVersion: "test",
      node: "24.0.0",
      pnpm: "11.9.0",
      rustc: "1.89.0",
      cargo: "1.89.0",
      tauriCli: "2.8.0",
    },
  });
  await writeRuntimeArtifactDescriptor(runtimeDirectory, runtimeDescriptor);
  const vemArchive = join(root, "vem-runtime.zip");
  writeZip(
    vemArchive,
    readdirSync(runtimeDirectory).map((name) =>
      member(name, readFileSync(join(runtimeDirectory, name))),
    ),
  );

  const candidateInput = join(root, "vision-candidate-input");
  const dist = join(root, "vision-dist");
  const mainInternal = join(dist, "vending-vision/_internal");
  const workerInternal = join(dist, "vending-vision-ai-worker/_internal");
  mkdirSync(mainInternal, { recursive: true });
  mkdirSync(workerInternal, { recursive: true });
  writeFileSync(join(dist, "vending-vision/vending-vision.exe"), "test main");
  writeFileSync(
    join(dist, "vending-vision-ai-worker/vending-vision-ai-worker.exe"),
    "test worker",
  );
  const aiRuntime = Buffer.from(
    '{"schemaVersion":"vem-ai-runtime-descriptor/v1"}\n',
  );
  const aiLock = Buffer.from('{"wheels":[]}\n');
  const sourceDescriptor = Buffer.from(
    '{"schemaVersion":"vem-official-ai-source-descriptor/v1"}\n',
  );
  const modelDescriptor = Buffer.from(
    '{"schemaVersion":"vem-official-ai-model-pack-descriptor/v2"}\n',
  );
  for (const [name, bytes] of [
    ["ai-runtime-descriptor.json", aiRuntime],
    ["requirements-ai.lock.json", aiLock],
    ["official-ai-source-descriptor.json", sourceDescriptor],
    ["official-ai-model-pack-descriptor.json", modelDescriptor],
  ]) {
    writeFileSync(join(workerInternal, name), bytes);
  }
  cpSync(
    join(repoRoot, "packages/shared/generated/vision-v2"),
    join(mainInternal, "contracts/vem_vision_v2"),
    { recursive: true },
  );
  mkdirSync(candidateInput);
  const candidateArchive = join(candidateInput, "vending-vision-test.zip");
  const candidateManifest = join(candidateInput, "candidate-manifest.json");
  const built = spawnSync(
    python,
    [
      join(trustedVisionRoot, "scripts/candidate_artifact_manifest.py"),
      "--dist-root",
      dist,
      "--artifact",
      candidateArchive,
      "--manifest-output",
      candidateManifest,
      "--source-commit",
      visionCommit,
    ],
    { cwd: trustedVisionRoot, encoding: "utf8" },
  );
  assert.equal(built.status, 0, built.stderr);
  const candidate = JSON.parse(built.stdout);
  const attestation = join(
    candidateInput,
    "github-build-provenance.sigstore.json",
  );
  writeFileSync(attestation, "{}\n");
  const attestationSha256 = sha256(readFileSync(attestation));
  const builderEvidence = join(candidateInput, "trusted-builder-evidence.json");
  writeFileSync(
    builderEvidence,
    JSON.stringify({
      schemaVersion: "vending-vision-trusted-builder-evidence/v1",
      builderRepository: "hbhjt/vending-vision",
      builderWorkflow: ".github/workflows/trusted-ai-candidate-builder.yml",
      builderWorkflowSha: trustedVisionVerifierBuilderSha,
      sourceCommit: visionCommit,
      subjectSha256: candidate.subjectSha256,
      embeddedManifestSha256: candidate.embeddedManifestSha256,
      attestationBundleSha256: attestationSha256.slice(7),
    }),
  );

  const repository = readReleaseRepositoryFacts(repoRoot);
  const digest = (character) => `sha256:${character.repeat(64)}`;
  const evidence = {
    adminContracts: { evidenceSha256: digest("9") },
    ai: {
      modelDescriptorSha256: sha256(modelDescriptor),
      modelPackArchive: { byteSize: 1, sha256: digest("8") },
      requirementsLockSha256: sha256(aiLock),
      runtimeDescriptorSha256: sha256(aiRuntime),
    },
    backend: {
      adminUi: {
        image: `registry.test/admin@${digest("c")}`,
        provenanceSha256: digest("d"),
        sourceCommit: vemCommit,
      },
      serviceApi: {
        image: `registry.test/service@${digest("a")}`,
        provenanceSha256: digest("b"),
        sourceCommit: vemCommit,
      },
    },
    database: repository.database,
    precutover: {
      database: {
        backup: { byteSize: 1, sha256: digest("1") },
        receiptSha256: digest("2"),
        source: {
          databaseName: "vem",
          migrationChainSha256: repository.database.migrationChainSha256,
          systemIdentifier: "123456789",
        },
      },
      managedMedia: {
        assetCount: 1,
        assetsSetSha256: digest("3"),
        generation: "catalog-1",
        receiptSha256: digest("4"),
      },
    },
    schemaVersion: "vem.release-set.component-evidence.v1",
    vem: { sourceCommit: vemCommit },
    vision: {
      attestationBundleSha256: attestationSha256,
      candidateSubjectSha256: `sha256:${candidate.subjectSha256}`,
      embeddedManifestSha256: `sha256:${candidate.embeddedManifestSha256}`,
      sourceCommit: visionCommit,
      trustedBuilderEvidenceSha256: sha256(readFileSync(builderEvidence)),
    },
    visionV2Bundle: repository.visionV2Bundle,
    windowsRuntime: {
      archiveSha256: sha256(readFileSync(vemArchive)),
      descriptorSha256: sha256(
        readFileSync(join(runtimeDirectory, "WINDOWS-RUNTIME-ARTIFACTS.json")),
      ),
      sourceCommit: vemCommit,
    },
  };
  const releaseSetText = generateReleaseSet({ evidence, repoRoot });
  const releaseSetPath = join(root, "release-set.json");
  writeFileSync(releaseSetPath, releaseSetText);
  const releaseSetSha256 = sha256(releaseSetText);
  const approvalText = canonical({
    attester: {
      hostedRunnerRequired: true,
      repository: "YKDZ/vem",
      workflow: ".github/workflows/trusted-release-set-attester.yml",
      workflowSha: "91b06351bdf630de8826e88b7b811a8fee491528",
    },
    inputArtifact: {
      aggregateSha256: digest("5"),
      members: {
        "component-evidence.json": digest("6"),
        "database-backup-receipt.json": digest("7"),
        "managed-media-receipt.json": digest("8"),
        "release-set.json": releaseSetSha256,
      },
    },
    schemaVersion: "vem.release-set.approval.v1",
    sourceCommit: vemCommit,
    sourceRef,
  });
  const approvalPath = join(root, "release-set-approval.json");
  writeFileSync(approvalPath, approvalText);
  const approvalBundlePath = join(root, "release-set-approval.sigstore.json");
  writeFileSync(approvalBundlePath, "{}\n");
  const releaseSetInputDirectory = join(root, "release-set-input");
  mkdirSync(releaseSetInputDirectory);
  const databaseProof = {
    backup: { byteSize: 1, format: "postgresql-custom", sha256: digest("1") },
    catalogData: { sha256: digest("2") },
    constraintsSha256: digest("3"),
    legacyResidue: {
      columns: 0,
      constraints: 0,
      indexes: 0,
      purposeRows: 0,
      storageReferences: 0,
    },
    migration: {
      chainSha256: repository.database.migrationChainSha256,
      count: repository.database.migrationCount,
      target: repository.database.migrationTarget,
    },
  };
  const mediaReceiptText = managedMediaReceiptText("2026-08-11T00:00:00.000Z");
  const approvedText = buildApprovedPrecutoverReceiptText({
    approval: JSON.parse(approvalText),
    approvalText,
    databaseProof,
    liveMediaReceiptText: mediaReceiptText,
    sourceCommit: vemCommit,
    sourceRef,
  });
  const approvedPath = join(root, "approved-precutover.json");
  writeFileSync(approvedPath, approvedText);
  const databaseBackupPath = join(root, "database.dump");
  writeFileSync(databaseBackupPath, "test-owned backup");
  return {
    approvalPath,
    approvalBundlePath,
    approvalSha256: sha256(approvalText),
    approvedPath,
    candidateInput,
    databaseBackupPath,
    databaseProof,
    freshApprovedText: approvedText,
    mediaReceiptText,
    releaseSetInputDirectory,
    releaseSetPath,
    trustedVisionRoot,
    vemArchive,
  };
}

function productionArgs(fixture, output, overrides = {}) {
  return [
    productionCli,
    "verify",
    "--approved",
    fixture.approvedPath,
    "--approval",
    fixture.approvalPath,
    "--approval-attestation-bundle",
    fixture.approvalBundlePath,
    "--approval-subject-sha256",
    fixture.approvalSha256,
    "--database-backup",
    fixture.databaseBackupPath,
    "--docker-binary",
    "/usr/bin/docker",
    "--expected-docker-byte-size",
    "1",
    "--expected-docker-sha256",
    `sha256:${"0".repeat(64)}`,
    "--expected-docker-version",
    "Docker version test",
    "--gh-binary",
    overrides.ghBinary ?? "/usr/bin/gh",
    "--output",
    output,
    "--python",
    overrides.python ?? python,
    "--release-set",
    fixture.releaseSetPath,
    "--release-set-input-directory",
    fixture.releaseSetInputDirectory,
    "--managed-media-origin",
    "http://127.0.0.1:1",
    "--managed-media-token",
    "test-owned-token",
    "--repo-root",
    overrides.repoRoot ?? repoRoot,
    "--postgres-container",
    "test-owned-postgres",
    "--postgres-user",
    "postgres",
    "--source-commit",
    vemCommit,
    "--source-ref",
    sourceRef,
    "--vem-runtime-archive",
    fixture.vemArchive,
    "--vision-candidate-input-directory",
    fixture.candidateInput,
    "--vision-source-ref",
    sourceRef,
    "--vision-verifier-root",
    overrides.visionVerifierRoot ?? fixture.trustedVisionRoot,
  ];
}

function runtimeOptions(fixture, output, overrides = {}) {
  const args = productionArgs(fixture, output, overrides);
  const options = { command: "verify" };
  for (let index = 2; index < args.length; index += 2) {
    options[args[index].slice(2)] = args[index + 1];
  }
  return options;
}

function testProvenPrecutover(fixture) {
  const approvalText = readFileSync(fixture.approvalPath, "utf8");
  const manifestText = readFileSync(fixture.releaseSetPath, "utf8");
  return {
    approval: JSON.parse(approvalText),
    approvalText,
    approvedText: fixture.freshApprovedText,
    manifest: JSON.parse(manifestText),
    manifestText,
    receipt: JSON.parse(fixture.freshApprovedText),
  };
}

async function runWithTestAuthority(
  fixture,
  output,
  overrides = {},
  verifyVisionAttestation,
  provePrecutover = async () => testProvenPrecutover(fixture),
  beforeVemHelperExecute,
) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  try {
    await verifyRuntimeArtifactsForTest(
      runtimeOptions(fixture, output, overrides),
      provePrecutover,
      verifyVisionAttestation,
      beforeVemHelperExecute,
    );
    return { status: 0, stderr: "" };
  } catch (error) {
    return {
      status: 1,
      stderr: `PRECUTOVER_RUNTIME_ARTIFACTS=FAIL:${error.message}\n`,
    };
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

describe("pre-cutover complete runtime archives", () => {
  it("binds the production candidate verifier descriptor to immutable Vision blobs", () => {
    const descriptor = JSON.parse(
      readFileSync(
        join(repoRoot, "trusted-vision-candidate-verifier.json"),
        "utf8",
      ),
    );
    assert.equal(descriptor.revision, nextTrustedVisionVerifierSha);
    for (const script of descriptor.scripts) {
      const bytes = execFileSync("git", [
        "-C",
        visionRoot,
        "show",
        `${nextTrustedVisionVerifierSha}:${script.path}`,
      ]);
      assert.equal(script.byteSize, bytes.byteLength);
      assert.equal(script.sha256, sha256(bytes).slice(7));
    }
    const verifier = execFileSync("git", [
      "-C",
      visionRoot,
      "show",
      `${nextTrustedVisionVerifierSha}:scripts/verify_trusted_candidate_inputs.py`,
    ]).toString("utf8");
    assert.match(
      verifier,
      new RegExp(
        `TRUSTED_BUILDER_COMMIT = "${nextTrustedVisionVerifierBuilderSha}"`,
      ),
    );
  });

  it("rejects a locally authored release-set authority at the production CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-unsigned-root-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const output = join(root, "runtime-artifacts-receipt.json");

    const result = spawnSync(
      process.execPath,
      productionArgs(fixture, output),
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /attestation|authority|approval/i);
    assert.equal(
      readdirSync(root).includes("runtime-artifacts-receipt.json"),
      false,
    );
  });

  it("rejects a locally rewritten approved receipt even when its authenticated release references remain exact", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-forged-approved-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const approved = JSON.parse(readFileSync(fixture.approvedPath, "utf8"));
    approved.database.catalogDataSha256 = `sha256:${"a".repeat(64)}`;
    approved.managedMedia.assetsSetSha256 = `sha256:${"b".repeat(64)}`;
    approved.managedMedia.generation = "attacker-generation";
    approved.managedMedia.stableMediaProofSha256 = sha256(
      canonical({
        assetCount: approved.managedMedia.assetCount,
        assetsSetSha256: approved.managedMedia.assetsSetSha256,
        generation: approved.managedMedia.generation,
        planogramVersion: approved.managedMedia.planogramVersion,
      }),
    );
    writeFileSync(fixture.approvedPath, canonical(approved));
    const output = join(root, "runtime-artifacts-receipt.json");

    const result = await runWithTestAuthority(fixture, output);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fresh|reproof|approved.*differ/i);
    assert.equal(existsSync(output), false);
  });

  it("accepts a fresh media observation with identical stable facts", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-media-observation-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const output = join(root, "runtime-artifacts-receipt.json");
    const secondMediaReceiptText = managedMediaReceiptText(
      "2026-08-11T00:00:01.000Z",
    );
    assert.notEqual(secondMediaReceiptText, fixture.mediaReceiptText);
    const approvalText = readFileSync(fixture.approvalPath, "utf8");
    const freshApprovedText = buildApprovedPrecutoverReceiptText({
      approval: JSON.parse(approvalText),
      approvalText,
      databaseProof: fixture.databaseProof,
      liveMediaReceiptText: secondMediaReceiptText,
      sourceCommit: vemCommit,
      sourceRef,
    });
    const fresh = JSON.parse(freshApprovedText);

    const result = await runWithTestAuthority(
      fixture,
      output,
      {},
      undefined,
      async () => ({
        ...testProvenPrecutover(fixture),
        approvedText: freshApprovedText,
        receipt: fresh,
      }),
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(output), true);
  });

  for (const failure of [
    "database reproof failed",
    "managed-media reproof failed",
  ]) {
    it(`publishes no runtime receipt when ${failure}`, async () => {
      const root = mkdtempSync(join(tmpdir(), "vem-runtime-reproof-failed-"));
      temporaryRoots.push(root);
      const fixture = await buildFixture(root);
      const output = join(root, "runtime-artifacts-receipt.json");
      const events = [];

      const result = await runWithTestAuthority(
        fixture,
        output,
        {},
        async () => events.push("vision-verifier"),
        async () => {
          events.push("precutover-reproof");
          throw new Error(failure);
        },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, new RegExp(failure));
      assert.deepEqual(events, ["precutover-reproof"]);
      assert.equal(existsSync(output), false);
    });
  }

  it("completes the fresh database and media proof before consuming runtime archives", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-reproof-order-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const output = join(root, "runtime-artifacts-receipt.json");
    const events = [];

    const result = await runWithTestAuthority(
      fixture,
      output,
      {},
      async () => events.push("vision-verifier"),
      async () => {
        events.push("database-and-media-reproof");
        return testProvenPrecutover(fixture);
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(events, ["database-and-media-reproof", "vision-verifier"]);
    assert.equal(existsSync(output), true);
  });

  for (const mutation of ["atomic replacement", "in-place rewrite"]) {
    it(`rejects VEM archive helper source ${mutation} after authority validation`, async () => {
      const root = mkdtempSync(join(tmpdir(), "vem-runtime-helper-race-"));
      temporaryRoots.push(root);
      const fixture = await buildFixture(root);
      const output = join(root, "runtime-artifacts-receipt.json");

      const result = await runWithTestAuthority(
        fixture,
        output,
        {},
        undefined,
        undefined,
        async ({ sourcePath }) => {
          const bytes = readFileSync(sourcePath);
          if (mutation === "atomic replacement") {
            const replacement = `${sourcePath}.${process.pid}.replacement`;
            writeFileSync(replacement, bytes, { mode: 0o644 });
            renameSync(replacement, sourcePath);
          } else {
            writeFileSync(sourcePath, bytes);
          }
        },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /helper|verifier|changed|identity/i);
      assert.equal(existsSync(output), false);
    });
  }

  for (const mutation of ["atomic replacement", "in-place rewrite"]) {
    it(`rejects private VEM archive helper staging ${mutation} before Python execution`, async () => {
      const root = mkdtempSync(
        join(tmpdir(), "vem-runtime-staged-helper-race-"),
      );
      temporaryRoots.push(root);
      const fixture = await buildFixture(root);
      const output = join(root, "runtime-artifacts-receipt.json");
      let privateRoot;

      const result = await runWithTestAuthority(
        fixture,
        output,
        {},
        undefined,
        undefined,
        async ({ stagedPath }) => {
          privateRoot = dirname(stagedPath);
          const bytes = readFileSync(stagedPath);
          if (mutation === "atomic replacement") {
            const replacement = `${stagedPath}.replacement`;
            writeFileSync(replacement, bytes, { mode: 0o600 });
            renameSync(replacement, stagedPath);
          } else {
            writeFileSync(stagedPath, bytes);
          }
        },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /helper|verifier|changed|identity/i);
      assert.equal(existsSync(output), false);
      assert.equal(existsSync(privateRoot), false);
    });
  }

  it("safely extracts the exact VEM runtime archive member set", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-archive-"));
    temporaryRoots.push(root);
    const archive = join(root, "runtime.zip");
    const destination = join(root, "extracted");
    const members = [
      member("WINDOWS-RUNTIME-ARTIFACTS.json", "{}\n"),
      member("WebView2Loader.dll", "webview"),
      member("machine.exe", "machine"),
      member("vending-daemon.exe", "daemon"),
    ];
    writeZip(archive, members);
    const result = spawnSync(
      python,
      [
        archiveHelper,
        "verify",
        "--archive",
        archive,
        "--destination",
        destination,
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      readdirSync(destination).sort(),
      members.map(({ name }) => name).sort(),
    );
    for (const { name, bytes } of members) {
      assert.deepEqual(
        readFileSync(join(destination, name)),
        Buffer.from(bytes, "base64"),
      );
    }
  });

  for (const [name, mutate] of [
    ["traversal", (items) => (items[3].name = "../vending-daemon.exe")],
    ["symlink", (items) => (items[3].mode = 0o120777)],
    ["special", (items) => (items[3].mode = 0o010777)],
    [
      "case collision",
      (items) => {
        items[3].name = "Machine.exe";
      },
    ],
    ["extra", (items) => items.push(member("extra.exe", "extra"))],
    [
      "duplicate",
      (items) => {
        items[3].name = "machine.exe";
      },
    ],
    ["compression", (items) => (items[3].compression = 8)],
    [
      "oversized descriptor",
      (items) => {
        items[0] = {
          name: "WINDOWS-RUNTIME-ARTIFACTS.json",
          repeatedBytes: 1024 * 1024 + 1,
        };
      },
    ],
  ]) {
    it(`rejects ${name} without publishing extracted runtime bytes`, () => {
      const root = mkdtempSync(join(tmpdir(), "vem-runtime-unsafe-"));
      temporaryRoots.push(root);
      const archive = join(root, "runtime.zip");
      const destination = join(root, "extracted");
      const members = [
        member("WINDOWS-RUNTIME-ARTIFACTS.json", "{}\n"),
        member("WebView2Loader.dll", "webview"),
        member("machine.exe", "machine"),
        member("vending-daemon.exe", "daemon"),
      ];
      mutate(members);
      writeZip(archive, members);
      const result = spawnSync(
        python,
        [
          archiveHelper,
          "verify",
          "--archive",
          archive,
          "--destination",
          destination,
        ],
        { cwd: repoRoot, encoding: "utf8" },
      );
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /VEM_RUNTIME_ARCHIVE=FAIL/);
      assert.equal(readdirSync(root).includes("extracted"), false);
    });
  }

  it("verifies both complete archives behind explicit test-owned trust boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-complete-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const output = join(root, "runtime-artifacts-receipt.json");
    const result = await runWithTestAuthority(fixture, output);
    assert.equal(result.status, 0, result.stderr);
    const receiptRaw = readFileSync(output, "utf8");
    const receipt = JSON.parse(receiptRaw);
    assert.equal(receiptRaw, canonical(receipt));
    assert.equal(receipt.schemaVersion, "vem.precutover.runtime-artifacts.v1");
    assert.equal(receipt.trustStatus, "pending_final_aggregate_approval");
    assert.equal(receipt.vem.files.length, 3);
    assert.equal(receipt.vision.sourceCommit, visionCommit);
    assert.match(
      receipt.vision.trustedBuilderEvidenceSha256,
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.match(receipt.verifier.descriptorIdentity, /^sha256:[a-f0-9]{64}$/);
  });

  it("strictly rejects a runtime receipt using the retired Vision evidence field", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-retired-field-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const output = join(root, "runtime-artifacts-receipt.json");
    const result = await runWithTestAuthority(fixture, output);
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(output, "utf8"));
    const retired = "supplier" + "EvidenceSha256";
    receipt.vision[retired] = receipt.vision.trustedBuilderEvidenceSha256;
    delete receipt.vision.trustedBuilderEvidenceSha256;
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      assert.throws(
        () => validateRuntimeArtifactsReceiptTextForTest(canonical(receipt)),
        /Vision candidate facts has missing or unknown fields/,
      );
    } finally {
      if (prior === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  it("projects the complete externally verified packaged worker onedir for the AI proof", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-ai-materials-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const output = join(root, "runtime-artifacts-receipt.json");
    const destination = join(root, "verified-ai-materials");
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const proof = await verifyRuntimeArtifactsForTest(
        runtimeOptions(fixture, output),
        async () => testProvenPrecutover(fixture),
        async () => {},
        undefined,
        destination,
      );
      assert.equal(proof.aiMaterials.workerFiles.length, 5);
      assert.deepEqual(
        proof.aiMaterials.workerFiles.map(({ relative }) => relative).sort(),
        [
          "_internal/ai-runtime-descriptor.json",
          "_internal/official-ai-model-pack-descriptor.json",
          "_internal/official-ai-source-descriptor.json",
          "_internal/requirements-ai.lock.json",
          "vending-vision-ai-worker.exe",
        ],
      );
      for (const file of proof.aiMaterials.workerFiles) {
        assert.equal(existsSync(file.path), true);
      }
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("rejects an empty Vision builder attestation after release authority authentication", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-unsigned-vision-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const output = join(root, "runtime-artifacts-receipt.json");

    const result = await runWithTestAuthority(
      fixture,
      output,
      {},
      verifyTrustedVisionCandidateAttestation,
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Vision.*attestation|GitHub.*attestation/i);
    assert.equal(
      readdirSync(root).includes("runtime-artifacts-receipt.json"),
      false,
    );
  });

  it("rejects a self-consistent candidate ZIP and manifest without all external builder facts", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-self-manifest-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const output = join(root, "runtime-artifacts-receipt.json");
    rmSync(join(fixture.candidateInput, "trusted-builder-evidence.json"));

    const result = await runWithTestAuthority(fixture, output);

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /Vision candidate input must contain exactly four regular files/,
    );
    assert.equal(
      readdirSync(root).includes("runtime-artifacts-receipt.json"),
      false,
    );
  });

  for (const [label, mutate] of [
    [
      "a replaced VEM runtime archive",
      (fixture) =>
        writeFileSync(
          fixture.vemArchive,
          Buffer.concat([
            readFileSync(fixture.vemArchive),
            Buffer.from("replacement"),
          ]),
        ),
    ],
    [
      "a replaced Vision candidate archive",
      (fixture) => {
        const archive = readdirSync(fixture.candidateInput).find((name) =>
          name.endsWith(".zip"),
        );
        const path = join(fixture.candidateInput, archive);
        writeFileSync(
          path,
          Buffer.concat([readFileSync(path), Buffer.from("replacement")]),
        );
      },
    ],
    [
      "a rewritten candidate self-manifest",
      (fixture) => {
        const path = join(fixture.candidateInput, "candidate-manifest.json");
        writeFileSync(path, `${readFileSync(path, "utf8")}\n`);
      },
    ],
  ]) {
    it(`rejects ${label} without publishing a partial receipt`, async () => {
      const root = mkdtempSync(join(tmpdir(), "vem-runtime-replaced-"));
      temporaryRoots.push(root);
      const fixture = await buildFixture(root);
      const output = join(root, "runtime-artifacts-receipt.json");
      mutate(fixture);

      const result = await runWithTestAuthority(fixture, output);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /digest mismatch/);
      assert.equal(
        readdirSync(root).includes("runtime-artifacts-receipt.json"),
        false,
      );
    });
  }

  it("rejects an absolute companion root whose verifier bytes differ from the tracked descriptor", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-fake-verifier-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const fakeRoot = join(root, "fake-vision-root");
    mkdirSync(join(fakeRoot, "scripts"), { recursive: true });
    for (const name of [
      "candidate_artifact_manifest.py",
      "verify_trusted_candidate_inputs.py",
    ]) {
      cpSync(
        join(visionRoot, "scripts", name),
        join(fakeRoot, "scripts", name),
      );
    }
    const verifier = join(
      fakeRoot,
      "scripts/verify_trusted_candidate_inputs.py",
    );
    writeFileSync(verifier, `${readFileSync(verifier, "utf8")}\n# fake\n`);
    const output = join(root, "runtime-artifacts-receipt.json");

    const result = await runWithTestAuthority(fixture, output, {
      visionVerifierRoot: fakeRoot,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Vision verifier script identity mismatch/);
    assert.equal(
      readdirSync(root).includes("runtime-artifacts-receipt.json"),
      false,
    );
  });

  it("rejects a caller-replaced self-signed verifier repository even when all local hashes agree", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-self-signed-tools-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const fakeRepo = join(root, "fake-vem-repository");
    const fakeVision = join(root, "fake-vision-repository");
    mkdirSync(join(fakeRepo, "scripts/lib"), { recursive: true });
    mkdirSync(join(fakeVision, "scripts"), { recursive: true });
    cpSync(
      join(repoRoot, "packages/shared/generated/vision-v2"),
      join(fakeRepo, "packages/shared/generated/vision-v2"),
      { recursive: true },
    );
    const helper = join(fakeRepo, "scripts/lib/verify_vem_runtime_archive.py");
    cpSync(join(repoRoot, "scripts/lib/verify_vem_runtime_archive.py"), helper);
    writeFileSync(
      helper,
      `${readFileSync(helper, "utf8")}\n# caller replacement\n`,
    );
    for (const name of [
      "candidate_artifact_manifest.py",
      "verify_trusted_candidate_inputs.py",
    ]) {
      const target = join(fakeVision, "scripts", name);
      cpSync(join(visionRoot, "scripts", name), target);
      writeFileSync(
        target,
        `${readFileSync(target, "utf8")}\n# caller replacement\n`,
      );
    }
    const descriptor = JSON.parse(
      readFileSync(
        join(repoRoot, "trusted-vision-candidate-verifier.json"),
        "utf8",
      ),
    );
    descriptor.revision = "c".repeat(40);
    descriptor.scripts = descriptor.scripts.map((script) => {
      const bytes = readFileSync(join(fakeVision, script.path));
      return {
        byteSize: bytes.byteLength,
        path: script.path,
        sha256: sha256(bytes).slice(7),
      };
    });
    delete descriptor.identity;
    descriptor.identity = sha256(
      JSON.stringify(JSON.parse(canonical(descriptor))),
    );
    writeFileSync(
      join(fakeRepo, "trusted-vision-candidate-verifier.json"),
      JSON.stringify(JSON.parse(canonical(descriptor)), null, 2) + "\n",
    );
    const output = join(root, "runtime-artifacts-receipt.json");

    const result = await runWithTestAuthority(fixture, output, {
      repoRoot: fakeRepo,
      visionVerifierRoot: fakeVision,
    });

    assert.notEqual(result.status, 0);
    assert.match(
      result.stderr,
      /authenticated|authority|revision|descriptor|helper|not a git repository/i,
    );
    assert.equal(
      readdirSync(root).includes("runtime-artifacts-receipt.json"),
      false,
    );
  });

  it("rejects a caller-selected Python even when it is an absolute regular executable", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-fake-python-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const fakePython = join(root, "python3.11");
    cpSync(python, fakePython);
    const output = join(root, "runtime-artifacts-receipt.json");

    const result = await runWithTestAuthority(fixture, output, {
      python: fakePython,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Python path differs from its descriptor/);
    assert.equal(
      readdirSync(root).includes("runtime-artifacts-receipt.json"),
      false,
    );
  });

  it("ignores ambient Python import paths while executing trusted verifier bytes", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-python-isolation-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const ambient = join(root, "ambient-python");
    const marker = join(root, "ambient-site-ran");
    mkdirSync(ambient);
    writeFileSync(
      join(ambient, "sitecustomize.py"),
      `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("ran")\n`,
    );
    const output = join(root, "runtime-artifacts-receipt.json");
    const previousPythonPath = process.env.PYTHONPATH;
    process.env.PYTHONPATH = ambient;
    try {
      const result = await runWithTestAuthority(fixture, output);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(existsSync(marker), false);
    } finally {
      if (previousPythonPath === undefined) delete process.env.PYTHONPATH;
      else process.env.PYTHONPATH = previousPythonPath;
    }
  });

  for (const [inputName, resolveInput] of [
    ["VEM archive", (fixture) => fixture.vemArchive],
    [
      "Vision candidate archive",
      (fixture) =>
        join(
          fixture.candidateInput,
          readdirSync(fixture.candidateInput).find((name) =>
            name.endsWith(".zip"),
          ),
        ),
    ],
    [
      "Vision candidate manifest",
      (fixture) => join(fixture.candidateInput, "candidate-manifest.json"),
    ],
    [
      "Vision GitHub attestation",
      (fixture) =>
        join(fixture.candidateInput, "github-build-provenance.sigstore.json"),
    ],
    [
      "Vision trusted-builder evidence",
      (fixture) =>
        join(fixture.candidateInput, "trusted-builder-evidence.json"),
    ],
  ]) {
    for (const mutation of ["atomic replacement", "in-place rewrite"]) {
      it(`rejects ${inputName} ${mutation} after private verification consumed staged bytes`, async () => {
        const root = mkdtempSync(
          join(tmpdir(), "vem-runtime-concurrent-input-"),
        );
        temporaryRoots.push(root);
        const fixture = await buildFixture(root);
        const output = join(root, "runtime-artifacts-receipt.json");
        const input = resolveInput(fixture);
        let privateRoot;

        const result = await runWithTestAuthority(
          fixture,
          output,
          {},
          async ({ artifactPath }) => {
            privateRoot = dirname(dirname(artifactPath));
            const bytes = readFileSync(input);
            if (mutation === "atomic replacement") {
              const replacement = `${input}.replacement`;
              writeFileSync(replacement, bytes);
              renameSync(replacement, input);
            } else {
              writeFileSync(input, bytes);
            }
          },
        );

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /changed|identity|replaced/i);
        assert.equal(
          readdirSync(root).includes("runtime-artifacts-receipt.json"),
          false,
        );
        assert.equal(existsSync(privateRoot), false);
      });
    }
  }

  for (const mutation of ["atomic replacement", "in-place rewrite"]) {
    it(`rejects private Vision staging ${mutation} during verifier consumption`, async () => {
      const root = mkdtempSync(
        join(tmpdir(), "vem-runtime-concurrent-staging-"),
      );
      temporaryRoots.push(root);
      const fixture = await buildFixture(root);
      const output = join(root, "runtime-artifacts-receipt.json");
      let privateRoot;

      const result = await runWithTestAuthority(
        fixture,
        output,
        {},
        async ({ artifactPath }) => {
          privateRoot = dirname(dirname(artifactPath));
          const bytes = readFileSync(artifactPath);
          if (mutation === "atomic replacement") {
            const replacement = `${artifactPath}.replacement`;
            writeFileSync(replacement, bytes);
            renameSync(replacement, artifactPath);
          } else {
            writeFileSync(artifactPath, bytes);
          }
        },
      );

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /private staging.*changed|identity changed/i);
      assert.equal(
        readdirSync(root).includes("runtime-artifacts-receipt.json"),
        false,
      );
      assert.equal(existsSync(privateRoot), false);
    });
  }
});
