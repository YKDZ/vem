import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { createFullWorkflowEvidenceBundle } from "./full-workflow-evidence-bundle.mjs";
import { buildFullWorkflowEvidenceManifest } from "./full-workflow-evidence-manifest.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vem-evidence-bundle-"));
  roots.push(root);
  const artifactRoot = join(root, "artifacts");
  mkdirSync(artifactRoot);
  const logPath = join(artifactRoot, "runtime.log");
  const pngPath = join(artifactRoot, "result.png");
  writeFileSync(logPath, "original log\n");
  writeFileSync(pngPath, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  const reportPath = join(root, "sale.json");
  writeFileSync(reportPath, '{"runtimeTrace":[{"id":"trace-1"}]}\n');
  const manifest = buildFullWorkflowEvidenceManifest({
    tracks: [{ key: "sale", reportPath, artifactRoot }],
  });
  const manifestPath = join(root, "full-workflow-evidence-manifest.json");
  const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestRaw);
  const summaryPath = join(root, "full-workflow-tracks.json");
  writeFileSync(
    summaryPath,
    `${JSON.stringify({
      ok: true,
      businessOutcome: { ok: true },
      evidenceInventory: {
        ok: true,
        reportPath: manifestPath,
        manifestFile: {
          byteLength: Buffer.byteLength(manifestRaw),
          sha256: createHash("sha256").update(manifestRaw).digest("hex"),
        },
      },
    })}\n`,
  );
  const smokePath = join(root, "installed-runtime-smoke.json");
  writeFileSync(smokePath, '{"ok":true}\n');
  return {
    root,
    artifactRoot,
    logPath,
    pngPath,
    manifestPath,
    summaryPath,
    smokePath,
    bundleRoot: join(root, "full-workflow-evidence-bundle"),
  };
}

function publishNoReplace(source, destination) {
  if (existsSync(destination)) throw new Error("bundle destination exists");
  renameSync(source, destination);
}

function filesRecursively(root, prefix = "") {
  return readdirSync(join(root, prefix), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = join(prefix, entry.name);
      return entry.isDirectory() ? filesRecursively(root, path) : [path];
    },
  );
}

describe("full workflow evidence bundle", () => {
  it("rejects an in-place log change after validation", () => {
    const input = fixture();
    assert.throws(
      () =>
        createFullWorkflowEvidenceBundle(input, {
          copyFile(source, destination, index) {
            copyFileSync(source, destination);
            if (index === 0) writeFileSync(input.logPath, "changed log!\n");
          },
          publishDirectory: publishNoReplace,
        }),
      /changed|digest|size/,
    );
    assert.equal(existsSync(input.bundleRoot), false);
  });

  it("rejects an atomically replaced PNG after validation", () => {
    const input = fixture();
    assert.throws(
      () =>
        createFullWorkflowEvidenceBundle(input, {
          copyFile(source, destination, index) {
            copyFileSync(source, destination);
            if (index !== 0) return;
            const next = join(input.artifactRoot, "replacement.png");
            writeFileSync(
              next,
              Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 2]),
            );
            renameSync(next, input.pngPath);
          },
          publishDirectory: publishNoReplace,
        }),
      /changed|digest|size/,
    );
    assert.equal(existsSync(input.bundleRoot), false);
  });

  it("cleans partial staging when the Nth copy fails", () => {
    const input = fixture();
    assert.throws(
      () =>
        createFullWorkflowEvidenceBundle(input, {
          copyFile(source, destination, index) {
            if (index === 2) throw new Error("injected third copy failure");
            copyFileSync(source, destination);
          },
          publishDirectory: publishNoReplace,
        }),
      /third copy failure/,
    );
    assert.equal(existsSync(input.bundleRoot), false);
    assert.deepEqual(
      readdirSync(input.root).filter((name) => name.includes(".bundle-stage-")),
      [],
    );
  });

  it("publishes an exact bundle and preserves a preexisting destination", () => {
    const input = fixture();
    const result = createFullWorkflowEvidenceBundle(input, {
      copyFile(source, destination) {
        copyFileSync(source, destination);
      },
      publishDirectory: publishNoReplace,
    });
    assert.equal(existsSync(input.bundleRoot), true);
    assert.deepEqual(filesRecursively(input.bundleRoot).sort(), result.files);
    assert.equal(
      readFileSync(
        join(input.bundleRoot, "metadata", basename(input.summaryPath)),
        "utf8",
      ),
      readFileSync(input.summaryPath, "utf8"),
    );

    const second = fixture();
    mkdirSync(second.bundleRoot);
    writeFileSync(join(second.bundleRoot, "sentinel"), "keep\n");
    assert.throws(
      () =>
        createFullWorkflowEvidenceBundle(second, {
          copyFile(source, destination) {
            copyFileSync(source, destination);
          },
          publishDirectory: publishNoReplace,
        }),
      /destination exists/,
    );
    assert.equal(
      readFileSync(join(second.bundleRoot, "sentinel"), "utf8"),
      "keep\n",
    );
  });

  it(
    "fails closed where an exclusive directory publish primitive is unavailable",
    {
      skip: process.platform === "win32",
    },
    () => {
      const input = fixture();
      assert.throws(
        () => createFullWorkflowEvidenceBundle(input),
        /exclusive evidence bundle directory publication is unsupported/,
      );
      assert.equal(existsSync(input.bundleRoot), false);
      assert.deepEqual(
        readdirSync(input.root).filter((name) =>
          name.includes(".bundle-stage-"),
        ),
        [],
      );
    },
  );
});
