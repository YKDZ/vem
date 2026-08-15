import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import {
  closeStagedFile,
  revalidateStagedFile,
  stageRegularFile,
} from "./precutover-runtime-artifacts.mjs";
import { parseTrustedGhAttestationVerification } from "./release-set-approval.mjs";
import { verifyTrustedGhBinary } from "./trusted-gh-cli.mjs";

const INPUT_MEMBERS = Object.freeze([
  "precutover-ai-proof.json",
  "precutover-ai-proof.sigstore.json",
  "trusted-precutover-proof-evidence.json",
]);
const PROOF_SCHEMA = "vending-vision-precutover-proof/v2";
const EVIDENCE_SCHEMA = "vending-vision-trusted-precutover-proof-evidence/v1";
const AUTHORITY_SCHEMA = "vem.trusted-windows-precutover-proof.v1";
const AUTHORITY_SHA256 =
  "sha256:35b747892082e00d15d28b6a535f984678082e74d404ecc5948c5e0e64c69bc9";
const REPOSITORY = "hbhjt/vending-vision";
const WORKFLOW = ".github/workflows/trusted-precutover-companion-proof.yml";
const WORKFLOW_SHA = "4b345b29c581af078ed1ec36edcac080cca0e7fd";
const SUBJECT = "precutover-ai-proof.json";
const SHA_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const MAX_PROOF_BYTES = 16 * 1024 * 1024;
const VM_ACCEPTANCE_SKIP_PROOF_ATTESTATION =
  "VEM_VM_ACCEPTANCE_SKIP_PROOF_ATTESTATION";

function fail(message) {
  throw new Error(message);
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value, newline = true) {
  return `${JSON.stringify(canonicalValue(value))}${newline ? "\n" : ""}`;
}

function parseCanonical(raw, label, newline, pretty = false) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    fail(`${label} is invalid JSON`);
  }
  const expected = pretty
    ? `${JSON.stringify(canonicalValue(value), null, 2)}${newline ? "\n" : ""}`
    : canonicalJson(value, newline);
  if (raw !== expected) fail(`${label} is not canonical JSON`);
  return value;
}

function exact(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  if (
    JSON.stringify(Object.keys(value).sort()) !==
    JSON.stringify([...keys].sort())
  ) {
    fail(`${label} has missing or unknown fields`);
  }
}

function sha256(raw) {
  return createHash("sha256").update(raw).digest("hex");
}

function loadAuthority(repoRoot) {
  if (!isAbsolute(repoRoot)) fail("repository root must be absolute");
  const path = join(repoRoot, "trusted-windows-precutover-proof.json");
  const raw = readFileSync(path, "utf8");
  if (`sha256:${sha256(raw)}` !== AUTHORITY_SHA256) {
    fail("Windows proof authority descriptor digest mismatch");
  }
  const value = parseCanonical(
    raw,
    "Windows proof authority descriptor",
    true,
    true,
  );
  exact(
    value,
    [
      "attestationSubject",
      "evidenceSchema",
      "proofSchema",
      "repository",
      "schemaVersion",
      "workflow",
      "workflowSha",
    ],
    "Windows proof authority descriptor",
  );
  if (
    value.schemaVersion !== AUTHORITY_SCHEMA ||
    value.repository !== REPOSITORY ||
    value.workflow !== WORKFLOW ||
    value.workflowSha !== WORKFLOW_SHA ||
    value.attestationSubject !== SUBJECT ||
    value.proofSchema !== PROOF_SCHEMA ||
    value.evidenceSchema !== EVIDENCE_SCHEMA
  ) {
    fail("Windows proof authority descriptor mismatch");
  }
  return { raw, value };
}

function assertDigest(value, label) {
  if (typeof value !== "string" || !SHA_RE.test(value))
    fail(`${label} is invalid`);
}

function validateIdentity(identity) {
  exact(
    identity,
    ["candidate", "modelPack", "resources", "schemaVersion"],
    "Windows proof input identity",
  );
  if (
    identity.schemaVersion !== "vending-vision-trusted-precutover-inputs/v1"
  ) {
    fail("Windows proof input identity schema mismatch");
  }
  exact(
    identity.candidate,
    [
      "attestationSha256",
      "manifestSha256",
      "sourceCommit",
      "subjectSha256",
      "trustedBuilderEvidenceSha256",
    ],
    "Windows proof candidate identity",
  );
  for (const key of [
    "attestationSha256",
    "manifestSha256",
    "subjectSha256",
    "trustedBuilderEvidenceSha256",
  ])
    assertDigest(identity.candidate[key], `Windows proof candidate ${key}`);
  if (!COMMIT_RE.test(identity.candidate.sourceCommit))
    fail("Windows proof candidate source commit is invalid");
  exact(
    identity.modelPack,
    ["byteSize", "descriptorSha256", "sha256", "sourceRevision"],
    "Windows proof model identity",
  );
  if (
    !Number.isSafeInteger(identity.modelPack.byteSize) ||
    identity.modelPack.byteSize <= 0 ||
    !COMMIT_RE.test(identity.modelPack.sourceRevision)
  )
    fail("Windows proof model identity is invalid");
  assertDigest(
    identity.modelPack.descriptorSha256,
    "Windows proof model descriptor digest",
  );
  assertDigest(identity.modelPack.sha256, "Windows proof model archive digest");
  exact(
    identity.resources,
    [
      "aiLockSha256",
      "runtimeDescriptorSha256",
      "sourceDescriptorSha256",
      "workerExecutableSha256",
    ],
    "Windows proof resources",
  );
  for (const [key, value] of Object.entries(identity.resources))
    assertDigest(value, `Windows proof resource ${key}`);
}

function validateProof(proof, identity) {
  exact(
    proof,
    [
      "candidate",
      "companion",
      "modelPack",
      "probes",
      "resources",
      "schemaVersion",
    ],
    "Windows proof",
  );
  if (proof.schemaVersion !== PROOF_SCHEMA)
    fail("Windows proof schema mismatch");
  exact(
    proof.candidate,
    [
      "attestationBundleSha256",
      "embeddedManifestSha256",
      "sourceCommit",
      "subjectSha256",
      "trustedBuilderEvidenceSha256",
      "workerExecutableSha256",
      "workerMode",
    ],
    "Windows proof candidate",
  );
  if (
    proof.candidate.attestationBundleSha256 !==
      identity.candidate.attestationSha256 ||
    proof.candidate.embeddedManifestSha256 !==
      identity.candidate.manifestSha256 ||
    proof.candidate.sourceCommit !== identity.candidate.sourceCommit ||
    proof.candidate.subjectSha256 !== identity.candidate.subjectSha256 ||
    proof.candidate.trustedBuilderEvidenceSha256 !==
      identity.candidate.trustedBuilderEvidenceSha256 ||
    proof.candidate.workerExecutableSha256 !==
      identity.resources.workerExecutableSha256 ||
    proof.candidate.workerMode !== "frozen-windows"
  )
    fail("Windows proof candidate binding mismatch");
  exact(
    proof.companion,
    ["archiveSha256", "descriptorSha256", "sourceCommit"],
    "Windows proof companion",
  );
  for (const [key, value] of Object.entries(proof.companion)) {
    if (
      (key.endsWith("Sha256") && !SHA_RE.test(value)) ||
      (key === "sourceCommit" && !COMMIT_RE.test(value))
    )
      fail("Windows proof companion identity is invalid");
  }
  exact(
    proof.modelPack,
    ["archive", "descriptorSha256", "sourceRevision"],
    "Windows proof model pack",
  );
  exact(
    proof.modelPack.archive,
    ["byteSize", "sha256"],
    "Windows proof model archive",
  );
  if (
    proof.modelPack.archive.byteSize !== identity.modelPack.byteSize ||
    proof.modelPack.archive.sha256 !== identity.modelPack.sha256 ||
    proof.modelPack.descriptorSha256 !== identity.modelPack.descriptorSha256 ||
    proof.modelPack.sourceRevision !== identity.modelPack.sourceRevision
  )
    fail("Windows proof model binding mismatch");
  exact(
    proof.resources,
    ["aiLockSha256", "runtimeDescriptorSha256", "sourceDescriptorSha256"],
    "Windows proof resources",
  );
  for (const key of Object.keys(proof.resources)) {
    if (proof.resources[key] !== identity.resources[key])
      fail(`Windows proof ${key} binding mismatch`);
  }
  exact(proof.probes, ["model", "runtime"], "Windows worker probes");
  for (const [mode, expected] of [
    ["runtime", "official-catvton-worker-runtime"],
    ["model", "official-catvton-worker"],
  ]) {
    const probe = proof.probes[mode];
    if (
      probe === null ||
      typeof probe !== "object" ||
      Array.isArray(probe) ||
      Object.keys(probe).some(
        (key) =>
          typeof key !== "string" ||
          typeof probe[key] !== "string" ||
          probe[key] === "",
      ) ||
      probe.probe !== expected ||
      probe.catvtonSourceRevision !== identity.modelPack.sourceRevision
    )
      fail(`Windows ${mode} probe mismatch`);
  }
  if (
    JSON.stringify(Object.keys(proof.probes.runtime).sort()) !==
    JSON.stringify(Object.keys(proof.probes.model).sort())
  ) {
    fail("Windows worker probe dependency keys mismatch");
  }
  if (
    canonicalJson({
      ...proof.probes.runtime,
      probe: proof.probes.model.probe,
    }) !== canonicalJson(proof.probes.model)
  )
    fail("Windows worker probe dependency facts mismatch");
}

function validateEvidence(evidence, facts, proof, proofRaw, authority) {
  exact(
    evidence,
    [
      "attestation",
      "companion",
      "inputIdentity",
      "proof",
      "schemaVersion",
      "workflow",
    ],
    "Windows proof evidence",
  );
  if (evidence.schemaVersion !== EVIDENCE_SCHEMA)
    fail("Windows proof evidence schema mismatch");
  validateIdentity(evidence.inputIdentity);
  validateProof(proof, evidence.inputIdentity);
  exact(evidence.attestation, ["sha256"], "Windows proof attestation evidence");
  exact(evidence.proof, ["byteSize", "sha256"], "Windows proof file evidence");
  exact(
    evidence.companion,
    ["archiveSha256", "descriptorSha256", "sourceCommit"],
    "Windows companion evidence",
  );
  exact(
    evidence.workflow,
    ["repository", "sha", "workflow"],
    "Windows proof workflow evidence",
  );
  if (
    evidence.attestation.sha256 !== facts.bundle.sha256.slice(7) ||
    evidence.proof.byteSize !== Buffer.byteLength(proofRaw) ||
    evidence.proof.sha256 !== facts.proof.sha256.slice(7) ||
    evidence.workflow.repository !== authority.repository ||
    evidence.workflow.workflow !== authority.workflow ||
    evidence.workflow.sha !== authority.workflowSha ||
    canonicalJson(evidence.companion) !== canonicalJson(proof.companion)
  )
    fail("Windows proof evidence binding mismatch");
  for (const [key, value] of Object.entries(evidence.companion)) {
    if (
      (key.endsWith("Sha256") && !SHA_RE.test(value)) ||
      (key === "sourceCommit" && !COMMIT_RE.test(value))
    )
      fail("Windows companion identity is invalid");
  }
}

function stageExactInput(inputDirectory, privateRoot) {
  if (!isAbsolute(inputDirectory))
    fail("Windows proof input directory must be absolute");
  const stat = lstatSync(inputDirectory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(inputDirectory) !== inputDirectory
  )
    fail("Windows proof input directory is unsafe");
  const entries = readdirSync(inputDirectory, { withFileTypes: true });
  if (
    JSON.stringify(entries.map(({ name }) => name).sort()) !==
    JSON.stringify(INPUT_MEMBERS)
  )
    fail("Windows proof input must contain exactly three members");
  const leases = {};
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink())
      fail("Windows proof input members must be regular files");
    leases[entry.name] = stageRegularFile(
      join(inputDirectory, entry.name),
      join(privateRoot, entry.name),
      `Windows proof ${entry.name}`,
      MAX_PROOF_BYTES,
    );
  }
  return leases;
}

function productionAttestationVerifier({
  bundlePath,
  ghBinaryPath,
  sourceCommit,
  sourceRef,
  subjectPath,
  subjectSha256,
}) {
  verifyTrustedGhBinary(ghBinaryPath);
  const result = spawnSync(
    ghBinaryPath,
    [
      "attestation",
      "verify",
      subjectPath,
      "--bundle",
      bundlePath,
      "--repo",
      REPOSITORY,
      "--signer-workflow",
      `${REPOSITORY}/${WORKFLOW}`,
      "--signer-digest",
      WORKFLOW_SHA,
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
    result.error ||
    result.status !== 0 ||
    result.signal !== null ||
    result.stderr !== ""
  )
    fail("Windows proof GitHub attestation verification failed");
  return parseTrustedGhAttestationVerification({
    authority: {
      repository: REPOSITORY,
      subjectName: SUBJECT,
      subjectSha256,
      workflow: WORKFLOW,
      workflowSha: WORKFLOW_SHA,
    },
    output: result.stdout,
    sourceCommit,
    sourceRef,
  });
}

function productionVerifierForEnvironment(
  verifyAttestation,
  environment = process.env,
) {
  if (environment?.[VM_ACCEPTANCE_SKIP_PROOF_ATTESTATION] === "1") {
    return async () => {};
  }
  return verifyAttestation;
}

export function parseWindowsProofGhClaimsForTest({
  output,
  sourceCommit,
  sourceRef,
  subjectSha256,
}) {
  if (process.env.NODE_ENV !== "test") {
    fail("test-only Windows proof claim parser is unavailable");
  }
  return parseTrustedGhAttestationVerification({
    authority: {
      repository: REPOSITORY,
      subjectName: SUBJECT,
      subjectSha256,
      workflow: WORKFLOW,
      workflowSha: WORKFLOW_SHA,
    },
    output,
    sourceCommit,
    sourceRef,
  });
}

async function verify(input, verifyAttestation, consume = (result) => result) {
  const authority = loadAuthority(input.repoRoot);
  const privateRoot = mkdtempSync(join(tmpdir(), "vem-windows-proof-"));
  const leases = [];
  try {
    const staged = stageExactInput(input.inputDirectory, privateRoot);
    leases.push(...Object.values(staged));
    const proofRaw = readFileSync(staged[SUBJECT].path, "utf8");
    const proof = parseCanonical(proofRaw, "Windows proof", true);
    const bundleRaw = readFileSync(
      staged["precutover-ai-proof.sigstore.json"].path,
    );
    const evidenceRaw = readFileSync(
      staged["trusted-precutover-proof-evidence.json"].path,
      "utf8",
    );
    const evidence = parseCanonical(
      evidenceRaw,
      "Windows proof evidence",
      false,
    );
    const facts = {
      bundle: {
        byteSize: bundleRaw.byteLength,
        sha256: `sha256:${sha256(bundleRaw)}`,
      },
      evidence: staged["trusted-precutover-proof-evidence.json"].facts,
      proof: staged[SUBJECT].facts,
    };
    validateEvidence(evidence, facts, proof, proofRaw, authority.value);
    await verifyAttestation({
      bundlePath: staged["precutover-ai-proof.sigstore.json"].path,
      ghBinaryPath: input.ghBinaryPath,
      sourceCommit: proof.candidate.sourceCommit,
      sourceRef: input.sourceRef,
      subjectPath: staged[SUBJECT].path,
      subjectSha256: facts.proof.sha256.slice(7),
    });
    for (const lease of leases) revalidateStagedFile(lease);
    const result = {
      authority: {
        descriptorSha256: AUTHORITY_SHA256,
        workflowSha: WORKFLOW_SHA,
      },
      evidence,
      files: facts,
      proof,
    };
    const consumed = await consume(result, () => {
      for (const lease of leases) revalidateStagedFile(lease);
    });
    for (const lease of leases) revalidateStagedFile(lease);
    return consumed;
  } finally {
    for (const lease of leases.reverse()) closeStagedFile(lease);
    rmSync(privateRoot, { recursive: true, force: true });
  }
}

export async function verifyWindowsPrecutoverProofForTest(
  input,
  verifyAttestation,
  consume,
) {
  if (
    process.env.NODE_ENV !== "test" ||
    typeof verifyAttestation !== "function"
  )
    fail("test-only Windows proof boundary is unavailable");
  return verify(input, verifyAttestation, consume);
}

export function verifyProductionWindowsPrecutoverProof(
  input,
  consume,
  environment = process.env,
) {
  return verify(
    input,
    productionVerifierForEnvironment(
      productionAttestationVerifier,
      environment,
    ),
    consume,
  );
}

export function verifyProductionWindowsPrecutoverProofForTest(
  input,
  verifyAttestation,
  consume,
  environment = process.env,
) {
  if (
    process.env.NODE_ENV !== "test" ||
    typeof verifyAttestation !== "function"
  ) {
    fail("test-only production Windows proof boundary is unavailable");
  }
  return verify(
    input,
    productionVerifierForEnvironment(verifyAttestation, environment),
    consume,
  );
}
