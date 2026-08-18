import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  syncVisionArtifactPair,
  writeHostConfigVisionCore,
} from "./sync-vision-artifacts.mjs";

const COMMIT = "234e2961adff5c4e8fc58b29b6f67869007e5718";

function makeCandidateArchive(root, commit) {
  const inner = join(root, "candidate-inner");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(inner, "runtime.bin"), "runtime-bytes");
  const runtimeZipName = `vending-vision-${commit}.zip`;
  execFileSync("zip", ["-qj", join(inner, runtimeZipName), join(inner, "runtime.bin")]);
  const manifest = {
    schemaVersion: "vending-vision-candidate-artifact/v3",
    sourceCommit: commit,
    files: [],
  };
  writeFileSync(
    join(inner, "candidate-manifest.json"),
    `${JSON.stringify(manifest)}\n`,
  );
  const outer = join(root, "candidate-outer.zip");
  execFileSync("zip", ["-qj", outer, join(inner, runtimeZipName), join(inner, "candidate-manifest.json")]);
  return outer;
}

function makeMainArchive(root, commit) {
  const inner = join(root, "main-inner");
  mkdirSync(inner, { recursive: true });
  writeFileSync(join(inner, "fixture.bin"), "fixture-bytes");
  execFileSync("zip", ["-qj", join(inner, "fixture.zip"), join(inner, "fixture.bin")]);
  const manifest = {
    schemaVersion: "vending-vision-main-artifacts/v1",
    commit: COMMIT,
    fixtures: { file: "fixture.zip", sha256: "" },
  };
  manifest.fixtures.sha256 = sha256File(join(inner, "fixture.zip"));
  writeFileSync(
    join(inner, "vending-vision-main-artifacts.json"),
    `${JSON.stringify(manifest)}\n`,
  );
  const outer = join(root, "outer.zip");
  execFileSync("zip", ["-qj", outer, join(inner, "fixture.zip"), join(inner, "vending-vision-main-artifacts.json")]);
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
    const candidateOuter = makeCandidateArchive(root, COMMIT);
    const { outer, manifest } = makeMainArchive(root, COMMIT);
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

    const result = await syncVisionArtifactPair({
      candidateArchivePath: candidateOuter,
      mainArchivePath: outer,
      commit: COMMIT,
      outputRoot,
      hostConfigPath: configPath,
    });

    assert.equal(result.runtimeArchive.sourceCommit, COMMIT);
    assert.ok(result.runtimeArchive.sha256.match(/^[a-f0-9]{64}$/));
    assert.equal(result.recordedFixtureArchive.sha256, manifest.fixtures.sha256);
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.visionCoreArtifacts.runtimeArchive.sourceCommit, COMMIT);
    assert.equal(
      config.visionCoreArtifacts.recordedFixtureArchive.sha256,
      manifest.fixtures.sha256,
    );
  });

  it("rejects an outer archive whose manifest commit does not match", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-sync-commit-"));
    const candidateOuter = makeCandidateArchive(root, COMMIT);
    const { outer } = makeMainArchive(root, COMMIT);
    const outputRoot = join(root, "cache");
    const configPath = hostConfigPath();
    writeFileSync(configPath, "{}");
    await assert.rejects(
      syncVisionArtifactPair({
          candidateArchivePath: candidateOuter,
          mainArchivePath: outer,
          commit: "a".repeat(40),
          outputRoot,
          hostConfigPath: configPath,
        }),
      /commit mismatch/,
    );
    assert.equal(readFileSync(configPath, "utf8"), "{}");
  });
});
