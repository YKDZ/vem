#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index === -1) throw new Error(`--${name} is required`);
  return required(args[index + 1], name);
}

function loadReport(path, label) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value?.schemaVersion !== "vem-local-testbed-full-workflow/v2") {
      throw new Error("unexpected schema version");
    }
    return value;
  } catch (error) {
    throw new Error(
      `${label} report is unreadable at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function buildStabilityGateReport({
  commit,
  passAPath,
  passBPath,
} = {}) {
  const passA = loadReport(passAPath, "passA");
  const passB = loadReport(passBPath, "passB");
  const tracks = ["standardSale", "audio", "scanner", "vision", "tryOn", "error"];
  const gateFailures = [];
  if (passA.mode !== "full" || passB.mode !== "full") {
    gateFailures.push("stability gate requires two full workflow passes");
  }
  if (passA.ok !== true) gateFailures.push("pass A did not pass");
  if (passB.ok !== true) gateFailures.push("pass B did not pass");
  for (const key of tracks) {
    if (passA.tracks?.[key]?.status !== "passed") {
      gateFailures.push(`pass A ${key} status is not passed`);
    }
    if (passB.tracks?.[key]?.status !== "passed") {
      gateFailures.push(`pass B ${key} status is not passed`);
    }
  }
  return {
    schemaVersion: "vem-local-testbed-stability-gate/v1",
    commit: required(commit, "commit"),
    ok: gateFailures.length === 0,
    declaredStateReconstruction: {
      systemDrive: "reconstructed C:",
      platform: "reconstructed ephemeral platform state",
      retainedCaches: [
        "D:\\runtime-cache\\v1\\pnpm-store",
        "D:\\runtime-cache\\v1\\cargo-home",
        "D:\\runtime-cache\\v1\\target",
        "D:\\runtime-cache\\v1\\sccache",
        "D:\\runtime-cache\\v1\\turbo",
      ],
    },
    passes: {
      passA: {
        ok: passA.ok,
        failures: passA.failures ?? [],
      },
      passB: {
        ok: passB.ok,
        failures: passB.failures ?? [],
      },
    },
    gateFailures,
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main() {
  const args = process.argv.slice(2);
  const report = buildStabilityGateReport({
    commit: option(args, "commit"),
    passAPath: option(args, "pass-a"),
    passBPath: option(args, "pass-b"),
  });
  const outPath = option(args, "out");
  writeJson(outPath, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
