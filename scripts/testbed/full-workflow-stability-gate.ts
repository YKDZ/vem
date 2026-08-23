#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  bindAcceptanceReleaseManifest,
  canonicalAcceptanceReleaseManifest,
} from "./acceptance-release-manifest.ts";
import { BUSINESS_CHECK_REGISTRY } from "./business-check-registry.ts";

const RETAINED_CACHE_CONTRACT = Object.freeze([
  "D:\\runtime-cache\\v1\\pnpm-store",
  "D:\\runtime-cache\\v1\\pnpm-virtual-store",
  "D:\\runtime-cache\\v1\\cargo-home",
  "D:\\runtime-cache\\v1\\target",
  "D:\\runtime-cache\\v1\\sccache",
  "D:\\runtime-cache\\v1\\turbo",
  "D:\\runtime-cache\\v1\\vision-main",
  "D:\\runtime-cache\\v1\\acceptance-inputs",
  "D:\\runtime-cache\\v1\\powershell",
]);
const REQUIRED_EXECUTION_ORDER = Object.freeze(
  BUSINESS_CHECK_REGISTRY.filter((descriptor) => descriptor.fullRequired).map(
    (descriptor) => descriptor.name,
  ),
);

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  if (index === -1) throw new Error(`--${name} is required`);
  return required(args[index + 1], name);
}

function loadReport(path: string, label: string): JsonRecord {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
    if (value?.schemaVersion !== "vem-local-testbed-full-workflow/v4") {
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

function sameStringArray(
  actual: unknown,
  expected: readonly unknown[],
): boolean {
  return JSON.stringify(arrayValue(actual)) === JSON.stringify(expected);
}

function runtimeArtifactDigests(
  identity: JsonRecord | null | undefined,
): JsonRecord | null {
  const runtimeArtifacts = recordValue(identity?.runtimeArtifacts);
  if (runtimeArtifacts.commit !== identity?.githubSha) return null;
  const artifacts = recordValue(runtimeArtifacts.artifacts);
  const digests = Object.fromEntries(
    ["daemon", "machine", "webViewLoader"].map((name) => [
      name,
      recordValue(artifacts[name]).sha256,
    ]),
  ) as JsonRecord;
  return Object.values(digests).every((digest) =>
    /^[a-f0-9]{64}$/.test(String(digest)),
  )
    ? digests
    : null;
}

export function buildStabilityGateReport({
  commit,
  passAPath,
  passBPath,
}: {
  commit?: unknown;
  passAPath?: unknown;
  passBPath?: unknown;
} = {}): JsonRecord {
  const passA = loadReport(String(passAPath), "passA");
  const passB = loadReport(String(passBPath), "passB");
  const gateFailures: string[] = [];
  let acceptanceRelease: JsonRecord | null = null;
  try {
    acceptanceRelease = recordValue(
      bindAcceptanceReleaseManifest(passA.identity, passB.identity),
    );
  } catch (error) {
    gateFailures.push(error instanceof Error ? error.message : String(error));
  }
  if (passA.mode !== "full" || passB.mode !== "full") {
    gateFailures.push("stability gate requires two full workflow passes");
  }
  if (passA.ok !== true) gateFailures.push("pass A did not pass");
  if (passB.ok !== true) gateFailures.push("pass B did not pass");
  const passASets = recordValue(passA.businessSets);
  const passBSets = recordValue(passB.businessSets);
  for (const key of REQUIRED_EXECUTION_ORDER) {
    if (recordValue(passASets[key]).status !== "passed") {
      gateFailures.push(`pass A ${key} status is not passed`);
    }
    if (recordValue(passBSets[key]).status !== "passed") {
      gateFailures.push(`pass B ${key} status is not passed`);
    }
  }
  const identities = { passA: passA.identity, passB: passB.identity };
  for (const [label, identityValue] of Object.entries(identities)) {
    const identity = recordValue(identityValue);
    if (identity?.githubSha !== commit)
      gateFailures.push(`${label} GITHUB_SHA does not match gate commit`);
    const baseline = recordValue(identity?.baseline);
    if (
      typeof baseline?.releaseId !== "string" ||
      String(baseline.releaseId).trim() === ""
    ) {
      gateFailures.push(`${label} baseline release is missing`);
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(String(baseline?.digest ?? ""))) {
      gateFailures.push(`${label} baseline digest is invalid`);
    }
    if (
      !/^runtime-base:\/\/sha256\/[a-f0-9]{64}$/.test(
        String(identity?.runtimeBase ?? ""),
      )
    ) {
      gateFailures.push(`${label} runtime-base is invalid`);
    }
    if (
      !/^reconstruction:\/\/sha256\/[a-f0-9]{64}$/.test(
        String(identity?.reconstructionId ?? ""),
      )
    ) {
      gateFailures.push(`${label} reconstruction ID is invalid`);
    }
    if (
      !sameStringArray(identity?.retainedCaches, RETAINED_CACHE_CONTRACT)
    ) {
      gateFailures.push(`${label} retained-cache contract drifted`);
    }
    if (!Array.isArray(identity?.removedUndeclaredCaches)) {
      gateFailures.push(
        `${label} undeclared cache cleanup evidence is missing`,
      );
    }
    if (!runtimeArtifactDigests(identity)) {
      gateFailures.push(`${label} runtime artifact evidence is invalid`);
    }
    if (
      JSON.stringify(
        recordValue(passA.execution).selectedBusinessSets,
      ) !==
        JSON.stringify(REQUIRED_EXECUTION_ORDER) &&
      label === "passA"
    ) {
      gateFailures.push(
        "pass A execution order does not match the business-set registry",
      );
    }
    if (
      JSON.stringify(
        recordValue(passB.execution).selectedBusinessSets,
      ) !==
        JSON.stringify(REQUIRED_EXECUTION_ORDER) &&
      label === "passB"
    ) {
      gateFailures.push(
        "pass B execution order does not match the business-set registry",
      );
    }
  }
  if (
    recordValue(recordValue(passA.identity).baseline).releaseId !==
    recordValue(recordValue(passB.identity).baseline).releaseId
  )
    gateFailures.push("baseline release differs between passes");
  if (
    recordValue(recordValue(passA.identity).baseline).digest !==
    recordValue(recordValue(passB.identity).baseline).digest
  )
    gateFailures.push("baseline digest differs between passes");
  if (recordValue(passA.identity).runtimeBase !== recordValue(passB.identity).runtimeBase)
    gateFailures.push("runtime-base differs between passes");
  if (recordValue(passA.identity).reconstructionId === recordValue(passB.identity).reconstructionId)
    gateFailures.push("two passes reused one reconstruction ID");
  if (
    !sameStringArray(
      recordValue(passA.identity).retainedCaches,
      arrayValue(recordValue(passB.identity).retainedCaches),
    )
  )
    gateFailures.push("retained-cache contract differs between passes");
  if (
    JSON.stringify(runtimeArtifactDigests(recordValue(passA.identity))) !==
    JSON.stringify(runtimeArtifactDigests(recordValue(passB.identity)))
  ) {
    gateFailures.push("runtime artifact digests differ between passes");
  }
  const ok = gateFailures.length === 0;
  return {
    schemaVersion: "vem-local-testbed-stability-gate/v2",
    commit: required(commit, "commit"),
    ok,
    ...(ok && acceptanceRelease
      ? {
          acceptanceReleaseManifest: acceptanceRelease.manifest,
          acceptanceReleaseManifestSha256: acceptanceRelease.sha256,
        }
      : {}),
    declaredStateReconstruction: {
      systemDrive: "reconstructed C:",
      platform: "reconstructed ephemeral platform state",
      retainedCachesAllowlist: RETAINED_CACHE_CONTRACT,
    },
    passes: {
      passA: {
        ok: passA.ok,
        failures: arrayValue(passA.failures),
        identity: passA.identity ?? null,
      },
      passB: {
        ok: passB.ok,
        failures: arrayValue(passB.failures),
        identity: passB.identity ?? null,
      },
    },
    gateFailures,
  };
}

function writeJson(path: string, value: JsonRecord): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const report = buildStabilityGateReport({
    commit: option(args, "commit"),
    passAPath: option(args, "pass-a"),
    passBPath: option(args, "pass-b"),
  });
  const outPath = option(args, "out");
  if (report.ok && report.acceptanceReleaseManifest) {
    const manifestPath = resolve(
      dirname(outPath),
      "acceptance-release-manifest.json",
    );
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(
      manifestPath,
      canonicalAcceptanceReleaseManifest(report.acceptanceReleaseManifest),
      "utf8",
    );
  }
  writeJson(outPath, report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.ok !== true) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
