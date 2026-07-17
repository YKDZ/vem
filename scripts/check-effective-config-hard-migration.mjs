#!/usr/bin/env node

import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "target",
  "dist",
  "build",
  "fixtures",
  "retired",
]);

const forbiddenPatterns = [
  /machine-config\.json/i,
  /machine-config\.local\.json/i,
  /MachinePublicConfig/,
  /MachineConfigUpdateRequest/,
  /\bgetConfig\b/,
  /\bsaveMachineConfig\b/,
  /\bsave_config_update\b/,
  /ConfirmAudioOutput/,
  /confirm_audio_output/,
  /audio-output-binding/i,
  /serialPortPath/,
  /scannerSerialPortPath/,
  /FactoryProfile/,
  /factoryProfile/,
  /local-bringup-settings/i,
  /bringup\/local-settings/i,
  /provisioning\/profile-cache-summary/i,
];

function walk(path, files) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) walk(join(path, entry.name), files);
      continue;
    }
    if (entry.isFile()) files.push(join(path, entry.name));
  }
}

export function findLegacyEffectiveConfigReferences({ root = ".", paths }) {
  const files = [];
  for (const path of paths) walk(join(root, path), files);

  return files.flatMap((path) => {
    if (relative(root, path) === "scripts/check-effective-config-hard-migration.mjs") {
      return [];
    }
    const text = readFileSync(path, "utf8");
    return forbiddenPatterns.flatMap((pattern) =>
      pattern.test(text)
        ? [`${relative(root, path)} matches ${pattern}`]
        : [],
    );
  });
}

export function assertNoLegacyEffectiveConfigReferences(options) {
  const findings = findLegacyEffectiveConfigReferences(options);
  if (findings.length > 0) {
    throw new Error(`legacy effective-config references found:\n${findings.join("\n")}`);
  }
}

const isDirectExecution =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectExecution) {
  assertNoLegacyEffectiveConfigReferences({
    root: ".",
    paths: ["apps/vending-daemon", "apps/machine", "scripts", ".github/workflows"],
  });
}
