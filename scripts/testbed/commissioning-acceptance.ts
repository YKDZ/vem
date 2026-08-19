#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  const value = index >= 0 ? args[index + 1] : null;
  if (!value || value.startsWith("--"))
    throw new Error(`--${name} is required`);
  return value;
}

export function validateCommissioningAdmission(guestInput, handoff) {
  if (guestInput?.mode !== "full") {
    throw new Error(
      "commissioning requires a reconstructed full-pass guest input",
    );
  }
  if (
    handoff?.claim?.status !== "provisioned" ||
    handoff.claim.machineCode !== guestInput.machineCode
  ) {
    throw new Error("commissioning claim admission is absent or mismatched");
  }
  return { machineCode: guestInput.machineCode, status: handoff.claim.status };
}

async function main() {
  const args = process.argv.slice(2);
  const [guestInput, handoff] = await Promise.all([
    readFile(option(args, "guest-input"), "utf8").then(JSON.parse),
    readFile(option(args, "handoff"), "utf8").then(JSON.parse),
  ]);
  const admission = validateCommissioningAdmission(guestInput, handoff);
  const out = option(args, "out");
  const report = {
    schemaVersion: "vem-runtime-commissioning-acceptance/v1",
    ok: true,
    admission,
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
