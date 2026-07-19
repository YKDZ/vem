#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const RETAINED_CACHE_CONTRACT = Object.freeze([
  "D:\\runtime-cache\\v1\\pnpm-store",
  "D:\\runtime-cache\\v1\\pnpm-virtual-store",
  "D:\\runtime-cache\\v1\\cargo-home",
  "D:\\runtime-cache\\v1\\target",
  "D:\\runtime-cache\\v1\\sccache",
  "D:\\runtime-cache\\v1\\turbo",
  "D:\\runtime-cache\\v1\\vision-main",
  "D:\\runtime-cache\\v1\\powershell",
]);
const REQUIRED_EXECUTION_ORDER = Object.freeze([
  "fast",
  "delayedPickup",
  "scanner",
  "ipcRecovery",
  "fulfillmentFailure",
  "visionTryOn",
]);

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
    if (value?.schemaVersion !== "vem-local-testbed-full-workflow/v3") {
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

function sameStringArray(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function buildStabilityGateReport({
  commit,
  passAPath,
  passBPath,
} = {}) {
  const passA = loadReport(passAPath, "passA");
  const passB = loadReport(passBPath, "passB");
  const tracks = [
    "standardSale",
    "ipcRecovery",
    "fulfillmentFailure",
    "audio",
    "scanner",
    "vision",
    "tryOn",
    "evidence",
    "error",
  ];
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
  const identities = { passA: passA.identity, passB: passB.identity };
  for (const [label, identity] of Object.entries(identities)) {
    if (identity?.githubSha !== commit)
      gateFailures.push(`${label} GITHUB_SHA does not match gate commit`);
    if (
      typeof identity?.baseline?.releaseId !== "string" ||
      identity.baseline.releaseId.trim() === ""
    ) {
      gateFailures.push(`${label} baseline release is missing`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(identity?.baseline?.digest ?? "")) {
      gateFailures.push(`${label} baseline digest is invalid`);
    }
    if (
      !/^runtime-base:\/\/sha256\/[a-f0-9]{64}$/.test(
        identity?.runtimeBase ?? "",
      )
    ) {
      gateFailures.push(`${label} runtime-base is invalid`);
    }
    if (
      !/^reconstruction:\/\/sha256\/[a-f0-9]{64}$/.test(
        identity?.reconstructionId ?? "",
      )
    ) {
      gateFailures.push(`${label} reconstruction ID is invalid`);
    }
    if (!sameStringArray(identity?.retainedCaches, RETAINED_CACHE_CONTRACT)) {
      gateFailures.push(`${label} retained-cache contract drifted`);
    }
    if (
      !sameStringArray(identity?.observedRetainedCaches, RETAINED_CACHE_CONTRACT)
    ) {
      gateFailures.push(`${label} observed retained caches drifted`);
    }
    if (!Array.isArray(identity?.removedUndeclaredCaches)) {
      gateFailures.push(`${label} undeclared cache cleanup evidence is missing`);
    }
    if (
      JSON.stringify(
        passA.execution?.executedTracks?.map((track) => track.key),
      ) !== JSON.stringify(REQUIRED_EXECUTION_ORDER) &&
      label === "passA"
    ) {
      gateFailures.push(
        "pass A execution order is not fast -> delayed audio -> scanner -> IPC recovery -> fulfillment failure -> Vision",
      );
    }
    if (
      JSON.stringify(
        passB.execution?.executedTracks?.map((track) => track.key),
      ) !== JSON.stringify(REQUIRED_EXECUTION_ORDER) &&
      label === "passB"
    ) {
      gateFailures.push(
        "pass B execution order is not fast -> delayed audio -> scanner -> IPC recovery -> fulfillment failure -> Vision",
      );
    }
  }
  if (
    passA.identity?.baseline?.releaseId !== passB.identity?.baseline?.releaseId
  )
    gateFailures.push("baseline release differs between passes");
  if (passA.identity?.baseline?.digest !== passB.identity?.baseline?.digest)
    gateFailures.push("baseline digest differs between passes");
  if (passA.identity?.runtimeBase !== passB.identity?.runtimeBase)
    gateFailures.push("runtime-base differs between passes");
  if (passA.identity?.reconstructionId === passB.identity?.reconstructionId)
    gateFailures.push("two passes reused one reconstruction ID");
  if (!sameStringArray(passA.identity?.retainedCaches, passB.identity?.retainedCaches))
    gateFailures.push("retained-cache contract differs between passes");
  if (
    !sameStringArray(
      passA.identity?.observedRetainedCaches,
      passB.identity?.observedRetainedCaches,
    )
  ) {
    gateFailures.push("observed retained caches differ between passes");
  }
  return {
    schemaVersion: "vem-local-testbed-stability-gate/v2",
    commit: required(commit, "commit"),
    ok: gateFailures.length === 0,
    declaredStateReconstruction: {
      systemDrive: "reconstructed C:",
      platform: "reconstructed ephemeral platform state",
      retainedCachesAllowlist: RETAINED_CACHE_CONTRACT,
    },
    passes: {
      passA: {
        ok: passA.ok,
        failures: passA.failures ?? [],
        identity: passA.identity ?? null,
      },
      passB: {
        ok: passB.ok,
        failures: passB.failures ?? [],
        identity: passB.identity ?? null,
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
