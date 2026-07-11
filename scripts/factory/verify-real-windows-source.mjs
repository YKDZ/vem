#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { inspectWindowsSourceIso } from "./build-factory-media.mjs";
import { validateFactoryManifest } from "./factory-manifest.mjs";

function option(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1])
    throw new Error(`${name} is required`);
  return process.argv[index + 1];
}

const manifest = validateFactoryManifest(
  JSON.parse(await readFile(option("--manifest"), "utf8")),
);
const structure = await inspectWindowsSourceIso({
  sourceIsoPath: option("--source-iso"),
  source: manifest.source,
  isoBuilderPath: option("--xorriso"),
  isoBuilder: manifest.toolchain.isoBuilder,
  wimlibPath: option("--wimlib"),
  wimlib: manifest.toolchain.wimlib,
});
process.stdout.write(
  `${JSON.stringify({ installImage: structure.installImage, selectedImage: structure.selectedImage, bootCatalog: structure.bootCatalog })}\n`,
);
