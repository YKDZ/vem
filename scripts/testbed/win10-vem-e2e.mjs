#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  CdpClient,
  activateVisibleSelector,
  captureCheckpoint,
  discoverMachineUiTarget,
  enablePageRuntime,
  evaluateExpression,
  openMachineUiCdpSidecar,
  rewriteWebSocketDebuggerUrl,
  runVisibleMachineSaleScenario,
  waitForRoute,
} from "./machine-ui-cdp-driver.mjs";
import { validateSerialConformanceReport } from "./vm-host-adapter-serial-conformance.mjs";

const VEM_RESET_ROOTS = [
  "C:\\VEM\\bringup",
  "C:\\VEM\\updates",
  "C:\\VEM\\vision",
  "C:\\ProgramData\\VEM\\vending-daemon",
];

const VEM_RESET_FILES = [
  "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json",
];

const PROTECTED_PATH_PREFIXES = [
  "C:\\Windows",
  "C:\\Program Files\\Tailscale",
  "C:\\Program Files\\OpenSSH",
  "C:\\Program Files (x86)\\Microsoft\\EdgeWebView",
  "C:\\Users\\Admin",
  "C:\\ProgramData\\Tailscale",
  "C:\\ProgramData\\ssh",
];

const PROTECTED_SERVICE_NAMES = new Set(["tailscale", "sshd"]);
const TESTBED_PROVISIONING_EVIDENCE_FILE =
  "C:\\ProgramData\\VEM\\vending-daemon\\testbed-provisioning-evidence.json";
const RUNTIME_ACCEPTANCE_REPORT_FILE =
  "C:\\ProgramData\\VEM\\vending-daemon\\runtime-acceptance-report.json";
const SIMULATED_HARDWARE_SALE_FLOW_REPORT_FILE =
  "C:\\ProgramData\\VEM\\vending-daemon\\simulated-hardware-sale-flow.json";
const SIMULATED_HARDWARE_SALE_CONTEXT_FILE =
  "C:\\ProgramData\\VEM\\vending-daemon\\simulated-hardware-sale-context.json";
const INSTALLED_KIOSK_SALE_DEBUG_TASK = "VEMInstalledKioskSaleDebug";
const INSTALLED_KIOSK_SALE_DEBUG_LAUNCHER =
  "C:\\VEM\\bringup\\launch-machine-ui-debug.vbs";
const INSTALLED_KIOSK_SALE_NORMAL_LAUNCHER =
  "C:\\VEM\\bringup\\launch-machine-ui.vbs";
const INSTALLED_KIOSK_SALE_MACHINE_PATH = "C:\\VEM\\bringup\\machine.exe";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const PLATFORM_TARGETS = {
  "vem-vps": {
    apiBaseUrl: "http://118.25.104.160:26849/api",
    mqttUrl: "mqtt://118.25.104.160:1883",
  },
};
const SHARED_PLATFORM_TARGET_MARKERS = ["vem-vps", "118.25.104.160"];
const KNOWN_PRODUCTION_DATABASE_NAMES = new Set([
  "vem",
  "vem_prod",
  "vem_production",
  "vem-vps",
  "vem_vps",
]);

const FINAL_PUBLIC_CONFIG_FIELDS = [
  "machineCode",
  "machineId",
  "machineName",
  "machineStatus",
  "machineLocationLabel",
  "mqttUsername",
  "mqttClientId",
  "runtimeEndpoints",
  "hardwareProfile",
  "paymentCapability",
  "provisioningMetadata",
];

const EXPECTED_KIOSK_USER = "VEMKiosk";
const EXPECTED_DAEMON_USER = "Admin";
const EXPECTED_DAEMON_PATH = "C:\\VEM\\bringup\\vending-daemon.exe";
const TESTBED_MACHINE_CODE_PREFIX = "VEM-TESTBED-";
const EXPECTED_MACHINE_UI_PATH = "C:\\VEM\\bringup\\machine.exe";
const EXPECTED_VISION_TASK_NAME = "VEM\\StartVisionServer";
const EXPECTED_VISION_COMMAND = "C:\\Windows\\System32\\cmd.exe";
const EXPECTED_VISION_LAUNCHER = "C:\\VEM\\bringup\\start_vision.bat";
const EXPECTED_VISION_WORKING_DIRECTORY = "C:\\VEM\\vision\\app";
const EXPECTED_VISION_WORK_DIRECTORY = "C:\\ProgramData\\VEM\\vision\\runtime";
const EXPECTED_VISION_ENTRYPOINT = "C:\\VEM\\vision\\app\\vending-vision.exe";
const DEFAULT_RUNTIME_REMOTE = "operator@runtime.test";
const ALLOWED_SCHEDULED_TASKS = new Set([
  "vemmachineui",
  "vem\\startvisionserver",
]);
const EXPECTED_PORTRAIT_WIDTH_PX = 1080;
const EXPECTED_PORTRAIT_HEIGHT_PX = 1920;
const DEFAULT_VM_ACCEPTANCE_MACHINE_CODE_PREFIX = "VEM-TESTBED-WINVM";
const DEFAULT_VM_ACCEPTANCE_EVIDENCE_ROOT = "artifacts/vm-runtime-acceptance";
const EPHEMERAL_DATABASE_URL_ENV = "VEM_EPHEMERAL_DATABASE_URL";
const INSTALLED_KIOSK_SALE_DATABASE_URL_ENV =
  "VEM_INSTALLED_KIOSK_SALE_DATABASE_URL";

export function nonQueryChildEnvironment(environment = process.env) {
  const childEnvironment = { ...environment };
  delete childEnvironment.DATABASE_URL;
  return childEnvironment;
}

export function assertTestbedMachineCode(machineCode) {
  if (!String(machineCode ?? "").startsWith("VEM-TESTBED-")) {
    throw new Error(
      `machine code must be a dedicated testbed identity: ${machineCode}`,
    );
  }
  return machineCode;
}

function isSharedPlatformTarget(value) {
  return SHARED_PLATFORM_TARGET_MARKERS.some((marker) =>
    String(value ?? "")
      .toLowerCase()
      .includes(marker),
  );
}

function normalizeEphemeralRunId(runId) {
  const normalized = String(runId ?? "")
    .trim()
    .toUpperCase()
    .replaceAll(/[^A-Z0-9-]/g, "-")
    .replaceAll(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (normalized.length === 0) {
    throw new Error("--run-id must contain letters or numbers");
  }
  if (normalized.length > 32) {
    throw new Error("--run-id must normalize to at most 32 characters");
  }
  if (normalized === "LOCAL" || normalized === "DEFAULT") {
    throw new Error("--run-id must be non-default");
  }
  return normalized;
}

function buildTestbedMachineCodeFromRun({
  machineCode,
  machineCodePrefix,
  runId,
} = {}) {
  if (machineCode) {
    return assertTestbedMachineCode(machineCode);
  }
  const prefix = String(
    machineCodePrefix ?? DEFAULT_VM_ACCEPTANCE_MACHINE_CODE_PREFIX,
  )
    .trim()
    .toUpperCase()
    .replace(/-+$/g, "");
  return assertTestbedMachineCode(
    `${prefix}-${normalizeEphemeralRunId(runId)}`,
  );
}

function buildEphemeralMachineCodeBinding(options = {}) {
  const canonicalRunId = normalizeEphemeralRunId(options.runId);
  const defaultPrefix = String(
    options.machineCodePrefix ?? DEFAULT_VM_ACCEPTANCE_MACHINE_CODE_PREFIX,
  )
    .trim()
    .toUpperCase()
    .replace(/-+$/g, "");

  if (options.machineCode) {
    const machineCode = assertTestbedMachineCode(
      String(options.machineCode).trim().toUpperCase(),
    );
    const suffix = `-${canonicalRunId}`;
    if (!machineCode.endsWith(suffix)) {
      throw new Error(
        "explicit --machine-code must end with canonical run id so ephemeral setup generates the same identity",
      );
    }
    const machineCodePrefix = machineCode.slice(0, -suffix.length);
    if (!machineCodePrefix.startsWith(TESTBED_MACHINE_CODE_PREFIX)) {
      throw new Error(
        `machine code prefix must be a dedicated testbed identity: ${machineCodePrefix}`,
      );
    }
    return { canonicalRunId, machineCode, machineCodePrefix };
  }

  return {
    canonicalRunId,
    machineCode: assertTestbedMachineCode(`${defaultPrefix}-${canonicalRunId}`),
    machineCodePrefix: defaultPrefix,
  };
}

function assertNotSharedOrKnownProductionTarget(label, value) {
  const text = String(value ?? "").trim();
  if (text.length === 0) {
    throw new Error(`VM runtime acceptance requires ${label}`);
  }
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (isSharedPlatformTarget(text)) {
    throw new Error(
      `VM runtime acceptance refuses known VPS or production endpoint for ${label}: ${text}`,
    );
  }
  if (label === EPHEMERAL_DATABASE_URL_ENV) {
    const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
    if (KNOWN_PRODUCTION_DATABASE_NAMES.has(databaseName)) {
      throw new Error(
        `VM runtime acceptance refuses known production database for ${label}: ${databaseName}`,
      );
    }
  }
  return text;
}

function requireEvidenceString(value, message) {
  const text = String(value ?? "").trim();
  if (text.length === 0) {
    throw new Error(message);
  }
  return text;
}

export function readEphemeralPlatformSetupEvidence(options = {}) {
  const consumesEphemeralPlatform = new Set([
    "provision",
    "runtime-acceptance",
    "simulated-hardware-sale-flow",
  ]).has(options.mode);
  if (!consumesEphemeralPlatform) {
    return null;
  }
  if (
    options.mode !== "simulated-hardware-sale-flow" &&
    !String(options.ephemeralPlatformEvidence ?? "").trim()
  ) {
    return null;
  }

  const evidencePath = requireEvidenceString(
    options.ephemeralPlatformEvidence,
    "simulated hardware sale-flow requires --ephemeral-platform-evidence from prepare-ephemeral-platform",
  );
  const platformTarget = requireEvidenceString(
    options.platformTarget,
    "simulated hardware sale-flow requires explicit --platform-target for ephemeral evidence",
  );
  if (isSharedPlatformTarget(platformTarget)) {
    throw new Error(
      `simulated hardware sale-flow refuses shared platform target: ${platformTarget}`,
    );
  }

  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  const runId = normalizeEphemeralRunId(options.runId);
  if (String(evidence.runId ?? "") !== runId) {
    throw new Error(
      `simulated hardware sale-flow requires ephemeral platform evidence from the same run id: expected ${runId}, got ${evidence.runId}`,
    );
  }

  const machineCode = assertTestbedMachineCode(options.machineCode);
  const evidenceMachineCode = requireEvidenceString(
    evidence.testbedMachine?.code,
    "ephemeral platform evidence is missing testbedMachine.code",
  );
  if (evidenceMachineCode !== machineCode) {
    throw new Error(
      `simulated hardware sale-flow requires ephemeral evidence for ${machineCode}, got ${evidenceMachineCode}`,
    );
  }

  const apiBaseUrl = requireEvidenceString(
    evidence.stack?.apiBaseUrl,
    "ephemeral platform evidence is missing stack.apiBaseUrl",
  );
  const mqttUrl = requireEvidenceString(
    evidence.stack?.mqttUrl,
    "ephemeral platform evidence is missing stack.mqttUrl",
  );
  if (isSharedPlatformTarget(apiBaseUrl) || isSharedPlatformTarget(mqttUrl)) {
    throw new Error(
      "simulated hardware sale-flow refuses shared platform target endpoints",
    );
  }

  const claimPath = requireEvidenceString(
    evidence.testbedMachine?.claim?.path,
    "ephemeral platform evidence is missing testbed claim path",
  );
  if (claimPath !== "/api/machines/claim") {
    throw new Error(`unexpected ephemeral claim path: ${claimPath}`);
  }

  const claimCode = requireEvidenceString(
    evidence.testbedMachine?.claim?.claimCode,
    "ephemeral platform evidence is missing the same-run claim code",
  );
  const claimCodeId = requireEvidenceString(
    evidence.testbedMachine?.claim?.claimCodeId,
    "ephemeral platform evidence is missing claimCodeId",
  );
  const paymentReadiness = evidence.seededData?.paymentReadiness ?? {};
  if (
    paymentReadiness.ready !== true ||
    paymentReadiness.mockProviderStatus !== "enabled" ||
    paymentReadiness.runtimePaymentMockEnabled !== true ||
    paymentReadiness.mockPaymentAcknowledged !== true
  ) {
    throw new Error(
      "ephemeral platform evidence must prove mock payment readiness",
    );
  }

  return {
    status: "prepared",
    runId,
    target: platformTarget,
    machineCode,
    apiBaseUrl,
    mqttUrl,
    claimCode,
    claimCodeId,
    claimPath,
    mockPaymentReady: true,
    hardwareTopologyIdentity: requireEvidenceString(
      evidence.hardwareSlotTopology?.identity,
      "ephemeral platform evidence is missing hardware topology identity",
    ),
    hardwareTopologyVersion: requireEvidenceString(
      evidence.hardwareSlotTopology?.version,
      "ephemeral platform evidence is missing hardware topology version",
    ),
    planogramVersion: requireEvidenceString(
      evidence.seededData?.planogram?.planogramVersion,
      "ephemeral platform evidence is missing planogram version",
    ),
  };
}

export function assertSimulatedSaleFlowPreMutationTarget({
  target = {},
  daemonMachineCode,
  daemonApiBaseUrl,
  daemonMqttUrl,
  hardwareMode,
  platformSetup = {},
} = {}) {
  const machineCode = String(target.machineCode ?? "");
  if (!machineCode.startsWith(TESTBED_MACHINE_CODE_PREFIX)) {
    return { ok: false, code: "testbed_machine_identity_required" };
  }
  if (String(daemonMachineCode ?? "") !== machineCode) {
    return { ok: false, code: "daemon_machine_identity_mismatch" };
  }
  if (hardwareMode !== "simulated") {
    return { ok: false, code: "simulated_hardware_mode_required" };
  }
  if (
    isSharedPlatformTarget(target.platformTarget) ||
    isSharedPlatformTarget(platformSetup.target) ||
    isSharedPlatformTarget(platformSetup.apiBaseUrl) ||
    isSharedPlatformTarget(platformSetup.mqttUrl)
  ) {
    return { ok: false, code: "shared_platform_target_rejected" };
  }
  if (
    platformSetup.evidenceStatus !== "prepared" ||
    platformSetup.target !== target.platformTarget
  ) {
    return { ok: false, code: "ephemeral_platform_evidence_required" };
  }
  if (
    String(daemonApiBaseUrl ?? "") !== String(platformSetup.apiBaseUrl ?? "") ||
    String(daemonMqttUrl ?? "") !== String(platformSetup.mqttUrl ?? "")
  ) {
    return { ok: false, code: "ephemeral_platform_target_mismatch" };
  }
  return { ok: true, code: "pre_mutation_target_verified" };
}

function present(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
}

function isVisionProtocolTimestamp(value) {
  if (typeof value !== "string") {
    return false;
  }
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) {
    return false;
  }
  const [year, month, day, hour, minute, second] = match
    .slice(1, 7)
    .map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second
  );
}

function normalizeWindowsUser(user) {
  const value = String(user ?? "").trim();
  if (value.length === 0) {
    return "";
  }
  return value.split("\\").at(-1);
}

function normalizeSessionState(state) {
  return String(state ?? "")
    .trim()
    .toLowerCase();
}

function isActiveKioskSessionEvidence(session) {
  const state = normalizeSessionState(session?.state);
  const sessionName = String(session?.sessionName ?? "")
    .trim()
    .toLowerCase();
  return (
    normalizeWindowsUser(session?.user).toLowerCase() ===
      EXPECTED_KIOSK_USER.toLowerCase() &&
    toNullableSessionId(session?.sessionId) !== null &&
    session?.source !== "ssh_service_session" &&
    (state === "active" ||
      (sessionName === "console" &&
        state !== "disc" &&
        state !== "disconnected" &&
        state !== "listen"))
  );
}

function toNullableSessionId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeSessionEvidence(session) {
  return {
    user: normalizeWindowsUser(session?.user),
    sessionName: present(session?.sessionName)
      ? String(session.sessionName)
      : null,
    sessionId: toNullableSessionId(session?.sessionId),
    state: String(session?.state ?? "unknown"),
    source: String(session?.source ?? "unknown"),
  };
}

export function findActiveKioskSession(sessions = []) {
  const normalizedSessions = Array.isArray(sessions)
    ? sessions.map(normalizeSessionEvidence)
    : [];
  return (
    normalizedSessions.find((session) =>
      isActiveKioskSessionEvidence(session),
    ) ?? null
  );
}

function normalizeScreenDimensions(screen) {
  const widthPx = Number(screen?.widthPx);
  const heightPx = Number(screen?.heightPx);
  return {
    widthPx: Number.isInteger(widthPx) && widthPx > 0 ? widthPx : 0,
    heightPx: Number.isInteger(heightPx) && heightPx > 0 ? heightPx : 0,
  };
}

export function buildInteractiveDesktopDisplayBaseline({
  activeSession,
  screen,
} = {}) {
  const session = activeSession
    ? normalizeSessionEvidence(activeSession)
    : null;
  const dimensions = normalizeScreenDimensions(screen);
  const screenSource = String(screen?.source ?? "");
  const passed =
    isActiveKioskSessionEvidence(session) &&
    screenSource !== "ssh_service_session" &&
    dimensions.widthPx === EXPECTED_PORTRAIT_WIDTH_PX &&
    dimensions.heightPx === EXPECTED_PORTRAIT_HEIGHT_PX;

  return {
    status: session === null ? "missing" : passed ? "passed" : "failed",
    widthPx: session === null ? 0 : dimensions.widthPx,
    heightPx: session === null ? 0 : dimensions.heightPx,
    sessionUser: session?.user || "unknown",
    sessionId: session?.sessionId ?? null,
    source: "interactive_desktop_screen",
  };
}

export function buildPortraitKioskAcceptance(baseline = {}) {
  const passed =
    baseline.status === "passed" &&
    baseline.widthPx === EXPECTED_PORTRAIT_WIDTH_PX &&
    baseline.heightPx === EXPECTED_PORTRAIT_HEIGHT_PX &&
    normalizeWindowsUser(baseline.sessionUser) === EXPECTED_KIOSK_USER &&
    toNullableSessionId(baseline.sessionId) !== null;

  return {
    status: passed ? "passed" : "failed",
    widthPx: Number.isInteger(Number(baseline.widthPx))
      ? Number(baseline.widthPx)
      : 0,
    heightPx: Number.isInteger(Number(baseline.heightPx))
      ? Number(baseline.heightPx)
      : 0,
    sessionUser: normalizeWindowsUser(baseline.sessionUser) || "unknown",
    sessionId: toNullableSessionId(baseline.sessionId),
    source: "interactive_kiosk_session",
  };
}

export function isStrictTauriHashRouteUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return (
      url.protocol === "http:" &&
      url.hostname === "tauri.localhost" &&
      url.pathname === "/" &&
      url.hash.startsWith("#/")
    );
  } catch {
    return false;
  }
}

function isSha256(value) {
  return /^[a-fA-F0-9]{64}$/.test(String(value ?? ""));
}

function addDiagnostic(diagnostics, code, message) {
  diagnostics.push({ code, message });
}

function runtimeAssertion(status, asserted) {
  return { status, asserted };
}

export function buildRuntimeAcceptanceReport(facts = {}) {
  const diagnostics = [];

  if (
    !String(facts.target?.machineCode ?? "").startsWith(
      TESTBED_MACHINE_CODE_PREFIX,
    )
  ) {
    addDiagnostic(
      diagnostics,
      "testbed_machine_identity_required",
      "Machine Runtime Testbed MVP reports must use a VEM-TESTBED-* machine identity.",
    );
  }
  const observedMachineCode = facts.provisioning?.machineCode ?? null;
  if (!present(observedMachineCode)) {
    addDiagnostic(
      diagnostics,
      "daemon_config_machine_identity_missing",
      "Runtime acceptance must include the daemon-observed machine identity from config IPC.",
    );
  } else if (
    !String(observedMachineCode).startsWith(TESTBED_MACHINE_CODE_PREFIX)
  ) {
    addDiagnostic(
      diagnostics,
      "daemon_config_machine_identity_required",
      "Daemon-observed machine identity must be a VEM-TESTBED-* machine identity.",
    );
  } else if (observedMachineCode !== facts.target?.machineCode) {
    addDiagnostic(
      diagnostics,
      "daemon_config_machine_identity_mismatch",
      "Daemon-observed machine identity must match the requested testbed target.",
    );
  }
  if (!isSha256(facts.artifacts?.daemonSha256)) {
    addDiagnostic(
      diagnostics,
      "daemon_artifact_hash_missing",
      "Runtime acceptance requires a SHA-256 hash for vending-daemon.exe.",
    );
  }
  if (!isSha256(facts.artifacts?.machineUiSha256)) {
    addDiagnostic(
      diagnostics,
      "machine_ui_artifact_hash_missing",
      "Runtime acceptance requires a SHA-256 hash for machine.exe.",
    );
  }
  if (facts.readyFile?.exists !== true) {
    addDiagnostic(
      diagnostics,
      "ready_file_missing",
      "Daemon ready file must exist before runtime-ready can pass.",
    );
  }
  if (facts.readyFile?.readableByKioskUser !== true) {
    addDiagnostic(
      diagnostics,
      "ready_file_not_readable_by_kiosk",
      "Daemon ready file must be readable by the VEMKiosk user.",
    );
  }
  if (
    facts.readyFile?.ipcEndpointPresent !== true ||
    facts.readyFile?.tokenPresent !== true
  ) {
    addDiagnostic(
      diagnostics,
      "daemon_ipc_handoff_missing",
      "Ready file must include the daemon IPC endpoint and token.",
    );
  }
  if (facts.daemonRuntime?.ipcReachable !== true) {
    addDiagnostic(
      diagnostics,
      "daemon_ipc_unreachable",
      "Daemon IPC must be reachable through the ready-file handoff.",
    );
  }
  if (
    facts.daemonRuntime?.processRunning !== true ||
    !Number.isInteger(facts.daemonRuntime?.processId) ||
    facts.daemonRuntime?.processUser !== EXPECTED_DAEMON_USER ||
    facts.daemonRuntime?.executablePath !== EXPECTED_DAEMON_PATH
  ) {
    addDiagnostic(
      diagnostics,
      "daemon_process_not_ready",
      "The manually started daemon process must run as Admin from C:\\VEM\\bringup\\vending-daemon.exe.",
    );
  }
  if (facts.provisioning?.provisioned !== true) {
    addDiagnostic(
      diagnostics,
      "machine_provisioning_incomplete",
      "Machine Provisioning must complete before runtime-ready can pass.",
    );
  }
  if (facts.provisioning?.usedDaemonIpcTaskExecute !== true) {
    addDiagnostic(
      diagnostics,
      "machine_provisioning_bypassed_daemon_ipc",
      "Machine Provisioning must use the daemon IPC claim path.",
    );
  }
  if (facts.daemonRuntime?.readyz?.ready !== true) {
    addDiagnostic(
      diagnostics,
      "daemon_readyz_not_ready",
      "Daemon readyz must report ready before runtime-ready can pass.",
    );
  }
  if (facts.daemonRuntime?.healthz?.backendOnline !== true) {
    addDiagnostic(
      diagnostics,
      "backend_connectivity_failed",
      "Daemon health must report backend connectivity.",
    );
  }
  if (facts.daemonRuntime?.healthz?.mqttConnected !== true) {
    addDiagnostic(
      diagnostics,
      "mqtt_connectivity_failed",
      "Daemon health must report MQTT connectivity.",
    );
  }
  if (
    facts.visionRuntime?.healthReachable !== true ||
    !["ok", "degraded"].includes(facts.visionRuntime?.healthStatus) ||
    facts.visionRuntime?.healthProtocol !== "vem.vision.v1" ||
    facts.visionRuntime?.healthModule !== "vision" ||
    facts.visionRuntime?.healthMockScenario !== "off" ||
    facts.visionRuntime?.modelReady !== true
  ) {
    addDiagnostic(
      diagnostics,
      "vision_health_not_ready",
      "The installed Vision runtime must expose a healthy vem.vision.v1 service with loaded models.",
    );
  }
  if (
    facts.visionRuntime?.installedProcessBound !== true ||
    facts.visionRuntime?.installedRecordPresent !== true ||
    !/^[a-f0-9]{40}$/.test(facts.visionRuntime?.installedCommit ?? "") ||
    facts.visionRuntime?.installedRuntime !== "vending-vision.exe" ||
    facts.visionRuntime?.installedAppDirectory !== "C:\\VEM\\vision\\app" ||
    facts.visionRuntime?.installedRuntimeWorkDirectory !==
      EXPECTED_VISION_WORK_DIRECTORY ||
    facts.visionRuntime?.executablePath !== EXPECTED_VISION_ENTRYPOINT ||
    !Number.isInteger(facts.visionRuntime?.processId) ||
    facts.visionRuntime.processId < 1 ||
    facts.visionRuntime?.listenerBound !== true ||
    !Number.isInteger(facts.visionRuntime?.listenerProcessId) ||
    facts.visionRuntime.listenerProcessId !== facts.visionRuntime.processId ||
    facts.visionRuntime?.listenerOwnerCount !== 1 ||
    !["Get-NetTCPConnection", "netstat"].includes(
      facts.visionRuntime?.listenerBindingSource,
    )
  ) {
    addDiagnostic(
      diagnostics,
      "vision_installed_process_not_bound",
      "Vision acceptance must bind the listener to the fixed installed app and installed.json record.",
    );
  }
  if (
    facts.visionRuntime?.webSocketConnected !== true ||
    facts.visionRuntime?.readyProtocol !== "vem.vision.v1" ||
    facts.visionRuntime?.readyType !== "vision.ready" ||
    typeof facts.visionRuntime?.readyMessageId !== "string" ||
    facts.visionRuntime.readyMessageId.trim().length === 0 ||
    facts.visionRuntime.readyMessageId.length > 128 ||
    !isVisionProtocolTimestamp(facts.visionRuntime?.readyTimestamp) ||
    typeof facts.visionRuntime?.readyServerName !== "string" ||
    facts.visionRuntime.readyServerName.trim().length === 0 ||
    facts.visionRuntime.readyServerName.length > 128 ||
    typeof facts.visionRuntime?.readyCameraReady !== "boolean" ||
    facts.visionRuntime?.readyCameraReady !==
      facts.visionRuntime?.cameraReady ||
    facts.visionRuntime?.readyModelReady !== true ||
    facts.visionRuntime?.readyModelReady !== facts.visionRuntime?.modelReady ||
    !Array.isArray(facts.visionRuntime?.readyCapabilities) ||
    !facts.visionRuntime.readyCapabilities.every(
      (capability) =>
        typeof capability === "string" &&
        capability.trim().length > 0 &&
        capability.length <= 64,
    ) ||
    ![
      "profile_push",
      "presence_status",
      "person_departed",
      "try_on_session",
    ].every((capability) =>
      facts.visionRuntime.readyCapabilities.includes(capability),
    )
  ) {
    addDiagnostic(
      diagnostics,
      "vision_protocol_not_ready",
      "The installed Vision runtime must complete the vem.vision.v1 hello handshake.",
    );
  }
  if (facts.kioskRuntime?.webviewRunning !== true) {
    addDiagnostic(
      diagnostics,
      "kiosk_webview_missing",
      "Machine Runtime Console must be running as a Tauri WebView in the active VEMKiosk session.",
    );
  }
  if (facts.kioskRuntime?.sessionUser !== EXPECTED_KIOSK_USER) {
    addDiagnostic(
      diagnostics,
      "kiosk_session_user_mismatch",
      "Machine Runtime Console must run in the VEMKiosk customer session.",
    );
  }
  if (
    facts.kioskRuntime?.sessionId === null ||
    facts.displayEvidence?.interactiveDesktopDisplayBaseline?.sessionId ===
      null ||
    facts.displayEvidence?.portraitKioskAcceptance?.sessionId === null
  ) {
    addDiagnostic(
      diagnostics,
      "kiosk_session_id_missing",
      "Runtime acceptance requires observed interactive VEMKiosk session ids.",
    );
  }
  if (
    facts.kioskRuntime?.sessionId !==
      facts.displayEvidence?.interactiveDesktopDisplayBaseline?.sessionId ||
    facts.kioskRuntime?.sessionId !==
      facts.displayEvidence?.portraitKioskAcceptance?.sessionId
  ) {
    addDiagnostic(
      diagnostics,
      "kiosk_session_id_mismatch",
      "Machine Runtime Console evidence must match the active VEMKiosk interactive session.",
    );
  }
  if (
    !Number.isInteger(facts.kioskRuntime?.processId) ||
    facts.kioskRuntime?.machineProcessCount !== 1 ||
    facts.kioskRuntime?.machineExecutablePath !== EXPECTED_MACHINE_UI_PATH
  ) {
    addDiagnostic(
      diagnostics,
      "kiosk_normal_process_not_unique",
      "Runtime acceptance requires exactly one installed machine.exe in the active VEMKiosk session.",
    );
  }
  if (facts.kioskRuntime?.cdpAvailable === true) {
    if (
      facts.kioskRuntime?.acceptanceOverlayCdp !== true ||
      !Number.isInteger(facts.kioskRuntime?.cdpListenerProcessId) ||
      facts.kioskRuntime?.cdpListenerSessionId !==
        facts.kioskRuntime?.sessionId ||
      facts.kioskRuntime?.cdpMachineAncestorProcessId !==
        facts.kioskRuntime?.processId
    ) {
      addDiagnostic(
        diagnostics,
        "kiosk_cdp_process_binding_missing",
        "The accepted CDP listener must belong to the active VEMKiosk machine.exe process tree and Windows session.",
      );
    }
  } else if (
    facts.kioskRuntime?.cdpAvailable !== false ||
    facts.kioskRuntime?.source !== "webview2_process" ||
    facts.kioskRuntime?.webView2ProcessCount < 1 ||
    facts.kioskRuntime?.url !== "unavailable:production-cdp-disabled"
  ) {
    addDiagnostic(
      diagnostics,
      "kiosk_production_webview_evidence_missing",
      "CDP-disabled production UI acceptance requires same-session WebView2 process evidence.",
    );
  }
  if (
    facts.displayEvidence?.portraitKioskAcceptance?.sessionUser !==
    EXPECTED_KIOSK_USER
  ) {
    addDiagnostic(
      diagnostics,
      "portrait_kiosk_session_user_mismatch",
      "Portrait Kiosk Acceptance must be captured from the VEMKiosk customer session.",
    );
  }
  if (
    facts.displayEvidence?.interactiveDesktopDisplayBaseline?.status !==
      "passed" ||
    facts.displayEvidence?.interactiveDesktopDisplayBaseline?.widthPx !==
      EXPECTED_PORTRAIT_WIDTH_PX ||
    facts.displayEvidence?.interactiveDesktopDisplayBaseline?.heightPx !==
      EXPECTED_PORTRAIT_HEIGHT_PX
  ) {
    addDiagnostic(
      diagnostics,
      "interactive_desktop_display_baseline_missing",
      "Interactive Desktop Display Baseline must pass at exactly 1080x1920 before runtime-ready can pass.",
    );
  }
  if (
    facts.displayEvidence?.portraitKioskAcceptance?.status !== "passed" ||
    facts.displayEvidence?.portraitKioskAcceptance?.source !==
      "interactive_kiosk_session" ||
    facts.displayEvidence?.portraitKioskAcceptance?.widthPx !==
      EXPECTED_PORTRAIT_WIDTH_PX ||
    facts.displayEvidence?.portraitKioskAcceptance?.heightPx !==
      EXPECTED_PORTRAIT_HEIGHT_PX
  ) {
    addDiagnostic(
      diagnostics,
      "portrait_kiosk_acceptance_missing",
      "Portrait Kiosk Acceptance requires 1080x1920 evidence from the interactive kiosk session.",
    );
  }

  return {
    schemaVersion: "runtime-acceptance-report/v1",
    ...facts,
    mode: "installed_runtime",
    result: {
      runtimeReady:
        diagnostics.length === 0
          ? runtimeAssertion("passed", true)
          : runtimeAssertion("failed", false),
      simulatedHardwareReady: runtimeAssertion("not_asserted", false),
      sellReady: runtimeAssertion("not_asserted", false),
    },
    diagnostics,
  };
}

export function buildKioskRuntimeEvidence({
  activeSession,
  machineProcesses = [],
  webView2Processes = [],
  cdpTargets = [],
  cdpAvailable = Array.isArray(cdpTargets),
  cdpListener = null,
  acceptanceOverlayCdp = false,
} = {}) {
  const session = activeSession
    ? normalizeSessionEvidence(activeSession)
    : null;
  const kioskMachineProcesses = Array.isArray(machineProcesses)
    ? machineProcesses.filter(
        (candidate) =>
          normalizeWindowsUser(candidate?.ownerUser) === EXPECTED_KIOSK_USER &&
          toNullableSessionId(candidate?.sessionId) === session?.sessionId,
      )
    : [];
  const process = kioskMachineProcesses[0] ?? null;
  const target = Array.isArray(cdpTargets)
    ? cdpTargets.find((candidate) => isStrictTauriHashRouteUrl(candidate?.url))
    : null;
  const kioskWebView2Processes = Array.isArray(webView2Processes)
    ? webView2Processes.filter(
        (candidate) =>
          normalizeWindowsUser(candidate?.ownerUser) === EXPECTED_KIOSK_USER &&
          toNullableSessionId(candidate?.sessionId) === session?.sessionId,
      )
    : [];
  const webView2Process = kioskWebView2Processes[0] ?? null;
  const cdpTargetId =
    typeof target?.id === "string" && target.id.trim().length > 0
      ? target.id
      : null;
  const cdpProcessBound = Boolean(
    session &&
    process &&
    Number.isInteger(cdpListener?.processId) &&
    toNullableSessionId(cdpListener?.sessionId) === session.sessionId &&
    cdpListener?.machineAncestorProcessId === process.processId,
  );
  const cdpVerified = Boolean(
    session && process && target && cdpTargetId && cdpProcessBound,
  );
  const productionWebViewVerified = Boolean(
    session && process && webView2Process && cdpAvailable === false,
  );
  const webviewRunning = cdpVerified || productionWebViewVerified;

  return {
    webviewRunning,
    url:
      target?.url ??
      (productionWebViewVerified
        ? "unavailable:production-cdp-disabled"
        : "unavailable:no-tauri-hash-route-target"),
    sessionUser: session?.user ?? "unknown",
    sessionId: session?.sessionId ?? null,
    processId: process?.processId ?? null,
    machineProcessCount: kioskMachineProcesses.length,
    machineExecutablePath: process?.executablePath ?? null,
    webView2ProcessId: webView2Process?.processId ?? null,
    webView2ProcessCount: kioskWebView2Processes.length,
    cdpListenerProcessId: cdpListener?.processId ?? null,
    cdpListenerSessionId: toNullableSessionId(cdpListener?.sessionId),
    cdpMachineAncestorProcessId: cdpListener?.machineAncestorProcessId ?? null,
    cdpTargetId,
    cdpAvailable,
    acceptanceOverlayCdp: cdpVerified && acceptanceOverlayCdp === true,
    error: webviewRunning ? null : "kiosk_webview_not_verified",
  };
}

export function buildPreClaimPublicConfig(publicConfig = {}, platform) {
  return {
    ...publicConfig,
    machineCode: null,
    machineId: null,
    machineName: null,
    machineStatus: null,
    machineLocationLabel: null,
    apiBaseUrl: platform.apiBaseUrl,
    mqttUrl: platform.mqttUrl,
    mqttUsername: null,
    mqttClientId: null,
    runtimeEndpoints: null,
    hardwareProfile: null,
    paymentCapability: null,
    provisioningMetadata: null,
  };
}

export function evaluateFirstClaimPrecondition(configSnapshot = {}) {
  const publicConfig = configSnapshot.public ?? {};
  if (configSnapshot.provisioned === true) {
    return {
      ok: false,
      code: "already_provisioned",
      message:
        "first-claim provisioning requires reset before a provisioned config can be claimed again",
    };
  }

  const credentialFlags = [
    "machineSecretConfigured",
    "mqttSigningSecretConfigured",
    "mqttPasswordConfigured",
  ];
  const configuredCredential = credentialFlags.find(
    (field) => configSnapshot[field] === true,
  );
  if (configuredCredential) {
    return {
      ok: false,
      code: "credentials_configured",
      message: `first-claim provisioning requires reset before reusing credentialed config: ${configuredCredential}`,
    };
  }

  const staleField = FINAL_PUBLIC_CONFIG_FIELDS.find((field) =>
    present(publicConfig[field]),
  );
  if (staleField) {
    const value = publicConfig[staleField];
    const code =
      staleField === "machineCode" && !String(value).startsWith("VEM-TESTBED-")
        ? "non_testbed_identity"
        : "stale_final_identity";
    return {
      ok: false,
      code,
      message: `first-claim provisioning requires reset before reusing final config field: ${staleField}`,
    };
  }

  return { ok: true, code: "ready_for_first_claim", message: null };
}

export function classifyProvisioningFailure(errorInfo = {}) {
  if (present(errorInfo.body?.code)) {
    return String(errorInfo.body.code);
  }
  if (Number.isInteger(errorInfo.statusCode)) {
    return `http_${errorInfo.statusCode}`;
  }
  return "request_failed";
}

export function buildReadyFileEvidence(readyFile) {
  if (!readyFile) {
    return {
      exists: false,
      ipcEndpointPresent: false,
      tokenPresent: false,
      error: "ready_file_missing",
    };
  }

  const tokenPresent = present(readyFile.ipcToken);
  const healthzUrl = String(readyFile.healthzUrl ?? "");
  const ipcEndpointPresent = healthzUrl.trim().length > 0;
  let error = null;
  if (!tokenPresent) {
    error = "ipc_token_missing";
  } else if (!ipcEndpointPresent) {
    error = "healthz_url_missing";
  } else if (!healthzUrl.endsWith("/healthz")) {
    error = "healthz_url_invalid";
  }

  return {
    exists: true,
    ipcEndpointPresent,
    tokenPresent,
    error,
  };
}

export function buildProvisioningFacts({ configSnapshot, actions = [] } = {}) {
  const actionList = Array.isArray(actions) ? actions : [];
  const usedDaemonIpcTaskExecute = actionList.some((action) => {
    const evidence = action?.evidence ?? {};
    return (
      evidence.usedDaemonIpcTaskExecute === true &&
      String(evidence.endpoint ?? "").endsWith("/v1/provisioning/claim") &&
      ["provisioned", "failed"].includes(String(evidence.claimStatus ?? ""))
    );
  });
  return {
    provisioned: configSnapshot?.provisioned === true,
    usedDaemonIpcTaskExecute,
    machineCode: configSnapshot?.public?.machineCode ?? null,
    machineSecretConfigured: configSnapshot?.machineSecretConfigured === true,
    mqttSigningSecretConfigured:
      configSnapshot?.mqttSigningSecretConfigured === true,
    mqttPasswordConfigured: configSnapshot?.mqttPasswordConfigured === true,
    provisioningIssues: Array.isArray(configSnapshot?.provisioningIssues)
      ? configSnapshot.provisioningIssues.map(String)
      : [],
  };
}

export function buildResetPlan() {
  return {
    stopServices: ["VemVendingDaemon"],
    unregisterScheduledTasks: ["VEMMachineUI", "VEM\\StartVisionServer"],
    removeDirectories: [...VEM_RESET_ROOTS],
    removeFiles: [...VEM_RESET_FILES],
    preservedResources: [
      "Windows OS",
      "display setup",
      "OpenSSH",
      "WebView2",
      "base networking",
    ],
  };
}

export function assertResetPlanPreservesTestbed(plan) {
  const candidatePaths = [
    ...(plan.removeDirectories ?? []),
    ...(plan.removeFiles ?? []),
  ];

  for (const path of candidatePaths) {
    const normalized = String(path).replaceAll("/", "\\").toLowerCase();
    for (const protectedPrefix of PROTECTED_PATH_PREFIXES) {
      if (
        normalized === protectedPrefix.toLowerCase() ||
        normalized.startsWith(`${protectedPrefix.toLowerCase()}\\`)
      ) {
        throw new Error(
          `reset plan targets protected testbed resource: ${path}`,
        );
      }
    }
  }

  for (const service of plan.stopServices ?? []) {
    const normalized = String(service).toLowerCase();
    if (
      PROTECTED_SERVICE_NAMES.has(normalized) ||
      !normalized.startsWith("vem")
    ) {
      throw new Error(
        `reset plan targets protected testbed resource: service ${service}`,
      );
    }
  }

  for (const task of plan.unregisterScheduledTasks ?? []) {
    const normalized = String(task).replaceAll("/", "\\").toLowerCase();
    if (!ALLOWED_SCHEDULED_TASKS.has(normalized)) {
      throw new Error(
        `reset plan targets protected testbed resource: scheduled task ${task}`,
      );
    }
  }

  return plan;
}

function psString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function psArray(values) {
  return `@(${values.map(psString).join(", ")})`;
}

function psArgumentValue(value) {
  if (Array.isArray(value)) {
    return psArray(value);
  }
  if (String(value).startsWith("$env:")) {
    return String(value);
  }
  return psString(value);
}

function sanitizeRunId(value) {
  const runId = String(value ?? "").trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) {
    throw new Error(
      "testbed acceptance requires --run-id with only letters, digits, dot, underscore, or hyphen",
    );
  }
  return runId;
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function assertSha256Hash(value, label) {
  const hash = String(value ?? "").trim();
  if (!SHA256_PATTERN.test(hash)) {
    throw new Error(`${label} requires lowercase SHA-256 hash`);
  }
  return hash;
}

function resolveMachineUiSidecarArtifactPath(machineUiArtifactPath) {
  const sidecarPath = join(
    dirname(machineUiArtifactPath),
    "WebView2Loader.dll",
  );
  if (!existsSync(sidecarPath)) {
    throw new Error(
      `machine UI artifact requires WebView2Loader.dll next to machine.exe: ${sidecarPath}`,
    );
  }
  return sidecarPath;
}

function resolveVmRuntimeAcceptanceArtifacts(options = {}) {
  if (options.daemonArtifactSha256 && options.machineUiArtifactSha256) {
    return {
      source: "uploaded_local_artifacts",
      daemonSha256: assertSha256Hash(
        options.daemonArtifactSha256,
        "VM runtime acceptance daemon artifact",
      ),
      machineUiSha256: assertSha256Hash(
        options.machineUiArtifactSha256,
        "VM runtime acceptance machine UI artifact",
      ),
    };
  }
  if (!options.daemonArtifact || !options.machineUiArtifact) {
    throw new Error(
      "VM runtime acceptance requires --daemon-artifact and --machine-ui-artifact",
    );
  }
  resolveMachineUiSidecarArtifactPath(options.machineUiArtifact);
  return {
    source: "uploaded_local_artifacts",
    daemonSha256: sha256File(options.daemonArtifact),
    machineUiSha256: sha256File(options.machineUiArtifact),
  };
}

export function buildAcceptanceScriptCommand(
  mode,
  options = {},
  extraArgs = [],
) {
  const command = [
    process.execPath,
    "scripts/testbed/win10-vem-e2e.mjs",
    "--mode",
    mode,
    "--run-id",
    sanitizeRunId(options.runId),
    "--machine-code",
    buildTestbedMachineCodeFromRun(options),
    "--platform-target",
    options.platformTarget,
    ...extraArgs,
  ];
  if (options.remote) {
    command.push("--remote", options.remote);
  }
  if (options.sshPort) {
    command.push("--ssh-port", String(options.sshPort));
  }
  if (options.sshKnownHostsPath) {
    command.push("--ssh-known-hosts-path", options.sshKnownHostsPath);
  }
  if (options.sshHostKeyAlias) {
    command.push("--ssh-host-key-alias", options.sshHostKeyAlias);
  }
  if (options.expectedTestbedUser) {
    command.push("--expected-testbed-user", options.expectedTestbedUser);
  }
  if (options.identity) {
    command.push("--identity", options.identity);
  }
  if (options.certificate) {
    command.push("--certificate", options.certificate);
  }
  return command;
}

export function buildInstalledKioskSaleLaunchScript() {
  return String.raw`
$ErrorActionPreference = 'Stop'
$debugTask = '${INSTALLED_KIOSK_SALE_DEBUG_TASK}'
$machinePath = '${INSTALLED_KIOSK_SALE_MACHINE_PATH}'
$debugLauncher = '${INSTALLED_KIOSK_SALE_DEBUG_LAUNCHER}'
$normalTask = '${EXPECTED_MACHINE_UI_TASK_NAME}'
if (-not (Test-Path -LiteralPath $debugLauncher -PathType Leaf)) { throw 'installed kiosk sale debug launcher is missing' }
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class VemKioskConsole {
  [DllImport("kernel32.dll")] public static extern UInt32 WTSGetActiveConsoleSessionId();
}
'@
$activeConsoleSessionId = [int][VemKioskConsole]::WTSGetActiveConsoleSessionId()
if ($activeConsoleSessionId -lt 0 -or $activeConsoleSessionId -eq 0xffffffff) { throw 'active console session is unavailable' }
$activeConsolePrincipal = [string](Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).UserName
if ([string]::IsNullOrWhiteSpace($activeConsolePrincipal)) { throw 'active console principal is unavailable' }
$daemon = Get-Service -Name 'VemVendingDaemon' -ErrorAction Stop
if ([string]$daemon.Status -ne 'Running') { throw 'daemon must remain running before installed kiosk sale acceptance' }
$normal = @(Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $machinePath) })
if ($normal.Count -ne 1) { throw "expected exactly one normal machine.exe before debug launch, found $($normal.Count)" }
$normalProcess = Get-Process -Id ([int]$normal[0].ProcessId) -ErrorAction Stop
$owner = Invoke-CimMethod -InputObject $normal[0] -MethodName GetOwner -ErrorAction Stop
if ([string]::IsNullOrWhiteSpace([string]$owner.Domain) -or [string]::IsNullOrWhiteSpace([string]$owner.User)) { throw 'normal machine.exe owner is incomplete' }
$principal = "{0}\{1}" -f [string]$owner.Domain, [string]$owner.User
$sessionId = [int]$normalProcess.SessionId
if ($principal -cne $activeConsolePrincipal -or $sessionId -ne $activeConsoleSessionId) { throw 'normal machine.exe must belong exactly to the active console principal and session' }
$normalTaskInstance = Get-ScheduledTask -TaskName $normalTask -ErrorAction SilentlyContinue
if ($null -ne $normalTaskInstance) { Stop-ScheduledTask -TaskName $normalTask -ErrorAction Stop }
$normalTaskXml = Export-ScheduledTask -TaskName $normalTask -ErrorAction Stop
$normalTaskXmlBytes = [Text.Encoding]::UTF8.GetBytes($normalTaskXml)
$normalTaskXmlSha256 = ([Security.Cryptography.SHA256]::Create().ComputeHash($normalTaskXmlBytes) | ForEach-Object { $_.ToString('x2') }) -join ''
$normalTaskXmlBase64 = [Convert]::ToBase64String($normalTaskXmlBytes)
$normalTaskAction = if ($null -ne $normalTaskInstance) { @($normalTaskInstance.Actions | Select-Object -First 1) } else { @() }
if ($normalTaskAction.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$normalTaskAction[0].Execute)) { throw 'VEMMachineUI task action is missing before temporary CDP launch' }
$launcherOwners = @(Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" | Where-Object {
  if (-not ($_.CommandLine -and $_.CommandLine -match [regex]::Escape('${INSTALLED_KIOSK_SALE_NORMAL_LAUNCHER}'))) { return $false }
  $launcherProcess = Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop
  return $launcherProcess.SessionId -eq $sessionId
})
foreach ($launcherOwner in $launcherOwners) { Stop-Process -Id ([int]$launcherOwner.ProcessId) -Force -ErrorAction Stop }
Stop-Process -Id ([int]$normal[0].ProcessId) -Force -ErrorAction Stop
Unregister-ScheduledTask -TaskName $debugTask -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument ('"{0}"' -f $debugLauncher) -WorkingDirectory 'C:\VEM\bringup'
$principalSpec = New-ScheduledTaskPrincipal -UserId $principal -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Principal $principalSpec
Register-ScheduledTask -TaskName $debugTask -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $debugTask
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  $machines = @(Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $machinePath) })
  $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue)
  if ($machines.Count -eq 1 -and $listeners.Count -eq 1) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
if ($machines.Count -ne 1 -or $listeners.Count -ne 1) { throw 'temporary CDP-enabled machine.exe did not reach exactly-one process/listener state' }
$machine = $machines[0]
$process = Get-Process -Id ([int]$machine.ProcessId) -ErrorAction Stop
if ($process.SessionId -ne $sessionId) { throw 'debug machine.exe did not launch in active interactive session' }
$owner = Invoke-CimMethod -InputObject $machine -MethodName GetOwner -ErrorAction Stop
$observedPrincipal = "{0}\{1}" -f [string]$owner.Domain, [string]$owner.User
if ($observedPrincipal -cne $principal) { throw 'debug machine.exe principal differs from active interactive principal' }
$targets = @(Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json' -TimeoutSec 5 | Where-Object { [string]$_.url -match '^http://tauri\.localhost/#/' })
if ($targets.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$targets[0].id)) { throw 'debug CDP must expose exactly one tauri target' }
[Console]::Out.WriteLine(([ordered]@{ ok = $true; prelaunch = [ordered]@{ processId = [int]$normalProcess.Id; executablePath = $machinePath; sessionId = [int]$sessionId; principal = $principal; owner = if ($null -ne $normalTaskInstance) { 'scheduled_task' } else { 'shell_launcher' }; task = [ordered]@{ name = $normalTask; execute = [string]$normalTaskAction[0].Execute; arguments = [string]$normalTaskAction[0].Arguments; workingDirectory = [string]$normalTaskAction[0].WorkingDirectory; xmlBase64 = $normalTaskXmlBase64; xmlSha256 = $normalTaskXmlSha256 } }; machine = [ordered]@{ processId = [int]$process.Id; executablePath = $machinePath; sessionId = [int]$sessionId; principal = $principal }; debugTarget = [ordered]@{ id = [string]$targets[0].id; url = [string]$targets[0].url }; debugTask = $debugTask; daemonRunningBefore = $true } | ConvertTo-Json -Compress -Depth 8))
`.trim();
}

export function buildInstalledKioskSaleCleanupScript(prelaunch = {}) {
  const principal = String(prelaunch.principal ?? "");
  const sessionId = Number(prelaunch.sessionId);
  const expectedRoute = String(prelaunch.expectedRoute ?? "#/catalog");
  if (!principal || !Number.isSafeInteger(sessionId) || sessionId < 1) {
    throw new Error(
      "installed kiosk cleanup requires the saved active interactive principal and session",
    );
  }
  const task = prelaunch.task;
  if (
    !task ||
    task.name !== EXPECTED_MACHINE_UI_TASK_NAME ||
    typeof task.execute !== "string" ||
    task.execute.trim() === "" ||
    typeof task.arguments !== "string" ||
    typeof task.workingDirectory !== "string" ||
    typeof task.xmlBase64 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(task.xmlSha256 ?? "")
  ) {
    throw new Error(
      "installed kiosk cleanup requires the complete original VEMMachineUI task XML",
    );
  }
  const taskXmlBase64 = task.xmlBase64.replaceAll("'", "''");
  const taskXmlSha256 = task.xmlSha256.toLowerCase();
  return String.raw`
$ErrorActionPreference = 'Stop'
$debugTask = '${INSTALLED_KIOSK_SALE_DEBUG_TASK}'
$normalTask = '${EXPECTED_MACHINE_UI_TASK_NAME}'
$machinePath = '${INSTALLED_KIOSK_SALE_MACHINE_PATH}'
$principal = '${principal.replaceAll("'", "''")}'
$sessionId = ${sessionId}
$taskXml = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${taskXmlBase64}'))
$taskXmlBytes = [Text.Encoding]::UTF8.GetBytes($taskXml)
$taskXmlSha256 = ([Security.Cryptography.SHA256]::Create().ComputeHash($taskXmlBytes) | ForEach-Object { $_.ToString('x2') }) -join ''
if ($taskXmlSha256 -cne '${taskXmlSha256}') { throw 'VEMMachineUI saved task XML digest is invalid' }
Stop-ScheduledTask -TaskName $debugTask -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $debugTask -Confirm:$false -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id ([int]$_.OwningProcess) -Force -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $machinePath) } | ForEach-Object { Stop-Process -Id ([int]$_.ProcessId) -Force -ErrorAction SilentlyContinue }
Unregister-ScheduledTask -TaskName $normalTask -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $normalTask -Xml $taskXml -Force | Out-Null
Start-ScheduledTask -TaskName $normalTask -ErrorAction Stop
$deadline = [DateTime]::UtcNow.AddSeconds(30)
do {
  $machines = @(Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $machinePath) })
  $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue)
  if ($machines.Count -eq 1 -and $listeners.Count -eq 0) { break }
  Start-Sleep -Milliseconds 250
} while ([DateTime]::UtcNow -lt $deadline)
if ($machines.Count -ne 1 -or $listeners.Count -ne 0) { throw 'VEMMachineUI restoration retained CDP or did not start exactly one machine.exe' }
$restored = Get-ScheduledTask -TaskName $normalTask -ErrorAction Stop
$restoredXml = Export-ScheduledTask -TaskName $normalTask -ErrorAction Stop
$restoredXmlBytes = [Text.Encoding]::UTF8.GetBytes($restoredXml)
$restoredXmlSha256 = ([Security.Cryptography.SHA256]::Create().ComputeHash($restoredXmlBytes) | ForEach-Object { $_.ToString('x2') }) -join ''
if ($restoredXmlSha256 -cne $taskXmlSha256) { throw 'VEMMachineUI XML restore changed triggers, settings, conditions, principal, or actions' }
$simulatedOrFaultProcesses = @(Get-CimInstance Win32_Process | Where-Object { [string]$_.CommandLine -match '(?i)ui-debug|simulat|fault-inject|testbed-fault' })
if ($simulatedOrFaultProcesses.Count -ne 0) { throw 'VEMMachineUI cleanup retained simulated or fault-injection process state' }
[Console]::Out.WriteLine(([ordered]@{ ok = $true; restored = 'original_vem_machine_ui_task'; normal = [ordered]@{ machineCount = $machines.Count; task = [ordered]@{ name = $normalTask; execute = [string]$restored.Actions[0].Execute; arguments = [string]$restored.Actions[0].Arguments; workingDirectory = [string]$restored.Actions[0].WorkingDirectory; xmlSha256 = $restoredXmlSha256; triggersSettingsConditionsPrincipalActionRestored = $true }; cdpListenerCount = $listeners.Count; simulatedOrFaultProcessCount = $simulatedOrFaultProcesses.Count }; daemonRunning = ((Get-Service -Name 'VemVendingDaemon').Status -eq 'Running'); cdpListenerCount = $listeners.Count } | ConvertTo-Json -Compress -Depth 8))
`.trim();
}

export function runInstalledKioskSaleRemoteScript(options, script) {
  const ssh = buildSshCommand(options);
  const diagnosticScript = String.raw`trap {
  [Console]::Error.WriteLine(("installed kiosk remote error: {0}" -f [string]$_.Exception.Message))
  [Console]::Error.WriteLine(("at {0}:{1}" -f [string]$_.InvocationInfo.ScriptName, [int]$_.InvocationInfo.ScriptLineNumber))
  [Console]::Error.WriteLine([string]$_.ScriptStackTrace)
  exit 1
}
${script}`;
  const stagingRoot = mkdtempSync(join(tmpdir(), "vem-kiosk-remote-"));
  const localScriptPath = join(stagingRoot, "run.ps1");
  const remoteScriptPath = `C:\\Windows\\Temp\\vem-kiosk-${process.pid}-${Date.now()}.ps1`;
  writeFileSync(localScriptPath, `${diagnosticScript}\n`, "utf8");
  const childOptions = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: nonQueryChildEnvironment(),
  };
  let result;
  try {
    const scp = buildScpCommand(localScriptPath, remoteScriptPath, options);
    const copy = spawnSync(scp[0], scp.slice(1), childOptions);
    if (copy.status !== 0) {
      throw new Error(
        copy.stderr ||
          copy.stdout ||
          `installed kiosk remote script upload failed (exit=${copy.status ?? "null"}, signal=${copy.signal ?? "none"})`,
      );
    }
    result = spawnSync(
      ssh[0],
      [...ssh.slice(1), buildRemotePowerShellCommand(remoteScriptPath)],
      childOptions,
    );
  } finally {
    rmSync(stagingRoot, { recursive: true, force: true });
    spawnSync(
      ssh[0],
      [
        ...ssh.slice(1),
        buildEncodedPowerShellCommand(
          `Remove-Item -LiteralPath ${quotePowerShellSingleQuoted(remoteScriptPath)} -Force -ErrorAction SilentlyContinue`,
        ),
      ],
      childOptions,
    );
  }
  let output = null;
  try {
    output = JSON.parse(result.stdout || "null");
  } catch {}
  if (result.status !== 0 || output?.ok !== true) {
    throw new Error(
      result.stderr ||
        result.stdout ||
        `installed kiosk sale remote operation failed (exit=${result.status ?? "null"}, signal=${result.signal ?? "none"})`,
    );
  }
  return output;
}

export async function captureInstalledKioskSaleHook({
  options,
  attestation,
  selector,
  route,
}) {
  const sidecar = await openMachineUiCdpSidecar({
    remote: options.remote,
    sshPort: options.sshPort,
    identityFile: options.identity,
    certificateFile: options.certificate,
    sshKnownHostsPath: options.sshKnownHostsPath,
    sshHostKeyAlias: options.sshHostKeyAlias,
    remoteCdpPort: 9222,
  });
  let client;
  try {
    const target = await discoverMachineUiTarget({
      endpoint: sidecar.endpoint,
      expectedTargetId: attestation.targetId,
    });
    client = new CdpClient(
      rewriteWebSocketDebuggerUrl(
        target.webSocketDebuggerUrl,
        sidecar.endpoint,
      ),
    );
    await client.connect();
    await waitForRoute(client, route, { timeoutMs: 30_000 });
    const hook = await evaluateExpression(
      client,
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? { orderId: el.dataset.orderId, paymentId: el.dataset.paymentId, orderNo: el.dataset.orderNo, commandId: el.dataset.commandId || null, route: location.hash } : null; })()`,
    );
    if (!hook || !hook.orderId || !hook.paymentId || !hook.orderNo)
      throw new Error(
        `required rendered customer UI hook is missing: ${selector}`,
      );
    return { targetId: target.id, route: hook.route, ...hook };
  } finally {
    await Promise.allSettled([
      client?.close() ?? Promise.resolve(),
      sidecar.close(),
    ]);
  }
}

async function runInstalledKioskCatalogScenario({ options, attestation }) {
  const sidecar = await openMachineUiCdpSidecar({
    remote: options.remote,
    sshPort: options.sshPort,
    identityFile: options.identity,
    certificateFile: options.certificate,
    sshKnownHostsPath: options.sshKnownHostsPath,
    sshHostKeyAlias: options.sshHostKeyAlias,
    remoteCdpPort: 9222,
  });
  let client;
  try {
    const target = await discoverMachineUiTarget({
      endpoint: sidecar.endpoint,
      expectedTargetId: attestation.targetId,
    });
    client = new CdpClient(
      rewriteWebSocketDebuggerUrl(
        target.webSocketDebuggerUrl,
        sidecar.endpoint,
      ),
    );
    await client.connect();
    await enablePageRuntime(client);
    const evidence = [];
    for (const step of [
      {
        name: "catalog category",
        selector: '[data-test="catalog-category"]:not(:disabled)',
        before: "#/catalog",
        after: "#/catalog",
      },
      {
        name: "catalog product",
        selector: '[data-test="catalog-product"]',
        before: "#/catalog",
        after: /^#\/products\//,
      },
      {
        name: "buy",
        selector: '[data-test="product-buy"]',
        before: /^#\/products\//,
        after: "#/checkout",
      },
    ]) {
      const before = await waitForRoute(client, step.before, {
        timeoutMs: 30_000,
      });
      const activation = await activateVisibleSelector(client, step.selector, {
        kind: "touch",
        timeoutMs: 30_000,
      });
      const after = await waitForRoute(client, step.after, {
        timeoutMs: 30_000,
      });
      evidence.push({
        type: "customer-activation",
        label: step.name,
        selector: step.selector,
        input: activation.input,
        routeBefore: before.route,
        routeAfter: after.route,
      });
    }
    return {
      schemaVersion: "installed-kiosk-catalog-scenario/v1",
      targetId: target.id,
      evidence,
      final: await captureCheckpoint(client, "checkout-ready", {
        timeoutMs: 30_000,
      }),
    };
  } finally {
    await Promise.allSettled([
      client?.close() ?? Promise.resolve(),
      sidecar.close(),
    ]);
  }
}

export function buildVmRuntimeAcceptancePlan(options = {}) {
  const { canonicalRunId, machineCode, machineCodePrefix } =
    buildEphemeralMachineCodeBinding(options);
  const runId = canonicalRunId;
  const platformTarget = String(options.platformTarget ?? "").trim();
  if (platformTarget.length === 0) {
    throw new Error(
      "VM runtime acceptance requires explicit --platform-target for the ephemeral stack",
    );
  }
  if (isSharedPlatformTarget(platformTarget)) {
    throw new Error(
      `VM runtime acceptance refuses shared platform target: ${platformTarget}`,
    );
  }
  assertNotSharedOrKnownProductionTarget(
    EPHEMERAL_DATABASE_URL_ENV,
    process.env[EPHEMERAL_DATABASE_URL_ENV] ?? options.ephemeralDatabaseUrl,
  );
  const apiBaseUrl = assertNotSharedOrKnownProductionTarget(
    "--ephemeral-api-base-url",
    options.ephemeralApiBaseUrl,
  );
  const mqttUrl = assertNotSharedOrKnownProductionTarget(
    "--ephemeral-mqtt-url",
    options.ephemeralMqttUrl,
  );
  const evidenceRoot = `${
    options.evidenceRoot ?? DEFAULT_VM_ACCEPTANCE_EVIDENCE_ROOT
  }/${runId}`;
  const reportPath = `${evidenceRoot}/vm-runtime-acceptance-report.json`;
  const logsRoot = `${evidenceRoot}/logs`;
  const screenshotsRoot = `${evidenceRoot}/screenshots`;
  const sessionsRoot = `${evidenceRoot}/sessions`;
  const ephemeralPlatformEvidence = `${evidenceRoot}/ephemeral-platform.json`;
  const runtimeAcceptanceReport = `${evidenceRoot}/runtime-acceptance-response.json`;
  const postSaleRuntimeAcceptanceReport = `${evidenceRoot}/post-sale-runtime-acceptance-response.json`;
  const saleFlowReport = `${evidenceRoot}/simulated-hardware-sale-flow-response.json`;
  const serialConformanceReport = `${evidenceRoot}/serial-com-scanner-sale-conformance.json`;
  const customerUiSaleNormalRoot = `${evidenceRoot}/installed-kiosk-sale-normal`;
  const customerUiSaleScannerRoot = `${evidenceRoot}/installed-kiosk-sale-scanner`;
  const customerUiSaleCompetitionRoot = `${evidenceRoot}/installed-kiosk-sale-route-competition`;
  const customerUiSaleIpcRecoveryRoot = `${evidenceRoot}/installed-kiosk-sale-ipc-recovery`;
  const delayedPickupNativeAudioRoot = `${evidenceRoot}/installed-kiosk-sale-delayed-pickup-native-audio`;
  const customerUiSaleNormalReport = `${customerUiSaleNormalRoot}/report.json`;
  const customerUiSaleScannerReport = `${customerUiSaleScannerRoot}/report.json`;
  const customerUiSaleCompetitionReport = `${customerUiSaleCompetitionRoot}/report.json`;
  const customerUiSaleIpcRecoveryReport = `${customerUiSaleIpcRecoveryRoot}/report.json`;
  const delayedPickupNativeAudioReport = `${delayedPickupNativeAudioRoot}/report.json`;
  const runtimeCommand = buildAcceptanceScriptCommand(
    "runtime-acceptance",
    { ...options, runId, machineCode, platformTarget },
    [
      "--ephemeral-platform-evidence",
      ephemeralPlatformEvidence,
      "--out",
      runtimeAcceptanceReport,
    ],
  );
  const postSaleRuntimeCommand = buildAcceptanceScriptCommand(
    "runtime-acceptance",
    { ...options, runId, machineCode, platformTarget },
    [
      "--ephemeral-platform-evidence",
      ephemeralPlatformEvidence,
      "--already-claimed",
      "--out",
      postSaleRuntimeAcceptanceReport,
    ],
  );
  const salePrepareCommand = buildAcceptanceScriptCommand(
    "simulated-hardware-sale-flow",
    { ...options, runId, machineCode, platformTarget },
    [
      "--ephemeral-platform-evidence",
      ephemeralPlatformEvidence,
      "--sale-phase",
      "fixture",
      "--already-claimed",
      "--out",
      `${evidenceRoot}/simulated-hardware-sale-prepare-response.json`,
    ],
  );
  const saleCompleteCommand = buildAcceptanceScriptCommand(
    "simulated-hardware-sale-flow",
    { ...options, runId, machineCode, platformTarget },
    [
      "--ephemeral-platform-evidence",
      ephemeralPlatformEvidence,
      "--sale-phase",
      "complete",
      "--out",
      saleFlowReport,
    ],
  );
  const failureMatrixArtifacts = {
    "malformed-frame": {
      report: `${evidenceRoot}/failure-matrix/malformed-frame/serial-conformance-failure.json`,
    },
    "device-disconnected": {
      report: `${evidenceRoot}/failure-matrix/device-disconnected/serial-conformance-failure.json`,
    },
    "swapped-roles": {
      report: `${evidenceRoot}/failure-matrix/swapped-roles/serial-conformance-failure.json`,
      salePrepare: `${evidenceRoot}/failure-matrix/swapped-roles/sale-prepare-response.json`,
      runtimeRecovery: `${evidenceRoot}/failure-matrix/swapped-roles/runtime-recovery-response.json`,
    },
    "missing-device": {
      report: `${evidenceRoot}/failure-matrix/missing-device/serial-conformance-failure.json`,
      salePrepare: `${evidenceRoot}/failure-matrix/missing-device/sale-prepare-response.json`,
      runtimeRecovery: `${evidenceRoot}/failure-matrix/missing-device/runtime-recovery-response.json`,
    },
    "scanner-timeout": {
      report: `${evidenceRoot}/failure-matrix/scanner-timeout/serial-conformance-failure.json`,
      salePrepare: `${evidenceRoot}/failure-matrix/scanner-timeout/sale-prepare-response.json`,
    },
    "dispense-failed": {
      report: `${evidenceRoot}/failure-matrix/dispense-failed/serial-conformance-failure.json`,
      saleComplete: `${evidenceRoot}/failure-matrix/dispense-failed/sale-complete-response.json`,
    },
  };
  const serialLifecycleReference = `vm-lifecycle://${runId.toLowerCase()}.runtime-acceptance`;
  const buildInstalledKioskSaleCommand = (profile, out, alreadyClaimed) => {
    const command = [
      process.execPath,
      "scripts/testbed/installed-kiosk-sale-acceptance.mjs",
      "--run-id",
      runId,
      "--machine-code",
      machineCode,
      "--platform-target",
      platformTarget,
      "--ephemeral-platform-evidence",
      ephemeralPlatformEvidence,
      "--runtime-acceptance-report",
      runtimeAcceptanceReport,
      "--identity",
      options.identity ?? "certificate-ssh-identity-required",
      "--certificate",
      options.certificate ?? "certificate-ssh-certificate-required",
      "--adapter",
      process.env.VEM_VM_HOST_ADAPTER ?? "runner-service-adapter",
      "--target-identity",
      process.env.VEM_VM_HOST_TARGET_ID ?? "vm-target://runtime-testbed",
      "--runtime-base",
      options.approvedRuntimeBase ?? "runner-approved-runtime-base-required",
      "--lifecycle-reference",
      serialLifecycleReference,
      "--profile",
      profile,
      ...(alreadyClaimed ? ["--already-claimed"] : []),
      "--out",
      out,
    ];
    if (options.scannerCodeFile) {
      command.push("--scanner-code-file", options.scannerCodeFile);
    }
    if (options.runtimeGuestEndpointJson) {
      command.push(
        "--runtime-guest-endpoint-json",
        options.runtimeGuestEndpointJson,
        "--expected-testbed-user",
        options.expectedTestbedUser ?? "Admin",
      );
    } else {
      command.push("--remote", options.remote ?? DEFAULT_RUNTIME_REMOTE);
      if (options.sshPort) command.push("--ssh-port", String(options.sshPort));
    }
    if (options.sshKnownHostsPath) {
      command.push("--ssh-known-hosts-path", options.sshKnownHostsPath);
    }
    if (options.sshHostKeyAlias) {
      command.push("--ssh-host-key-alias", options.sshHostKeyAlias);
    }
    return command;
  };
  const installedKioskSaleNormalCommand = buildInstalledKioskSaleCommand(
    "vm-normal",
    customerUiSaleNormalReport,
    true,
  );
  const installedKioskSaleScannerCommand = buildInstalledKioskSaleCommand(
    "vm-scanner-payment-code",
    customerUiSaleScannerReport,
    true,
  );
  const installedKioskSaleCompetitionCommand = buildInstalledKioskSaleCommand(
    "vm-route-competition",
    customerUiSaleCompetitionReport,
    true,
  );
  const installedKioskSaleIpcRecoveryCommand = buildInstalledKioskSaleCommand(
    "vm-ipc-recovery",
    customerUiSaleIpcRecoveryReport,
    true,
  );
  const delayedPickupNativeAudioCommand = buildInstalledKioskSaleCommand(
    "vm-delayed-pickup-native-audio",
    delayedPickupNativeAudioReport,
    true,
  );
  const failureMatrixCommands = {
    "swapped-roles": {
      salePrepareCommand: buildAcceptanceScriptCommand(
        "simulated-hardware-sale-flow",
        { ...options, runId, machineCode, platformTarget },
        [
          "--ephemeral-platform-evidence",
          ephemeralPlatformEvidence,
          "--sale-phase",
          "fixture",
          "--already-claimed",
          "--out",
          failureMatrixArtifacts["swapped-roles"].salePrepare,
        ],
      ),
      runtimeRecoveryCommand: buildAcceptanceScriptCommand(
        "runtime-acceptance",
        { ...options, runId, machineCode, platformTarget },
        ["--out", failureMatrixArtifacts["swapped-roles"].runtimeRecovery],
      ),
    },
    "missing-device": {
      salePrepareCommand: buildAcceptanceScriptCommand(
        "simulated-hardware-sale-flow",
        { ...options, runId, machineCode, platformTarget },
        [
          "--ephemeral-platform-evidence",
          ephemeralPlatformEvidence,
          "--sale-phase",
          "fixture",
          "--already-claimed",
          "--out",
          failureMatrixArtifacts["missing-device"].salePrepare,
        ],
      ),
      runtimeRecoveryCommand: buildAcceptanceScriptCommand(
        "runtime-acceptance",
        { ...options, runId, machineCode, platformTarget },
        ["--out", failureMatrixArtifacts["missing-device"].runtimeRecovery],
      ),
    },
    "scanner-timeout": {
      salePrepareCommand: buildAcceptanceScriptCommand(
        "simulated-hardware-sale-flow",
        { ...options, runId, machineCode, platformTarget },
        [
          "--ephemeral-platform-evidence",
          ephemeralPlatformEvidence,
          "--sale-phase",
          "fixture",
          "--already-claimed",
          "--out",
          failureMatrixArtifacts["scanner-timeout"].salePrepare,
        ],
      ),
    },
    "dispense-failed": {
      saleCompleteCommand: buildAcceptanceScriptCommand(
        "simulated-hardware-sale-flow",
        { ...options, runId, machineCode, platformTarget },
        [
          "--ephemeral-platform-evidence",
          ephemeralPlatformEvidence,
          "--sale-phase",
          "complete",
          "--out",
          failureMatrixArtifacts["dispense-failed"].saleComplete,
        ],
      ),
    },
  };
  const saleCorrelationId = `sale-correlation://vm-runtime-${runId.toLowerCase()}`;
  const saleFlowCommand = [
    process.execPath,
    "scripts/testbed/vm-host-adapter-serial-conformance.mjs",
    "--adapter",
    process.env.VEM_VM_HOST_ADAPTER ?? "runner-service-adapter",
    "--scanner-code-file",
    options.scannerCodeFile ?? "runner-owned-scanner-code-file-required",
    "--runner-signing-key-file",
    options.serialRunnerSigningKeyFile ??
      "runner-owned-serial-signing-key-file-required",
    "--expected-runner-public-key",
    options.expectedSerialRunnerPublicKey ??
      "expected-serial-runner-public-key-required",
    "--run-id",
    runId,
    "--target-identity",
    process.env.VEM_VM_HOST_TARGET_ID ?? "vm-target://runtime-testbed",
    "--runtime-base",
    options.approvedRuntimeBase ?? "runner-approved-runtime-base-required",
    "--lifecycle-reference",
    serialLifecycleReference,
    "--sale-correlation-id",
    saleCorrelationId,
    "--machine-code",
    machineCode,
    "--ephemeral-platform-evidence",
    ephemeralPlatformEvidence,
    "--sale-prepare-command-json",
    JSON.stringify(salePrepareCommand),
    "--sale-complete-command-json",
    JSON.stringify(saleCompleteCommand),
    "--runtime-recovery-command-json",
    JSON.stringify(runtimeCommand),
    "--failure-matrix-commands-json",
    JSON.stringify(failureMatrixCommands),
    "--failure-matrix-artifact-paths-json",
    JSON.stringify(failureMatrixArtifacts),
    "--out",
    serialConformanceReport,
  ];
  return {
    schemaVersion: "vm-runtime-acceptance-plan/v1",
    mode: "vm-runtime-acceptance",
    runId,
    target: {
      testbedName: "win10-vem-e2e",
      machineCode,
      machineCodePrefix,
      platformTarget,
      remote: options.remote ?? DEFAULT_RUNTIME_REMOTE,
    },
    evidenceRoot,
    artifacts: {
      source: "runtime-base",
      report: reportPath,
      logsRoot,
      screenshotsRoot,
      sessionsRoot,
      ephemeralPlatformEvidence,
      runtimeBase: options.approvedRuntimeBase ?? null,
      runtimeAcceptance: runtimeAcceptanceReport,
      postSaleRuntimeAcceptance: postSaleRuntimeAcceptanceReport,
      simulatedHardwareSaleFlow: saleFlowReport,
      serialConformance: serialConformanceReport,
      failureMatrix: failureMatrixArtifacts,
      customerUiSaleNormal: customerUiSaleNormalReport,
      customerUiSaleScanner: customerUiSaleScannerReport,
      customerUiSaleRouteCompetition: customerUiSaleCompetitionReport,
      customerUiSaleIpcRecovery: customerUiSaleIpcRecoveryReport,
      customerUiSale: customerUiSaleCompetitionReport,
      delayedPickupNativeAudio: delayedPickupNativeAudioReport,
    },
    serialRunnerExpectedPublicKey:
      options.expectedSerialRunnerPublicKey ?? null,
    expectedAdapterIdentity:
      process.env.VEM_VM_HOST_EXPECTED_ADAPTER_IDENTITY ?? null,
    ci: {
      entrypoint:
        "node scripts/testbed/win10-vem-e2e.mjs --mode vm-runtime-acceptance",
      requiredSecrets: [],
      requiredCredentials: ["runtime-base", "certificate-only-ssh"],
      requiredEnvironment: ["PAYMENT_MOCK_ENABLED=true"],
      githubActionsScope: "future manual runtime gate",
    },
    readinessLevels: {
      runtimeBase: "asserted_by_overlay_restore",
      runtimeReady: "asserted_by_runtime_acceptance_step",
      simulatedHardwareReady: "asserted_by_sale_flow_step",
      sellReady: "not_asserted",
    },
    steps: [
      {
        name: "ephemeral platform setup",
        mode: "prepare-ephemeral-platform",
        status: "planned",
        cwd: "apps/service-api",
        command: [
          "pnpm",
          "run",
          "testbed:prepare-ephemeral-platform",
          "--",
          "--run-id",
          runId,
          "--api-base-url",
          apiBaseUrl,
          "--mqtt-url",
          mqttUrl,
          "--machine-code-prefix",
          machineCodePrefix,
          "--allow-ephemeral-target",
          "--allow-mock-payment",
          "--reset",
          "--output",
          `../../${ephemeralPlatformEvidence}`,
        ],
        env: {
          PAYMENT_MOCK_ENABLED: "true",
        },
        requiresEphemeralDatabase: true,
        report: ephemeralPlatformEvidence,
        blocksOnFailure: true,
      },
      {
        name: "runtime acceptance",
        mode: "runtime-acceptance",
        status: "planned",
        command: runtimeCommand,
        report: runtimeAcceptanceReport,
        blocksOnFailure: true,
      },
      {
        name: "installed kiosk sale normal",
        mode: "installed-kiosk-sale",
        status: "planned",
        command: installedKioskSaleNormalCommand,
        ephemeralPlatformEvidence,
        report: customerUiSaleNormalReport,
        blocksOnFailure: true,
        requiresEphemeralDatabase: true,
      },
      {
        name: "installed kiosk sale scanner payment-code",
        mode: "installed-kiosk-sale",
        status: "planned",
        command: installedKioskSaleScannerCommand,
        ephemeralPlatformEvidence,
        report: customerUiSaleScannerReport,
        blocksOnFailure: true,
        requiresEphemeralDatabase: true,
      },
      {
        name: "installed kiosk sale route competition",
        mode: "installed-kiosk-sale",
        status: "planned",
        command: installedKioskSaleCompetitionCommand,
        ephemeralPlatformEvidence,
        report: customerUiSaleCompetitionReport,
        blocksOnFailure: true,
        requiresEphemeralDatabase: true,
      },
      {
        name: "installed kiosk sale ipc recovery",
        mode: "installed-kiosk-sale",
        status: "planned",
        command: installedKioskSaleIpcRecoveryCommand,
        ephemeralPlatformEvidence,
        report: customerUiSaleIpcRecoveryReport,
        blocksOnFailure: true,
        requiresEphemeralDatabase: true,
      },
      {
        name: "post-sale runtime acceptance",
        mode: "runtime-acceptance",
        status: "planned",
        command: postSaleRuntimeCommand,
        report: postSaleRuntimeAcceptanceReport,
        blocksOnFailure: true,
      },
      {
        name: "delayed pickup native audio live sale",
        mode: "installed-kiosk-sale",
        status: "planned",
        command: delayedPickupNativeAudioCommand,
        ephemeralPlatformEvidence,
        report: delayedPickupNativeAudioReport,
        issue16ControlPlaneProfile: "delayed-pickup-native-audio",
        blocksOnFailure: true,
        requiresEphemeralDatabase: true,
      },
    ],
  };
}

function readJsonIfPresent(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readFailureMatrixArtifacts(paths) {
  if (!paths || typeof paths !== "object") return null;
  const artifactKinds = [
    "report",
    "salePrepare",
    "saleComplete",
    "runtimeRecovery",
  ];
  return Object.fromEntries(
    Object.entries(paths).map(([failureMode, entries]) => [
      failureMode,
      Object.fromEntries(
        artifactKinds.map((kind) => [kind, readJsonIfPresent(entries?.[kind])]),
      ),
    ]),
  );
}

const REDACTED = "[REDACTED]";
const REDACTED_KEY = "[REDACTED_KEY]";
const SENSITIVE_REPORT_KEY_PATTERN =
  /claim[-_]?code|token|secret|password|passwd|pwd|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|wifi[-_]?password|network[-_]?password|ssid[-_]?password/i;

function redactSensitiveText(value) {
  return String(value)
    .replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
      `$1${REDACTED}@`,
    )
    .replace(
      /\b(postgres(?:ql)?:\/\/[^:\s/@]+):([^@\s]+)@/gi,
      `$1:${REDACTED}@`,
    )
    .replace(
      /\b(claimCode|token|secret|password)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1=${REDACTED}`,
    )
    .replace(
      /"(claimCode|token|secret|password)"\s*:\s*("[^"]*"|'[^']*'|[^\s,;}]+)/gi,
      `"$1":"${REDACTED}"`,
    )
    .replace(
      /(-{1,2}(?:claim[-_]?code|token|secret|password|passwd|pwd|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|wifi[-_]?password|network[-_]?password|ssid[-_]?password))(?:=|\s+)("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1=${REDACTED}`,
    )
    .replace(/VEM-WIN10-REAL-01/gi, REDACTED)
    .replace(/100\.66\.207\.119/g, REDACTED)
    .replace(/DESKTOP-2IDRN2K/gi, REDACTED)
    .replace(/\bAdmin@real\b/gi, REDACTED)
    .replace(/\bAdmin@100\.66\.207\.119\b/gi, REDACTED)
    .replace(/\bAdmin@desktop-2idrn2k\b/gi, REDACTED)
    .replace(
      /\b(wifiPassword|ssidPassword|networkPassword|现场 network credentials)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1=${REDACTED}`,
    );
}

function isSensitiveReportKey(key) {
  const keyText = String(key);
  return (
    SENSITIVE_REPORT_KEY_PATTERN.test(keyText) ||
    redactSensitiveText(keyText) !== keyText
  );
}

function sanitizeReportKey(key) {
  return isSensitiveReportKey(key) ? REDACTED_KEY : key;
}

function sanitizeReportValue(value) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === "string") {
    return redactSensitiveText(value);
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReportValue(item));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const sensitiveKey = isSensitiveReportKey(key);
      return [
        sanitizeReportKey(key),
        sensitiveKey ? REDACTED : sanitizeReportValue(item),
      ];
    }),
  );
}

function sanitizeVmRuntimeAcceptancePlan(plan) {
  return JSON.parse(
    JSON.stringify(plan, (_key, value) =>
      typeof value === "string" ? redactSensitiveText(value) : value,
    ),
  );
}

function sanitizeVmRuntimeAcceptanceStep(step = {}) {
  return {
    name: step.name,
    mode: step.mode,
    status: step.status,
    cwd: step.cwd,
    report: step.report,
    ephemeralPlatformEvidence: step.ephemeralPlatformEvidence,
    blocksOnFailure: step.blocksOnFailure,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    exitCode: step.exitCode,
    stdoutPath: step.stdoutPath,
    stderrPath: step.stderrPath,
    error: step.error === null ? null : redactSensitiveText(step.error ?? ""),
  };
}

function sanitizeVmRuntimeAcceptanceDiagnostics(diagnostics) {
  return diagnostics.map((diagnostic) => ({
    ...diagnostic,
    detail:
      diagnostic.detail === null
        ? null
        : redactSensitiveText(diagnostic.detail ?? ""),
  }));
}

function appendDisplayEvidence(displayEvidence, source, evidence) {
  if (evidence) {
    displayEvidence.push({ source, evidence });
  }
}

function appendSessionsFromDisplayEvidence(sessions, source, displayEvidence) {
  const sessionList = displayEvidence?.interactiveWindowsSessions?.sessions;
  if (!Array.isArray(sessionList)) {
    return;
  }
  for (const session of sessionList) {
    sessions.push({ source, ...normalizeSessionEvidence(session) });
  }
}

function vmStepArtifactSummary(step = {}) {
  return {
    name: step.name,
    mode: step.mode,
    status: step.status,
    report: step.report,
    stdoutPath: step.stdoutPath,
    stderrPath: step.stderrPath,
  };
}

function buildVmRuntimeAcceptanceEvidenceIndexes({ plan, steps }) {
  const displayEvidence = [];
  const sessions = [];
  const screenshotArtifacts = [];
  const stepArtifacts = steps.map(vmStepArtifactSummary);

  for (const step of steps) {
    appendDisplayEvidence(
      displayEvidence,
      `${step.name}:inventory-display-evidence`,
      step.parsed?.inventory?.displayEvidence,
    );
    appendDisplayEvidence(
      displayEvidence,
      `${step.name}:runtime-acceptance-display-evidence`,
      step.parsed?.runtimeAcceptanceReport?.displayEvidence,
    );
    appendDisplayEvidence(
      displayEvidence,
      `${step.name}:facts-subset-display-evidence`,
      step.parsed?.runtimeAcceptanceFactsSubset?.displayEvidence,
    );
    appendSessionsFromDisplayEvidence(
      sessions,
      `${step.name}:inventory-display-evidence`,
      step.parsed?.inventory?.displayEvidence,
    );
    appendSessionsFromDisplayEvidence(
      sessions,
      `${step.name}:runtime-acceptance-display-evidence`,
      step.parsed?.runtimeAcceptanceReport?.displayEvidence,
    );

    const stepScreenshots = step.parsed?.screenshots;
    if (Array.isArray(stepScreenshots)) {
      for (const screenshot of stepScreenshots) {
        screenshotArtifacts.push({
          source: `${step.name}:screenshots`,
          path: String(screenshot?.path ?? screenshot),
        });
      }
    }
  }

  return {
    screenshots: {
      schemaVersion: "vm-runtime-acceptance-screenshot-index/v1",
      status: screenshotArtifacts.length > 0 ? "indexed" : "missing",
      missingReason:
        screenshotArtifacts.length > 0 ? null : "no_screenshot_artifacts",
      root: plan.artifacts.screenshotsRoot,
      screenshots: screenshotArtifacts,
      displayEvidence,
      stepArtifacts,
    },
    sessions: {
      schemaVersion: "vm-runtime-acceptance-session-index/v1",
      status: sessions.length > 0 ? "indexed" : "missing",
      missingReason: sessions.length > 0 ? null : "no_session_evidence",
      root: plan.artifacts.sessionsRoot,
      sessions,
      stepArtifacts,
    },
  };
}

export function writeVmRuntimeAcceptanceEvidenceIndexes({ plan, steps }) {
  const indexes = buildVmRuntimeAcceptanceEvidenceIndexes({ plan, steps });
  mkdirSync(plan.artifacts.screenshotsRoot, { recursive: true });
  mkdirSync(plan.artifacts.sessionsRoot, { recursive: true });
  writeFileSync(
    `${plan.artifacts.screenshotsRoot}/index.json`,
    `${JSON.stringify(indexes.screenshots, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(
    `${plan.artifacts.sessionsRoot}/index.json`,
    `${JSON.stringify(indexes.sessions, null, 2)}\n`,
    "utf8",
  );
  return indexes;
}

function windowsComPathFromGuestIdentity(identity) {
  const match = String(identity ?? "").match(
    /^(?:windows-com|guest-com|serial-com):\/\/(COM[1-9][0-9]*)$/i,
  );
  return match ? match[1].toUpperCase() : null;
}

function serialAcceptanceDiagnostic(code, message) {
  return { code, message };
}

function hasOneObservedIdentity(observation, expected) {
  return (
    Array.isArray(observation?.occurrences) &&
    observation.occurrences.length === 1 &&
    Array.isArray(observation?.unique) &&
    observation.unique.length === 1 &&
    observation.unique[0] === expected &&
    observation.count === 1
  );
}

function hasReservationExactOnce(reservation, observation, count, orderId) {
  if (
    !reservation ||
    typeof reservation.source !== "string" ||
    !Number.isSafeInteger(reservation.rawRecordCount) ||
    typeof reservation.reservationId !== "string" ||
    typeof reservation.orderId !== "string" ||
    typeof reservation.orderItemId !== "string" ||
    typeof reservation.inventoryId !== "string" ||
    !Number.isSafeInteger(reservation.quantity)
  ) {
    return false;
  }
  return (
    reservation.exposed === true &&
    reservation.source ===
      "authoritative_ephemeral_platform.inventory_reservations" &&
    reservation.rawRecordCount === 1 &&
    reservation.orderId === orderId &&
    reservation.quantity === 1 &&
    reservation.status === "confirmed" &&
    count === 1 &&
    hasOneObservedIdentity(observation, reservation.reservationId)
  );
}

export function evaluateSimulatedHardwareSerialEvidence({
  saleFlow,
  serialConformance,
  expectedRunnerPublicKey,
  expectedAdapterIdentity,
  failureArtifacts = null,
  requireFailureArtifacts = false,
} = {}) {
  const diagnostics = [];
  const facts = saleFlow?.simulatedHardwareSaleFlow ?? saleFlow;
  const serialConfiguration = facts?.daemonSerialConfiguration;
  const sale = facts?.sale;
  let validatedConformance = null;
  try {
    validatedConformance = validateSerialConformanceReport(serialConformance, {
      expectedRunnerPublicKey,
      expectedAdapterIdentity,
    });
  } catch {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "serial_conformance_report_invalid",
        "Acceptance requires the complete serial conformance report to be revalidated before evidence labels are consumed.",
      ),
    );
  }
  const session = validatedConformance?.reports.start.serialSession;
  const collect = validatedConformance?.reports.collect;
  const records = collect?.serialEvidence?.records;
  const firstStop = validatedConformance?.reports.firstStop;
  const repeatedStop = validatedConformance?.reports.repeatedStop;

  if (
    facts?.phase !== "complete" ||
    facts?.hostSerialEvidencePending !== true
  ) {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "serial_acceptance_intermediate_evidence_required",
        "Serial acceptance requires the completed guest sale-flow intermediate evidence.",
      ),
    );
  }
  if (
    serialConfiguration?.hardwareAdapter !== "serial" ||
    serialConfiguration?.scannerAdapter !== "serial_text"
  ) {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "serial_adapter_evidence_required",
        "Acceptance requires daemon hardwareAdapter=serial and scannerAdapter=serial_text.",
      ),
    );
  }
  const lowerPort = String(
    serialConfiguration?.lowerControllerPort ?? "",
  ).toUpperCase();
  const scannerPort = String(
    serialConfiguration?.scannerPort ?? "",
  ).toUpperCase();
  if (
    !/^COM[1-9][0-9]*$/.test(lowerPort) ||
    !/^COM[1-9][0-9]*$/.test(scannerPort) ||
    serialConfiguration?.lowerControllerPortObserved !== true ||
    serialConfiguration?.scannerPortObserved !== true
  ) {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "windows_com_path_evidence_required",
        "Acceptance requires observed non-TCP Windows COM paths for both daemon adapters.",
      ),
    );
  }
  if (!lowerPort || !scannerPort || lowerPort === scannerPort) {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "distinct_virtual_com_mapping_required",
        "Acceptance requires distinct lower-controller and scanner COM mappings.",
      ),
    );
  }
  const mappings = session?.deviceMappings;
  if (
    validatedConformance?.reports?.start?.result !== "succeeded" ||
    !Array.isArray(mappings) ||
    !session?.serialSessionId ||
    !session?.deviceMappingDigest
  ) {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "guest_serial_session_evidence_required",
        "Acceptance requires a successful guest serial session and device mapping digest.",
      ),
    );
  } else {
    const byRole = new Map(mappings.map((mapping) => [mapping?.role, mapping]));
    const lowerMapping = byRole.get("lower-controller");
    const scannerMapping = byRole.get("scanner");
    if (
      byRole.size !== 2 ||
      mappings.length !== 2 ||
      lowerMapping?.connectionState !== "connected" ||
      scannerMapping?.connectionState !== "connected" ||
      windowsComPathFromGuestIdentity(lowerMapping?.guestDeviceIdentity) !==
        lowerPort ||
      windowsComPathFromGuestIdentity(scannerMapping?.guestDeviceIdentity) !==
        scannerPort
    ) {
      diagnostics.push(
        serialAcceptanceDiagnostic(
          "guest_serial_mapping_mismatch",
          "Guest serial mappings must be connected, role-distinct Windows COM identities matching the daemon configuration.",
        ),
      );
    }
  }
  const hasBoundFrame = (role, event) =>
    Array.isArray(records) &&
    records.some(
      (record) =>
        record?.role === role &&
        record?.event === event &&
        record?.capturedFrame?.source === "guest-serial-session" &&
        Number.isInteger(record?.capturedFrame?.sequence) &&
        record.capturedFrame.sequence > 0 &&
        typeof record.capturedFrame.digest === "string" &&
        record.capturedFrame.digest.startsWith("sha256:") &&
        Number.isInteger(record.capturedFrame.byteLength) &&
        record.capturedFrame.byteLength > 0 &&
        record?.saleBinding?.orderId === sale?.orderId &&
        record?.saleBinding?.paymentId === sale?.paymentId &&
        record?.saleBinding?.vendingCommandId === sale?.vendingCommandId &&
        record?.deviceMappingDigest === session?.deviceMappingDigest,
    );
  if (
    collect?.result !== "succeeded" ||
    collect?.serialEvidence?.serialSessionId !== session?.serialSessionId ||
    collect?.serialEvidence?.deviceMappingDigest !==
      session?.deviceMappingDigest ||
    !hasBoundFrame("scanner", "scanner-injection") ||
    !hasBoundFrame("lower-controller", "dispense-request") ||
    !hasBoundFrame("lower-controller", "dispense-result")
  ) {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "guest_serial_frame_evidence_required",
        "Acceptance requires guest-captured scanner and lower-controller frames bound to this sale; software injection or missing frames are rejected.",
      ),
    );
  }
  const expectedFailureDiagnostics = new Map([
    ["malformed-frame", "serial_malformed_frame"],
    ["device-disconnected", "serial_device_disconnected"],
    ["scanner-timeout", "serial_scanner_timeout"],
    ["dispense-failed", "serial_dispense_failed"],
    ["swapped-roles", "serial_swapped_roles"],
    ["missing-device", "serial_missing_device"],
  ]);
  const failureMatrix = validatedConformance?.failureMatrix;
  const failureByMode = new Map(
    Array.isArray(failureMatrix)
      ? failureMatrix.map((entry) => [entry?.failureMode, entry])
      : [],
  );
  const lifecycleMatchesSession = (report) =>
    report?.result === "succeeded" &&
    report?.serialSession?.serialSessionId === session?.serialSessionId &&
    report?.serialSession?.deviceMappingDigest ===
      session?.deviceMappingDigest &&
    report?.serialSession?.simulatorCleanup?.survivingProcessCount === 0;
  const failureMatrixComplete =
    Array.isArray(failureMatrix) &&
    failureMatrix.length === expectedFailureDiagnostics.size &&
    failureByMode.size === expectedFailureDiagnostics.size &&
    [...expectedFailureDiagnostics].every(([failureMode, diagnosticCode]) => {
      const failure = failureByMode.get(failureMode);
      const recoveryRequired =
        failureMode === "swapped-roles" || failureMode === "missing-device";
      const expectedOperation =
        failureMode === "scanner-timeout"
          ? "inject-scanner-code"
          : failureMode === "swapped-roles" || failureMode === "missing-device"
            ? "prepare-sale-with-faulted-mapping"
            : "collect-serial-evidence";
      const sourceSale =
        failure?.source?.fault?.request?.serialSession?.saleBindings;
      const hasCompletedSaleBinding =
        Array.isArray(sourceSale) &&
        sourceSale.length === 1 &&
        sourceSale[0]?.orderId === sale?.orderId &&
        sourceSale[0]?.paymentId === sale?.paymentId &&
        sourceSale[0]?.vendingCommandId === sale?.vendingCommandId;
      const hasFailureSaleBinding =
        Array.isArray(sourceSale) &&
        sourceSale.length === 1 &&
        sourceSale[0]?.orderId === failure?.orderId &&
        sourceSale[0]?.paymentId === failure?.paymentId &&
        (failureMode === "scanner-timeout"
          ? !Object.hasOwn(failure ?? {}, "vendingCommandId") &&
            sourceSale[0]?.vendingCommandId === null
          : sourceSale[0]?.vendingCommandId ===
            (failure?.vendingCommandId ?? null));
      const hasMappingRecoveryEvidence =
        failure?.source?.start?.request?.operation === "start-serial-session" &&
        failure?.source?.fault?.request?.operation === "start-serial-session" &&
        Array.isArray(
          failure?.source?.start?.request?.serialSession?.saleBindings,
        ) &&
        failure.source.start.request.serialSession.saleBindings.length === 0 &&
        Array.isArray(sourceSale) &&
        sourceSale.length === 0 &&
        failure?.daemonFailClosed?.commandExitStatus > 0 &&
        failure?.daemonFailClosed?.simulatedHardwareReady === "failed" &&
        failure?.daemonFailClosed?.daemonHealthObserved === true &&
        failure?.daemonFailClosed?.hardwareOnline === false &&
        failure?.daemonFailClosed?.readyzObserved === true &&
        failure?.daemonFailClosed?.saleBindingCreated === false &&
        Array.isArray(failure?.daemonFailClosed?.readinessBlockingCodes) &&
        failure.daemonFailClosed.readinessBlockingCodes.length === 1 &&
        failure.daemonFailClosed.readinessBlockingCodes[0] ===
          "LOWER_CONTROLLER_UNAVAILABLE" &&
        Array.isArray(failure?.daemonFailClosed?.responseBlockingCodes) &&
        failure.daemonFailClosed.responseBlockingCodes.length === 1 &&
        failure.daemonFailClosed.responseBlockingCodes[0] ===
          "LOWER_CONTROLLER_UNAVAILABLE";
      return (
        failure?.result === "observed_failure" &&
        failure?.adapterResult === "succeeded" &&
        failure?.operation === expectedOperation &&
        failure?.diagnosticCode === diagnosticCode &&
        (recoveryRequired
          ? hasMappingRecoveryEvidence &&
            failure?.recovery?.runtimeReady === "passed" &&
            failure?.recovery?.hardwareOnline === true &&
            failure?.recovery?.scannerOnline === true &&
            failure?.recovery?.ready === true
          : failureMode === "malformed-frame" ||
              failureMode === "device-disconnected"
            ? hasCompletedSaleBinding &&
              failure?.orderId === sale?.orderId &&
              failure?.paymentId === sale?.paymentId &&
              failure?.vendingCommandId === sale?.vendingCommandId
            : hasFailureSaleBinding)
      );
    });
  if (
    !lifecycleMatchesSession(firstStop) ||
    !lifecycleMatchesSession(repeatedStop) ||
    repeatedStop?.serialSession?.simulatorCleanup?.idempotencyVerified !==
      true ||
    !failureMatrixComplete
  ) {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "guest_serial_lifecycle_evidence_required",
        "Acceptance requires idempotent serial-session cleanup and the complete observed failure matrix before hardware readiness can be asserted.",
      ),
    );
  }
  const malformedFrame = failureByMode.get("malformed-frame");
  const scannerTimeout = failureByMode.get("scanner-timeout");
  const dispenseFailed = failureByMode.get("dispense-failed");
  const dispenseFailedSale =
    failureArtifacts?.["dispense-failed"]?.saleComplete
      ?.simulatedHardwareSaleFlow ??
    failureArtifacts?.["dispense-failed"]?.saleComplete ??
    null;
  const dispenseFailedSaleFacts = dispenseFailedSale?.sale ?? null;
  const dispenseFailedPlatform = dispenseFailedSale?.platformState ?? null;
  const dispenseFailedOutcomeValid =
    dispenseFailedSale?.phase === "complete" &&
    dispenseFailed?.orderId &&
    dispenseFailed?.paymentId &&
    dispenseFailed?.vendingCommandId &&
    dispenseFailedSaleFacts?.orderId === dispenseFailed.orderId &&
    dispenseFailedSaleFacts?.paymentId === dispenseFailed.paymentId &&
    dispenseFailedSaleFacts?.vendingCommandId ===
      dispenseFailed.vendingCommandId &&
    ["succeeded", "refund_pending", "refunded"].includes(
      String(dispenseFailedSaleFacts?.paymentStatus ?? ""),
    ) &&
    [
      "dispense_failed",
      "refund_pending",
      "refunded",
      "manual_handling",
    ].includes(String(dispenseFailedSaleFacts?.orderStatus ?? "")) &&
    dispenseFailedSaleFacts?.customerResult !== "success" &&
    dispenseFailedSaleFacts?.dispenseSucceeded !== true &&
    dispenseFailedPlatform?.fulfillmentStatus === "dispense_failed" &&
    dispenseFailedPlatform?.stockMovementAccepted !== true &&
    dispenseFailedPlatform?.postSaleDispenseMovement?.status === "missing" &&
    dispenseFailedPlatform?.postSaleDispenseMovement?.movementId == null;
  if (requireFailureArtifacts && !dispenseFailedOutcomeValid) {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "serial_failure_authority_missing",
        "Issue20 requires authoritative daemon/platform failure evidence showing post-payment dispense faults end in refund or manual handling without success, accepted stock movement, or inventory decrement.",
      ),
    );
  }
  const scannerFailureAtomic =
    malformedFrame?.orderId === sale?.orderId &&
    malformedFrame?.paymentId === sale?.paymentId &&
    malformedFrame?.vendingCommandId === sale?.vendingCommandId &&
    scannerTimeout?.orderId &&
    scannerTimeout?.paymentId &&
    !Object.hasOwn(scannerTimeout ?? {}, "vendingCommandId");
  if (requireFailureArtifacts && !scannerFailureAtomic) {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "serial_scanner_failure_atomicity_missing",
        "Issue20 requires malformed scanner evidence to stay bound to the successful sale and timeout evidence to stop before any vending command is created.",
      ),
    );
  }
  return {
    status: diagnostics.length === 0 ? "passed" : "failed",
    asserted: diagnostics.length === 0,
    diagnostics,
    evidence: {
      daemonSerialConfiguration: serialConfiguration ?? null,
      guestSerialEvidence: {
        status: session && Array.isArray(records) ? "captured" : "missing",
        serialSessionId: session?.serialSessionId ?? null,
        deviceMappingDigest: session?.deviceMappingDigest ?? null,
        scannerInputTransport: hasBoundFrame("scanner", "scanner-injection")
          ? "guest_serial_frame"
          : null,
        mappings: Array.isArray(mappings)
          ? mappings.map((mapping) => ({
              role: mapping.role ?? "unknown",
              guestPort: windowsComPathFromGuestIdentity(
                mapping.guestDeviceIdentity,
              ),
              connectionState: mapping.connectionState ?? "unknown",
            }))
          : [],
        frames: Array.isArray(records)
          ? records.map((record) => ({
              role: record.role ?? "unknown",
              event: record.event ?? "unknown",
              source: record.capturedFrame?.source ?? "unknown",
              sequence: record.capturedFrame?.sequence ?? null,
              digest: record.capturedFrame?.digest ?? null,
              byteLength: record.capturedFrame?.byteLength ?? null,
              orderId: record.saleBinding?.orderId ?? null,
              paymentId: record.saleBinding?.paymentId ?? null,
              vendingCommandId: record.saleBinding?.vendingCommandId ?? null,
            }))
          : [],
      },
      issue20FailureMatrix: {
        malformedFrame: malformedFrame
          ? {
              orderId: malformedFrame.orderId ?? null,
              paymentId: malformedFrame.paymentId ?? null,
              vendingCommandId: malformedFrame.vendingCommandId ?? null,
            }
          : null,
        scannerTimeout: scannerTimeout
          ? {
              orderId: scannerTimeout.orderId ?? null,
              paymentId: scannerTimeout.paymentId ?? null,
              vendingCommandId: scannerTimeout.vendingCommandId ?? null,
            }
          : null,
        dispenseFailed:
          dispenseFailed && dispenseFailedSale
            ? {
                orderId: dispenseFailed.orderId ?? null,
                paymentId: dispenseFailed.paymentId ?? null,
                vendingCommandId: dispenseFailed.vendingCommandId ?? null,
                orderStatus: dispenseFailedSaleFacts?.orderStatus ?? null,
                paymentStatus: dispenseFailedSaleFacts?.paymentStatus ?? null,
                fulfillmentStatus:
                  dispenseFailedPlatform?.fulfillmentStatus ?? null,
                stockMovementAccepted:
                  dispenseFailedPlatform?.stockMovementAccepted ?? null,
                movementStatus:
                  dispenseFailedPlatform?.postSaleDispenseMovement?.status ??
                  null,
              }
            : null,
      },
    },
  };
}

function evaluateInstalledKioskSaleEvidence(step, plan) {
  const report = step?.parsed;
  const serialPath = report?.evidence?.serialConformancePath;
  const serial = serialPath ? readJsonIfPresent(serialPath) : null;
  const diagnostics = [];
  if (
    step?.status !== "passed" ||
    report?.ok !== true ||
    report?.schemaVersion !== "installed-kiosk-sale-acceptance/v2"
  ) {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "installed_kiosk_sale_failed",
        "Installed kiosk sale step did not complete.",
      ),
    );
  }
  try {
    validateSerialConformanceReport(serial, {
      expectedRunnerPublicKey: serial?.runnerEvidence?.publicKey,
      expectedAdapterIdentity: plan.expectedAdapterIdentity,
    });
  } catch {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "installed_kiosk_serial_invalid",
        "Installed kiosk sale requires revalidated serial/scanner evidence.",
      ),
    );
  }
  const rendered = report?.correlation?.rendered;
  const platform = report?.correlation?.platform;
  const paymentCodeAttempt = platform?.paymentCodeAttempt;
  const exactOnce = report?.correlation?.exactOnce;
  const observations = platform?.observations;
  const reservation = platform?.reservation;
  const scenarioEvidence = Array.isArray(report?.machineUiCdpScenario?.evidence)
    ? report.machineUiCdpScenario.evidence
    : [];
  if (
    !rendered?.orderId ||
    !rendered?.paymentId ||
    !rendered?.orderNo ||
    !rendered?.commandId ||
    rendered.orderId !== platform?.orderId ||
    rendered.paymentId !== platform?.paymentId ||
    rendered.orderNo !== platform?.orderNo ||
    rendered.commandId !== platform?.commandId ||
    paymentCodeAttempt?.orderId !== rendered?.orderId ||
    paymentCodeAttempt?.paymentId !== rendered?.paymentId ||
    paymentCodeAttempt?.attemptNo !== 1 ||
    paymentCodeAttempt?.status !== "succeeded" ||
    paymentCodeAttempt?.isActive !== false ||
    paymentCodeAttempt?.source !== "serial_text" ||
    platform?.stockDelta !== -1 ||
    platform?.status !== "accepted" ||
    exactOnce?.orderCount !== 1 ||
    exactOnce.paymentCount !== 1 ||
    exactOnce.paymentCodeAttemptCount !== 1 ||
    exactOnce.orderNoCount !== 1 ||
    !hasReservationExactOnce(
      reservation,
      observations?.reservationIds,
      exactOnce?.reservationCount,
      rendered?.orderId,
    ) ||
    exactOnce.commandCount !== 1 ||
    exactOnce.movementCount !== 1 ||
    exactOnce.serialSaleBindingCount?.injected !== 1 ||
    exactOnce.serialSaleBindingCount?.collected !== 1 ||
    !hasOneObservedIdentity(observations?.orderIds, rendered?.orderId) ||
    !hasOneObservedIdentity(observations?.paymentIds, rendered?.paymentId) ||
    !hasOneObservedIdentity(
      observations?.paymentCodeAttemptIds,
      paymentCodeAttempt?.attemptId,
    ) ||
    !hasOneObservedIdentity(observations?.orderNos, rendered?.orderNo) ||
    !hasOneObservedIdentity(observations?.commandIds, rendered?.commandId) ||
    !hasOneObservedIdentity(
      observations?.movementIds,
      platform?.stockMovementId,
    )
  ) {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "installed_kiosk_ui_binding_missing",
        "Rendered payment, platform completion, and serial reports must bind one order, payment, order number, reservation when exposed, command, movement, and stock delta.",
      ),
    );
  }
  const requiredDisturbances = new Set(
    step?.name === "installed kiosk sale route competition"
      ? ["presence_departure", "catalog_refresh"]
      : step?.name === "installed kiosk sale ipc recovery"
        ? ["ipc_interruption"]
        : [],
  );
  if (
    requiredDisturbances.size > 0 &&
    ![...requiredDisturbances].every((disturbance) =>
      scenarioEvidence.some(
        (entry) =>
          entry?.type === "route-disturbance" &&
          entry?.disturbance === disturbance &&
          entry?.routeBefore === "#/payment" &&
          entry?.routeAfter === "#/payment",
      ),
    )
  ) {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "installed_kiosk_required_disturbance_missing",
        "Installed kiosk evidence must include the declared disturbance while the active payment route stays on Payment.",
      ),
    );
  }
  if (
    step?.name === "installed kiosk sale route competition" &&
    !scenarioEvidence.some(
      (entry) =>
        entry?.type === "customer-activation" &&
        entry?.label === "payment submit repeat" &&
        entry?.input?.method === "Input.dispatchTouchEvent",
    )
  ) {
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "installed_kiosk_repeat_submit_missing",
        "Route-competition evidence must repeat the original touchscreen submit during payment creation.",
      ),
    );
  }
  if (step?.name === "installed kiosk sale route competition") {
    const routeAction = scenarioEvidence.find(
      (entry) =>
        entry?.type === "route-action" &&
        entry?.label === "history competition during payment",
    );
    if (
      routeAction?.routeBefore !== "#/payment" ||
      routeAction?.routeAfter !== "#/payment"
    ) {
      diagnostics.push(
        serialAcceptanceDiagnostic(
          "installed_kiosk_route_competition_missing",
          "Route-competition evidence must prove the payment route rejects a competing history action.",
        ),
      );
    }
  }
  if (step?.name === "installed kiosk sale ipc recovery") {
    const ipcRecovery = scenarioEvidence.find(
      (entry) =>
        entry?.type === "route-disturbance" &&
        entry?.disturbance === "ipc_interruption",
    );
    const retained =
      ipcRecovery?.injection?.recovery?.retainedOrderCredential ?? null;
    const resumed =
      ipcRecovery?.injection?.recovery?.resumedOrderCredential ?? null;
    if (
      ipcRecovery?.injection?.recovery?.overlayObserved !== true ||
      typeof retained !== "string" ||
      retained.length === 0 ||
      retained !== resumed ||
      retained !== rendered?.orderNo
    ) {
      diagnostics.push(
        serialAcceptanceDiagnostic(
          "installed_kiosk_ipc_recovery_missing",
          "IPC recovery evidence must prove the recovery overlay appeared and the same order credential resumed on Payment.",
        ),
      );
    }
  }
  return {
    status: diagnostics.length === 0 ? "passed" : "failed",
    asserted: diagnostics.length === 0,
    diagnostics,
    evidence: { customerUiSale: report ?? null },
  };
}

function evaluateDelayedPickupNativeAudioEvidence(step) {
  const report = step?.parsed;
  const acceptance = step?.parsed?.delayedPickupNativeAudio;
  const diagnostics = [];
  if (
    step?.status !== "passed" ||
    report?.ok !== true ||
    report?.schemaVersion !== "installed-kiosk-sale-acceptance/v2"
  )
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "delayed_pickup_installed_sale_failed",
        "Delayed pickup installed sale step did not complete.",
      ),
    );
  if (
    acceptance?.schemaVersion !==
      "delayed-pickup-native-audio-production-acceptance/v3" ||
    acceptance?.result !== "passed" ||
    !acceptance?.binding ||
    !acceptance?.runtime ||
    acceptance?.audio?.source !== "windows_default_output" ||
    acceptance?.audio?.physicalSpeakerAudibility !== "hitl_required_issue_22" ||
    !Array.isArray(acceptance?.audio?.cueWindows) ||
    acceptance.audio.cueWindows.length !== 5 ||
    acceptance.audio.cueWindows.some((window) => window?.kind !== "passed") ||
    !Array.isArray(acceptance?.diagnostics) ||
    acceptance.diagnostics.length !== 0
  )
    diagnostics.push(
      serialAcceptanceDiagnostic(
        "delayed_pickup_native_audio_evidence_invalid",
        "Delayed pickup requires passed production serial, Machine journey, daemon/platform stock, and Windows default-audio evidence.",
      ),
    );
  return {
    status: diagnostics.length === 0 ? "passed" : "failed",
    asserted: diagnostics.length === 0,
    diagnostics,
    evidence: acceptance ?? null,
  };
}

export function buildVmRuntimeAcceptanceReport({ plan, steps }) {
  const stepMap = new Map(steps.map((step) => [step.name, step]));
  const ephemeral = stepMap.get("ephemeral platform setup");
  const runtime = stepMap.get("runtime acceptance");
  const saleFlow = stepMap.get("simulated hardware sale flow");
  const saleNormal = stepMap.get("installed kiosk sale normal");
  const saleScanner = stepMap.get("installed kiosk sale scanner payment-code");
  const saleCompetition = stepMap.get("installed kiosk sale route competition");
  const saleIpcRecovery = stepMap.get("installed kiosk sale ipc recovery");
  const postSaleRuntime = stepMap.get("post-sale runtime acceptance");
  const delayedPickup = stepMap.get("delayed pickup native audio live sale");
  const failureArtifacts = readFailureMatrixArtifacts(
    plan?.artifacts?.failureMatrix,
  );
  const simulatedHardwareEvidence = evaluateSimulatedHardwareSerialEvidence({
    saleFlow: saleFlow?.parsed,
    serialConformance: saleFlow?.serialConformance,
    expectedRunnerPublicKey: plan.serialRunnerExpectedPublicKey,
    expectedAdapterIdentity: plan.expectedAdapterIdentity,
    failureArtifacts,
    requireFailureArtifacts:
      saleFlow?.status === "passed" &&
      saleFlow?.parsed != null &&
      plan?.artifacts?.failureMatrix != null,
  });
  const normalSaleEvidence = evaluateInstalledKioskSaleEvidence(
    saleNormal,
    plan,
  );
  const scannerSaleEvidence = evaluateInstalledKioskSaleEvidence(
    saleScanner,
    plan,
  );
  const competitionSaleEvidence = evaluateInstalledKioskSaleEvidence(
    saleCompetition,
    plan,
  );
  const ipcRecoverySaleEvidence = evaluateInstalledKioskSaleEvidence(
    saleIpcRecovery,
    plan,
  );
  const delayedPickupEvidence =
    evaluateDelayedPickupNativeAudioEvidence(delayedPickup);
  const installedKioskEvidence = {
    status:
      normalSaleEvidence.status === "passed" &&
      scannerSaleEvidence.status === "passed" &&
      competitionSaleEvidence.status === "passed" &&
      ipcRecoverySaleEvidence.status === "passed" &&
      delayedPickupEvidence.status === "passed"
        ? "passed"
        : "failed",
    asserted:
      normalSaleEvidence.asserted === true &&
      scannerSaleEvidence.asserted === true &&
      competitionSaleEvidence.asserted === true &&
      ipcRecoverySaleEvidence.asserted === true &&
      delayedPickupEvidence.asserted === true,
    diagnostics: [
      ...normalSaleEvidence.diagnostics,
      ...scannerSaleEvidence.diagnostics,
      ...competitionSaleEvidence.diagnostics,
      ...ipcRecoverySaleEvidence.diagnostics,
      ...delayedPickupEvidence.diagnostics,
    ],
    evidence: {
      normal: normalSaleEvidence.evidence,
      scannerPaymentCode: scannerSaleEvidence.evidence,
      routeCompetition: competitionSaleEvidence.evidence,
      ipcRecovery: ipcRecoverySaleEvidence.evidence,
      delayedPickupNativeAudio: delayedPickupEvidence.evidence,
    },
  };
  const diagnostics = [
    ...simulatedHardwareEvidence.diagnostics,
    ...installedKioskEvidence.diagnostics,
    ...steps
      .filter((step) => step.status !== "passed")
      .map((step) => ({
        code:
          step.status === "blocked"
            ? `${step.mode}_blocked`
            : `${step.mode}_failed`,
        message: `${step.name} ${step.status}`,
        detail: step.error ?? null,
      })),
  ];

  const sanitizedDiagnostics =
    sanitizeVmRuntimeAcceptanceDiagnostics(diagnostics);

  return {
    schemaVersion: "vm-runtime-acceptance-report/v1",
    runId: plan.runId,
    target: plan.target,
    evidenceRoot: plan.evidenceRoot,
    artifacts: plan.artifacts,
    steps: steps.map(sanitizeVmRuntimeAcceptanceStep),
    preparationVerifierStatus: "not_asserted",
    bringUpStateProgression: {
      runtimeBase: "asserted_by_overlay_restore",
      ephemeralPlatformSetup: ephemeral?.status ?? "missing",
      runtimeAcceptance: runtime?.status ?? "missing",
      simulatedHardwareSaleFlow: saleFlow?.status ?? "missing",
      installedKioskSaleNormal: saleNormal?.status ?? "missing",
      installedKioskSaleScannerPaymentCode: saleScanner?.status ?? "missing",
      installedKioskSaleRouteCompetition: saleCompetition?.status ?? "missing",
      installedKioskSaleIpcRecovery: saleIpcRecovery?.status ?? "missing",
      postSaleRuntimeAcceptance: postSaleRuntime?.status ?? "missing",
      delayedPickupNativeAudio: delayedPickup?.status ?? "missing",
    },
    platformSetup: {
      status: ephemeral?.status ?? "missing",
      evidencePath: plan.artifacts.ephemeralPlatformEvidence,
      identifiers: ephemeral?.parsed?.testbedMachine
        ? {
            machineId: ephemeral.parsed.testbedMachine.id,
            machineCode: ephemeral.parsed.testbedMachine.code,
            claimCodeId: ephemeral.parsed.testbedMachine.claim?.claimCodeId,
            planogramVersion:
              ephemeral.parsed.seededData?.planogram?.planogramVersion,
          }
        : null,
    },
    evidenceReview: buildVmRuntimeAcceptanceEvidenceIndexes({ plan, steps }),
    simulatedHardwareMode: {
      status: saleFlow?.status ?? "missing",
      evidencePath: plan.artifacts.simulatedHardwareSaleFlow,
      serialConformancePath: plan.artifacts.serialConformance,
      serialEvidence: simulatedHardwareEvidence.evidence,
    },
    installedKioskSale: {
      status: installedKioskEvidence.status,
      normal: {
        status: saleNormal?.status ?? "missing",
        evidencePath: plan.artifacts.customerUiSaleNormal,
      },
      scannerPaymentCode: {
        status: saleScanner?.status ?? "missing",
        evidencePath: plan.artifacts.customerUiSaleScanner,
      },
      routeCompetition: {
        status: saleCompetition?.status ?? "missing",
        evidencePath: plan.artifacts.customerUiSaleRouteCompetition,
      },
      ipcRecovery: {
        status: saleIpcRecovery?.status ?? "missing",
        evidencePath: plan.artifacts.customerUiSaleIpcRecovery,
      },
      delayedPickupNativeAudio: {
        status: delayedPickupEvidence.status,
        evidencePath: plan.artifacts.delayedPickupNativeAudio,
        acceptance: delayedPickupEvidence.evidence,
      },
      serialEvidence: installedKioskEvidence.evidence,
      sellReady: {
        status: "not_asserted",
        asserted: false,
      },
    },
    runtimeAcceptanceReport:
      postSaleRuntime?.parsed?.runtimeAcceptanceReport ?? null,
    displayBinding: postSaleRuntime?.parsed?.runtimeAcceptanceReport
      ?.kioskRuntime
      ? {
          activeKioskSession: {
            sessionUser:
              postSaleRuntime.parsed.runtimeAcceptanceReport.kioskRuntime
                .sessionUser,
            sessionId:
              postSaleRuntime.parsed.runtimeAcceptanceReport.kioskRuntime
                .sessionId,
          },
          tauriRoute:
            postSaleRuntime.parsed.runtimeAcceptanceReport.kioskRuntime.url,
          cdpTargetId:
            postSaleRuntime.parsed.runtimeAcceptanceReport.kioskRuntime
              .cdpTargetId,
        }
      : null,
    finalReadiness: {
      runtimeBase: {
        status: "asserted_by_overlay_restore",
        asserted: true,
      },
      runtimeReady: postSaleRuntime?.parsed?.runtimeAcceptanceReport?.result
        ?.runtimeReady ?? {
        status: postSaleRuntime?.status ?? "missing",
        asserted: false,
      },
      simulatedHardwareReady: {
        status: simulatedHardwareEvidence.status,
        asserted: simulatedHardwareEvidence.asserted,
      },
      sellReady: {
        status: "not_asserted",
        asserted: false,
      },
    },
    diagnostics: sanitizedDiagnostics,
    ok: sanitizedDiagnostics.length === 0,
  };
}

export async function runVmRuntimeAcceptance(options, dependencies = {}) {
  if (!options.scannerCodeFile || !options.approvedRuntimeBase)
    throw new Error(
      "VM runtime acceptance requires --scanner-code-file and --runtime-base",
    );
  const plan = buildVmRuntimeAcceptancePlan(options);
  const databaseUrl = process.env[EPHEMERAL_DATABASE_URL_ENV];
  const childEnvironment = nonQueryChildEnvironment();
  delete childEnvironment[EPHEMERAL_DATABASE_URL_ENV];
  delete childEnvironment[INSTALLED_KIOSK_SALE_DATABASE_URL_ENV];
  mkdirSync(plan.evidenceRoot, { recursive: true });
  mkdirSync(plan.artifacts.logsRoot, { recursive: true });
  mkdirSync(plan.artifacts.screenshotsRoot, { recursive: true });
  mkdirSync(plan.artifacts.sessionsRoot, { recursive: true });

  const steps = [];
  let blocked = false;
  let serialRunnerTrust = null;
  const scannerCopiesRoot = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "vem-vm-runtime-scanner-"),
  );
  chmodSync(scannerCopiesRoot, 0o700);
  try {
    for (const [index, originalStep] of plan.steps.entries()) {
      let step = originalStep;
      const startedAt = new Date().toISOString();
      const stdoutPath = `${plan.artifacts.logsRoot}/${String(
        index + 1,
      ).padStart(2, "0")}-${step.mode}.stdout.log`;
      const stderrPath = `${plan.artifacts.logsRoot}/${String(
        index + 1,
      ).padStart(2, "0")}-${step.mode}.stderr.log`;
      if (blocked) {
        steps.push({
          ...step,
          status: "blocked",
          startedAt,
          finishedAt: new Date().toISOString(),
          exitCode: null,
          stdoutPath,
          stderrPath,
          error: "blocked_by_previous_failed_step",
        });
        continue;
      }
      if (step.name === "simulated hardware sale flow") {
        serialRunnerTrust = createSerialRunnerTrustAnchor();
        plan.serialRunnerExpectedPublicKey = serialRunnerTrust.publicKey;
        step = {
          ...step,
          command: replaceCommandOption(
            replaceCommandOption(
              step.command,
              "--runner-signing-key-file",
              serialRunnerTrust.signingKeyFile,
            ),
            "--expected-runner-public-key",
            serialRunnerTrust.publicKey,
          ),
        };
      }
      const scannerCodeFile = commandOption(
        step.command,
        "--scanner-code-file",
      );
      const scannerCopy = scannerCodeFile
        ? createRunScopedScannerCodeCopy(
            scannerCodeFile,
            scannerCopiesRoot,
            index,
          )
        : null;
      if (scannerCopy) {
        step = {
          ...step,
          command: replaceCommandOption(
            step.command,
            "--scanner-code-file",
            scannerCopy,
          ),
        };
      }
      let result;
      try {
        result = (dependencies.spawnSync ?? spawnSync)(
          step.command[0],
          step.command.slice(1),
          {
            cwd: step.cwd ?? process.cwd(),
            encoding: "utf8",
            env: {
              ...childEnvironment,
              ...(step.env ?? {}),
              ...(step.requiresEphemeralDatabase
                ? step.mode === "installed-kiosk-sale"
                  ? {
                      [INSTALLED_KIOSK_SALE_DATABASE_URL_ENV]: databaseUrl,
                    }
                  : { [EPHEMERAL_DATABASE_URL_ENV]: databaseUrl }
                : {}),
            },
          },
        );
      } finally {
        if (scannerCopy) rmSync(scannerCopy, { force: true });
      }
      writeFileSync(stdoutPath, result.stdout ?? "", "utf8");
      writeFileSync(stderrPath, result.stderr ?? "", "utf8");
      const status = result.status === 0 ? "passed" : "failed";
      const parsed =
        status === "passed"
          ? (readJsonIfPresent(step.report) ??
            JSON.parse(result.stdout || "null"))
          : readJsonIfPresent(step.report);
      const stepResult = {
        ...step,
        status,
        startedAt,
        finishedAt: new Date().toISOString(),
        exitCode: result.status,
        stdoutPath,
        stderrPath,
        parsed,
        error:
          status === "passed" ? null : result.stderr || result.stdout || null,
      };
      if (step.name === "simulated hardware sale flow") {
        stepResult.serialConformance = readJsonIfPresent(
          plan.artifacts.serialConformance,
        );
      }
      steps.push(stepResult);
      if (status !== "passed" && step.blocksOnFailure) {
        blocked = true;
      }
    }

    const report = buildVmRuntimeAcceptanceReport({ plan, steps });
    writeVmRuntimeAcceptanceEvidenceIndexes({ plan, steps });
    writeFileSync(
      plan.artifacts.report,
      `${JSON.stringify(report, null, 2)}\n`,
    );
    return report;
  } finally {
    serialRunnerTrust?.cleanup();
    rmSync(scannerCopiesRoot, { recursive: true, force: true });
  }
}

function createSerialRunnerTrustAnchor() {
  const root = mkdtempSync(
    join(process.env.RUNNER_TEMP ?? tmpdir(), "vem-serial-runner-trust-"),
  );
  chmodSync(root, 0o700);
  const signingKeyFile = join(root, "runner-ed25519.pem");
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    signingKeyFile,
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 },
  );
  chmodSync(signingKeyFile, 0o600);
  return {
    signingKeyFile,
    publicKey: `ed25519-public-key:base64:${publicKey
      .export({ type: "spki", format: "der" })
      .toString("base64")}`,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function replaceCommandOption(command, option, value) {
  const index = command.indexOf(option);
  if (index === -1 || !command[index + 1])
    throw new Error(`${option} is required for serial conformance`);
  const replaced = [...command];
  replaced[index + 1] = value;
  return replaced;
}

function commandOption(command, option) {
  const index = command.indexOf(option);
  return index === -1 ? null : (command[index + 1] ?? null);
}

function createRunScopedScannerCodeCopy(source, root, stepIndex) {
  const target = join(
    root,
    `${String(stepIndex + 1).padStart(2, "0")}-scanner-code`,
  );
  copyFileSync(source, target);
  chmodSync(target, 0o600);
  return target;
}

function writeJsonOutput(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function splitTaskName(taskName) {
  const index = taskName.lastIndexOf("\\");
  if (index === -1) {
    return { taskPath: "\\", taskName };
  }
  return {
    taskPath: `\\${taskName.slice(0, index)}\\`,
    taskName: taskName.slice(index + 1),
  };
}

export function buildRemotePowerShellScript(options = {}) {
  const mode = options.mode ?? "inventory";
  const machineCode = options.machineCode ?? "VEM-TESTBED-WINVM-01";
  const supportedModes = [
    "inventory",
    "reset",
    "inventory-reset",
    "provision",
    "runtime-acceptance",
    "simulated-hardware-sale-flow",
  ];
  if (!supportedModes.includes(mode)) {
    throw new Error(`unsupported mode: ${mode}`);
  }
  assertTestbedMachineCode(machineCode);
  const runId =
    mode === "simulated-hardware-sale-flow" ||
    ((mode === "provision" || mode === "runtime-acceptance") &&
      options.ephemeralPlatformEvidence)
      ? sanitizeRunId(options.runId)
      : "not-applicable";
  const ephemeralPlatformSetup = readEphemeralPlatformSetupEvidence({
    ...options,
    mode,
    runId,
    machineCode,
  });
  const platformOverride =
    options.platformApiBaseUrl && options.platformMqttUrl
      ? {
          apiBaseUrl: options.platformApiBaseUrl,
          mqttUrl: options.platformMqttUrl,
        }
      : null;
  const platformTarget =
    ephemeralPlatformSetup?.target ?? options.platformTarget ?? "vem-vps";
  if (
    mode === "provision" &&
    !ephemeralPlatformSetup &&
    !Object.hasOwn(PLATFORM_TARGETS, platformTarget)
  ) {
    throw new Error(`unsupported platform target: ${platformTarget}`);
  }
  const platform =
    ephemeralPlatformSetup ??
    platformOverride ??
    PLATFORM_TARGETS[platformTarget] ??
    PLATFORM_TARGETS["vem-vps"];
  const claimCode =
    mode === "simulated-hardware-sale-flow" ||
    ((mode === "provision" || mode === "runtime-acceptance") &&
      ephemeralPlatformSetup)
      ? ephemeralPlatformSetup.claimCode
      : (options.claimCode ?? "");
  if (mode === "provision" && String(claimCode).trim().length === 0) {
    throw new Error("provision mode requires --claim-code");
  }
  const plan = assertResetPlanPreservesTestbed(buildResetPlan());
  const taskRemovals = plan.unregisterScheduledTasks
    .map((task) => {
      const { taskPath, taskName } = splitTaskName(task);
      return `Invoke-ResetStep $resetActions "unregister scheduled task ${task}" {
  $task = Get-ScheduledTask -TaskName ${psString(taskName)} -TaskPath ${psString(taskPath)} -ErrorAction SilentlyContinue
  if ($null -ne $task) {
    Unregister-ScheduledTask -TaskName ${psString(taskName)} -TaskPath ${psString(taskPath)} -Confirm:$false -ErrorAction Stop
  }
}
Assert-ResetPostcondition $resetActions "scheduled task ${task} removed" {
  $null -eq (Get-ScheduledTask -TaskName ${psString(taskName)} -TaskPath ${psString(taskPath)} -ErrorAction SilentlyContinue)
}`;
    })
    .join("\n");
  const serviceStops = plan.stopServices
    .map(
      (service) => `Invoke-ResetStep $resetActions "stop service ${service}" {
  $service = Get-Service -Name ${psString(service)} -ErrorAction SilentlyContinue
  if ($null -ne $service) {
    if ($service.Status -ne "Stopped") {
      Stop-Service -Name ${psString(service)} -Force -ErrorAction Stop
    }
    $deleteOutput = sc.exe delete ${psString(service)} 2>&1
    if ($LASTEXITCODE -ne 0) {
      throw "sc.exe delete ${service} failed ($LASTEXITCODE): $deleteOutput"
    }
  }
}
Assert-ResetPostcondition $resetActions "service ${service} removed" {
  $null -eq (Get-ServiceStateOrNull -Name ${psString(service)})
}`,
    )
    .join("\n");
  const directoryRemovals = plan.removeDirectories
    .map(
      (path) => `Invoke-ResetStep $resetActions "remove directory ${path}" {
  if (Test-Path -LiteralPath ${psString(path)}) {
    Remove-Item -LiteralPath ${psString(path)} -Recurse -Force -ErrorAction Stop
  }
}
Assert-ResetPostcondition $resetActions "directory ${path} removed" {
  -not (Test-Path -LiteralPath ${psString(path)})
}`,
    )
    .join("\n");
  const fileRemovals = plan.removeFiles
    .map(
      (path) => `Invoke-ResetStep $resetActions "remove file ${path}" {
  if (Test-Path -LiteralPath ${psString(path)}) {
    Remove-Item -LiteralPath ${psString(path)} -Force -ErrorAction Stop
  }
}
Assert-ResetPostcondition $resetActions "file ${path} removed" {
  -not (Test-Path -LiteralPath ${psString(path)})
}`,
    )
    .join("\n");

  return `$ErrorActionPreference = "Stop"

function Read-JsonFile([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    throw "file not found: $Path"
  }
  return [System.IO.File]::ReadAllText(
    $Path,
    [System.Text.Encoding]::UTF8
  ) | ConvertFrom-Json
}

function Write-JsonFile([string]$Path, $Value) {
  $directory = Split-Path -Parent $Path
  if (-not (Test-Path -LiteralPath $directory)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  $json = $Value | ConvertTo-Json -Depth 60
  [System.IO.File]::WriteAllText($Path, $json, [System.Text.UTF8Encoding]::new($false))
}

function Get-ServiceStateOrNull([string]$Name) {
  $service = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $service) { return $null }
  return [pscustomobject]@{
    name = $service.Name
    status = [string]$service.Status
    startType = [string]$service.StartType
  }
}

function Test-LocalAdmin {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}


function Test-PathEvidence([string]$Path) {
  $item = Get-Item -LiteralPath $Path -ErrorAction SilentlyContinue
  if ($null -eq $item) {
    return [pscustomobject]@{ path = $Path; exists = $false; kind = $null }
  }
  return [pscustomobject]@{
    path = $Path
    exists = $true
    kind = if ($item.PSIsContainer) { "directory" } else { "file" }
  }
}

function Get-ManualProcessEvidence([string]$Name, [string]$ExpectedPath) {
  $matches = @(Get-CimInstance Win32_Process -Filter "Name = '$Name'" -ErrorAction SilentlyContinue | Where-Object {
    $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $ExpectedPath)
  })
  if ($matches.Count -ne 1) {
    return [ordered]@{
      running = $false
      processId = $null
      user = "unknown"
      executablePath = if ($matches.Count -gt 0) { [string]$matches[0].ExecutablePath } else { $ExpectedPath }
    }
  }
  $cim = $matches[0]
  $owner = Invoke-CimMethod -InputObject $cim -MethodName GetOwner -ErrorAction SilentlyContinue
  return [ordered]@{
    running = $true
    processId = [int]$cim.ProcessId
    user = if ($null -ne $owner -and -not [string]::IsNullOrWhiteSpace($owner.User)) { [string]$owner.User } else { "unknown" }
    executablePath = [IO.Path]::GetFullPath($cim.ExecutablePath)
  }
}

function Get-ArtifactSha256([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
  try { return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() } catch { return $null }
}

function Test-ReadyFileReadableByKioskUser([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
  try {
    $acl = Get-Acl -LiteralPath $Path
    return @($acl.Access | Where-Object { [string]$_.IdentityReference -match "(^|\\)VEMKiosk$" -and $_.AccessControlType -eq "Allow" -and ("Read", "ReadAndExecute", "FullControl" -contains [string]$_.FileSystemRights) }).Count -gt 0
  } catch { return $false }
}

function New-RuntimeAcceptanceAssertion([string]$Status, [bool]$Asserted) {
  return [ordered]@{ status = $Status; asserted = $Asserted }
}

function Add-RuntimeAcceptanceDiagnostic($Diagnostics, [string]$Code, [string]$Message) {
  $Diagnostics.Add([ordered]@{ code = $Code; message = $Message }) | Out-Null
}

function Classify-RuntimeAcceptanceReport($Facts) {
  $diagnostics = [System.Collections.Generic.List[object]]::new()
  if (-not ([string]$Facts.target.machineCode).StartsWith("VEM-TESTBED-", [StringComparison]::Ordinal)) { Add-RuntimeAcceptanceDiagnostic $diagnostics "testbed_machine_identity_required" "Runtime acceptance requires a VEM-TESTBED-* machine identity." }
  if ([string]$Facts.provisioning.machineCode -ne [string]$Facts.target.machineCode) { Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_config_machine_identity_mismatch" "Daemon-observed machine identity must match the requested testbed target." }
  if (-not [bool]$Facts.readyFile.exists) { Add-RuntimeAcceptanceDiagnostic $diagnostics "ready_file_missing" "Daemon ready file must exist before runtime-ready can pass." }
  if (-not [bool]$Facts.readyFile.readableByKioskUser) { Add-RuntimeAcceptanceDiagnostic $diagnostics "ready_file_not_readable_by_kiosk" "Daemon ready file must be readable by VEMKiosk." }
  if (-not [bool]$Facts.readyFile.ipcEndpointPresent -or -not [bool]$Facts.readyFile.tokenPresent) { Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_ipc_handoff_missing" "Ready file must include the daemon IPC endpoint and token." }
  if (-not [bool]$Facts.daemonRuntime.processRunning -or [int]$Facts.daemonRuntime.processId -lt 1 -or [string]$Facts.daemonRuntime.processUser -ne "Admin" -or [string]$Facts.daemonRuntime.executablePath -ine "C:\\VEM\\bringup\\vending-daemon.exe") { Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_process_not_ready" "The manually started daemon process must run as Admin from C:\\VEM\\bringup\\vending-daemon.exe." }
  if (-not [bool]$Facts.daemonRuntime.ipcReachable) { Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_ipc_unreachable" "Daemon IPC must be reachable through the ready-file handoff." }
  if (-not [bool]$Facts.provisioning.provisioned) { Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_provisioning_incomplete" "Machine Provisioning must complete before runtime-ready can pass." }
  if (-not [bool]$Facts.provisioning.usedDaemonIpcTaskExecute) { Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_provisioning_bypassed_daemon_ipc" "Machine Provisioning must use the daemon IPC claim path." }
  if (-not [bool]$Facts.daemonRuntime.readyz.ready) { Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_readyz_not_ready" "Daemon readyz must report ready before runtime-ready can pass." }
  if (-not [bool]$Facts.daemonRuntime.healthz.backendOnline -or -not [bool]$Facts.daemonRuntime.healthz.mqttConnected) { Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_connectivity_failed" "Daemon health must report backend and MQTT connectivity." }
  if (-not [bool]$Facts.kioskRuntime.webviewRunning -or [string]$Facts.kioskRuntime.sessionUser -ne "VEMKiosk" -or [int]$Facts.kioskRuntime.processId -lt 1 -or [int]$Facts.kioskRuntime.machineProcessCount -ne 1 -or [string]$Facts.kioskRuntime.machineExecutablePath -ine "C:\\VEM\\bringup\\machine.exe") { Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_ui_process_not_ready" "The manually started Machine UI must be the unique VEMKiosk process from C:\\VEM\\bringup\\machine.exe." }
  if ([string]$Facts.kioskRuntime.sessionId -ne [string]$Facts.displayEvidence.interactiveDesktopDisplayBaseline.sessionId -or [string]$Facts.kioskRuntime.sessionId -ne [string]$Facts.displayEvidence.portraitKioskAcceptance.sessionId) { Add-RuntimeAcceptanceDiagnostic $diagnostics "kiosk_session_id_mismatch" "Machine UI evidence must match the active VEMKiosk interactive session." }
  if ([string]$Facts.displayEvidence.interactiveDesktopDisplayBaseline.status -ne "passed" -or [int]$Facts.displayEvidence.interactiveDesktopDisplayBaseline.widthPx -ne 1080 -or [int]$Facts.displayEvidence.interactiveDesktopDisplayBaseline.heightPx -ne 1920) { Add-RuntimeAcceptanceDiagnostic $diagnostics "interactive_desktop_display_baseline_missing" "Interactive display must be 1080x1920." }
  if ([string]$Facts.displayEvidence.portraitKioskAcceptance.status -ne "passed" -or [string]$Facts.displayEvidence.portraitKioskAcceptance.source -ne "interactive_kiosk_session" -or [int]$Facts.displayEvidence.portraitKioskAcceptance.widthPx -ne 1080 -or [int]$Facts.displayEvidence.portraitKioskAcceptance.heightPx -ne 1920) { Add-RuntimeAcceptanceDiagnostic $diagnostics "portrait_kiosk_acceptance_missing" "Portrait kiosk evidence must be 1080x1920 from the interactive kiosk session." }
  return [ordered]@{ schemaVersion = "runtime-acceptance-report/v1"; mode = $Facts.mode; target = $Facts.target; artifacts = $Facts.artifacts; displayEvidence = $Facts.displayEvidence; readyFile = $Facts.readyFile; provisioning = $Facts.provisioning; daemonRuntime = $Facts.daemonRuntime; kioskRuntime = $Facts.kioskRuntime; result = [ordered]@{ runtimeReady = if ($diagnostics.Count -eq 0) { New-RuntimeAcceptanceAssertion "passed" $true } else { New-RuntimeAcceptanceAssertion "failed" $false }; simulatedHardwareReady = New-RuntimeAcceptanceAssertion "not_asserted" $false; sellReady = New-RuntimeAcceptanceAssertion "not_asserted" $false }; diagnostics = @($diagnostics) }
}

function Get-RuntimeAcceptanceReport($ProvisioningActions = @()) {
  $inventory = Get-InventoryFacts $ProvisioningActions
  $factsSubset = $inventory.runtimeAcceptanceFactsSubset
  $daemonIpc = Get-DaemonIpcInventoryEvidence "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json"
  $facts = [ordered]@{
    mode = "installed_runtime"
    target = $factsSubset.target
    artifacts = [ordered]@{ daemonSha256 = Get-ArtifactSha256 "C:\\VEM\\bringup\\vending-daemon.exe"; machineUiSha256 = Get-ArtifactSha256 "C:\\VEM\\bringup\\machine.exe" }
    displayEvidence = $factsSubset.displayEvidence
    readyFile = [ordered]@{ exists = [bool]$daemonIpc.readyFile.exists; readableByKioskUser = Test-ReadyFileReadableByKioskUser "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json"; ipcEndpointPresent = [bool]$daemonIpc.readyFile.ipcEndpointPresent; tokenPresent = [bool]$daemonIpc.readyFile.tokenPresent }
    provisioning = $factsSubset.provisioning
    daemonRuntime = $factsSubset.daemonRuntime
    kioskRuntime = $factsSubset.kioskRuntime
  }
  $facts.daemonRuntime.ipcReachable = [bool]$daemonIpc.healthz.observed -and [bool]$daemonIpc.readyz.observed
  $facts.daemonRuntime.healthz = [ordered]@{ backendOnline = [bool]$daemonIpc.healthz.backendOnline; mqttConnected = [bool]$daemonIpc.healthz.mqttConnected }
  $facts.daemonRuntime.readyz = [ordered]@{ ready = [bool]$daemonIpc.readyz.ready }
  $report = Classify-RuntimeAcceptanceReport $facts
  Write-JsonFile ${psString(RUNTIME_ACCEPTANCE_REPORT_FILE)} $report
  return [ordered]@{ path = ${psString(RUNTIME_ACCEPTANCE_REPORT_FILE)}; report = $report }
}

function Get-IpcBaseUrl($Ready) {
  $healthz = [string]$Ready.healthzUrl
  if ([string]::IsNullOrWhiteSpace($healthz)) {
    throw "healthzUrl missing from daemon ready file"
  }
  if (-not $healthz.EndsWith("/healthz", [StringComparison]::OrdinalIgnoreCase)) {
    throw "invalid healthzUrl in daemon ready file: $healthz"
  }
  return $healthz.Substring(0, $healthz.Length - "/healthz".Length)
}

function Get-HttpErrorInfo($ErrorRecord) {
  $statusCode = $null
  $bodyText = ""
  $response = $ErrorRecord.Exception.Response

  if ($null -ne $response) {
    if ($null -ne $response.StatusCode) {
      $statusCode = [int]$response.StatusCode
    }
    if ($null -ne $response.Content) {
      try {
        $bodyText = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      } catch {
        $bodyText = ""
      }
    } elseif ($response.PSObject.Methods.Name -contains "GetResponseStream") {
      try {
        $stream = $response.GetResponseStream()
        if ($null -ne $stream) {
          $reader = New-Object System.IO.StreamReader($stream)
          $bodyText = $reader.ReadToEnd()
        }
      } catch {
        $bodyText = ""
      }
    }
  }

  if ($bodyText.Length -eq 0 -and $null -ne $ErrorRecord.ErrorDetails -and $null -ne $ErrorRecord.ErrorDetails.Message) {
    $bodyText = $ErrorRecord.ErrorDetails.Message
  }

  $body = $null
  if ($bodyText.Length -gt 0) {
    try {
      $body = $bodyText | ConvertFrom-Json -ErrorAction Stop
    } catch {
      $body = $null
    }
  }

  [pscustomobject]@{
    statusCode = $statusCode
    bodyText = $bodyText
    body = $body
  }
}

function Invoke-IpcJson([string]$Method, [string]$Uri, $Headers, $Body = $null, [int]$TimeoutSec = 20) {
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -TimeoutSec $TimeoutSec
  }
  $json = $Body | ConvertTo-Json -Depth 40 -Compress
  return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -ContentType "application/json" -Body $json -TimeoutSec 60
}

function Convert-ClaimFailureClassification($ErrorInfo) {
  if ($null -ne $ErrorInfo.body -and -not [string]::IsNullOrWhiteSpace($ErrorInfo.body.code)) {
    return [string]$ErrorInfo.body.code
  }
  if ($null -ne $ErrorInfo.statusCode) {
    return "http_$($ErrorInfo.statusCode)"
  }
  return "request_failed"
}

function Get-NetworkSaleResponseBlockingCodes($ErrorInfo) {
  if ($null -eq $ErrorInfo.body) {
    return @()
  }
  $messageProperty = $ErrorInfo.body.PSObject.Properties["message"]
  if ($null -eq $messageProperty -or $null -eq $messageProperty.Value) {
    return @()
  }
  $message = [string]$messageProperty.Value
  $match = [regex]::Match(
    $message,
    '\Amachine is not ready for network sale: ([A-Z][A-Z0-9_]*(?:,[A-Z][A-Z0-9_]*)*)\z',
    [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
  )
  if (-not $match.Success) {
    return @()
  }
  return @($match.Groups[1].Value.Split(','))
}

function Test-ConfigFieldPresent($Object, [string]$Name) {
  if ($null -eq $Object) { return $false }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $false }
  $value = $property.Value
  if ($null -eq $value) { return $false }
  if ($value -is [string]) {
    return -not [string]::IsNullOrWhiteSpace($value)
  }
  return $true
}

function Assert-FirstClaimConfig($Config) {
  if ([bool]$Config.provisioned) {
    throw "first-claim provisioning requires reset before reusing provisioned config"
  }

  foreach ($field in @("machineSecretConfigured", "mqttSigningSecretConfigured", "mqttPasswordConfigured")) {
    $property = $Config.PSObject.Properties[$field]
    if ($null -ne $property -and [bool]$property.Value) {
      throw "first-claim provisioning requires reset before reusing credentialed config: $field"
    }
  }

  $public = $Config.public
  if ($null -eq $public) {
    throw "daemon config response missing public config"
  }
  foreach ($field in @(
    "machineCode",
    "machineId",
    "machineName",
    "machineStatus",
    "machineLocationLabel",
    "mqttUsername",
    "mqttClientId",
    "runtimeEndpoints",
    "hardwareProfile",
    "paymentCapability",
    "provisioningMetadata"
  )) {
    if (Test-ConfigFieldPresent $public $field) {
      if ($field -eq "machineCode" -and -not ([string]$public.machineCode).StartsWith("VEM-TESTBED-", [StringComparison]::Ordinal)) {
        throw "refusing to provision over non-testbed configured identity: $($public.machineCode)"
      }
      throw "first-claim provisioning requires reset before reusing final config field: $field"
    }
  }
}

function Get-ConfigSnapshotFromRuntimeSummary($Summary) {
  if ($null -ne $Summary -and $null -ne $Summary.sourceDocuments -and $null -ne $Summary.sourceDocuments.bootstrap) {
    $bootstrap = $Summary.sourceDocuments.bootstrap
    $profile = $Summary.sourceDocuments.profileCache
    $secrets = $Summary.secretStatus
    $platform = $Summary.platform
    $machine = $Summary.machine
    $machineSecret = $null -ne $secrets -and [bool]$secrets.machineSecretConfigured
    $mqttSigningSecret = $null -ne $secrets -and [bool]$secrets.mqttSigningSecretConfigured
    $mqttPassword = $null -ne $secrets -and [bool]$secrets.mqttPasswordConfigured
    $profileAccepted = $null -ne $profile
    return [pscustomobject]@{
      public = [pscustomobject]@{
        machineCode = if ($null -ne $machine) { $machine.code } else { $null }
        machineId = if ($null -ne $machine) { $machine.id } else { $null }
        machineName = if ($null -ne $machine) { $machine.name } else { $null }
        machineStatus = if ($null -ne $machine) { $machine.status } else { $null }
        machineLocationLabel = if ($null -ne $machine) { $machine.locationLabel } else { $null }
        apiBaseUrl = if ($null -ne $platform) { $platform.apiBaseUrl } else { $bootstrap.provisioningApiBaseUrl }
        mqttUrl = if ($null -ne $platform -and $null -ne $platform.mqttConnection) { $platform.mqttConnection.url } else { $null }
      }
      machineSecretConfigured = $machineSecret
      mqttSigningSecretConfigured = $mqttSigningSecret
      mqttPasswordConfigured = $mqttPassword
      provisioned = $profileAccepted -and $machineSecret -and $mqttSigningSecret
      provisioningIssues = @()
      runtimeBootstrapConfigured = $true
    }
  }
  if ($null -eq $Summary -or $null -eq $Summary.effectivePublic -or $null -eq $Summary.configuredState) {
    throw "daemon runtime configuration summary is incomplete"
  }
  $state = $Summary.configuredState
  $public = $Summary.effectivePublic
  $issues = [System.Collections.Generic.List[string]]::new()
  if (-not [bool]$state.provisioningProfileCache) { $issues.Add("provisioning_profile_cache_missing") }
  if ([string]::IsNullOrWhiteSpace([string]$public.machineCode)) { $issues.Add("machine_code_missing") }
  if (-not [bool]$state.machineSecretConfigured) { $issues.Add("machine_secret_missing") }
  if (-not [bool]$state.mqttSigningSecretConfigured) { $issues.Add("mqtt_signing_secret_missing") }
  if ($null -ne $public.mqttUsername -and -not [bool]$state.mqttPasswordConfigured) { $issues.Add("mqtt_password_missing") }
  return [pscustomobject]@{
    public = $public
    machineSecretConfigured = [bool]$state.machineSecretConfigured
    mqttSigningSecretConfigured = [bool]$state.mqttSigningSecretConfigured
    mqttPasswordConfigured = [bool]$state.mqttPasswordConfigured
    provisioned = $issues.Count -eq 0
    provisioningIssues = @($issues)
    runtimeBootstrapConfigured = [bool]$state.runtimeManifest
  }
}

function Convert-ConfigSnapshotEvidence($Config) {
  if ($null -eq $Config) {
    return [ordered]@{
      observed = $false
      provisioned = $false
      machineCode = $null
      apiBaseUrl = $null
      mqttUrl = $null
      hardwareAdapter = $null
      scannerAdapter = $null
      machineSecretConfigured = $false
      mqttSigningSecretConfigured = $false
      mqttPasswordConfigured = $false
      provisioningIssues = @()
      error = $null
    }
  }
  return [ordered]@{
    observed = $true
    provisioned = [bool]$Config.provisioned
    machineCode = if ($null -ne $Config.public) { $Config.public.machineCode } else { $null }
    apiBaseUrl = if ($null -ne $Config.public) { $Config.public.apiBaseUrl } else { $null }
    mqttUrl = if ($null -ne $Config.public) { $Config.public.mqttUrl } else { $null }
    hardwareAdapter = if ($null -ne $Config.public) { $Config.public.hardwareAdapter } else { $null }
    scannerAdapter = if ($null -ne $Config.public) { $Config.public.scannerAdapter } else { $null }
    machineSecretConfigured = [bool]$Config.machineSecretConfigured
    mqttSigningSecretConfigured = [bool]$Config.mqttSigningSecretConfigured
    mqttPasswordConfigured = [bool]$Config.mqttPasswordConfigured
    provisioningIssues = @($Config.provisioningIssues | ForEach-Object { [string]$_ })
    error = $null
  }
}

function Convert-HealthzEvidence($Snapshot) {
  return [ordered]@{
    observed = $true
    status = if ($null -ne $Snapshot.status) { [string]$Snapshot.status } else { $null }
    operatorReason = if ($null -ne $Snapshot.operatorReason) { [string]$Snapshot.operatorReason } else { $null }
    hardwareOnline = [bool]$Snapshot.hardwareOnline
    scannerOnline = [bool]$Snapshot.scannerOnline
    backendOnline = [bool]$Snapshot.backendOnline
    mqttConnected = [bool]$Snapshot.mqttConnected
    error = $null
  }
}

function Convert-ReadyzEvidence($Snapshot) {
  return [ordered]@{
    observed = $true
    ready = [bool]$Snapshot.ready
    error = $null
  }
}

function Get-FailedIpcEvidence($ErrorRecord) {
  $errorInfo = Get-HttpErrorInfo $ErrorRecord
  return [ordered]@{
    observed = $false
    statusCode = $errorInfo.statusCode
    error = Convert-ClaimFailureClassification $errorInfo
  }
}

function Get-SafeHealthzEvidence([string]$BaseUrl) {
  try {
    return Convert-HealthzEvidence (Invoke-IpcJson "GET" "$BaseUrl/healthz" @{})
  } catch {
    return Get-FailedIpcEvidence $_
  }
}

function Get-SafeReadyzEvidence([string]$BaseUrl) {
  try {
    return Convert-ReadyzEvidence (Invoke-IpcJson "GET" "$BaseUrl/readyz" @{})
  } catch {
    return Get-FailedIpcEvidence $_
  }
}

function Wait-DaemonIpc(
  [string]$ReadyFilePath,
  [int]$MaxAttempts = 20,
  [int]$RetryDelayMilliseconds = 1000
) {
  $lastError = $null
  $lastServiceStartError = $null
  for ($attempt = 0; $attempt -lt $MaxAttempts; $attempt++) {
    try {
      $service = Get-Service -Name "VemVendingDaemon" -ErrorAction Stop
      if ($service.Status -eq "Stopped") {
        try {
          Start-Service -Name "VemVendingDaemon" -ErrorAction Stop
        } catch {
          $lastServiceStartError = $_.Exception.Message
          throw "Start-Service VemVendingDaemon failed: $lastServiceStartError"
        }
      }

      $ready = Read-JsonFile $ReadyFilePath
      if ([string]::IsNullOrWhiteSpace($ready.ipcToken)) {
        throw "ipcToken missing from daemon ready file"
      }
      $baseUrl = Get-IpcBaseUrl $ready
      $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
      Invoke-IpcJson "GET" "$baseUrl/healthz" @{} -TimeoutSec 2 | Out-Null
      return [ordered]@{
        ready = $ready
        baseUrl = $baseUrl
        headers = $headers
        attempts = $attempt + 1
        observedHealth = $true
      }
    } catch {
      $lastError = $_.Exception.Message
      if ($attempt -lt ($MaxAttempts - 1)) {
        Start-Sleep -Milliseconds $RetryDelayMilliseconds
      }
    }
  }
  $serviceStartDiagnostic = if ($null -ne $lastServiceStartError) {
    "; last service start error: $lastServiceStartError"
  } else {
    ""
  }
  throw "daemon IPC did not become available after $MaxAttempts attempts: $lastError$serviceStartDiagnostic"
}

function Wait-DaemonIpcAfterProvisioning(
  [string]$ReadyFilePath,
  [long]$PreviousReadyGeneration,
  [string]$ExpectedMachineCode,
  $RecoveryEvidence,
  [int]$TimeoutMilliseconds = 60000,
  [int]$RetryDelayMilliseconds = 500
) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMilliseconds)
  $attempts = 0
  $lastError = $null
  $lastObservedGeneration = $PreviousReadyGeneration
  $lastObservedMachineCode = $null
  $RecoveryEvidence["previousReadyGeneration"] = $PreviousReadyGeneration
  do {
    $attempts += 1
    $service = Get-Service -Name "VemVendingDaemon" -ErrorAction Stop
    if ([string]$service.Status -ne "Running") {
      throw "VemVendingDaemon left Running during post-claim reconfigure: $($service.Status)"
    }
    try {
      $readyItem = Get-Item -LiteralPath $ReadyFilePath -ErrorAction Stop
      $lastObservedGeneration = [long]$readyItem.LastWriteTimeUtc.Ticks
      $RecoveryEvidence["observedReadyGeneration"] = $lastObservedGeneration
      if ($lastObservedGeneration -le $PreviousReadyGeneration) {
        throw "daemon ready generation has not advanced"
      }
      $RecoveryEvidence["runtimeReconfigureObserved"] = $true
      $ready = Read-JsonFile $ReadyFilePath
      if ([string]::IsNullOrWhiteSpace([string]$ready.ipcToken)) {
        throw "ipcToken missing from daemon ready file"
      }
      $baseUrl = Get-IpcBaseUrl $ready
      $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
      Invoke-IpcJson "GET" "$baseUrl/healthz" @{} -TimeoutSec 2 | Out-Null
      $RecoveryEvidence["observedHealthAfterReconfigure"] = $true
      $summary = Invoke-IpcJson "GET" "$baseUrl/v1/runtime-configuration" $headers -TimeoutSec 2
      $config = Get-ConfigSnapshotFromRuntimeSummary $summary
      $lastObservedMachineCode = [string]$config.public.machineCode
      $RecoveryEvidence["observedMachineCodeAfterReconfigure"] = $lastObservedMachineCode
      $RecoveryEvidence["observedProvisionedAfterReconfigure"] = [bool]$config.provisioned
      if (-not [bool]$config.provisioned) {
        throw "daemon runtime config is not provisioned"
      }
      if ($lastObservedMachineCode -ne $ExpectedMachineCode) {
        throw "daemon runtime machineCode is $lastObservedMachineCode"
      }
      $RecoveryEvidence["recoveredAfterReconfigure"] = $true
      $RecoveryEvidence["recoveryAttempts"] = $attempts
      $RecoveryEvidence["recoveryEvidence"] = "daemon_ready_generation_advanced_then_runtime_healthy"
      return [ordered]@{
        ready = $ready
        baseUrl = $baseUrl
        headers = $headers
        attempts = $attempts
        readyGeneration = $lastObservedGeneration
        observedHealth = $true
        recovered = $true
        recoveryEvidence = "daemon_ready_generation_advanced_then_runtime_healthy"
      }
    } catch {
      $lastError = $_.Exception.Message
    }
    if ([DateTime]::UtcNow -lt $deadline) {
      Start-Sleep -Milliseconds $RetryDelayMilliseconds
    }
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "daemon-owned post-claim reconfigure did not converge within $TimeoutMilliseconds ms; expected machineCode $ExpectedMachineCode; previous ready generation $PreviousReadyGeneration; last observed generation $lastObservedGeneration; last observed machineCode $lastObservedMachineCode; last error: $lastError"
}

function Get-DaemonIpcInventoryEvidence([string]$ReadyFilePath) {
  $evidence = [ordered]@{
    readyFile = [ordered]@{
      exists = $false
      readableByKioskUser = $false
      ipcEndpointPresent = $false
      tokenPresent = $false
      error = $null
    }
    config = Convert-ConfigSnapshotEvidence $null
    healthz = [ordered]@{ observed = $false; error = $null }
    readyz = [ordered]@{ observed = $false; error = $null }
  }

  if (-not (Test-Path -LiteralPath $ReadyFilePath)) {
    $evidence.readyFile.error = "ready_file_missing"
    return $evidence
  }
  $evidence.readyFile.exists = $true

  try {
    $ready = Read-JsonFile $ReadyFilePath
    $evidence.readyFile.tokenPresent = -not [string]::IsNullOrWhiteSpace($ready.ipcToken)
    $evidence.readyFile.ipcEndpointPresent = -not [string]::IsNullOrWhiteSpace($ready.healthzUrl)
    $baseUrl = Get-IpcBaseUrl $ready
    $evidence.healthz = Get-SafeHealthzEvidence $baseUrl
    $evidence.readyz = Get-SafeReadyzEvidence $baseUrl
    if (-not $evidence.readyFile.tokenPresent) {
      $evidence.config.error = "ipc_token_missing"
      return $evidence
    }
    $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }
    try {
      $summary = Invoke-IpcJson "GET" "$baseUrl/v1/runtime-configuration" $headers
      $evidence.config = Convert-ConfigSnapshotEvidence (Get-ConfigSnapshotFromRuntimeSummary $summary)
    } catch {
      $failed = Get-FailedIpcEvidence $_
      $evidence.config.error = $failed.error
    }
  } catch {
    $evidence.readyFile.error = [string]$_
  }

  return $evidence
}

function Convert-ProvisioningFacts($DaemonIpc, $ProvisioningActions) {
  $usedTaskExecute = $false
  $claimEvidence = $null
  foreach ($action in @($ProvisioningActions)) {
    $actionEvidence = $action.evidence
    if (
      $null -ne $actionEvidence -and
      [bool]$actionEvidence.usedDaemonIpcTaskExecute -and
      ([string]$actionEvidence.endpoint).EndsWith("/v1/provisioning/claim", [StringComparison]::OrdinalIgnoreCase) -and
      @("provisioned", "failed") -contains [string]$actionEvidence.claimStatus
    ) {
      $usedTaskExecute = $true
      $claimEvidence = $actionEvidence
    }
  }
  $profileApplied = [bool]$DaemonIpc.config.machineSecretConfigured -and [bool]$DaemonIpc.config.mqttSigningSecretConfigured

  return [ordered]@{
    provisioned = [bool]$DaemonIpc.config.provisioned
    usedDaemonIpcTaskExecute = $usedTaskExecute
    machineCode = $DaemonIpc.config.machineCode
    machineSecretConfigured = [bool]$DaemonIpc.config.machineSecretConfigured
    mqttSigningSecretConfigured = [bool]$DaemonIpc.config.mqttSigningSecretConfigured
    mqttPasswordConfigured = [bool]$DaemonIpc.config.mqttPasswordConfigured
    provisioningIssues = @($DaemonIpc.config.provisioningIssues | ForEach-Object { [string]$_ })
    claim = [ordered]@{
      runId = if ($null -ne $claimEvidence -and -not [string]::IsNullOrWhiteSpace($claimEvidence.runId)) { [string]$claimEvidence.runId } else { "missing" }
      status = if ($null -ne $claimEvidence -and -not [string]::IsNullOrWhiteSpace($claimEvidence.claimStatus)) { [string]$claimEvidence.claimStatus } else { "not_attempted" }
      httpStatus = if ($null -ne $claimEvidence -and $null -ne $claimEvidence.claimHttpStatus) { [int]$claimEvidence.claimHttpStatus } elseif ($null -ne $claimEvidence -and [string]$claimEvidence.claimStatus -eq "provisioned") { 200 } else { $null }
      failureCode = if ($null -ne $claimEvidence -and -not [string]::IsNullOrWhiteSpace($claimEvidence.claimFailureCode)) { [string]$claimEvidence.claimFailureCode } else { $null }
      endpoint = if ($null -ne $claimEvidence -and -not [string]::IsNullOrWhiteSpace($claimEvidence.endpoint)) { [string]$claimEvidence.endpoint } else { "missing" }
    }
    profile = [ordered]@{
      status = if ($profileApplied) { "applied" } elseif ([bool]$DaemonIpc.config.provisioned) { "failed" } else { "missing" }
      machineSecretConfigured = [bool]$DaemonIpc.config.machineSecretConfigured
      mqttSigningSecretConfigured = [bool]$DaemonIpc.config.mqttSigningSecretConfigured
      mqttPasswordConfigured = [bool]$DaemonIpc.config.mqttPasswordConfigured
    }
  }
}

function Get-PersistedProvisioningActions {
  $path = ${psString(TESTBED_PROVISIONING_EVIDENCE_FILE)}
  if (-not (Test-Path -LiteralPath $path)) {
    return @()
  }
  try {
    return @((Read-JsonFile $path))
  } catch {
    return @()
  }
}

function Confirm-ExistingTestbedProvisioningClaim($Actions) {
  $status = "succeeded"
  $message = $null
  $evidence = [ordered]@{
    reused = $true
    usedDaemonIpcTaskExecute = $false
    endpoint = $null
    runId = ${psString(runId)}
    expectedMachineCode = ${psString(machineCode)}
    platformTarget = ${psString(platformTarget)}
    apiBaseUrl = ${psString(platform.apiBaseUrl)}
    mqttUrl = ${psString(platform.mqttUrl)}
    claimStatus = "not_attempted"
    provisioned = $false
    credentialFlags = [ordered]@{
      machineSecretConfigured = $false
      mqttSigningSecretConfigured = $false
    }
  }

  try {
    $persisted = @(
      Get-PersistedProvisioningActions |
        Where-Object {
          [string]$_.name -eq "daemon IPC provisioning claim" -and
          [string]$_.status -eq "succeeded"
        } |
        Select-Object -Last 1
    )
    if ($persisted.Count -ne 1) {
      throw "already-claimed sale fixture requires persisted successful daemon IPC claim evidence"
    }
    $persistedEvidence = $persisted[0].evidence
    if (
      $null -eq $persistedEvidence -or
      [bool]$persistedEvidence.usedDaemonIpcTaskExecute -ne $true -or
      [string]$persistedEvidence.claimStatus -ne "provisioned" -or
      [string]$persistedEvidence.runId -ne ${psString(runId)} -or
      [string]$persistedEvidence.expectedMachineCode -ne ${psString(machineCode)} -or
      [string]$persistedEvidence.platformTarget -ne ${psString(platformTarget)} -or
      [string]$persistedEvidence.apiBaseUrl -ne ${psString(platform.apiBaseUrl)} -or
      [string]$persistedEvidence.mqttUrl -ne ${psString(platform.mqttUrl)}
    ) {
      throw "persisted daemon IPC claim evidence does not bind this sale fixture to the same run, identity, and platform"
    }
    $daemonIpc = Wait-DaemonIpc "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json"
    $config = Get-ConfigSnapshotFromRuntimeSummary (Invoke-IpcJson "GET" "$($daemonIpc.baseUrl)/v1/runtime-configuration" $daemonIpc.headers)
    if (
      [bool]$config.provisioned -ne $true -or
      [string]$config.public.machineCode -ne ${psString(machineCode)} -or
      [string]$config.public.apiBaseUrl -ne ${psString(platform.apiBaseUrl)} -or
      [string]$config.public.mqttUrl -ne ${psString(platform.mqttUrl)} -or
      [bool]$config.machineSecretConfigured -ne $true -or
      [bool]$config.mqttSigningSecretConfigured -ne $true
    ) {
      throw "already-claimed sale fixture current daemon state does not preserve the expected identity, platform, and credentials"
    }
    $evidence.usedDaemonIpcTaskExecute = $true
    $evidence.endpoint = [string]$persistedEvidence.endpoint
    $evidence.claimStatus = "provisioned"
    $evidence.provisioned = $true
    $evidence.credentialFlags.machineSecretConfigured = $true
    $evidence.credentialFlags.mqttSigningSecretConfigured = $true
  } catch {
    $status = "failed"
    $message = [string]$_
  }

  $Actions.Add([pscustomobject]@{
    name = "reuse persisted daemon IPC provisioning claim"
    status = $status
    message = $message
    evidence = $evidence
  }) | Out-Null
}

function Invoke-TestbedProvisioningClaim($Actions) {
  $status = "succeeded"
  $message = $null
  $evidence = [ordered]@{
    usedDaemonIpcTaskExecute = $false
    readyFile = "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json"
    endpoint = $null
    runId = ${psString(runId)}
    claimCodeId = ${psString(ephemeralPlatformSetup?.claimCodeId ?? "")}
    expectedMachineCode = ${psString(machineCode)}
    platformTarget = ${psString(platformTarget)}
    apiBaseUrl = ${psString(platform.apiBaseUrl)}
    mqttUrl = ${psString(platform.mqttUrl)}
    preClaimRuntimeBootstrapVerified = $false
    claimStatus = "not_attempted"
    claimFailureCode = $null
    claimHttpStatus = $null
    claimResult = [ordered]@{
      restartRequested = $null
      runtimeReconfigureObserved = $false
      previousReadyGeneration = $null
      observedReadyGeneration = $null
      observedHealthAfterReconfigure = $null
      observedMachineCodeAfterReconfigure = $null
      observedProvisionedAfterReconfigure = $null
      recoveredAfterReconfigure = $null
      recoveryAttempts = $null
      recoveryEvidence = $null
      recoveryFailure = $null
    }
    machineCode = $null
    provisioned = $false
    credentialFlags = [ordered]@{
      machineSecretConfigured = $false
      mqttSigningSecretConfigured = $false
      mqttPasswordConfigured = $false
    }
    provisioningIssues = @()
    healthzAfterClaim = [ordered]@{ observed = $false; error = $null }
    readyzAfterClaim = [ordered]@{ observed = $false; error = $null }
  }

  try {
    if (-not ${psString(machineCode)}.StartsWith("VEM-TESTBED-", [StringComparison]::Ordinal)) {
      throw "refusing to provision non-testbed target identity: ${machineCode}"
    }

    $runtimeBootstrapPath = "C:\\ProgramData\\VEM\\runtime-bootstrap.json"
    $runtimeBootstrap = [ordered]@{
      schemaVersion = 1
      provisioningApiBaseUrl = ${psString(platform.apiBaseUrl)}
      hardwareModel = ${psString(options.runtimeHardwareModel ?? "vem-prod-24")}
      topology = [ordered]@{
        identity = ${psString(platform.hardwareTopologyIdentity)}
        version = ${psString(platform.hardwareTopologyVersion)}
      }
    }
    Write-JsonFile -Path $runtimeBootstrapPath -Value $runtimeBootstrap
    Restart-Service -Name "VemVendingDaemon" -Force -ErrorAction Stop

    $daemonIpc = Wait-DaemonIpc "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json"
    $ready = $daemonIpc.ready
    $baseUrl = $daemonIpc.baseUrl
    $headers = $daemonIpc.headers

    $configBefore = Get-ConfigSnapshotFromRuntimeSummary (Invoke-IpcJson "GET" "$baseUrl/v1/runtime-configuration" $headers)
    $public = $configBefore.public
    Assert-FirstClaimConfig $configBefore
    if (-not [bool]$configBefore.runtimeBootstrapConfigured) {
      throw "Runtime Bootstrap is missing before Testbed claim"
    }
    if ([string]$public.apiBaseUrl -ne ${psString(platform.apiBaseUrl)}) {
      throw "Runtime Bootstrap did not expose the run-local Platform endpoint"
    }
    $evidence.preClaimRuntimeBootstrapVerified = $true

    $claimPayload = [ordered]@{
      claimCode = ${psString(claimCode)}
    }
    $evidence.endpoint = "$baseUrl/v1/provisioning/claim"
    $evidence.usedDaemonIpcTaskExecute = $true
    $preClaimReadyGeneration = [long](Get-Item -LiteralPath "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json" -ErrorAction Stop).LastWriteTimeUtc.Ticks
    try {
      $claimResult = Invoke-IpcJson "POST" "$baseUrl/v1/provisioning/claim" $headers $claimPayload
      $evidence.claimStatus = "provisioned"
      $evidence.claimHttpStatus = 200
      $evidence.machineCode = $claimResult.machineCode
      $evidence.claimResult.restartRequested = if ($null -ne $claimResult.restartRequested) { [bool]$claimResult.restartRequested } else { $null }
    } catch {
      $claimError = Get-HttpErrorInfo $_
      $evidence.claimStatus = "failed"
      $evidence.claimFailureCode = Convert-ClaimFailureClassification $claimError
      $evidence.claimHttpStatus = $claimError.statusCode
      throw "daemon IPC claim failed: $($evidence.claimFailureCode)"
    }

    if (-not [bool]$evidence.claimResult.restartRequested) {
      throw "daemon Claim did not request the required runtime reconfigure"
    }
    try {
      $recoveredIpc = Wait-DaemonIpcAfterProvisioning "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json" $preClaimReadyGeneration $evidence.machineCode $evidence.claimResult
      $ready = $recoveredIpc.ready
      $baseUrl = $recoveredIpc.baseUrl
      $headers = $recoveredIpc.headers
    } catch {
      $evidence.claimResult.recoveredAfterReconfigure = $false
      $evidence.claimResult.recoveryFailure = $_.Exception.Message
      throw
    }

    $evidence.healthzAfterClaim = Get-SafeHealthzEvidence $baseUrl
    $evidence.readyzAfterClaim = Get-SafeReadyzEvidence $baseUrl
    $configAfter = Get-ConfigSnapshotFromRuntimeSummary (Invoke-IpcJson "GET" "$baseUrl/v1/runtime-configuration" $headers)
    $configEvidence = Convert-ConfigSnapshotEvidence $configAfter
    $evidence.provisioned = $configEvidence.provisioned
    $evidence.credentialFlags.machineSecretConfigured = $configEvidence.machineSecretConfigured
    $evidence.credentialFlags.mqttSigningSecretConfigured = $configEvidence.mqttSigningSecretConfigured
    $evidence.credentialFlags.mqttPasswordConfigured = $configEvidence.mqttPasswordConfigured
    $evidence.provisioningIssues = $configEvidence.provisioningIssues
    if ([string]::IsNullOrWhiteSpace($evidence.machineCode)) {
      $evidence.machineCode = $configEvidence.machineCode
    }
    if (-not ([string]$evidence.machineCode).StartsWith("VEM-TESTBED-", [StringComparison]::Ordinal)) {
      throw "daemon IPC claim returned non-testbed identity: $($evidence.machineCode)"
    }
    if ([string]$evidence.machineCode -ne ${psString(machineCode)}) {
      throw "daemon IPC claim returned unexpected testbed identity: $($evidence.machineCode)"
    }
    if (-not $evidence.provisioned) {
      throw "daemon IPC claim completed but daemon config is not provisioned"
    }

    # A restored VM snapshot can retain a scheduled-task state whose original
    # process no longer exists. Rebind both interactive runtimes to the live
    # VEMKiosk session after the daemon finishes its claim reconfigure.
    $machineUiLauncher = "C:\\VEM\\bringup\\launch-machine-ui.vbs"
    if (Test-Path -LiteralPath $machineUiLauncher) {
      $launcherText = [IO.File]::ReadAllText($machineUiLauncher)
      $launcherText = $launcherText.Replace(
        'capture-kiosk-display.ps1""", 0, True',
        'capture-kiosk-display.ps1""", 0, False'
      )
      [IO.File]::WriteAllText($machineUiLauncher, $launcherText, [Text.Encoding]::ASCII)
    }
    & icacls.exe "C:\\VEM\\bringup" /grant:r "VEMKiosk:(OI)(CI)(RX)" /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "failed to grant VEMKiosk runtime access: C:\\VEM\\bringup"
    }
    & icacls.exe "C:\\VEM\\vision" /grant:r "VEMKiosk:(OI)(CI)(M)" /T /C /Q | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "failed to grant VEMKiosk runtime access: C:\\VEM\\vision"
    }
    Stop-ScheduledTask -TaskName "VEMMachineUI" -ErrorAction SilentlyContinue
    Stop-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\\VEM\\" -ErrorAction SilentlyContinue
    Get-Process -Name "machine" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-ScheduledTask -TaskName "StartVisionServer" -TaskPath "\\VEM\\" -ErrorAction Stop
    Start-ScheduledTask -TaskName "VEMMachineUI" -ErrorAction Stop
    Start-Sleep -Seconds 5
  } catch {
    $status = "failed"
    $message = [string]$_
  }

  $action = [pscustomobject]@{
    name = "daemon IPC provisioning claim"
    status = $status
    message = $message
    evidence = $evidence
  }
  $Actions.Add($action) | Out-Null

  try {
    $provisioningEvidencePath = ${psString(TESTBED_PROVISIONING_EVIDENCE_FILE)}
    $provisioningEvidenceDirectory = Split-Path -Parent $provisioningEvidencePath
    if (-not (Test-Path -LiteralPath $provisioningEvidenceDirectory)) {
      New-Item -ItemType Directory -Path $provisioningEvidenceDirectory -Force | Out-Null
    }
    $provisioningEvidenceJson = $action | ConvertTo-Json -Depth 40
    Set-Content -LiteralPath $provisioningEvidencePath -Value $provisioningEvidenceJson -Encoding UTF8
  } catch {
    $Actions.Add([pscustomobject]@{
      name = "persist daemon IPC provisioning evidence"
      status = "failed"
      message = [string]$_
    }) | Out-Null
  }
}

function Get-CommandEvidence([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Select-Object -First 1
  return [pscustomobject]@{
    name = $Name
    available = $null -ne $command
    source = if ($null -ne $command) { $command.Source } else { $null }
    path = if ($null -ne $command) { $command.Path } else { $null }
  }
}

function Get-LocalUserEvidence([string]$Name) {
  $user = Get-LocalUser -Name $Name -ErrorAction SilentlyContinue
  if ($null -eq $user) {
    return [pscustomobject]@{ name = $Name; exists = $false; enabled = $false; admin = $false }
  }
  $admin = $false
  try {
    $admin = $null -ne (Get-LocalGroupMember -Group "Administrators" -Member $Name -ErrorAction SilentlyContinue)
  } catch {
    $admin = $false
  }
  return [pscustomobject]@{
    name = $Name
    exists = $true
    enabled = [bool]$user.Enabled
    admin = [bool]$admin
  }
}

function Get-InventoryFacts($ProvisioningActions = @()) {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $os = Get-CimInstance Win32_OperatingSystem
  $computer = Get-CimInstance Win32_ComputerSystem
  $hostDisplay = Get-DisplayEvidence
  $displayDimensionsEvidence = Convert-DisplayDimensionsEvidence $hostDisplay
  $interactiveWindowsSessions = Get-InteractiveWindowsSessionEvidence
  $activeKioskSession = Get-ActiveKioskSession $interactiveWindowsSessions
  $interactiveDesktopDisplay = Get-InteractiveDesktopDisplayEvidence $activeKioskSession
  $interactiveDesktopDisplayBaseline = Convert-InteractiveDisplayDimensionsEvidence $interactiveDesktopDisplay
  $portraitKioskAcceptance = Convert-PortraitKioskAcceptanceEvidence $interactiveDesktopDisplayBaseline
  $kioskRuntime = Get-KioskRuntimeEvidence $activeKioskSession
  $kioskDesktopEscape = Get-KioskDesktopEscapeEvidence $activeKioskSession
  $daemonProcess = Get-ManualProcessEvidence "vending-daemon.exe" "C:\\VEM\\bringup\\vending-daemon.exe"
  $readyFile = Test-PathEvidence "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json"
  $daemonConfig = Test-PathEvidence "C:\\ProgramData\\VEM\\vending-daemon\\runtime-bootstrap.json"
  $daemonIpc = Get-DaemonIpcInventoryEvidence "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json"
  $provisioningFacts = Convert-ProvisioningFacts $daemonIpc (@($ProvisioningActions) + @(Get-PersistedProvisioningActions))
  $runtimeAcceptanceFactsSubset = [ordered]@{
    mode = "installed_runtime"
    target = [ordered]@{
      testbedName = "win10-vem-e2e"
      machineCode = ${psString(machineCode)}
      platformTarget = ${psString(platformTarget)}
    }
    displayEvidence = [ordered]@{
      hostDisplayBaseline = $displayDimensionsEvidence
      interactiveDesktopDisplayBaseline = $interactiveDesktopDisplayBaseline
      sshServiceSessionScreenDimensions = $displayDimensionsEvidence
      portraitKioskAcceptance = $portraitKioskAcceptance
    }
    readyFile = $daemonIpc.readyFile
    provisioning = $provisioningFacts
    daemonRuntime = [ordered]@{
      processRunning = $daemonProcess.running
      processId = $daemonProcess.processId
      processUser = $daemonProcess.user
      executablePath = $daemonProcess.executablePath
    }
    kioskRuntime = [ordered]@{
      webviewRunning = $kioskRuntime.webviewRunning
      url = $kioskRuntime.url
      sessionUser = $kioskRuntime.sessionUser
      sessionId = $kioskRuntime.sessionId
      source = $kioskRuntime.source
      processId = $kioskRuntime.processId
      machineProcessCount = $kioskRuntime.machineProcessCount
      machineExecutablePath = $kioskRuntime.machineExecutablePath
      webView2ProcessId = $kioskRuntime.webView2ProcessId
      webView2ProcessCount = $kioskRuntime.webView2ProcessCount
      cdpListenerProcessId = $kioskRuntime.cdpListenerProcessId
      cdpListenerSessionId = $kioskRuntime.cdpListenerSessionId
      cdpMachineAncestorProcessId = $kioskRuntime.cdpMachineAncestorProcessId
      cdpAvailable = $kioskRuntime.cdpAvailable
      cdpTargetId = $kioskRuntime.cdpTargetId
      acceptanceOverlayCdp = $kioskRuntime.acceptanceOverlayCdp
    }
    kioskDesktopEscape = $kioskDesktopEscape
  }

  return [ordered]@{
    testbedName = "win10-vem-e2e"
    collectedAt = (Get-Date).ToUniversalTime().ToString("o")
    target = [ordered]@{
      machineCode = ${psString(machineCode)}
      platformTarget = ${psString(platformTarget)}
    }
    os = [ordered]@{
      caption = [string]$os.Caption
      version = [string]$os.Version
      buildNumber = [string]$os.BuildNumber
      hostName = [string]$computer.Name
    }
    user = [ordered]@{
      current = [string]$identity.Name
      isAdmin = Test-LocalAdmin
      kiosk = Get-LocalUserEvidence "VEMKiosk"
    }
    access = [ordered]@{
      openSshServer = Get-ServiceStateOrNull -Name "sshd"
      sshCommand = Get-CommandEvidence "ssh"
    }
    webView2 = Get-WebView2Presence
    vem = [ordered]@{
      bringupDirectory = Test-PathEvidence "C:\\VEM\\bringup"
      updatesDirectory = Test-PathEvidence "C:\\VEM\\updates"
      visionDirectory = Test-PathEvidence "C:\\VEM\\vision"
      daemonDataDirectory = Test-PathEvidence "C:\\ProgramData\\VEM\\vending-daemon"
      readyFile = $readyFile
      daemonConfig = $daemonConfig
    }
    displayEvidence = [ordered]@{
      hostDisplayBaseline = $hostDisplay
      interactiveWindowsSessions = $interactiveWindowsSessions
      interactiveDesktopDisplayBaseline = $interactiveDesktopDisplay
      sshServiceSessionScreenDimensions = $hostDisplay
      portraitKioskAcceptance = $portraitKioskAcceptance
    }
    artifactConsumerPrerequisites = [ordered]@{
      powershell = $PSVersionTable.PSVersion.ToString()
      expandArchiveAvailable = $null -ne (Get-Command Expand-Archive -ErrorAction SilentlyContinue)
      getFileHashAvailable = $null -ne (Get-Command Get-FileHash -ErrorAction SilentlyContinue)
    }
    runtimeAcceptanceFactsSubset = $runtimeAcceptanceFactsSubset
    runtimeAcceptanceReportPreparation = [ordered]@{
      schemaVersion = "runtime-acceptance-report/v1"
      completeness = "partial_missing_required_facts"
      missingRequiredFacts = @("artifacts", "daemonRuntime")
      runtimeReadyAssertion = [ordered]@{
        status = "not_asserted"
        asserted = $false
      }
      factsSubset = $runtimeAcceptanceFactsSubset
    }
  }
}

$mode = ${psString(mode)}
$inventoryBefore = Get-InventoryFacts
$resetPlan = [ordered]@{
  stopServices = ${psArray(plan.stopServices)}
  unregisterScheduledTasks = ${psArray(plan.unregisterScheduledTasks)}
  removeDirectories = ${psArray(plan.removeDirectories)}
  removeFiles = ${psArray(plan.removeFiles)}
  preservedResources = ${psArray(plan.preservedResources)}
}
$resetActions = [System.Collections.Generic.List[object]]::new()
$provisioningActions = [System.Collections.Generic.List[object]]::new()
$simulatedHardwareSaleFlowResult = $null

if ($mode -eq "reset" -or $mode -eq "inventory-reset") {
${serviceStops}
${taskRemovals}
${fileRemovals}
${directoryRemovals}
}

if ($mode -eq "provision") {
  Invoke-TestbedProvisioningClaim $provisioningActions
}

if ($mode -eq "runtime-acceptance" -and ${ephemeralPlatformSetup ? "$true" : "$false"}) {
  if (${options.alreadyClaimed ? "$true" : "$false"}) {
    Confirm-ExistingTestbedProvisioningClaim $provisioningActions
  } else {
    Invoke-TestbedProvisioningClaim $provisioningActions
  }
}

if ($mode -eq "simulated-hardware-sale-flow") {
  if (${psString(options.salePhase ?? "single")} -ne "complete") {
    if (${options.alreadyClaimed ? "$true" : "$false"}) {
      Confirm-ExistingTestbedProvisioningClaim $provisioningActions
    } else {
      Invoke-TestbedProvisioningClaim $provisioningActions
    }
  }
  $simulatedHardwareSaleFlowResult = Invoke-SimulatedHardwareSaleFlow $provisioningActions
}

$inventoryAfter = if ($mode -eq "inventory-reset") { Get-InventoryFacts } else { $null }
$inventoryAfterProvision = if ($mode -eq "provision") { Get-InventoryFacts $provisioningActions } else { $null }
$runtimeAcceptanceReportResult = if ($mode -eq "runtime-acceptance") { Get-RuntimeAcceptanceReport $provisioningActions } else { $null }
$runtimeAcceptanceReport = if ($null -ne $runtimeAcceptanceReportResult) { $runtimeAcceptanceReportResult.report } else { $null }
$simulatedHardwareSaleFlowReport = if ($null -ne $simulatedHardwareSaleFlowResult) { $simulatedHardwareSaleFlowResult.report } else { $null }
$actionsOk = (((@($resetActions) + @($provisioningActions)) | Where-Object { $_.status -eq "failed" } | Measure-Object | Select-Object -ExpandProperty Count) -eq 0)
$runtimeAcceptanceOk = if ($mode -eq "runtime-acceptance") {
  $null -ne $runtimeAcceptanceReport -and [string]$runtimeAcceptanceReport.result.runtimeReady.status -eq "passed"
} else {
  $true
}
$simulatedHardwareSaleFlowOk = if ($mode -eq "simulated-hardware-sale-flow") {
  $null -ne $simulatedHardwareSaleFlowReport -and (
    ([string]$simulatedHardwareSaleFlowReport.phase -eq "fixture" -and [string]$simulatedHardwareSaleFlowReport.result.simulatedHardwareReady.status -eq "fixture_ready") -or
    ([string]$simulatedHardwareSaleFlowReport.phase -eq "complete" -and [bool]$simulatedHardwareSaleFlowReport.hostSerialEvidencePending -and [string]$simulatedHardwareSaleFlowReport.result.simulatedHardwareReady.status -eq "not_asserted")
  )
} else {
  $true
}

$result = [ordered]@{
  ok = $actionsOk -and $runtimeAcceptanceOk -and $simulatedHardwareSaleFlowOk
  mode = $mode
  inventory = $inventoryBefore
  reset = [ordered]@{
    plan = $resetPlan
    actions = @($resetActions)
    idempotent = $true
  }
  provisioning = [ordered]@{
    actions = @($provisioningActions)
  }
  inventoryAfterReset = $inventoryAfter
  inventoryAfterProvision = $inventoryAfterProvision
  runtimeAcceptanceReportPath = if ($null -ne $runtimeAcceptanceReportResult) { $runtimeAcceptanceReportResult.path } else { $null }
  runtimeAcceptanceReport = $runtimeAcceptanceReport
  simulatedHardwareSaleFlowPath = if ($null -ne $simulatedHardwareSaleFlowResult) { $simulatedHardwareSaleFlowResult.path } else { $null }
  simulatedHardwareSaleFlow = if ($null -ne $simulatedHardwareSaleFlowResult) { $simulatedHardwareSaleFlowResult.report } else { $null }
}

[pscustomobject]$result | ConvertTo-Json -Depth 60
`;
}

export function buildSshCommand(options = {}) {
  return [
    "ssh",
    ...buildSshOptionArgs(options),
    options.remote ?? DEFAULT_RUNTIME_REMOTE,
  ];
}

function buildSshOptionArgs(options = {}, { portFlag = "-p" } = {}) {
  const identity = String(options.identity ?? "").trim();
  const certificate = String(options.certificate ?? "").trim();
  if (!identity || !certificate) {
    throw new Error(
      "certificate-only SSH requires --identity and --certificate",
    );
  }
  const sshArgs = [
    "-o",
    `IdentityFile=${identity}`,
    "-o",
    `CertificateFile=${certificate}`,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "IdentityAgent=none",
    "-o",
    "BatchMode=yes",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    "PreferredAuthentications=publickey",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ForwardAgent=no",
    "-o",
    "ConnectTimeout=30",
  ];
  if (options.sshPort) sshArgs.push(portFlag, String(options.sshPort));
  if (options.sshKnownHostsPath) {
    sshArgs.push(
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${options.sshKnownHostsPath}`,
    );
  }
  if (options.sshHostKeyAlias) {
    sshArgs.push("-o", `HostKeyAlias=${options.sshHostKeyAlias}`);
  }
  sshArgs.push("-o", "ProxyCommand=none");
  return sshArgs;
}

function remotePathForScp(remotePath) {
  return remotePath.replaceAll("\\", "/");
}

function quotePowerShellSingleQuoted(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function buildRemotePowerShellCommand(remoteScriptPath, options = {}) {
  const scriptInvocation = `& ${quotePowerShellSingleQuoted(remoteScriptPath)}`;
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "${scriptInvocation}"`;
}

export function buildScpCommand(sourcePath, remoteScriptPath, options = {}) {
  const remote = options.remote ?? DEFAULT_RUNTIME_REMOTE;
  return [
    "scp",
    "-O",
    ...buildSshOptionArgs(options, { portFlag: "-P" }),
    sourcePath,
    `${remote}:${remotePathForScp(remoteScriptPath)}`,
  ];
}

function buildEncodedPowerShellCommand(script) {
  return `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(
    script,
    "utf16le",
  ).toString("base64")}`;
}

const TRANSIENT_SSH_TRANSPORT_FAILURE =
  /(?:kex_exchange_identification|ssh_exchange_identification|connection (?:closed|refused|reset|timed out)|no route to host|operation timed out)/i;

export function parseStructuredSshVerifierEvidence(stdout) {
  try {
    const parsed = JSON.parse(String(stdout ?? ""));
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function spawnSshOperation(command, args, { input, signal } = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command, args, {
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      signal,
      env: nonQueryChildEnvironment(),
    });
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, ...result });
    };
    child.on("error", (error) => finish({ status: null, signal: null, error }));
    child.on("close", (status, signal) => finish({ status, signal }));
  });
}

export async function runTransientSshOperation(
  command,
  args,
  {
    run = spawnSshOperation,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    maxAttempts = 24,
    retryDelayMs = 5000,
    input,
    signal,
  } = {},
) {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("SSH operation maxAttempts must be a positive integer");
  }
  const throwIfAborted = () => {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("SSH operation cancelled");
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted();
    const result = await run(command, args, { input, signal });
    throwIfAborted();
    if (result.status === 0) return result;
    // A remote verifier can finish and emit its evidence before an SSH transport
    // reset. Preserve that first result for the caller instead of replacing it.
    if (parseStructuredSshVerifierEvidence(result.stdout) !== null) {
      return result;
    }
    const diagnostic = `${result.stderr ?? ""}\n${result.stdout ?? ""}`;
    if (
      attempt === maxAttempts ||
      !TRANSIENT_SSH_TRANSPORT_FAILURE.test(diagnostic)
    ) {
      return result;
    }
    await sleep(retryDelayMs);
    throwIfAborted();
  }
  throw new Error("unreachable SSH retry state");
}

export function buildStdinPowerShellCommand() {
  return "powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -";
}

export function getRuntimeAcceptanceExitStatus({
  mode,
  sshStatus,
  stdout,
} = {}) {
  const status = sshStatus ?? 1;
  if (status !== 0) {
    return status;
  }
  if (mode === "simulated-hardware-sale-flow") {
    try {
      const output = JSON.parse(String(stdout ?? ""));
      const simulatedHardwareReady =
        output?.simulatedHardwareSaleFlow?.result?.simulatedHardwareReady
          ?.status;
      const phase = output?.simulatedHardwareSaleFlow?.phase;
      return output?.ok === true &&
        ((phase === "fixture" && simulatedHardwareReady === "fixture_ready") ||
          (phase === "complete" &&
            output?.simulatedHardwareSaleFlow?.hostSerialEvidencePending ===
              true &&
            simulatedHardwareReady === "not_asserted"))
        ? 0
        : 1;
    } catch {
      return 1;
    }
  }
  if (mode !== "runtime-acceptance") {
    return 0;
  }

  try {
    const output = JSON.parse(String(stdout ?? ""));
    const runtimeReady =
      output?.runtimeAcceptanceReport?.result?.runtimeReady?.status;
    return output?.ok === true && runtimeReady === "passed" ? 0 : 1;
  } catch {
    return 1;
  }
}

function usage() {
  console.error(`Usage:
  win10-vem-e2e.mjs [--mode inventory|reset|inventory-reset|provision|runtime-acceptance|simulated-hardware-sale-flow|vm-runtime-acceptance] [--run-id ID] [--claim-code CODE] [--ephemeral-platform-evidence PATH] [--ephemeral-api-base-url URL] [--ephemeral-mqtt-url URL] [--daemon-artifact PATH] [--machine-ui-artifact PATH] [--daemon-artifact-sha256 HASH] [--machine-ui-artifact-sha256 HASH] [--runtime-base URI] [--remote USER@HOST] [--ssh-port PORT] [--runtime-guest-endpoint-json JSON] [--expected-testbed-user USER] --identity KEY --certificate CERT [--dry-run] [--out PATH]

Defaults target the documented Machine Runtime Testbed:
  --remote ${DEFAULT_RUNTIME_REMOTE}
  --mode inventory

Provision mode starts and reads the daemon IPC, applies only pre-claim platform endpoints, and claims the prepared testbed identity through daemon IPC /v1/provisioning/claim.

Runtime-acceptance mode writes C:\ProgramData\VEM\vending-daemon\runtime-acceptance-report.json on the remote host and includes the same report in stdout; use --out to save the SSH response locally.

Simulated hardware sale-flow mode writes C:\ProgramData\VEM\vending-daemon\simulated-hardware-sale-flow.json on the remote host and includes the same report in stdout. It requires --ephemeral-platform-evidence from service-api testbed:prepare-ephemeral-platform, an explicit non-shared --platform-target, a same-run daemon IPC claim, simulated hardware mode, platform planogram sync, stock attestation upload acceptance, mock payment readiness, and simulated dispense success.

VM runtime acceptance mode is the CI/manual gate entrypoint. It uses the restored runtime base, then runs ephemeral platform setup, runtime acceptance, installed kiosk sale checks, serial conformance, and simulated hardware sale-flow in one non-interactive sequence. It requires --run-id, a non-shared --platform-target, VEM_EPHEMERAL_DATABASE_URL, explicit --ephemeral-api-base-url/--ephemeral-mqtt-url, --runtime-base, --scanner-code-file, and certificate SSH inputs. Reports and logs are written under artifacts/vm-runtime-acceptance/<run-id>/.
`);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--mode") {
      options.mode = next;
      index += 1;
    } else if (arg === "--remote") {
      options.remote = next;
      index += 1;
    } else if (arg === "--ssh-port") {
      const port = Number(next);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error("--ssh-port must be a valid TCP port");
      options.sshPort = port;
      index += 1;
    } else if (arg === "--ssh-known-hosts-path") {
      if (typeof next !== "string" || !next.startsWith("/")) {
        throw new Error("--ssh-known-hosts-path must be an absolute path");
      }
      options.sshKnownHostsPath = next;
      index += 1;
    } else if (arg === "--ssh-host-key-alias") {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(next ?? "")) {
        throw new Error("--ssh-host-key-alias must be a safe host-key alias");
      }
      options.sshHostKeyAlias = next;
      index += 1;
    } else if (arg === "--identity") {
      options.identity = next;
      index += 1;
    } else if (arg === "--certificate") {
      options.certificate = next;
      index += 1;
    } else if (arg === "--machine-code") {
      options.machineCode = next;
      index += 1;
    } else if (arg === "--platform-target") {
      options.platformTarget = next;
      index += 1;
    } else if (arg === "--claim-code") {
      options.claimCode = next;
      index += 1;
    } else if (arg === "--ephemeral-platform-evidence") {
      options.ephemeralPlatformEvidence = next;
      index += 1;
    } else if (arg === "--sale-phase") {
      if (!new Set(["fixture", "complete"]).has(next))
        throw new Error("--sale-phase must be fixture or complete");
      options.salePhase = next;
      index += 1;
    } else if (arg === "--sale-binding-json") {
      try {
        const binding = JSON.parse(next);
        for (const field of ["orderId", "paymentId", "orderNo"]) {
          if (typeof binding?.[field] !== "string" || !binding[field].trim()) {
            throw new Error();
          }
        }
      } catch {
        throw new Error(
          "--sale-binding-json must contain rendered orderId, paymentId, and orderNo",
        );
      }
      options.saleBindingJson = next;
      index += 1;
    } else if (arg === "--already-claimed") {
      options.alreadyClaimed = true;
    } else if (arg === "--ephemeral-api-base-url") {
      options.ephemeralApiBaseUrl = next;
      index += 1;
    } else if (arg === "--ephemeral-mqtt-url") {
      options.ephemeralMqttUrl = next;
      index += 1;
    } else if (arg === "--scanner-code-file") {
      options.scannerCodeFile = next;
      index += 1;
    } else if (arg === "--serial-runner-signing-key-file") {
      options.serialRunnerSigningKeyFile = next;
      index += 1;
    } else if (arg === "--expected-serial-runner-public-key") {
      options.expectedSerialRunnerPublicKey = next;
      index += 1;
    } else if (arg === "--runtime-base") {
      options.approvedRuntimeBase = next;
      index += 1;
    } else if (arg === "--machine-code-prefix") {
      options.machineCodePrefix = next;
      index += 1;
    } else if (arg === "--platform-api-base-url") {
      options.platformApiBaseUrl = next;
      index += 1;
    } else if (arg === "--platform-mqtt-url") {
      options.platformMqttUrl = next;
      index += 1;
    } else if (arg === "--evidence-root") {
      options.evidenceRoot = next;
      index += 1;
    } else if (arg === "--daemon-artifact") {
      options.daemonArtifact = next;
      index += 1;
    } else if (arg === "--machine-ui-artifact") {
      options.machineUiArtifact = next;
      index += 1;
    } else if (arg === "--daemon-artifact-sha256") {
      options.daemonArtifactSha256 = next;
      index += 1;
    } else if (arg === "--machine-ui-artifact-sha256") {
      options.machineUiArtifactSha256 = next;
      index += 1;
    } else if (arg === "--run-id") {
      options.runId = next;
      index += 1;
    } else if (arg === "--out") {
      options.out = next;
      index += 1;
    } else if (arg === "--runtime-guest-endpoint-json") {
      options.runtimeGuestEndpointJson = next;
      index += 1;
    } else if (arg === "--expected-testbed-user") {
      options.expectedTestbedUser = next;
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function applyRuntimeGuestEndpoint(options) {
  if (!options.runtimeGuestEndpointJson) return options;
  let endpoint;
  try {
    endpoint = JSON.parse(options.runtimeGuestEndpointJson);
  } catch {
    throw new Error(
      "--runtime-guest-endpoint-json must be adapter-discovered endpoint JSON",
    );
  }
  if (
    endpoint?.protocol !== "ssh" ||
    typeof endpoint.host !== "string" ||
    endpoint.host.trim().length === 0 ||
    ["0.0.0.0", "::", "127.0.0.1", "::1"].includes(endpoint.host) ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port !== 22 ||
    !["discovered", "authenticated"].includes(endpoint.reachability) ||
    endpoint.transport !== "testbed-runner-direct" ||
    !options.expectedTestbedUser ||
    options.remote ||
    options.sshPort
  ) {
    throw new Error(
      "runtime guest endpoint requires adapter-discovered direct SSH, --expected-testbed-user, and no caller-supplied remote or SSH port",
    );
  }
  return {
    ...options,
    remote: `${options.expectedTestbedUser}@${endpoint.host}`,
    sshPort: endpoint.port,
    sshHostKeyAlias:
      options.sshHostKeyAlias ??
      `vem-runtime-${normalizeEphemeralRunId(options.runId).toLowerCase()}`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    try {
      const options = applyRuntimeGuestEndpoint(
        parseArgs(process.argv.slice(2)),
      );
      if (options.help) {
        usage();
        process.exit(0);
      }
      if (options.mode === "vm-runtime-acceptance") {
        const plan = buildVmRuntimeAcceptancePlan(options);
        if (options.dryRun) {
          const sanitizedPlan = sanitizeVmRuntimeAcceptancePlan(plan);
          if (options.out) {
            writeJsonOutput(options.out, sanitizedPlan);
          }
          console.log(JSON.stringify(sanitizedPlan, null, 2));
          process.exit(0);
        }
        const report = await runVmRuntimeAcceptance(options);
        if (options.out) {
          writeFileSync(options.out, `${JSON.stringify(report, null, 2)}\n`);
          console.error(`wrote report: ${options.out}`);
        } else {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        }
        process.exit(report.ok ? 0 : 1);
      }

      const localTempDirectory = mkdtempSync(join(tmpdir(), "vem-win10-e2e-"));
      try {
        const script = buildRemotePowerShellScript(options);
        const sshCommand = buildSshCommand(options);
        const localScriptPath = join(localTempDirectory, "run.ps1");
        const remoteScriptPath = `C:\\Users\\Admin\\AppData\\Local\\Temp\\vem-win10-e2e-${process.pid}-${Date.now()}.ps1`;
        const scpCommand = buildScpCommand(
          localScriptPath,
          remoteScriptPath,
          options,
        );
        const remoteCommand = buildRemotePowerShellCommand(
          remoteScriptPath,
          options,
        );

        if (options.dryRun) {
          console.log(
            JSON.stringify(
              {
                sshCommand,
                scpCommand,
                remoteCommand,
                transport: "scp-temp-ps1",
                resetPlan: assertResetPlanPreservesTestbed(buildResetPlan()),
                runId:
                  options.mode === "simulated-hardware-sale-flow"
                    ? sanitizeRunId(options.runId)
                    : null,
              },
              null,
              2,
            ),
          );
          process.exitCode = 0;
          return;
        }

        writeFileSync(localScriptPath, script, "utf8");
        const upload = await runTransientSshOperation(
          scpCommand[0],
          scpCommand.slice(1),
        );
        if (upload.stdout) process.stdout.write(upload.stdout);
        if (upload.stderr) process.stderr.write(upload.stderr);
        if (upload.status !== 0) {
          throw new Error(
            `remote script upload failed with status ${upload.status ?? 1}`,
          );
        }

        const result = spawnSync(
          sshCommand[0],
          [...sshCommand.slice(1), remoteCommand],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            env: nonQueryChildEnvironment(),
          },
        );
        await runTransientSshOperation(
          sshCommand[0],
          [
            ...sshCommand.slice(1),
            buildEncodedPowerShellCommand(
              `Remove-Item -LiteralPath ${quotePowerShellSingleQuoted(remoteScriptPath)} -Force -ErrorAction SilentlyContinue`,
            ),
          ],
          { maxAttempts: 1 },
        );
        if (result.stdout && options.out) {
          writeFileSync(options.out, result.stdout, "utf8");
          console.error(`wrote report: ${options.out}`);
        } else if (result.stdout) {
          process.stdout.write(result.stdout);
        }
        if (result.stderr) {
          process.stderr.write(result.stderr);
        }
        process.exitCode = getRuntimeAcceptanceExitStatus({
          mode: options.mode,
          sshStatus: result.status,
          stdout: result.stdout,
        });
      } finally {
        rmSync(localTempDirectory, { recursive: true, force: true });
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      usage();
      process.exitCode = 2;
    }
  })();
}
