import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  linkSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { reproveDatabaseBackup } from "./precutover-database-backup.mjs";
import { collectManagedMediaReceipt } from "./precutover-managed-media.mjs";
import {
  canonicalJson as canonicalReceiptJson,
  deriveManagedMediaEvidence,
  derivePrecutoverEvidence,
} from "./precutover-receipts.mjs";
import { verifyReleaseSet } from "./release-set.mjs";
import { verifyTrustedGhBinary } from "./trusted-gh-cli.mjs";

export const TRUSTED_RELEASE_SET_REPOSITORY = "YKDZ/vem";
export const TRUSTED_RELEASE_SET_WORKFLOW =
  ".github/workflows/trusted-release-set-attester.yml";
export const TRUSTED_RELEASE_SET_WORKFLOW_SHA =
  "54f30f648f07c8bf5bc639f4ca2ba8f5a3d85981";
const APPROVAL_SCHEMA = "vem.release-set.approval.v1";
const EVIDENCE_SCHEMA = "vem.release-set.component-evidence.v1";
const COMMIT_RE = /^[a-f0-9]{40}$/;
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const SOURCE_REF_RE =
  /^refs\/tags\/v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rc\.[0-9A-Za-z.-]+$/;
const INPUT_MEMBERS = [
  "component-evidence.json",
  "database-backup-receipt.json",
  "managed-media-receipt.json",
  "release-set.json",
];
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
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error("release-set input artifact root must be a real directory");
  }
  const entries = readdirSync(directory, { withFileTypes: true });
  if (
    JSON.stringify(entries.map((entry) => entry.name).sort()) !==
    JSON.stringify(INPUT_MEMBERS)
  ) {
    throw new Error(
      "release-set input artifact must contain exactly four members",
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

function writeExclusiveAtomic(path, contents, label) {
  const parent = dirname(path);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw new Error(`${label} parent is unsafe`);
  }
  const staging = join(
    parent,
    `.${process.pid}-${randomBytes(8).toString("hex")}.${label}.tmp`,
  );
  try {
    writeFileSync(staging, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    linkSync(staging, path);
    rmSync(staging);
  } finally {
    rmSync(staging, { force: true });
  }
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
  const databaseReceiptText = input["database-backup-receipt.json"];
  const managedMediaReceiptText = input["managed-media-receipt.json"];
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
  const precutover = derivePrecutoverEvidence(
    databaseReceiptText,
    managedMediaReceiptText,
  );
  if (
    canonicalReceiptJson(componentEvidence.precutover) !==
    canonicalReceiptJson(precutover)
  ) {
    throw new Error(
      "pending precutover receipts do not match component evidence",
    );
  }
  const manifestSha256 = sha256(manifestText);
  verifyReleaseSet({
    componentEvidence,
    expectedManifestSha256: manifestSha256,
    manifestText,
    repoRoot,
  });
  const members = Object.fromEntries(
    INPUT_MEMBERS.map((name) => [name, sha256(input[name])]),
  );
  const approvalText = canonicalJson({
    attester: {
      hostedRunnerRequired: true,
      repository: TRUSTED_RELEASE_SET_REPOSITORY,
      workflow: TRUSTED_RELEASE_SET_WORKFLOW,
      workflowSha: attesterWorkflowSha,
    },
    inputArtifact: {
      aggregateSha256: sha256(canonicalJson(members)),
      members,
    },
    schemaVersion: APPROVAL_SCHEMA,
    sourceCommit,
    sourceRef,
  });
  writeExclusiveAtomic(outputPath, approvalText, "release-set-approval");
  return JSON.parse(approvalText);
}

export function verifyReleaseSetApprovalBinding({
  approvalText,
  componentEvidenceText,
  databaseReceiptText,
  managedMediaReceiptText,
  manifestText,
  sourceCommit,
  sourceRef,
  trustedWorkflowSha,
}) {
  validateClaim(sourceCommit, sourceRef, trustedWorkflowSha);
  const approval = parseCanonical(approvalText, "release-set approval");
  assertExactObject(
    approval,
    ["attester", "inputArtifact", "schemaVersion", "sourceCommit", "sourceRef"],
    "release-set approval",
  );
  assertExactObject(
    approval.attester,
    ["hostedRunnerRequired", "repository", "workflow", "workflowSha"],
    "release-set approval attester",
  );
  assertExactObject(
    approval.inputArtifact,
    ["aggregateSha256", "members"],
    "release-set approval input artifact",
  );
  assertExactObject(
    approval.inputArtifact.members,
    INPUT_MEMBERS,
    "release-set approval input members",
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
  const input = {
    "component-evidence.json": componentEvidenceText,
    "database-backup-receipt.json": databaseReceiptText,
    "managed-media-receipt.json": managedMediaReceiptText,
    "release-set.json": manifestText,
  };
  const expectedMembers = Object.fromEntries(
    INPUT_MEMBERS.map((name) => [name, sha256(input[name])]),
  );
  if (
    Object.values(approval.inputArtifact.members).some(
      (value) => !DIGEST_RE.test(value),
    ) ||
    canonicalJson(approval.inputArtifact.members) !==
      canonicalJson(expectedMembers) ||
    approval.inputArtifact.aggregateSha256 !==
      sha256(canonicalJson(expectedMembers))
  ) {
    throw new Error("release-set approval payload digest mismatch");
  }
  const componentEvidence = parseCanonical(
    componentEvidenceText,
    "component evidence",
  );
  const precutover = derivePrecutoverEvidence(
    databaseReceiptText,
    managedMediaReceiptText,
  );
  if (
    canonicalReceiptJson(componentEvidence.precutover) !==
    canonicalReceiptJson(precutover)
  ) {
    throw new Error("release-set approval precutover payload mismatch");
  }
  return approval;
}

export function verifyLiveManagedMediaReproof(expected, liveReceiptText) {
  assertExactObject(
    expected,
    ["assetCount", "assetsSetSha256", "generation", "receiptSha256"],
    "approved managed-media evidence",
  );
  const live = deriveManagedMediaEvidence(liveReceiptText);
  for (const key of ["assetCount", "assetsSetSha256", "generation"]) {
    if (live[key] !== expected[key]) {
      throw new Error(`live managed-media ${key} differs from the approval`);
    }
  }
  return live;
}

export function validateApprovedPrecutoverReceiptText(raw) {
  const receipt = parseCanonical(raw, "approved precutover receipt");
  assertExactObject(
    receipt,
    [
      "database",
      "managedMedia",
      "releaseApprovalSha256",
      "releaseSetSha256",
      "schemaVersion",
      "sourceCommit",
      "sourceRef",
    ],
    "approved precutover receipt",
  );
  assertExactObject(
    receipt.database,
    ["backup", "catalogDataSha256", "receiptSha256"],
    "approved precutover database",
  );
  assertExactObject(
    receipt.database.backup,
    ["byteSize", "format", "sha256"],
    "approved precutover database backup",
  );
  assertExactObject(
    receipt.managedMedia,
    [
      "assetCount",
      "assetsSetSha256",
      "generation",
      "liveProofSha256",
      "receiptSha256",
    ],
    "approved precutover managed media",
  );
  if (
    receipt.schemaVersion !== "vem.precutover.approved.v1" ||
    !COMMIT_RE.test(receipt.sourceCommit) ||
    !SOURCE_REF_RE.test(receipt.sourceRef) ||
    receipt.database.backup.format !== "postgresql-custom" ||
    !Number.isSafeInteger(receipt.database.backup.byteSize) ||
    receipt.database.backup.byteSize <= 0 ||
    !Number.isSafeInteger(receipt.managedMedia.assetCount) ||
    receipt.managedMedia.assetCount < 0 ||
    typeof receipt.managedMedia.generation !== "string" ||
    receipt.managedMedia.generation.length === 0 ||
    receipt.managedMedia.generation.length > 128
  ) {
    throw new Error("approved precutover receipt identity is invalid");
  }
  for (const digest of [
    receipt.database.backup.sha256,
    receipt.database.catalogDataSha256,
    receipt.database.receiptSha256,
    receipt.managedMedia.assetsSetSha256,
    receipt.managedMedia.liveProofSha256,
    receipt.managedMedia.receiptSha256,
    receipt.releaseApprovalSha256,
    receipt.releaseSetSha256,
  ]) {
    if (!DIGEST_RE.test(digest)) {
      throw new Error("approved precutover receipt digest is invalid");
    }
  }
  return receipt;
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

export async function verifyProductionReleaseSet({
  approvalPath,
  attestationBundlePath,
  backupPath,
  container,
  dockerBinary,
  expectedDockerByteSize,
  expectedDockerSha256,
  expectedDockerVersion,
  ghBinaryPath,
  inputDirectory,
  managedMediaOrigin,
  managedMediaToken,
  outputPath,
  repoRoot,
  sourceCommit,
  sourceRef,
  sourceUser,
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
  const input = readExactInput(inputDirectory);
  const componentEvidenceText = input["component-evidence.json"];
  const databaseReceiptText = input["database-backup-receipt.json"];
  const managedMediaReceiptText = input["managed-media-receipt.json"];
  const manifestText = input["release-set.json"];
  const approval = verifyReleaseSetApprovalBinding({
    approvalText,
    componentEvidenceText,
    databaseReceiptText,
    managedMediaReceiptText,
    manifestText,
    sourceCommit,
    sourceRef,
    trustedWorkflowSha: TRUSTED_RELEASE_SET_WORKFLOW_SHA,
  });
  const componentEvidence = parseCanonical(
    componentEvidenceText,
    "component evidence",
  );
  const manifest = verifyReleaseSet({
    componentEvidence,
    expectedManifestSha256: approval.inputArtifact.members["release-set.json"],
    manifestText,
    repoRoot,
  });
  const databaseProof = await reproveDatabaseBackup({
    backupPath,
    container,
    dockerBinary,
    expectedDockerByteSize,
    expectedDockerSha256,
    expectedDockerVersion,
    receiptText: databaseReceiptText,
    repoRoot,
    sourceUser,
  });
  const liveMedia = await collectManagedMediaReceipt({
    origin: managedMediaOrigin,
    token: managedMediaToken,
  });
  const liveMediaFacts = verifyLiveManagedMediaReproof(
    componentEvidence.precutover.managedMedia,
    liveMedia.text,
  );
  const approvedText = canonicalJson({
    database: {
      backup: databaseProof.backup,
      catalogDataSha256: databaseProof.catalogData.sha256,
      receiptSha256:
        approval.inputArtifact.members["database-backup-receipt.json"],
    },
    managedMedia: {
      assetCount: liveMediaFacts.assetCount,
      assetsSetSha256: liveMediaFacts.assetsSetSha256,
      generation: liveMediaFacts.generation,
      liveProofSha256: sha256(liveMedia.text),
      receiptSha256:
        approval.inputArtifact.members["managed-media-receipt.json"],
    },
    releaseApprovalSha256: sha256(approvalText),
    releaseSetSha256: approval.inputArtifact.members["release-set.json"],
    schemaVersion: "vem.precutover.approved.v1",
    sourceCommit,
    sourceRef,
  });
  validateApprovedPrecutoverReceiptText(approvedText);
  writeExclusiveAtomic(outputPath, approvedText, "approved-precutover");
  return { approval, manifest, receipt: JSON.parse(approvedText) };
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
          "database-backup",
          "docker-binary",
          "expected-docker-byte-size",
          "expected-docker-sha256",
          "expected-docker-version",
          "gh-binary",
          "input-directory",
          "managed-media-origin",
          "managed-media-token",
          "output",
          "postgres-container",
          "postgres-user",
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

async function main(argv) {
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
  await verifyProductionReleaseSet({
    approvalPath: values.approval,
    attestationBundlePath: values["attestation-bundle"],
    backupPath: values["database-backup"],
    container: values["postgres-container"],
    dockerBinary: values["docker-binary"],
    expectedDockerByteSize: values["expected-docker-byte-size"],
    expectedDockerSha256: values["expected-docker-sha256"],
    expectedDockerVersion: values["expected-docker-version"],
    ghBinaryPath: values["gh-binary"],
    inputDirectory: values["input-directory"],
    managedMediaOrigin: values["managed-media-origin"],
    managedMediaToken: values["managed-media-token"],
    outputPath: values.output,
    repoRoot: values["repo-root"],
    sourceCommit: values["source-commit"],
    sourceRef: values["source-ref"],
    sourceUser: values["postgres-user"],
  });
  process.stdout.write("production approval verified\n");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
