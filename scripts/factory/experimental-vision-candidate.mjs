#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  createFactoryManifest,
  canonicalJson,
  validateFactoryManifest,
} from "./factory-manifest.mjs";
import {
  createVisionReleaseApproval,
  verifySignedVisionSupplierCandidate,
} from "./vision-release.mjs";

const SUPPLIER_DOCUMENTS = {
  descriptor: "vision-release-descriptor.json",
  attestation: "vision-artifact-attestation.json",
  sbom: "vision-sbom.spdx.json",
  provenance: "vision-provenance.json",
};
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SIGNER = /^spki-sha256:[a-f0-9]{64}$/;
const RC_TAG =
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)-rc\.[0-9A-Za-z.-]+$/;

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    if (!name.startsWith("--") || index + 1 >= rest.length) {
      throw new Error(`invalid argument: ${name}`);
    }
    options[name.slice(2)] = rest[++index];
  }
  return options;
}

function digestBytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function evidenceIdentity(digest) {
  return `factory-evidence://${digest.replace(":", "/")}`;
}

const NETWORK_IDENTITY = /^(?:https?|git\+(?:https|ssh)|ssh):\/\//i;

function hasExplicitNetworkPort(value) {
  const authority = value.slice(value.indexOf("://") + 3).split(/[/?#]/, 1)[0];
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  if (host.startsWith("[")) {
    return host.indexOf("]") !== host.length - 1;
  }
  return host.includes(":");
}

function parseNetworkIdentity(value, label) {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new Error(`${label} must be a normalized non-empty string`);
  }
  if (/^git\+ssh:/i.test(value)) {
    throw new Error(`${label} must not use git+ssh`);
  }
  if (hasExplicitNetworkPort(value)) {
    throw new Error(`${label} must not contain an explicit port`);
  }
  const parseable = value.replace(/^git\+https:/i, "https:");
  let url;
  try {
    url = new URL(parseable);
  } catch {
    throw new Error(`${label} is not a valid network identity`);
  }
  if (url.username || url.password || url.search || url.hash || url.port) {
    throw new Error(`${label} must not contain credentials or URL modifiers`);
  }
  return url;
}

export function manifestSourceIdentity(value) {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new Error("Candidate provenance source must be normalized");
  }
  if (/^git\+ssh:/i.test(value)) {
    throw new Error("Candidate provenance source must not use git+ssh");
  }
  const gitCommit =
    /^git\+https:\/\/([^@\s?#]+)@([a-f0-9]{40}|[a-f0-9]{64})$/i.exec(value);
  if (gitCommit) {
    const url = parseNetworkIdentity(
      `git+https://${gitCommit[1]}`,
      "Candidate provenance source",
    );
    if (!url.hostname || url.pathname === "/") {
      throw new Error("Candidate provenance source must name a repository");
    }
    return `git-commit:${url.hostname}${url.pathname.replace(/\/$/, "")}@${gitCommit[2].toLowerCase()}`;
  }
  if (NETWORK_IDENTITY.test(value)) {
    throw new Error(
      "Candidate provenance source must bind an immutable Git commit",
    );
  }
  return value;
}

export function manifestBuilderIdentity(value) {
  if (typeof value !== "string" || value !== value.trim()) {
    throw new Error("Candidate provenance builder must be normalized");
  }
  if (/^git\+ssh:/i.test(value)) {
    throw new Error("Candidate provenance builder must not use git+ssh");
  }
  if (!NETWORK_IDENTITY.test(value)) return value;
  parseNetworkIdentity(value, "Candidate provenance builder");
  return `builder-uri-sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function canonicalBytes(value) {
  return Buffer.from(`${canonicalJson(value)}\n`);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value ?? {}).sort();
  const wanted = [...expected].sort();
  if (
    actual.length !== wanted.length ||
    actual.some((name, index) => name !== wanted[index])
  ) {
    throw new Error(`${label} contains missing or unknown fields`);
  }
}

export function loadVisionCandidate(candidateDirectory) {
  const root = resolve(candidateDirectory);
  const bundleNames = readdirSync(root).filter((name) =>
    /^vending-vision-.+-windows-x86_64\.zip$/.test(name),
  );
  if (bundleNames.length !== 1) {
    throw new Error(
      "Candidate directory must contain exactly one Windows bundle",
    );
  }
  const documents = {};
  const signatures = {};
  const paths = {};
  for (const [role, fileName] of Object.entries(SUPPLIER_DOCUMENTS)) {
    const documentPath = join(root, fileName);
    const signaturePath = join(root, `${fileName}.sig.json`);
    documents[role] = readFileSync(documentPath);
    signatures[role] = JSON.parse(readFileSync(signaturePath, "utf8"));
    paths[role] = documentPath;
    paths[`${role}Signature`] = signaturePath;
  }
  const bundlePath = join(root, bundleNames[0]);
  return {
    root,
    bundlePath,
    bundle: readFileSync(bundlePath),
    documents,
    signatures,
    paths,
  };
}

export function verifyCandidateInputs({
  candidateDirectory,
  tag,
  expectedBundleDigest,
  expectedSupplierIdentity,
}) {
  if (!RC_TAG.test(tag ?? ""))
    throw new Error("Candidate tag is not a SemVer RC tag");
  if (!DIGEST.test(expectedBundleDigest ?? "")) {
    throw new Error("expected bundle digest is invalid");
  }
  if (!SIGNER.test(expectedSupplierIdentity ?? "")) {
    throw new Error("expected supplier identity is invalid");
  }
  const candidate = loadVisionCandidate(candidateDirectory);
  const verified = verifySignedVisionSupplierCandidate({
    bundle: candidate.bundle,
    documents: candidate.documents,
    signatures: candidate.signatures,
    expectedSignerIdentity: expectedSupplierIdentity,
  });
  if (`v${verified.releaseVersion}` !== tag) {
    throw new Error("Candidate tag does not match descriptor releaseVersion");
  }
  if (verified.bundleDigest !== expectedBundleDigest) {
    throw new Error(
      "Candidate bundle does not match the operator-provided digest",
    );
  }
  return { candidate, verified };
}

function signingIdentity(privateKey) {
  const publicKeyDer = createPublicKey(privateKey).export({
    type: "spki",
    format: "der",
  });
  return {
    identity: `spki-sha256:${createHash("sha256")
      .update(publicKeyDer)
      .digest("hex")}`,
    publicKeyDer,
  };
}

function signDocument(role, bytes, privateKey, signer) {
  const statement = Buffer.from(
    canonicalJson({ role, digest: digestBytes(bytes) }),
  );
  return {
    signer: {
      identity: signer.identity,
      publicKey: signer.publicKeyDer.toString("base64"),
    },
    signature: sign(null, statement, privateKey).toString("base64"),
  };
}

function evidenceReference(bytes) {
  const digest = digestBytes(bytes);
  return { identity: evidenceIdentity(digest), digest };
}

function writeBytes(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

export const FACTORY_VISION_INSTALLER_FILES = Object.freeze([
  "install-vision-release.ps1",
  "provision-vision-factory-release.ps1",
  "vision-release-materialization.psm1",
  "vision-diagnostic-redaction.psm1",
]);

export function stageFactoryVisionInstaller(stage) {
  for (const script of FACTORY_VISION_INSTALLER_FILES) {
    stage(
      `VISION-INSTALLER/${script}`,
      readFileSync(new URL(`../windows/${script}`, import.meta.url)),
    );
  }
}

export function createPreapprovalDeliveryManifest({
  bundle,
  descriptor,
  expectedBundleDigest,
  testEntry,
  materializer,
  redactor,
}) {
  if (digestBytes(bundle) !== expectedBundleDigest) {
    throw new Error("preapproval bundle does not match ExpectedDigest");
  }
  const files = {
    "bundle.bin": digestBytes(bundle),
    "vision-release-descriptor.json": digestBytes(descriptor),
    "test-vision-candidate.ps1": digestBytes(testEntry),
    "vision-release-materialization.psm1": digestBytes(materializer),
    "vision-diagnostic-redaction.psm1": digestBytes(redactor),
  };
  const manifest = {
    schemaVersion: "vem-vision-preapproval-delivery/v1",
    kind: "vision-preapproval-delivery",
    expectedDigest: expectedBundleDigest,
    descriptorDigest: files["vision-release-descriptor.json"],
    files,
  };
  return {
    ...manifest,
    identity: digestBytes(canonicalBytes(manifest)),
  };
}

export function stagePreapprovalDeliveryUnit({
  candidate,
  verified,
  outputDirectory,
}) {
  const outputRoot = resolve(outputDirectory);
  const preapprovalRoot = join(outputRoot, "VEM-VISION-PREAPPROVAL");
  const testEntry = readFileSync(
    new URL("../windows/test-vision-candidate.ps1", import.meta.url),
  );
  const materializer = readFileSync(
    new URL("../windows/vision-release-materialization.psm1", import.meta.url),
  );
  const redactor = readFileSync(
    new URL("../windows/vision-diagnostic-redaction.psm1", import.meta.url),
  );
  const manifest = createPreapprovalDeliveryManifest({
    bundle: candidate.bundle,
    descriptor: candidate.documents.descriptor,
    expectedBundleDigest: verified.bundleDigest,
    testEntry,
    materializer,
    redactor,
  });
  const entries = {
    "bundle.bin": candidate.bundle,
    "vision-release-descriptor.json": candidate.documents.descriptor,
    "test-vision-candidate.ps1": testEntry,
    "vision-release-materialization.psm1": materializer,
    "vision-diagnostic-redaction.psm1": redactor,
    "preapproval-manifest.json": canonicalBytes(manifest),
  };
  for (const [name, bytes] of Object.entries(entries)) {
    writeBytes(join(preapprovalRoot, name), bytes);
  }
  writeFileSync(
    join(preapprovalRoot, "SHA256SUMS"),
    `${Object.entries(entries)
      .map(([name, bytes]) => `${digestBytes(bytes).slice(7)}  ${name}`)
      .sort()
      .join("\n")}\n`,
  );
  return { root: preapprovalRoot, manifest };
}

function createExperimentalFactoryManifest({
  baseManifest,
  candidate,
  verified,
  documents,
  signatures,
}) {
  const manifest = structuredClone(validateFactoryManifest(baseManifest));
  const visionIndex = manifest.assets.findIndex(
    (asset) => asset.role === "vision-release",
  );
  if (visionIndex < 0)
    throw new Error("base Factory Manifest has no Vision asset");
  const provenance = JSON.parse(documents.provenance.toString("utf8"));
  const resolvedSource =
    provenance.predicate?.buildDefinition?.resolvedDependencies?.[0]?.uri;
  const builderIdentity = provenance.predicate?.runDetails?.builder?.id;
  const buildId = provenance.predicate?.runDetails?.metadata?.invocationId;
  if (
    ![resolvedSource, builderIdentity, buildId].every(
      (value) => typeof value === "string" && value.length > 0,
    )
  ) {
    throw new Error(
      "Candidate provenance cannot populate the experimental manifest",
    );
  }
  const signatureEvidence = canonicalBytes(signatures.attestation);
  const signatureReference = evidenceReference(signatureEvidence);
  const provenanceReference = evidenceReference(documents.provenance);
  const descriptorReference = evidenceReference(documents.descriptor);
  const release = {
    descriptorIdentity: descriptorReference.identity,
    descriptorDigest: descriptorReference.digest,
    attestationIdentity: evidenceIdentity(digestBytes(documents.attestation)),
    attestationDigest: digestBytes(documents.attestation),
    approvalIdentity: evidenceIdentity(digestBytes(documents.approval)),
    approvalDigest: digestBytes(documents.approval),
    conformanceEvidenceIdentity: evidenceIdentity(
      digestBytes(documents.conformance),
    ),
    conformanceEvidenceDigest: digestBytes(documents.conformance),
  };
  const existing = manifest.assets[visionIndex];
  manifest.assets[visionIndex] = {
    ...existing,
    identity: `factory-cas://${verified.bundleDigest.replace(":", "/")}`,
    digest: verified.bundleDigest,
    version: verified.releaseVersion,
    signature: {
      scheme: "detached-ed25519",
      signerIdentity: verified.supplierIdentity,
      evidenceIdentity: signatureReference.identity,
      evidenceDigest: signatureReference.digest,
    },
    provenance: {
      predicateType: "https://slsa.dev/provenance/v1",
      sourceIdentity: manifestSourceIdentity(resolvedSource),
      builderIdentity: manifestBuilderIdentity(builderIdentity),
      buildId,
      signerIdentity: verified.supplierIdentity,
      evidenceIdentity: provenanceReference.identity,
      evidenceDigest: provenanceReference.digest,
    },
    release,
  };
  delete manifest.manifestId;
  return createFactoryManifest(manifest);
}

export function finalizeExperimentalCandidate(options) {
  const { candidate, verified } = verifyCandidateInputs(options);
  const conformance = readFileSync(resolve(options.conformancePath));
  const conformanceValue = JSON.parse(conformance.toString("utf8"));
  exactKeys(
    conformanceValue,
    [
      "schemaVersion",
      "kind",
      "bundleDigest",
      "descriptorDigest",
      "protocolVersion",
    ],
    "Vision conformance evidence",
  );
  if (
    conformanceValue.schemaVersion !== "vem-vision-conformance/v1" ||
    conformanceValue.kind !== "vision-release-conformance" ||
    conformanceValue.bundleDigest !== verified.bundleDigest ||
    conformanceValue.descriptorDigest !== verified.descriptorDigest ||
    conformanceValue.protocolVersion !== "vem.vision.v1"
  ) {
    throw new Error("Vision conformance evidence does not bind the Candidate");
  }
  const privateKey = createPrivateKey(
    readFileSync(resolve(options.acceptancePrivateKey)),
  );
  const acceptanceSigner = signingIdentity(privateKey);
  if (acceptanceSigner.identity !== options.expectedAcceptanceIdentity) {
    throw new Error("VEM acceptance private key identity mismatch");
  }
  const approval = createVisionReleaseApproval({
    releaseVersion: verified.releaseVersion,
    bundleDigest: verified.bundleDigest,
    descriptorDigest: verified.descriptorDigest,
    attestationDigest: digestBytes(candidate.documents.attestation),
    conformanceEvidenceDigest: digestBytes(conformance),
    approverIdentity:
      options.approverIdentity ?? "vem-release-approval:experimental-testbed",
  });
  const approvalBytes = canonicalBytes(approval);
  const documents = {
    ...candidate.documents,
    conformance,
    approval: approvalBytes,
  };
  const signatures = {
    ...candidate.signatures,
    conformance: signDocument(
      "conformance",
      conformance,
      privateKey,
      acceptanceSigner,
    ),
    approval: signDocument(
      "approval",
      approvalBytes,
      privateKey,
      acceptanceSigner,
    ),
  };
  const verifierBytes = readFileSync(resolve(options.verifierPath));
  if (verifierBytes.length < 1) throw new Error("Vision verifier is empty");
  const verifierDigest = digestBytes(verifierBytes);
  const trustPolicy = {
    schemaVersion: "vem-vision-release-trust-policy/v1",
    kind: "vision-release-trust-policy",
    verifierDigest,
    approvedIdentities: {
      descriptor: [verified.supplierIdentity],
      attestation: [verified.supplierIdentity],
      sbom: [verified.supplierIdentity],
      provenance: [verified.supplierIdentity],
      conformance: [acceptanceSigner.identity],
      approval: [acceptanceSigner.identity],
    },
  };
  const trustPolicyBytes = canonicalBytes(trustPolicy);
  const trustAnchor = {
    schemaVersion: "vem-factory-vision-trust-anchor/v1",
    kind: "factory-vision-trust-anchor",
    trustPolicyDigest: digestBytes(trustPolicyBytes),
    verifierDigest,
  };
  const baseManifest = JSON.parse(
    readFileSync(resolve(options.baseManifestPath), "utf8"),
  );
  const factoryManifest = createExperimentalFactoryManifest({
    baseManifest,
    candidate,
    verified,
    documents,
    signatures,
  });
  const factoryManifestBytes = canonicalBytes(factoryManifest);
  const outputRoot = resolve(options.outputDirectory);
  const mediaRoot = join(outputRoot, "VEM");
  const releaseRoot = join(mediaRoot, "VISION-RELEASE");
  const trustRoot = join(mediaRoot, "VISION-TRUST");
  const installerRoot = join(mediaRoot, "VISION-INSTALLER");
  mkdirSync(releaseRoot, { recursive: true });
  mkdirSync(trustRoot, { recursive: true });
  mkdirSync(installerRoot, { recursive: true });

  const provisioningFiles = {};
  function stage(relative, bytes) {
    writeBytes(join(mediaRoot, relative), bytes);
    provisioningFiles[relative.replaceAll("\\", "/")] = digestBytes(bytes);
  }
  stage("VISION-RELEASE/bundle.bin", candidate.bundle);
  stage("VISION-RELEASE/factory-manifest.json", factoryManifestBytes);
  for (const [role, bytes] of Object.entries(documents)) {
    stage(`VISION-RELEASE/${role}.json`, bytes);
  }
  for (const [role, signature] of Object.entries(signatures)) {
    stage(`VISION-RELEASE/${role}.signature.json`, canonicalBytes(signature));
  }
  stage("VISION-TRUST/vision-release-trust-policy.json", trustPolicyBytes);
  stage(
    "VISION-TRUST/vision-release-trust-anchor.json",
    canonicalBytes(trustAnchor),
  );
  stage("VISION-TRUST/vision-release-verifier.exe", verifierBytes);
  stageFactoryVisionInstaller(stage);
  const provisioningManifest = {
    schemaVersion: "vem-vision-factory-provisioning/v1",
    kind: "vision-factory-provisioning",
    files: Object.fromEntries(
      Object.entries(provisioningFiles).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
  writeBytes(
    join(mediaRoot, "VISION-FACTORY-PROVISIONING.JSON"),
    canonicalBytes(provisioningManifest),
  );
  const deliveryUnit = {
    documents: Object.fromEntries(
      Object.entries(documents).map(([role, bytes]) => [
        role,
        bytes.toString("base64"),
      ]),
    ),
    signatures,
  };
  writeBytes(
    join(outputRoot, "delivery-unit.json"),
    canonicalBytes(deliveryUnit),
  );
  const classification = {
    schemaVersion: "vem-vision-experimental-acceptance/v1",
    kind: "vision-experimental-acceptance",
    classification: "Experimental Candidate / Testbed Accepted",
    tag: options.tag,
    releaseVersion: verified.releaseVersion,
    bundleDigest: verified.bundleDigest,
    descriptorDigest: verified.descriptorDigest,
    supplierIdentity: verified.supplierIdentity,
    acceptanceIdentity: acceptanceSigner.identity,
    baseFactoryManifestIdentity: baseManifest.manifestId,
    derivedFactoryManifestIdentity: factoryManifest.manifestId,
  };
  writeBytes(
    join(outputRoot, "experimental-acceptance.json"),
    canonicalBytes(classification),
  );
  const checksums = [];
  function visit(directory, prefix = "") {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (statSync(path).isDirectory()) visit(path, relative);
      else
        checksums.push(
          `${digestBytes(readFileSync(path)).slice(7)}  ${relative}`,
        );
    }
  }
  visit(outputRoot);
  writeFileSync(join(outputRoot, "SHA256SUMS"), `${checksums.join("\n")}\n`);
  return classification;
}

export function stageExperimentalVisionDeliveryAssemblyContract({
  outputRoot,
  kind,
  nonce,
}) {
  if (kind === "deliveryAssembly") {
    const mediaRoot = join(resolve(outputRoot), "VEM");
    const files = {};
    stageFactoryVisionInstaller((relative, bytes) => {
      writeBytes(join(mediaRoot, relative), bytes);
      files[relative] = digestBytes(bytes);
    });
    mkdirSync(join(mediaRoot, "VISION-RELEASE"), { recursive: true });
    mkdirSync(join(mediaRoot, "VISION-TRUST"), { recursive: true });
    writeBytes(
      join(mediaRoot, "VISION-FACTORY-PROVISIONING.JSON"),
      canonicalBytes({
        schemaVersion: "vem-vision-factory-provisioning/v1",
        kind: "vision-factory-provisioning",
        files: Object.fromEntries(
          Object.entries(files).sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
      }),
    );
    return { outputRoot: resolve(outputRoot), kind };
  }
  if (kind === "preapprovalDeliveryAssembly") {
    const bundle = Buffer.from(`inventory-contract:${nonce}\n`);
    const descriptor = canonicalBytes({
      schemaVersion: "vem-vision-delivery-contract-fixture/v1",
      nonce,
    });
    const staged = stagePreapprovalDeliveryUnit({
      candidate: { bundle, documents: { descriptor } },
      verified: { bundleDigest: digestBytes(bundle) },
      outputDirectory: outputRoot,
    });
    return { outputRoot: resolve(outputRoot), kind, staged };
  }
  throw new Error("unsupported Experimental Vision delivery assembly kind");
}

function usage() {
  return `
experimental-vision-candidate.mjs verify --candidate-dir DIR --tag TAG --expected-bundle-digest sha256:... --expected-supplier-identity spki-sha256:...

experimental-vision-candidate.mjs prepare-preapproval (verify options) --output DIR

experimental-vision-candidate.mjs finalize (verify options) --conformance PATH --acceptance-private-key PATH --expected-acceptance-identity spki-sha256:... --verifier PATH --base-manifest PATH --output DIR
`.trim();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const contractIndex = process.argv.indexOf("--delivery-assembly-contract");
    if (contractIndex >= 0) {
      const contractPath = process.argv[contractIndex + 1];
      const contract = JSON.parse(readFileSync(contractPath, "utf8"));
      if (
        contract?.schemaVersion !==
          "vem-delivery-assembly-execution-contract/v1" ||
        contract.producer !==
          "scripts/factory/experimental-vision-candidate.mjs" ||
        typeof contract.outputRoot !== "string"
      ) {
        throw new Error(
          "invalid Experimental Vision delivery assembly contract",
        );
      }
      const result = stageExperimentalVisionDeliveryAssemblyContract({
        outputRoot: contract.outputRoot,
        kind: contract.kind,
        nonce: contract.nonce,
      });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      const options = parseArgs(process.argv.slice(2));
      const shared = {
        candidateDirectory: options["candidate-dir"],
        tag: options.tag,
        expectedBundleDigest: options["expected-bundle-digest"],
        expectedSupplierIdentity: options["expected-supplier-identity"],
      };
      if (options.command === "verify") {
        const { verified } = verifyCandidateInputs(shared);
        process.stdout.write(`${JSON.stringify(verified, null, 2)}\n`);
      } else if (options.command === "prepare-preapproval") {
        const { candidate, verified } = verifyCandidateInputs(shared);
        const result = stagePreapprovalDeliveryUnit({
          candidate,
          verified,
          outputDirectory: options.output,
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else if (options.command === "finalize") {
        const result = finalizeExperimentalCandidate({
          ...shared,
          conformancePath: options.conformance,
          acceptancePrivateKey: options["acceptance-private-key"],
          expectedAcceptanceIdentity: options["expected-acceptance-identity"],
          verifierPath: options.verifier,
          baseManifestPath: options["base-manifest"],
          outputDirectory: options.output,
          approverIdentity: options["approver-identity"],
        });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        throw new Error(usage());
      }
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
