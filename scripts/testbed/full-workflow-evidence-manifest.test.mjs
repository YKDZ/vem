import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  AI_SUPPORT_EVIDENCE_SCHEMA,
  buildFullWorkflowEvidenceManifest,
  EVIDENCE_LIMITS,
  validateFullWorkflowEvidenceManifest,
  validateFullWorkflowEvidenceOwnedFiles,
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
      tracks: [{ key: "sale", reportPath: report, artifactRoot: artifacts }],
    });
    assert.equal(manifest.ok, true);
    assert.equal(manifest.tracks[0].key, "sale");
    assert.match(manifest.tracks[0].machineRuntimeTrace, /#runtimeTrace$/);
    assert.equal(manifest.tracks[0].logs.length, 1);
    assert.equal(manifest.tracks[0].screenshots.length, 2);
    assert.match(manifest.tracks[0].screenshots[0], /failure\.png$/);
    assert.deepEqual(validateFullWorkflowEvidenceManifest(manifest), []);
    const tampered = structuredClone(manifest);
    tampered.totals.byteLength = 0;
    tampered.tracks[0].screenshots = ["other-track.png"];
    const failures = validateFullWorkflowEvidenceManifest(tampered);
    assert.ok(failures.some((failure) => failure.includes("not owned")));
    assert.ok(failures.some((failure) => failure.includes("inconsistent")));
  });

  it("binds workflow tracks to their own real evidence", () => {
    const temp = root();
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    const definitions = [
      ["sale", { runtimeTrace: [{ id: "sale-trace" }] }, true],
      ["pickupProtocol", { ok: true }, true],
      [
        "scannerPayment",
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
        "fulfillmentRecovery",
        {
          evidence: {
            ui: { trace: [{ id: "e6-trace" }] },
            platformLog: { log: "refund queued" },
          },
        },
        false,
      ],
      ["visionExperience", { runtimeTrace: [{ id: "vision-trace" }] }, true],
      [
        "presenceAndAudio",
        {
          presenceAndAudio: {
            runtimeTrace: [{ id: "presence-and-audio-trace" }],
          },
        },
        true,
      ],
    ];
    const tracks = definitions.map(([key, reportValue, needsPhysicalLog]) => {
      const artifactRoot = join(temp, `${key}-artifacts`);
      mkdirSync(artifactRoot);
      writeFileSync(join(artifactRoot, `${key}.png`), png);
      if (needsPhysicalLog)
        writeFileSync(join(artifactRoot, `${key}.log`), `${key} log\n`);
      if (key === "pickupProtocol") {
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
    assert.equal(manifest.tracks.length, 7);
    assert.equal(manifest.totals.machineRuntimeTrace, 7);
    assert.equal(manifest.totals.screenshots, 7);
    assert.deepEqual(validateFullWorkflowEvidenceManifest(manifest), []);
  });

  it("records absent supporting trace as an inventory warning", () => {
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
      tracks: [{ key: "sale", reportPath: report, artifactRoot: artifacts }],
    });
    assert.equal(manifest.ok, true);
    assert.ok(
      manifest.warnings.some((failure) =>
        failure.includes("Machine Runtime Trace"),
      ),
    );
  });

  it("maps AI virtual try-on runtime trace and rejects model or executable artifacts", () => {
    const temp = root();
    const artifacts = join(temp, "ai-artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "ai-virtual-try-on.json");
    writeFileSync(report, '{"runtimeTrace":[{"id":"ai-trace"}]}\n');
    writeFileSync(join(artifacts, "ai.log"), "installed AI track\n");
    writeFileSync(
      join(artifacts, "result.png"),
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    writeFileSync(join(artifacts, "model.bin"), "forbidden");
    writeFileSync(join(artifacts, "notes.txt"), "not AI evidence\n");
    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [
        { key: "aiVirtualTryOn", reportPath: report, artifactRoot: artifacts },
      ],
    });
    assert.match(manifest.tracks[0].machineRuntimeTrace, /#runtimeTrace$/);
    assert.ok(
      manifest.failures.some((warning) =>
        warning.includes("forbidden AI evidence artifact for aiVirtualTryOn"),
      ),
    );
    assert.equal(manifest.ok, false);
    assert.ok(
      validateFullWorkflowEvidenceManifest(manifest).some((failure) =>
        failure.includes("forbidden AI evidence artifact"),
      ),
    );
  });

  it("fails forbidden artifacts while retaining optional screenshot warnings", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "report.json");
    writeFileSync(report, '{"runtimeTrace":[{"id":"trace-1"}]}\n');
    writeFileSync(join(artifacts, "runtime.log"), "ok\n");
    writeFileSync(join(artifacts, "capture.wav"), "audio");
    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [{ key: "sale", reportPath: report, artifactRoot: artifacts }],
    });
    assert.equal(manifest.ok, false);
    assert.ok(
      manifest.failures.some((failure) => failure.includes("forbidden")),
    );
    assert.ok(
      manifest.warnings.some((failure) => failure.includes("PNG screenshot")),
    );
  });

  it("fails closed when any artifact tree contains an executable", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "report.json");
    writeFileSync(report, '{"runtimeTrace":[{"id":"trace-1"}]}\n');
    writeFileSync(join(artifacts, "runtime.log"), "ok\n");
    writeFileSync(join(artifacts, "unexpected.exe"), Buffer.from("MZpayload"));

    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [{ key: "sale", reportPath: report, artifactRoot: artifacts }],
    });

    assert.equal(manifest.ok, false);
    assert.ok(
      manifest.failures.some((failure) =>
        failure.includes("forbidden evidence artifact"),
      ),
    );
  });

  it("rejects executable magic disguised as AI supporting JSON", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "ai-virtual-try-on.json");
    writeFileSync(report, '{"runtimeTrace":[{"id":"ai-trace"}]}\n');
    writeFileSync(join(artifacts, "runtime.log"), "ok\n");
    writeFileSync(join(artifacts, "worker.json"), Buffer.from("MZpayload"));

    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [
        { key: "aiVirtualTryOn", reportPath: report, artifactRoot: artifacts },
      ],
    });

    assert.equal(manifest.ok, false);
    assert.ok(
      manifest.failures.some((failure) =>
        failure.includes("disguised executable or archive"),
      ),
    );
  });

  it("rejects executable, archive, and media magic behind textual suffixes", () => {
    const signatures = [
      ["ELF", Buffer.from([0x7f, 0x45, 0x4c, 0x46])],
      ["Mach-O", Buffer.from([0xfe, 0xed, 0xfa, 0xcf])],
      ["ZIP", Buffer.from([0x50, 0x4b, 0x03, 0x04])],
      ["media", Buffer.from([0xff, 0xd8, 0xff])],
    ];
    for (const [label, signature] of signatures) {
      const temp = root();
      const artifacts = join(temp, "artifacts");
      mkdirSync(artifacts);
      const report = join(temp, "report.json");
      writeFileSync(report, '{"runtimeTrace":[{"id":"trace-1"}]}\n');
      writeFileSync(join(artifacts, "runtime.log"), "ok\n");
      writeFileSync(
        join(artifacts, "diagnostic.json"),
        Buffer.concat([signature, Buffer.from("payload")]),
      );

      const manifest = buildFullWorkflowEvidenceManifest({
        tracks: [{ key: "sale", reportPath: report, artifactRoot: artifacts }],
      });
      assert.equal(manifest.ok, false, `${label} magic was accepted`);
      assert.ok(
        manifest.failures.some((failure) =>
          failure.includes("disguised executable or archive/media"),
        ),
        `${label} magic did not produce an authority failure`,
      );
    }
  });

  it("accepts only canonical explicitly-versioned AI supporting JSON", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "ai-virtual-try-on.json");
    writeFileSync(report, '{"runtimeTrace":[{"id":"ai-trace"}]}\n');
    writeFileSync(join(artifacts, "runtime.log"), "ok\n");
    writeFileSync(
      join(artifacts, "diagnostic.json"),
      `${JSON.stringify({
        facts: { aiReady: false, diagnostic: "model_pack_missing" },
        kind: "degradation-diagnostic",
        schemaVersion: AI_SUPPORT_EVIDENCE_SCHEMA,
      })}\n`,
    );

    const accepted = buildFullWorkflowEvidenceManifest({
      tracks: [
        { key: "aiVirtualTryOn", reportPath: report, artifactRoot: artifacts },
      ],
    });
    assert.equal(accepted.ok, true, JSON.stringify(accepted.failures));

    writeFileSync(
      join(artifacts, "diagnostic.json"),
      '{"facts":{},"kind":"degradation-diagnostic","schemaVersion":"unknown"}\n',
    );
    const rejected = buildFullWorkflowEvidenceManifest({
      tracks: [
        { key: "aiVirtualTryOn", reportPath: report, artifactRoot: artifacts },
      ],
    });
    assert.equal(rejected.ok, false);
    assert.ok(
      rejected.failures.some((failure) =>
        failure.includes("unsupported AI supporting JSON schema"),
      ),
    );
  });

  it("owns both case-scoped regional sidecars in the AI artifact tree", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    const short = join(artifacts, "regional", "short");
    const long = join(artifacts, "regional", "long");
    mkdirSync(short, { recursive: true });
    mkdirSync(long, { recursive: true });
    const report = join(temp, "ai-virtual-try-on.json");
    writeFileSync(report, '{"runtimeTrace":[{"id":"ai-trace"}]}\n');
    writeFileSync(join(artifacts, "runtime.log"), "ok\n");
    const support =
      '{"kind":"regional-evidence","schemaVersion":"vem-ai-regional-evidence/v1"}\n';
    writeFileSync(join(short, "short-attempt.regional-evidence.json"), support);
    writeFileSync(join(long, "long-attempt.regional-evidence.json"), support);

    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [
        { key: "aiVirtualTryOn", reportPath: report, artifactRoot: artifacts },
      ],
    });

    assert.equal(manifest.ok, true, JSON.stringify(manifest.failures));
    assert.equal(
      manifest.files.filter(
        (file) =>
          file.track === "aiVirtualTryOn" && file.kind === "supportingEvidence",
      ).length,
      2,
    );
  });

  it("rejects an artifact symlink that escapes its declared root", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "report.json");
    const outside = join(temp, "outside.json");
    writeFileSync(report, '{"runtimeTrace":[{"id":"trace-1"}]}\n');
    writeFileSync(outside, '{"private":"outside"}\n');
    writeFileSync(join(artifacts, "runtime.log"), "ok\n");
    symlinkSync(outside, join(artifacts, "diagnostic.json"));

    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [{ key: "sale", reportPath: report, artifactRoot: artifacts }],
    });

    assert.equal(manifest.ok, false);
    assert.ok(
      manifest.failures.some((failure) =>
        failure.includes("non-regular or linked evidence artifact"),
      ),
    );
  });

  it("budgets every screenshot before selecting at most three", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "report.json");
    writeFileSync(report, '{"runtimeTrace":[{"id":"trace-1"}]}\n');
    writeFileSync(join(artifacts, "runtime.log"), "ok\n");
    const screenshot = Buffer.alloc(EVIDENCE_LIMITS.screenshotPerFileBytes);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(screenshot);
    for (let index = 0; index < 4; index += 1)
      writeFileSync(join(artifacts, `capture-${index}.png`), screenshot);

    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [{ key: "sale", reportPath: report, artifactRoot: artifacts }],
    });

    assert.equal(manifest.tracks[0].screenshots.length, 3);
    assert.equal(manifest.totals.screenshots, 4);
    assert.equal(manifest.ok, false);
    assert.ok(
      manifest.failures.some((failure) => failure.includes("total size limit")),
    );
    const tampered = structuredClone(manifest);
    tampered.ok = true;
    tampered.failures = [];
    tampered.tracks[0].screenshots = tampered.files
      .filter((file) => file.kind === "screenshots")
      .map((file) => file.path);
    assert.ok(
      validateFullWorkflowEvidenceManifest(tampered).some((failure) =>
        failure.includes("too many selected screenshots"),
      ),
    );
  });

  it("rejects evidence bytes changed after manifest construction", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "report.json");
    const log = join(artifacts, "runtime.log");
    writeFileSync(report, '{"runtimeTrace":[{"id":"trace-1"}]}\n');
    writeFileSync(log, "original\n");
    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [{ key: "sale", reportPath: report, artifactRoot: artifacts }],
    });
    assert.deepEqual(validateFullWorkflowEvidenceOwnedFiles(manifest), []);

    writeFileSync(log, "tampered\n");

    assert.ok(
      validateFullWorkflowEvidenceOwnedFiles(manifest).some((failure) =>
        failure.includes("digest or size changed"),
      ),
    );
  });

  it("allows bundling only while the aggregate, manifest, and owned bytes remain valid", () => {
    const temp = root();
    const artifacts = join(temp, "artifacts");
    mkdirSync(artifacts);
    const report = join(temp, "report.json");
    const log = join(artifacts, "runtime.log");
    writeFileSync(report, '{"runtimeTrace":[{"id":"trace-1"}]}\n');
    writeFileSync(log, "original\n");
    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [{ key: "sale", reportPath: report, artifactRoot: artifacts }],
    });
    const manifestPath = join(temp, "full-workflow-evidence-manifest.json");
    const manifestRaw = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(manifestPath, manifestRaw);
    const summaryPath = join(temp, "full-workflow-tracks.json");
    const summary = {
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
    };
    writeFileSync(summaryPath, `${JSON.stringify(summary)}\n`);
    const run = () =>
      spawnSync(
        process.execPath,
        [
          new URL("./full-workflow-evidence-manifest.mjs", import.meta.url)
            .pathname,
          "--validate-upload",
          manifestPath,
          summaryPath,
        ],
        { encoding: "utf8" },
      );
    assert.equal(run().status, 0);

    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    const manifestTampered = run();
    assert.notEqual(manifestTampered.status, 0);
    assert.match(
      manifestTampered.stderr,
      /manifest changed after aggregate decision/,
    );
    writeFileSync(manifestPath, manifestRaw);

    writeFileSync(log, "tampered\n");
    const tampered = run();
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /digest or size changed/);

    writeFileSync(log, "original\n");
    summary.ok = false;
    writeFileSync(summaryPath, `${JSON.stringify(summary)}\n`);
    const failed = run();
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /diagnostic-only and not uploadable/);
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
          key: "scannerPayment",
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
    writeFileSync(
      report,
      `${JSON.stringify({ ok: false, error: { name: "Error", message: "Vision fixture unavailable", stack: "Error: Vision fixture unavailable" } })}\n`,
    );
    writeFileSync(join(artifacts, "diagnostic.json"), "{}\n");
    const manifest = buildFullWorkflowEvidenceManifest({
      tracks: [
        {
          key: "visionExperience",
          reportPath: report,
          artifactRoot: artifacts,
          result: { businessStatus: "failed" },
        },
      ],
    });
    assert.equal(manifest.ok, true, JSON.stringify(manifest.failures));
    assert.equal(
      manifest.tracks[0].primaryReason,
      "Error: Vision fixture unavailable",
    );
  });
});
