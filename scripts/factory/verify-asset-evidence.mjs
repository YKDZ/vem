import { execFile } from "node:child_process";
import {
  createHash,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { canonicalJson } from "./factory-manifest.mjs";

const DIGEST = /^sha256:([a-f0-9]{64})$/;
const EVIDENCE_IDENTITY = /^factory-evidence:\/\/sha256\/([a-f0-9]{64})$/;
const MAX_EVIDENCE_BYTES = 1024 * 1024;
const run = promisify(execFile);

function exactKeys(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const expected = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`${label}.${key} is unknown`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key))
      throw new Error(`${label}.${key} is required`);
  }
}

function publicIdentity(publicKeyDer) {
  return `spki-sha256:${createHash("sha256").update(publicKeyDer).digest("hex")}`;
}

function evidenceReference(evidence) {
  const bytes = Buffer.from(canonicalJson(evidence));
  const hash = createHash("sha256").update(bytes).digest("hex");
  return {
    identity: `factory-evidence://sha256/${hash}`,
    digest: `sha256:${hash}`,
    bytes,
  };
}

export function createSignedAssetEvidence({
  assetDigest,
  privateKey,
  sourceIdentity,
  builderIdentity,
  buildId,
}) {
  if (!DIGEST.test(assetDigest ?? ""))
    throw new Error("assetDigest is invalid");
  const publicKey = createPublicKey(privateKey);
  const publicKeyDer = publicKey.export({ type: "spki", format: "der" });
  const signerIdentity = publicIdentity(publicKeyDer);
  const signer = {
    identity: signerIdentity,
    publicKey: publicKeyDer.toString("base64"),
  };
  const signatureStatement = { subject: { digest: assetDigest } };
  const signatureEvidence = {
    schemaVersion: "vem-detached-signature/v1",
    kind: "detached-ed25519-signature",
    statement: signatureStatement,
    signer,
    signature: signBytes(
      null,
      Buffer.from(canonicalJson(signatureStatement)),
      privateKey,
    ).toString("base64"),
  };
  const signatureReference = evidenceReference(signatureEvidence);

  const provenanceStatement = {
    subject: { digest: assetDigest },
    predicateType: "https://slsa.dev/provenance/v1",
    sourceIdentity,
    builderIdentity,
    buildId,
  };
  const provenanceEvidence = {
    schemaVersion: "vem-provenance-attestation/v1",
    kind: "signed-ed25519-provenance",
    statement: provenanceStatement,
    signer,
    signature: signBytes(
      null,
      Buffer.from(canonicalJson(provenanceStatement)),
      privateKey,
    ).toString("base64"),
  };
  const provenanceReference = evidenceReference(provenanceEvidence);

  return {
    signature: {
      scheme: "detached-ed25519",
      signerIdentity,
      evidenceIdentity: signatureReference.identity,
      evidenceDigest: signatureReference.digest,
    },
    provenance: {
      predicateType: provenanceStatement.predicateType,
      sourceIdentity,
      builderIdentity,
      buildId,
      signerIdentity,
      evidenceIdentity: provenanceReference.identity,
      evidenceDigest: provenanceReference.digest,
    },
    evidence: [signatureReference, provenanceReference],
  };
}

async function readEvidence(root, identity, digest, label) {
  const identityMatch = EVIDENCE_IDENTITY.exec(identity ?? "");
  const digestMatch = DIGEST.exec(digest ?? "");
  if (!identityMatch || !digestMatch || identityMatch[1] !== digestMatch[1]) {
    throw new Error(`${label} evidence identity/digest mismatch`);
  }
  let handle;
  try {
    handle = await open(
      join(root, "sha256", identityMatch[1]),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if (error?.code === "ELOOP")
      throw new Error(`${label} evidence must not be a symlink`);
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (
      !fileStat.isFile() ||
      fileStat.size < 2 ||
      fileStat.size > MAX_EVIDENCE_BYTES
    ) {
      throw new Error(`${label} evidence must be a bounded regular file`);
    }
    const bytes = Buffer.alloc(fileStat.size);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    if (read.bytesRead !== bytes.length)
      throw new Error(`${label} evidence read was incomplete`);
    const actual = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actual !== digest) throw new Error(`${label} evidence digest mismatch`);
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    await handle.close();
  }
}

function verifySignedEvidence({
  evidence,
  statementKeys,
  expected,
  approvals,
  label,
}) {
  exactKeys(
    evidence,
    ["schemaVersion", "kind", "statement", "signer", "signature"],
    `${label} evidence`,
  );
  exactKeys(evidence.statement, statementKeys, `${label} statement`);
  exactKeys(evidence.statement.subject, ["digest"], `${label} subject`);
  exactKeys(evidence.signer, ["identity", "publicKey"], `${label} signer`);
  const publicKeyDer = Buffer.from(evidence.signer.publicKey, "base64");
  const actualSignerIdentity = publicIdentity(publicKeyDer);
  if (evidence.signer.identity !== actualSignerIdentity) {
    throw new Error(`${label} signer identity does not match public key`);
  }
  if (!approvals.has(actualSignerIdentity)) {
    throw new Error(`${label} does not use an approved signer identity`);
  }
  const publicKey = createPublicKey({
    key: publicKeyDer,
    type: "spki",
    format: "der",
  });
  if (
    !verifyBytes(
      null,
      Buffer.from(canonicalJson(evidence.statement)),
      publicKey,
      Buffer.from(evidence.signature, "base64"),
    )
  ) {
    throw new Error(`${label} signature verification failed`);
  }
  for (const [key, value] of Object.entries(expected)) {
    const actual =
      key === "digest"
        ? evidence.statement.subject.digest
        : evidence.statement[key];
    if (actual !== value)
      throw new Error(`${label} ${key} does not match manifest claim`);
  }
  return actualSignerIdentity;
}

export async function verifyAssetEvidence({
  asset,
  evidenceStoreRoot,
  approvalPolicy,
  authenticodeVerification,
}) {
  exactKeys(
    approvalPolicy,
    ["signerIdentities", "builderIdentities", "authenticodeSignerIdentities"],
    "approval policy",
  );
  for (const key of ["signerIdentities", "builderIdentities"]) {
    if (
      !Array.isArray(approvalPolicy[key]) ||
      approvalPolicy[key].length === 0 ||
      approvalPolicy[key].some(
        (identity) => typeof identity !== "string" || identity.length === 0,
      )
    ) {
      throw new Error(
        `approval policy ${key} must be a non-empty identity list`,
      );
    }
  }
  const approvedSigners = new Set(approvalPolicy?.signerIdentities ?? []);
  const approvedBuilders = new Set(approvalPolicy?.builderIdentities ?? []);
  if (approvedSigners.size === 0 || approvedBuilders.size === 0) {
    throw new Error("signature and builder approval policy is required");
  }
  let verifiedSignature;
  if (asset.signature?.scheme === "detached-ed25519") {
    const signatureEvidence = await readEvidence(
      evidenceStoreRoot,
      asset.signature.evidenceIdentity,
      asset.signature.evidenceDigest,
      "asset signature",
    );
    if (
      signatureEvidence.schemaVersion !== "vem-detached-signature/v1" ||
      signatureEvidence.kind !== "detached-ed25519-signature"
    ) {
      throw new Error("asset signature evidence contract is invalid");
    }
    const signatureSigner = verifySignedEvidence({
      evidence: signatureEvidence,
      statementKeys: ["subject"],
      expected: { digest: asset.digest },
      approvals: approvedSigners,
      label: "asset signature",
    });
    if (asset.signature.signerIdentity !== signatureSigner) {
      throw new Error("asset signature signer does not match manifest claim");
    }
    verifiedSignature = {
      scheme: asset.signature.scheme,
      signerIdentity: signatureSigner,
      evidenceIdentity: asset.signature.evidenceIdentity,
      evidenceDigest: asset.signature.evidenceDigest,
      verified: true,
    };
  } else if (asset.signature?.scheme === "authenticode") {
    if (
      !authenticodeVerification?.verified ||
      authenticodeVerification.signerIdentity !==
        asset.signature.signerIdentity ||
      authenticodeVerification.evidenceIdentity !== asset.identity ||
      authenticodeVerification.evidenceDigest !== asset.digest
    ) {
      throw new Error(
        "AuthentiCode verification does not match manifest evidence",
      );
    }
    verifiedSignature = structuredClone(authenticodeVerification);
  } else {
    throw new Error("asset signature scheme is not executable");
  }

  const provenanceEvidence = await readEvidence(
    evidenceStoreRoot,
    asset.provenance.evidenceIdentity,
    asset.provenance.evidenceDigest,
    "asset provenance",
  );
  if (
    provenanceEvidence.schemaVersion !== "vem-provenance-attestation/v1" ||
    provenanceEvidence.kind !== "signed-ed25519-provenance"
  ) {
    throw new Error("asset provenance evidence contract is invalid");
  }
  const provenanceSigner = verifySignedEvidence({
    evidence: provenanceEvidence,
    statementKeys: [
      "subject",
      "predicateType",
      "sourceIdentity",
      "builderIdentity",
      "buildId",
    ],
    expected: {
      digest: asset.digest,
      predicateType: asset.provenance.predicateType,
      sourceIdentity: asset.provenance.sourceIdentity,
      builderIdentity: asset.provenance.builderIdentity,
      buildId: asset.provenance.buildId,
    },
    approvals: approvedSigners,
    label: "asset provenance",
  });
  if (asset.provenance.signerIdentity !== provenanceSigner) {
    throw new Error("asset provenance signer does not match manifest claim");
  }
  if (!approvedBuilders.has(asset.provenance.builderIdentity)) {
    throw new Error(
      "asset provenance does not use an approved builder identity",
    );
  }
  return {
    signature: verifiedSignature,
    provenance: {
      predicateType: asset.provenance.predicateType,
      sourceIdentity: asset.provenance.sourceIdentity,
      builderIdentity: asset.provenance.builderIdentity,
      buildId: asset.provenance.buildId,
      signerIdentity: provenanceSigner,
      evidenceIdentity: asset.provenance.evidenceIdentity,
      evidenceDigest: asset.provenance.evidenceDigest,
      verified: true,
    },
  };
}

export async function verifyAuthenticodeSignature({
  asset,
  assetPath,
  verifierPath,
  verifierDigest,
  caBundlePath,
  approvedSignerIdentities,
}) {
  const match = /^x509-sha256:([a-f0-9]{64})$/.exec(
    asset.signature?.signerIdentity ?? "",
  );
  if (!match)
    throw new Error("AuthentiCode signer identity must be x509-sha256");
  if (!approvedSignerIdentities.includes(asset.signature.signerIdentity)) {
    throw new Error("AuthentiCode signature does not use an approved signer");
  }
  if (
    asset.signature.evidenceIdentity !== asset.identity ||
    asset.signature.evidenceDigest !== asset.digest
  ) {
    throw new Error(
      "AuthentiCode embedded evidence must be bound to asset bytes",
    );
  }
  const readRegularBytes = async (path, label, executable = false) => {
    let handle;
    try {
      handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      if (error?.code === "ELOOP")
        throw new Error(`${label} must not be a symlink`);
      throw error;
    }
    try {
      const fileStat = await handle.stat();
      if (
        !fileStat.isFile() ||
        fileStat.size < 1 ||
        (executable && (fileStat.mode & 0o111) === 0)
      ) {
        throw new Error(
          `${label} must be a regular ${executable ? "executable " : ""}file`,
        );
      }
      const bytes = Buffer.alloc(fileStat.size);
      const read = await handle.read(bytes, 0, bytes.length, 0);
      if (read.bytesRead !== bytes.length)
        throw new Error(`${label} read was incomplete`);
      return bytes;
    } finally {
      await handle.close();
    }
  };
  const verifierBytes = await readRegularBytes(
    verifierPath,
    "AuthentiCode verifier",
    true,
  );
  const caBundleBytes = await readRegularBytes(
    caBundlePath,
    "AuthentiCode CA bundle",
  );
  const actualVerifierDigest = `sha256:${createHash("sha256")
    .update(verifierBytes)
    .digest("hex")}`;
  if (actualVerifierDigest !== verifierDigest) {
    throw new Error("AuthentiCode verifier digest mismatch");
  }
  const workDirectory = await mkdtemp(join(tmpdir(), "vem-authenticode-"));
  try {
    const executable = join(workDirectory, "osslsigncode");
    const caBundle = join(workDirectory, "approved-ca.pem");
    await writeFile(executable, verifierBytes, { mode: 0o555 });
    await writeFile(caBundle, caBundleBytes, { mode: 0o444 });
    await run(
      executable,
      [
        "verify",
        "-in",
        assetPath,
        "-CAfile",
        caBundle,
        "-require-leaf-hash",
        `sha256:${match[1]}`,
      ],
      {
        env: { PATH: "/usr/bin:/bin", HOME: workDirectory, LC_ALL: "C" },
        maxBuffer: 1024 * 1024,
      },
    );
  } catch (error) {
    throw new Error(
      `AuthentiCode signature verification failed: ${error instanceof Error ? error.message : error}`,
    );
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
  return {
    scheme: "authenticode",
    signerIdentity: asset.signature.signerIdentity,
    evidenceIdentity: asset.identity,
    evidenceDigest: asset.digest,
    verified: true,
  };
}
