import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  generateReleaseSet,
  readReleaseRepositoryFacts,
} from "./release-set.mjs";
import {
  createRuntimeArtifactDescriptor,
  writeRuntimeArtifactDescriptor,
} from "./windows/runtime-artifact-descriptor.mjs";

const repoRoot = new URL("..", import.meta.url).pathname;
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

async function buildFixture(root) {
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
      join(visionRoot, "scripts/candidate_artifact_manifest.py"),
      "--dist-root",
      dist,
      "--artifact",
      candidateArchive,
      "--manifest-output",
      candidateManifest,
      "--source-commit",
      visionCommit,
    ],
    { cwd: visionRoot, encoding: "utf8" },
  );
  assert.equal(built.status, 0, built.stderr);
  const candidate = JSON.parse(built.stdout);
  const attestation = join(
    candidateInput,
    "github-build-provenance.sigstore.json",
  );
  writeFileSync(attestation, "{}\n");
  const attestationSha256 = sha256(readFileSync(attestation));
  const supplierEvidence = join(
    candidateInput,
    "trusted-builder-evidence.json",
  );
  writeFileSync(
    supplierEvidence,
    JSON.stringify({
      schemaVersion: "vending-vision-trusted-builder-evidence/v1",
      builderRepository: "hbhjt/vending-vision",
      builderWorkflow: ".github/workflows/trusted-ai-candidate-builder.yml",
      builderWorkflowSha: "be8fe434855b94f61511e8c6c926e02c54230a38",
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
      supplierEvidenceSha256: sha256(readFileSync(supplierEvidence)),
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
      workflowSha: "54f30f648f07c8bf5bc639f4ca2ba8f5a3d85981",
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
  const approvedText = canonical({
    database: {
      backup: { byteSize: 1, format: "postgresql-custom", sha256: digest("1") },
      catalogDataSha256: digest("2"),
      receiptSha256: digest("3"),
    },
    managedMedia: {
      assetCount: 1,
      assetsSetSha256: digest("4"),
      generation: "catalog-1",
      liveProofSha256: digest("5"),
      receiptSha256: digest("6"),
    },
    releaseApprovalSha256: sha256(approvalText),
    releaseSetSha256,
    schemaVersion: "vem.precutover.approved.v1",
    sourceCommit: vemCommit,
    sourceRef,
  });
  const approvedPath = join(root, "approved-precutover.json");
  writeFileSync(approvedPath, approvedText);
  return {
    approvalPath,
    approvedPath,
    candidateInput,
    releaseSetPath,
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
    "--output",
    output,
    "--python",
    overrides.python ?? python,
    "--release-set",
    fixture.releaseSetPath,
    "--repo-root",
    repoRoot,
    "--vem-runtime-archive",
    fixture.vemArchive,
    "--vision-candidate-input-directory",
    fixture.candidateInput,
    "--vision-verifier-root",
    overrides.visionVerifierRoot ?? visionRoot,
  ];
}

describe("pre-cutover complete runtime archives", () => {
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

  it("verifies both complete archives before publishing one pending receipt", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-complete-"));
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
    assert.equal(result.status, 0, result.stderr);
    const receiptRaw = readFileSync(output, "utf8");
    const receipt = JSON.parse(receiptRaw);
    assert.equal(receiptRaw, canonical(receipt));
    assert.equal(receipt.schemaVersion, "vem.precutover.runtime-artifacts.v1");
    assert.equal(receipt.trustStatus, "pending_final_aggregate_approval");
    assert.equal(receipt.vem.files.length, 3);
    assert.equal(receipt.vision.sourceCommit, visionCommit);
    assert.match(receipt.verifier.descriptorIdentity, /^sha256:[a-f0-9]{64}$/);
  });

  it("rejects a self-consistent candidate ZIP and manifest without all external builder facts", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-runtime-self-manifest-"));
    temporaryRoots.push(root);
    const fixture = await buildFixture(root);
    const output = join(root, "runtime-artifacts-receipt.json");
    rmSync(join(fixture.candidateInput, "trusted-builder-evidence.json"));

    const result = spawnSync(
      process.execPath,
      productionArgs(fixture, output),
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

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

      const result = spawnSync(
        process.execPath,
        productionArgs(fixture, output),
        {
          cwd: repoRoot,
          encoding: "utf8",
        },
      );

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

    const result = spawnSync(
      process.execPath,
      productionArgs(fixture, output, { visionVerifierRoot: fakeRoot }),
      { cwd: repoRoot, encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Vision verifier script identity mismatch/);
    assert.equal(
      readdirSync(root).includes("runtime-artifacts-receipt.json"),
      false,
    );
  });
});
