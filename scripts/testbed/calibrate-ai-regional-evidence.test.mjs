import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  AI_REGIONAL_EVIDENCE_POLICY,
  AI_REGIONAL_EVIDENCE_POLICY_SHA256,
  loadAiRegionalEvidencePolicy,
  validateAiRegionalEvidence,
} from "./ai-regional-evidence.mjs";
import {
  calibrateAiRegionalEvidence,
  readCalibrationSourceClosure,
  validateCalibratedAiRegionalReceipt,
} from "./calibrate-ai-regional-evidence.mjs";

const cli = join(
  dirname(fileURLToPath(import.meta.url)),
  "calibrate-ai-regional-evidence.mjs",
);
const contractBundleDigest = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../packages/shared/generated/vision-v2/manifest.json",
  ),
  "utf8",
);
const CONTRACT_BUNDLE_DIGEST = JSON.parse(contractBundleDigest).bundleDigest;
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

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

function writeCanonical(path, value, { compact = false } = {}) {
  const raw = compact
    ? `${JSON.stringify(canonical(value))}\n`
    : `${JSON.stringify(canonical(value), null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, raw);
  return createHash("sha256").update(raw).digest("hex");
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function rewriteInput(path, mutate) {
  const input = readJson(path);
  mutate(input);
  writeCanonical(path, input);
}

function rewriteBoundReport(input, mutate) {
  const report = readJson(input.acceptanceReport.path);
  mutate(report);
  input.acceptanceReport.sha256 = writeCanonical(
    input.acceptanceReport.path,
    report,
    { compact: true },
  );
}

function calibrationFixture() {
  const root = mkdtempSync(join(tmpdir(), "vem-ai-regional-calibration-"));
  roots.push(root);
  const artifactRoot = join(root, "artifacts");
  mkdirSync(artifactRoot);
  const attempts = ["short", "long"].map((caseKey, index) => {
    const attemptId = `0198f44e-21bd-7c62-8f52-b7c86cc2b00${index + 1}`;
    const sidecar = {
      attempt: {
        acquisitionSource: "direct_recorded_frame",
        decodedHeight: 32,
        decodedWidth: 40,
        garmentSha256: String(index + 3).repeat(64),
        inputSha256: String(index + 5).repeat(64),
        recordedFixtureSha256: String(index + 7).repeat(64),
        resultSha256: String(index + 9).repeat(64),
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
          changedFractionBps: index === 0 ? 7998 : 9003,
          changedPixels: index === 0 ? 819 : 922,
          meanDelta: index === 0 ? 40 : 50,
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
    const relative = `regional/${caseKey}/${attemptId}.regional-evidence.json`;
    const sidecarPath = join(artifactRoot, relative);
    const sidecarSha256 = writeCanonical(sidecarPath, sidecar, {
      compact: true,
    });
    const attempt = {
      attemptId,
      caseKey,
      garment: { sha256: sidecar.attempt.garmentSha256 },
      input: { sha256: sidecar.attempt.inputSha256 },
      regionalEvidence: {
        path: relative,
        schemaVersion: "vem-ai-regional-evidence-reference/v1",
        sha256: sidecarSha256,
        verdict: "passed",
      },
      result: {
        decodedHeight: 32,
        decodedWidth: 40,
        sha256: sidecar.attempt.resultSha256,
      },
      template:
        caseKey === "short" ? "tshirt_short_sleeve" : "tshirt_long_sleeve",
    };
    return {
      attempt,
      attemptSha256: digest(`${JSON.stringify(canonical(attempt), null, 2)}\n`),
      caseKey,
      sidecar,
    };
  });
  const manifest = {
    files: attempts.map(({ attempt }) => {
      const path = join(artifactRoot, attempt.regionalEvidence.path);
      const raw = readFileSync(path);
      return {
        byteLength: raw.byteLength,
        kind: "supportingEvidence",
        path,
        sha256: attempt.regionalEvidence.sha256,
        track: "aiVirtualTryOn",
      };
    }),
  };
  const manifestPath = join(root, "manifest.json");
  const manifestSha256 = writeCanonical(manifestPath, manifest);
  const releasePath = join(root, "precutover-ai-proof.json");
  const releaseSha256 = writeCanonical(
    releasePath,
    {
      candidate: {
        attestationBundleSha256: "d".repeat(64),
        embeddedManifestSha256: "f".repeat(64),
        sourceCommit: "b".repeat(40),
        subjectSha256: "4".repeat(64),
        trustedBuilderEvidenceSha256: "e".repeat(64),
        workerExecutableSha256: "5".repeat(64),
        workerMode: "frozen-windows",
      },
      companion: {
        archiveSha256: "f".repeat(64),
        descriptorSha256: "a".repeat(64),
        sourceCommit: "b".repeat(40),
      },
      modelPack: {
        archive: { byteSize: 1, sha256: "3".repeat(64) },
        descriptorSha256: "7".repeat(64),
        sourceRevision: "a".repeat(40),
      },
      probes: {},
      resources: {
        aiLockSha256: "8".repeat(64),
        runtimeDescriptorSha256: "1".repeat(64),
        sourceDescriptorSha256: "9".repeat(64),
      },
      schemaVersion: "vending-vision-precutover-proof/v2",
    },
    { compact: true },
  );
  const receipt = {
    identityRoot: {
      approvedPrecutoverSha256: `sha256:${"f".repeat(64)}`,
      releaseApprovalSha256: `sha256:${"a".repeat(64)}`,
      releaseSetSha256: `sha256:${"b".repeat(64)}`,
      runtimeArtifactsReceiptSha256: `sha256:${"c".repeat(64)}`,
    },
    schemaVersion: "vem.precutover.ai.v2",
    trustStatus: "pending_final_aggregate_approval",
    windowsProof: {
      authorityDescriptorSha256: `sha256:${"a".repeat(64)}`,
      candidate: {
        attestationBundleSha256: "d".repeat(64),
        trustedBuilderEvidenceSha256: "e".repeat(64),
      },
      companion: {
        archiveSha256: "f".repeat(64),
        descriptorSha256: "a".repeat(64),
        sourceCommit: "b".repeat(40),
      },
      proofAttestationBundleSha256: `sha256:${"b".repeat(64)}`,
      signedProofSha256: `sha256:${releaseSha256}`,
      trustedProofEvidenceSha256: `sha256:${"d".repeat(64)}`,
      workflowSha: "c".repeat(40),
    },
  };
  const receiptPath = join(root, "precutover.json");
  const receiptSha256 = writeCanonical(receiptPath, receipt, { compact: true });
  const reportPath = join(root, "acceptance-report.json");
  const reportSha256 = writeCanonical(
    reportPath,
    {
      attempts: attempts.map(({ attempt }) => attempt),
      execution: {
        identities: {
          aiRuntime: `sha256:${"1".repeat(64)}`,
          contract: `sha256:${CONTRACT_BUNDLE_DIGEST}`,
          modelPack: `sha256:${"3".repeat(64)}`,
          runtime: `sha256:${"4".repeat(64)}`,
        },
        noDirectWorker: true,
        protocol: "vem.vision.v2",
        recordedSources: ["front", "top"],
        source: "installed_machine_ui_cdp",
      },
      schemaVersion: "vem-ai-virtual-try-on-acceptance/v2",
    },
    { compact: true },
  );
  const recoveryPath = join(root, "recovery.json");
  const recoverySha256 = writeCanonical(
    recoveryPath,
    {
      facts: {
        recovery: {
          aiReadinessDiagnostic: "ready",
          aiReady: true,
          modelPackSha256: "3".repeat(64),
          runtimeDescriptorSha256: "1".repeat(64),
          sourceCommit: "b".repeat(40),
          workerExecutableSha256: "5".repeat(64),
        },
      },
      kind: "installed-runtime",
      schemaVersion: "vem.testbed.ai-virtual-try-on-support.v1",
    },
    { compact: true },
  );
  const inputPath = join(root, "input.json");
  writeCanonical(inputPath, {
    artifactRoot,
    acceptanceReport: { path: reportPath, sha256: reportSha256 },
    attempts: attempts.map(({ attempt, attemptSha256, caseKey }) => ({
      attempt,
      attemptSha256,
      caseKey,
    })),
    evidenceManifest: { path: manifestPath, sha256: manifestSha256 },
    precutoverReceipt: { path: receiptPath, sha256: receiptSha256 },
    recoverySupport: { path: recoveryPath, sha256: recoverySha256 },
    releaseProof: { path: releasePath, sha256: releaseSha256 },
    schemaVersion: "vem-ai-regional-evidence-calibration-input/v1",
  });
  return { artifactRoot, attempts, inputPath, root };
}

describe("AI regional evidence calibration", () => {
  it("provides the production calibration CLI", () => {
    assert.equal(existsSync(cli), true);
  });

  it("derives inclusive two-garment thresholds and writes canonical exclusive candidates", () => {
    const fixture = calibrationFixture();
    const policyPath = join(fixture.root, "candidate-policy.json");
    const receiptPath = join(fixture.root, "candidate-receipt.json");
    const result = calibrateAiRegionalEvidence(
      fixture.inputPath,
      policyPath,
      receiptPath,
    );
    assert.deepEqual(result.policy, {
      algorithm: "rgb-absolute-delta-rle/v1",
      atrEvaluator: "schp-atr",
      calibrationStatus: "calibrated_issue10",
      lipEvaluator: "schp-lip",
      maximumProtectedChangedFractionBps: 0,
      maximumProtectedMeanDelta: 0,
      minimumUpperBodyChangedFractionBps: 7998,
      minimumUpperBodyMeanDelta: 40,
      minimumUpperBodySampledPixels: 1024,
      poseEvaluator: "mediapipe-pose",
      schemaVersion: "vem-ai-regional-evidence-policy/v1",
      sourceDescriptorSha256:
        AI_REGIONAL_EVIDENCE_POLICY.sourceDescriptorSha256,
    });
    assert.equal(
      readFileSync(policyPath, "utf8"),
      `${JSON.stringify(canonical(result.policy), null, 2)}\n`,
    );
    assert.throws(
      () =>
        calibrateAiRegionalEvidence(fixture.inputPath, policyPath, receiptPath),
      /outputs already exist/,
    );
  });

  it("derives the same policy when the two canonical attempts are swapped", () => {
    const first = calibrationFixture();
    const second = calibrationFixture();
    rewriteInput(second.inputPath, (input) => {
      input.attempts.reverse();
      rewriteBoundReport(input, (report) => report.attempts.reverse());
    });
    const firstPolicy = join(first.root, "policy.json");
    const secondPolicy = join(second.root, "policy.json");
    calibrateAiRegionalEvidence(
      first.inputPath,
      firstPolicy,
      join(first.root, "receipt.json"),
    );
    calibrateAiRegionalEvidence(
      second.inputPath,
      secondPolicy,
      join(second.root, "receipt.json"),
    );
    assert.equal(
      readFileSync(firstPolicy, "utf8"),
      readFileSync(secondPolicy, "utf8"),
    );
  });

  it("re-adjudicates calibrated production evidence from sidecar measurements", () => {
    const fixture = calibrationFixture();
    const policyPath = join(fixture.root, "candidate-policy.json");
    const receiptPath = join(fixture.root, "candidate-receipt.json");
    calibrateAiRegionalEvidence(fixture.inputPath, policyPath, receiptPath);
    const policy = loadAiRegionalEvidencePolicy(policyPath);
    const entry = fixture.attempts[0];
    const path = join(
      fixture.artifactRoot,
      entry.attempt.regionalEvidence.path,
    );
    entry.sidecar.policy.sha256 = policy.sha256;
    entry.sidecar.measurements.upperBody.verdict = "insufficient_change";
    entry.sidecar.verdict = "regional_check_failed";
    entry.attempt.regionalEvidence.verdict = "regional_check_failed";
    entry.attempt.regionalEvidence.sha256 = writeCanonical(
      path,
      entry.sidecar,
      { compact: true },
    );
    const manifest = {
      files: [
        {
          byteLength: readFileSync(path).byteLength,
          kind: "supportingEvidence",
          path,
          sha256: entry.attempt.regionalEvidence.sha256,
          track: "aiVirtualTryOn",
        },
      ],
    };
    assert.equal(
      validateAiRegionalEvidence(
        entry.attempt,
        fixture.artifactRoot,
        manifest,
        policy,
      ).ok,
      true,
    );
  });

  it("rejects a refreshed calibrated receipt whose attempt binding no longer matches", () => {
    const fixture = calibrationFixture();
    const policyPath = join(fixture.root, "candidate-policy.json");
    const receiptPath = join(fixture.root, "candidate-receipt.json");
    calibrateAiRegionalEvidence(fixture.inputPath, policyPath, receiptPath);
    const input = readJson(fixture.inputPath);
    const report = readJson(input.acceptanceReport.path);
    const identities = Object.fromEntries(
      Object.entries(report.execution.identities).map(([key, value]) => [
        key,
        value.replace("sha256:", ""),
      ]),
    );
    const attempts = input.attempts.map((entry) => entry.attempt);
    const policy = loadAiRegionalEvidencePolicy(policyPath);
    assert.doesNotThrow(() =>
      validateCalibratedAiRegionalReceipt({
        closure: readCalibrationSourceClosure(fixture.inputPath),
        attempts,
        identities,
        policy,
        receiptPath,
      }),
    );
    const receipt = readJson(receiptPath);
    receipt.attempts[0].resultSha256 = "0".repeat(64);
    writeCanonical(receiptPath, receipt);
    assert.throws(
      () =>
        validateCalibratedAiRegionalReceipt({
          closure: readCalibrationSourceClosure(fixture.inputPath),
          attempts,
          identities,
          policy,
          receiptPath,
        }),
      /attempt binding mismatched/,
    );
  });

  it("rejects noncanonical, duplicate, proof, manifest, and attempt-digest contradictions", () => {
    const cases = [
      [
        "noncanonical input",
        (fixture) =>
          writeFileSync(
            fixture.inputPath,
            `${readFileSync(fixture.inputPath, "utf8")} `,
          ),
        /not canonical/,
      ],
      [
        "duplicate garment case",
        (fixture) =>
          rewriteInput(fixture.inputPath, (input) => {
            input.attempts[1] = structuredClone(input.attempts[0]);
          }),
        /exactly one short and one long/,
      ],
      [
        "precutover digest",
        (fixture) =>
          rewriteInput(fixture.inputPath, (input) => {
            input.precutoverReceipt.sha256 = "0".repeat(64);
          }),
        /precutover receipt digest mismatched/,
      ],
      [
        "manifest ownership",
        (fixture) => {
          const input = readJson(fixture.inputPath);
          const manifest = readJson(input.evidenceManifest.path);
          manifest.files = [];
          input.evidenceManifest.sha256 = writeCanonical(
            input.evidenceManifest.path,
            manifest,
          );
          writeCanonical(fixture.inputPath, input);
        },
        /not manifest-owned/,
      ],
      [
        "attempt digest",
        (fixture) =>
          rewriteInput(fixture.inputPath, (input) => {
            input.attempts[0].attemptSha256 = "0".repeat(64);
          }),
        /attempt digest mismatched/,
      ],
    ];
    for (const [label, mutate, expected] of cases) {
      const fixture = calibrationFixture();
      mutate(fixture);
      assert.throws(
        () =>
          calibrateAiRegionalEvidence(
            fixture.inputPath,
            join(fixture.root, `${label}.policy.json`),
            join(fixture.root, `${label}.receipt.json`),
          ),
        expected,
      );
    }
  });

  it("rejects a forged release proof even when its caller reference digest is refreshed", () => {
    const fixture = calibrationFixture();
    const input = readJson(fixture.inputPath);
    const proof = readJson(input.releaseProof.path);
    proof.resources.runtimeDescriptorSha256 = "0".repeat(64);
    input.releaseProof.sha256 = writeCanonical(input.releaseProof.path, proof, {
      compact: true,
    });
    writeCanonical(fixture.inputPath, input);
    assert.throws(
      () =>
        calibrateAiRegionalEvidence(
          fixture.inputPath,
          join(fixture.root, "policy.json"),
          join(fixture.root, "receipt.json"),
        ),
      /release proof digest does not bind trusted precutover receipt/,
    );
  });

  it("rejects a forged acceptance release identity even when its caller digest is refreshed", () => {
    const fixture = calibrationFixture();
    const input = readJson(fixture.inputPath);
    rewriteBoundReport(input, (report) => {
      report.execution.identities.runtime = `sha256:${"0".repeat(64)}`;
    });
    writeCanonical(fixture.inputPath, input);
    assert.throws(
      () =>
        calibrateAiRegionalEvidence(
          fixture.inputPath,
          join(fixture.root, "policy.json"),
          join(fixture.root, "receipt.json"),
        ),
      /acceptance report release identities mismatched/,
    );
  });

  it("rejects a forged recovery worker identity even when its caller digest is refreshed", () => {
    const fixture = calibrationFixture();
    const input = readJson(fixture.inputPath);
    const recovery = readJson(input.recoverySupport.path);
    recovery.facts.recovery.workerExecutableSha256 = "0".repeat(64);
    input.recoverySupport.sha256 = writeCanonical(
      input.recoverySupport.path,
      recovery,
      { compact: true },
    );
    writeCanonical(fixture.inputPath, input);
    assert.throws(
      () =>
        calibrateAiRegionalEvidence(
          fixture.inputPath,
          join(fixture.root, "policy.json"),
          join(fixture.root, "receipt.json"),
        ),
      /recovery support does not bind release proof/,
    );
  });

  it("rejects threshold calibration when protected facts are not actually preserved", () => {
    const fixture = calibrationFixture();
    const entry = fixture.attempts[0];
    const path = join(
      fixture.artifactRoot,
      entry.attempt.regionalEvidence.path,
    );
    entry.sidecar.measurements.protectedRegion.changedPixels = 1;
    entry.sidecar.measurements.protectedRegion.changedFractionBps = 100;
    entry.attempt.regionalEvidence.sha256 = writeCanonical(
      path,
      entry.sidecar,
      { compact: true },
    );
    entry.attemptSha256 = digest(
      `${JSON.stringify(canonical(entry.attempt), null, 2)}\n`,
    );
    const input = readJson(fixture.inputPath);
    input.attempts[0] = {
      attempt: entry.attempt,
      attemptSha256: entry.attemptSha256,
      caseKey: entry.caseKey,
    };
    const manifest = readJson(input.evidenceManifest.path);
    const file = manifest.files.find((candidate) => candidate.path === path);
    file.sha256 = entry.attempt.regionalEvidence.sha256;
    file.byteLength = readFileSync(path).byteLength;
    input.evidenceManifest.sha256 = writeCanonical(
      input.evidenceManifest.path,
      manifest,
    );
    rewriteBoundReport(input, (report) => {
      report.attempts[0] = entry.attempt;
    });
    writeCanonical(fixture.inputPath, input);
    assert.throws(
      () =>
        calibrateAiRegionalEvidence(
          fixture.inputPath,
          join(fixture.root, "policy.json"),
          join(fixture.root, "receipt.json"),
        ),
      /does not satisfy measured regional facts/,
    );
  });
});
