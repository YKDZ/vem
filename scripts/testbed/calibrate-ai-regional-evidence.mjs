#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AI_REGIONAL_EVIDENCE_POLICY,
  validateAiRegionalEvidenceSet,
} from "./ai-regional-evidence.mjs";

const DIGEST = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const INPUT_SCHEMA = "vem-ai-regional-evidence-calibration-input/v1";
const RELEASE_SCHEMA = "vem-ai-regional-evidence-calibration-release/v1";
const RECEIPT_SCHEMA = "vem-ai-regional-evidence-calibration-receipt/v1";

function exact(value, keys) {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
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

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(canonical(value), null, 2)}\n`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  throw new Error(message);
}

function readCanonical(path, label, { pretty = true } = {}) {
  if (typeof path !== "string" || !isAbsolute(path))
    fail(`${label} path must be absolute`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) fail(`${label} must be regular`);
  const raw = readFileSync(path);
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    fail(`${label} is invalid JSON`);
  }
  const expected = pretty
    ? canonicalBytes(value)
    : Buffer.from(`${JSON.stringify(canonical(value))}\n`);
  if (!raw.equals(expected)) fail(`${label} is not canonical JSON`);
  return { path: realpathSync(path), raw, value };
}

function requireDigest(value, label) {
  if (!DIGEST.test(value ?? "")) fail(`${label} digest is invalid`);
  return value;
}

function readBoundCanonical(reference, label) {
  if (!exact(reference, ["path", "sha256"]))
    fail(`${label} reference is invalid`);
  const parsed = readCanonical(reference.path, label);
  if (sha256(parsed.raw) !== requireDigest(reference.sha256, label))
    fail(`${label} digest mismatched`);
  return parsed;
}

function parseArguments(argv) {
  const value = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--input", "--out-policy", "--out-receipt"].includes(key))
      fail(
        "usage: calibrate-ai-regional-evidence.mjs --input <path> --out-policy <path> --out-receipt <path>",
      );
    if (value[key] !== undefined || index + 1 >= argv.length)
      fail("calibration CLI arguments are invalid");
    value[key] = argv[(index += 1)];
  }
  if (Object.keys(value).length !== 3)
    fail(
      "usage: calibrate-ai-regional-evidence.mjs --input <path> --out-policy <path> --out-receipt <path>",
    );
  return value;
}

function writeExclusiveCanonical(path, value, label) {
  if (typeof path !== "string" || !isAbsolute(path))
    fail(`${label} output path must be absolute`);
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (parentStat.isSymbolicLink() || !parentStat.isDirectory())
    fail(`${label} output parent is unsafe`);
  writeFileSync(path, canonicalBytes(value), { flag: "wx", mode: 0o600 });
}

function parseReleaseProof(value, receiptSha256) {
  if (
    !exact(value, [
      "aiRuntimeSha256",
      "contractBundleSha256",
      "modelPackSha256",
      "precutoverReceiptSha256",
      "runtimeSha256",
      "schemaVersion",
      "workerExecutableSha256",
    ]) ||
    value.schemaVersion !== RELEASE_SCHEMA ||
    value.precutoverReceiptSha256 !== receiptSha256
  )
    fail(
      "calibration release proof is invalid or not bound to precutover receipt",
    );
  for (const [key, digest] of Object.entries(value))
    if (key.endsWith("Sha256"))
      requireDigest(digest, `calibration release ${key}`);
  return value;
}

function parsePrecutoverReceipt(value) {
  if (
    !exact(value, [
      "identityRoot",
      "schemaVersion",
      "trustStatus",
      "windowsProof",
    ]) ||
    value.schemaVersion !== "vem.precutover.ai.v2" ||
    value.trustStatus !== "pending_final_aggregate_approval"
  )
    fail("trusted precutover receipt is invalid");
  if (
    !exact(value.identityRoot, [
      "approvedPrecutoverSha256",
      "releaseApprovalSha256",
      "releaseSetSha256",
      "runtimeArtifactsReceiptSha256",
    ])
  )
    fail("trusted precutover receipt root identity is invalid");
  for (const [key, digest] of Object.entries(value.identityRoot))
    requireDigest(digest, `trusted precutover ${key}`);
  if (
    !exact(value.windowsProof, [
      "authorityDescriptorSha256",
      "candidate",
      "companion",
      "proofAttestationBundleSha256",
      "signedProofSha256",
      "trustedProofEvidenceSha256",
      "workflowSha",
    ])
  )
    fail("trusted precutover receipt proof identity is invalid");
  if (
    !exact(value.windowsProof.candidate, [
      "attestationBundleSha256",
      "trustedBuilderEvidenceSha256",
    ]) ||
    !exact(value.windowsProof.companion, [
      "archiveSha256",
      "descriptorSha256",
      "sourceCommit",
    ]) ||
    !COMMIT.test(value.windowsProof.workflowSha) ||
    !COMMIT.test(value.windowsProof.companion.sourceCommit)
  )
    fail("trusted precutover receipt nested proof identity is invalid");
  for (const [key, digest] of Object.entries(value.windowsProof))
    if (key.endsWith("Sha256"))
      requireDigest(digest, `trusted precutover ${key}`);
  for (const [key, digest] of Object.entries(value.windowsProof.candidate))
    requireDigest(digest, `trusted precutover candidate ${key}`);
  for (const [key, digest] of Object.entries(value.windowsProof.companion))
    if (key.endsWith("Sha256"))
      requireDigest(digest, `trusted precutover companion ${key}`);
  return value;
}

function readSidecar(artifactRoot, attempt) {
  const relative = attempt.regionalEvidence.path;
  return readCanonical(
    resolve(artifactRoot, relative),
    "regional calibration sidecar",
    {
      pretty: false,
    },
  ).value;
}

function deriveThresholds(sidecars) {
  const upper = sidecars.map((sidecar) => sidecar.measurements.upperBody);
  const protectedRegion = sidecars.map(
    (sidecar) => sidecar.measurements.protectedRegion,
  );
  for (const [index, sidecar] of sidecars.entries()) {
    const upperMeasurement = sidecar.measurements.upperBody;
    const protectedMeasurement = sidecar.measurements.protectedRegion;
    if (
      upperMeasurement.sampledPixels < 1024 ||
      protectedMeasurement.sampledPixels <= 0 ||
      upperMeasurement.changedPixels <= 0 ||
      protectedMeasurement.changedPixels !== 0 ||
      upperMeasurement.verdict !== "changed" ||
      protectedMeasurement.verdict !== "preserved" ||
      sidecar.verdict !== "passed"
    )
      fail(
        `calibration attempt ${index + 1} does not satisfy measured regional facts`,
      );
  }
  return {
    maximumProtectedChangedFractionBps: Math.max(
      ...protectedRegion.map((value) => value.changedFractionBps),
    ),
    maximumProtectedMeanDelta: Math.max(
      ...protectedRegion.map((value) => value.meanDelta),
    ),
    minimumUpperBodyChangedFractionBps: Math.min(
      ...upper.map((value) => value.changedFractionBps),
    ),
    minimumUpperBodyMeanDelta: Math.min(
      ...upper.map((value) => value.meanDelta),
    ),
  };
}

export function calibrateAiRegionalEvidence(
  inputPath,
  outputPolicyPath,
  outputReceiptPath,
) {
  const inputFile = readCanonical(inputPath, "calibration input");
  const input = inputFile.value;
  if (
    !exact(input, [
      "artifactRoot",
      "attempts",
      "evidenceManifest",
      "precutoverReceipt",
      "releaseProof",
      "schemaVersion",
    ]) ||
    input.schemaVersion !== INPUT_SCHEMA ||
    typeof input.artifactRoot !== "string" ||
    !isAbsolute(input.artifactRoot) ||
    !Array.isArray(input.attempts) ||
    input.attempts.length !== 2
  )
    fail("calibration input is invalid");
  const artifactRootStat = lstatSync(input.artifactRoot);
  if (artifactRootStat.isSymbolicLink() || !artifactRootStat.isDirectory())
    fail("calibration artifact root is invalid");
  const artifactRoot = realpathSync(input.artifactRoot);
  const manifest = readBoundCanonical(
    input.evidenceManifest,
    "calibration evidence manifest",
  );
  const receipt = readBoundCanonical(
    input.precutoverReceipt,
    "trusted precutover receipt",
  );
  parsePrecutoverReceipt(receipt.value);
  const releaseProof = readBoundCanonical(
    input.releaseProof,
    "calibration release proof",
  );
  const release = parseReleaseProof(releaseProof.value, sha256(receipt.raw));
  const attempts = input.attempts.map((entry) => {
    if (!exact(entry, ["attempt", "attemptSha256", "caseKey"]))
      fail("calibration attempt reference is invalid");
    if (!["short", "long"].includes(entry.caseKey))
      fail("calibration garment case is invalid");
    if (
      sha256(canonicalBytes(entry.attempt)) !==
      requireDigest(entry.attemptSha256, "calibration attempt")
    )
      fail("calibration attempt digest mismatched");
    if (
      entry.attempt?.caseKey !== entry.caseKey ||
      entry.attempt?.template !==
        (entry.caseKey === "short"
          ? "tshirt_short_sleeve"
          : "tshirt_long_sleeve")
    )
      fail("calibration attempt garment identity is invalid");
    return entry;
  });
  if (new Set(attempts.map((entry) => entry.caseKey)).size !== 2)
    fail("calibration requires exactly one short and one long garment attempt");
  for (const [label, values] of [
    ["attempt", attempts.map((entry) => entry.attempt?.attemptId)],
    ["garment", attempts.map((entry) => entry.attempt?.garment?.sha256)],
    ["result", attempts.map((entry) => entry.attempt?.result?.sha256)],
    [
      "regional sidecar",
      attempts.map((entry) => entry.attempt?.regionalEvidence?.sha256),
    ],
  ])
    if (
      values.some((value) => typeof value !== "string" || value === "") ||
      new Set(values).size !== 2
    )
      fail(`calibration ${label} identity is not independent`);
  const ordered = [...attempts].sort((left, right) =>
    left.caseKey.localeCompare(right.caseKey),
  );
  const validation = validateAiRegionalEvidenceSet(
    ordered.map((entry) => entry.attempt),
    artifactRoot,
    manifest.value,
  );
  if (
    validation.reason !==
    "AI regional evidence policy awaits Issue10 two-garment calibration"
  )
    fail(validation.reason ?? "calibration evidence unexpectedly passed");
  const sidecars = ordered.map((entry) =>
    readSidecar(artifactRoot, entry.attempt),
  );
  const thresholds = deriveThresholds(sidecars);
  const policy = {
    algorithm: AI_REGIONAL_EVIDENCE_POLICY.algorithm,
    atrEvaluator: AI_REGIONAL_EVIDENCE_POLICY.atrEvaluator,
    calibrationStatus: "calibrated_issue10",
    lipEvaluator: AI_REGIONAL_EVIDENCE_POLICY.lipEvaluator,
    minimumUpperBodySampledPixels: 1024,
    poseEvaluator: AI_REGIONAL_EVIDENCE_POLICY.poseEvaluator,
    schemaVersion: AI_REGIONAL_EVIDENCE_POLICY.schemaVersion,
    sourceDescriptorSha256: AI_REGIONAL_EVIDENCE_POLICY.sourceDescriptorSha256,
    ...thresholds,
  };
  const policyBytes = canonicalBytes(policy);
  const receiptValue = {
    attempts: ordered.map((entry, index) => ({
      attemptSha256: entry.attemptSha256,
      caseKey: entry.caseKey,
      garmentSha256: sidecars[index].attempt.garmentSha256,
      inputSha256: sidecars[index].attempt.inputSha256,
      recordedFixtureSha256: sidecars[index].attempt.recordedFixtureSha256,
      resultSha256: sidecars[index].attempt.resultSha256,
      sidecarSha256: entry.attempt.regionalEvidence.sha256,
    })),
    calibrationInputSha256: sha256(inputFile.raw),
    derivedThresholds: thresholds,
    policySha256: sha256(policyBytes),
    precutoverReceiptSha256: sha256(receipt.raw),
    release,
    releaseProofSha256: sha256(releaseProof.raw),
    schemaVersion: RECEIPT_SCHEMA,
  };
  if (resolve(outputPolicyPath) === resolve(outputReceiptPath))
    fail("calibration outputs must be distinct");
  if (existsSync(outputPolicyPath) || existsSync(outputReceiptPath))
    fail("calibration outputs already exist");
  writeExclusiveCanonical(outputPolicyPath, policy, "calibrated policy");
  writeExclusiveCanonical(
    outputReceiptPath,
    receiptValue,
    "calibration receipt",
  );
  return { policy, receipt: receiptValue };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    calibrateAiRegionalEvidence(
      options["--input"],
      options["--out-policy"],
      options["--out-receipt"],
    );
  } catch (error) {
    process.stderr.write(
      `AI regional evidence calibration failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
