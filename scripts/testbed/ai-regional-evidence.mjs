import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
const POLICY_PATH = resolve(MODULE_ROOT, "ai-regional-evidence-policy.json");
const SIDECAR_SCHEMA = "vem-ai-regional-evidence/v1";
const REPORT_SCHEMA = "vem-ai-regional-evidence-reference/v1";
const DIGEST = /^[a-f0-9]{64}$/;
const POLICY_RAW = readFileSync(POLICY_PATH, "utf8");
const POLICY_VALUE = JSON.parse(POLICY_RAW);
if (
  `${JSON.stringify(canonical(POLICY_VALUE), null, 2)}\n` !== POLICY_RAW ||
  !exact(POLICY_VALUE, [
    "algorithm",
    "atrEvaluator",
    "calibrationStatus",
    "lipEvaluator",
    "minimumUpperBodySampledPixels",
    "poseEvaluator",
    "schemaVersion",
    "sourceDescriptorSha256",
  ]) ||
  POLICY_VALUE.calibrationStatus !== "pending_issue10_two_garment"
)
  throw new Error("AI regional evidence policy authority is invalid");
export const AI_REGIONAL_EVIDENCE_POLICY = Object.freeze(POLICY_VALUE);
export const AI_REGIONAL_EVIDENCE_POLICY_SHA256 = createHash("sha256")
  .update(POLICY_RAW)
  .digest("hex");

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

function within(root, candidate) {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}

function fail(reason) {
  return { ok: false, reason };
}

function safeInteger(value, minimum, maximum) {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function expandRle(region, pixelCount, label) {
  if (
    !exact(region, ["encoding", "runs"]) ||
    region.encoding !== "rle-row-major/v1" ||
    !Array.isArray(region.runs) ||
    region.runs.length === 0
  )
    throw new Error(`${label} RLE is invalid`);
  const pixels = [];
  let previousEnd = 0;
  for (const run of region.runs) {
    if (
      !Array.isArray(run) ||
      run.length !== 2 ||
      !safeInteger(run[0], 0, pixelCount - 1) ||
      !safeInteger(run[1], 1, pixelCount) ||
      run[0] < previousEnd ||
      run[0] + run[1] > pixelCount
    )
      throw new Error(`${label} RLE is out of bounds or overlapping`);
    for (let offset = 0; offset < run[1]; offset += 1)
      pixels.push(run[0] + offset);
    previousEnd = run[0] + run[1];
  }
  return pixels;
}

function measurement(inputRgb, resultRgb, pixels) {
  let changedPixels = 0;
  let totalDelta = 0;
  for (const pixel of pixels) {
    let changed = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(
        resultRgb[pixel * 3 + channel] - inputRgb[pixel * 3 + channel],
      );
      totalDelta += delta;
      if (delta > 0) changed = true;
    }
    if (changed) changedPixels += 1;
  }
  return {
    sampledPixels: pixels.length,
    changedPixels,
    changedFractionBps: Math.floor((changedPixels * 10_000) / pixels.length),
    meanDelta: Math.floor(totalDelta / (pixels.length * 3)),
  };
}

export function evaluateAiRegionalPixels(
  { width, height, inputRgb, resultRgb, upperBody, protectedRegion },
  policy,
) {
  if (
    process.env.NODE_ENV !== "test" ||
    !safeInteger(width, 1, 4096) ||
    !safeInteger(height, 1, 4096) ||
    !Array.isArray(inputRgb) ||
    !Array.isArray(resultRgb) ||
    inputRgb.length !== width * height * 3 ||
    resultRgb.length !== inputRgb.length ||
    ![...inputRgb, ...resultRgb].every((value) => safeInteger(value, 0, 255))
  )
    throw new Error("test-owned RGB evaluation input is invalid");
  const pixelCount = width * height;
  const upperPixels = expandRle(upperBody, pixelCount, "upperBody");
  const protectedPixels = expandRle(
    protectedRegion,
    pixelCount,
    "protectedRegion",
  );
  const protectedSet = new Set(protectedPixels);
  if (upperPixels.some((pixel) => protectedSet.has(pixel)))
    throw new Error("regional masks overlap");
  const upperMeasurement = measurement(inputRgb, resultRgb, upperPixels);
  const protectedMeasurement = measurement(
    inputRgb,
    resultRgb,
    protectedPixels,
  );
  const upperChanged =
    upperMeasurement.sampledPixels >= policy.minimumUpperBodySampledPixels &&
    upperMeasurement.changedFractionBps >=
      policy.minimumUpperBodyChangedFractionBps &&
    upperMeasurement.meanDelta >= policy.minimumUpperBodyMeanDelta;
  const protectedPreserved =
    protectedMeasurement.changedFractionBps <=
      policy.maximumProtectedChangedFractionBps &&
    protectedMeasurement.meanDelta <= policy.maximumProtectedMeanDelta;
  return {
    upperBody: {
      ...upperMeasurement,
      verdict: upperChanged ? "changed" : "insufficient_change",
    },
    protectedRegion: {
      ...protectedMeasurement,
      verdict: protectedPreserved ? "preserved" : "changed",
    },
    verdict:
      upperChanged && protectedPreserved ? "passed" : "regional_check_failed",
  };
}

function validateMeasurement(value, sampledPixels, label) {
  return (
    exact(value, [
      "changedFractionBps",
      "changedPixels",
      "meanDelta",
      "sampledPixels",
      "verdict",
    ]) &&
    value.sampledPixels === sampledPixels &&
    safeInteger(value.changedPixels, 0, sampledPixels) &&
    safeInteger(value.changedFractionBps, 0, 10_000) &&
    value.changedFractionBps ===
      Math.floor((value.changedPixels * 10_000) / sampledPixels) &&
    safeInteger(value.meanDelta, 0, 255) &&
    (label === "upperBody"
      ? ["changed", "insufficient_change"].includes(value.verdict)
      : ["preserved", "changed"].includes(value.verdict))
  );
}

export function validateAiRegionalEvidence(
  attempt,
  artifactRoot,
  evidenceManifest = null,
) {
  const reference = attempt?.regionalEvidence;
  if (
    !exact(reference, ["path", "schemaVersion", "sha256", "verdict"]) ||
    reference.schemaVersion !== REPORT_SCHEMA ||
    !DIGEST.test(reference.sha256 ?? "") ||
    !["passed", "regional_check_failed"].includes(reference.verdict)
  )
    return fail("AI regional evidence reference is missing or invalid");
  if (
    typeof artifactRoot !== "string" ||
    !isAbsolute(artifactRoot) ||
    typeof attempt?.attemptId !== "string" ||
    typeof attempt?.caseKey !== "string" ||
    typeof reference.path !== "string" ||
    reference.path === "" ||
    isAbsolute(reference.path) ||
    reference.path !==
      `regional/${attempt.caseKey}/${attempt.attemptId}.regional-evidence.json`
  )
    return fail("AI regional evidence root or path is invalid");
  try {
    const rootStat = lstatSync(artifactRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory())
      return fail("AI regional evidence root is not a regular directory");
    const root = realpathSync(artifactRoot);
    const candidatePath = resolve(root, reference.path);
    const candidateStat = lstatSync(candidatePath);
    if (candidateStat.isSymbolicLink() || !candidateStat.isFile())
      return fail("AI regional evidence sidecar is not a regular file");
    const candidate = realpathSync(candidatePath);
    if (!within(root, candidate))
      return fail("AI regional evidence sidecar escapes its artifact root");
    if (candidateStat.size <= 0 || candidateStat.size > 512 * 1024)
      return fail("AI regional evidence sidecar size is invalid");
    const raw = readFileSync(candidate);
    if (createHash("sha256").update(raw).digest("hex") !== reference.sha256)
      return fail("AI regional evidence sidecar digest mismatched");
    const owned = evidenceManifest?.files?.some(
      (file) =>
        file?.track === "aiVirtualTryOn" &&
        file?.kind === "supportingEvidence" &&
        resolve(file.path) === candidate &&
        file?.byteLength === raw.byteLength &&
        file?.sha256 === reference.sha256,
    );
    if (!owned)
      return fail("AI regional evidence sidecar is not manifest-owned");
    let sidecar;
    try {
      sidecar = JSON.parse(raw.toString("utf8"));
    } catch {
      return fail("AI regional evidence sidecar is invalid JSON");
    }
    if (`${JSON.stringify(canonical(sidecar))}\n` !== raw.toString("utf8"))
      return fail("AI regional evidence sidecar is not canonical JSON");
    if (
      !exact(sidecar, [
        "attempt",
        "evaluator",
        "kind",
        "masks",
        "measurements",
        "policy",
        "schemaVersion",
        "verdict",
      ]) ||
      sidecar.schemaVersion !== SIDECAR_SCHEMA ||
      sidecar.kind !== "regional-evidence" ||
      !exact(sidecar.attempt, [
        "acquisitionSource",
        "decodedHeight",
        "decodedWidth",
        "garmentSha256",
        "inputSha256",
        "recordedFixtureSha256",
        "resultSha256",
        "sourceCamera",
      ]) ||
      sidecar.attempt.inputSha256 !== attempt?.input?.sha256 ||
      sidecar.attempt.garmentSha256 !== attempt?.garment?.sha256 ||
      sidecar.attempt.resultSha256 !== attempt?.result?.sha256 ||
      sidecar.attempt.decodedWidth !== attempt?.result?.decodedWidth ||
      sidecar.attempt.decodedHeight !== attempt?.result?.decodedHeight ||
      sidecar.attempt.sourceCamera !== "front" ||
      sidecar.attempt.acquisitionSource !== "direct_recorded_frame" ||
      !DIGEST.test(sidecar.attempt.recordedFixtureSha256 ?? "") ||
      !exact(sidecar.evaluator, [
        "algorithm",
        "atr",
        "lip",
        "pose",
        "sourceDescriptorSha256",
      ]) ||
      sidecar.evaluator.algorithm !== AI_REGIONAL_EVIDENCE_POLICY.algorithm ||
      sidecar.evaluator.atr !== AI_REGIONAL_EVIDENCE_POLICY.atrEvaluator ||
      sidecar.evaluator.lip !== AI_REGIONAL_EVIDENCE_POLICY.lipEvaluator ||
      sidecar.evaluator.pose !== AI_REGIONAL_EVIDENCE_POLICY.poseEvaluator ||
      sidecar.evaluator.sourceDescriptorSha256 !==
        AI_REGIONAL_EVIDENCE_POLICY.sourceDescriptorSha256 ||
      !exact(sidecar.policy, ["sha256", "schemaVersion"]) ||
      sidecar.policy.schemaVersion !==
        AI_REGIONAL_EVIDENCE_POLICY.schemaVersion ||
      sidecar.policy.sha256 !== AI_REGIONAL_EVIDENCE_POLICY_SHA256 ||
      !exact(sidecar.masks, [
        "height",
        "protectedRegion",
        "upperBody",
        "width",
      ]) ||
      sidecar.masks.width !== sidecar.attempt.decodedWidth ||
      sidecar.masks.height !== sidecar.attempt.decodedHeight ||
      !exact(sidecar.measurements, ["protectedRegion", "upperBody"])
    )
      return fail("AI regional evidence identity or schema mismatched");
    const pixelCount = sidecar.masks.width * sidecar.masks.height;
    const upper = expandRle(sidecar.masks.upperBody, pixelCount, "upperBody");
    const protectedPixels = expandRle(
      sidecar.masks.protectedRegion,
      pixelCount,
      "protectedRegion",
    );
    const protectedSet = new Set(protectedPixels);
    if (upper.some((pixel) => protectedSet.has(pixel)))
      return fail("AI regional evidence masks overlap");
    if (
      !validateMeasurement(
        sidecar.measurements.upperBody,
        upper.length,
        "upperBody",
      ) ||
      !validateMeasurement(
        sidecar.measurements.protectedRegion,
        protectedPixels.length,
        "protectedRegion",
      ) ||
      sidecar.verdict !== reference.verdict ||
      sidecar.verdict !==
        (sidecar.measurements.upperBody.verdict === "changed" &&
        sidecar.measurements.protectedRegion.verdict === "preserved"
          ? "passed"
          : "regional_check_failed")
    )
      return fail("AI regional evidence measurement or verdict contradicted");
    if (AI_REGIONAL_EVIDENCE_POLICY.calibrationStatus !== "calibrated_issue10")
      return fail(
        "AI regional evidence policy awaits Issue10 two-garment calibration",
      );
    return { ok: true, reason: null };
  } catch (error) {
    return fail(
      `AI regional evidence is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function validateAiRegionalEvidenceSet(
  attempts,
  artifactRoot,
  evidenceManifest = null,
) {
  if (!Array.isArray(attempts) || attempts.length !== 2)
    return fail("AI regional evidence attempt set is invalid");
  const physicalMembers = new Set();
  try {
    const root = realpathSync(artifactRoot);
    for (const attempt of attempts) {
      const candidate = resolve(root, attempt?.regionalEvidence?.path ?? "");
      const stat = lstatSync(candidate, { bigint: true });
      if (stat.isSymbolicLink() || !stat.isFile())
        return fail("AI regional evidence sidecar is not a regular file");
      const identity = `${stat.dev}:${stat.ino}`;
      if (physicalMembers.has(identity))
        return fail("AI regional evidence physical member is reused");
      physicalMembers.add(identity);
    }
  } catch (error) {
    return fail(
      `AI regional evidence member identity is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  for (const attempt of attempts) {
    const result = validateAiRegionalEvidence(
      attempt,
      artifactRoot,
      evidenceManifest,
    );
    if (!result.ok) return result;
  }
  return { ok: true, reason: null };
}
