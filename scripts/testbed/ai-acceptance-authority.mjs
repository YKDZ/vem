#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyProductionWindowsPrecutoverProof } from "../precutover-windows-proof.mjs";
import {
  TRUSTED_VISION_BUILDER_SHA,
  TRUSTED_VISION_BUILDER_WORKFLOW,
  TRUSTED_VISION_REPOSITORY,
  verifyTrustedVisionCandidateAttestation,
} from "../release-set-approval.mjs";

const SCHEMA_VERSION = "vem.testbed.ai-acceptance-authority/v1";
const CONTRACT_SCHEMA = "vem-vision-v2-contract-bundle/v1";
const CANDIDATE_MEMBERS = new Set([
  "candidate-manifest.json",
  "github-build-provenance.sigstore.json",
  "trusted-builder-evidence.json",
]);
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

function fail(message) {
  throw new Error(`AI acceptance authority ${message}`);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(canonical(value))}\n`;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) {
    fail(`${label} fields are invalid`);
  }
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.length === 0)
    fail(`${label} is required`);
  return value;
}

function requiredDigest(value, label) {
  if (!SHA256.test(requiredString(value, label))) fail(`${label} is invalid`);
  return value;
}

function requiredCommit(value, label) {
  if (!COMMIT.test(requiredString(value, label))) fail(`${label} is invalid`);
  return value;
}

function readCanonical(path, label, { newline = false } = {}) {
  const raw = readFileSync(path, "utf8");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(`${label} is invalid JSON`);
  }
  if (raw !== `${JSON.stringify(canonical(value))}${newline ? "\n" : ""}`) {
    fail(`${label} is not canonical JSON`);
  }
  return { raw, value };
}

function readJson(path, label) {
  const raw = readFileSync(path, "utf8");
  try {
    return { raw, value: JSON.parse(raw) };
  } catch {
    fail(`${label} is invalid JSON`);
  }
}

function exactCandidateInput(directory) {
  if (!isAbsolute(directory))
    fail("candidate input directory must be absolute");
  const root = resolve(directory);
  const stat = lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    fail("candidate input directory is unsafe");
  }
  const entries = readdirSync(root, { withFileTypes: true });
  if (
    entries.length !== 4 ||
    entries.some((entry) => !entry.isFile() || entry.isSymbolicLink())
  ) {
    fail("candidate input must contain exact-four regular members");
  }
  const names = entries.map((entry) => entry.name);
  if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    fail("candidate input has a case collision");
  }
  const archives = names.filter((name) => name.endsWith(".zip"));
  if (
    archives.length !== 1 ||
    ![...CANDIDATE_MEMBERS].every((name) => names.includes(name))
  ) {
    fail("candidate exact-four member set is invalid");
  }
  return {
    archive: join(root, archives[0]),
    attestation: join(root, "github-build-provenance.sigstore.json"),
    evidence: join(root, "trusted-builder-evidence.json"),
    manifest: join(root, "candidate-manifest.json"),
  };
}

function readContract(path) {
  if (!isAbsolute(path)) fail("contract manifest must be absolute");
  const { raw, value } = readCanonical(path, "contract manifest");
  exact(
    value,
    ["bundleDigest", "bundleVersion", "files", "protocol", "schemaVersion"],
    "contract manifest",
  );
  if (
    value.schemaVersion !== CONTRACT_SCHEMA ||
    value.protocol !== "vem.vision.v2" ||
    !SHA256.test(value.bundleDigest)
  ) {
    fail("contract manifest identity is invalid");
  }
  return { bundleDigest: value.bundleDigest, sha256: digest(raw) };
}

function candidateFacts(paths, contract) {
  const archive = readFileSync(paths.archive);
  const manifest = readCanonical(paths.manifest, "candidate manifest");
  const attestation = readFileSync(paths.attestation);
  const evidence = readJson(paths.evidence, "trusted builder evidence");
  exact(
    manifest.value,
    ["bindings", "files", "layout", "schemaVersion", "sourceCommit"],
    "candidate manifest",
  );
  if (
    manifest.value.schemaVersion !== "vending-vision-candidate-artifact/v3" ||
    !COMMIT.test(manifest.value.sourceCommit) ||
    !Array.isArray(manifest.value.files)
  ) {
    fail("candidate manifest identity is invalid");
  }
  const contractFile = manifest.value.files.find(
    (file) =>
      file?.path ===
      "vending-vision/_internal/contracts/vem_vision_v2/manifest.json",
  );
  if (
    !contractFile ||
    Object.keys(contractFile).sort().join("\0") !== "path\0sha256\0size" ||
    contractFile.sha256 !== contract.sha256
  ) {
    fail("candidate contract binding mismatch");
  }
  const facts = {
    attestationBundleSha256: digest(attestation),
    embeddedManifestSha256: digest(manifest.raw),
    sourceCommit: manifest.value.sourceCommit,
    subjectSha256: digest(archive),
    trustedBuilderEvidenceSha256: digest(evidence.raw),
  };
  const expectedEvidence = {
    attestationBundleSha256: facts.attestationBundleSha256,
    builderRepository: TRUSTED_VISION_REPOSITORY,
    builderWorkflow: TRUSTED_VISION_BUILDER_WORKFLOW,
    builderWorkflowSha: TRUSTED_VISION_BUILDER_SHA,
    embeddedManifestSha256: facts.embeddedManifestSha256,
    schemaVersion: "vending-vision-trusted-builder-evidence/v1",
    sourceCommit: facts.sourceCommit,
    subjectSha256: facts.subjectSha256,
  };
  if (
    JSON.stringify(canonical(evidence.value)) !==
    JSON.stringify(canonical(expectedEvidence))
  ) {
    fail("trusted builder evidence binding mismatch");
  }
  return { facts, paths };
}

function crossBind(candidate, windows, contract) {
  const proof = windows.proof;
  const matches = [
    [
      proof.candidate.attestationBundleSha256,
      candidate.attestationBundleSha256,
      "candidate attestation",
    ],
    [
      proof.candidate.embeddedManifestSha256,
      candidate.embeddedManifestSha256,
      "candidate manifest",
    ],
    [proof.candidate.sourceCommit, candidate.sourceCommit, "candidate source"],
    [
      proof.candidate.subjectSha256,
      candidate.subjectSha256,
      "candidate subject",
    ],
    [
      proof.candidate.trustedBuilderEvidenceSha256,
      candidate.trustedBuilderEvidenceSha256,
      "trusted builder evidence",
    ],
  ];
  for (const [actual, expected, label] of matches) {
    if (actual !== expected) fail(`${label} does not match Windows proof`);
  }
  return {
    candidate,
    companion: proof.companion,
    contract: {
      bundleDigest: contract.bundleDigest,
      manifestSha256: contract.sha256,
      protocol: "vem.vision.v2",
    },
    modelPack: proof.modelPack,
    resources: {
      ...proof.resources,
      workerExecutableSha256: proof.candidate.workerExecutableSha256,
    },
    schemaVersion: SCHEMA_VERSION,
    scope: "installed_windows_acceptance",
    trustStatus: "verified_for_acceptance",
    windowsProof: {
      authorityDescriptorSha256: windows.authority.descriptorSha256,
      proofAttestationBundleSha256: windows.files.bundle.sha256.slice(7),
      signedProofSha256: windows.files.proof.sha256.slice(7),
      trustedProofEvidenceSha256: windows.files.evidence.sha256.slice(7),
      workflowSha: windows.authority.workflowSha,
    },
  };
}

function writeExclusive(path, raw) {
  if (!isAbsolute(path)) fail("output must be absolute");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, raw, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function verify(
  options,
  { verifyCandidateAttestation, verifyWindowsProof },
) {
  const contract = readContract(options.contractManifest);
  const candidate = candidateFacts(
    exactCandidateInput(options.candidateInputDirectory),
    contract,
  );
  await verifyCandidateAttestation({
    artifactPath: candidate.paths.archive,
    attestationBundlePath: candidate.paths.attestation,
    ghBinaryPath: options.ghBinaryPath,
    sourceCommit: candidate.facts.sourceCommit,
    sourceRef: options.visionSourceRef,
    subjectSha256: candidate.facts.subjectSha256,
  });
  return verifyWindowsProof(
    {
      ghBinaryPath: options.ghBinaryPath,
      inputDirectory: options.windowsProofInputDirectory,
      repoRoot: options.repoRoot,
      sourceRef: options.visionSourceRef,
    },
    async (windows, revalidate) => {
      const receipt = crossBind(candidate.facts, windows, contract);
      revalidate();
      return receipt;
    },
  );
}

export async function verifyAiAcceptanceAuthorityForTest(
  options,
  dependencies,
) {
  if (
    process.env.NODE_ENV !== "test" ||
    typeof dependencies?.verifyCandidateAttestation !== "function" ||
    typeof dependencies?.verifyWindowsProof !== "function"
  ) {
    fail("test-only authority verifier boundary is unavailable");
  }
  return verify(options, dependencies);
}

export async function createAiAcceptanceAuthorityReceipt(options) {
  const receipt = await verify(options, {
    verifyCandidateAttestation: verifyTrustedVisionCandidateAttestation,
    verifyWindowsProof: verifyProductionWindowsPrecutoverProof,
  });
  writeExclusive(options.outputPath, canonicalJson(receipt));
  return receipt;
}

function parseArgs(argv) {
  const [command, ...tokens] = argv;
  if (command !== "verify")
    fail("usage: ai-acceptance-authority.mjs verify [options]");
  const required = [
    "candidate-input-directory",
    "contract-manifest",
    "gh-binary",
    "output",
    "repo-root",
    "vision-source-ref",
    "windows-proof-input-directory",
  ];
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
  return {
    candidateInputDirectory: values["candidate-input-directory"],
    contractManifest: values["contract-manifest"],
    ghBinaryPath: values["gh-binary"],
    outputPath: values.output,
    repoRoot: values["repo-root"],
    visionSourceRef: values["vision-source-ref"],
    windowsProofInputDirectory: values["windows-proof-input-directory"],
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  createAiAcceptanceAuthorityReceipt(parseArgs(process.argv.slice(2)))
    .then(() => process.stdout.write("AI_ACCEPTANCE_AUTHORITY=PASS\n"))
    .catch((error) => {
      process.stderr.write(`AI_ACCEPTANCE_AUTHORITY=FAIL:${error.message}\n`);
      process.exitCode = 1;
    });
}
