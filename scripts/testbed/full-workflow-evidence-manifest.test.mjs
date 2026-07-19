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
  it("requires bounded Machine Runtime Trace, log, and PNG evidence for each track", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "report.json");
    writeFileSync(report, '{"runtimeTrace":[{"id":"trace-1"}]}\n');
    writeFileSync(join(artifacts, "runtime.log"), "ok\n");
    writeFileSync(
      join(artifacts, "checkpoint.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    writeFileSync(
      join(artifacts, "failure.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    );
    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [{ key: "fast", reportPath: report, artifactRoot: artifacts }],
    });
    assert.equal(manifest.ok, true);
    assert.equal(manifest.tracks[0].key, "fast");
    assert.match(manifest.tracks[0].machineRuntimeTrace, /#runtimeTrace$/);
    assert.equal(manifest.tracks[0].logs.length, 1);
    assert.equal(manifest.tracks[0].screenshots.length, 1);
    assert.match(manifest.tracks[0].screenshots[0], /failure\.png$/);
    assert.deepEqual(validateFullWorkflowEvidenceManifest(manifest), []);
    const tampered = structuredClone(manifest);
    tampered.totals.byteLength = 0;
    tampered.tracks[0].screenshots = ["other-track.png"];
    const failures = validateFullWorkflowEvidenceManifest(tampered);
    assert.ok(failures.some((failure) => failure.includes("not owned")));
    assert.ok(failures.some((failure) => failure.includes("inconsistent")));
  });

  it("binds all six workflow tracks to their own real evidence", () => {
    const temp = root();
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const definitions = [
      ["fast", { runtimeTrace: [{ id: "fast-trace" }] }, true],
      ["delayedPickup", { ok: true }, true],
      [
        "scanner",
        {
          runtimeTrace: [{ id: "scanner-trace" }],
          serial: { rawFrames: [{ bytesHex: "55f0" }] },
        },
        false,
      ],
      [
        "ipcRecovery",
        {
          ipcRecovery: {
            provenance: {
              ui: {
                before: { runtimeTrace: [{ id: "ipc-before" }] },
                after: { runtimeTrace: [{ id: "ipc-after" }] },
              },
            },
          },
          serial: { rawFrames: [{ parsedOpcode: "F0" }] },
        },
        false,
      ],
      [
        "fulfillmentFailure",
        {
          evidence: {
            ui: { trace: [{ id: "e6-trace" }] },
            platformLog: { log: "refund queued" },
          },
        },
        false,
      ],
      ["visionTryOn", { runtimeTrace: [{ id: "vision-trace" }] }, true],
    ];
    const tracks = definitions.map(([key, reportValue, needsPhysicalLog]) => {
      const artifactRoot = join(temp, `${key}-artifacts`);
      mkdirSync(artifactRoot);
      writeFileSync(join(artifactRoot, `${key}.png`), png);
      if (needsPhysicalLog)
        writeFileSync(join(artifactRoot, `${key}.log`), `${key} log\n`);
      if (key === "delayedPickup") {
        writeFileSync(
          join(artifactRoot, "machine-production-evidence.json"),
          `${JSON.stringify({
            schemaVersion: "machine-production-evidence/v2",
            source: "installed_canonical_machine_cdp",
            runtimeTrace: [{ id: "delayed-trace" }],
          })}\n`,
        );
      }
      const reportPath = join(temp, `${key}.json`);
      writeFileSync(reportPath, `${JSON.stringify(reportValue)}\n`);
      return { key, reportPath, artifactRoot };
    });
    const manifest = buildFullWorkflowEvidenceManifest({ tracks });
    assert.equal(manifest.ok, true, JSON.stringify(manifest.failures));
    assert.equal(manifest.tracks.length, 6);
    assert.equal(manifest.totals.machineRuntimeTrace, 6);
    assert.equal(manifest.totals.screenshots, 6);
    assert.deepEqual(validateFullWorkflowEvidenceManifest(manifest), []);
  });

  it("does not accept arbitrary JSON or another track's global evidence", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "report.json");
    writeFileSync(report, '{"ok":true}\n');
    writeFileSync(join(artifacts, "unrelated.json"), '{"trace":[]}\n');
    writeFileSync(join(artifacts, "runtime.log"), "ok\n");
    writeFileSync(
      join(artifacts, "checkpoint.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [{ key: "fast", reportPath: report, artifactRoot: artifacts }],
    });
    assert.equal(manifest.ok, false);
    assert.ok(
      manifest.failures.some((failure) =>
        failure.includes("Machine Runtime Trace"),
      ),
    );
  });

  it("fails closed for missing PNGs and forbidden WAV evidence", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "report.json");
    writeFileSync(report, '{"runtimeTrace":[{"id":"trace-1"}]}\n');
    writeFileSync(join(artifacts, "runtime.log"), "ok\n");
    writeFileSync(join(artifacts, "capture.wav"), "audio");
    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [{ key: "fast", reportPath: report, artifactRoot: artifacts }],
    });
    assert.equal(manifest.ok, false);
    assert.ok(
      manifest.failures.some((failure) => failure.includes("forbidden")),
    );
    assert.ok(
      manifest.failures.some((failure) => failure.includes("PNG screenshot")),
    );
  });

  it("keeps a failed business track failed while accepting its structured primary reason and one diagnostic source", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "scanner.json");
    writeFileSync(
      report,
      `${JSON.stringify({
        ok: false,
        errors: { primary: "scanner binding was not ready: null" },
      })}\n`,
    );
    writeFileSync(
      join(artifacts, "scanner-diagnostic.json"),
      '{"binding":null}\n',
    );
    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [
        {
          key: "scanner",
          reportPath: report,
          artifactRoot: artifacts,
          evidence: {
            passed: { trace: true, logs: true, screenshot: true },
            failed: {
              primaryReason: true,
              diagnostic: true,
              trace: false,
              logs: false,
              screenshot: false,
            },
          },
          result: { businessStatus: "failed" },
        },
      ],
    });
    assert.equal(manifest.ok, true, JSON.stringify(manifest.failures));
    assert.equal(manifest.tracks[0].businessStatus, "failed");
    assert.equal(
      manifest.tracks[0].primaryReason,
      "scanner binding was not ready: null",
    );
    assert.equal(manifest.tracks[0].screenshots.length, 0);
  });

  it("uses repository error objects as the failed track primary reason", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "vision.json");
    writeFileSync(report, `${JSON.stringify({ ok: false, error: { name: "Error", message: "Vision fixture unavailable", stack: "Error: Vision fixture unavailable" } })}\n`);
    writeFileSync(join(artifacts, "diagnostic.json"), "{}\n");
    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [{ key: "visionTryOn", reportPath: report, artifactRoot: artifacts, result: { businessStatus: "failed" } }],
    });
    assert.equal(manifest.ok, true, JSON.stringify(manifest.failures));
    assert.equal(manifest.tracks[0].primaryReason, "Error: Vision fixture unavailable");
  });
});
