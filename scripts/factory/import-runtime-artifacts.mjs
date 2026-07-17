#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  readRuntimeArtifactDescriptor,
  validateRuntimeArtifactDescriptor,
  validateRuntimeArtifactDirectory,
} from "../windows/runtime-artifact-descriptor.mjs";
import { ContentAddressedAssetStore } from "./content-addressed-store.mjs";
import { validateFactoryManifest } from "./factory-manifest.mjs";

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--") || index + 1 >= argv.length)
      throw new Error(`invalid argument: ${value}`);
    options[value.slice(2)] = argv[++index];
  }
  return options;
}

async function readManifest(root, identity) {
  const match = /^sha256:([a-f0-9]{64})$/.exec(identity ?? "");
  if (!match)
    throw new Error("manifest identity must be sha256:<64 lowercase hex>");
  const manifest = validateFactoryManifest(
    JSON.parse(
      await readFile(join(root, "sha256", `${match[1]}.json`), "utf8"),
    ),
  );
  if (manifest.manifestId !== identity)
    throw new Error("manifest store identity mismatch");
  return manifest;
}

export async function importRuntimeArtifacts({
  manifest,
  runtimeDirectory,
  store,
  expected,
}) {
  if (!(store instanceof ContentAddressedAssetStore)) {
    throw new TypeError(
      "runtime importer requires a ContentAddressedAssetStore",
    );
  }
  const descriptor = validateRuntimeArtifactDescriptor(
    await readRuntimeArtifactDescriptor(runtimeDirectory),
    expected,
  );
  await validateRuntimeArtifactDirectory(runtimeDirectory, descriptor);
  const imported = [];
  for (const entry of descriptor.artifacts) {
    const reference = manifest.assets.find(
      (asset) => asset.role === entry.role,
    );
    if (!reference) throw new Error(`manifest does not declare ${entry.role}`);
    if (reference.digest !== entry.digest) {
      throw new Error(
        `manifest digest does not match runtime descriptor for ${entry.role}`,
      );
    }
    const result = await store.ensure(
      reference,
      join(runtimeDirectory, entry.name),
    );
    imported.push(result.evidence);
  }
  return {
    schemaVersion: "vem-runtime-import/v1",
    descriptorIdentity: descriptor.identity,
    commit: descriptor.commit,
    imported,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const manifest = await readManifest(
    options["manifest-store"],
    options["manifest-identity"],
  );
  const result = await importRuntimeArtifacts({
    manifest,
    runtimeDirectory: options["runtime-directory"],
    store: new ContentAddressedAssetStore(options["asset-store"]),
    expected: {
      artifactIdentity: options["artifact-identity"],
      artifactName: options["artifact-name"],
      commit: options.commit,
      workflowRunIdentity: options["workflow-run-identity"],
    },
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
