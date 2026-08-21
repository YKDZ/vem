import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  parseSyncOptions,
  syncVisionArtifactPair,
  writeHostConfigVisionCore,
} from "./sync-vision-artifacts.ts";

const COMMIT = "234e2961adff5c4e8fc58b29b6f67869007e5718";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function makeMainArtifactRoot(root, commit = COMMIT) {
  const artifactRoot = join(root, "main-artifact");
  mkdirSync(artifactRoot, { recursive: true });
  const runtime = Buffer.from("runtime-bytes");
  const fixtures = Buffer.from("fixture-bytes");
  writeFileSync(
    join(artifactRoot, "vending-vision-windows-x86_64.zip"),
    runtime,
  );
  writeFileSync(
    join(artifactRoot, "vending-vision-test-fixtures.zip"),
    fixtures,
  );
  const manifest = {
    schemaVersion: "vending-vision-main-artifacts/v1",
    commit,
    runtime: {
      file: "vending-vision-windows-x86_64.zip",
      sha256: sha256(runtime),
      bytes: runtime.byteLength,
    },
    fixtures: {
      file: "vending-vision-test-fixtures.zip",
      sha256: sha256(fixtures),
      bytes: fixtures.byteLength,
    },
  };
  writeFileSync(
    join(artifactRoot, "vending-vision-main-artifacts.json"),
    `${JSON.stringify(manifest)}\n`,
  );
  return { artifactRoot, manifest };
}

function makeHostConfig(root) {
  const configPath = join(root, "host-config.json");
  writeFileSync(configPath, JSON.stringify({ schemaVersion: "host/v1" }));
  return configPath;
}

describe("Vision main artifact sync", () => {
  it("registers the manifest-bound runtime and fixture from one local artifact root", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-sync-main-"));
    const { artifactRoot, manifest } = makeMainArtifactRoot(root);
    const configPath = makeHostConfig(root);

    const result = await syncVisionArtifactPair({
      mainArtifactRoot: artifactRoot,
      commit: COMMIT,
      outputRoot: join(root, "cache"),
      hostConfigPath: configPath,
    });

    assert.equal(result.runtimeArchive.sha256, manifest.runtime.sha256);
    assert.equal(result.runtimeArchive.byteSize, manifest.runtime.bytes);
    assert.equal(
      result.recordedFixtureArchive.sha256,
      manifest.fixtures.sha256,
    );
    assert.equal(
      result.recordedFixtureArchive.byteSize,
      manifest.fixtures.bytes,
    );
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.deepEqual(Object.keys(config.visionCoreArtifacts).sort(), [
      "recordedFixtureArchive",
      "runtimeArchive",
    ]);
  });

  it("rejects a manifest-bound archive when its bytes or digest are tampered", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-sync-tampered-"));
    const { artifactRoot } = makeMainArtifactRoot(root);
    writeFileSync(
      join(artifactRoot, "vending-vision-windows-x86_64.zip"),
      "tampered",
    );
    const configPath = makeHostConfig(root);

    await assert.rejects(
      syncVisionArtifactPair({
        mainArtifactRoot: artifactRoot,
        commit: COMMIT,
        outputRoot: join(root, "cache"),
        hostConfigPath: configPath,
      }),
      /runtime .*SHA-256|runtime .*bytes/,
    );
  });

  it("rejects a missing manifest-bound member", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-sync-missing-member-"));
    const { artifactRoot } = makeMainArtifactRoot(root);
    const configPath = makeHostConfig(root);
    rmSync(join(artifactRoot, "vending-vision-test-fixtures.zip"));

    await assert.rejects(
      syncVisionArtifactPair({
        mainArtifactRoot: artifactRoot,
        commit: COMMIT,
        outputRoot: join(root, "cache"),
        hostConfigPath: configPath,
      }),
      /fixtures delivery manifest member is missing/,
    );
  });

  it("rejects a manifest-bound member redirected to a non-regular file", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-sync-invalid-member-"));
    const { artifactRoot } = makeMainArtifactRoot(root);
    const configPath = makeHostConfig(root);
    const fixturePath = join(artifactRoot, "vending-vision-test-fixtures.zip");
    const linkedTarget = join(artifactRoot, "linked.zip");
    renameSync(fixturePath, linkedTarget);
    symlinkSync(linkedTarget, fixturePath);

    await assert.rejects(
      syncVisionArtifactPair({
        mainArtifactRoot: artifactRoot,
        commit: COMMIT,
        outputRoot: join(root, "cache"),
        hostConfigPath: configPath,
      }),
      /fixtures .*regular file/,
    );
  });

  it("rejects an invalid delivery schema", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-sync-invalid-manifest-"));
    const { artifactRoot } = makeMainArtifactRoot(root);
    const configPath = makeHostConfig(root);
    const manifestPath = join(
      artifactRoot,
      "vending-vision-main-artifacts.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.schemaVersion = "invalid/v1";
    writeFileSync(manifestPath, JSON.stringify(manifest));

    await assert.rejects(
      syncVisionArtifactPair({
        mainArtifactRoot: artifactRoot,
        commit: COMMIT,
        outputRoot: join(root, "cache"),
        hostConfigPath: configPath,
      }),
      /schema is invalid/,
    );
  });

  it("rejects a delivery manifest from another commit", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-sync-wrong-commit-"));
    const { artifactRoot } = makeMainArtifactRoot(root, "a".repeat(40));
    const configPath = makeHostConfig(root);

    await assert.rejects(
      syncVisionArtifactPair({
        mainArtifactRoot: artifactRoot,
        commit: COMMIT,
        outputRoot: join(root, "cache"),
        hostConfigPath: configPath,
      }),
      /commit mismatch/,
    );
  });

  it("accepts a local main artifact root", () => {
    const options = parseSyncOptions([
      "--commit",
      COMMIT,
      "--output-root",
      "/tmp/cache",
      "--host-config",
      "/tmp/host.json",
      "--main-artifact-root",
      "/tmp/main-artifact",
    ]);
    assert.equal(options.mainArtifactRoot, "/tmp/main-artifact");
  });

  it("accepts the main download entry and rejects unknown inputs", () => {
    const downloaded = parseSyncOptions([
      "--commit",
      COMMIT,
      "--output-root",
      "/tmp/cache",
      "--host-config",
      "/tmp/host.json",
      "--download",
    ]);
    assert.equal(downloaded.download, true);
    assert.throws(
      () =>
        parseSyncOptions([
          "--commit",
          COMMIT,
          "--output-root",
          "/tmp/cache",
          "--host-config",
          "/tmp/host.json",
          "--retired-input",
          "/tmp/retired.zip",
        ]),
      /unknown option/,
    );
  });
});

describe("host config", () => {
  it("replaces Vision core artifacts atomically", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-sync-config-"));
    const configPath = makeHostConfig(root);
    await writeHostConfigVisionCore(configPath, {
      runtimeArchive: { hostPath: "/tmp/runtime.zip" },
      recordedFixtureArchive: { hostPath: "/tmp/fixtures.zip" },
    });
    assert.deepEqual(
      Object.keys(
        JSON.parse(readFileSync(configPath, "utf8")).visionCoreArtifacts,
      ).sort(),
      ["recordedFixtureArchive", "runtimeArchive"],
    );
  });
});
