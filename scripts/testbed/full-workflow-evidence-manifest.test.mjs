import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  buildFullWorkflowEvidenceManifest,
  validateFullWorkflowEvidenceManifest,
} from "./full-workflow-evidence-manifest.mjs";

const roots = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function root() {
  const value = mkdtempSync(join(tmpdir(), "vem-workflow-evidence-"));
  roots.push(value);
  return value;
}

describe("full workflow evidence manifest", () => {
  it("indexes bounded traces, logs, and screenshots", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "report.json");
    writeFileSync(report, "{}\n");
    writeFileSync(join(artifacts, "runtime.log"), "ok\n");
    writeFileSync(join(artifacts, "checkpoint.png"), "png");
    const manifest = buildFullWorkflowEvidenceManifest({
      reportPaths: [report],
      artifactRoots: [artifacts],
    });
    assert.equal(manifest.ok, true);
    assert.deepEqual(validateFullWorkflowEvidenceManifest(manifest), []);
  });

  it("fails closed for missing screenshots and forbidden WAV evidence", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "report.json");
    writeFileSync(report, "{}\n");
    writeFileSync(join(artifacts, "runtime.log"), "ok\n");
    writeFileSync(join(artifacts, "capture.wav"), "audio");
    const manifest = buildFullWorkflowEvidenceManifest({
      reportPaths: [report],
      artifactRoots: [artifacts],
    });
    assert.equal(manifest.ok, false);
    assert.ok(
      manifest.failures.some((failure) => failure.includes("forbidden")),
    );
    assert.ok(
      manifest.failures.some((failure) => failure.includes("screenshots")),
    );
  });
});
