#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
    !executedBuilderImage
  ) {
    throw new Error(
      "Factory manifest, output, asset, Windows source, evidence, approval policy, ISO builder, and executed builder image configuration are required",
    );
  }
  const manifest = await readManifest(
    manifestStore,
    options["manifest-identity"],
  );
  const store = new ContentAddressedAssetStore(assetStoreRoot);
  const approvalPolicy = JSON.parse(await readFile(approvalPolicyPath, "utf8"));
  const result = await buildFactoryMedia({
    manifest,
    store,
    outputDirectory,
    sourceStoreRoot,
    evidenceStoreRoot,
    approvalPolicy,
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
