#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { buildFactoryMedia } from "./build-factory-media.mjs";
import { ContentAddressedAssetStore } from "./content-addressed-store.mjs";
import { validateFactoryManifest } from "./factory-manifest.mjs";
import {
  validateFactoryEvidencePayload,
  validateFactoryEvidenceUploadDirectory,
} from "./sanitize-build-evidence.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--reproducibility") {
      options.reproducibility = true;
      continue;
    }
    if (!value.startsWith("--") || index + 1 >= argv.length) {
      throw new Error(`invalid argument: ${value}`);
    }
    options[value.slice(2)] = argv[++index];
  }
  return options;
}

function assertSafeHostPath(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    /^[A-Za-z]:/.test(value) ||
    value.startsWith("//") ||
    !isAbsolute(value) ||
    normalize(value) !== resolve(value)
  ) {
    throw new Error(`${label} must be a canonical local Unix path`);
  }
  return value;
}

async function readManifest(manifestStoreRoot, manifestIdentity) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(manifestIdentity ?? "");
  if (!match)
    throw new Error("--manifest-identity must be sha256:<64 lowercase hex>");
  const manifestPath = join(manifestStoreRoot, "sha256", `${match[1]}.json`);
  const manifest = validateFactoryManifest(
    JSON.parse(await readFile(manifestPath, "utf8")),
  );
  if (manifest.manifestId !== manifestIdentity)
    throw new Error("manifest store identity mismatch");
  return manifest;
}

async function readVisionReleaseDeliveryUnit(path) {
  const value = JSON.parse(await readFile(path, "utf8"));
  if (
    !value ||
    typeof value !== "object" ||
    !value.documents ||
    !value.signatures
  ) {
    throw new Error(
      "Vision release delivery unit must contain documents and signatures",
    );
  }
  return {
    documents: Object.fromEntries(
      Object.entries(value.documents).map(([role, base64]) => [
        role,
        Buffer.from(base64, "base64"),
      ]),
    ),
    signatures: value.signatures,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifestStore =
    options["manifest-store"] ?? process.env.VEM_FACTORY_MANIFEST_STORE;
  const outputDirectory =
    options["output-dir"] ?? process.env.VEM_FACTORY_OUTPUT_DIR;
  const assetStoreRoot =
    options["asset-store"] ?? process.env.VEM_FACTORY_ASSET_STORE;
  const sourceStoreRoot =
    options["windows-source-store"] ??
    process.env.VEM_FACTORY_WINDOWS_SOURCE_STORE;
  const evidenceStoreRoot =
    options["evidence-store"] ?? process.env.VEM_FACTORY_EVIDENCE_STORE;
  const approvalPolicyPath =
    options["approval-policy"] ?? process.env.VEM_FACTORY_APPROVAL_POLICY;
  const isoBuilderPath =
    options["iso-builder"] ?? process.env.VEM_FACTORY_ISO_BUILDER;
  const visionReleaseDeliveryUnitPath =
    options["vision-release-delivery-unit"] ??
    process.env.VEM_FACTORY_VISION_RELEASE_DELIVERY_UNIT;
  const repositoryVisionTrustedRootsPath =
    options["repository-vision-trusted-roots"] ??
    process.env.VEM_FACTORY_REPOSITORY_VISION_TRUSTED_ROOTS;
  const factoryVisionTrustedRootsPath =
    options["factory-vision-trusted-roots"] ??
    process.env.VEM_FACTORY_FACTORY_VISION_TRUSTED_ROOTS;
  const visionEvidenceVerifierPath =
    options["vision-evidence-verifier"] ??
    process.env.VEM_FACTORY_VISION_EVIDENCE_VERIFIER;
  const authenticodeVerifierPath =
    options["authenticode-verifier"] ??
    process.env.VEM_FACTORY_AUTHENTICODE_VERIFIER;
  const authenticodeCaBundlePath =
    options["authenticode-ca-bundle"] ??
    process.env.VEM_FACTORY_AUTHENTICODE_CA_BUNDLE;
  const executedBuilderImage = process.env.VEM_FACTORY_EXECUTED_BUILDER_IMAGE;
  if (
    !manifestStore ||
    !outputDirectory ||
    !assetStoreRoot ||
    !sourceStoreRoot ||
    !evidenceStoreRoot ||
    !approvalPolicyPath ||
    !isoBuilderPath ||
    !visionReleaseDeliveryUnitPath ||
    !repositoryVisionTrustedRootsPath ||
    !factoryVisionTrustedRootsPath ||
    !visionEvidenceVerifierPath ||
    !executedBuilderImage
  ) {
    throw new Error(
      "Factory manifest, output, asset, Windows source, evidence, approval policy, Vision release delivery unit, repository/factory Vision trusted roots, Vision verifier, ISO builder, and executed builder image configuration are required",
    );
  }
  for (const [value, label] of [
    [manifestStore, "--manifest-store"],
    [outputDirectory, "--output-dir"],
    [assetStoreRoot, "--asset-store"],
    [sourceStoreRoot, "--windows-source-store"],
    [evidenceStoreRoot, "--evidence-store"],
    [approvalPolicyPath, "--approval-policy"],
    [isoBuilderPath, "--iso-builder"],
    [visionReleaseDeliveryUnitPath, "--vision-release-delivery-unit"],
    [repositoryVisionTrustedRootsPath, "--repository-vision-trusted-roots"],
    [factoryVisionTrustedRootsPath, "--factory-vision-trusted-roots"],
    [visionEvidenceVerifierPath, "--vision-evidence-verifier"],
    ...(authenticodeVerifierPath
      ? [[authenticodeVerifierPath, "--authenticode-verifier"]]
      : []),
    ...(authenticodeCaBundlePath
      ? [[authenticodeCaBundlePath, "--authenticode-ca-bundle"]]
      : []),
  ]) {
    assertSafeHostPath(value, label);
  }
  const manifest = await readManifest(
    manifestStore,
    options["manifest-identity"],
  );
  const store = new ContentAddressedAssetStore(assetStoreRoot);
  const approvalPolicy = JSON.parse(await readFile(approvalPolicyPath, "utf8"));
  const visionReleaseDeliveryUnit = await readVisionReleaseDeliveryUnit(
    visionReleaseDeliveryUnitPath,
  );
  const repositoryVisionTrustedRoots = JSON.parse(
    await readFile(repositoryVisionTrustedRootsPath, "utf8"),
  );
  const factoryVisionTrustedRoots = JSON.parse(
    await readFile(factoryVisionTrustedRootsPath, "utf8"),
  );
  const result = await buildFactoryMedia({
    manifest,
    store,
    outputDirectory,
    sourceStoreRoot,
    evidenceStoreRoot,
    approvalPolicy,
    visionReleaseDeliveryUnit,
    repositoryVisionTrustedRoots,
    factoryVisionTrustedRoots,
    visionEvidenceVerifierPath,
    isoBuilderPath,
    authenticodeVerifierPath,
    authenticodeCaBundlePath,
    executedBuilderImage,
    reproducibility: options.reproducibility === true,
  });
  await store.ensure(result.output, result.output.path);
  await rm(result.output.path, { force: true });
  const evidencePath = join(outputDirectory, "factory-provenance.json");
  validateFactoryEvidencePayload("factory-provenance.json", result.provenance);
  const provenanceBytes = Buffer.from(
    `${JSON.stringify(result.provenance, null, 2)}\n`,
  );
  const provenanceDigest = `sha256:${createHash("sha256")
    .update(provenanceBytes)
    .digest("hex")}`;
  await writeFile(evidencePath, provenanceBytes, { mode: 0o444 });
  const publicResult = {
    schemaVersion: "vem-factory-build-result/v1",
    kind: "factory-build-result",
    manifestIdentity: manifest.manifestId,
    isoIdentity: result.output.identity,
    isoDigest: result.output.digest,
    isoFileName: result.output.fileName,
    provenanceFileName: "factory-provenance.json",
    provenanceIdentity: `factory-evidence://${provenanceDigest.replace(":", "/")}`,
    provenanceDigest,
    reproducibility: result.reproducibility,
  };
  validateFactoryEvidencePayload("factory-build-result.json", publicResult);
  await writeFile(
    join(outputDirectory, "factory-build-result.json"),
    `${JSON.stringify(publicResult, null, 2)}\n`,
    {
      mode: 0o444,
    },
  );
  await validateFactoryEvidenceUploadDirectory(outputDirectory);
  process.stdout.write(`${JSON.stringify(publicResult)}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
