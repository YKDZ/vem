#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  canonicalAiAcceptanceInputManifest,
  describeAiAcceptanceInputDirectory,
  validateAiAcceptanceInputManifest,
} from "./ai-acceptance-input-provisioning.mjs";
import { loadAiRegionalEvidencePolicy } from "./ai-regional-evidence.mjs";
import {
  readCalibrationSourceClosure,
  validateCalibratedAiRegionalReceipt,
} from "./calibrate-ai-regional-evidence.mjs";

const SOURCE_COMMIT = /^[a-f0-9]{40}$/;

function fail(message) {
  throw new Error(`AI acceptance input manifest creation ${message}`);
}

function absolute(path, label) {
  if (typeof path !== "string" || !isAbsolute(path))
    fail(`${label} must be absolute`);
  return resolve(path);
}

function contains(root, path) {
  const difference = relative(resolve(root), resolve(path));
  return (
    difference === "" ||
    (difference !== ".." &&
      !difference.startsWith(`..${sep}`) &&
      !isAbsolute(difference))
  );
}

async function assertSafePath(path, label, { required = true } = {}) {
  const resolved = absolute(path, label);
  const ancestors = [];
  for (let current = resolved; ; current = dirname(current)) {
    ancestors.push(current);
    if (dirname(current) === current) break;
  }
  for (const ancestor of ancestors.reverse()) {
    const entry = await lstat(ancestor).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (!entry) {
      if (required) fail(`${label} is missing`);
      return resolved;
    }
    if (entry.isSymbolicLink())
      fail(`${label} must not have a symlink ancestor`);
    if (ancestor !== resolved && !entry.isDirectory())
      fail(`${label} parent must be a directory`);
  }
  return resolved;
}

async function rejectOverlappingOutput(inputDirectories, outputPath, label) {
  const roots = await Promise.all(
    inputDirectories.map(async (path) =>
      realpath(absolute(path, "input directory")),
    ),
  );
  if (roots.some((path) => contains(path, outputPath)))
    fail(`output must remain outside ${label}`);
}

async function describeFile(path, label, sourceCommit) {
  const hostPath = await assertSafePath(path, label);
  const entry = await lstat(hostPath).catch(() => fail(`${label} is missing`));
  if (!entry.isFile() || entry.isSymbolicLink())
    fail(`${label} must be a regular file`);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(hostPath)) hash.update(chunk);
  return {
    hostPath,
    sha256: hash.digest("hex"),
    byteSize: entry.size,
    ...(sourceCommit ? { sourceCommit } : {}),
  };
}

function authoritySourceCommit(raw) {
  let receipt;
  try {
    receipt = JSON.parse(raw);
  } catch {
    fail("acceptance authority receipt is not JSON");
  }
  const commits = [
    receipt?.candidate?.sourceCommit,
    receipt?.visionCore?.runtimeArchive?.sourceCommit,
    receipt?.visionCore?.recordedFixtureArchive?.sourceCommit,
  ];
  if (
    commits.some((commit) => !SOURCE_COMMIT.test(commit ?? "")) ||
    new Set(commits).size !== 1
  ) {
    fail("acceptance authority Vision source commit is invalid");
  }
  return commits[0];
}

export async function buildMeasurementAiAcceptanceInputManifest(options) {
  const receiptPath = await assertSafePath(
    options.acceptanceAuthorityReceipt,
    "acceptance authority receipt",
  );
  const sourceCommit = authoritySourceCommit(
    await readFile(receiptPath, "utf8"),
  );
  return {
    acceptanceAuthorityReceipt: await describeFile(
      receiptPath,
      "acceptance authority receipt",
    ),
    candidateInput: await describeSafeDirectory(
      options.candidateInputDirectory,
      "candidate input directory",
      { nested: false },
    ),
    installedVisionRuntimeArchive: await describeFile(
      options.installedVisionRuntimeArchive,
      "installed Vision runtime archive",
      sourceCommit,
    ),
    modelPack: {
      archive: await describeFile(
        options.modelPackArchive,
        "model pack archive",
      ),
      delivery: { kind: "host-local-cache" },
      materializedRoot: await describeSafeDirectory(
        options.materializedModelPackRoot,
        "materialized model pack root",
        { nested: true },
      ),
    },
    phase: "measurement",
    recordedFixtureArchive: await describeFile(
      options.recordedFixtureArchive,
      "recorded fixture archive",
      sourceCommit,
    ),
    schemaVersion: "vem-runtime-testbed-ai-input/v4",
    windowsProofInput: await describeSafeDirectory(
      options.windowsProofInputDirectory,
      "Windows proof input directory",
      { nested: false },
    ),
  };
}

async function describeSafeDirectory(path, label, options) {
  return describeAiAcceptanceInputDirectory(
    await assertSafePath(path, label),
    label,
    options,
  );
}

export async function createMeasurementAiAcceptanceInputManifest(options) {
  const outputPath = absolute(options.outputPath, "output");
  const value = await buildMeasurementAiAcceptanceInputManifest(options);
  const raw = canonicalAiAcceptanceInputManifest(value);
  await validateAiAcceptanceInputManifest(raw);
  await assertSafePath(outputPath, "output", { required: false });
  await rejectOverlappingOutput(
    [
      value.candidateInput.hostPath,
      value.windowsProofInput.hostPath,
      value.modelPack.materializedRoot.hostPath,
    ],
    outputPath,
    "candidate, proof, and model input directories",
  );
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await assertSafePath(outputPath, "output", { required: false });
  await validateAiAcceptanceInputManifest(raw);
  await rejectOverlappingOutput(
    [
      value.candidateInput.hostPath,
      value.windowsProofInput.hostPath,
      value.modelPack.materializedRoot.hostPath,
    ],
    outputPath,
    "candidate, proof, and model input directories",
  );
  await writeFile(outputPath, raw, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return {
    outputPath,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

async function readValidatedMeasurementManifest(path) {
  const measurementPath = await assertSafePath(path, "measurement manifest");
  const entry = await lstat(measurementPath).catch(() =>
    fail("measurement manifest is missing"),
  );
  if (!entry.isFile() || entry.isSymbolicLink())
    fail("measurement manifest must be a regular file");
  const raw = await readFile(measurementPath, "utf8");
  let unvalidated;
  try {
    unvalidated = JSON.parse(raw);
  } catch {
    fail("measurement manifest is not JSON");
  }
  for (const descriptor of [
    unvalidated.acceptanceAuthorityReceipt,
    unvalidated.candidateInput,
    unvalidated.windowsProofInput,
    unvalidated.installedVisionRuntimeArchive,
    unvalidated.recordedFixtureArchive,
    unvalidated.modelPack?.archive,
    unvalidated.modelPack?.materializedRoot,
  ]) {
    await assertSafePath(descriptor?.hostPath, "measurement manifest input");
  }
  const preparation = await validateAiAcceptanceInputManifest(raw);
  const measurement = JSON.parse(raw);
  if (measurement.phase !== "measurement")
    fail("measurement manifest phase must be measurement");
  return { measurement, preparation };
}

function calibrationReleaseIdentities(authority) {
  return {
    aiRuntime: authority.resources.runtimeDescriptorSha256,
    contract: authority.contract.bundleDigest,
    modelPack: authority.modelPack.archive.sha256,
    runtime: authority.candidate.subjectSha256,
  };
}

function validateFormalCalibration(value, authority) {
  const policy = loadAiRegionalEvidencePolicy(
    value.calibratedRegionalPolicy.hostPath,
  );
  const closure = readCalibrationSourceClosure(
    join(
      value.calibrationSourceInput.hostPath,
      "calibration-source-input.json",
    ),
  );
  validateCalibratedAiRegionalReceipt({
    closure,
    identities: calibrationReleaseIdentities(authority),
    policy,
    receiptPath: value.calibrationReceipt.hostPath,
  });
}

export async function buildFormalAiAcceptanceInputManifest(options) {
  const { measurement, preparation } = await readValidatedMeasurementManifest(
    options.measurementManifest,
  );
  const value = {
    acceptanceAuthorityReceipt: measurement.acceptanceAuthorityReceipt,
    calibrationSourceInput: await describeSafeDirectory(
      options.calibrationSourceInputDirectory,
      "formal calibration source bundle",
      { nested: true },
    ),
    calibratedRegionalPolicy: await describeFile(
      options.calibratedRegionalPolicy,
      "calibrated regional policy",
    ),
    calibrationReceipt: await describeFile(
      options.calibrationReceipt,
      "calibration receipt",
    ),
    candidateInput: measurement.candidateInput,
    installedVisionRuntimeArchive: measurement.installedVisionRuntimeArchive,
    modelPack: measurement.modelPack,
    phase: "formal",
    recordedFixtureArchive: measurement.recordedFixtureArchive,
    schemaVersion: "vem-runtime-testbed-ai-input/v4",
    windowsProofInput: measurement.windowsProofInput,
  };
  await validateAiAcceptanceInputManifest(
    canonicalAiAcceptanceInputManifest(value),
  );
  validateFormalCalibration(
    value,
    preparation.acceptanceAuthorityReceipt.value,
  );
  return value;
}

export async function createFormalAiAcceptanceInputManifest(options) {
  const outputPath = absolute(options.outputPath, "output");
  const { measurement } = await readValidatedMeasurementManifest(
    options.measurementManifest,
  );
  const calibrationSourceInputDirectory = await assertSafePath(
    options.calibrationSourceInputDirectory,
    "formal calibration source bundle",
  );
  await assertSafePath(outputPath, "output", { required: false });
  await rejectOverlappingOutput(
    [
      measurement.candidateInput.hostPath,
      measurement.windowsProofInput.hostPath,
      measurement.modelPack.materializedRoot.hostPath,
      calibrationSourceInputDirectory,
    ],
    outputPath,
    "every formal input directory",
  );
  const value = await buildFormalAiAcceptanceInputManifest(options);
  const raw = canonicalAiAcceptanceInputManifest(value);
  await validateAiAcceptanceInputManifest(raw);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  await assertSafePath(outputPath, "output", { required: false });
  await validateAiAcceptanceInputManifest(raw);
  validateFormalCalibration(
    value,
    (await readValidatedMeasurementManifest(options.measurementManifest))
      .preparation.acceptanceAuthorityReceipt.value,
  );
  await rejectOverlappingOutput(
    [
      measurement.candidateInput.hostPath,
      measurement.windowsProofInput.hostPath,
      measurement.modelPack.materializedRoot.hostPath,
      value.calibrationSourceInput.hostPath,
    ],
    outputPath,
    "every formal input directory",
  );
  await writeFile(outputPath, raw, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return {
    outputPath,
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  const commands = {
    "create-measurement": [
      "acceptance-authority-receipt",
      "candidate-input-directory",
      "installed-vision-runtime-archive",
      "materialized-model-pack-root",
      "model-pack-archive",
      "output",
      "recorded-fixture-archive",
      "windows-proof-input-directory",
    ],
    "create-formal": [
      "measurement-manifest",
      "calibrated-regional-policy",
      "calibration-receipt",
      "calibration-source-input-directory",
      "output",
    ],
  };
  if (!Object.hasOwn(commands, command)) {
    fail(
      "usage: ai-acceptance-input-manifest.mjs <create-measurement|create-formal> [options]",
    );
  }
  const required = commands[command];
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (!flag?.startsWith("--") || value === undefined)
      fail("arguments are invalid");
    const key = flag.slice(2);
    if (!required.includes(key) || Object.hasOwn(values, key))
      fail(`unknown or duplicate --${key}`);
    values[key] = value;
  }
  for (const key of required) if (!values[key]) fail(`--${key} is required`);
  if (command === "create-formal")
    return {
      calibratedRegionalPolicy: values["calibrated-regional-policy"],
      calibrationReceipt: values["calibration-receipt"],
      calibrationSourceInputDirectory:
        values["calibration-source-input-directory"],
      measurementManifest: values["measurement-manifest"],
      outputPath: values.output,
    };
  return {
    acceptanceAuthorityReceipt: values["acceptance-authority-receipt"],
    candidateInputDirectory: values["candidate-input-directory"],
    installedVisionRuntimeArchive: values["installed-vision-runtime-archive"],
    materializedModelPackRoot: values["materialized-model-pack-root"],
    modelPackArchive: values["model-pack-archive"],
    outputPath: values.output,
    recordedFixtureArchive: values["recorded-fixture-archive"],
    windowsProofInputDirectory: values["windows-proof-input-directory"],
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  (process.argv[2] === "create-formal"
    ? createFormalAiAcceptanceInputManifest
    : createMeasurementAiAcceptanceInputManifest)(
    parseArgs(process.argv.slice(2)),
  )
    .then((result) =>
      process.stdout.write(
        `AI_ACCEPTANCE_INPUT_MANIFEST=PASS:${result.sha256}\n`,
      ),
    )
    .catch((error) => {
      process.stderr.write(
        `AI_ACCEPTANCE_INPUT_MANIFEST=FAIL:${error.message}\n`,
      );
      process.exitCode = 1;
    });
}
