#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { validateAiRegionalEvidenceSet } from "./ai-regional-evidence.mjs";

const INPUT_SCHEMA = "vem-ai-regional-evidence-calibration-input/v2";
const MEASUREMENT_SCHEMA = "vem-ai-regional-measurement/v1";
const DIGEST = /^[a-f0-9]{64}$/;

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}

function canonicalBytes(value, pretty = true) {
  return Buffer.from(
    `${JSON.stringify(canonical(value), null, pretty ? 2 : undefined)}\n`,
  );
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(message) {
  throw new Error(`AI regional measurement ${message}`);
}

function readCanonical(path, label, pretty = false) {
  if (!isAbsolute(path)) fail(`${label} path must be absolute`);
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink())
    fail(`${label} must be regular`);
  const raw = readFileSync(path);
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    fail(`${label} is invalid JSON`);
  }
  if (!raw.equals(canonicalBytes(value, pretty)))
    fail(`${label} is not canonical JSON`);
  return { path: resolve(path), raw, value };
}

function descriptor(path) {
  const raw = readFileSync(path);
  return { path, sha256: digest(raw) };
}

function parseArguments(argv) {
  const flags = [
    "--report",
    "--artifact-root",
    "--acceptance-authority-receipt",
    "--release-proof",
    "--recovery-support",
    "--source-root",
    "--out",
  ];
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flags.includes(flag) || result[flag] || !argv[index + 1])
      fail("CLI arguments are invalid");
    result[flag] = argv[index + 1];
  }
  if (Object.keys(result).length !== flags.length)
    fail("CLI arguments are incomplete");
  return result;
}

function writeExclusive(path, value, label) {
  if (!isAbsolute(path)) fail(`${label} path must be absolute`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, canonicalBytes(value), { flag: "wx", mode: 0o600 });
}

function copyExclusive(source, target, label) {
  if (existsSync(target)) fail(`${label} already exists`);
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  copyFileSync(source, target, 0);
}

export function createAiRegionalMeasurement(options) {
  const report = readCanonical(options.report, "business report");
  const artifactRoot = resolve(options.artifactRoot);
  const rootEntry = lstatSync(artifactRoot);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink())
    fail("artifact root must be regular directory");
  if (
    report.value?.schemaVersion !== "vem-ai-virtual-try-on-acceptance/v2" ||
    report.value?.ok !== false ||
    report.value?.error !==
      "AI regional evidence policy awaits Issue10 two-garment calibration" ||
    report.value?.calibration !== undefined ||
    report.value?.postAi?.ordinarySaleCompleted !== true
  )
    fail("business report is not calibration-pending installed evidence");
  const manifest = options.evidenceManifest
    ? readCanonical(options.evidenceManifest, "evidence manifest", true)
    : {
        value: {
          files: report.value.attempts.map((attempt) => {
            const path = resolve(artifactRoot, attempt.regionalEvidence.path);
            const bytes = readFileSync(path);
            return {
              byteLength: bytes.byteLength,
              kind: "supportingEvidence",
              path,
              sha256: digest(bytes),
              track: "aiVirtualTryOn",
            };
          }),
        },
      };
  const regional = validateAiRegionalEvidenceSet(
    report.value.attempts,
    artifactRoot,
    manifest.value,
  );
  if (
    regional.ok ||
    regional.reason !==
      "AI regional evidence policy awaits Issue10 two-garment calibration"
  )
    fail("business report must remain measured but not accepted");
  const attempts = report.value.attempts;
  if (!Array.isArray(attempts) || attempts.length !== 2)
    fail("attempts must be exact-two");
  const sourceRoot = resolve(options.sourceRoot);
  if (existsSync(sourceRoot)) fail("source bundle already exists");
  mkdirSync(sourceRoot, { recursive: true, mode: 0o700 });
  const documents = [
    ["acceptanceReport", report.path, "acceptance-report.json"],
    [
      "acceptanceAuthorityReceipt",
      readCanonical(
        options.acceptanceAuthorityReceipt,
        "acceptance authority receipt",
      ).path,
      "acceptance-authority-receipt.json",
    ],
    [
      "releaseProof",
      readCanonical(options.releaseProof, "release proof").path,
      "release-proof.json",
    ],
    [
      "recoverySupport",
      readCanonical(options.recoverySupport, "recovery support").path,
      "recovery-support.json",
    ],
  ];
  for (const [, source, name] of documents)
    copyExclusive(source, resolve(sourceRoot, name), "source bundle member");
  const sidecars = attempts.map((attempt) => {
    const relative = attempt?.regionalEvidence?.path;
    if (
      typeof relative !== "string" ||
      relative.startsWith("/") ||
      relative.includes("..")
    )
      fail("regional sidecar path is invalid");
    const source = resolve(artifactRoot, relative);
    if (!source.startsWith(`${artifactRoot}/`) || !lstatSync(source).isFile())
      fail("regional sidecar is missing");
    const target = resolve(sourceRoot, relative);
    copyExclusive(source, target, "regional sidecar");
    return { attempt, relative, target };
  });
  if (new Set(sidecars.map((entry) => entry.relative)).size !== 2)
    fail("regional sidecars are reused");
  const reducedManifest = {
    files: sidecars.map(({ attempt, target }) => ({
      byteLength: readFileSync(target).byteLength,
      kind: "supportingEvidence",
      path: target,
      sha256: attempt.regionalEvidence.sha256,
      track: "aiVirtualTryOn",
    })),
  };
  const manifestPath = resolve(sourceRoot, "evidence-manifest.json");
  writeExclusive(manifestPath, reducedManifest, "evidence manifest");
  const calibrationInput = {
    acceptanceAuthorityReceipt: descriptor(
      resolve(sourceRoot, "acceptance-authority-receipt.json"),
    ),
    acceptanceReport: descriptor(resolve(sourceRoot, "acceptance-report.json")),
    artifactRoot: sourceRoot,
    attempts: sidecars.map(({ attempt }) => ({
      attempt,
      attemptSha256: digest(canonicalBytes(attempt)),
      caseKey: attempt.caseKey,
    })),
    evidenceManifest: descriptor(manifestPath),
    recoverySupport: descriptor(resolve(sourceRoot, "recovery-support.json")),
    releaseProof: descriptor(resolve(sourceRoot, "release-proof.json")),
    schemaVersion: INPUT_SCHEMA,
  };
  const inputPath = resolve(sourceRoot, "calibration-source-input.json");
  writeExclusive(inputPath, calibrationInput, "calibration source input");
  const members = [
    "acceptance-authority-receipt.json",
    "acceptance-report.json",
    "calibration-source-input.json",
    "evidence-manifest.json",
    "recovery-support.json",
    "release-proof.json",
    ...sidecars.map((entry) => entry.relative),
  ].sort();
  if (members.length !== 8 || new Set(members).size !== 8)
    fail("source bundle must contain exact-eight members");
  const identities = members.map((name) => {
    const bytes = readFileSync(resolve(sourceRoot, name));
    return { name, sha256: digest(bytes), byteSize: bytes.byteLength };
  });
  const sourceBundle = {
    byteSize: identities.reduce((sum, member) => sum + member.byteSize, 0),
    members: identities,
    sha256: digest(
      Buffer.from(
        identities
          .map(
            (member) =>
              `${member.name}\0${member.sha256}\0${member.byteSize}\n`,
          )
          .join(""),
      ),
    ),
  };
  const measurement = {
    acceptancePassed: false,
    calibrationRequired: true,
    calibrationSourceBundle: sourceBundle,
    schemaVersion: MEASUREMENT_SCHEMA,
    status: "measured_not_accepted",
  };
  writeExclusive(options.out, measurement, "measurement output");
  return measurement;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  try {
    const options = parseArguments(process.argv.slice(2));
    createAiRegionalMeasurement({
      report: options["--report"],
      artifactRoot: options["--artifact-root"],
      acceptanceAuthorityReceipt: options["--acceptance-authority-receipt"],
      releaseProof: options["--release-proof"],
      recoverySupport: options["--recovery-support"],
      evidenceManifest: options["--evidence-manifest"],
      sourceRoot: options["--source-root"],
      out: options["--out"],
    });
  } catch (error) {
    process.stderr.write(`AI regional measurement failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
