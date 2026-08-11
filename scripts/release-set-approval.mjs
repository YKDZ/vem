import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { verifyReleaseSet } from "./release-set.mjs";
import { verifyTrustedGhBinary } from "./trusted-gh-cli.mjs";

export const TRUSTED_RELEASE_SET_REPOSITORY = "YKDZ/vem";
export const TRUSTED_RELEASE_SET_WORKFLOW =
  ".github/workflows/trusted-release-set-attester.yml";
export const TRUSTED_RELEASE_SET_WORKFLOW_SHA =
  "f849cb57d0868fe7b11065fcacbbf9276291abd4";
const APPROVAL_SCHEMA = "vem.release-set.approval.v1";
const EVIDENCE_SCHEMA = "vem.release-set.component-evidence.v1";
const COMMIT_RE = /^[a-f0-9]{40}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const SOURCE_REF_RE =
  /^refs\/tags\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rc\.[0-9A-Za-z.-]+$/;
const INPUT_MEMBERS = ["component-evidence.json", "release-set.json"];
const GH_VERIFICATION_MEDIA_TYPE =
  "application/vnd.dev.sigstore.verificationresult+json;version=0.1";
const GH_CERTIFICATE_KEYS = [
  "buildConfigDigest",
  "buildConfigURI",
  "buildSignerDigest",
  "buildSignerURI",
  "buildTrigger",
  "certificateIssuer",
  "githubWorkflowName",
  "githubWorkflowRef",
  "githubWorkflowRepository",
  "githubWorkflowSHA",
  "githubWorkflowTrigger",
  "issuer",
  "runInvocationURI",
  "runnerEnvironment",
  "sourceRepositoryDigest",
  "sourceRepositoryIdentifier",
  "sourceRepositoryOwnerIdentifier",
  "sourceRepositoryOwnerURI",
  "sourceRepositoryRef",
  "sourceRepositoryURI",
  "sourceRepositoryVisibilityAtSigning",
  "subjectAlternativeName",
];

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sortCanonical(value) {
  if (Array.isArray(value)) return value.map(sortCanonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortCanonical(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortCanonical(value))}\n`;
}

function parseCanonical(raw, label) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  if (canonicalJson(parsed) !== raw) {
    throw new Error(`${label} must use canonical JSON`);
  }
  return parsed;
}

function assertExactObject(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...keys].sort())
  ) {
    throw new Error(`${label} has missing or unknown fields`);
  }
}

function validateClaim(sourceCommit, sourceRef, workflowSha) {
  if (!COMMIT_RE.test(sourceCommit))
    throw new Error("source commit is invalid");
  if (!SOURCE_REF_RE.test(sourceRef)) throw new Error("source ref is invalid");
  if (!COMMIT_RE.test(workflowSha)) {
    throw new Error("trusted attester workflow SHA is invalid");
  }
}

function readExactInput(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  if (
    JSON.stringify(entries.map((entry) => entry.name).sort()) !==
    JSON.stringify(INPUT_MEMBERS)
  ) {
    throw new Error(
      "release-set input artifact must contain exactly two members",
    );
  }
  const result = {};
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (!entry.isFile() || !lstatSync(path).isFile()) {
      throw new Error(
        "release-set input artifact members must be regular files",
      );
    }
    result[entry.name] = readFileSync(path, "utf8");
  }
  return result;
}

export function createReleaseSetApproval({
  attesterWorkflowSha,
  inputDirectory,
  outputPath,
  repoRoot,
  sourceCommit,
  sourceRef,
}) {
  validateClaim(sourceCommit, sourceRef, attesterWorkflowSha);
  const input = readExactInput(inputDirectory);
  const componentEvidenceText = input["component-evidence.json"];
  const manifestText = input["release-set.json"];
  const componentEvidence = parseCanonical(
    componentEvidenceText,
    "component evidence",
  );
  if (componentEvidence.schemaVersion !== EVIDENCE_SCHEMA) {
    throw new Error("component evidence schema is invalid");
  }
  if (componentEvidence.vem?.sourceCommit !== sourceCommit) {
    throw new Error(
      "component evidence does not bind the approved source commit",
    );
  }
  const manifestSha256 = sha256(manifestText);
  verifyReleaseSet({
    componentEvidence,
    expectedManifestSha256: manifestSha256,
    manifestText,
    repoRoot,
  });
  const approvalText = canonicalJson({
    attester: {
      hostedRunnerRequired: true,
      repository: TRUSTED_RELEASE_SET_REPOSITORY,
      workflow: TRUSTED_RELEASE_SET_WORKFLOW,
      workflowSha: attesterWorkflowSha,
    },
    componentEvidenceSha256: sha256(componentEvidenceText),
    manifestSha256,
    schemaVersion: APPROVAL_SCHEMA,
    sourceCommit,
    sourceRef,
  });
  const temporary = join(dirname(outputPath), `.${process.pid}.approval.tmp`);
  writeFileSync(temporary, approvalText, { flag: "wx" });
  renameSync(temporary, outputPath);
  return JSON.parse(approvalText);
}

export function verifyReleaseSetApprovalBinding({
  approvalText,
  componentEvidenceText,
  manifestText,
  sourceCommit,
  sourceRef,
  trustedWorkflowSha,
}) {
  validateClaim(sourceCommit, sourceRef, trustedWorkflowSha);
  const approval = parseCanonical(approvalText, "release-set approval");
  assertExactObject(
    approval,
    [
      "attester",
      "componentEvidenceSha256",
      "manifestSha256",
      "schemaVersion",
      "sourceCommit",
      "sourceRef",
    ],
    "release-set approval",
  );
  assertExactObject(
    approval.attester,
    ["hostedRunnerRequired", "repository", "workflow", "workflowSha"],
    "release-set approval attester",
  );
  if (
    approval.schemaVersion !== APPROVAL_SCHEMA ||
    approval.sourceCommit !== sourceCommit ||
    approval.sourceRef !== sourceRef ||
    approval.attester.repository !== TRUSTED_RELEASE_SET_REPOSITORY ||
    approval.attester.workflow !== TRUSTED_RELEASE_SET_WORKFLOW ||
    approval.attester.workflowSha !== trustedWorkflowSha ||
    approval.attester.hostedRunnerRequired !== true
  ) {
    throw new Error("release-set approval authority mismatch");
  }
  if (
    !DIGEST_RE.test(approval.manifestSha256) ||
    approval.manifestSha256 !== sha256(manifestText) ||
    !DIGEST_RE.test(approval.componentEvidenceSha256) ||
    approval.componentEvidenceSha256 !== sha256(componentEvidenceText)
  ) {
    throw new Error("release-set approval payload digest mismatch");
  }
  parseCanonical(componentEvidenceText, "component evidence");
  return approval;
}

function assertNonemptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

export function parseTrustedGhAttestationVerification({
  approvalText,
  output,
  sourceCommit,
  sourceRef,
}) {
  if (typeof output !== "string" || output.length === 0) {
    throw new Error("GitHub attestation verification output is empty");
  }
  let entries;
  try {
    entries = JSON.parse(output);
  } catch {
    throw new Error("GitHub attestation verification output is invalid JSON");
  }
  if (!Array.isArray(entries) || entries.length !== 1) {
    throw new Error(
      "GitHub attestation verification must contain exactly one result",
    );
  }
  const entry = entries[0];
  assertExactObject(
    entry,
    ["attestation", "verificationResult"],
    "GitHub attestation result",
  );
  assertExactObject(
    entry.attestation,
    ["bundle", "bundle_url", "initiator"],
    "GitHub attestation metadata",
  );
  if (
    entry.attestation.bundle === null ||
    typeof entry.attestation.bundle !== "object" ||
    Array.isArray(entry.attestation.bundle)
  ) {
    throw new Error("GitHub attestation bundle metadata is invalid");
  }
  if (
    typeof entry.attestation.bundle_url !== "string" ||
    typeof entry.attestation.initiator !== "string"
  ) {
    throw new Error("GitHub attestation metadata strings are invalid");
  }

  const result = entry.verificationResult;
  assertExactObject(
    result,
    [
      "mediaType",
      "signature",
      "statement",
      "verifiedIdentity",
      "verifiedTimestamps",
    ],
    "GitHub verification result",
  );
  if (result.mediaType !== GH_VERIFICATION_MEDIA_TYPE) {
    throw new Error("GitHub verification result media type mismatch");
  }
  assertExactObject(result.signature, ["certificate"], "GitHub signature");
  const certificate = result.signature.certificate;
  assertExactObject(
    certificate,
    GH_CERTIFICATE_KEYS,
    "GitHub verification certificate claims",
  );
  for (const key of GH_CERTIFICATE_KEYS) {
    assertNonemptyString(certificate[key], `GitHub certificate claim ${key}`);
  }
  const signerPrefix = `https://github.com/${TRUSTED_RELEASE_SET_REPOSITORY}/${TRUSTED_RELEASE_SET_WORKFLOW}@`;
  if (
    certificate.githubWorkflowRepository !== TRUSTED_RELEASE_SET_REPOSITORY ||
    certificate.buildSignerDigest !== TRUSTED_RELEASE_SET_WORKFLOW_SHA ||
    !certificate.buildSignerURI.startsWith(signerPrefix) ||
    certificate.subjectAlternativeName !== certificate.buildSignerURI ||
    certificate.sourceRepositoryURI !==
      `https://github.com/${TRUSTED_RELEASE_SET_REPOSITORY}` ||
    certificate.sourceRepositoryDigest !== sourceCommit ||
    certificate.sourceRepositoryRef !== sourceRef ||
    certificate.runnerEnvironment !== "github-hosted" ||
    certificate.issuer !== "https://token.actions.githubusercontent.com"
  ) {
    throw new Error("GitHub attestation certificate authority mismatch");
  }

  const statement = result.statement;
  assertExactObject(
    statement,
    ["_type", "predicate", "predicateType", "subject"],
    "GitHub attestation statement",
  );
  if (
    statement._type !== "https://in-toto.io/Statement/v1" ||
    statement.predicate === null ||
    typeof statement.predicate !== "object" ||
    Array.isArray(statement.predicate) ||
    typeof statement.predicateType !== "string" ||
    statement.predicateType.length === 0 ||
    !Array.isArray(statement.subject) ||
    statement.subject.length !== 1
  ) {
    throw new Error("GitHub attestation statement is invalid");
  }
  const subject = statement.subject[0];
  assertExactObject(subject, ["digest", "name"], "GitHub attestation subject");
  assertExactObject(subject.digest, ["sha256"], "GitHub subject digest");
  if (
    subject.name !== "release-set-approval.json" ||
    subject.digest.sha256 !== sha256(approvalText).slice("sha256:".length)
  ) {
    throw new Error("GitHub attestation subject digest mismatch");
  }

  const identity = result.verifiedIdentity;
  assertExactObject(
    identity,
    ["issuer", "subjectAlternativeName"],
    "GitHub verified identity",
  );
  assertExactObject(
    identity.issuer,
    ["issuer", "regexp"],
    "GitHub verified issuer",
  );
  assertExactObject(
    identity.subjectAlternativeName,
    ["regexp", "subjectAlternativeName"],
    "GitHub verified subject alternative name",
  );
  for (const value of [
    identity.issuer.issuer,
    identity.issuer.regexp,
    identity.subjectAlternativeName.subjectAlternativeName,
    identity.subjectAlternativeName.regexp,
  ]) {
    if (typeof value !== "string") {
      throw new Error("GitHub verified identity is invalid");
    }
  }
  if (
    !Array.isArray(result.verifiedTimestamps) ||
    result.verifiedTimestamps.length === 0
  ) {
    throw new Error("GitHub verified timestamps are missing");
  }
  for (const timestamp of result.verifiedTimestamps) {
    assertExactObject(
      timestamp,
      ["timestamp", "type", "uri"],
      "GitHub verified timestamp",
    );
    for (const key of ["timestamp", "type", "uri"]) {
      assertNonemptyString(timestamp[key], `GitHub timestamp ${key}`);
    }
  }
  return result;
}

export function verifyProductionReleaseSet({
  approvalPath,
  attestationBundlePath,
  componentEvidencePath,
  ghBinaryPath,
  manifestPath,
  repoRoot,
  sourceCommit,
  sourceRef,
}) {
  validateClaim(sourceCommit, sourceRef, TRUSTED_RELEASE_SET_WORKFLOW_SHA);
  verifyTrustedGhBinary(ghBinaryPath);
  const attestation = spawnSync(
    ghBinaryPath,
    [
      "attestation",
      "verify",
      approvalPath,
      "--bundle",
      attestationBundlePath,
      "--repo",
      TRUSTED_RELEASE_SET_REPOSITORY,
      "--signer-workflow",
      `${TRUSTED_RELEASE_SET_REPOSITORY}/${TRUSTED_RELEASE_SET_WORKFLOW}`,
      "--signer-digest",
      TRUSTED_RELEASE_SET_WORKFLOW_SHA,
      "--source-ref",
      sourceRef,
      "--source-digest",
      sourceCommit,
      "--deny-self-hosted-runners",
      "--format=json",
    ],
    {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    },
  );
  if (
    attestation.error ||
    attestation.status !== 0 ||
    attestation.signal !== null ||
    attestation.stderr !== ""
  ) {
    throw new Error("GitHub attestation verification failed");
  }

  const approvalText = readFileSync(approvalPath, "utf8");
  parseTrustedGhAttestationVerification({
    approvalText,
    output: attestation.stdout,
    sourceCommit,
    sourceRef,
  });
  const componentEvidenceText = readFileSync(componentEvidencePath, "utf8");
  const manifestText = readFileSync(manifestPath, "utf8");
  const approval = verifyReleaseSetApprovalBinding({
    approvalText,
    componentEvidenceText,
    manifestText,
    sourceCommit,
    sourceRef,
    trustedWorkflowSha: TRUSTED_RELEASE_SET_WORKFLOW_SHA,
  });
  const componentEvidence = parseCanonical(
    componentEvidenceText,
    "component evidence",
  );
  return verifyReleaseSet({
    componentEvidence,
    expectedManifestSha256: approval.manifestSha256,
    manifestText,
    repoRoot,
  });
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  if (!["create", "verify"].includes(command)) {
    throw new Error(
      "usage: release-set-approval.mjs <create|verify> [options]",
    );
  }
  const values = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];
    if (!option?.startsWith("--") || value === undefined) {
      throw new Error("invalid approval CLI option");
    }
    const key = option.slice(2);
    if (Object.hasOwn(values, key))
      throw new Error(`duplicate option: ${option}`);
    values[key] = value;
  }
  const required =
    command === "create"
      ? [
          "attester-workflow-sha",
          "input-directory",
          "output",
          "repo-root",
          "source-commit",
          "source-ref",
        ]
      : [
          "approval",
          "attestation-bundle",
          "evidence",
          "gh-binary",
          "manifest",
          "repo-root",
          "source-commit",
          "source-ref",
        ];
  for (const key of Object.keys(values)) {
    if (!required.includes(key)) throw new Error(`unknown option: --${key}`);
  }
  for (const key of required) {
    if (!values[key]) throw new Error(`--${key} is required`);
  }
  return { command, values };
}

function main(argv) {
  const { command, values } = parseArguments(argv);
  if (command === "create") {
    createReleaseSetApproval({
      attesterWorkflowSha: values["attester-workflow-sha"],
      inputDirectory: values["input-directory"],
      outputPath: values.output,
      repoRoot: values["repo-root"],
      sourceCommit: values["source-commit"],
      sourceRef: values["source-ref"],
    });
    process.stdout.write("release-set approval created\n");
    return;
  }
  verifyProductionReleaseSet({
    approvalPath: values.approval,
    attestationBundlePath: values["attestation-bundle"],
    componentEvidencePath: values.evidence,
    ghBinaryPath: values["gh-binary"],
    manifestPath: values.manifest,
    repoRoot: values["repo-root"],
    sourceCommit: values["source-commit"],
    sourceRef: values["source-ref"],
  });
  process.stdout.write("production approval verified\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
