import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  AI_REGIONAL_EVIDENCE_POLICY,
  AI_REGIONAL_EVIDENCE_POLICY_SHA256,
  evaluateAiRegionalPixels,
  validateAiRegionalEvidence,
  validateAiRegionalEvidenceSet,
} from "./ai-regional-evidence.ts";

const roots = [];
const ATTEMPT_ID = "0198f44e-21bd-7c62-8f52-b7c86cc2b001";
const visionRoot = "/workspaces/vending-vision";
const regionalEvaluatorAuthorityRevision =
  "d9e7cd5275cd1c70fb2a9d216829ecf15dd539e1";
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-regional-evidence-"));
  roots.push(root);
  return root;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value != null && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

it("pins the regional evidence policy to the committed Vision evaluator descriptor", () => {
  const descriptor = execFileSync("git", [
    "-C",
    visionRoot,
    "show",
    `${regionalEvaluatorAuthorityRevision}:regional-evaluator-descriptor.json`,
  ]);
  const digest = createHash("sha256").update(descriptor).digest("hex");
  assert.equal(AI_REGIONAL_EVIDENCE_POLICY.sourceDescriptorSha256, digest);
});

function sidecarFixture() {
  return {
    attempt: {
      acquisitionSource: "direct_recorded_frame",
      decodedHeight: 32,
      decodedWidth: 40,
      garmentSha256: "6".repeat(64),
      inputSha256: "5".repeat(64),
      recordedFixtureSha256: "8".repeat(64),
      resultSha256: "7".repeat(64),
      sourceCamera: "front",
    },
    evaluator: {
      algorithm: AI_REGIONAL_EVIDENCE_POLICY.algorithm,
      atr: AI_REGIONAL_EVIDENCE_POLICY.atrEvaluator,
      lip: AI_REGIONAL_EVIDENCE_POLICY.lipEvaluator,
      pose: AI_REGIONAL_EVIDENCE_POLICY.poseEvaluator,
      sourceDescriptorSha256:
        AI_REGIONAL_EVIDENCE_POLICY.sourceDescriptorSha256,
    },
    kind: "regional-evidence",
    masks: {
      height: 32,
      protectedRegion: { encoding: "rle-row-major/v1", runs: [[1100, 100]] },
      upperBody: { encoding: "rle-row-major/v1", runs: [[0, 1024]] },
      width: 40,
    },
    measurements: {
      protectedRegion: {
        changedFractionBps: 0,
        changedPixels: 0,
        meanDelta: 0,
        sampledPixels: 100,
        verdict: "preserved",
      },
      upperBody: {
        changedFractionBps: 10_000,
        changedPixels: 1024,
        meanDelta: 64,
        sampledPixels: 1024,
        verdict: "changed",
      },
    },
    policy: {
      schemaVersion: AI_REGIONAL_EVIDENCE_POLICY.schemaVersion,
      sha256: AI_REGIONAL_EVIDENCE_POLICY_SHA256,
    },
    schemaVersion: "vem-ai-regional-evidence/v1",
    verdict: "passed",
  };
}

function reportFixture(root, mutate = () => undefined) {
  const sidecar = sidecarFixture();
  mutate(sidecar);
  const raw = `${JSON.stringify(canonical(sidecar))}\n`;
  const relativePath = `regional/short/${ATTEMPT_ID}.regional-evidence.json`;
  const path = join(root, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  return {
    attempt: {
      attemptId: ATTEMPT_ID,
      caseKey: "short",
      template: "tshirt_short_sleeve",
      garment: { sha256: "6".repeat(64) },
      input: { sha256: "5".repeat(64) },
      result: {
        decodedHeight: 32,
        decodedWidth: 40,
        sha256: "7".repeat(64),
      },
      regionalEvidence: {
        path: relativePath,
        schemaVersion: "vem-ai-regional-evidence-reference/v1",
        sha256,
        verdict: sidecar.verdict,
      },
    },
    sidecar,
    manifest: {
      files: [
        {
          track: "aiVirtualTryOn",
          kind: "supportingEvidence",
          path,
          byteLength: Buffer.byteLength(raw),
          sha256,
        },
      ],
    },
  };
}

describe("AI regional evidence", () => {
  it("recomputes test-owned RGB/RLE measurements and both region verdicts", () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      const inputRgb = Array(18).fill(0);
      const resultRgb = [...inputRgb];
      resultRgb.splice(0, 6, 30, 30, 30, 30, 30, 30);
      const result = evaluateAiRegionalPixels(
        {
          width: 3,
          height: 2,
          inputRgb,
          resultRgb,
          upperBody: { encoding: "rle-row-major/v1", runs: [[0, 2]] },
          protectedRegion: { encoding: "rle-row-major/v1", runs: [[2, 2]] },
        },
        {
          minimumUpperBodySampledPixels: 2,
          minimumUpperBodyChangedFractionBps: 10_000,
          minimumUpperBodyMeanDelta: 30,
          maximumProtectedChangedFractionBps: 0,
          maximumProtectedMeanDelta: 0,
        },
      );
      assert.deepEqual(result.upperBody, {
        sampledPixels: 2,
        changedPixels: 2,
        changedFractionBps: 10_000,
        meanDelta: 30,
        verdict: "changed",
      });
      assert.equal(result.protectedRegion.verdict, "preserved");
      assert.equal(result.verdict, "passed");
    } finally {
      if (prior == null) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  it("rejects overlap and contradictory test-owned thresholds", () => {
    const prior = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      assert.throws(
        () =>
          evaluateAiRegionalPixels(
            {
              width: 2,
              height: 2,
              inputRgb: Array(12).fill(0),
              resultRgb: Array(12).fill(1),
              upperBody: { encoding: "rle-row-major/v1", runs: [[0, 2]] },
              protectedRegion: {
                encoding: "rle-row-major/v1",
                runs: [[1, 2]],
              },
            },
            {},
          ),
        /overlap/,
      );
    } finally {
      if (prior == null) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prior;
    }
  });

  it("validates all stable facts but remains failclosed before Issue10 calibration", () => {
    const root = fixtureRoot();
    const { attempt, manifest } = reportFixture(root);
    const result = validateAiRegionalEvidence(attempt, root, manifest);
    assert.equal(result.ok, false);
    assert.match(result.reason, /awaits Issue10 two-garment calibration/);
  });

  it("requires the sidecar to be owned by the evidence manifest", () => {
    const root = fixtureRoot();
    const { attempt } = reportFixture(root);
    const result = validateAiRegionalEvidence(attempt, root, { files: [] });
    assert.equal(result.ok, false);
    assert.match(result.reason, /not manifest-owned/);
  });

  it("binds each sidecar path and dimensions to its report attempt", () => {
    const root = fixtureRoot();
    const { attempt, manifest } = reportFixture(root);
    attempt.regionalEvidence.path = `regional/long/${ATTEMPT_ID}.regional-evidence.json`;
    assert.match(
      validateAiRegionalEvidence(attempt, root, manifest).reason,
      /root or path is invalid/,
    );

    const fresh = reportFixture(root);
    fresh.attempt.result.decodedWidth += 1;
    assert.match(
      validateAiRegionalEvidence(fresh.attempt, root, fresh.manifest).reason,
      /identity or schema mismatched/,
    );
  });

  it("rejects manifest ownership attributed to another track", () => {
    const root = fixtureRoot();
    const { attempt, manifest } = reportFixture(root);
    manifest.files[0].track = "visionExperience";
    assert.match(
      validateAiRegionalEvidence(attempt, root, manifest).reason,
      /not manifest-owned/,
    );
  });

  it("rejects two case-scoped references to the same physical sidecar", () => {
    const root = fixtureRoot();
    const { attempt, manifest } = reportFixture(root);
    const longAttemptId = "0198f44e-21bd-7c62-8f52-b7c86cc2b002";
    const longRelative = `regional/long/${longAttemptId}.regional-evidence.json`;
    const source = manifest.files[0].path;
    const destination = join(root, longRelative);
    mkdirSync(dirname(destination), { recursive: true });
    linkSync(source, destination);
    const longAttempt = structuredClone(attempt);
    longAttempt.attemptId = longAttemptId;
    longAttempt.caseKey = "long";
    longAttempt.template = "tshirt_long_sleeve";
    longAttempt.regionalEvidence.path = longRelative;
    manifest.files.push({ ...manifest.files[0], path: destination });

    const result = validateAiRegionalEvidenceSet(
      [attempt, longAttempt],
      root,
      manifest,
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /physical member is reused/);
  });

  it("validates both physical sidecars before reporting calibration pending", () => {
    const root = fixtureRoot();
    const short = reportFixture(root);
    const longAttemptId = "0198f44e-21bd-7c62-8f52-b7c86cc2b003";
    const longRelative = `regional/long/${longAttemptId}.regional-evidence.json`;
    const longPath = join(root, longRelative);
    mkdirSync(dirname(longPath), { recursive: true });
    const longSidecar = sidecarFixture();
    longSidecar.attempt.garmentSha256 = "4".repeat(64);
    longSidecar.attempt.resultSha256 = "9".repeat(64);
    const longRaw = `${JSON.stringify(canonical(longSidecar))}\n`;
    writeFileSync(longPath, longRaw);
    const longAttempt = structuredClone(short.attempt);
    longAttempt.attemptId = longAttemptId;
    longAttempt.caseKey = "long";
    longAttempt.template = "tshirt_long_sleeve";
    longAttempt.garment.sha256 = longSidecar.attempt.garmentSha256;
    longAttempt.result.sha256 = longSidecar.attempt.resultSha256;
    longAttempt.regionalEvidence.path = longRelative;
    longAttempt.regionalEvidence.sha256 = createHash("sha256")
      .update(longRaw)
      .digest("hex");
    const manifest = {
      files: [
        ...short.manifest.files,
        {
          byteLength: Buffer.byteLength(longRaw),
          kind: "supportingEvidence",
          path: longPath,
          sha256: longAttempt.regionalEvidence.sha256,
          track: "aiVirtualTryOn",
        },
      ],
    };
    writeFileSync(longPath, `${longRaw.trimEnd()} `);
    const result = validateAiRegionalEvidenceSet(
      [short.attempt, longAttempt],
      root,
      manifest,
    );
    assert.equal(result.ok, false);
    assert.match(result.reason, /digest mismatched|not canonical/);
  });

  for (const [label, mutate, reason] of [
    ["unknown field", (value) => (value.unknown = true), /schema/],
    [
      "out-of-range measurement",
      (value) => (value.measurements.upperBody.changedFractionBps = 10_001),
      /measurement/,
    ],
    [
      "non-integer measurement",
      (value) => (value.measurements.upperBody.meanDelta = Number.NaN),
      /canonical|measurement/,
    ],
    [
      "attempt digest mismatch",
      (value) => (value.attempt.resultSha256 = "a".repeat(64)),
      /identity/,
    ],
    [
      "zero-length RLE",
      (value) => (value.masks.upperBody.runs = [[0, 0]]),
      /RLE/,
    ],
    [
      "overlapping regions",
      (value) => (value.masks.protectedRegion.runs = [[1000, 100]]),
      /overlap/,
    ],
    [
      "preview source",
      (value) => (value.attempt.acquisitionSource = "preview"),
      /identity/,
    ],
    [
      "policy drift",
      (value) => (value.policy.sha256 = "0".repeat(64)),
      /identity/,
    ],
    [
      "verdict contradiction",
      (value) => (value.measurements.protectedRegion.verdict = "changed"),
      /verdict/,
    ],
  ]) {
    it(`rejects ${label}`, () => {
      const root = fixtureRoot();
      const { attempt, manifest } = reportFixture(root, mutate);
      const result = validateAiRegionalEvidence(attempt, root, manifest);
      assert.equal(result.ok, false);
      assert.match(result.reason, reason);
    });
  }

  it("rejects digest mismatch and traversal", () => {
    const root = fixtureRoot();
    const { attempt, manifest } = reportFixture(root);
    attempt.regionalEvidence.sha256 = "0".repeat(64);
    assert.match(
      validateAiRegionalEvidence(attempt, root, manifest).reason,
      /digest mismatched/,
    );
    attempt.regionalEvidence.path = "../regional-evidence.json";
    assert.equal(validateAiRegionalEvidence(attempt, root, manifest).ok, false);
  });
});
