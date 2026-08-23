#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODES = new Set(["fast", "full"]);
const MANIFEST_SCHEMA = "vem-runtime-owners/v1";
const REPORT_SCHEMA = "vem-installed-runtime-startup-acceptance/v1";

type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function required(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function validateModeEvidence(
  evidence: JsonRecord,
  mode: string,
  sessionId: number,
): JsonRecord {
  const modeEvidence = recordValue(evidence?.modeEvidence);
  if (modeEvidence?.mode !== mode) {
    throw new Error(`startup mode evidence must declare ${mode} mode`);
  }
  if (mode === "fast") {
    if (modeEvidence.source !== "installed_owner_stop_start") {
      throw new Error(
        "fast startup requires installed owner stop/start evidence",
      );
    }
    return {
      source: modeEvidence.source,
      ownerRestartMarker: required(
        modeEvidence.ownerRestartMarker,
        "fast owner restart marker",
      ),
    };
  }
  const logon = recordValue(modeEvidence.logon);
  const boot = recordValue(modeEvidence.boot);
  if (modeEvidence.source !== "windows_reboot_logon_probe") {
    throw new Error(
      "full startup requires Windows reboot/logon probe evidence",
    );
  }
  if (logon?.user !== "VEMKiosk" || logon?.sessionId !== sessionId) {
    throw new Error(
      "full startup logon identity must match the active VEMKiosk session",
    );
  }
  return {
    source: modeEvidence.source,
    bootMarker: required(boot?.marker, "full reboot boot marker"),
    bootObservedAt: canonicalTimestamp(
      boot?.observedAt,
      "full reboot observation",
    ),
    logonMarker: required(logon?.marker, "full logon marker"),
    logonObservedAt: canonicalTimestamp(
      logon?.observedAt,
      "full logon observation",
    ),
  };
}

function assertOwner(
  manifest: JsonRecord,
  key: string,
  expected: JsonRecord,
): JsonRecord {
  const owner = recordValue(manifest?.[key]);
  for (const [field, value] of Object.entries(expected)) {
    if (owner?.[field] !== value) {
      throw new Error(`${key} owner ${field} must be ${value}`);
    }
  }
  return owner;
}

function taskHasStartedState(taskState: unknown): boolean {
  return taskState === "Ready" || taskState === "Running";
}

export function validateStartupOwnerReadinessEvidence(
  evidence: JsonRecord,
  mode = "fast",
): JsonRecord {
  if (evidence?.schemaVersion !== REPORT_SCHEMA) {
    throw new Error("startup owner readiness schema is invalid");
  }
  const manifest = recordValue(evidence.ownerManifest);
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA) {
    throw new Error("runtime owner manifest schema is invalid");
  }
  const daemonOwner = assertOwner(recordValue(manifest.owners), "daemon", {
    name: "VemVendingDaemon",
    account: "LocalSystem",
    startType: "Automatic",
  });
  const machineUiOwner = assertOwner(
    recordValue(manifest.owners),
    "machineUi",
    {
      name: "VEMMachineUI",
      trigger: "AtLogon",
      user: "VEMKiosk",
    },
  );
  const visionOwner = assertOwner(recordValue(manifest.owners), "vision", {
    name: "VEMVisionRuntime",
    trigger: "AtLogon",
    user: "VEMKiosk",
  });
  const observation = recordValue(evidence.observation);
  const observationDaemon = recordValue(observation.daemon);
  const observationKioskSession = recordValue(observation.kioskSession);
  const observationMachineUi = recordValue(observation.machineUi);
  const observationVision = recordValue(observation.vision);
  if (observation?.source !== "windows_service_task_process_session_probe") {
    throw new Error("startup owner readiness must use the Windows owner probe");
  }
  if (observationDaemon?.status !== "Running") {
    throw new Error("daemon service is not running");
  }
  if (Number(observationDaemon?.processCount) !== 1) {
    throw new Error("daemon process count must be exactly one");
  }
  if (observationDaemon?.ready !== true) {
    throw new Error("daemon is not ready");
  }
  if (
    observationKioskSession?.user !== "VEMKiosk" ||
    observationKioskSession?.active !== true
  ) {
    throw new Error("active interactive session must belong to VEMKiosk");
  }
  const sessionId = positiveInteger(
    observationKioskSession?.sessionId,
    "VEMKiosk sessionId",
  );
  if (
    !taskHasStartedState(observationMachineUi?.taskState) ||
    Number(observationMachineUi?.processCount) !== 1 ||
    observationMachineUi?.sessionId !== sessionId ||
    observationMachineUi?.route !== "#/catalog"
  ) {
    throw new Error(
      "Machine UI must run in the active VEMKiosk session and reach Catalog",
    );
  }
  if (
    !taskHasStartedState(observationVision?.taskState) ||
    Number(observationVision?.processCount) !== 1 ||
    observationVision?.sessionId !== sessionId
  ) {
    throw new Error("Vision must run in the active VEMKiosk session");
  }
  const visionWorkerCount = observationVision?.workerCount;
  if (
    visionWorkerCount !== undefined &&
    (!Number.isSafeInteger(Number(visionWorkerCount)) ||
      Number(visionWorkerCount) < 0)
  ) {
    throw new Error("Vision worker count must be a non-negative integer");
  }
  return {
    daemonService: daemonOwner.name,
    machineUiTask: machineUiOwner.name,
    visionTask: visionOwner.name,
    kioskSessionId: sessionId,
    catalogRoute: observationMachineUi.route,
    modeEvidence: validateModeEvidence(evidence, mode, sessionId),
  };
}

export function runStartupOwnerAcceptance({
  mode,
  handoff,
  fixtureKey,
}: {
  mode: string;
  handoff: JsonRecord;
  fixtureKey: string;
}): JsonRecord {
  if (!MODES.has(mode)) throw new Error("startup mode must be fast or full");
  if (fixtureKey !== "startup") {
    throw new Error(
      "startup owner acceptance requires the startup fixture key",
    );
  }
  const evidence = recordValue(handoff?.startupOwnerReadiness);
  if (!evidence) {
    return {
      schemaVersion: REPORT_SCHEMA,
      ok: false,
      mode,
      diagnostics: ["startup owner readiness projection is absent"],
    };
  }
  try {
    return {
      schemaVersion: REPORT_SCHEMA,
      ok: true,
      mode,
      summary: validateStartupOwnerReadinessEvidence(evidence, mode),
    };
  } catch (error) {
    return {
      schemaVersion: REPORT_SCHEMA,
      ok: false,
      mode,
      diagnostics: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function startupArtifactDirectory(outPath: string): string {
  return join(dirname(resolve(outPath)), "startup-owner-readiness-artifacts");
}

function option(args: string[], name: string): string {
  const index = args.indexOf(`--${name}`);
  return required(index < 0 ? undefined : args[index + 1], `--${name}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode = option(args, "mode");
  const handoffPath = option(args, "handoff");
  const outPath = option(args, "out");
  const fixtureKey = option(args, "fixture-key");
  option(args, "guest-input");
  if (!isAbsolute(handoffPath) || !isAbsolute(outPath)) {
    throw new Error("--handoff and --out must be absolute paths");
  }
  const handoff = JSON.parse(await readFile(handoffPath, "utf8")) as JsonRecord;
  const report = runStartupOwnerAcceptance({ mode, handoff, fixtureKey });
  await mkdir(startupArtifactDirectory(outPath), { recursive: true });
  await writeFile(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.ok !== true) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
