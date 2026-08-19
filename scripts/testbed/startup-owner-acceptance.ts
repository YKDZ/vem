#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODES = new Set(["fast", "full"]);
const MANIFEST_SCHEMA = "vem-runtime-owners/v1";
const REPORT_SCHEMA = "vem-installed-runtime-startup-acceptance/v1";

function required(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function canonicalTimestamp(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
    new Date(value).toISOString() !== value
  ) {
    throw new Error(`${label} must be a canonical UTC timestamp`);
  }
  return value;
}

function validateModeEvidence(evidence, mode, sessionId) {
  const modeEvidence = evidence?.modeEvidence;
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
  if (modeEvidence.source !== "windows_reboot_logon_probe") {
    throw new Error(
      "full startup requires Windows reboot/logon probe evidence",
    );
  }
  if (
    modeEvidence.logon?.user !== "VEMKiosk" ||
    modeEvidence.logon?.sessionId !== sessionId
  ) {
    throw new Error(
      "full startup logon identity must match the active VEMKiosk session",
    );
  }
  return {
    source: modeEvidence.source,
    bootMarker: required(modeEvidence.boot?.marker, "full reboot boot marker"),
    bootObservedAt: canonicalTimestamp(
      modeEvidence.boot?.observedAt,
      "full reboot observation",
    ),
    logonMarker: required(modeEvidence.logon?.marker, "full logon marker"),
    logonObservedAt: canonicalTimestamp(
      modeEvidence.logon?.observedAt,
      "full logon observation",
    ),
  };
}

function assertOwner(manifest, key, expected) {
  const owner = manifest?.[key];
  for (const [field, value] of Object.entries(expected)) {
    if (owner?.[field] !== value) {
      throw new Error(`${key} owner ${field} must be ${value}`);
    }
  }
  return owner;
}

function taskHasStartedState(taskState) {
  return taskState === "Ready" || taskState === "Running";
}

export function validateStartupOwnerReadinessEvidence(evidence, mode = "fast") {
  if (evidence?.schemaVersion !== REPORT_SCHEMA) {
    throw new Error("startup owner readiness schema is invalid");
  }
  const manifest = evidence.ownerManifest;
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA) {
    throw new Error("runtime owner manifest schema is invalid");
  }
  const daemonOwner = assertOwner(manifest?.owners, "daemon", {
    name: "VemVendingDaemon",
    account: "LocalSystem",
    startType: "Automatic",
  });
  const machineUiOwner = assertOwner(manifest?.owners, "machineUi", {
    name: "VEMMachineUI",
    trigger: "AtLogon",
    user: "VEMKiosk",
  });
  const visionOwner = assertOwner(manifest?.owners, "vision", {
    name: "VEMVisionRuntime",
    trigger: "AtLogon",
    user: "VEMKiosk",
  });
  const observation = evidence.observation;
  if (observation?.source !== "windows_service_task_process_session_probe") {
    throw new Error("startup owner readiness must use the Windows owner probe");
  }
  if (observation?.daemon?.status !== "Running") {
    throw new Error("daemon service is not running");
  }
  if (observation.daemon?.processCount !== 1) {
    throw new Error("daemon process count must be exactly one");
  }
  if (observation.daemon?.ready !== true) {
    throw new Error("daemon is not ready");
  }
  if (
    observation?.kioskSession?.user !== "VEMKiosk" ||
    observation.kioskSession?.active !== true
  ) {
    throw new Error("active interactive session must belong to VEMKiosk");
  }
  const sessionId = positiveInteger(
    observation.kioskSession?.sessionId,
    "VEMKiosk sessionId",
  );
  if (
    !taskHasStartedState(observation?.machineUi?.taskState) ||
    observation.machineUi?.processCount !== 1 ||
    observation.machineUi?.sessionId !== sessionId ||
    observation.machineUi?.route !== "#/catalog"
  ) {
    throw new Error(
      "Machine UI must run in the active VEMKiosk session and reach Catalog",
    );
  }
  if (
    !taskHasStartedState(observation?.vision?.taskState) ||
    observation.vision?.processCount !== 1 ||
    observation.vision?.sessionId !== sessionId
  ) {
    throw new Error("Vision must run in the active VEMKiosk session");
  }
  const visionWorkerCount = observation.vision?.workerCount;
  if (
    visionWorkerCount !== undefined &&
    (!Number.isSafeInteger(visionWorkerCount) || visionWorkerCount < 0)
  ) {
    throw new Error("Vision worker count must be a non-negative integer");
  }
  return {
    daemonService: daemonOwner.name,
    machineUiTask: machineUiOwner.name,
    visionTask: visionOwner.name,
    kioskSessionId: sessionId,
    catalogRoute: observation.machineUi.route,
    modeEvidence: validateModeEvidence(evidence, mode, sessionId),
  };
}

export function runStartupOwnerAcceptance({ mode, handoff, fixtureKey }) {
  if (!MODES.has(mode)) throw new Error("startup mode must be fast or full");
  if (fixtureKey !== "startup") {
    throw new Error(
      "startup owner acceptance requires the startup fixture key",
    );
  }
  const evidence = handoff?.startupOwnerReadiness;
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

export function startupArtifactDirectory(outPath) {
  return join(dirname(resolve(outPath)), "startup-owner-readiness-artifacts");
}

function option(args, name) {
  const index = args.indexOf(`--${name}`);
  return required(index < 0 ? undefined : args[index + 1], `--${name}`);
}

async function main() {
  const args = process.argv.slice(2);
  const mode = option(args, "mode");
  const handoffPath = option(args, "handoff");
  const outPath = option(args, "out");
  const fixtureKey = option(args, "fixture-key");
  option(args, "guest-input");
  if (!isAbsolute(handoffPath) || !isAbsolute(outPath)) {
    throw new Error("--handoff and --out must be absolute paths");
  }
  const handoff = JSON.parse(await readFile(handoffPath, "utf8"));
  const report = runStartupOwnerAcceptance({ mode, handoff, fixtureKey });
  await mkdir(startupArtifactDirectory(outPath), { recursive: true });
  await writeFile(resolve(outPath), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (!report.ok) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
