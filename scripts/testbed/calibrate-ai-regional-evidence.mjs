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
  normalizeAiRegionalSha256,
  validateAiRegionalEvidenceSet,
} from "./ai-regional-evidence.mjs";

const DIGEST = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const INPUT_SCHEMA = "vem-ai-regional-evidence-calibration-input/v2";
const RECEIPT_SCHEMA = "vem-ai-regional-evidence-calibration-receipt/v2";
const CONTRACT_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../packages/shared/generated/vision-v2/manifest.json",
);

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

function readBoundCanonical(reference, label, options = undefined) {
  if (!exact(reference, ["path", "sha256"]))
    fail(`${label} reference is invalid`);
  const parsed = readCanonical(reference.path, label, options);
  if (sha256(parsed.raw) !== requireDigest(reference.sha256, label))
    fail(`${label} digest mismatched`);
  return parsed;
}

export function readCalibrationSourceClosure(inputPath) {
  const inputFile = readCanonical(inputPath, "calibration source input");
  const input = inputFile.value;
  if (
    !exact(input, [
      "artifactRoot",
      "acceptanceReport",
      "attempts",
      "evidenceManifest",
      "acceptanceAuthorityReceipt",
      "recoverySupport",
      "releaseProof",
      "schemaVersion",
    ]) ||
    input.schemaVersion !== INPUT_SCHEMA ||
    !Array.isArray(input.attempts) ||
    input.attempts.length !== 2
  )
    fail("calibration source input is invalid");
  const acceptanceReport = readBoundCanonical(
    input.acceptanceReport,
    "calibration source acceptance report",
    { pretty: false },
  );
  const acceptanceAuthorityReceipt = readBoundCanonical(
    input.acceptanceAuthorityReceipt,
    "calibration source acceptance authority receipt",
    { pretty: false },
  );
  const releaseProof = readBoundCanonical(
    input.releaseProof,
    "calibration source release proof",
    { pretty: false },
  );
  const recoverySupport = readBoundCanonical(
    input.recoverySupport,
    "calibration source recovery support",
    { pretty: false },
  );
  const evidenceManifest = readBoundCanonical(
    input.evidenceManifest,
    "calibration source evidence manifest",
  );
  return {
    acceptanceReport,
    attempts: input.attempts.map((entry) => entry.attempt),
    input: inputFile,
    acceptanceAuthorityReceipt,
    recoverySupport,
    releaseProof,
    evidenceManifest,
  };
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

function parseReleaseProof(value, receipt) {
  if (
    !exact(value, [
      "candidate",
      "companion",
      "modelPack",
      "probes",
      "resources",
      "schemaVersion",
    ]) ||
    value.schemaVersion !== "vending-vision-precutover-proof/v2" ||
    !exact(value.candidate, [
      "attestationBundleSha256",
      "embeddedManifestSha256",
      "sourceCommit",
      "subjectSha256",
      "trustedBuilderEvidenceSha256",
      "workerExecutableSha256",
      "workerMode",
    ]) ||
    !exact(value.companion, [
      "archiveSha256",
      "descriptorSha256",
      "sourceCommit",
    ]) ||
    !exact(value.modelPack, [
      "archive",
      "descriptorSha256",
      "sourceRevision",
    ]) ||
    !exact(value.modelPack.archive, ["byteSize", "sha256"]) ||
    !exact(value.resources, [
      "aiLockSha256",
      "runtimeDescriptorSha256",
      "sourceDescriptorSha256",
    ]) ||
    value.candidate.workerMode !== "frozen-windows" ||
    !COMMIT.test(value.candidate.sourceCommit) ||
    !COMMIT.test(value.companion.sourceCommit) ||
    !COMMIT.test(value.modelPack.sourceRevision) ||
    !Number.isSafeInteger(value.modelPack.archive.byteSize) ||
    value.modelPack.archive.byteSize <= 0
  )
    fail("calibration release proof is invalid");
  for (const group of [
    value.candidate,
    value.companion,
    value.modelPack,
    value.modelPack.archive,
    value.resources,
  ])
    for (const [key, digest] of Object.entries(group))
      if (key.endsWith("Sha256"))
        requireDigest(digest, `calibration release ${key}`);
  const authority = receipt;
  if (
    value.candidate.attestationBundleSha256 !==
      normalizeAiRegionalSha256(
        authority.candidate.attestationBundleSha256,
        "calibration authority candidate attestation",
      ) ||
    value.candidate.trustedBuilderEvidenceSha256 !==
      normalizeAiRegionalSha256(
        authority.candidate.trustedBuilderEvidenceSha256,
        "calibration authority candidate evidence",
      ) ||
    value.candidate.embeddedManifestSha256 !==
      authority.candidate.embeddedManifestSha256 ||
    value.candidate.subjectSha256 !== authority.candidate.subjectSha256 ||
    value.candidate.sourceCommit !== authority.candidate.sourceCommit ||
    value.candidate.workerExecutableSha256 !==
      authority.resources.workerExecutableSha256 ||
    value.companion.archiveSha256 !==
      normalizeAiRegionalSha256(
        authority.companion.archiveSha256,
        "calibration authority companion archive",
      ) ||
    value.companion.descriptorSha256 !==
      normalizeAiRegionalSha256(
        authority.companion.descriptorSha256,
        "calibration authority companion descriptor",
      ) ||
    value.companion.sourceCommit !== authority.companion.sourceCommit ||
    value.modelPack.archive.sha256 !== authority.modelPack.archive.sha256 ||
    value.modelPack.archive.byteSize !== authority.modelPack.archive.byteSize ||
    value.modelPack.descriptorSha256 !== authority.modelPack.descriptorSha256 ||
    value.modelPack.sourceRevision !== authority.modelPack.sourceRevision ||
    value.resources.aiLockSha256 !== authority.resources.aiLockSha256 ||
    value.resources.runtimeDescriptorSha256 !==
      authority.resources.runtimeDescriptorSha256 ||
    value.resources.sourceDescriptorSha256 !==
      authority.resources.sourceDescriptorSha256
  )
    fail(
      "calibration release proof does not bind acceptance authority receipt",
    );
  return value;
}

function parseAcceptanceAuthorityReceipt(value) {
  if (
    !exact(value, [
      "candidate",
      "companion",
      "contract",
      "modelPack",
      "resources",
      "schemaVersion",
      "scope",
      "trustStatus",
      "windowsProof",
    ]) ||
    value.schemaVersion !== "vem.testbed.ai-acceptance-authority/v1" ||
    value.scope !== "installed_windows_acceptance" ||
    value.trustStatus !== "verified_for_acceptance"
  )
    fail("calibration acceptance authority receipt is invalid");
  if (
    !exact(value.candidate, [
      "attestationBundleSha256",
      "embeddedManifestSha256",
      "sourceCommit",
      "subjectSha256",
      "trustedBuilderEvidenceSha256",
    ]) ||
    !exact(value.companion, [
      "archiveSha256",
      "descriptorSha256",
      "sourceCommit",
    ]) ||
    !exact(value.modelPack, [
      "archive",
      "descriptorSha256",
      "sourceRevision",
    ]) ||
    !exact(value.modelPack.archive, ["byteSize", "sha256"]) ||
    !exact(value.resources, [
      "aiLockSha256",
      "runtimeDescriptorSha256",
      "sourceDescriptorSha256",
      "workerExecutableSha256",
    ]) ||
    !exact(value.contract, ["bundleDigest", "manifestSha256", "protocol"]) ||
    value.contract.protocol !== "vem.vision.v2" ||
    !exact(value.windowsProof, [
      "authorityDescriptorSha256",
      "proofAttestationBundleSha256",
      "signedProofSha256",
      "trustedProofEvidenceSha256",
      "workflowSha",
    ]) ||
    !COMMIT.test(value.candidate.sourceCommit) ||
    !COMMIT.test(value.companion.sourceCommit) ||
    !COMMIT.test(value.modelPack.sourceRevision) ||
    !COMMIT.test(value.windowsProof.workflowSha) ||
    !Number.isSafeInteger(value.modelPack.archive.byteSize) ||
    value.modelPack.archive.byteSize <= 0
  )
    fail("calibration acceptance authority receipt identity is invalid");
  for (const group of [
    value.candidate,
    value.companion,
    value.modelPack,
    value.modelPack.archive,
    value.resources,
    value.contract,
    value.windowsProof,
  ])
    for (const [key, digest] of Object.entries(group))
      if (key.endsWith("Sha256") || key === "bundleDigest")
        normalizeAiRegionalSha256(digest, `calibration authority ${key}`, {
          prefixed: key.endsWith("Sha256") && group === value.windowsProof,
        });
  return value;
}

function parseAcceptanceReport(value, proof, attempts) {
  const identities = value?.execution?.identities;
  if (
    value?.schemaVersion !== "vem-ai-virtual-try-on-acceptance/v2" ||
    !exact(value.execution, [
      "identities",
      "noDirectWorker",
      "protocol",
      "recordedSources",
      "source",
    ]) ||
    !exact(identities, ["aiRuntime", "contract", "modelPack", "runtime"]) ||
    value.execution.noDirectWorker !== true ||
    value.execution.protocol !== "vem.vision.v2" ||
    !Array.isArray(value.attempts) ||
    !canonicalBytes(value.attempts).equals(canonicalBytes(attempts))
  )
    fail("calibration acceptance report is invalid or does not bind attempts");
  const release = Object.fromEntries(
    Object.entries(identities).map(([key, digest]) => [
      key,
      normalizeAiRegionalSha256(digest, `calibration report ${key}`, {
        prefixed: true,
      }),
    ]),
  );
  if (
    release.aiRuntime !== proof.resources.runtimeDescriptorSha256 ||
    release.modelPack !== proof.modelPack.archive.sha256 ||
    release.runtime !== proof.candidate.subjectSha256 ||
    release.contract !==
      readCanonical(CONTRACT_PATH, "generated Vision V2 contract", {
        pretty: false,
      }).value.bundleDigest
  )
    fail("calibration acceptance report release identities mismatched");
  return release;
}

function parseRecoverySupport(value, proof) {
  const recovery = value?.facts?.recovery;
  if (
    !exact(value, ["facts", "kind", "schemaVersion"]) ||
    value.schemaVersion !== "vem.testbed.ai-virtual-try-on-support.v1" ||
    value.kind !== "installed-runtime" ||
    !exact(value.facts, ["recovery"]) ||
    !exact(recovery, [
      "aiReadinessDiagnostic",
      "aiReady",
      "modelPackSha256",
      "runtimeDescriptorSha256",
      "sourceCommit",
      "workerExecutableSha256",
    ]) ||
    recovery.aiReady !== true ||
    recovery.aiReadinessDiagnostic !== "ready" ||
    recovery.modelPackSha256 !== proof.modelPack.archive.sha256 ||
    recovery.runtimeDescriptorSha256 !==
      proof.resources.runtimeDescriptorSha256 ||
    recovery.workerExecutableSha256 !==
      proof.candidate.workerExecutableSha256 ||
    recovery.sourceCommit !== proof.candidate.sourceCommit
  )
    fail("calibration recovery support does not bind release proof");
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

export function adjudicateCalibrationSourceClosure(closure) {
  const input = closure?.input?.value;
  if (!input) fail("calibration source closure is invalid");
  if (typeof input.artifactRoot !== "string" || !isAbsolute(input.artifactRoot))
    fail("calibration artifact root is invalid");
  const artifactRootStat = lstatSync(input.artifactRoot);
  if (artifactRootStat.isSymbolicLink() || !artifactRootStat.isDirectory())
    fail("calibration artifact root is invalid");
  const artifactRoot = realpathSync(input.artifactRoot);

  const receipt = parseAcceptanceAuthorityReceipt(
    closure.acceptanceAuthorityReceipt.value,
  );
  if (
    sha256(closure.releaseProof.raw) !==
    normalizeAiRegionalSha256(
      receipt.windowsProof.signedProofSha256,
      "calibration authority signed proof",
      { prefixed: true },
    )
  )
    fail(
      "calibration release proof digest does not bind acceptance authority receipt",
    );
  const proof = parseReleaseProof(closure.releaseProof.value, receipt);
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

  const release = parseAcceptanceReport(
    closure.acceptanceReport.value,
    proof,
    attempts.map((entry) => entry.attempt),
  );
  parseRecoverySupport(closure.recoverySupport.value, proof);
  const ordered = [...attempts].sort((left, right) =>
    left.caseKey.localeCompare(right.caseKey),
  );
  const validation = validateAiRegionalEvidenceSet(
    ordered.map((entry) => entry.attempt),
    artifactRoot,
    closure.evidenceManifest.value,
  );
  if (
    validation.reason !==
    "AI regional evidence policy awaits Issue10 two-garment calibration"
  )
    fail(validation.reason ?? "calibration evidence unexpectedly passed");
  const sidecars = ordered.map((entry) =>
    readSidecar(artifactRoot, entry.attempt),
  );
  return {
    attempts: ordered,
    release,
    sidecars,
    thresholds: deriveThresholds(sidecars),
  };
}

export function validateCalibratedAiRegionalReceipt({
  closure,
  policy,
  receiptPath,
  identities,
}) {
  if (!policy || policy.calibrationStatus !== "calibrated_issue10")
    fail("calibrated AI regional evidence policy is invalid");
  const adjudicated = adjudicateCalibrationSourceClosure(closure);
  const receipt = readCanonical(
    receiptPath,
    "calibrated AI regional evidence receipt",
  );
  const value = receipt.value;
  const thresholdKeys = [
    "maximumProtectedChangedFractionBps",
    "maximumProtectedMeanDelta",
    "minimumUpperBodyChangedFractionBps",
    "minimumUpperBodyMeanDelta",
  ];
  if (
    !exact(value, [
      "acceptanceReportSha256",
      "attempts",
      "calibrationInputSha256",
      "derivedThresholds",
      "policySha256",
      "acceptanceAuthorityReceiptSha256",
      "recoverySupportSha256",
      "release",
      "releaseProofSha256",
      "schemaVersion",
    ]) ||
    value.schemaVersion !== RECEIPT_SCHEMA ||
    value.policySha256 !== policy.sha256 ||
    value.calibrationInputSha256 !== sha256(closure.input.raw) ||
    value.acceptanceReportSha256 !== sha256(closure.acceptanceReport.raw) ||
    value.acceptanceAuthorityReceiptSha256 !==
      sha256(closure.acceptanceAuthorityReceipt.raw) ||
    value.releaseProofSha256 !== sha256(closure.releaseProof.raw) ||
    value.recoverySupportSha256 !== sha256(closure.recoverySupport.raw) ||
    !exact(value.derivedThresholds, thresholdKeys) ||
    thresholdKeys.some(
      (key) =>
        value.derivedThresholds[key] !== policy[key] ||
        value.derivedThresholds[key] !== adjudicated.thresholds[key],
    ) ||
    !exact(value.release, ["aiRuntime", "contract", "modelPack", "runtime"]) ||
    thresholdKeys.some((key) => policy[key] !== adjudicated.thresholds[key]) ||
    Object.entries(adjudicated.release).some(
      ([key, digest]) => value.release[key] !== digest,
    ) ||
    Object.entries(identities).some(
      ([key, digest]) =>
        value.release[key] !== requireDigest(digest, `${key} identity`),
    ) ||
    !Array.isArray(value.attempts) ||
    value.attempts.length !== 2
  )
    fail(
      "calibrated AI regional evidence receipt is not bound to this release",
    );
  const calibrationAttempt = (attempt) => {
    const { journey, screenshots, ...value } = attempt;
    return value;
  };
  const expected = adjudicated.attempts
    .map((entry) => entry.attempt)
    .sort((left, right) => left.caseKey.localeCompare(right.caseKey))
    .map((attempt) => ({
      attemptSha256: sha256(canonicalBytes(calibrationAttempt(attempt))),
      caseKey: attempt.caseKey,
      garmentSha256: attempt.garment.sha256,
      inputSha256: attempt.input.sha256,
      recordedFixtureSha256: null,
      resultSha256: attempt.result.sha256,
      sidecarSha256: attempt.regionalEvidence.sha256,
    }));
  for (const [index, entry] of value.attempts.entries()) {
    if (
      !exact(entry, [
        "attemptSha256",
        "caseKey",
        "garmentSha256",
        "inputSha256",
        "recordedFixtureSha256",
        "resultSha256",
        "sidecarSha256",
      ]) ||
      entry.caseKey !== expected[index].caseKey ||
      entry.attemptSha256 !== expected[index].attemptSha256 ||
      entry.garmentSha256 !== expected[index].garmentSha256 ||
      entry.inputSha256 !== expected[index].inputSha256 ||
      entry.resultSha256 !== expected[index].resultSha256 ||
      entry.sidecarSha256 !== expected[index].sidecarSha256 ||
      !DIGEST.test(entry.recordedFixtureSha256 ?? "")
    )
      fail(
        "calibrated AI regional evidence receipt attempt binding mismatched",
      );
  }
  if (new Set(value.attempts.map((entry) => entry.caseKey)).size !== 2)
    fail(
      "calibrated AI regional evidence receipt attempts are not independent",
    );
  for (const key of [
    "attemptSha256",
    "garmentSha256",
    "resultSha256",
    "sidecarSha256",
  ])
    if (new Set(value.attempts.map((entry) => entry[key])).size !== 2)
      fail(
        "calibrated AI regional evidence receipt attempts are not independent",
      );
  for (const key of [
    "acceptanceReportSha256",
    "calibrationInputSha256",
    "acceptanceAuthorityReceiptSha256",
    "recoverySupportSha256",
    "releaseProofSha256",
  ])
    requireDigest(value[key], `calibrated receipt ${key}`);
  return { receipt: value, sha256: sha256(receipt.raw) };
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
      "acceptanceReport",
      "attempts",
      "evidenceManifest",
      "acceptanceAuthorityReceipt",
      "recoverySupport",
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
  const closure = readCalibrationSourceClosure(inputPath);
  const {
    attempts: ordered,
    release,
    sidecars,
    thresholds,
  } = adjudicateCalibrationSourceClosure(closure);
  const receipt = closure.acceptanceAuthorityReceipt;
  const releaseProof = closure.releaseProof;
  const acceptanceReport = closure.acceptanceReport;
  const recoverySupport = closure.recoverySupport;
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
    acceptanceAuthorityReceiptSha256: sha256(receipt.raw),
    recoverySupportSha256: sha256(recoverySupport.raw),
    release,
    releaseProofSha256: sha256(releaseProof.raw),
    acceptanceReportSha256: sha256(acceptanceReport.raw),
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
