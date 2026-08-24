#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPORT_SCHEMA = "vem-installed-runtime-startup-acceptance/v1";
const STABILITY_SCHEMA = "vem-startup-reboot-stability/v1";
const MINIMUM_OBSERVATIONS = 10;

type JsonRecord = Record<string, unknown>;

export interface StartupRebootObservationInput {
  source: string;
  pass: number;
  reportPath: string;
  report: JsonRecord;
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function repeatableOption(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== `--${name}`) continue;
    values.push(required(args[index + 1], `--${name}`));
    index += 1;
  }
  return values;
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  return required(index < 0 ? undefined : args[index + 1], `--${name}`);
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function validSha(value: unknown, length: number): value is string {
  return (
    typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value)
  );
}

function observationFailure(
  ordinal: number,
  input: StartupRebootObservationInput,
  message: string,
): JsonRecord {
  const report = recordValue(input.report);
  return {
    observation: ordinal,
    source: input.source,
    pass: input.pass,
    reportPath: input.reportPath,
    ok: false,
    failedStage: report.failedStage ?? "evidence",
    reasonCode: report.reasonCode ?? "startup_observation_invalid",
    diagnostics: arrayValue(report.diagnostics),
    message,
  };
}

export function buildStartupRebootStabilityReport({
  commit,
  observations = [],
}: {
  commit?: unknown;
  observations?: StartupRebootObservationInput[];
} = {}): JsonRecord {
  const expectedCommit = required(commit, "commit").toLowerCase();
  if (!validSha(expectedCommit, 40)) {
    throw new Error("commit must be a full 40-character Git SHA");
  }
  const gateFailures: string[] = [];
  const normalized: JsonRecord[] = [];
  let firstFailure: JsonRecord | null = null;

  for (const [index, input] of observations.entries()) {
    const ordinal = index + 1;
    const report = recordValue(input.report);
    let failureMessage: string | null = null;
    if (report.schemaVersion !== REPORT_SCHEMA) {
      failureMessage = `observation ${ordinal} schema is invalid`;
    } else if (report.ok !== true) {
      failureMessage = `observation ${ordinal} failed`;
    } else if (report.mode !== "full") {
      failureMessage = `observation ${ordinal} is not full mode`;
    } else if (report.commit !== expectedCommit) {
      failureMessage = `observation ${ordinal} commit differs from the gate commit`;
    } else if (
      input.source !== "reconstructed_full_pass" &&
      input.source !== "same_install_repeat"
    ) {
      failureMessage = `observation ${ordinal} source is invalid`;
    } else if (input.pass !== 1 && input.pass !== 2) {
      failureMessage = `observation ${ordinal} pass is invalid`;
    }
    const summary = recordValue(report.summary);
    const modeEvidence = recordValue(summary.modeEvidence);
    const ownerInstalledAt = summary.ownerInstalledAt;
    const ownerConfigurationSha256 = summary.ownerConfigurationSha256;
    const bootMarker = modeEvidence.bootMarker;
    if (!failureMessage && !validSha(ownerConfigurationSha256, 64)) {
      failureMessage = `observation ${ordinal} owner configuration digest is invalid`;
    }
    if (
      !failureMessage &&
      (typeof ownerInstalledAt !== "string" ||
        Number.isNaN(Date.parse(ownerInstalledAt)))
    ) {
      failureMessage = `observation ${ordinal} owner installation time is invalid`;
    }
    if (
      !failureMessage &&
      (modeEvidence.source !== "windows_reboot_logon_probe" ||
        typeof bootMarker !== "string" ||
        bootMarker.trim() === "")
    ) {
      failureMessage = `observation ${ordinal} reboot evidence is invalid`;
    }
    if (failureMessage) {
      const failure = observationFailure(ordinal, input, failureMessage);
      normalized.push(failure);
      gateFailures.push(failureMessage);
      firstFailure ??= failure;
      continue;
    }
    normalized.push({
      observation: ordinal,
      source: input.source,
      pass: input.pass,
      reportPath: input.reportPath,
      ok: true,
      commit: report.commit,
      ownerInstalledAt,
      ownerConfigurationSha256,
      bootMarker,
      bootStartedAt: modeEvidence.bootStartedAt ?? null,
      bootObservedAt: modeEvidence.bootObservedAt ?? null,
    });
  }

  if (observations.length < MINIMUM_OBSERVATIONS) {
    gateFailures.push(
      `startup release requires at least ${MINIMUM_OBSERVATIONS} reboot observations`,
    );
  }
  const reconstructed = normalized.filter(
    (entry) => entry.source === "reconstructed_full_pass",
  );
  const repeats = normalized.filter(
    (entry) => entry.source === "same_install_repeat",
  );
  if (
    reconstructed.length !== 2 ||
    !reconstructed.some((entry) => entry.pass === 1) ||
    !reconstructed.some((entry) => entry.pass === 2)
  ) {
    gateFailures.push(
      "startup release requires reconstructed full pass 1 and pass 2 observations",
    );
  }
  const accepted = normalized.filter((entry) => entry.ok === true);
  const configurationDigests = new Set(
    accepted.map((entry) => entry.ownerConfigurationSha256),
  );
  if (configurationDigests.size > 1) {
    gateFailures.push(
      "startup owner configuration differs between observations",
    );
  }
  const bootMarkers = accepted.map((entry) => entry.bootMarker);
  if (new Set(bootMarkers).size !== bootMarkers.length) {
    gateFailures.push("startup reboot boot marker is not unique");
  }
  const reconstructedPassOne = reconstructed.find(
    (entry) => entry.pass === 1 && entry.ok === true,
  );
  const reconstructedPassTwo = reconstructed.find(
    (entry) => entry.pass === 2 && entry.ok === true,
  );
  if (
    reconstructedPassOne &&
    reconstructedPassTwo &&
    reconstructedPassOne.ownerInstalledAt ===
      reconstructedPassTwo.ownerInstalledAt
  ) {
    gateFailures.push("two reconstructed passes reused one owner installation");
  }
  if (
    reconstructedPassTwo &&
    repeats.some(
      (entry) =>
        entry.ok === true &&
        entry.ownerInstalledAt !== reconstructedPassTwo.ownerInstalledAt,
    )
  ) {
    gateFailures.push(
      "same-install reboot observations changed the pass 2 owner installation",
    );
  }
  if (repeats.length < MINIMUM_OBSERVATIONS - 2) {
    gateFailures.push(
      "startup release is missing same-install repeat observations",
    );
  }

  return {
    schemaVersion: STABILITY_SCHEMA,
    commit: expectedCommit,
    ok: gateFailures.length === 0,
    minimumSampleCount: MINIMUM_OBSERVATIONS,
    sampleCount: observations.length,
    reconstructedPassCount: reconstructed.length,
    sameInstallRepeatCount: repeats.length,
    observationListSha256: sha256(normalized),
    observations: normalized,
    firstFailure,
    gateFailures,
  };
}

function loadReport(path: string): JsonRecord {
  return JSON.parse(readFileSync(path, "utf8")) as JsonRecord;
}

function writeJson(path: string, value: JsonRecord): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const passOnePath = option(args, "reconstructed-pass-one");
  const passTwoPath = option(args, "reconstructed-pass-two");
  const repeatPaths = repeatableOption(args, "same-install-repeat");
  const observations: StartupRebootObservationInput[] = [
    {
      source: "reconstructed_full_pass",
      pass: 1,
      reportPath: passOnePath,
      report: loadReport(passOnePath),
    },
    {
      source: "reconstructed_full_pass",
      pass: 2,
      reportPath: passTwoPath,
      report: loadReport(passTwoPath),
    },
    ...repeatPaths.map((reportPath) => ({
      source: "same_install_repeat",
      pass: 2,
      reportPath,
      report: loadReport(reportPath),
    })),
  ];
  const report = buildStartupRebootStabilityReport({
    commit: option(args, "commit"),
    observations,
  });
  writeJson(option(args, "out"), report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.ok !== true) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
