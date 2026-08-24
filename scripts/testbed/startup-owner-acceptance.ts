#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MODES = new Set(["fast", "full"]);
const MANIFEST_SCHEMA = "vem-runtime-owners/v1";
const REPORT_SCHEMA = "vem-installed-runtime-startup-acceptance/v1";

type JsonRecord = Record<string, unknown>;

class StartupEvidenceError extends Error {
  readonly failedStage: string;
  readonly reasonCode: string;

  constructor(failedStage: string, reasonCode: string, message: string) {
    super(message);
    this.failedStage = failedStage;
    this.reasonCode = reasonCode;
  }
}

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    const record = value as JsonRecord;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonicalJson(record[key])]),
    );
  }
  return value;
}

function ownerConfigurationSha256(manifest: JsonRecord): string {
  const { installedAt: _installedAt, ...configuration } = manifest;
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(configuration)))
    .digest("hex");
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

function observedTimestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new Error(`${label} must be a UTC timestamp`);
  }
  return value;
}

function failStartup(
  failedStage: string,
  reasonCode: string,
  message: string,
): never {
  throw new StartupEvidenceError(failedStage, reasonCode, message);
}

function validateFullOwnerTask(
  task: JsonRecord,
  {
    key,
    name,
    failedStage,
    bootStartedAt,
  }: {
    key: string;
    name: string;
    failedStage: string;
    bootStartedAt: string;
  },
): JsonRecord {
  if (task?.name !== name) {
    failStartup(
      failedStage,
      "task_evidence_invalid",
      `${key} task name is invalid`,
    );
  }
  if (!taskHasStartedState(task?.state)) {
    failStartup(
      failedStage,
      "task_not_started",
      `${name} task state does not show a started owner`,
    );
  }
  let lastRunTime: string;
  try {
    lastRunTime = canonicalTimestamp(
      task?.lastRunTime,
      `${name} task last run time`,
    );
  } catch {
    failStartup(
      failedStage,
      "task_not_triggered_after_reboot",
      `${name} has no canonical post-reboot run time`,
    );
  }
  if (Date.parse(lastRunTime) < Date.parse(bootStartedAt)) {
    failStartup(
      failedStage,
      "task_not_triggered_after_reboot",
      `${name} last ran before the accepted reboot`,
    );
  }
  const lastTaskResult = Number(task?.lastTaskResult);
  if (
    !Number.isSafeInteger(lastTaskResult) ||
    lastTaskResult < 0 ||
    lastTaskResult > 0xffffffff
  ) {
    failStartup(
      failedStage,
      "task_result_unavailable",
      `${name} task result is unavailable`,
    );
  }
  const runningResult = 0x00041301;
  if (
    lastTaskResult !== 0 &&
    !(task.state === "Running" && lastTaskResult === runningResult)
  ) {
    failStartup(
      failedStage,
      "task_action_failed",
      `${name} action failed with 0x${lastTaskResult
        .toString(16)
        .toUpperCase()
        .padStart(8, "0")}`,
    );
  }
  return {
    name,
    state: task.state,
    lastRunTime,
    lastTaskResult,
  };
}

function validateModeEvidence(
  evidence: JsonRecord,
  manifest: JsonRecord,
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
  const installedAt = observedTimestamp(
    manifest?.installedAt,
    "runtime owner installation",
  );
  const bootStartedAt = canonicalTimestamp(
    boot?.startedAt,
    "full reboot start",
  );
  if (Date.parse(bootStartedAt) <= Date.parse(installedAt)) {
    failStartup(
      "boot",
      "reboot_not_after_owner_install",
      "full startup requires a reboot after the runtime owners were installed",
    );
  }
  const tasks = recordValue(modeEvidence.tasks);
  const machineUiTask = validateFullOwnerTask(recordValue(tasks.machineUi), {
    key: "machineUi",
    name: "VEMMachineUI",
    failedStage: "machine_ui_owner",
    bootStartedAt,
  });
  const visionTask = validateFullOwnerTask(recordValue(tasks.vision), {
    key: "vision",
    name: "VEMVisionRuntime",
    failedStage: "vision_owner",
    bootStartedAt,
  });
  return {
    source: modeEvidence.source,
    bootMarker: required(boot?.marker, "full reboot boot marker"),
    bootStartedAt,
    bootObservedAt: canonicalTimestamp(
      boot?.observedAt,
      "full reboot observation",
    ),
    logonMarker: required(logon?.marker, "full logon marker"),
    logonObservedAt: canonicalTimestamp(
      logon?.observedAt,
      "full logon observation",
    ),
    tasks: { machineUi: machineUiTask, vision: visionTask },
  };
}

function validateVisionReadiness(value: unknown): JsonRecord {
  const readiness = recordValue(value);
  const health = recordValue(readiness.health);
  const handshake = recordValue(readiness.handshake);
  if (
    !["ok", "degraded"].includes(String(health.status)) ||
    health.protocol !== "vem.vision.v2" ||
    health.module !== "vision" ||
    health.mockScenario !== "off" ||
    handshake.protocol !== "vem.vision.v2" ||
    handshake.type !== "vision.ready"
  ) {
    failStartup(
      "vision_readiness",
      "vision_protocol_invalid",
      "Vision health and ready handshake must use the generated V2 protocol",
    );
  }
  if (health.cameraReady !== true || handshake.cameraReady !== true) {
    failStartup(
      "vision_readiness",
      "vision_camera_not_ready",
      "Vision camera readiness is not true after startup",
    );
  }
  if (handshake.tryOnReady !== true) {
    failStartup(
      "vision_readiness",
      "vision_try_on_not_ready",
      "Vision try-on readiness is not true after startup",
    );
  }
  if (
    handshake.visionBusinessReady !== true ||
    handshake.businessReadinessDiagnostic !== "ready"
  ) {
    failStartup(
      "vision_readiness",
      "vision_business_not_ready",
      "Vision business readiness is not ready after startup",
    );
  }
  const capabilities = Array.isArray(handshake.capabilities)
    ? handshake.capabilities
    : [];
  const requiredCapabilities = [
    "profile_push",
    "presence_status",
    "person_departed",
    "try_on",
  ];
  if (
    capabilities.some(
      (capability) =>
        typeof capability !== "string" ||
        capability.trim() === "" ||
        capability.length > 64,
    ) ||
    requiredCapabilities.some(
      (capability) => !capabilities.includes(capability),
    )
  ) {
    failStartup(
      "vision_readiness",
      "vision_capability_incomplete",
      "Vision ready handshake is missing a required V2 capability",
    );
  }
  try {
    required(handshake.messageId, "Vision ready message ID");
    observedTimestamp(handshake.timestamp, "Vision ready timestamp");
    required(handshake.serverName, "Vision ready server name");
    required(handshake.schemaVersion, "Vision ready schema version");
    required(handshake.bundleVersion, "Vision ready bundle version");
  } catch {
    failStartup(
      "vision_readiness",
      "vision_handshake_incomplete",
      "Vision ready handshake identity is incomplete",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(String(handshake.contractDigest ?? ""))) {
    failStartup(
      "vision_readiness",
      "vision_contract_digest_invalid",
      "Vision ready contract digest is invalid",
    );
  }
  return {
    protocol: handshake.protocol,
    cameraReady: true,
    tryOnReady: true,
    visionBusinessReady: true,
    capabilities,
    contractDigest: handshake.contractDigest,
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

function validateOwnerLaunchResult(
  value: unknown,
  {
    role,
    processId,
    failedStage,
  }: { role: string; processId: number; failedStage: string },
): JsonRecord {
  const result = recordValue(value);
  if (
    result.schemaVersion !== "vem-runtime-owner-launch-result/v1" ||
    result.role !== role ||
    result.adapter !== "scheduled_task"
  ) {
    failStartup(
      failedStage,
      "owner_launch_result_invalid",
      `${role} launcher result identity is invalid`,
    );
  }
  if (result.status !== "ready") {
    failStartup(
      failedStage,
      "owner_launch_failed",
      `${role} launcher failed at ${String(result.failedStage ?? "unknown")} with ${String(result.reasonCode ?? "unknown")}`,
    );
  }
  if (
    !["owner_started", "owner_already_ready"].includes(
      String(result.reasonCode),
    ) ||
    result.failedStage !== null ||
    Number(result.processId) !== processId ||
    recordValue(result.readiness).processStable !== true
  ) {
    failStartup(
      failedStage,
      "owner_launch_result_invalid",
      `${role} launcher did not terminate on the observed ready owner`,
    );
  }
  const invocationId = required(result.invocationId, `${role} invocation ID`);
  if (!/^[a-f0-9]{32}$/i.test(invocationId)) {
    failStartup(
      failedStage,
      "owner_launch_result_invalid",
      `${role} launcher invocation ID is invalid`,
    );
  }
  let startedAt: string;
  let finishedAt: string;
  try {
    startedAt = canonicalTimestamp(result.startedAt, `${role} launch start`);
    finishedAt = canonicalTimestamp(result.finishedAt, `${role} launch finish`);
  } catch {
    failStartup(
      failedStage,
      "owner_launch_result_invalid",
      `${role} launcher timestamps are invalid`,
    );
  }
  if (Date.parse(finishedAt) < Date.parse(startedAt)) {
    failStartup(
      failedStage,
      "owner_launch_result_invalid",
      `${role} launcher finished before it started`,
    );
  }
  return {
    role,
    invocationId,
    startedAt,
    finishedAt,
    reasonCode: result.reasonCode,
    processId,
  };
}

function validateOwnerReentry(
  value: unknown,
  machineUiProcessId: number,
  visionProcessId: number,
): JsonRecord {
  const reentry = recordValue(value);
  if (
    reentry.source !== "installed_scheduled_task_reentry" ||
    reentry.requestsPerRole !== 2
  ) {
    failStartup(
      "owner_reentry",
      "owner_reentry_evidence_invalid",
      "fast startup owner reentry evidence is invalid",
    );
  }
  const checks: Array<{
    key: string;
    processId: number;
    failedStage: string;
  }> = [
    {
      key: "machineUi",
      processId: machineUiProcessId,
      failedStage: "machine_ui_owner",
    },
    { key: "vision", processId: visionProcessId, failedStage: "vision_owner" },
  ];
  for (const check of checks) {
    const observed = recordValue(reentry[check.key]);
    if (
      Number(observed.beforeProcessId) !== check.processId ||
      Number(observed.afterProcessId) !== check.processId
    ) {
      failStartup(
        check.failedStage,
        "owner_reentry_replaced_process",
        `${check.key} task reentry replaced or duplicated the canonical process`,
      );
    }
    if (observed.invocationChanged !== true) {
      failStartup(
        check.failedStage,
        "owner_reentry_not_observed",
        `${check.key} task reentry did not produce a new launcher result`,
      );
    }
  }
  return {
    source: reentry.source,
    requestsPerRole: 2,
    machineUiProcessId,
    visionProcessId,
  };
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
  const ownerInstalledAt = observedTimestamp(
    manifest.installedAt,
    "runtime owner installation",
  );
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
  const machineUiProcessId = positiveInteger(
    observationMachineUi?.processId,
    "Machine UI processId",
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
  const visionProcessId = positiveInteger(
    observationVision?.processId,
    "Vision processId",
  );
  if (
    visionWorkerCount !== undefined &&
    (!Number.isSafeInteger(Number(visionWorkerCount)) ||
      Number(visionWorkerCount) < 0)
  ) {
    throw new Error("Vision worker count must be a non-negative integer");
  }
  const visionReadiness = validateVisionReadiness(observationVision.readiness);
  const ownerLaunch = recordValue(observation.ownerLaunch);
  const machineUiLaunch = validateOwnerLaunchResult(ownerLaunch.machineUi, {
    role: "machine-ui",
    processId: machineUiProcessId,
    failedStage: "machine_ui_owner",
  });
  const visionLaunch = validateOwnerLaunchResult(ownerLaunch.vision, {
    role: "vision",
    processId: visionProcessId,
    failedStage: "vision_owner",
  });
  const validatedModeEvidence = validateModeEvidence(
    evidence,
    manifest,
    mode,
    sessionId,
  );
  if (mode === "full") {
    const bootStartedAt = String(validatedModeEvidence.bootStartedAt);
    for (const launch of [machineUiLaunch, visionLaunch]) {
      if (Date.parse(String(launch.startedAt)) < Date.parse(bootStartedAt)) {
        failStartup(
          launch.role === "vision" ? "vision_owner" : "machine_ui_owner",
          "owner_launch_before_reboot",
          `${String(launch.role)} launcher result predates the accepted reboot`,
        );
      }
    }
  }
  const ownerReentry =
    mode === "fast"
      ? validateOwnerReentry(
          observation.ownerReentry,
          machineUiProcessId,
          visionProcessId,
        )
      : undefined;
  if (
    mode === "fast" &&
    (machineUiLaunch.reasonCode !== "owner_already_ready" ||
      visionLaunch.reasonCode !== "owner_already_ready")
  ) {
    failStartup(
      "owner_reentry",
      "owner_reentry_result_invalid",
      "fast startup did not finish on reused canonical owner results",
    );
  }
  return {
    daemonService: daemonOwner.name,
    machineUiTask: machineUiOwner.name,
    visionTask: visionOwner.name,
    kioskSessionId: sessionId,
    catalogRoute: observationMachineUi.route,
    ownerInstalledAt,
    ownerConfigurationSha256: ownerConfigurationSha256(manifest),
    visionReadiness,
    ownerLaunch: { machineUi: machineUiLaunch, vision: visionLaunch },
    ...(ownerReentry ? { ownerReentry } : {}),
    modeEvidence: validatedModeEvidence,
  };
}

export function runStartupOwnerAcceptance({
  mode,
  handoff,
  fixtureKey,
  commit,
}: {
  mode: string;
  handoff: JsonRecord;
  fixtureKey: string;
  commit?: string;
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
      ...(commit ? { commit } : {}),
      diagnostics: ["startup owner readiness projection is absent"],
    };
  }
  try {
    return {
      schemaVersion: REPORT_SCHEMA,
      ok: true,
      mode,
      ...(commit ? { commit } : {}),
      summary: validateStartupOwnerReadinessEvidence(evidence, mode),
    };
  } catch (error) {
    const startupError =
      error instanceof StartupEvidenceError ? error : undefined;
    return {
      schemaVersion: REPORT_SCHEMA,
      ok: false,
      mode,
      ...(commit ? { commit } : {}),
      failedStage: startupError?.failedStage ?? "evidence",
      reasonCode: startupError?.reasonCode ?? "startup_evidence_invalid",
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
  const guestInputPath = option(args, "guest-input");
  if (!isAbsolute(handoffPath) || !isAbsolute(outPath)) {
    throw new Error("--handoff and --out must be absolute paths");
  }
  const handoff = JSON.parse(await readFile(handoffPath, "utf8")) as JsonRecord;
  const guestInput = JSON.parse(
    await readFile(guestInputPath, "utf8"),
  ) as JsonRecord;
  const commit = required(
    recordValue(guestInput.workflowIdentity).githubSha,
    "guest input workflow commit",
  ).toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error("guest input workflow commit must be a full Git SHA");
  }
  const report = runStartupOwnerAcceptance({
    mode,
    handoff,
    fixtureKey,
    commit,
  });
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
