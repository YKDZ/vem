import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  createMeasurementEvidenceBundle,
  validateMeasurementEvidenceTransport,
} from "./measurement-evidence-bundle.mjs";
const pending =
  "AI regional evidence policy awaits Issue10 two-garment calibration";
const sha = (v) => createHash("sha256").update(v).digest("hex");
const write = (p, v) => {
  mkdirSync(join(p, ".."), { recursive: true });
  const raw = `${JSON.stringify(v, null, 2)}\n`;
  writeFileSync(p, raw);
  return { byteLength: Buffer.byteLength(raw), sha256: sha(raw) };
};
test("accepts only the production-shaped single pending aggregate", () => {
  const root = mkdtempSync("/tmp/vem-measurement-");
  try {
    const source = join(root, "source");
    const report = { ok: false, error: pending };
    const rp = join(root, "report.json"),
      mp = join(root, "measurement.json"),
      manifestp = join(root, "manifest.json"),
      ap = join(root, "aggregate.json");
    write(rp, report);
    for (const n of [
      "acceptance-authority-receipt.json",
      "acceptance-report.json",
      "calibration-source-input.json",
      "evidence-manifest.json",
      "recovery-support.json",
      "release-proof.json",
      "regional/short/a.json",
      "regional/long/b.json",
    ])
      write(join(source, n), {});
    const manifest = write(manifestp, { ok: true });
    const incomplete = "AI virtual try-on acceptance evidence is incomplete";
    const failures = [
      { set: "aiVirtualTryOn", reason: incomplete },
      { set: "evidenceInventory", reason: pending },
    ];
    write(ap, {
      ok: false,
      businessOutcome: {
        ok: false,
        failures,
      },
      execution: {
        executedTracks: [
          {
            key: "aiVirtualTryOn",
            businessStatus: "failed",
            error: incomplete,
          },
        ],
      },
      businessSets: {
        aiVirtualTryOn: { status: "failed", reason: incomplete },
      },
      failures,
      evidenceInventory: {
        ok: false,
        failures: [pending],
        manifestFile: manifest,
      },
    });
    write(mp, {
      schemaVersion: "vem-ai-regional-measurement/v1",
      status: "measured_not_accepted",
      acceptancePassed: false,
      calibrationRequired: true,
      calibrationSourceBundle: { members: Array(8) },
    });
    const bundle = join(root, "bundle");
    createMeasurementEvidenceBundle({
      measurementPath: mp,
      reportPath: rp,
      aggregatePath: ap,
      manifestPath: manifestp,
      sourceRoot: source,
      bundleRoot: bundle,
    });
    assert.doesNotThrow(() => validateMeasurementEvidenceTransport(bundle));
    const aggregate = JSON.parse(
      readFileSync(join(bundle, "metadata/full-workflow-tracks.json")),
    );
    aggregate.failures.push({ set: "sale", reason: "bad" });
    writeFileSync(
      join(bundle, "metadata/full-workflow-tracks.json"),
      `${JSON.stringify(aggregate, null, 2)}\n`,
    );
    assert.throws(() => validateMeasurementEvidenceTransport(bundle));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
