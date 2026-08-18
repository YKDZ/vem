import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  syncVisionArtifactsFromArchive,
  writeHostConfigVisionCore,
} from "./sync-vision-artifacts.mjs";

const COMMIT = "234e2961adff5c4e8fc58b29b6f67869007e5718";

function makeArchive(root) {
  const inner = join(root, "inner");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(inner, "runtime.bin"), "runtime-bytes");
  writeFileSync(join(inner, "fixture.bin"), "fixture-bytes");
  execFileSync("zip", ["-qj", join(inner, "runtime.zip"), join(inner, "runtime.bin")]);
  execFileSync("zip", ["-qj", join(inner, "fixture.zip"), join(inner, "fixture.bin")]);
  const manifest = {
    schemaVersion: "vending-vision-main-artifacts/v1",
    commit: COMMIT,
    runtime: { file: "runtime.zip", sha256: "" },
    fixtures: { file: "fixture.zip", sha256: "" },
  };
  manifest.runtime.sha256 = sha256File(join(inner, "runtime.zip"));
  manifest.fixtures.sha256 = sha256File(join(inner, "fixture.zip"));
  writeFileSync(
    join(inner, "vending-vision-main-artifacts.json"),
    `${JSON.stringify(manifest)}\n`,
  );
  const outer = join(root, "outer.zip");
  execFileSync("zip", ["-qj", outer, ...Object.keys({
    "runtime.zip": join(inner, "runtime.zip"),
    "fixture.zip": join(inner, "fixture.zip"),
    "vending-vision-main-artifacts.json": join(
      inner,
      "vending-vision-main-artifacts.json",
    ),
  }).map((name) => join(inner, name))]);
  return { outer, manifest };
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hostConfigPath() {
  const root = mkdtempSync(join(tmpdir(), "vem-sync-"));
  return join(root, "host-config.json");
}

describe("Vision artifact pair sync", () => {
  it("registers the runtime and fixture identities from a valid outer archive", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-sync-outer-"));
    const { outer, manifest } = makeArchive(root);
    const outputRoot = join(root, "cache");
    const configPath = hostConfigPath();
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: "vem-runtime-testbed-host/v1",
        visionCoreArtifacts: {
          runtimeArchive: { hostPath: "", sha256: "", byteSize: 0, sourceCommit: "" },
          recordedFixtureArchive: {
            hostPath: "",
            sha256: "",
            byteSize: 0,
            sourceCommit: "",
          },
        },
      }),
    );

    const result = await syncVisionArtifactsFromArchive({
      archivePath: outer,
      commit: COMMIT,
      outputRoot,
      hostConfigPath: configPath,
    });

    assert.equal(result.runtimeArchive.sourceCommit, COMMIT);
    assert.equal(result.runtimeArchive.sha256, manifest.runtime.sha256);
    assert.equal(result.recordedFixtureArchive.sha256, manifest.fixtures.sha256);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(
      config.visionCoreArtifacts.runtimeArchive.sha256,
      manifest.runtime.sha256,
    );
    assert.equal(
      config.visionCoreArtifacts.recordedFixtureArchive.sha256,
      manifest.fixtures.sha256,
    );
  });

  it("rejects an outer archive whose manifest commit does not match", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-sync-commit-"));
    const { outer } = makeArchive(root);
    const outputRoot = join(root, "cache");
    const configPath = hostConfigPath();
    writeFileSync(configPath, "{}");
    await assert.rejects(
      syncVisionArtifactsFromArchive({
          archivePath: outer,
          commit: "a".repeat(40),
          outputRoot,
          hostConfigPath: configPath,
        }),
      /commit mismatch/,
    );
    assert.equal(readFileSync(configPath, "utf8"), "{}");
  });
});
