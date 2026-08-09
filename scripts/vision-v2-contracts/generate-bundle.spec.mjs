import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));

function withTemporaryBundles(callback) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "vem-vision-v2-contracts-"));
  const sourceOutput = join(temporaryRoot, "shared");
  const visionRoot = join(temporaryRoot, "vision");
  try {
    return callback({ sourceOutput, visionRoot });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

function generate({ sourceOutput, visionRoot, check = false }) {
  return spawnSync(
    "pnpm",
    [
      "exec",
      "tsx",
      "scripts/vision-v2-contracts/generate-bundle.ts",
      ...(check ? ["--check"] : []),
      "--source-output",
      sourceOutput,
      "--vision-root",
      visionRoot,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --conditions=vem-source`,
      },
    },
  );
}

test("publishes byte-stable bundles only into temporary cross-repository targets", () => {
  withTemporaryBundles(({ sourceOutput, visionRoot }) => {
    assert.equal(generate({ sourceOutput, visionRoot }).status, 0);
    const sourceManifest = readFileSync(
      join(sourceOutput, "manifest.json"),
      "utf8",
    );
    assert.equal(generate({ sourceOutput, visionRoot }).status, 0);
    assert.equal(
      readFileSync(join(sourceOutput, "manifest.json"), "utf8"),
      sourceManifest,
    );
    assert.equal(
      readFileSync(
        join(visionRoot, "contracts/vem_vision_v2/manifest.json"),
        "utf8",
      ),
      sourceManifest,
    );
    assert.equal(generate({ sourceOutput, visionRoot, check: true }).status, 0);
  });
});

test("detects a tampered manifest and unexpected generated file", () => {
  withTemporaryBundles(({ sourceOutput, visionRoot }) => {
    assert.equal(generate({ sourceOutput, visionRoot }).status, 0);
    writeFileSync(join(sourceOutput, "manifest.json"), "{}\n", "utf8");
    const manifestDrift = generate({ sourceOutput, visionRoot, check: true });
    assert.notEqual(manifestDrift.status, 0);
    assert.match(manifestDrift.stderr, /Vision V2 contract bundle drifted/);

    assert.equal(generate({ sourceOutput, visionRoot }).status, 0);
    writeFileSync(join(sourceOutput, "unexpected.json"), "{}\n", "utf8");
    const extraFileDrift = generate({ sourceOutput, visionRoot, check: true });
    assert.notEqual(extraFileDrift.status, 0);
    assert.match(extraFileDrift.stderr, /unexpected\.json/);
  });
});
