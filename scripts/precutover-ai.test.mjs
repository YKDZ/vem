import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { verifyPrecutoverAiForTest } from "./precutover-ai.mjs";

const repoRoot = realpathSync(new URL("..", import.meta.url).pathname);
const visionRoot = "/workspaces/vending-vision";
const sourceRevision = "3b795364a4d2f3b5adb365f39cdea376d20bc53c";
const temporaryRoots = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    rmSync(temporaryRoots.pop(), { recursive: true, force: true });
  }
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

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function writeMaterial(root, name, value) {
  const path = join(root, name);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  writeFileSync(path, bytes);
  return { byteSize: bytes.byteLength, path, sha256: sha256(bytes) };
}

function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), "vem-precutover-ai-test-"));
  temporaryRoots.push(root);
  const materials = join(root, "materials");
  mkdirSync(materials);
  const directRequirements = [
    "torch==2.8.0+cpu",
    "torchvision==0.23.0+cpu",
    "diffusers==0.29.2",
    "transformers==4.53.3",
    "accelerate==0.31.0",
    "safetensors==0.5.3",
    "scipy==1.16.1",
    "tqdm==4.67.1",
    "opencv-python-headless==4.12.0.88",
  ];
  const aiMaterials = {
    aiLock: writeMaterial(
      materials,
      "requirements-ai.lock.json",
      '{"wheels":[]}\n',
    ),
    modelPackDescriptor: writeMaterial(
      materials,
      "official-ai-model-pack-descriptor.json",
      canonical({
        catvtonSourceRevision: sourceRevision,
        files: [
          {
            byteSize: 1,
            format: "json",
            path: "inpainting/unet/config.json",
            role: "inpainting_unet_config",
            sha256: createHash("sha256").update("x").digest("hex"),
            upstream: "inpainting",
            upstreamPath: "unet/config.json",
          },
        ],
        schemaVersion: "vem-official-ai-model-pack-descriptor/v2",
        totalByteSize: 1,
        upstreams: [],
      }),
    ),
    runtimeDescriptor: writeMaterial(
      materials,
      "ai-runtime-descriptor.json",
      canonical({
        directRequirements,
        python: "3.11.9",
        requirementsAiLockSha256: "a".repeat(64),
        requirementsAiSha256: "b".repeat(64),
        schemaVersion: "vem-ai-runtime-descriptor/v1",
        target: "windows-x86_64",
        workerLayout: {
          mainOnedir: "vending-vision",
          modelPackEnv: "VEM_AI_MODEL_PACK",
          workerExecutable:
            "vending-vision-ai-worker/vending-vision-ai-worker.exe",
          workerOnedir: "vending-vision-ai-worker",
        },
      }),
    ),
    sourceDescriptor: writeMaterial(
      materials,
      "official-ai-source-descriptor.json",
      canonical({
        catvtonSourceRevision: sourceRevision,
        schemaVersion: "vem-official-ai-source-descriptor/v1",
        sources: [],
      }),
    ),
    workerExecutable: writeMaterial(
      materials,
      "vending-vision-ai-worker.exe",
      "test worker",
    ),
  };
  aiMaterials.workerFiles = Object.values(aiMaterials).map((file) => ({
    ...file,
    relative: file.path.slice(materials.length + 1),
  }));
  const modelPack = join(root, "official-model-pack.zip");
  writeFileSync(modelPack, "test-owned model pack bytes");
  const modelPackFacts = {
    byteSize: readFileSync(modelPack).byteLength,
    sha256: sha256(readFileSync(modelPack)),
  };
  const releaseSet = {
    ai: {
      modelDescriptorSha256: aiMaterials.modelPackDescriptor.sha256,
      modelPackArchive: modelPackFacts,
      requirementsLockSha256: aiMaterials.aiLock.sha256,
      runtimeDescriptorSha256: aiMaterials.runtimeDescriptor.sha256,
    },
  };
  const receipt = {
    identityRoot: {
      approvedPrecutoverSha256: `sha256:${"a".repeat(64)}`,
      releaseApprovalSha256: `sha256:${"b".repeat(64)}`,
      releaseSetSha256: `sha256:${"c".repeat(64)}`,
    },
    vision: {
      archive: { byteSize: 100, sha256: `sha256:${"d".repeat(64)}` },
      embeddedManifestSha256: `sha256:${"e".repeat(64)}`,
      sourceCommit: "f".repeat(40),
      v2BundleSha256: `sha256:${"1".repeat(64)}`,
    },
  };
  const output = join(root, "precutover-ai-receipt.json");
  const options = {
    approved: join(root, "approved.json"),
    approval: join(root, "approval.json"),
    "approval-attestation-bundle": join(root, "approval.sigstore.json"),
    "database-backup": join(root, "database.dump"),
    "docker-binary": "/usr/bin/docker",
    "gh-binary": "/usr/bin/gh",
    "model-pack-archive": modelPack,
    output,
    python: "/usr/bin/python3.11",
    "release-set": join(root, "release-set.json"),
    "release-set-input-directory": join(root, "release-input"),
    "repo-root": repoRoot,
    "vem-runtime-archive": join(root, "vem-runtime.zip"),
    "vision-ai-verifier-root": visionRoot,
    "vision-candidate-input-directory": join(root, "candidate-input"),
    "vision-verifier-root": visionRoot,
  };
  return {
    aiMaterials,
    directRequirements,
    modelPack,
    modelPackFacts,
    options,
    output,
    receipt,
    releaseSet,
    root,
  };
}

function versionPayload(directRequirements, probe, overrides = {}) {
  const value = { catvtonSourceRevision: sourceRevision, probe };
  for (const requirement of directRequirements) {
    const [, name, version] = /^([a-z0-9-]+)==(.+)$/.exec(requirement);
    value[name] = version;
  }
  return { ...value, ...overrides };
}

function envelope(payload) {
  return canonical({ returncode: 0, stderr: "", stdout: canonical(payload) });
}

function dependencies(fixture, overrides = {}) {
  const events = [];
  return {
    events,
    platform: overrides.platform ?? "win32",
    async proveRuntimeArtifacts(options, destination) {
      events.push("fresh-runtime-proof");
      mkdirSync(destination);
      writeFileSync(options.output, canonical(fixture.receipt));
      return {
        aiMaterials: fixture.aiMaterials,
        receipt: fixture.receipt,
        releaseSet: fixture.releaseSet,
      };
    },
    async runModelVerifier(context) {
      events.push("official-model-verifier");
      if (overrides.modelFailure) throw new Error(overrides.modelFailure);
      const installedPack = join(
        context.installRoot,
        "packs",
        context.modelIdentity.sha256.slice(7),
      );
      mkdirSync(installedPack, { recursive: true });
      mkdirSync(join(installedPack, "inpainting/unet"), { recursive: true });
      writeFileSync(join(installedPack, "inpainting/unet/config.json"), "x");
      overrides.afterModelVerifier?.(context);
      return canonical({
        archive: {
          byteSize: context.modelIdentity.byteSize,
          sha256: context.modelIdentity.sha256.slice(7),
        },
        descriptor: {
          catvtonSourceRevision: sourceRevision,
          schemaVersion: "vem-official-ai-model-pack-descriptor/v2",
          sha256: context.descriptorIdentity.sha256.slice(7),
          totalByteSize: 1,
          upstreams: [],
        },
        installedPack,
        schemaVersion: "vending-vision-precutover-model-pack-proof/v1",
      });
    },
    async runWorkerProbe(context) {
      events.push(`${context.mode}-worker-probe`);
      const probe =
        context.mode === "runtime"
          ? "official-catvton-worker-runtime"
          : "official-catvton-worker";
      const mutation =
        context.mode === "model" ? overrides.modelProbeMutation : undefined;
      overrides.duringWorkerProbe?.(context);
      return envelope(
        versionPayload(fixture.directRequirements, probe, mutation),
      );
    },
    async stagePython() {
      events.push("trusted-python");
      return "/usr/bin/python3.11";
    },
  };
}

async function run(fixture, dependencyOverrides = {}) {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "test";
  const deps = dependencies(fixture, dependencyOverrides);
  try {
    const receiptText = await verifyPrecutoverAiForTest(fixture.options, deps);
    return { deps, receiptText, status: 0 };
  } catch (error) {
    return { deps, error, status: 1 };
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

describe("pre-cutover official model pack and packaged AI worker proof", () => {
  it("requires actual model-pack bytes and publishes only after both worker probes", async () => {
    const fixture = buildFixture();

    const result = await run(fixture);

    assert.equal(result.status, 0, result.error?.stack);
    assert.deepEqual(result.deps.events, [
      "fresh-runtime-proof",
      "trusted-python",
      "official-model-verifier",
      "runtime-worker-probe",
      "model-worker-probe",
    ]);
    assert.equal(readFileSync(fixture.output, "utf8"), result.receiptText);
    const receipt = JSON.parse(result.receiptText);
    assert.equal(receipt.schemaVersion, "vem.precutover.ai.v1");
    assert.equal(
      receipt.modelPack.archive.sha256,
      fixture.modelPackFacts.sha256,
    );
    assert.equal(
      receipt.runtime.workerExecutableSha256,
      fixture.aiMaterials.workerExecutable.sha256,
    );
    assert.equal(receipt.probes.model.probe, "official-catvton-worker");
  });

  it("rejects a string-only release identity when the actual model archive is absent", async () => {
    const fixture = buildFixture();
    rmSync(fixture.modelPack);

    const result = await run(fixture);

    assert.notEqual(result.status, 0);
    assert.match(result.error.message, /model-pack|no such file/i);
    assert.equal(existsSync(fixture.output), false);
    assert.deepEqual(result.deps.events, ["fresh-runtime-proof"]);
  });

  it("rejects a model archive whose bytes differ from the authenticated release-set", async () => {
    const fixture = buildFixture();
    writeFileSync(fixture.modelPack, "attacker model pack");

    const result = await run(fixture);

    assert.notEqual(result.status, 0);
    assert.match(
      result.error.message,
      /model-pack archive release identity mismatch/,
    );
    assert.equal(existsSync(fixture.output), false);
    assert.equal(result.deps.events.includes("official-model-verifier"), false);
  });

  it("leaves no receipt when official ZIP verification rejects corrupt or extra members", async () => {
    const fixture = buildFixture();

    const result = await run(fixture, {
      modelFailure: "official ZIP contains an extra member",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.error.message, /extra member/);
    assert.equal(existsSync(fixture.output), false);
    assert.equal(result.deps.events.includes("runtime-worker-probe"), false);
  });

  it("rejects an exact-JSON emitter with a wrong dependency version", async () => {
    const fixture = buildFixture();

    const result = await run(fixture, {
      modelProbeMutation: { torch: "9.9.0+cpu" },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.error.message, /dependency mismatch: torch/);
    assert.equal(existsSync(fixture.output), false);
  });

  it("fails closed outside Windows after official model-pack validation", async () => {
    const fixture = buildFixture();

    const result = await run(fixture, { platform: "linux" });

    assert.notEqual(result.status, 0);
    assert.match(result.error.message, /requires Windows/);
    assert.deepEqual(result.deps.events, [
      "fresh-runtime-proof",
      "trusted-python",
      "official-model-verifier",
    ]);
    assert.equal(existsSync(fixture.output), false);
  });

  for (const mutation of ["atomic replacement", "in-place rewrite"]) {
    it(`rejects model archive ${mutation} after the official verifier consumed private bytes`, async () => {
      const fixture = buildFixture();

      const result = await run(fixture, {
        afterModelVerifier() {
          const bytes = readFileSync(fixture.modelPack);
          if (mutation === "atomic replacement") {
            const replacement = `${fixture.modelPack}.replacement`;
            writeFileSync(replacement, bytes);
            renameSync(replacement, fixture.modelPack);
          } else {
            writeFileSync(fixture.modelPack, bytes);
          }
        },
      });

      assert.notEqual(result.status, 0);
      assert.match(
        result.error.message,
        /model-pack.*identity changed|content changed/i,
      );
      assert.equal(existsSync(fixture.output), false);
    });
  }

  it("rejects an installed model file changed while the worker probe consumes it", async () => {
    const fixture = buildFixture();
    let mutated = false;

    const result = await run(fixture, {
      duringWorkerProbe({ mode, modelPack }) {
        if (mode !== "model" || mutated) return;
        mutated = true;
        writeFileSync(join(modelPack, "inpainting/unet/config.json"), "y");
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(
      result.error.message,
      /installed model file.*content changed/i,
    );
    assert.equal(existsSync(fixture.output), false);
  });

  for (const mutation of ["atomic replacement", "in-place rewrite"]) {
    it(`rejects packaged worker source ${mutation} while a production probe is running`, async () => {
      const fixture = buildFixture();
      let mutated = false;

      const result = await run(fixture, {
        duringWorkerProbe({ mode }) {
          if (mode !== "runtime" || mutated) return;
          mutated = true;
          const path = fixture.aiMaterials.workerExecutable.path;
          const bytes = readFileSync(path);
          if (mutation === "atomic replacement") {
            const replacement = `${path}.replacement`;
            writeFileSync(replacement, bytes);
            renameSync(replacement, path);
          } else {
            writeFileSync(path, bytes);
          }
        },
      });

      assert.notEqual(result.status, 0);
      assert.match(
        result.error.message,
        /packaged worker.*identity changed|content changed/i,
      );
      assert.equal(existsSync(fixture.output), false);
    });
  }

  it("replays the fresh runtime, model archive, and both probes on every invocation", async () => {
    const first = buildFixture();
    const second = buildFixture();

    const firstResult = await run(first);
    const secondResult = await run(second);

    assert.equal(firstResult.status, 0, firstResult.error?.stack);
    assert.equal(secondResult.status, 0, secondResult.error?.stack);
    assert.deepEqual(firstResult.deps.events, secondResult.deps.events);
  });
});
