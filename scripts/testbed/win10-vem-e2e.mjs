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
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { admitFactoryAcceptance } from "../factory/factory-acceptance-admission.mjs";
import {
  createFactoryPersonalizationStagingCopy,
  readFactoryPersonalizationMediaSnapshot,
  redactFactoryPersonalizationMedia,
} from "../factory/factory-personalization-media.mjs";
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
  "C:\\Users\\YKDZ",
  "C:\\ProgramData\\Tailscale",
  "C:\\ProgramData\\ssh",
];

const PROTECTED_SERVICE_NAMES = new Set(["tailscale", "sshd"]);
const ALLOWED_SCHEDULED_TASKS = new Set([
  "vemmachineui",
  "vemmaintenanceui",
  "vem\\startvisionserver",
]);

const STARTUP_BRINGUP_EVIDENCE_FILE =
  "C:\\ProgramData\\VEM\\vending-daemon\\startup-bringup-evidence.json";
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
const CLEAN_BASE_FACTORY_ACCEPTANCE_FILE_NAME =
  "clean-base-factory-acceptance.json";
const FACTORY_IMAGE_DELIVERY_UNIT_FILE_NAME =
  "factory-image-delivery-unit-report.json";
const CLEAN_BASE_FACTORY_ACCEPTANCE_REPORT_SCHEMA_VERSION =
  "clean-base-factory-acceptance-report/v1";
const CLEAN_BASE_FACTORY_ACCEPTANCE_KIND = "clean-base-factory-acceptance";
const FACTORY_IMAGE_DELIVERY_UNIT_REPORT_SCHEMA_VERSION =
  "factory-image-delivery-unit-report/v1";
const FACTORY_IMAGE_DELIVERY_UNIT_KIND = "factory-image-delivery-unit";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const FACTORY_WINDOWS_BASELINE_POLICY = {
  schemaVersion: "factory-windows-baseline-policy/v1",
  model: "allowlist",
  requiredCapabilities: [
    "defender_enabled",
    "firewall_enabled",
    "no_default_product_remote_ingress",
    "vem_runtime_defender_exclusions",
    "openssh_server_for_maintenance_users",
    "tailscale_not_installed_by_default",
    "kiosk_account_denied_remote_access",
    "windows_event_logging",
    "powershell_management",
    "networking_certificates_time_sync",
    "webview2_runtime_support",
    "display_touch_usb_serial_drivers",
    "fonts_input_methods",
  ],
  disabledRuntimeInterference: [
    "windows_auto_update_installation",
    "windows_auto_update_auto_restart",
    "sleep",
    "hibernation",
    "testsigning",
    "store_automatic_app_updates",
    "consumer_experience_autostart",
    "consumer_experience_foreground_popups",
    "consumer_experience_kiosk_foreground_takeover_best_effort",
  ],
  evidenceFields: {
    windowsUpdatePolicy: "assertions.windowsUpdatePolicy",
    powerPolicy: "assertions.powerPolicy",
    bootPolicy: "assertions.bootPolicy",
    securityPosture: "assertions.securityPosture",
    remoteMaintenanceCapability:
      "assertions.factoryRemoteMaintenanceCapability",
    consumerExperienceInterference: "assertions.consumerExperienceInterference",
  },
};
const REQUIRED_CLEAN_BASE_ASSERTIONS = [
  "displayOrientationResolution",
  "sshReachability",
  "tailscaleDefaultAbsent",
  "windowsUpdatePolicy",
  "powerPolicy",
  "bootPolicy",
  "securityPosture",
  "factoryRemoteMaintenanceCapability",
  "consumerExperienceInterference",
  "sleepDisabled",
  "testsigningOff",
  "autologonConfigured",
  "startupLauncherMode",
  "daemonService",
  "uiLauncherTask",
  "runtimeResetGateClean",
  "hardwareProfileMode",
  "startupReachesBringUpOrSalesEligible",
  "preflightNoMachineIdentity",
  "preflightNoProvisioningProfile",
  "preflightNoProtectedSecrets",
  "preflightNoDaemonState",
  "preflightNoPreviousVemEvidence",
];
const CLEAN_BASE_PREFLIGHT_ABSENCE_PROBES = [
  {
    code: "preflightNoMachineIdentity",
    paths: [
      "C:\\ProgramData\\VEM\\provisioning",
      "C:\\ProgramData\\VEM\\vending-daemon\\machine-config.json",
      "C:\\ProgramData\\VEM\\bringup\\local-bringup-settings.json",
    ],
    services: [],
    tasks: [],
  },
  {
    code: "preflightNoProvisioningProfile",
    paths: ["C:\\ProgramData\\VEM\\provisioning"],
    services: [],
    tasks: [],
  },
  {
    code: "preflightNoProtectedSecrets",
    paths: ["C:\\ProgramData\\VEM\\secrets", "C:\\ProgramData\\VEM\\overrides"],
    services: [],
    tasks: [],
  },
  {
    code: "preflightNoDaemonState",
    paths: [
      "C:\\VEM\\bringup",
      "C:\\ProgramData\\VEM\\factory",
      "C:\\ProgramData\\VEM\\bringup",
      "C:\\ProgramData\\VEM\\vending-daemon",
      "C:\\ProgramData\\VEM\\maintenance",
      "C:\\ProgramData\\ssh\\sshd_config",
    ],
    services: [
      "VemVendingDaemon",
      "WireGuardTunnel$VEM-Maintenance",
      "WireGuardTunnelVEM-Maintenance",
    ],
    tasks: ["VEMMachineUI", "VEM\\StartVisionServer"],
  },
  {
    code: "preflightNoPreviousVemEvidence",
    paths: ["C:\\ProgramData\\VEM\\evidence"],
    services: [],
    tasks: [],
  },
];
const KNOWN_DIRTY_CLEAN_BASE_SOURCE_MARKERS = [
  "100.68.189.11",
  "192.168.2.161",
  "win10-vem-e2e",
  "desktop-2stvs5b",
  "dirty",
  "retained",
];
const KNOWN_PRODUCTION_CLEAN_BASE_SOURCE_MARKERS = [
  "100.66.207.119",
  "desktop-2idrn2k",
  "vem-win10-real-01",
  "admin@real",
  "admin@100.66.207.119",
  "admin@desktop-2idrn2k",
];
const KNOWN_PRODUCTION_CLEAN_BASE_SOURCE_TOKENS = new Set(["vem", "real"]);
const FACTORY_SUPPORT_SCRIPT_NAMES = [
  "prepare-factory-runtime.ps1",
  "verify-factory-runtime.ps1",
  "setup-scheduled-tasks.ps1",
  "verify-kiosk-lockdown.ps1",
  "verify-vem-runtime.ps1",
  "apply-managed-update.ps1",
  "provision-vision-factory-release.ps1",
  "install-vision-release.ps1",
  "vision-release-materialization.psm1",
  "vision-diagnostic-redaction.psm1",
  "test-wireguard-localsystem-acceptance.ps1",
];

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
const TESTBED_MACHINE_CODE_PREFIX = "VEM-TESTBED-";
const EXPECTED_MACHINE_UI_TASK_NAME = "VEMMachineUI";
const EXPECTED_MACHINE_UI_COMMAND = "C:\\Windows\\System32\\wscript.exe";
const EXPECTED_MACHINE_UI_LAUNCHER = "C:\\VEM\\bringup\\launch-machine-ui.vbs";
const EXPECTED_MACHINE_UI_WORKING_DIRECTORY = "C:\\VEM\\bringup";
const EXPECTED_PORTRAIT_WIDTH_PX = 1080;
const EXPECTED_PORTRAIT_HEIGHT_PX = 1920;
const DEFAULT_CONTROLLED_MAINTENANCE_USER = "YKDZ";
const DEFAULT_CONTROLLED_MAINTENANCE_INGRESS_HOST =
  "controlled-maintenance-ingress.local";
const DEFAULT_CONTROLLED_MAINTENANCE_REMOTE = `${DEFAULT_CONTROLLED_MAINTENANCE_USER}@${DEFAULT_CONTROLLED_MAINTENANCE_INGRESS_HOST}`;
const DEFAULT_VM_ACCEPTANCE_MACHINE_CODE_PREFIX = "VEM-TESTBED-WINVM";
const DEFAULT_VM_ACCEPTANCE_EVIDENCE_ROOT = "artifacts/vm-runtime-acceptance";
const EPHEMERAL_DATABASE_URL_ENV = "VEM_EPHEMERAL_DATABASE_URL";
const INSTALLED_KIOSK_SALE_DATABASE_URL_ENV =
  "VEM_INSTALLED_KIOSK_SALE_DATABASE_URL";
const DEFAULT_CLEAN_BASE_ACCEPTANCE_EVIDENCE_ROOT =
  "artifacts/clean-base-factory-acceptance";

export function nonQueryChildEnvironment(environment = process.env) {
  const childEnvironment = { ...environment };
  delete childEnvironment.DATABASE_URL;
  return childEnvironment;
}

export function buildBringUpPlan(options = {}) {
  const maintenanceIngressSourceAllowlist = String(
    options.maintenanceIngressSourceAllowlist ?? "",
  ).trim();
  return {
    setupScript:
      options.setupScript ??
      "C:\\VEM\\bringup\\scripts\\setup-scheduled-tasks.ps1",
    requiredSecretEnvironment: [
      "VEM_KIOSK_PASSWORD",
      "VEM_MAINTENANCE_PASSWORD",
      "VEM_AUTOLOGON_PASSWORD",
    ],
    arguments: {
      KioskUser: "VEMKiosk",
      MaintenanceUser: "YKDZ",
      RunAsUser: "YKDZ",
      AutoLogonDomain: "$env:COMPUTERNAME",
      BringupDir: "C:\\VEM\\bringup",
      DaemonExe: "C:\\VEM\\bringup\\vending-daemon.exe",
      DaemonDataDir: "C:\\ProgramData\\VEM\\vending-daemon",
      DaemonReadyFile:
        "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json",
      StartupBringupEvidenceFile: STARTUP_BRINGUP_EVIDENCE_FILE,
      MachineUiExe: "C:\\VEM\\bringup\\machine.exe",
      MachineUiLauncher: "C:\\VEM\\bringup\\launch-machine-ui.vbs",
      MachineUiDebugLauncher: "C:\\VEM\\bringup\\launch-machine-ui-debug.vbs",
      VisionLauncher: "C:\\VEM\\bringup\\start_vision.bat",
      VisionWorkingDirectory: "C:\\VEM\\vision",
      KioskPassword: "$env:VEM_KIOSK_PASSWORD",
      MaintenancePassword: "$env:VEM_MAINTENANCE_PASSWORD",
      AutoLogonPassword: "$env:VEM_AUTOLOGON_PASSWORD",
      ...(maintenanceIngressSourceAllowlist
        ? {
            MaintenanceIngressSourceAllowlist:
              maintenanceIngressSourceAllowlist,
          }
        : {}),
    },
    switches: [
      "ConfigureKioskAccounts",
      "UseKioskAccount",
      "ConfigureAutoLogon",
      ...(maintenanceIngressSourceAllowlist
        ? ["ConfigureControlledMaintenanceIngress"]
        : []),
    ],
  };
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

async function admitFactoryMediaBeforeAcceptance(options) {
  const supplied = [
    options.factoryIso,
    options.factoryAssemblyMode,
    options.factoryManifest,
    options.factoryProvenance,
    options.factoryProvenanceDigest,
    options.factoryManifestPath,
    options.factoryProvenancePath,
    options.factoryIsoPath,
    options.factoryUdfExtractorPath,
    options.factoryUdfWriterPath,
    options.factoryWimlibPath,
  ];
  if (supplied.every((value) => value === undefined)) return null;
  if (supplied.some((value) => typeof value !== "string" || value.length === 0))
    throw new Error(
      "Factory acceptance requires complete host-owned Factory media provenance inputs",
    );
  if (options.factoryAssemblyMode !== "windows-serviced-iso")
    throw new Error(
      "Factory acceptance requires windows-serviced-iso assembly",
    );
  const digest = /^sha256:[a-f0-9]{64}$/;
  if (
    !/^factory-cas:\/\/sha256\/[a-f0-9]{64}$/.test(options.factoryIso) ||
    !digest.test(options.factoryManifest) ||
    !/^factory-evidence:\/\/sha256\/[a-f0-9]{64}$/.test(
      options.factoryProvenance,
    ) ||
    !digest.test(options.factoryProvenanceDigest)
  )
    throw new Error(
      "Factory acceptance requires immutable Factory media identities",
    );
  if (
    options.factoryProvenance !==
    `factory-evidence://${options.factoryProvenanceDigest.replace(":", "/")}`
  )
    throw new Error(
      "Factory acceptance provenance identity does not bind its digest",
    );
  const outputDigest = `sha256:${options.factoryIso.slice("factory-cas://sha256/".length)}`;
  return admitFactoryAcceptance({
    manifestPath: options.factoryManifestPath,
    provenancePath: options.factoryProvenancePath,
    outputIsoPath: options.factoryIsoPath,
    manifestIdentity: options.factoryManifest,
    provenanceDigest: options.factoryProvenanceDigest,
    outputIdentity: options.factoryIso,
    outputDigest,
    udfExtractorPath: options.factoryUdfExtractorPath,
    udfWriterPath: options.factoryUdfWriterPath,
    wimlibPath: options.factoryWimlibPath,
  });
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
    facts.serviceState?.daemonService?.installed !== true ||
    facts.serviceState?.daemonService?.running !== true ||
    facts.serviceState?.daemonService?.startupType !== "automatic"
  ) {
    addDiagnostic(
      diagnostics,
      "daemon_service_not_running",
      "Vending Daemon must be installed, running, and configured for automatic startup.",
    );
  }
  if (facts.startupBringup?.machineUiStartup?.mode === "scheduled_task") {
    if (facts.serviceState?.machineUiTask?.exists !== true) {
      addDiagnostic(
        diagnostics,
        "machine_ui_task_missing",
        "VEMMachineUI scheduled task must exist before runtime-ready can pass.",
      );
    }
    if (facts.serviceState?.machineUiTask?.enabled !== true) {
      addDiagnostic(
        diagnostics,
        "machine_ui_task_disabled",
        "VEMMachineUI scheduled task must be enabled before runtime-ready can pass.",
      );
    }
    if (facts.serviceState?.machineUiTask?.runAsUser !== EXPECTED_KIOSK_USER) {
      addDiagnostic(
        diagnostics,
        "machine_ui_task_user_mismatch",
        "VEMMachineUI scheduled task must run as the VEMKiosk user.",
      );
    }
  }
  if (
    facts.startupBringup?.configuredBy !==
      "scripts/windows/setup-scheduled-tasks.ps1" ||
    facts.startupBringup?.productionBringup !== true
  ) {
    addDiagnostic(
      diagnostics,
      "production_bringup_required",
      "Fresh Bring-Up Acceptance must use the production bring-up script path.",
    );
  }
  if (facts.startupBringup?.daemonOwnedInitialization === true) {
    addDiagnostic(
      diagnostics,
      "daemon_owned_startup_initialization",
      "Winlogon auto-logon and customer startup must not be daemon-owned initialization.",
    );
  }
  if (facts.startupBringup?.autoLogon?.configured !== true) {
    addDiagnostic(
      diagnostics,
      "winlogon_autologon_missing",
      "Winlogon auto-logon must be configured by production bring-up before runtime-ready can pass.",
    );
  }
  if (facts.startupBringup?.autoLogon?.user !== EXPECTED_KIOSK_USER) {
    addDiagnostic(
      diagnostics,
      "winlogon_autologon_user_mismatch",
      "Winlogon auto-logon must target the VEMKiosk customer session.",
    );
  }
  if (facts.startupBringup?.autoLogon?.force !== true) {
    addDiagnostic(
      diagnostics,
      "winlogon_force_autologon_missing",
      "Winlogon ForceAutoLogon must be enabled for unattended cold boot acceptance.",
    );
  }
  if (facts.startupBringup?.machineUiStartup?.configured !== true) {
    addDiagnostic(
      diagnostics,
      "machine_ui_startup_missing",
      "Machine UI startup must be configured by production bring-up.",
    );
  }
  if (
    facts.startupBringup?.machineUiStartup?.runAsUser !== EXPECTED_KIOSK_USER
  ) {
    addDiagnostic(
      diagnostics,
      "machine_ui_startup_user_mismatch",
      "Machine UI startup must target the VEMKiosk customer session.",
    );
  }
  if (facts.startupBringup?.machineUiStartup?.mode === "scheduled_task") {
    const machineUiStartupCommand = facts.startupBringup?.startupCommands?.find(
      (command) =>
        command?.name === EXPECTED_MACHINE_UI_TASK_NAME ||
        command?.name === `\\${EXPECTED_MACHINE_UI_TASK_NAME}`,
    );

    if (machineUiStartupCommand?.exists !== true) {
      addDiagnostic(
        diagnostics,
        "machine_ui_startup_command_missing",
        "Production bring-up must provide live VEMMachineUI startup command evidence.",
      );
    } else {
      if (machineUiStartupCommand.enabled !== true) {
        addDiagnostic(
          diagnostics,
          "machine_ui_startup_command_disabled",
          "VEMMachineUI startup command must be enabled.",
        );
      }
      if (machineUiStartupCommand.runAsUser !== EXPECTED_KIOSK_USER) {
        addDiagnostic(
          diagnostics,
          "machine_ui_startup_command_user_mismatch",
          "VEMMachineUI startup command must run as the VEMKiosk user.",
        );
      }
      if (machineUiStartupCommand.command !== EXPECTED_MACHINE_UI_COMMAND) {
        addDiagnostic(
          diagnostics,
          "machine_ui_startup_command_path_mismatch",
          "VEMMachineUI startup command must use the production wscript launcher path.",
        );
      }
      if (
        !String(machineUiStartupCommand.arguments ?? "").includes(
          EXPECTED_MACHINE_UI_LAUNCHER,
        )
      ) {
        addDiagnostic(
          diagnostics,
          "machine_ui_startup_arguments_mismatch",
          "VEMMachineUI startup arguments must point at the production machine UI launcher.",
        );
      }
      if (
        machineUiStartupCommand.workingDirectory !==
        EXPECTED_MACHINE_UI_WORKING_DIRECTORY
      ) {
        addDiagnostic(
          diagnostics,
          "machine_ui_startup_working_directory_mismatch",
          "VEMMachineUI startup working directory must be the production bring-up directory.",
        );
      }
    }
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
    facts.serviceState?.visionTask?.exists !== true ||
    facts.serviceState?.visionTask?.enabled !== true
  ) {
    addDiagnostic(
      diagnostics,
      "vision_task_not_ready",
      "The installed Vision runtime task must exist and be enabled.",
    );
  }
  if (
    facts.visionRuntime?.healthReachable !== true ||
    !["ok", "degraded"].includes(facts.visionRuntime?.healthStatus) ||
    facts.visionRuntime?.healthProtocol !== "vem.vision.v1" ||
    facts.visionRuntime?.healthModule !== "vision" ||
    facts.visionRuntime?.healthMockScenario !== false ||
    !present(facts.visionRuntime?.version) ||
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
    !present(facts.visionRuntime?.selectedReleaseVersion) ||
    facts.visionRuntime?.version !==
      facts.visionRuntime?.selectedReleaseVersion ||
    !Number.isInteger(facts.visionRuntime?.activeProcessId) ||
    facts.visionRuntime.activeProcessId < 1 ||
    facts.visionRuntime?.listenerBound !== true ||
    !Number.isInteger(facts.visionRuntime?.listenerProcessId) ||
    facts.visionRuntime.listenerProcessId !==
      facts.visionRuntime.activeProcessId ||
    facts.visionRuntime?.listenerOwnerCount !== 1 ||
    !["Get-NetTCPConnection", "netstat"].includes(
      facts.visionRuntime?.listenerBindingSource,
    )
  ) {
    addDiagnostic(
      diagnostics,
      "vision_installed_process_not_bound",
      "Vision acceptance must bind the listener to the selected installed release and its recorded active process.",
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
    typeof facts.visionRuntime?.readyServerVersion !== "string" ||
    facts.visionRuntime.readyServerVersion.trim().length === 0 ||
    facts.visionRuntime.readyServerVersion.length > 64 ||
    facts.visionRuntime?.readyServerVersion !== facts.visionRuntime?.version ||
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
      "ambient_light",
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
  const desktopEscape = facts.kioskDesktopEscape ?? {};
  for (const [field, code, message] of [
    [
      "desktopVisible",
      "kiosk_desktop_visible",
      "VEMKiosk normal UI path must not expose the Windows desktop.",
    ],
    [
      "taskbarVisible",
      "kiosk_taskbar_visible",
      "VEMKiosk normal UI path must not expose the Windows taskbar.",
    ],
    [
      "startMenuVisible",
      "kiosk_start_menu_visible",
      "VEMKiosk normal UI path must not expose the Windows Start menu.",
    ],
    [
      "edgeReachable",
      "kiosk_edge_reachable",
      "VEMKiosk normal UI path must not reach Microsoft Edge.",
    ],
    [
      "fileExplorerReachable",
      "kiosk_file_explorer_reachable",
      "VEMKiosk normal UI path must not reach File Explorer.",
    ],
  ]) {
    if (desktopEscape[field] === true) {
      addDiagnostic(diagnostics, code, message);
    } else if (desktopEscape[field] !== false) {
      addDiagnostic(
        diagnostics,
        `${code}_observation_missing`,
        `${message} The acceptance probe must explicitly observe this surface as unavailable.`,
      );
    }
  }
  if (
    !Number.isInteger(facts.kioskRuntime?.processId) ||
    facts.kioskRuntime?.machineProcessCount !== 1 ||
    facts.kioskRuntime?.machineExecutablePath !==
      INSTALLED_KIOSK_SALE_MACHINE_PATH
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
      String(evidence.endpoint ?? "").endsWith("/v1/bring-up/tasks/execute") &&
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
    unregisterScheduledTasks: [
      "VEMMachineUI",
      "VEMMaintenanceUI",
      "VEM\\StartVisionServer",
    ],
    removeDirectories: [...VEM_RESET_ROOTS],
    removeFiles: [...VEM_RESET_FILES],
    preservedResources: [
      "Windows OS",
      "display setup",
      "OpenSSH",
      "Controlled Maintenance Ingress configuration",
      "WebView2",
      "YKDZ maintenance account",
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

function psCleanBasePreflightProbeArray() {
  return `@(${CLEAN_BASE_PREFLIGHT_ABSENCE_PROBES.map(
    (probe) =>
      `[ordered]@{ code = ${psString(probe.code)}; paths = ${psArray(
        probe.paths,
      )}; services = ${psArray(probe.services)}; tasks = ${psArray(
        probe.tasks,
      )} }`,
  ).join(", ")})`;
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

function normalizeRemoteForSafety(remote) {
  const value = String(remote ?? DEFAULT_CONTROLLED_MAINTENANCE_REMOTE).trim();
  const lastAt = value.lastIndexOf("@");
  if (lastAt === -1) {
    return { user: null, host: value };
  }
  return {
    user: value.slice(0, lastAt),
    host: value.slice(lastAt + 1),
  };
}

function assertCleanBaseRemoteSafety(options = {}) {
  if (options.mode !== "clean-base-factory-acceptance") {
    return;
  }
  const remote = normalizeRemoteForSafety(options.remote);
  const refusal = classifyUnsafeCleanBaseSource([
    options.cleanBaseSource,
    options.cleanBaseSnapshot,
    remote.user,
    remote.host,
  ]);
  if (refusal) {
    throw new Error(
      `clean-base factory acceptance refuses ${refusal} remote before staging: ${options.remote}`,
    );
  }
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

function splitCsvOption(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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

export function assertTrustedProtectedFactoryPersonalizationGate(
  environment = process.env,
) {
  const requiredLabels = ["self-hosted", "Linux", "X64", "vem-factory"];
  let labels;
  try {
    labels = JSON.parse(
      environment.VEM_FACTORY_PERSONALIZATION_RUNNER_LABELS ?? "",
    );
  } catch {
    throw new Error(
      "Factory Personalization Media requires the protected runner label assertion",
    );
  }
  if (
    !Array.isArray(labels) ||
    !requiredLabels.every((label) => labels.includes(label))
  ) {
    throw new Error(
      "Factory Personalization Media requires exact protected factory runner labels",
    );
  }
  const repository = String(environment.GITHUB_REPOSITORY ?? "");
  const ref = String(environment.GITHUB_REF ?? "");
  const expectedWorkflow = `${repository}/.github/workflows/factory-image-acceptance.yml@${ref}`;
  if (
    environment.GITHUB_ACTIONS !== "true" ||
    environment.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    (ref !== "refs/heads/main" && !/^refs\/tags\/factory-v/.test(ref)) ||
    environment.GITHUB_WORKFLOW_REF !== expectedWorkflow ||
    environment.GITHUB_ACTOR !== environment.GITHUB_REPOSITORY_OWNER ||
    environment.VEM_FACTORY_PERSONALIZATION_TRUSTED_GATE !== "approved" ||
    !environment.VEM_FACTORY_PERSONALIZATION_TRUSTED_RUNNER_NAME ||
    environment.VEM_FACTORY_PERSONALIZATION_RUNNER_NAME !==
      environment.VEM_FACTORY_PERSONALIZATION_TRUSTED_RUNNER_NAME
  ) {
    throw new Error(
      "Factory Personalization Media requires the approved protected GitHub gate and exact runner identity",
    );
  }
  return {
    workflowRef: expectedWorkflow,
    runnerName: environment.VEM_FACTORY_PERSONALIZATION_RUNNER_NAME,
  };
}

async function resolveHostOwnedFactoryPersonalizationMedia(options = {}) {
  if (options.mode !== "clean-base-factory-acceptance") {
    return null;
  }
  assertTrustedProtectedFactoryPersonalizationGate();
  const mediaPath = process.env.VEM_FACTORY_PERSONALIZATION_MEDIA_PATH;
  if (!mediaPath) {
    throw new Error(
      "clean-base factory acceptance requires host-owned VEM_FACTORY_PERSONALIZATION_MEDIA_PATH after the trusted protected gate",
    );
  }
  const snapshot = await readFactoryPersonalizationMediaSnapshot(mediaPath);
  const media = snapshot.media;
  const expectedProfile = options.factoryProfile ?? "testbed";
  if (media.profile !== expectedProfile) {
    throw new Error(
      "Factory Personalization Media profile does not match --factory-profile",
    );
  }
  return {
    snapshot,
    redacted: redactFactoryPersonalizationMedia(media, {
      mediaConsumed: true,
      stagingRetained: false,
    }),
  };
}

export function resolveCleanBaseFactoryCapabilityInputs(options = {}) {
  if (options.mode !== "clean-base-factory-acceptance") {
    return null;
  }
  const factoryProfile = String(options.factoryProfile ?? "").trim();
  if (!new Set(["production", "testbed"]).has(factoryProfile)) {
    throw new Error(
      "clean-base factory capability requires explicit --factory-profile production|testbed",
    );
  }
  const required = [
    ["openssh-package", "openSshPackage"],
    ["wireguard-package", "wireGuardPackage"],
    ["maintenance-ca-public-key", "maintenanceCaPublicKey"],
    ["openssh-package-version", "openSshPackageVersion", false],
    [
      "openssh-approved-signer-thumbprint",
      "openSshApprovedSignerThumbprint",
      false,
    ],
    [
      "openssh-approved-root-thumbprint",
      "openSshApprovedRootThumbprint",
      false,
    ],
    ["wireguard-package-version", "wireGuardPackageVersion", false],
    [
      "wireguard-approved-signer-thumbprint",
      "wireGuardApprovedSignerThumbprint",
      false,
    ],
    [
      "wireguard-approved-root-thumbprint",
      "wireGuardApprovedRootThumbprint",
      false,
    ],
    [
      "maintenance-wireguard-listen-address",
      "maintenanceWireGuardListenAddress",
      false,
    ],
    ["factory-hardware-model", "factoryHardwareModel", false],
    ["factory-topology-identity", "factoryTopologyIdentity", false],
    ["factory-topology-version", "factoryTopologyVersion", false],
  ];
  for (const [label, key, isFile = true] of required) {
    if (!options[key] || (isFile && !existsSync(options[key]))) {
      throw new Error(`clean-base factory capability requires --${label}`);
    }
  }
  for (const [label, value] of [
    ["OpenSSH approved signer", options.openSshApprovedSignerThumbprint],
    ["OpenSSH approved root", options.openSshApprovedRootThumbprint],
    ["WireGuard approved signer", options.wireGuardApprovedSignerThumbprint],
    ["WireGuard approved root", options.wireGuardApprovedRootThumbprint],
  ]) {
    if (!/^[0-9a-fA-F]{40}$/.test(String(value))) {
      throw new Error(`${label} thumbprint must be 40 hexadecimal characters`);
    }
  }
  const caLines = readFileSync(options.maintenanceCaPublicKey, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  if (
    caLines.length !== 1 ||
    !caLines[0].endsWith(` vem-maintenance-ca:${factoryProfile}`)
  ) {
    throw new Error(
      `Maintenance SSH CA must contain exactly one key for profile ${factoryProfile}`,
    );
  }
  if (factoryProfile === "production") {
    if (!options.platformApiBaseUrl || !options.platformMqttUrl) {
      throw new Error(
        "production factory capability requires explicit production platform API and MQTT endpoints",
      );
    }
    const productionInputs = [
      options.remote,
      options.factoryHardwareModel,
      options.factoryTopologyIdentity,
      options.maintenanceCaPublicKey,
      options.platformApiBaseUrl,
      options.platformMqttUrl,
    ].join(" ");
    if (
      /YKDZ|testbed|simulator|shared-password|test-ca|test-peer|118\.25\.104\.160/iu.test(
        productionInputs,
      )
    ) {
      throw new Error(
        "production factory capability rejects testbed or simulator inputs",
      );
    }
  }
  const runnerSources = splitCsvOption(
    options.maintenanceRunnerSourceAllowlist,
  );
  const maintainerSources = splitCsvOption(
    options.maintenanceMaintainerSourceAllowlist,
  );
  if (runnerSources.length === 0 || maintainerSources.length === 0) {
    throw new Error(
      "clean-base factory capability requires runner and maintainer role pools",
    );
  }
  const packageInputs = [
    ["openSshPackage", "openSshPackageSha256", "OpenSSH package"],
    ["wireGuardPackage", "wireGuardPackageSha256", "WireGuard package"],
    [
      "maintenanceCaPublicKey",
      "maintenanceCaPublicKeySha256",
      "Maintenance SSH CA public key",
    ],
  ].map(([pathKey, hashKey, label]) => {
    const actual = sha256File(options[pathKey]);
    if (
      options[hashKey] &&
      actual !== assertSha256Hash(options[hashKey], label)
    ) {
      throw new Error(
        `${label} hash mismatch: expected ${options[hashKey]}, got ${actual}`,
      );
    }
    return { pathKey, hash: actual };
  });
  return {
    factoryProfile,
    maintenanceUser: factoryProfile === "production" ? "Admin" : "YKDZ",
    hardwareMode: factoryProfile === "production" ? "production" : "simulated",
    openSshPackageSha256: packageInputs[0].hash,
    wireGuardPackageSha256: packageInputs[1].hash,
    maintenanceCaPublicKeySha256: packageInputs[2].hash,
    wireGuardListenAddress: normalizeWireGuardHostAddress(
      options.maintenanceWireGuardListenAddress,
    ),
    runnerSources,
    maintainerSources,
  };
}

function normalizeWireGuardHostAddress(value) {
  const parts = String(value ?? "")
    .trim()
    .split("/");
  const address = parts[0];
  const version = isIP(address);
  const expectedPrefix = version === 6 ? "128" : "32";
  if (
    version === 0 ||
    ["0.0.0.0", "::", "127.0.0.1", "::1"].includes(address) ||
    parts.length > 2 ||
    (parts.length === 2 && parts[1] !== expectedPrefix)
  ) {
    throw new Error(
      "maintenance WireGuard listen address must be a concrete bare IP or single-host CIDR",
    );
  }
  return address;
}

function resolveCleanBaseArtifactInputs(options = {}) {
  if (options.mode !== "clean-base-factory-acceptance") {
    return null;
  }
  if (!options.daemonArtifact || !options.machineUiArtifact) {
    throw new Error(
      "clean-base factory acceptance live mode requires --daemon-artifact and --machine-ui-artifact",
    );
  }
  resolveMachineUiSidecarArtifactPath(options.machineUiArtifact);
  const daemonSha256 = sha256File(options.daemonArtifact);
  const machineUiSha256 = sha256File(options.machineUiArtifact);
  if (
    options.daemonArtifactSha256 &&
    daemonSha256 !==
      assertSha256Hash(
        options.daemonArtifactSha256,
        "clean-base factory acceptance daemon artifact",
      )
  ) {
    throw new Error(
      `clean-base factory acceptance daemon artifact hash mismatch: expected ${options.daemonArtifactSha256}, got ${daemonSha256}`,
    );
  }
  if (
    options.machineUiArtifactSha256 &&
    machineUiSha256 !==
      assertSha256Hash(
        options.machineUiArtifactSha256,
        "clean-base factory acceptance machine UI artifact",
      )
  ) {
    throw new Error(
      `clean-base factory acceptance machine UI artifact hash mismatch: expected ${options.machineUiArtifactSha256}, got ${machineUiSha256}`,
    );
  }
  return {
    source: "uploaded_local_artifacts",
    daemonSha256,
    machineUiSha256,
  };
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

function resolveAcceptanceArtifactHashes(options = {}, label) {
  if (options.daemonArtifactSha256 && options.machineUiArtifactSha256) {
    return {
      source: "declared_artifact_hashes",
      daemonSha256: assertSha256Hash(
        options.daemonArtifactSha256,
        `${label} daemon artifact`,
      ),
      machineUiSha256: assertSha256Hash(
        options.machineUiArtifactSha256,
        `${label} machine UI artifact`,
      ),
    };
  }
  if (!options.daemonArtifact || !options.machineUiArtifact) {
    throw new Error(
      `${label} requires --daemon-artifact and --machine-ui-artifact, or explicit artifact SHA-256 values`,
    );
  }
  resolveMachineUiSidecarArtifactPath(options.machineUiArtifact);
  return {
    source: "local_artifacts",
    daemonSha256: sha256File(options.daemonArtifact),
    machineUiSha256: sha256File(options.machineUiArtifact),
  };
}

function requireCleanBaseSource(value) {
  const source = String(value ?? "").trim();
  if (source.length === 0) {
    throw new Error(
      "clean-base factory acceptance requires --clean-base-source identifying a clean Windows base or VM source",
    );
  }
  const refusal = classifyUnsafeCleanBaseSource(source);
  if (refusal) {
    throw new Error(
      `clean-base factory acceptance refuses ${refusal} source: ${source}`,
    );
  }
  return source;
}

function collectCleanBaseSourceStrings(value, strings = []) {
  if (value === null || value === undefined) {
    return strings;
  }
  if (typeof value === "string" || typeof value === "number") {
    strings.push(String(value));
    return strings;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectCleanBaseSourceStrings(item, strings);
    }
    return strings;
  }
  if (typeof value === "object") {
    for (const item of Object.values(value)) {
      collectCleanBaseSourceStrings(item, strings);
    }
  }
  return strings;
}

function hasUnsafeCleanBaseToken(value) {
  const tokens = String(value)
    .toLowerCase()
    .split(/[^a-z0-9.-]+/u)
    .filter(Boolean);
  return tokens.some((token) =>
    KNOWN_PRODUCTION_CLEAN_BASE_SOURCE_TOKENS.has(token),
  );
}

function classifyUnsafeCleanBaseSource(value) {
  const values = collectCleanBaseSourceStrings(value).map((item) =>
    item.toLowerCase(),
  );
  for (const item of values) {
    if (
      KNOWN_DIRTY_CLEAN_BASE_SOURCE_MARKERS.some((marker) =>
        item.includes(marker),
      )
    ) {
      return "known dirty-host";
    }
    if (
      KNOWN_PRODUCTION_CLEAN_BASE_SOURCE_MARKERS.some((marker) =>
        item.includes(marker),
      ) ||
      hasUnsafeCleanBaseToken(item)
    ) {
      return "production machine";
    }
  }
  return null;
}

function cleanBaseValidationFailure(message, detail = null) {
  return {
    schemaVersion: "clean-base-factory-acceptance-validation/v1",
    kind: CLEAN_BASE_FACTORY_ACCEPTANCE_KIND,
    status: "failed",
    asserted: false,
    message,
    detail,
  };
}

function sameStringArray(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((value, index) => actual[index] === value)
  );
}

function sameStringMap(actual, expected) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
    return false;
  }
  const actualEntries = Object.entries(actual);
  const expectedEntries = Object.entries(expected);
  return (
    actualEntries.length === expectedEntries.length &&
    expectedEntries.every(([key, value]) => actual[key] === value)
  );
}

export function validateCleanBaseFactoryAcceptanceEvidence(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return cleanBaseValidationFailure(
      "clean-base evidence must be a JSON object",
    );
  }
  if (
    evidence.schemaVersion !==
    CLEAN_BASE_FACTORY_ACCEPTANCE_REPORT_SCHEMA_VERSION
  ) {
    return cleanBaseValidationFailure(
      `clean-base evidence requires schemaVersion ${CLEAN_BASE_FACTORY_ACCEPTANCE_REPORT_SCHEMA_VERSION}`,
    );
  }
  if (evidence.kind !== CLEAN_BASE_FACTORY_ACCEPTANCE_KIND) {
    return cleanBaseValidationFailure(
      `clean-base evidence requires kind ${CLEAN_BASE_FACTORY_ACCEPTANCE_KIND}`,
    );
  }
  if (evidence.result !== "passed" || evidence.ok !== true) {
    return cleanBaseValidationFailure(
      "clean-base evidence result must be passed with ok true",
    );
  }
  if (evidence.dryRun === true || evidence.planOnly === true) {
    return cleanBaseValidationFailure(
      "clean-base evidence must be verifier output, not dry-run or plan output",
    );
  }
  const source = evidence.source;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return cleanBaseValidationFailure(
      "clean-base evidence requires structured source",
    );
  }
  if (source.kind !== "clean-windows-base") {
    return cleanBaseValidationFailure(
      "clean-base evidence source.kind must be clean-windows-base",
    );
  }
  const sourceUri = String(source.uri ?? "").trim();
  if (sourceUri.length === 0) {
    return cleanBaseValidationFailure("clean-base evidence source.uri missing");
  }
  const sourceRefusal = classifyUnsafeCleanBaseSource(source);
  if (sourceRefusal) {
    return cleanBaseValidationFailure(
      `clean-base evidence refuses ${sourceRefusal} source`,
      source,
    );
  }
  const factoryProfile = evidence.factoryProfile;
  if (!new Set(["production", "testbed"]).has(factoryProfile)) {
    return cleanBaseValidationFailure(
      "clean-base evidence requires an explicit production or testbed factoryProfile",
    );
  }
  const factoryWindowsBaselinePolicy = evidence.factoryWindowsBaselinePolicy;
  if (
    !factoryWindowsBaselinePolicy ||
    typeof factoryWindowsBaselinePolicy !== "object" ||
    Array.isArray(factoryWindowsBaselinePolicy)
  ) {
    return cleanBaseValidationFailure(
      "clean-base evidence requires Factory Windows Baseline policy",
    );
  }
  if (
    factoryWindowsBaselinePolicy.schemaVersion !==
      FACTORY_WINDOWS_BASELINE_POLICY.schemaVersion ||
    factoryWindowsBaselinePolicy.model !== FACTORY_WINDOWS_BASELINE_POLICY.model
  ) {
    return cleanBaseValidationFailure(
      "clean-base evidence Factory Windows Baseline policy schema/model mismatch",
    );
  }
  if (
    !sameStringArray(
      factoryWindowsBaselinePolicy.requiredCapabilities,
      FACTORY_WINDOWS_BASELINE_POLICY.requiredCapabilities,
    )
  ) {
    return cleanBaseValidationFailure(
      "clean-base evidence Factory Windows Baseline policy requiredCapabilities mismatch",
    );
  }
  if (
    !sameStringArray(
      factoryWindowsBaselinePolicy.disabledRuntimeInterference,
      FACTORY_WINDOWS_BASELINE_POLICY.disabledRuntimeInterference,
    )
  ) {
    return cleanBaseValidationFailure(
      "clean-base evidence Factory Windows Baseline policy disabledRuntimeInterference mismatch",
    );
  }
  if (
    !sameStringMap(
      factoryWindowsBaselinePolicy.evidenceFields,
      FACTORY_WINDOWS_BASELINE_POLICY.evidenceFields,
    )
  ) {
    return cleanBaseValidationFailure(
      "clean-base evidence Factory Windows Baseline policy evidenceFields mismatch",
    );
  }

  const daemonSha256 = evidence.artifacts?.daemonSha256;
  const machineUiSha256 = evidence.artifacts?.machineUiSha256;
  if (!SHA256_PATTERN.test(String(daemonSha256 ?? ""))) {
    return cleanBaseValidationFailure(
      "clean-base evidence requires daemon SHA-256 hash",
    );
  }
  if (!SHA256_PATTERN.test(String(machineUiSha256 ?? ""))) {
    return cleanBaseValidationFailure(
      "clean-base evidence requires machine UI SHA-256 hash",
    );
  }

  const readiness = evidence.readiness;
  if (!readiness || typeof readiness !== "object") {
    return cleanBaseValidationFailure(
      "clean-base evidence requires readiness summary",
    );
  }
  if (readiness.cleanBasePreparationAcceptance !== "passed") {
    return cleanBaseValidationFailure(
      "clean-base readiness must pass cleanBasePreparationAcceptance",
    );
  }
  if (readiness.runtimeReady !== "not_asserted") {
    return cleanBaseValidationFailure(
      "clean-base evidence must not assert runtimeReady",
    );
  }
  if (readiness.simulatedHardwareReady !== "not_asserted") {
    return cleanBaseValidationFailure(
      "clean-base evidence must not assert simulatedHardwareReady",
    );
  }
  if (readiness.sellReady !== "not_asserted") {
    return cleanBaseValidationFailure(
      "clean-base evidence must not assert sellReady",
    );
  }

  const assertions = evidence.assertions;
  if (!assertions || typeof assertions !== "object") {
    return cleanBaseValidationFailure(
      "clean-base evidence requires assertions",
    );
  }
  const failedAssertions = REQUIRED_CLEAN_BASE_ASSERTIONS.filter(
    (name) => assertions[name]?.status !== "passed",
  );
  if (failedAssertions.length > 0) {
    return cleanBaseValidationFailure(
      "clean-base evidence required assertions are not all passed",
      { failedAssertions },
    );
  }
  const display = assertions.displayOrientationResolution;
  if (
    display.orientation !== "portrait" ||
    display.widthPx !== 1080 ||
    display.heightPx !== 1920
  ) {
    return cleanBaseValidationFailure(
      "clean-base display assertion must be 1080x1920 portrait",
    );
  }
  const hardwareProfileMode = assertions.hardwareProfileMode;
  if (hardwareProfileMode.profile !== factoryProfile) {
    return cleanBaseValidationFailure(
      "clean-base evidence factoryProfile must match the hardware profile assertion",
    );
  }
  const expectedHardwareMode =
    hardwareProfileMode.profile === "production" ? "production" : "simulated";
  if (hardwareProfileMode.mode !== expectedHardwareMode) {
    return cleanBaseValidationFailure(
      "clean-base evidence hardware mode must match its factory profile",
    );
  }
  const windowsUpdatePolicy = assertions.windowsUpdatePolicy;
  if (
    windowsUpdatePolicy.automaticUpdateInstallation !== "disabled" ||
    windowsUpdatePolicy.automaticRestart !== "disabled"
  ) {
    return cleanBaseValidationFailure(
      "clean-base Windows update policy must disable automatic installation and automatic restart",
    );
  }
  const powerPolicy = assertions.powerPolicy;
  if (
    powerPolicy.sleep !== "disabled" ||
    powerPolicy.hibernation !== "disabled"
  ) {
    return cleanBaseValidationFailure(
      "clean-base power policy must disable sleep and hibernation",
    );
  }
  const bootPolicy = assertions.bootPolicy;
  if (bootPolicy.testsigning !== "off") {
    return cleanBaseValidationFailure(
      "clean-base boot policy must verify testsigning off",
    );
  }
  const securityPosture = assertions.securityPosture;
  if (
    securityPosture.defender !== "enabled" ||
    securityPosture.firewall !== "enabled" ||
    securityPosture.fileAndPrinterSharing !== "not_enabled" ||
    !Array.isArray(securityPosture.enabledVemInboundRules) ||
    securityPosture.enabledVemInboundRules.length !== 0
  ) {
    return cleanBaseValidationFailure(
      "clean-base security posture must preserve Defender/firewall and avoid SMB/File Sharing maintenance ingress",
    );
  }
  const remoteMaintenance = assertions.factoryRemoteMaintenanceCapability;
  if (
    remoteMaintenance.opensshServer !== "available" ||
    remoteMaintenance.tailscale !== "not_installed_by_default" ||
    remoteMaintenance.kioskRemoteAccess !== "denied" ||
    remoteMaintenance.sshdConfigDeniesKioskUser !== true ||
    remoteMaintenance.maintenanceInOpenSshUsers !== true ||
    remoteMaintenance.kioskInOpenSshUsers !== false ||
    remoteMaintenance.kioskInRemoteDesktopUsers !== false
  ) {
    return cleanBaseValidationFailure(
      "clean-base remote maintenance capability must preserve maintenance access and explicitly deny kiosk SSH",
    );
  }
  const consumerExperience = assertions.consumerExperienceInterference;
  if (
    consumerExperience.componentAutostart !== "policy_configured" ||
    consumerExperience.foregroundPopups !== "policy_configured" ||
    consumerExperience.storeAutomaticAppUpdates !== "disabled" ||
    consumerExperience.kioskForegroundTakeover !==
      "best_effort_policy_configured"
  ) {
    return cleanBaseValidationFailure(
      "clean-base consumer-experience interference must be configured as best-effort policy evidence",
    );
  }
  const startup = assertions.startupReachesBringUpOrSalesEligible;
  if (!["bring_up", "sales_eligible"].includes(String(startup.state ?? ""))) {
    return cleanBaseValidationFailure(
      "clean-base startup assertion must reach bring_up or sales_eligible",
    );
  }

  return {
    schemaVersion: "clean-base-factory-acceptance-validation/v1",
    kind: CLEAN_BASE_FACTORY_ACCEPTANCE_KIND,
    status: "passed",
    asserted: true,
    source,
    factoryProfile,
    readiness,
    factoryWindowsBaselinePolicy,
    requiredAssertions: [...REQUIRED_CLEAN_BASE_ASSERTIONS],
  };
}

export function validateCleanBaseFactoryAcceptanceEvidenceFile(path) {
  const evidence = JSON.parse(readFileSync(path, "utf8"));
  return validateCleanBaseFactoryAcceptanceEvidence(evidence);
}

export function buildCleanBaseFactoryAcceptancePlan(options = {}) {
  const runId = normalizeEphemeralRunId(options.runId);
  const cleanBaseSource = requireCleanBaseSource(options.cleanBaseSource);
  const cleanBaseSnapshot = String(options.cleanBaseSnapshot ?? "").trim();
  const factoryProfile = String(options.factoryProfile ?? "").trim();
  const visionInputs =
    factoryProfile === "production"
      ? {
          factoryMediaRoot: String(options.factoryMediaRoot ?? "").trim(),
          visionConfigurationSourcePath: String(
            options.visionConfigurationSourcePath ?? "",
          ).trim(),
        }
      : null;
  if (
    visionInputs &&
    (!visionInputs.factoryMediaRoot ||
      !visionInputs.visionConfigurationSourcePath)
  ) {
    throw new Error(
      "production clean-base factory acceptance requires --factory-media-root and --vision-configuration-source-path",
    );
  }
  const artifacts = resolveAcceptanceArtifactHashes(
    options,
    "clean-base factory acceptance",
  );
  const evidenceRoot = `${
    options.evidenceRoot ?? DEFAULT_CLEAN_BASE_ACCEPTANCE_EVIDENCE_ROOT
  }/${runId}`;
  const report = `${evidenceRoot}/${CLEAN_BASE_FACTORY_ACCEPTANCE_FILE_NAME}`;

  return {
    schemaVersion: "clean-base-factory-acceptance-plan/v1",
    mode: "clean-base-factory-acceptance",
    runId,
    cleanBase: {
      source: cleanBaseSource,
      snapshot: cleanBaseSnapshot || null,
      requiresCleanWindowsBase: true,
      ...(visionInputs ? { visionInputs } : {}),
      factoryWindowsBaselinePolicy: structuredClone(
        FACTORY_WINDOWS_BASELINE_POLICY,
      ),
      requiredBaseline: {
        displayOrientationResolution: {
          orientation: "portrait",
          widthPx: 1080,
          heightPx: 1920,
        },
        sshReachability: "required",
        tailscaleDefaultAbsent: "required",
        sleepDisabled: "required",
        testsigningOff: "required",
        autologonConfigured: "required",
        startupLauncherMode: ["shell_launcher", "scheduled_task"],
        daemonService: "VemVendingDaemon",
        uiLauncherTask: "VEMMachineUI",
        runtimeResetGateClean: "required",
        hardwareProfileMode: "required",
        startupReachesBringUpOrSalesEligible: "required",
      },
    },
    evidenceRoot,
    report,
    reportContract: {
      schemaVersion: CLEAN_BASE_FACTORY_ACCEPTANCE_REPORT_SCHEMA_VERSION,
      kind: CLEAN_BASE_FACTORY_ACCEPTANCE_KIND,
      sourceKind: "clean-windows-base",
      factoryWindowsBaselinePolicy: structuredClone(
        FACTORY_WINDOWS_BASELINE_POLICY,
      ),
      requiredAssertions: [...REQUIRED_CLEAN_BASE_ASSERTIONS],
      dryRunAccepted: false,
      resultRequired: "passed",
    },
    artifacts: {
      cleanBaseFactoryAcceptance: report,
      logsRoot: `${evidenceRoot}/logs`,
      daemonSha256: artifacts.daemonSha256,
      machineUiSha256: artifacts.machineUiSha256,
      source: artifacts.source,
    },
    preflightAbsenceProbes: structuredClone(
      CLEAN_BASE_PREFLIGHT_ABSENCE_PROBES,
    ),
    steps: [
      {
        name: "record clean base source",
        status: "planned",
        destructive: false,
      },
      {
        name: "verify clean-base preflight absence",
        status: "planned",
        destructive: false,
      },
      {
        name: "prepare factory runtime",
        status: "planned",
        destructive: true,
        requires: ["--allow-clean-base-prepare"],
      },
      {
        name: "verify prepared runtime",
        status: "planned",
        destructive: false,
      },
      {
        name: "capture reusable snapshot and report",
        status: "planned",
        destructive: false,
      },
    ],
    readinessLevels: {
      cleanBasePreparationAcceptance: "asserted_by_clean_base_step",
      runtimeReady: "not_asserted",
      simulatedHardwareReady: "not_asserted",
      sellReady: "not_asserted",
    },
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
  if (options.maintenanceIngressSourceAllowlist) {
    command.push(
      "--maintenance-ingress-source-allowlist",
      options.maintenanceIngressSourceAllowlist,
    );
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
if ($activeConsolePrincipal -notmatch '(?i)\\VEMKiosk$') { throw 'active console principal must be VEMKiosk' }
$daemon = Get-Service -Name 'VemVendingDaemon' -ErrorAction Stop
if ([string]$daemon.Status -ne 'Running') { throw 'daemon must remain running before installed kiosk sale acceptance' }
$normal = @(Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $machinePath) })
if ($normal.Count -ne 1) { throw "expected exactly one normal machine.exe before debug launch, found $($normal.Count)" }
$normalProcess = Get-Process -Id ([int]$normal[0].ProcessId) -ErrorAction Stop
$owner = Invoke-CimMethod -InputObject $normal[0] -MethodName GetOwner -ErrorAction Stop
if ([string]::IsNullOrWhiteSpace([string]$owner.Domain) -or [string]::IsNullOrWhiteSpace([string]$owner.User)) { throw 'normal machine.exe owner is incomplete' }
$principal = "{0}\{1}" -f [string]$owner.Domain, [string]$owner.User
$sessionId = [int]$normalProcess.SessionId
if ($principal -cne $activeConsolePrincipal -or $sessionId -ne $activeConsoleSessionId) { throw 'normal machine.exe must belong exactly to the active console VEMKiosk principal and session' }
$normalTaskInstance = Get-ScheduledTask -TaskName $normalTask -ErrorAction SilentlyContinue
if ($null -ne $normalTaskInstance) { Stop-ScheduledTask -TaskName $normalTask -ErrorAction Stop }
$launcherOwners = @(Get-CimInstance Win32_Process -Filter "Name = 'wscript.exe'" | Where-Object {
  if (-not ($_.CommandLine -and $_.CommandLine -match [regex]::Escape('${INSTALLED_KIOSK_SALE_NORMAL_LAUNCHER}'))) { return $false }
  $launcherProcess = Get-Process -Id ([int]$_.ProcessId) -ErrorAction Stop
  return $launcherProcess.SessionId -eq $sessionId
})
foreach ($launcherOwner in $launcherOwners) { Stop-Process -Id ([int]$launcherOwner.ProcessId) -Force -ErrorAction Stop }
Stop-Process -Id ([int]$normal[0].ProcessId) -Force -ErrorAction Stop
Unregister-ScheduledTask -TaskName $debugTask -Confirm:$false -ErrorAction SilentlyContinue
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument ('"{0}"' -f $debugLauncher) -WorkingDirectory 'C:\VEM\bringup'
$principalSpec = New-ScheduledTaskPrincipal -UserId $principal -LogonType InteractiveToken -RunLevel Limited
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
if ($process.SessionId -ne $sessionId) { throw 'debug machine.exe did not launch in active VEMKiosk session' }
$owner = Invoke-CimMethod -InputObject $machine -MethodName GetOwner -ErrorAction Stop
$observedPrincipal = "{0}\{1}" -f [string]$owner.Domain, [string]$owner.User
if ($observedPrincipal -cne $principal) { throw 'debug machine.exe principal differs from active VEMKiosk principal' }
$targets = @(Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json' -TimeoutSec 5 | Where-Object { [string]$_.url -match '^http://tauri\.localhost/#/' })
if ($targets.Count -ne 1 -or [string]::IsNullOrWhiteSpace([string]$targets[0].id)) { throw 'debug CDP must expose exactly one tauri target' }
[ordered]@{ ok = $true; prelaunch = [ordered]@{ processId = [int]$normalProcess.Id; executablePath = $machinePath; sessionId = [int]$sessionId; principal = $principal; owner = if ($null -ne $normalTaskInstance) { 'scheduled_task' } else { 'shell_launcher' } }; machine = [ordered]@{ processId = [int]$process.Id; executablePath = $machinePath; sessionId = [int]$sessionId; principal = $principal }; debugTarget = [ordered]@{ id = [string]$targets[0].id; url = [string]$targets[0].url }; debugTask = $debugTask; daemonRunningBefore = $true } | ConvertTo-Json -Compress -Depth 8
`.trim();
}

export function buildInstalledKioskSaleCleanupScript(prelaunch = {}) {
  const principal = String(prelaunch.principal ?? "");
  const sessionId = Number(prelaunch.sessionId);
  const expectedRoute = String(prelaunch.expectedRoute ?? "#/catalog");
  if (!principal || !Number.isSafeInteger(sessionId) || sessionId < 1) {
    throw new Error(
      "installed kiosk cleanup requires the saved active VEMKiosk principal and session",
    );
  }
  return String.raw`
$ErrorActionPreference = 'Stop'
$debugTask = '${INSTALLED_KIOSK_SALE_DEBUG_TASK}'
$normalTask = '${EXPECTED_MACHINE_UI_TASK_NAME}'
$debugLauncher = '${INSTALLED_KIOSK_SALE_DEBUG_LAUNCHER}'
$machinePath = '${INSTALLED_KIOSK_SALE_MACHINE_PATH}'
$principal = '${principal.replaceAll("'", "''")}'
$sessionId = ${sessionId}
$expectedRoute = '${expectedRoute.replaceAll("'", "''")}'
$allowedInitialRoutes = @($expectedRoute, '#/result') | Select-Object -Unique
Stop-ScheduledTask -TaskName $debugTask -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $debugTask -Confirm:$false -ErrorAction SilentlyContinue
$listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) { Stop-Process -Id ([int]$listener.OwningProcess) -Force -ErrorAction SilentlyContinue }
Get-Process -Name machine -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sessionId } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 300
if (@(Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue).Count -ne 0) { throw 'CDP listener remained after debug UI cleanup' }
$normalTaskInstance = Get-ScheduledTask -TaskName $normalTask -ErrorAction Stop
if (-not [bool]$normalTaskInstance.Settings.Enabled) { throw 'normal VEMMachineUI task is disabled during cleanup' }
$normalTaskPrincipal = [string]$normalTaskInstance.Principal.UserId
if ($normalTaskPrincipal -notmatch '(?i)VEMKiosk$') { throw 'normal VEMMachineUI task does not target VEMKiosk' }
if (-not (Test-Path -LiteralPath $debugLauncher -PathType Leaf)) { throw 'installed kiosk sale acceptance CDP launcher is missing' }
$acceptanceOverlayAction = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wscript.exe" -Argument ('"{0}"' -f $debugLauncher) -WorkingDirectory 'C:\VEM\bringup'
Set-ScheduledTask -TaskName $normalTask -Action $acceptanceOverlayAction | Out-Null
Start-ScheduledTask -TaskName $normalTask -ErrorAction Stop
$deadline = [DateTime]::UtcNow.AddSeconds(30)
$acceptanceTarget = $null
  do {
    $normal = @(Get-CimInstance Win32_Process -Filter "Name = 'machine.exe'" | Where-Object { $_.ExecutablePath -and ([IO.Path]::GetFullPath($_.ExecutablePath) -ieq $machinePath) })
    $listeners = @(Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue)
    if ($normal.Count -eq 1 -and $listeners.Count -eq 1) {
      $targets = @(Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json' -TimeoutSec 5 | Where-Object { [string]$_.url -match '^http://tauri\.localhost/#/' })
      if ($targets.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace([string]$targets[0].id)) {
        $acceptanceTarget = $targets[0]
        break
      }
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($normal.Count -ne 1 -or $listeners.Count -ne 1 -or $null -eq $acceptanceTarget) { throw 'acceptance overlay kiosk restoration did not retain exactly one CDP listener' }
  $normalProcess = Get-Process -Id ([int]$normal[0].ProcessId) -ErrorAction Stop
  $owner = Invoke-CimMethod -InputObject $normal[0] -MethodName GetOwner -ErrorAction Stop
  $observedPrincipal = "{0}\{1}" -f [string]$owner.Domain, [string]$owner.User
  if ($observedPrincipal -cne $principal -or [int]$normalProcess.SessionId -ne $sessionId) { throw 'acceptance overlay machine.exe principal or session differs from saved VEMKiosk owner' }
  $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$listeners[0].OwningProcess)" -ErrorAction Stop
  if ([int]$listenerProcess.SessionId -ne $sessionId) { throw 'acceptance overlay CDP listener session differs from VEMKiosk' }
  $cursor = $listenerProcess
  $listenerBound = $false
  for ($depth = 0; $depth -lt 32 -and $null -ne $cursor; $depth++) {
    if ([int]$cursor.ProcessId -eq [int]$normalProcess.Id) { $listenerBound = $true; break }
    $parentId = [int]$cursor.ParentProcessId
    if ($parentId -le 0 -or $parentId -eq [int]$cursor.ProcessId) { break }
    $cursor = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -ErrorAction SilentlyContinue
  }
  if (-not $listenerBound) { throw 'acceptance overlay CDP listener is not a machine.exe descendant' }
  $initialRoute = ([uri][string]$acceptanceTarget.url).Fragment
  if ([string]::IsNullOrWhiteSpace($initialRoute) -or $allowedInitialRoutes -notcontains $initialRoute) { throw 'acceptance overlay CDP route is outside the post-sale return policy' }
  $settledTarget = $acceptanceTarget
  $settledRoute = $initialRoute
  $resultAutoReturnObserved = $false
  if ($initialRoute -eq '#/result') {
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
      $targets = @(Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json' -TimeoutSec 5 | Where-Object { [string]$_.url -match '^http://tauri\.localhost/#/' })
      if ($targets.Count -eq 1 -and -not [string]::IsNullOrWhiteSpace([string]$targets[0].id)) {
        $candidateRoute = ([uri][string]$targets[0].url).Fragment
        if ($candidateRoute -eq $expectedRoute) {
          $settledTarget = $targets[0]
          $settledRoute = $candidateRoute
          $resultAutoReturnObserved = $true
          break
        }
      }
      Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if (-not $resultAutoReturnObserved) { throw 'ResultView did not settle to the post-sale return route in the acceptance overlay' }
  }
  if ($settledRoute -ne $expectedRoute) { throw 'acceptance overlay CDP did not settle to the expected normal route' }
  $normalTaskInstance = Get-ScheduledTask -TaskName $normalTask -ErrorAction Stop
  $taskAction = @($normalTaskInstance.Actions | Select-Object -First 1)
  if ($taskAction.Count -ne 1 -or [string]$taskAction[0].Arguments -notmatch [regex]::Escape($debugLauncher)) { throw 'VEMMachineUI task action is not bound to the acceptance CDP launcher' }
  $routeEvidence = [ordered]@{ source = 'acceptance_overlay_cdp'; initialTargetId = [string]$acceptanceTarget.id; initialTargetUrl = [string]$acceptanceTarget.url; initialRoute = $initialRoute; allowedInitialRoutes = $allowedInitialRoutes; settledTargetId = [string]$settledTarget.id; settledTargetUrl = [string]$settledTarget.url; settledRoute = $settledRoute; resultAutoReturnObserved = $resultAutoReturnObserved; settledWithAcceptanceOverlay = $true; processId = [int]$normalProcess.Id; principal = $observedPrincipal; sessionId = [int]$normalProcess.SessionId }
$cdpListenerCount = @((Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue)).Count
if ($cdpListenerCount -ne 1) { throw 'acceptance overlay kiosk restoration did not retain exactly one CDP listener' }
$daemon = Get-Service -Name 'VemVendingDaemon' -ErrorAction Stop
if ([string]$daemon.Status -ne 'Running') { throw 'daemon stopped during installed kiosk sale acceptance' }
[ordered]@{ ok = $true; restored = 'acceptance_overlay_cdp_task_after_settled_route'; overlayScope = 'disposable_acceptance_overlay'; normal = [ordered]@{ processId = [int]$normalProcess.Id; principal = $observedPrincipal; sessionId = [int]$normalProcess.SessionId; machineCount = $normal.Count; task = [ordered]@{ name = $normalTask; exists = $true; enabled = [bool]$normalTaskInstance.Settings.Enabled; runAsUser = $normalTaskPrincipal; acceptanceOverlayCdp = $true; launcher = $debugLauncher }; acceptanceOverlayCdp = $true; cdpListenerCount = $cdpListenerCount; cdpListenerProcessId = [int]$listenerProcess.ProcessId; cdpListenerSessionId = [int]$listenerProcess.SessionId; cdpMachineAncestorProcessId = [int]$normalProcess.Id; cdpTargetId = [string]$settledTarget.id; route = $settledRoute; routeEvidence = $routeEvidence }; daemonRunning = $true; cdpListenerCount = $cdpListenerCount } | ConvertTo-Json -Compress -Depth 8
`.trim();
}

export function runInstalledKioskSaleRemoteScript(options, script) {
  const ssh = buildSshCommand(options);
  const result = spawnSync(
    ssh[0],
    [...ssh.slice(1), buildStdinPowerShellCommand()],
    {
      input: `${script}\n`,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: nonQueryChildEnvironment(),
    },
  );
  let output = null;
  try {
    output = JSON.parse(result.stdout || "null");
  } catch {}
  if (result.status !== 0 || output?.ok !== true) {
    throw new Error(
      result.stderr ||
        result.stdout ||
        "installed kiosk sale remote operation failed",
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
        selector: '[data-test="catalog-category"]',
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
  const cleanBaseFactoryAcceptance =
    options.cleanBaseEvidence ?? options.cleanBaseFactoryAcceptance ?? null;
  const approvedPreclaimBaseReport = `${evidenceRoot}/approved-preclaim-base-response.json`;
  const runtimeAcceptanceReport = `${evidenceRoot}/runtime-acceptance-response.json`;
  const postSaleRuntimeAcceptanceReport = `${evidenceRoot}/post-sale-runtime-acceptance-response.json`;
  const saleFlowReport = `${evidenceRoot}/simulated-hardware-sale-flow-response.json`;
  const serialConformanceReport = `${evidenceRoot}/serial-com-scanner-sale-conformance.json`;
  const customerUiSaleNormalRoot = `${evidenceRoot}/installed-kiosk-sale-normal`;
  const customerUiSaleCompetitionRoot = `${evidenceRoot}/installed-kiosk-sale-route-competition`;
  const customerUiSaleNormalReport = `${customerUiSaleNormalRoot}/report.json`;
  const customerUiSaleCompetitionReport = `${customerUiSaleCompetitionRoot}/report.json`;
  const approvedPreclaimOptions = options.factoryGuestEndpointJson
    ? { ...options, remote: undefined, sshPort: undefined }
    : options;
  const approvedPreclaimBaseCommand = buildAcceptanceScriptCommand(
    "factory-preclaim-verify",
    { ...approvedPreclaimOptions, runId, machineCode, platformTarget },
    ["--out", approvedPreclaimBaseReport],
  );
  if (options.factoryGuestEndpointJson) {
    approvedPreclaimBaseCommand.push(
      "--factory-guest-endpoint-json",
      options.factoryGuestEndpointJson,
    );
  }
  const runtimeCommand = buildAcceptanceScriptCommand(
    "runtime-acceptance",
    { ...options, runId, machineCode, platformTarget },
    ["--out", runtimeAcceptanceReport],
  );
  const postSaleRuntimeCommand = buildAcceptanceScriptCommand(
    "runtime-acceptance",
    { ...options, runId, machineCode, platformTarget },
    ["--out", postSaleRuntimeAcceptanceReport],
  );
  const salePrepareCommand = buildAcceptanceScriptCommand(
    "simulated-hardware-sale-flow",
    { ...options, runId, machineCode, platformTarget },
    [
      "--ephemeral-platform-evidence",
      ephemeralPlatformEvidence,
      "--sale-phase",
      "prepare",
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
      "--approved-runtime-base",
      options.approvedRuntimeBase ?? "runner-approved-runtime-base-required",
      "--profile",
      profile,
      ...(alreadyClaimed ? ["--already-claimed"] : []),
      "--out",
      out,
    ];
    if (options.scannerCodeFile) {
      command.push("--scanner-code-file", options.scannerCodeFile);
    }
    if (options.factoryGuestEndpointJson) {
      command.push(
        "--factory-guest-endpoint-json",
        options.factoryGuestEndpointJson,
        "--expected-testbed-user",
        options.expectedTestbedUser ?? DEFAULT_CONTROLLED_MAINTENANCE_USER,
      );
    } else {
      command.push(
        "--remote",
        options.remote ?? DEFAULT_CONTROLLED_MAINTENANCE_REMOTE,
      );
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
  const installedKioskSaleCompetitionCommand = buildInstalledKioskSaleCommand(
    "vm-route-competition",
    customerUiSaleCompetitionReport,
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
          "prepare",
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
          "prepare",
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
          "prepare",
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
    "--approved-runtime-base",
    options.approvedRuntimeBase ?? "runner-approved-runtime-base-required",
    "--lifecycle-reference",
    `vm-lifecycle://${runId.toLowerCase()}.runtime-acceptance`,
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
  if (options.maintenanceEndpointPolicy !== undefined) {
    if (options.maintenanceRelaySession === undefined)
      throw new Error(
        "VM runtime serial conformance endpoint policy requires a maintenance relay session",
      );
  }
  if (options.maintenanceRelaySession !== undefined) {
    saleFlowCommand.splice(
      saleFlowCommand.indexOf("--out"),
      0,
      "--maintenance-relay-session-json",
      JSON.stringify(options.maintenanceRelaySession),
    );
    if (options.maintenanceEndpointPolicy !== undefined)
      saleFlowCommand.splice(
        saleFlowCommand.indexOf("--out"),
        0,
        "--maintenance-endpoint-policy-json",
        JSON.stringify(options.maintenanceEndpointPolicy),
      );
  }

  const cleanBaseStep = cleanBaseFactoryAcceptance
    ? [
        {
          name: "clean-base factory preparation acceptance",
          mode: "clean-base-factory-acceptance",
          status: "planned",
          command: [
            process.execPath,
            "scripts/testbed/win10-vem-e2e.mjs",
            "--mode",
            "validate-clean-base-evidence",
            "--clean-base-evidence",
            cleanBaseFactoryAcceptance,
          ],
          report: cleanBaseFactoryAcceptance,
          blocksOnFailure: false,
          evidenceContract: {
            schemaVersion: CLEAN_BASE_FACTORY_ACCEPTANCE_REPORT_SCHEMA_VERSION,
            kind: CLEAN_BASE_FACTORY_ACCEPTANCE_KIND,
            requiredAssertions: [...REQUIRED_CLEAN_BASE_ASSERTIONS],
          },
        },
      ]
    : [];

  return {
    schemaVersion: "vm-runtime-acceptance-plan/v1",
    mode: "vm-runtime-acceptance",
    runId,
    target: {
      testbedName: "win10-vem-e2e",
      machineCode,
      machineCodePrefix,
      platformTarget,
      remote: options.remote ?? DEFAULT_CONTROLLED_MAINTENANCE_REMOTE,
    },
    evidenceRoot,
    artifacts: {
      source: "approved-preclaim-base",
      report: reportPath,
      logsRoot,
      screenshotsRoot,
      sessionsRoot,
      ephemeralPlatformEvidence,
      cleanBaseFactoryAcceptance,
      approvedPreclaimBase: approvedPreclaimBaseReport,
      runtimeAcceptance: runtimeAcceptanceReport,
      postSaleRuntimeAcceptance: postSaleRuntimeAcceptanceReport,
      simulatedHardwareSaleFlow: saleFlowReport,
      serialConformance: serialConformanceReport,
      failureMatrix: failureMatrixArtifacts,
      customerUiSaleNormal: customerUiSaleNormalReport,
      customerUiSaleRouteCompetition: customerUiSaleCompetitionReport,
      customerUiSale: customerUiSaleCompetitionReport,
    },
    serialRunnerExpectedPublicKey:
      options.expectedSerialRunnerPublicKey ?? null,
    expectedAdapterIdentity:
      process.env.VEM_VM_HOST_EXPECTED_ADAPTER_IDENTITY ?? null,
    ci: {
      entrypoint:
        "node scripts/testbed/win10-vem-e2e.mjs --mode vm-runtime-acceptance",
      requiredSecrets: [],
      requiredCredentials: ["approved-preclaim-base", "certificate-only-ssh"],
      requiredEnvironment: ["PAYMENT_MOCK_ENABLED=true"],
      githubActionsScope: "future manual runtime gate",
    },
    readinessLevels: {
      approvedPreclaimBase: "asserted_by_preclaim_step",
      cleanBasePreparationAcceptance: cleanBaseFactoryAcceptance
        ? "asserted_by_clean_base_step"
        : "not_asserted",
      runtimeReady: "asserted_by_runtime_acceptance_step",
      simulatedHardwareReady: "asserted_by_sale_flow_step",
      sellReady: "not_asserted",
    },
    steps: [
      ...cleanBaseStep,
      {
        name: "approved preclaim base verification",
        mode: "factory-preclaim-verify",
        status: "planned",
        command: approvedPreclaimBaseCommand,
        report: approvedPreclaimBaseReport,
        blocksOnFailure: true,
      },
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
        name: "simulated hardware sale flow",
        mode: "simulated-hardware-sale-flow",
        status: "planned",
        command: saleFlowCommand,
        ephemeralPlatformEvidence,
        report: saleFlowReport,
        blocksOnFailure: true,
        requiresEphemeralDatabase: true,
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
        name: "post-sale runtime acceptance",
        mode: "runtime-acceptance",
        status: "planned",
        command: postSaleRuntimeCommand,
        report: postSaleRuntimeAcceptanceReport,
        blocksOnFailure: true,
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

export function sanitizeFactoryPreclaimReport(report) {
  return sanitizeReportValue(report);
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

function normalizeDeliveryEvidenceItems(items) {
  return Array.isArray(items)
    ? items
        .filter((item) => item !== null && item !== undefined)
        .map((item) =>
          typeof item === "string" ? { path: item } : sanitizeReportValue(item),
        )
    : [];
}

function deliveryEvidenceIndex(index, missingReason, itemFieldName) {
  if (index && typeof index === "object" && !Array.isArray(index)) {
    const items = normalizeDeliveryEvidenceItems(
      Array.isArray(index[itemFieldName]) ? index[itemFieldName] : index.items,
    );
    const status =
      typeof index.status === "string"
        ? index.status
        : items.length > 0
          ? "indexed"
          : "missing";
    return {
      ...sanitizeReportValue(index),
      status,
      missingReason:
        items.length > 0 ? null : (index.missingReason ?? missingReason),
    };
  }
  const normalizedItems = normalizeDeliveryEvidenceItems(index);
  return {
    status: normalizedItems.length > 0 ? "indexed" : "missing",
    missingReason: normalizedItems.length > 0 ? null : missingReason,
    [itemFieldName]: normalizedItems,
  };
}

function deliveryReadinessAssertion(status) {
  return {
    status: status ?? "missing",
    asserted: status === "passed",
  };
}

function cleanBasePreparationLogs(cleanBaseAcceptance) {
  const evidence = cleanBaseAcceptance.evidence ?? {};
  const logs = [];
  if (evidence.preparationOutput) {
    logs.push({
      kind: "factory-runtime-preparation",
      path: evidence.preparationOutput,
    });
  }
  if (evidence.verificationAction) {
    logs.push({
      kind: "factory-runtime-verification-action",
      path: evidence.verificationAction,
    });
  }
  for (const action of Array.isArray(evidence.actions)
    ? evidence.actions
    : []) {
    if (action?.outputPath) {
      logs.push({
        kind: String(action.name ?? "factory-action-output"),
        path: action.outputPath,
        status: action.status ?? "unknown",
      });
    }
  }
  return {
    status: logs.length > 0 ? "indexed" : "missing",
    missingReason: logs.length > 0 ? null : "no_preparation_logs",
    logs: sanitizeReportValue(logs),
  };
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function validateFactoryImageDeliveryUnitCleanBaseEvidence(
  cleanBaseAcceptance,
) {
  const baseValidation =
    validateCleanBaseFactoryAcceptanceEvidence(cleanBaseAcceptance);
  if (baseValidation.status !== "passed") {
    return baseValidation;
  }

  const missingEvidence = [];
  const evidence = cleanBaseAcceptance.evidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    missingEvidence.push("evidence");
  } else {
    if (evidence.factoryProfile !== cleanBaseAcceptance.factoryProfile) {
      missingEvidence.push("evidence.factoryProfile");
    }
    if (!isNonEmptyString(evidence.preparationOutput)) {
      missingEvidence.push("evidence.preparationOutput");
    }
    if (!isNonEmptyString(evidence.verificationAction)) {
      missingEvidence.push("evidence.verificationAction");
    }
    if (!isNonEmptyString(evidence.verifierEvidence)) {
      missingEvidence.push("evidence.verifierEvidence");
    }
    const verification = evidence.factoryRuntimeVerification;
    if (
      !verification ||
      typeof verification !== "object" ||
      Array.isArray(verification)
    ) {
      missingEvidence.push("evidence.factoryRuntimeVerification");
    } else {
      if (verification.ok !== true) {
        missingEvidence.push("evidence.factoryRuntimeVerification.ok");
      }
      if (!isNonEmptyString(verification.manifestPath)) {
        missingEvidence.push(
          "evidence.factoryRuntimeVerification.manifestPath",
        );
      }
      const manifest = verification.checks?.manifest;
      if (
        !manifest ||
        typeof manifest !== "object" ||
        Array.isArray(manifest)
      ) {
        missingEvidence.push(
          "evidence.factoryRuntimeVerification.checks.manifest",
        );
      } else {
        for (const field of [
          "schemaVersion",
          "factoryProfile",
          "hardwareMode",
          "hardwareModel",
          "topologyIdentity",
          "topologyVersion",
        ]) {
          if (!isNonEmptyString(manifest[field])) {
            missingEvidence.push(
              `evidence.factoryRuntimeVerification.checks.manifest.${field}`,
            );
          }
        }
        if (manifest.factoryProfile !== cleanBaseAcceptance.factoryProfile) {
          missingEvidence.push(
            "evidence.factoryRuntimeVerification.checks.manifest.factoryProfile mismatch",
          );
        }
      }
    }
  }

  if (missingEvidence.length > 0) {
    return cleanBaseValidationFailure(
      "Factory Image Delivery Unit requires completed prep run evidence",
      { missingEvidence },
    );
  }

  return baseValidation;
}

function readCleanBaseSiblingEvidenceIndex(cleanBaseAcceptancePath, directory) {
  if (!cleanBaseAcceptancePath) {
    return null;
  }
  return readJsonIfPresent(
    join(dirname(cleanBaseAcceptancePath), directory, "index.json"),
  );
}

export function buildFactoryImageDeliveryUnitReport({
  cleanBaseAcceptance,
  cleanBaseAcceptancePath,
  reportPath = null,
  screenshots = null,
  sessions = null,
} = {}) {
  const validation =
    validateFactoryImageDeliveryUnitCleanBaseEvidence(cleanBaseAcceptance);
  if (validation.status !== "passed") {
    throw new Error(
      `Factory Image Delivery Unit requires completed clean-base acceptance: ${validation.message}`,
    );
  }

  const evidence = cleanBaseAcceptance.evidence ?? {};
  const factoryRuntimeVerification =
    evidence.factoryRuntimeVerification ?? null;
  const manifestPath =
    factoryRuntimeVerification?.manifestPath ??
    evidence.factoryManifest ??
    "C:\\ProgramData\\VEM\\factory\\factory-runtime-manifest.json";
  const manifest = factoryRuntimeVerification?.checks?.manifest ?? null;
  const readiness = cleanBaseAcceptance.readiness ?? {};
  const screenshotEvidence =
    screenshots ??
    evidence.screenshots ??
    readCleanBaseSiblingEvidenceIndex(cleanBaseAcceptancePath, "screenshots");
  const sessionEvidence =
    sessions ??
    evidence.sessions ??
    readCleanBaseSiblingEvidenceIndex(cleanBaseAcceptancePath, "sessions");
  const report = {
    schemaVersion: FACTORY_IMAGE_DELIVERY_UNIT_REPORT_SCHEMA_VERSION,
    kind: FACTORY_IMAGE_DELIVERY_UNIT_KIND,
    runId: cleanBaseAcceptance.runId ?? null,
    result: cleanBaseAcceptance.result,
    ok: cleanBaseAcceptance.ok === true,
    reportPath,
    imageSource: cleanBaseAcceptance.source,
    factoryProfile: cleanBaseAcceptance.factoryProfile,
    declaredBuildInputs: {
      source: cleanBaseAcceptance.source,
      artifacts: {
        daemonSha256: cleanBaseAcceptance.artifacts?.daemonSha256,
        machineUiSha256: cleanBaseAcceptance.artifacts?.machineUiSha256,
        webView2Sidecar: cleanBaseAcceptance.artifacts?.webView2Sidecar,
      },
      factoryManifest: {
        path: manifestPath,
        schemaVersion: manifest?.schemaVersion ?? null,
        factoryProfile: manifest?.factoryProfile ?? null,
        hardwareMode: manifest?.hardwareMode ?? null,
        hardwareModel: manifest?.hardwareModel ?? null,
        topologyIdentity: manifest?.topologyIdentity ?? null,
        topologyVersion: manifest?.topologyVersion ?? null,
      },
      factoryWindowsBaselinePolicy:
        cleanBaseAcceptance.factoryWindowsBaselinePolicy,
    },
    artifacts: {
      daemonSha256: cleanBaseAcceptance.artifacts?.daemonSha256,
      machineUiSha256: cleanBaseAcceptance.artifacts?.machineUiSha256,
      source: cleanBaseAcceptance.artifacts?.source ?? "unknown",
      webView2Sidecar: cleanBaseAcceptance.artifacts?.webView2Sidecar ?? null,
    },
    factoryManifest: {
      path: manifestPath,
      factoryProfile: manifest?.factoryProfile ?? null,
      summary: manifest,
    },
    preparationLogs: cleanBasePreparationLogs(cleanBaseAcceptance),
    verifierEvidence: {
      status: evidence.verifierEvidence ? "indexed" : "missing",
      missingReason: evidence.verifierEvidence
        ? null
        : "no_verifier_evidence_path",
      factoryRuntimeVerification: {
        path: evidence.verifierEvidence ?? null,
        summary: factoryRuntimeVerification
          ? {
              ok: factoryRuntimeVerification.ok ?? null,
              manifestPath: factoryRuntimeVerification.manifestPath ?? null,
              failures: factoryRuntimeVerification.failures ?? [],
            }
          : null,
      },
      verificationAction: evidence.verificationAction
        ? { path: evidence.verificationAction }
        : null,
    },
    cleanBaseAcceptanceReport: {
      path: cleanBaseAcceptancePath ?? null,
      schemaVersion: cleanBaseAcceptance.schemaVersion,
      kind: cleanBaseAcceptance.kind,
      result: cleanBaseAcceptance.result,
      ok: cleanBaseAcceptance.ok === true,
    },
    evidenceReview: {
      screenshots: deliveryEvidenceIndex(
        screenshotEvidence,
        "no_screenshot_artifacts",
        "screenshots",
      ),
      sessions: deliveryEvidenceIndex(
        sessionEvidence,
        "no_session_evidence",
        "sessions",
      ),
    },
    readiness: {
      cleanBasePreparationAcceptance: deliveryReadinessAssertion(
        readiness.cleanBasePreparationAcceptance,
      ),
      runtimeReady: deliveryReadinessAssertion(readiness.runtimeReady),
      simulatedHardwareReady: deliveryReadinessAssertion(
        readiness.simulatedHardwareReady,
      ),
      sellReady: deliveryReadinessAssertion(readiness.sellReady),
    },
    diagnostics: sanitizeReportValue(cleanBaseAcceptance.diagnostics ?? []),
  };

  return sanitizeReportValue(report);
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

function evaluateCleanBasePreparationStep(step) {
  if (!step) {
    return {
      status: "not_asserted",
      asserted: false,
      diagnostic: null,
      validation: null,
    };
  }

  const validation = validateCleanBaseFactoryAcceptanceEvidence(step.parsed);
  if (step.status === "passed" && validation.status === "passed") {
    return {
      status: "passed",
      asserted: true,
      diagnostic: null,
      validation,
    };
  }

  const status = step.status === "blocked" ? "blocked" : "failed";
  const validationMessage =
    validation.status === "passed"
      ? `${step.name} ${step.status}`
      : validation.message;
  return {
    status,
    asserted: false,
    validation,
    diagnostic: {
      code:
        validation.status === "passed"
          ? `${step.mode}_${status}`
          : `${step.mode}_invalid`,
      message:
        validation.status === "passed"
          ? `${step.name} ${status}`
          : `${step.name} invalid`,
      detail: validationMessage,
    },
  };
}

function evaluateApprovedPreclaimBaseStep(step) {
  const report = step?.parsed;
  const validEvidence =
    report?.ok === true &&
    report?.schemaVersion === "factory-preclaim-verification/v1" &&
    report?.kind === "factory-preclaim-verification";
  if (step?.status === "passed" && validEvidence) {
    return { status: "passed", asserted: true, diagnostic: null };
  }
  const status = step?.status === "blocked" ? "blocked" : "failed";
  const evidenceInvalid = step?.status === "passed" && !validEvidence;
  return {
    status,
    asserted: false,
    diagnostic: {
      code: evidenceInvalid
        ? "factory-preclaim-verify_invalid"
        : `factory-preclaim-verify_${status}`,
      message: evidenceInvalid
        ? "approved preclaim base verification returned invalid evidence"
        : "approved preclaim base verification failed",
      detail: evidenceInvalid
        ? "expected ok=true and factory-preclaim-verification/v1 schema and kind"
        : (step?.error ?? "approved preclaim base verification is missing"),
    },
  };
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
  const exactOnce = report?.correlation?.exactOnce;
  const observations = platform?.observations;
  const reservation = platform?.reservation;
  if (
    !rendered?.orderId ||
    !rendered?.paymentId ||
    !rendered?.orderNo ||
    !rendered?.commandId ||
    rendered.orderId !== platform?.orderId ||
    rendered.paymentId !== platform?.paymentId ||
    rendered.orderNo !== platform?.orderNo ||
    rendered.commandId !== platform?.commandId ||
    platform?.stockDelta !== -1 ||
    platform?.status !== "accepted" ||
    exactOnce?.orderCount !== 1 ||
    exactOnce.paymentCount !== 1 ||
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
  return {
    status: diagnostics.length === 0 ? "passed" : "failed",
    asserted: diagnostics.length === 0,
    diagnostics,
    evidence: { customerUiSale: report ?? null },
  };
}

export function buildVmRuntimeAcceptanceReport({ plan, steps }) {
  const stepMap = new Map(steps.map((step) => [step.name, step]));
  const cleanBase = stepMap.get("clean-base factory preparation acceptance");
  const approvedPreclaimBase = stepMap.get(
    "approved preclaim base verification",
  );
  const ephemeral = stepMap.get("ephemeral platform setup");
  const runtime = stepMap.get("runtime acceptance");
  const saleFlow = stepMap.get("simulated hardware sale flow");
  const saleNormal = stepMap.get("installed kiosk sale normal");
  const saleCompetition = stepMap.get("installed kiosk sale route competition");
  const postSaleRuntime = stepMap.get("post-sale runtime acceptance");
  const simulatedHardwareEvidence = evaluateSimulatedHardwareSerialEvidence({
    saleFlow: saleFlow?.parsed,
    serialConformance: saleFlow?.serialConformance,
    expectedRunnerPublicKey: plan.serialRunnerExpectedPublicKey,
    expectedAdapterIdentity: plan.expectedAdapterIdentity,
  });
  const normalSaleEvidence = evaluateInstalledKioskSaleEvidence(
    saleNormal,
    plan,
  );
  const competitionSaleEvidence = evaluateInstalledKioskSaleEvidence(
    saleCompetition,
    plan,
  );
  const installedKioskEvidence = {
    status:
      normalSaleEvidence.status === "passed" &&
      competitionSaleEvidence.status === "passed"
        ? "passed"
        : "failed",
    asserted:
      normalSaleEvidence.asserted === true &&
      competitionSaleEvidence.asserted === true,
    diagnostics: [
      ...normalSaleEvidence.diagnostics,
      ...competitionSaleEvidence.diagnostics,
    ],
    evidence: {
      normal: normalSaleEvidence.evidence,
      routeCompetition: competitionSaleEvidence.evidence,
    },
  };
  const cleanBaseEvaluation = evaluateCleanBasePreparationStep(cleanBase);
  const approvedPreclaimBaseEvaluation =
    evaluateApprovedPreclaimBaseStep(approvedPreclaimBase);
  const diagnostics = [
    ...(cleanBaseEvaluation.diagnostic ? [cleanBaseEvaluation.diagnostic] : []),
    ...(approvedPreclaimBaseEvaluation.diagnostic
      ? [approvedPreclaimBaseEvaluation.diagnostic]
      : []),
    ...simulatedHardwareEvidence.diagnostics,
    ...installedKioskEvidence.diagnostics,
    ...steps
      .filter((step) => step.status !== "passed")
      .filter((step) => step !== cleanBase && step !== approvedPreclaimBase)
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
    preparationVerifierStatus: approvedPreclaimBaseEvaluation.status,
    bringUpStateProgression: {
      cleanBasePreparationAcceptance: cleanBaseEvaluation.status,
      approvedPreclaimBase: approvedPreclaimBaseEvaluation.status,
      ephemeralPlatformSetup: ephemeral?.status ?? "missing",
      runtimeAcceptance: runtime?.status ?? "missing",
      simulatedHardwareSaleFlow: saleFlow?.status ?? "missing",
      installedKioskSaleNormal: saleNormal?.status ?? "missing",
      installedKioskSaleRouteCompetition: saleCompetition?.status ?? "missing",
      postSaleRuntimeAcceptance: postSaleRuntime?.status ?? "missing",
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
      routeCompetition: {
        status: saleCompetition?.status ?? "missing",
        evidencePath: plan.artifacts.customerUiSaleRouteCompetition,
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
      approvedPreclaimBase: {
        status: approvedPreclaimBaseEvaluation.status,
        asserted: approvedPreclaimBaseEvaluation.asserted,
      },
      cleanBasePreparationAcceptance: {
        status: cleanBaseEvaluation.status,
        asserted: cleanBaseEvaluation.asserted,
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
      "VM runtime acceptance requires --scanner-code-file and --approved-runtime-base",
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
    if (options.factoryMediaAdmission) {
      report.factoryMediaAdmission = structuredClone(
        options.factoryMediaAdmission,
      );
    }
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

function runFactoryImageDeliveryUnit(options) {
  if (!options.cleanBaseEvidence) {
    throw new Error(
      "factory-image-delivery-unit requires --clean-base-evidence",
    );
  }
  const cleanBaseAcceptance = JSON.parse(
    readFileSync(options.cleanBaseEvidence, "utf8"),
  );
  const reportPath =
    options.out ??
    `${dirname(options.cleanBaseEvidence)}/${FACTORY_IMAGE_DELIVERY_UNIT_FILE_NAME}`;
  const report = buildFactoryImageDeliveryUnitReport({
    cleanBaseAcceptance,
    cleanBaseAcceptancePath: options.cleanBaseEvidence,
    reportPath,
  });
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
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

export function buildFactoryPreclaimVerificationScript(options = {}) {
  const runId = sanitizeRunId(options.runId);
  const machineCode = assertTestbedMachineCode(options.machineCode);
  const verifierPath = "C:\\VEM\\bringup\\scripts\\verify-factory-runtime.ps1";
  const verifierEvidencePath = `C:\\Windows\\Temp\\vem-factory-preclaim-${runId}.json`;
  const machineConfigPath =
    "C:\\ProgramData\\VEM\\vending-daemon\\machine-config.json";
  const oobeStatusPath =
    "C:\\ProgramData\\VEM\\factory\\oobe-bootstrap-status.json";
  const cleanupStatusPath =
    "C:\\ProgramData\\VEM\\factory\\oobe-cleanup-status.json";
  const deprecatedOobeAnswerPath =
    "C:\\ProgramData\\VEM\\factory\\oobe-unattend.xml";
  const retainedKioskAutologonHandoffPath =
    "C:\\ProgramData\\VEM\\factory\\oobe-kiosk-autologon-password";
  const identityPaths = [
    "C:\\ProgramData\\VEM\\provisioning\\machine-profile.json",
    "C:\\ProgramData\\VEM\\provisioning\\provisioning-profile.json",
  ];
  return `
$ErrorActionPreference = 'Stop'
$verifierPath = ${psString(verifierPath)}
$verifierEvidencePath = ${psString(verifierEvidencePath)}
$machineConfigPath = ${psString(machineConfigPath)}
$oobeStatusPath = ${psString(oobeStatusPath)}
$cleanupStatusPath = ${psString(cleanupStatusPath)}
$deprecatedOobeAnswerPath = ${psString(deprecatedOobeAnswerPath)}
$retainedKioskAutologonHandoffPath = ${psString(retainedKioskAutologonHandoffPath)}
$identityPaths = ${psString(JSON.stringify(identityPaths))} | ConvertFrom-Json
if (-not (Test-Path -LiteralPath $verifierPath -PathType Leaf)) {
  throw "Factory ISO verifier is missing: $verifierPath"
}
function ConvertTo-BootIdentity($Value) {
  if ($null -eq $Value -or [string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
  return ([DateTime]$Value).ToUniversalTime().ToString('o')
}

try {
  $oobeDeadline = (Get-Date).AddMinutes(30)
  do {
    $oobeStatus = if (Test-Path -LiteralPath $oobeStatusPath -PathType Leaf) {
      Get-Content -LiteralPath $oobeStatusPath -Raw | ConvertFrom-Json -ErrorAction Stop
    } else { $null }
    $cleanupStatus = if (Test-Path -LiteralPath $cleanupStatusPath -PathType Leaf) {
      Get-Content -LiteralPath $cleanupStatusPath -Raw | ConvertFrom-Json -ErrorAction Stop
    } else { $null }
    $setupState = Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\Setup' -ErrorAction Stop
    $cleanupTask = Get-ScheduledTask -TaskName 'VEMFactoryOobeCleanup' -ErrorAction SilentlyContinue
    $personalizationVolumes = @(Get-Volume -FileSystemLabel 'VEM_PERSONALIZATION' -ErrorAction SilentlyContinue)
    $retainedKioskAutologonHandoffPresent = Test-Path -LiteralPath $retainedKioskAutologonHandoffPath
    $currentBoot = Get-CimInstance Win32_OperatingSystem -ErrorAction Stop
    $currentBootIdentity = ConvertTo-BootIdentity $currentBoot.LastBootUpTime
    $console = Get-CimInstance Win32_ComputerSystem -ErrorAction Stop
    $consoleUser = [string]$console.UserName
    $consoleUserName = if ([string]::IsNullOrWhiteSpace($consoleUser)) { $null } else { $consoleUser.Split('\\')[-1] }
    $activeVemKioskConsoleSession = $consoleUserName -ceq 'VEMKiosk'
    $rebootOriginBootIdentity = if ($null -ne $cleanupStatus) { ConvertTo-BootIdentity $cleanupStatus.rebootOriginBootIdentity } else { $null }
    $completedBootIdentity = if ($null -ne $cleanupStatus) { ConvertTo-BootIdentity $cleanupStatus.completedBootIdentity } else { $null }
    $completedBootProofIsPostReboot =
      -not [string]::IsNullOrWhiteSpace($completedBootIdentity) -and
      $completedBootIdentity -cne $rebootOriginBootIdentity
    $currentBootIsPostReboot =
      -not [string]::IsNullOrWhiteSpace([string]$currentBootIdentity) -and
      $currentBootIdentity -cne $rebootOriginBootIdentity
    $cleanupComplete =
      $null -ne $cleanupStatus -and
      $cleanupStatus.schemaVersion -ceq 'vem-factory-oobe-cleanup-status/v1' -and
      $cleanupStatus.phase -ceq 'complete' -and
      -not [string]::IsNullOrWhiteSpace($rebootOriginBootIdentity) -and
      $completedBootProofIsPostReboot -and
      $currentBootIsPostReboot -and
      [string]$cleanupStatus.kioskConsoleSession.user -ceq 'VEMKiosk'
    $oobeComplete =
      $null -ne $oobeStatus -and
      $oobeStatus.state -eq 'succeeded' -and
      $oobeStatus.stage -eq 'complete' -and
      [int]$setupState.OOBEInProgress -eq 0 -and
      [int]$setupState.SystemSetupInProgress -eq 0 -and
      [int]$setupState.SetupType -eq 0 -and
    [string]::IsNullOrWhiteSpace([string]$setupState.UnattendFile) -and
    -not (Test-Path -LiteralPath $deprecatedOobeAnswerPath) -and
      -not $retainedKioskAutologonHandoffPresent -and
      $null -eq (Get-LocalUser -Name 'VEMOobeBootstrap' -ErrorAction SilentlyContinue) -and
      $null -eq $cleanupTask -and
      $personalizationVolumes.Count -eq 0 -and
      $cleanupComplete -and
      $activeVemKioskConsoleSession
    if ($oobeComplete) { break }
    Start-Sleep -Seconds 10
  } while ((Get-Date) -lt $oobeDeadline)

  $factoryVerificationJson = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $verifierPath -EvidencePath $verifierEvidencePath
  $factoryVerifierExit = $LASTEXITCODE
  $factoryVerification = $factoryVerificationJson | ConvertFrom-Json
  $identityFiles = @($identityPaths | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })
  $machineConfig = [ordered]@{
    exists = Test-Path -LiteralPath $machineConfigPath -PathType Leaf
    structurallyValid = $false
    unclaimed = $false
    identityFields = @()
    credentialFields = @()
  }
  if ($machineConfig.exists) {
    try {
      $machineConfigDocument = Get-Content -LiteralPath $machineConfigPath -Raw | ConvertFrom-Json -ErrorAction Stop
      $machineCodeProperty = $machineConfigDocument.PSObject.Properties['machineCode']
      $machineConfig.structurallyValid =
        $machineConfigDocument -is [pscustomobject] -and
        $null -ne $machineCodeProperty -and
        $null -eq $machineCodeProperty.Value

      $machineConfig.identityFields = @(
        'machineCode', 'machineId', 'machineName', 'machineStatus',
        'machineLocationLabel', 'mqttClientId', 'runtimeEndpoints',
        'hardwareProfile', 'paymentCapability', 'provisioningMetadata' |
          Where-Object {
            $property = $machineConfigDocument.PSObject.Properties[$_]
            $null -ne $property -and
              $null -ne $property.Value -and
              ($property.Value -isnot [string] -or -not [string]::IsNullOrWhiteSpace($property.Value))
          }
      )
      $machineConfig.credentialFields = @(
        'machineSecret', 'mqttSigningSecret', 'mqttPassword', 'mqttUsername' |
          Where-Object {
            $property = $machineConfigDocument.PSObject.Properties[$_]
            $null -ne $property -and
              $null -ne $property.Value -and
              ($property.Value -isnot [string] -or -not [string]::IsNullOrWhiteSpace($property.Value))
          }
      ) + @(
        'machineSecretConfigured', 'mqttSigningSecretConfigured', 'mqttPasswordConfigured' |
          Where-Object {
            $property = $machineConfigDocument.PSObject.Properties[$_]
            $null -ne $property -and $property.Value -eq $true
          }
      )
      $machineConfig.unclaimed =
        $machineConfig.structurallyValid -and
        $machineConfig.identityFields.Count -eq 0 -and
        $machineConfig.credentialFields.Count -eq 0
    } catch {
      # A malformed config cannot prove this Factory image is unclaimed.
    }
  }
  $provisioningFiles = if (Test-Path -LiteralPath 'C:\\ProgramData\\VEM\\provisioning') {
    @(Get-ChildItem -LiteralPath 'C:\\ProgramData\\VEM\\provisioning' -File -Recurse -Force -ErrorAction Stop | ForEach-Object { $_.FullName })
  } else { @() }
  $identityAbsent =
    $machineConfig.unclaimed -and
    $identityFiles.Count -eq 0 -and
    $provisioningFiles.Count -eq 0
  $result = [ordered]@{
    schemaVersion = 'factory-preclaim-verification/v1'
    kind = 'factory-preclaim-verification'
    runId = ${psString(runId)}
    expectedUnclaimedMachineCode = ${psString(machineCode)}
    readOnly = $true
    ok = $factoryVerifierExit -eq 0 -and [bool]$factoryVerification.ok -and $identityAbsent -and $oobeComplete
    checks = [ordered]@{
      factoryRuntime = [ordered]@{
        ok = [bool]$factoryVerification.ok
        failureCount = @($factoryVerification.failures).Count
        failures = @($factoryVerification.failures | ForEach-Object { [string]$_ })
        baseline = $factoryVerification.checks.manifest
        packages = $factoryVerification.checks.factoryRemoteMaintenanceCapability.packageVersions
        daemonService = $factoryVerification.checks.daemonService
        machineUiStartup = $factoryVerification.checks.machineUiStartup
        maintenanceSshCa = $factoryVerification.checks.factoryRemoteMaintenanceCapability.caFingerprint
        passwordSsh = $factoryVerification.checks.factoryRemoteMaintenanceCapability.passwordAuthentication
        accounts = $factoryVerification.checks.factoryRemoteMaintenanceCapability.accountPolicy
        kiosk = $factoryVerification.checks.kiosk
      }
      absentMachineIdentity = [ordered]@{
        asserted = $identityAbsent
        machineIdentityFileCount = $identityFiles.Count
        machineConfig = $machineConfig
        provisioningFileCount = $provisioningFiles.Count
      }
      oobeComplete = [ordered]@{
        asserted = $oobeComplete
        bootstrapState = if ($null -ne $oobeStatus) { $oobeStatus.state } else { $null }
        bootstrapStage = if ($null -ne $oobeStatus) { $oobeStatus.stage } else { $null }
        oobeInProgress = $setupState.OOBEInProgress
        systemSetupInProgress = $setupState.SystemSetupInProgress
        setupType = $setupState.SetupType
        unattendOverride = $setupState.UnattendFile
        deprecatedAnswerPresent = Test-Path -LiteralPath $deprecatedOobeAnswerPath
        retainedKioskAutologonHandoffPresent = $retainedKioskAutologonHandoffPresent
        retainedKioskAutologonHandoffPath = $retainedKioskAutologonHandoffPath
        bootstrapAccountPresent = $null -ne (Get-LocalUser -Name 'VEMOobeBootstrap' -ErrorAction SilentlyContinue)
        cleanupTaskPresent = $null -ne $cleanupTask
        personalizationVolumeCount = $personalizationVolumes.Count
        cleanupPhase = if ($null -ne $cleanupStatus) { [string]$cleanupStatus.phase } else { $null }
        rebootOriginBootIdentity = $rebootOriginBootIdentity
        completedBootIdentity = $completedBootIdentity
        currentBootIdentity = $currentBootIdentity
        completedBootProofIsPostReboot = $completedBootProofIsPostReboot
        currentBootIsPostReboot = $currentBootIsPostReboot
        postRebootBootIdentityChanged = $cleanupComplete
        activeVemKioskConsoleSession = $activeVemKioskConsoleSession
        consoleUser = $consoleUser
      }
    }
  }
  [pscustomobject]$result | ConvertTo-Json -Depth 40
  if (-not [bool]$result.ok) { exit 1 }
} finally {
  Remove-Item -LiteralPath $verifierEvidencePath -Force -ErrorAction SilentlyContinue
}
`;
}

export function buildRemotePowerShellScript(options = {}) {
  const mode = options.mode ?? "inventory";
  const machineCode = options.machineCode ?? "VEM-TESTBED-WINVM-01";
  const supportedModes = [
    "inventory",
    "reset",
    "inventory-reset",
    "bring-up",
    "provision",
    "runtime-acceptance",
    "simulated-hardware-sale-flow",
    "clean-base-factory-acceptance",
    "factory-preclaim-verify",
  ];
  if (!supportedModes.includes(mode)) {
    throw new Error(`unsupported mode: ${mode}`);
  }
  if (
    mode !== "clean-base-factory-acceptance" &&
    mode !== "factory-preclaim-verify"
  ) {
    assertTestbedMachineCode(machineCode);
  }
  if (mode === "factory-preclaim-verify") {
    return buildFactoryPreclaimVerificationScript(options);
  }
  const runId =
    mode === "clean-base-factory-acceptance" ||
    mode === "simulated-hardware-sale-flow" ||
    ((mode === "provision" || mode === "runtime-acceptance") &&
      options.ephemeralPlatformEvidence)
      ? sanitizeRunId(options.runId)
      : "not-applicable";
  const cleanBasePlan =
    mode === "clean-base-factory-acceptance"
      ? buildCleanBaseFactoryAcceptancePlan({ ...options, runId })
      : null;
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
    (mode === "provision" && ephemeralPlatformSetup)
      ? ephemeralPlatformSetup.claimCode
      : (options.claimCode ?? "");
  if (mode === "provision" && String(claimCode).trim().length === 0) {
    throw new Error("provision mode requires --claim-code");
  }
  const cleanBaseEvidenceRoot =
    mode === "clean-base-factory-acceptance"
      ? `C:\\ProgramData\\VEM\\evidence\\clean-base-factory-acceptance\\${runId}`
      : "C:\\ProgramData\\VEM\\evidence\\clean-base-factory-acceptance\\not-applicable";
  const remoteSupportScriptRoot = options.remoteSupportScriptRoot ?? "";
  const remoteUploadedArtifactRoot = options.remoteUploadedArtifactRoot ?? "";
  const expectedDaemonArtifactSha256 = options.daemonArtifactSha256 ?? "";
  const expectedMachineUiArtifactSha256 = options.machineUiArtifactSha256 ?? "";
  const cleanBaseSource = cleanBasePlan?.cleanBase.source ?? "";
  const cleanBaseFactoryProfile = String(options.factoryProfile ?? "");
  const cleanBaseEnvironmentName = `vps-fresh-${cleanBaseFactoryProfile}-clean-base`;
  const cleanBaseFactoryMediaRoot = String(options.factoryMediaRoot ?? "");
  const cleanBaseVisionConfigurationSourcePath = String(
    options.visionConfigurationSourcePath ?? "",
  );
  const cleanBaseMaintenanceUser =
    cleanBaseFactoryProfile === "production" ? "Admin" : "YKDZ";
  const cleanBaseHardwareMode =
    cleanBaseFactoryProfile === "production" ? "production" : "simulated";
  const cleanBaseSnapshot = cleanBasePlan?.cleanBase.snapshot ?? "";
  const factoryWindowsBaselinePolicyJson = JSON.stringify(
    FACTORY_WINDOWS_BASELINE_POLICY,
  );

  const plan = assertResetPlanPreservesTestbed(buildResetPlan());
  const bringUpPlan = buildBringUpPlan(options);
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
  const bringUpArgumentLines = Object.entries(bringUpPlan.arguments)
    .map(([name, value]) => `    ${psString(name)} = ${psArgumentValue(value)}`)
    .join("\n");
  const bringUpReportArgumentLines = Object.entries(bringUpPlan.arguments)
    .map(([name, value]) => {
      const reportValue = String(value).startsWith("$env:")
        ? `<${String(value).slice(1)}>`
        : String(value);
      return `        ${psString(name)} = ${psString(reportValue)}`;
    })
    .join("\n");
  const bringUpSwitchLines = bringUpPlan.switches
    .map((name) => `  $setupArgs[${psString(name)}] = $true`)
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

function Assert-RequiredSecretEnvironment([string]$Name) {
  if ([string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($Name, "Process"))) {
    throw "required secret environment variable is missing: $Name"
  }
}

function Invoke-ProductionBringUp($Actions) {
  $status = "succeeded"
  $message = $null
  $output = @()
  try {
    foreach ($secretName in ${psArray(bringUpPlan.requiredSecretEnvironment)}) {
      Assert-RequiredSecretEnvironment $secretName
    }
    $setupScript = ${psString(bringUpPlan.setupScript)}
    if (-not (Test-Path -LiteralPath $setupScript)) {
      throw "production bring-up script not found: $setupScript"
    }
    $setupArgs = @{
${bringUpArgumentLines}
    }
${bringUpSwitchLines}
    $output = @(& $setupScript @setupArgs *>&1 | ForEach-Object { [string]$_ })
  } catch {
    $status = "failed"
    $message = [string]$_
  }
  $Actions.Add([pscustomobject]@{
    name = "run production bring-up"
    status = $status
    message = $message
    setupScript = ${psString(bringUpPlan.setupScript)}
    output = $output
  }) | Out-Null
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
  if (-not [bool]$state.maintenancePinConfigured) { $issues.Add("maintenance_pin_not_configured") }
  return [pscustomobject]@{
    public = $public
    machineSecretConfigured = [bool]$state.machineSecretConfigured
    mqttSigningSecretConfigured = [bool]$state.mqttSigningSecretConfigured
    mqttPasswordConfigured = [bool]$state.mqttPasswordConfigured
    maintenancePinConfigured = [bool]$state.maintenancePinConfigured
    provisioned = $issues.Count -eq 0
    provisioningIssues = @($issues)
    factoryManifestConfigured = [bool]$state.factoryManifest
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
      serialPortPath = $null
      scannerSerialPortPath = $null
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
    serialPortPath = if ($null -ne $Config.public) { $Config.public.serialPortPath } else { $null }
    scannerSerialPortPath = if ($null -ne $Config.public) { $Config.public.scannerSerialPortPath } else { $null }
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
    canSell = [bool]$Snapshot.canSell
    mode = if ($null -ne $Snapshot.mode) { [string]$Snapshot.mode } else { $null }
    suggestedRoute = if ($null -ne $Snapshot.suggestedRoute) { [string]$Snapshot.suggestedRoute } else { $null }
    blockingCodes = @($Snapshot.blockingCodes | ForEach-Object { [string]$_ })
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
      $summary = Invoke-IpcJson "GET" "$baseUrl/v1/config/summary" $headers -TimeoutSec 2
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
      $summary = Invoke-IpcJson "GET" "$baseUrl/v1/config/summary" $headers
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
      ([string]$actionEvidence.endpoint).EndsWith("/v1/bring-up/tasks/execute", [StringComparison]::OrdinalIgnoreCase) -and
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
    $daemonIpc = Wait-DaemonIpc ${psString(bringUpPlan.arguments.DaemonReadyFile)}
    $config = Get-ConfigSnapshotFromRuntimeSummary (Invoke-IpcJson "GET" "$($daemonIpc.baseUrl)/v1/config/summary" $daemonIpc.headers)
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
    readyFile = ${psString(bringUpPlan.arguments.DaemonReadyFile)}
    endpoint = $null
    runId = ${psString(runId)}
    claimCodeId = ${psString(ephemeralPlatformSetup?.claimCodeId ?? "")}
    expectedMachineCode = ${psString(machineCode)}
    platformTarget = ${psString(platformTarget)}
    apiBaseUrl = ${psString(platform.apiBaseUrl)}
    mqttUrl = ${psString(platform.mqttUrl)}
    preClaimFactoryConfigVerified = $false
    networkProbe = [ordered]@{
      endpoint = $null
      status = "not_attempted"
      httpStatus = $null
    }
    bootstrapMaintenanceSession = [ordered]@{
      endpoint = $null
      status = "not_attempted"
      httpStatus = $null
    }
    claimStatus = "not_attempted"
    claimFailureCode = $null
    claimHttpStatus = $null
    maintenanceStatusAfterClaimFailure = [ordered]@{
      observed = $false
      state = $null
      handshakeVerified = $null
      lastError = $null
    }
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

    $daemonIpc = Wait-DaemonIpc ${psString(bringUpPlan.arguments.DaemonReadyFile)}
    $ready = $daemonIpc.ready
    $baseUrl = $daemonIpc.baseUrl
    $headers = $daemonIpc.headers

    # Factory writes a random single-use capability readable only by the
    # maintenance account. Exchange it for the daemon's ordinary in-memory
    # session before any protected Bring-Up task; never use mutable config IPC.
    $bootstrapCapabilityPath = "C:\ProgramData\VEM\vending-daemon\factory\bootstrap-provisioning-capability"
    if (-not (Test-Path -LiteralPath $bootstrapCapabilityPath -PathType Leaf)) {
      throw "Factory bootstrap maintenance capability is missing"
    }
    $bootstrapCapability = [IO.File]::ReadAllText($bootstrapCapabilityPath, [Text.UTF8Encoding]::new($false)).Trim()
    if ([string]::IsNullOrWhiteSpace($bootstrapCapability)) {
      throw "Factory bootstrap maintenance capability is empty"
    }
    $bootstrapHeaders = @{}
    foreach ($entry in $headers.GetEnumerator()) { $bootstrapHeaders[[string]$entry.Key] = [string]$entry.Value }
    $bootstrapHeaders["x-vem-factory-bootstrap-capability"] = $bootstrapCapability
    $evidence.bootstrapMaintenanceSession.endpoint = "$baseUrl/v1/factory/bootstrap/maintenance-session"
    try {
      $bootstrapSession = Invoke-IpcJson "POST" "$baseUrl/v1/factory/bootstrap/maintenance-session" $bootstrapHeaders
      if ([string]::IsNullOrWhiteSpace([string]$bootstrapSession.sessionId)) {
        throw "Factory bootstrap session response has no session id"
      }
      $headers["x-vem-maintenance-session"] = [string]$bootstrapSession.sessionId
      $evidence.bootstrapMaintenanceSession.status = "issued"
      $evidence.bootstrapMaintenanceSession.httpStatus = 201
    } catch {
      $bootstrapError = Get-HttpErrorInfo $_
      $evidence.bootstrapMaintenanceSession.status = "failed"
      $evidence.bootstrapMaintenanceSession.httpStatus = $bootstrapError.statusCode
      throw "Factory bootstrap maintenance session failed"
    } finally {
      $bootstrapCapability = $null
      $bootstrapHeaders.Remove("x-vem-factory-bootstrap-capability")
    }

    $configBefore = Get-ConfigSnapshotFromRuntimeSummary (Invoke-IpcJson "GET" "$baseUrl/v1/config/summary" $headers)
    $public = $configBefore.public
    Assert-FirstClaimConfig $configBefore
    if (-not [bool]$configBefore.factoryManifestConfigured) {
      throw "Factory bootstrap configuration is missing before Testbed claim"
    }
    if ([string]$public.apiBaseUrl -ne ${psString(platform.apiBaseUrl)}) {
      throw "Factory bootstrap provisioning endpoint does not match the isolated Testbed platform"
    }
    $evidence.preClaimFactoryConfigVerified = $true

    $bringUp = Invoke-IpcJson "GET" "$baseUrl/v1/bring-up" $headers
    $currentTask = $bringUp.currentTask
    if ($null -eq $currentTask) {
      throw "daemon did not project a current Factory network task"
    }
    if ([string]$currentTask.kind -ne "configure_network" -or [string]$currentTask.intent -ne "refresh_network") {
      throw "daemon projected unexpected Factory network task: $($currentTask.kind)/$($currentTask.intent)"
    }
    if (
      [int]$currentTask.contractVersion -ne 1 -or
      [string]::IsNullOrWhiteSpace([string]$currentTask.taskId) -or
      [uint64]$currentTask.taskVersion -lt 1
    ) {
      throw "daemon projected an invalid Factory network task cursor"
    }
    $probePayload = [ordered]@{
      contractVersion = [int]$currentTask.contractVersion
      taskId = [string]$currentTask.taskId
      taskVersion = [uint64]$currentTask.taskVersion
      kind = [string]$currentTask.kind
      intent = [string]$currentTask.intent
      mutation = [ordered]@{ type = "probe_network" }
    }
    $evidence.networkProbe.endpoint = "$baseUrl/v1/bring-up/tasks/execute"
    try {
      $probeResult = Invoke-IpcJson "POST" "$baseUrl/v1/bring-up/tasks/execute" $headers $probePayload
      if ([string]$probeResult.status -ne "connected") {
        throw "daemon did not verify existing local network and Platform endpoint"
      }
      $evidence.networkProbe.status = "connected"
      $evidence.networkProbe.httpStatus = 200
    } catch {
      $probeError = Get-HttpErrorInfo $_
      $evidence.networkProbe.status = "failed"
      $evidence.networkProbe.httpStatus = $probeError.statusCode
      throw "daemon IPC existing-network probe failed"
    }

    $bringUp = Invoke-IpcJson "GET" "$baseUrl/v1/bring-up" $headers
    $currentTask = $bringUp.currentTask
    if ($null -eq $currentTask) {
      throw "daemon did not project a Factory claim task after network probe"
    }
    if ([string]$currentTask.kind -ne "claim_machine" -or [string]$currentTask.intent -ne "claim_machine") {
      throw "daemon projected unexpected Factory claim task after network probe: $($currentTask.kind)/$($currentTask.intent)"
    }
    if (
      [int]$currentTask.contractVersion -ne 1 -or
      [string]::IsNullOrWhiteSpace([string]$currentTask.taskId) -or
      [uint64]$currentTask.taskVersion -lt 1
    ) {
      throw "daemon projected an invalid Factory claim task cursor after network probe"
    }
    $claimPayload = [ordered]@{
      contractVersion = [int]$currentTask.contractVersion
      taskId = [string]$currentTask.taskId
      taskVersion = [uint64]$currentTask.taskVersion
      kind = [string]$currentTask.kind
      intent = [string]$currentTask.intent
      mutation = [ordered]@{
        type = "claim_machine"
        claimCode = ${psString(claimCode)}
      }
    }
    $evidence.endpoint = "$baseUrl/v1/bring-up/tasks/execute"
    $evidence.usedDaemonIpcTaskExecute = $true
    $preClaimReadyGeneration = [long](Get-Item -LiteralPath ${psString(bringUpPlan.arguments.DaemonReadyFile)} -ErrorAction Stop).LastWriteTimeUtc.Ticks
    try {
      $claimResult = Invoke-IpcJson "POST" "$baseUrl/v1/bring-up/tasks/execute" $headers $claimPayload
      $evidence.claimStatus = "provisioned"
      $evidence.claimHttpStatus = 200
      $evidence.machineCode = $claimResult.machineCode
      $evidence.claimResult.restartRequested = if ($null -ne $claimResult.restartRequested) { [bool]$claimResult.restartRequested } else { $null }
    } catch {
      $claimError = Get-HttpErrorInfo $_
      $evidence.claimStatus = "failed"
      $evidence.claimFailureCode = Convert-ClaimFailureClassification $claimError
      $evidence.claimHttpStatus = $claimError.statusCode
      try {
        $maintenanceStatus = Invoke-IpcJson "GET" "$baseUrl/v1/maintenance/status" $headers
        $evidence.maintenanceStatusAfterClaimFailure.observed = $true
        $evidence.maintenanceStatusAfterClaimFailure.state = [string]$maintenanceStatus.state
        $evidence.maintenanceStatusAfterClaimFailure.handshakeVerified = [bool]$maintenanceStatus.handshakeVerified
        $evidence.maintenanceStatusAfterClaimFailure.lastError = if (
          [string]::IsNullOrWhiteSpace([string]$maintenanceStatus.lastError)
        ) { $null } else { [string]$maintenanceStatus.lastError }
      } catch {
        $evidence.maintenanceStatusAfterClaimFailure.lastError = "maintenance_status_unavailable"
      }
      throw "daemon IPC claim failed: $($evidence.claimFailureCode)"
    }

    if (-not [bool]$evidence.claimResult.restartRequested) {
      throw "daemon Claim did not request the required runtime reconfigure"
    }
    try {
      $recoveredIpc = Wait-DaemonIpcAfterProvisioning ${psString(bringUpPlan.arguments.DaemonReadyFile)} $preClaimReadyGeneration $evidence.machineCode $evidence.claimResult
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
    $configAfter = Get-ConfigSnapshotFromRuntimeSummary (Invoke-IpcJson "GET" "$baseUrl/v1/config/summary" $headers)
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

function Get-ScheduledTaskEvidence([string]$TaskName, [string]$TaskPath) {
  $task = Get-ScheduledTask -TaskName $TaskName -TaskPath $TaskPath -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    return [pscustomobject]@{
      name = "$TaskPath$TaskName"
      exists = $false
      state = $null
      enabled = $false
      runAsUser = $null
      command = $null
      arguments = $null
      workingDirectory = $null
    }
  }
  $principal = $task.Principal
  $action = @($task.Actions | Select-Object -First 1)
  return [pscustomobject]@{
    name = "$TaskPath$TaskName"
    exists = $true
    state = [string]$task.State
    enabled = [string]$task.State -ne "Disabled"
    runAsUser = if ($null -ne $principal) { [string]$principal.UserId } else { $null }
    command = if ($action.Count -gt 0) { [string]$action[0].Execute } else { $null }
    arguments = if ($action.Count -gt 0) { [string]$action[0].Arguments } else { $null }
    workingDirectory = if ($action.Count -gt 0) { [string]$action[0].WorkingDirectory } else { $null }
  }
}

function Get-WinlogonAutoLogonEvidence {
  $winlogon = Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon" -ErrorAction SilentlyContinue
  if ($null -eq $winlogon) {
    return [ordered]@{
      configured = $false
      user = "unknown"
      domain = "unknown"
      force = $false
    }
  }
  return [ordered]@{
    configured = [string]$winlogon.AutoAdminLogon -eq "1"
    user = if ([string]::IsNullOrWhiteSpace($winlogon.DefaultUserName)) { "unknown" } else { [string]$winlogon.DefaultUserName }
    domain = if ([string]::IsNullOrWhiteSpace($winlogon.DefaultDomainName)) { "unknown" } else { [string]$winlogon.DefaultDomainName }
    force = [string]$winlogon.ForceAutoLogon -eq "1"
  }
}

function Get-MachineUiStartupEvidence($MachineUiTask) {
  $task = Get-ScheduledTask -TaskName "VEMMachineUI" -TaskPath "\\" -ErrorAction SilentlyContinue
  if ($null -eq $task) {
    return [ordered]@{
      configured = $false
      mode = "scheduled_task"
      runAsUser = "unknown"
      command = "unknown"
    }
  }
  $action = @($task.Actions | Select-Object -First 1)
  return [ordered]@{
    configured = [bool]$MachineUiTask.exists -and [bool]$MachineUiTask.enabled
    mode = "scheduled_task"
    runAsUser = if ([string]::IsNullOrWhiteSpace($MachineUiTask.runAsUser)) { "unknown" } else { [string]$MachineUiTask.runAsUser }
    command = if ($action.Count -gt 0 -and -not [string]::IsNullOrWhiteSpace($action[0].Execute)) { [string]$action[0].Execute } else { "unknown" }
  }
}

function Convert-StartupCommandEvidence($Command) {
  return [ordered]@{
    name = if ([string]::IsNullOrWhiteSpace($Command.name)) { "unknown" } else { [string]$Command.name }
    exists = [bool]$Command.exists
    enabled = [bool]$Command.enabled
    runAsUser = if ([string]::IsNullOrWhiteSpace($Command.runAsUser)) { $null } else { [string]$Command.runAsUser }
    command = if ([string]::IsNullOrWhiteSpace($Command.command)) { $null } else { [string]$Command.command }
    arguments = if ([string]::IsNullOrWhiteSpace($Command.arguments)) { $null } else { [string]$Command.arguments }
    workingDirectory = if ([string]::IsNullOrWhiteSpace($Command.workingDirectory)) { $null } else { [string]$Command.workingDirectory }
  }
}

function Get-MissingStartupBringupEvidence {
  return [ordered]@{
    configuredBy = "missing"
    productionBringup = $false
    daemonOwnedInitialization = $true
    autoLogon = [ordered]@{
      configured = $false
      user = "unknown"
      domain = "unknown"
      force = $false
    }
    machineUiStartup = [ordered]@{
      configured = $false
      mode = "scheduled_task"
      runAsUser = "unknown"
      command = "unknown"
    }
    startupCommands = @()
  }
}

function Get-StartupBringupEvidence {
  $path = ${psString(STARTUP_BRINGUP_EVIDENCE_FILE)}
  if (-not (Test-Path -LiteralPath $path)) {
    return Get-MissingStartupBringupEvidence
  }

  $evidence = Read-JsonFile $path
  $startupCommands = @($evidence.startupCommands | ForEach-Object {
    Convert-StartupCommandEvidence $_
  })
  return [ordered]@{
    configuredBy = if ([string]::IsNullOrWhiteSpace($evidence.configuredBy)) { "unknown" } else { [string]$evidence.configuredBy }
    productionBringup = [bool]$evidence.productionBringup
    daemonOwnedInitialization = [bool]$evidence.daemonOwnedInitialization
    autoLogon = [ordered]@{
      configured = [bool]$evidence.autoLogon.configured
      user = if ([string]::IsNullOrWhiteSpace($evidence.autoLogon.user)) { "unknown" } else { [string]$evidence.autoLogon.user }
      domain = if ([string]::IsNullOrWhiteSpace($evidence.autoLogon.domain)) { "unknown" } else { [string]$evidence.autoLogon.domain }
      force = [bool]$evidence.autoLogon.force
    }
    machineUiStartup = [ordered]@{
      configured = [bool]$evidence.machineUiStartup.configured
      mode = if ([string]$evidence.machineUiStartup.mode -eq "shell_launcher") { "shell_launcher" } else { "scheduled_task" }
      runAsUser = if ([string]::IsNullOrWhiteSpace($evidence.machineUiStartup.runAsUser)) { "unknown" } else { [string]$evidence.machineUiStartup.runAsUser }
      command = if ([string]::IsNullOrWhiteSpace($evidence.machineUiStartup.command)) { "unknown" } else { [string]$evidence.machineUiStartup.command }
    }
    startupCommands = $startupCommands
  }
}

function Get-WebView2Presence {
  $paths = @(
    "C:\\Program Files (x86)\\Microsoft\\EdgeWebView\\Application",
    "C:\\Program Files\\Microsoft\\EdgeWebView\\Application"
  )
  $existing = @($paths | Where-Object { Test-Path -LiteralPath $_ })
  return [pscustomobject]@{
    installed = $existing.Count -gt 0
    paths = $existing
  }
}

function Get-DisplayEvidence {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
  $screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
    [pscustomobject]@{
      deviceName = $_.DeviceName
      primary = [bool]$_.Primary
      widthPx = [int]$_.Bounds.Width
      heightPx = [int]$_.Bounds.Height
    }
  })
  return [pscustomobject]@{
    source = "ssh_service_session"
    screens = $screens
  }
}

function Get-ProcessOwnerEvidence($Process) {
  $owner = $null
  try {
    $ownerResult = Invoke-CimMethod -InputObject $Process -MethodName GetOwner -ErrorAction Stop
    if ($ownerResult.ReturnValue -eq 0) {
      $owner = [pscustomobject]@{
        user = [string]$ownerResult.User
        domain = [string]$ownerResult.Domain
      }
    }
  } catch {
    $owner = $null
  }
  return $owner
}

function Get-MachineUiProcessEvidence {
  $processes = @(Get-CimInstance Win32_Process -Filter "name = 'machine.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $owner = Get-ProcessOwnerEvidence $_
    [pscustomobject]@{
      processId = [int]$_.ProcessId
      sessionId = [int]$_.SessionId
      executablePath = if ($null -ne $_.ExecutablePath) { [string]$_.ExecutablePath } else { $null }
      commandLine = if ($null -ne $_.CommandLine) { [string]$_.CommandLine } else { $null }
      ownerUser = if ($null -ne $owner) { [string]$owner.user } else { "unknown" }
      ownerDomain = if ($null -ne $owner) { [string]$owner.domain } else { "unknown" }
    }
  })
  return $processes
}

function Get-WebView2ProcessEvidence {
  $processes = @(Get-CimInstance Win32_Process -Filter "name = 'msedgewebview2.exe'" -ErrorAction SilentlyContinue | ForEach-Object {
    $owner = Get-ProcessOwnerEvidence $_
    [pscustomobject]@{
      processId = [int]$_.ProcessId
      sessionId = [int]$_.SessionId
      executablePath = if ($null -ne $_.ExecutablePath) { [string]$_.ExecutablePath } else { $null }
      commandLine = if ($null -ne $_.CommandLine) { [string]$_.CommandLine } else { $null }
      ownerUser = if ($null -ne $owner) { [string]$owner.user } else { "unknown" }
      ownerDomain = if ($null -ne $owner) { [string]$owner.domain } else { "unknown" }
    }
  })
  return $processes
}

function Get-SessionProcessEvidence([string]$Name, $ActiveKioskSession) {
  if ($null -eq $ActiveKioskSession) {
    return @()
  }
  $safeName = $Name.Replace("'", "''")
  return @(Get-CimInstance Win32_Process -Filter "name = '$safeName'" -ErrorAction SilentlyContinue | Where-Object {
    [int]$_.SessionId -eq [int]$ActiveKioskSession.sessionId
  } | ForEach-Object {
    $owner = Get-ProcessOwnerEvidence $_
    [pscustomobject]@{
      processId = [int]$_.ProcessId
      sessionId = [int]$_.SessionId
      ownerUser = if ($null -ne $owner) { [string]$owner.user } else { "unknown" }
    }
  } | Where-Object {
    $_.ownerUser -eq "VEMKiosk"
  })
}

function Get-KioskDesktopEscapeEvidence($ActiveKioskSession) {
  $explorerProcesses = @(Get-SessionProcessEvidence "explorer.exe" $ActiveKioskSession)
  $edgeProcesses = @(Get-SessionProcessEvidence "msedge.exe" $ActiveKioskSession)
  $startProcesses = @(Get-SessionProcessEvidence "StartMenuExperienceHost.exe" $ActiveKioskSession)
  return [ordered]@{
    status = "asserted"
    source = "session_process_surface_probe"
    interactiveProbe = [ordered]@{
      status = "observed"
      message = "desktop shell surfaces were probed in the active VEMKiosk session"
    }
    processPresence = [ordered]@{
      explorer = $explorerProcesses
      edge = $edgeProcesses
      startMenu = $startProcesses
    }
    desktopVisible = $explorerProcesses.Count -gt 0
    taskbarVisible = $explorerProcesses.Count -gt 0
    startMenuVisible = $startProcesses.Count -gt 0
    edgeReachable = $edgeProcesses.Count -gt 0
    fileExplorerReachable = $explorerProcesses.Count -gt 0
  }
}

function Convert-QuserSessionLine([string]$Line) {
  if ([string]::IsNullOrWhiteSpace($Line)) { return $null }
  $match = [regex]::Match($Line, '^\\s*>?\\s*(?<user>\\S+)\\s+(?:(?<sessionName>\\S+)\\s+)?(?<id>\\d+)\\s+(?<state>\\S+)')
  if (-not $match.Success) { return $null }
  $user = [string]$match.Groups["user"].Value
  if ($user.Contains("\\")) {
    $user = $user.Split("\\")[-1]
  }
  return [pscustomobject]@{
    user = $user
    sessionName = if ($match.Groups["sessionName"].Success) { [string]$match.Groups["sessionName"].Value } else { $null }
    sessionId = [int]$match.Groups["id"].Value
    state = [string]$match.Groups["state"].Value
    source = "quser"
  }
}

function Test-ActiveKioskQuserSession($Session) {
  if ($null -eq $Session) { return $false }
  $state = ([string]$Session.state).Trim().ToLowerInvariant()
  $sessionName = ([string]$Session.sessionName).Trim().ToLowerInvariant()
  if ([string]$Session.user -ne "VEMKiosk") { return $false }
  if ([string]$Session.source -eq "ssh_service_session") { return $false }
  if ($state -eq "active") { return $true }
  return $sessionName -eq "console" -and
    $state -ne "disc" -and
    $state -ne "disconnected" -and
    $state -ne "listen"
}

function Get-InteractiveWindowsSessionEvidence {
  $sessions = @()
  $errorMessage = $null
  try {
    $lines = @(quser 2>&1 | Select-Object -Skip 1)
    $sessions = @($lines | ForEach-Object { Convert-QuserSessionLine ([string]$_) } | Where-Object { $null -ne $_ })
  } catch {
    $errorMessage = [string]$_
  }
  $activeKioskSession = @($sessions | Where-Object {
    Test-ActiveKioskQuserSession $_
  } | Select-Object -First 1)
  return [pscustomobject]@{
    source = "quser"
    sessions = $sessions
    activeKioskSessionId = if ($activeKioskSession.Count -gt 0) { [int]$activeKioskSession[0].sessionId } else { $null }
    activeKioskSession = if ($activeKioskSession.Count -gt 0) { $activeKioskSession[0] } else { $null }
    error = $errorMessage
  }
}

function Get-ActiveKioskSession($SessionEvidence) {
  if ($null -eq $SessionEvidence) { return $null }
  $session = @($SessionEvidence.sessions | Where-Object {
    Test-ActiveKioskQuserSession $_
  } | Select-Object -First 1)
  if ($session.Count -eq 0) { return $null }
  return $session[0]
}

function Get-CurrentDesktopScreenDimensions {
  try {
    if ($null -eq ("VemDisplaySettings" -as [type])) {
      Add-Type @"
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Ansi)]
public struct VemDevMode {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
  public string dmDeviceName;
  public short dmSpecVersion;
  public short dmDriverVersion;
  public short dmSize;
  public short dmDriverExtra;
  public int dmFields;
  public int dmPositionX;
  public int dmPositionY;
  public int dmDisplayOrientation;
  public int dmDisplayFixedOutput;
  public short dmColor;
  public short dmDuplex;
  public short dmYResolution;
  public short dmTTOption;
  public short dmCollate;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
  public string dmFormName;
  public short dmLogPixels;
  public int dmBitsPerPel;
  public int dmPelsWidth;
  public int dmPelsHeight;
  public int dmDisplayFlags;
  public int dmDisplayFrequency;
  public int dmICMMethod;
  public int dmICMIntent;
  public int dmMediaType;
  public int dmDitherType;
  public int dmReserved1;
  public int dmReserved2;
  public int dmPanningWidth;
  public int dmPanningHeight;
}

public static class VemDisplaySettings {
  public const int ENUM_CURRENT_SETTINGS = -1;

  [DllImport("user32.dll", CharSet = CharSet.Ansi)]
  public static extern bool EnumDisplaySettings(string deviceName, int modeNum, ref VemDevMode devMode);
}
"@ -ErrorAction Stop
    }
    $mode = New-Object VemDevMode
    $mode.dmSize = [System.Runtime.InteropServices.Marshal]::SizeOf([VemDevMode])
    if ([VemDisplaySettings]::EnumDisplaySettings($null, [VemDisplaySettings]::ENUM_CURRENT_SETTINGS, [ref]$mode)) {
      return [pscustomobject]@{
        deviceName = "interactive-desktop-current-settings"
        primary = $true
        widthPx = [int]$mode.dmPelsWidth
        heightPx = [int]$mode.dmPelsHeight
        source = "enum_display_settings"
      }
    }
  } catch {
    return $null
  }
  return $null
}

function Get-InteractiveDesktopDisplayEvidence($ActiveKioskSession) {
  if ($null -eq $ActiveKioskSession) {
    return [pscustomobject]@{
      source = "interactive_kiosk_session"
      status = "missing"
      reason = "active VEMKiosk interactive Windows session was not observed"
      sessionUser = "unknown"
      sessionId = $null
      screens = @()
      kioskUiWindow = $null
    }
  }

  $screen = Get-CurrentDesktopScreenDimensions
  if ($null -eq $screen) {
    $probePath = "C:\\Users\\VEMKiosk\\AppData\\Local\\VEM\\kiosk-display-evidence.json"
    if (Test-Path -LiteralPath $probePath -PathType Leaf) {
      try {
        $probe = Get-Content -LiteralPath $probePath -Raw | ConvertFrom-Json
        $probeScreen = @($probe.screens | Where-Object { $_.primary } | Select-Object -First 1)
        if ($probeScreen.Count -eq 0) {
          $probeScreen = @($probe.screens | Select-Object -First 1)
        }
        if ($probeScreen.Count -gt 0) {
          $screen = [pscustomobject]@{
            deviceName = if ([string]::IsNullOrWhiteSpace($probeScreen[0].deviceName)) { "kiosk-display-probe" } else { [string]$probeScreen[0].deviceName }
            primary = [bool]$probeScreen[0].primary
            widthPx = [int]$probeScreen[0].widthPx
            heightPx = [int]$probeScreen[0].heightPx
            source = "kiosk_logon_display_probe"
          }
        }
      } catch {
        $screen = $null
      }
    }
  }

  if ($null -eq $screen) {
    return [pscustomobject]@{
      source = "interactive_kiosk_session"
      status = "missing"
      reason = "interactive desktop screen dimensions were not available"
      sessionUser = [string]$ActiveKioskSession.user
      sessionId = [int]$ActiveKioskSession.sessionId
      screens = @()
      kioskUiWindow = $null
    }
  }

  return [pscustomobject]@{
    source = "interactive_kiosk_session"
    status = "observed"
    reason = $null
    sessionUser = [string]$ActiveKioskSession.user
    sessionId = [int]$ActiveKioskSession.sessionId
    screens = @($screen)
    kioskUiWindow = $null
  }
}

function Convert-DisplayDimensionsEvidence($Display) {
  $screen = @($Display.screens | Where-Object { $_.primary } | Select-Object -First 1)
  if ($screen.Count -eq 0) {
    $screen = @($Display.screens | Select-Object -First 1)
  }
  if ($screen.Count -eq 0) {
    return [ordered]@{
      status = "missing"
      widthPx = 0
      heightPx = 0
    }
  }
  return [ordered]@{
    status = "observed"
    widthPx = [int]$screen.widthPx
    heightPx = [int]$screen.heightPx
  }
}

function Convert-InteractiveDisplayDimensionsEvidence($Display) {
  $dimensions = Convert-DisplayDimensionsEvidence $Display
  $passed = (
    $Display.status -eq "observed" -and
    $dimensions.widthPx -eq 1080 -and $dimensions.heightPx -eq 1920 -and
    $Display.sessionUser -eq "VEMKiosk"
  )
  return [ordered]@{
    status = if ($passed) { "passed" } elseif ($dimensions.status -eq "missing") { "missing" } else { "failed" }
    widthPx = [int]$dimensions.widthPx
    heightPx = [int]$dimensions.heightPx
    sessionUser = if ([string]::IsNullOrWhiteSpace($Display.sessionUser)) { "unknown" } else { [string]$Display.sessionUser }
    sessionId = if ($null -ne $Display.sessionId) { [int]$Display.sessionId } else { $null }
  }
}

function Convert-PortraitKioskAcceptanceEvidence($Dimensions) {
  $passed = (
    $Dimensions.status -eq "passed" -and
    $Dimensions.widthPx -eq 1080 -and $Dimensions.heightPx -eq 1920 -and
    $Dimensions.sessionUser -eq "VEMKiosk"
  )
  return [ordered]@{
    status = if ($passed) { "passed" } else { "failed" }
    widthPx = [int]$Dimensions.widthPx
    heightPx = [int]$Dimensions.heightPx
    sessionUser = if ([string]::IsNullOrWhiteSpace($Dimensions.sessionUser)) { "unknown" } else { [string]$Dimensions.sessionUser }
    sessionId = if ($null -ne $Dimensions.sessionId) { [int]$Dimensions.sessionId } else { $null }
    source = "interactive_kiosk_session"
  }
}

function Test-TauriHashRouteUrl([string]$Url) {
  try {
    $uri = [System.Uri]::new($Url)
    return (
      $uri.Scheme -eq "http" -and
      $uri.Host -eq "tauri.localhost" -and
      $uri.AbsolutePath -eq "/" -and
      $uri.Fragment.StartsWith("#/")
    )
  } catch {
    return $false
  }
}

function Get-CdpListenerProcessBinding($KioskProcess, $ActiveKioskSession) {
  if ($null -eq $KioskProcess -or $null -eq $ActiveKioskSession) {
    return $null
  }
  $listeners = @(Get-NetTCPConnection -LocalPort 9222 -State Listen -ErrorAction SilentlyContinue)
  foreach ($listener in $listeners) {
    $listenerProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$listener.OwningProcess)" -ErrorAction SilentlyContinue
    if ($null -eq $listenerProcess -or [int]$listenerProcess.SessionId -ne [int]$ActiveKioskSession.sessionId) {
      continue
    }
    $cursor = $listenerProcess
    for ($depth = 0; $depth -lt 32 -and $null -ne $cursor; $depth++) {
      if ([int]$cursor.ProcessId -eq [int]$KioskProcess.processId) {
        return [pscustomobject]@{
          processId = [int]$listenerProcess.ProcessId
          sessionId = [int]$listenerProcess.SessionId
          machineAncestorProcessId = [int]$KioskProcess.processId
          bound = $true
        }
      }
      $parentId = [int]$cursor.ParentProcessId
      if ($parentId -le 0 -or $parentId -eq [int]$cursor.ProcessId) { break }
      $cursor = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -ErrorAction SilentlyContinue
    }
  }
  return $null
}

function Get-WebViewCdpUrlEvidence {
  try {
    $targets = @(Invoke-RestMethod -Method Get -Uri "http://127.0.0.1:9222/json" -TimeoutSec 3)
    $target = @($targets | Where-Object {
      Test-TauriHashRouteUrl ([string]$_.url)
    } | Select-Object -First 1)
    if ($target.Count -gt 0) {
      return [pscustomobject]@{
        available = $true
        url = [string]$target[0].url
        cdpTargetId = if ([string]::IsNullOrWhiteSpace([string]$target[0].id)) { $null } else { [string]$target[0].id }
        source = "webview_cdp"
        error = $null
      }
    }
    return [pscustomobject]@{
      available = $true
      url = "unavailable:no-tauri-hash-route-target"
      cdpTargetId = $null
      source = "webview_cdp"
      error = "no_tauri_hash_route_target"
    }
  } catch {
    return [pscustomobject]@{
      available = $false
      url = "unavailable:webview-cdp"
      cdpTargetId = $null
      source = "webview_cdp"
      error = [string]$_
    }
  }
}

function Get-KioskRuntimeEvidence($ActiveKioskSession) {
  $machineProcesses = @(Get-MachineUiProcessEvidence)
  $kioskMachineProcesses = @($machineProcesses | Where-Object {
    $null -ne $ActiveKioskSession -and
    $_.ownerUser -eq "VEMKiosk" -and
    $_.sessionId -eq $ActiveKioskSession.sessionId
  })
  $kioskProcess = @($kioskMachineProcesses | Where-Object {
    [string]$_.executablePath -ieq "C:\VEM\bringup\machine.exe"
  } | Select-Object -First 1)
  $webView2Processes = @(Get-WebView2ProcessEvidence)
  $kioskWebView2Processes = @($webView2Processes | Where-Object {
    $null -ne $ActiveKioskSession -and
    $_.ownerUser -eq "VEMKiosk" -and
    $_.sessionId -eq $ActiveKioskSession.sessionId
  })
  $kioskWebView2Process = @($kioskWebView2Processes | Select-Object -First 1)
  $cdpListener = if ($kioskProcess.Count -gt 0) {
    Get-CdpListenerProcessBinding $kioskProcess[0] $ActiveKioskSession
  } else {
    $null
  }
  $cdp = Get-WebViewCdpUrlEvidence
  $cdpVerified = $kioskProcess.Count -gt 0 -and $null -ne $cdpListener -and [bool]$cdpListener.bound -and (Test-TauriHashRouteUrl ([string]$cdp.url)) -and -not [string]::IsNullOrWhiteSpace([string]$cdp.cdpTargetId)
  $productionWebViewVerified = $kioskProcess.Count -gt 0 -and $kioskWebView2Process.Count -gt 0 -and -not [bool]$cdp.available
  $machineUiTask = Get-ScheduledTask -TaskName "VEMMachineUI" -TaskPath "\\" -ErrorAction SilentlyContinue
  $machineUiAction = @($machineUiTask.Actions | Select-Object -First 1)
  $acceptanceOverlayCdp = $cdpVerified -and $machineUiAction.Count -eq 1 -and [string]$machineUiAction[0].Arguments -match [regex]::Escape("C:\VEM\bringup\launch-machine-ui-debug.vbs")
  return [ordered]@{
    webviewRunning = $kioskMachineProcesses.Count -eq 1 -and ($cdpVerified -or $productionWebViewVerified)
    url = if ($cdpVerified) { [string]$cdp.url } elseif ($productionWebViewVerified) { "unavailable:production-cdp-disabled" } else { [string]$cdp.url }
    sessionUser = if ($null -ne $ActiveKioskSession) { [string]$ActiveKioskSession.user } else { "unknown" }
    source = if ($cdpVerified) { $cdp.source } elseif ($productionWebViewVerified) { "webview2_process" } else { $cdp.source }
    processId = if ($kioskProcess.Count -gt 0) { $kioskProcess[0].processId } else { $null }
    machineProcessCount = $kioskMachineProcesses.Count
    machineExecutablePath = if ($kioskProcess.Count -gt 0) { [string]$kioskProcess[0].executablePath } else { $null }
    webView2ProcessId = if ($kioskWebView2Process.Count -gt 0) { $kioskWebView2Process[0].processId } else { $null }
    webView2ProcessCount = $kioskWebView2Processes.Count
    cdpListenerProcessId = if ($null -ne $cdpListener) { [int]$cdpListener.processId } else { $null }
    cdpListenerSessionId = if ($null -ne $cdpListener) { [int]$cdpListener.sessionId } else { $null }
    cdpMachineAncestorProcessId = if ($null -ne $cdpListener) { [int]$cdpListener.machineAncestorProcessId } else { $null }
    sessionId = if ($null -ne $ActiveKioskSession) { [int]$ActiveKioskSession.sessionId } else { $null }
    cdpAvailable = [bool]$cdp.available
    cdpTargetId = if ($cdpVerified) { [string]$cdp.cdpTargetId } else { $null }
    acceptanceOverlayCdp = [bool]$acceptanceOverlayCdp
    error = $cdp.error
  }
}

function Get-ArtifactSha256([string]$Path) {
  try {
    if (-not (Test-Path -LiteralPath $Path)) {
      return "0000000000000000000000000000000000000000000000000000000000000000"
    }
    return [string](Get-FileHash -LiteralPath $Path -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant()
  } catch {
    return "0000000000000000000000000000000000000000000000000000000000000000"
  }
}

function Copy-FactoryAcceptanceInputs([string]$StageRoot) {
  $artifactRoot = Join-Path $StageRoot "artifact-backup"
  $scriptRoot = Join-Path $StageRoot "script-bundle"
  New-Item -ItemType Directory -Path $artifactRoot -Force | Out-Null
  New-Item -ItemType Directory -Path $scriptRoot -Force | Out-Null

  $uploadedArtifactRoot = ${psString(remoteUploadedArtifactRoot)}
  if ([string]::IsNullOrWhiteSpace($uploadedArtifactRoot)) {
    throw "factory acceptance requires uploaded artifact root"
  }
  $daemonSource = Join-Path $uploadedArtifactRoot "vending-daemon.exe"
  $machineUiSource = Join-Path $uploadedArtifactRoot "machine.exe"
  $machineUiSidecarSource = Join-Path $uploadedArtifactRoot "WebView2Loader.dll"
  $artifactSource = "uploaded_local_artifacts"
  $daemonBackup = Join-Path $artifactRoot "vending-daemon.exe"
  $machineUiBackup = Join-Path $artifactRoot "machine.exe"
  $machineUiSidecarBackup = Join-Path $artifactRoot "WebView2Loader.dll"
  Copy-Item -LiteralPath $daemonSource -Destination $daemonBackup -Force -ErrorAction Stop
  Copy-Item -LiteralPath $machineUiSource -Destination $machineUiBackup -Force -ErrorAction Stop
  Copy-Item -LiteralPath $machineUiSidecarSource -Destination $machineUiSidecarBackup -Force -ErrorAction Stop
  $daemonBackupSha256 = Get-ArtifactSha256 $daemonBackup
  $machineUiBackupSha256 = Get-ArtifactSha256 $machineUiBackup
  $expectedDaemonSha256 = ${psString(expectedDaemonArtifactSha256)}
  $expectedMachineUiSha256 = ${psString(expectedMachineUiArtifactSha256)}
  if (-not [string]::IsNullOrWhiteSpace($expectedDaemonSha256) -and $daemonBackupSha256 -ne $expectedDaemonSha256) {
    throw "uploaded vending-daemon.exe hash mismatch: expected $expectedDaemonSha256, got $daemonBackupSha256"
  }
  if (-not [string]::IsNullOrWhiteSpace($expectedMachineUiSha256) -and $machineUiBackupSha256 -ne $expectedMachineUiSha256) {
    throw "uploaded machine.exe hash mismatch: expected $expectedMachineUiSha256, got $machineUiBackupSha256"
  }

  $supportSourceRoots = @(
    ${psString(remoteSupportScriptRoot)},
    "C:\\VEM\\bringup\\scripts"
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  foreach ($scriptName in ${psArray(FACTORY_SUPPORT_SCRIPT_NAMES)}) {
    $source = $null
    foreach ($sourceRoot in $supportSourceRoots) {
      $candidate = Join-Path $sourceRoot $scriptName
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        $source = $candidate
        break
      }
    }
    if ($null -eq $source) {
      throw "required factory support script not found in staged or installed script roots: $scriptName"
    }
    Copy-Item -LiteralPath $source -Destination (Join-Path $scriptRoot $scriptName) -Force -ErrorAction Stop
  }

  return [ordered]@{
    artifactRoot = $artifactRoot
    artifactSource = $artifactSource
    scriptRoot = $scriptRoot
    daemonArtifactPath = $daemonBackup
    daemonSha256 = $daemonBackupSha256
    expectedDaemonSha256 = $expectedDaemonSha256
    machineUiArtifactPath = $machineUiBackup
    machineUiSidecarPath = $machineUiSidecarBackup
    machineUiSha256 = $machineUiBackupSha256
    expectedMachineUiSha256 = $expectedMachineUiSha256
    prepareScript = Join-Path $scriptRoot "prepare-factory-runtime.ps1"
    verifierScript = Join-Path $scriptRoot "verify-factory-runtime.ps1"
  }
}

function Convert-FactoryChildStructuredJsonOutput($Output) {
  $text = (@($Output) -join [Environment]::NewLine).Trim()
  if ([string]::IsNullOrWhiteSpace($text)) {
    throw "factory child did not write structured JSON to stdout"
  }
  $start = $text.IndexOf("{")
  $end = $text.LastIndexOf("}")
  if ($start -lt 0 -or $end -lt $start) {
    throw "factory child stdout did not contain a JSON object"
  }
  return $text.Substring($start, $end - $start + 1) | ConvertFrom-Json -ErrorAction Stop
}

function Invoke-FactoryChildPowerShell($Actions, [string]$Name, [string]$ScriptPath, [hashtable]$Arguments, [string]$OutputPath, [bool]$WriteStructuredJsonOutput = $false) {
  $status = "succeeded"
  $message = $null
  $output = @()
  $stderr = @()
  $exitCode = 0
  $structuredOutput = $null
  try {
    if (-not (Test-Path -LiteralPath $ScriptPath -PathType Leaf)) {
      throw "script not found: $ScriptPath"
    }
    $argumentList = @(
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      $ScriptPath
    )
    foreach ($entry in $Arguments.GetEnumerator()) {
      if ($entry.Value -is [bool]) {
        if ([bool]$entry.Value) {
          $argumentList += "-$($entry.Key)"
        }
      } elseif ($entry.Value -is [array]) {
        $argumentList += "-$($entry.Key)"
        foreach ($item in @($entry.Value)) {
          $argumentList += [string]$item
        }
      } else {
        $argumentList += "-$($entry.Key)"
        $argumentList += [string]$entry.Value
      }
    }
    $stdoutPath = Join-Path $env:TEMP ("vem-factory-child-" + [guid]::NewGuid().ToString("N") + ".stdout.txt")
    $stderrPath = Join-Path $env:TEMP ("vem-factory-child-" + [guid]::NewGuid().ToString("N") + ".stderr.txt")
    $process = Start-Process -FilePath "powershell.exe" -ArgumentList $argumentList -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
    $exitCode = [int]$process.ExitCode
    if (Test-Path -LiteralPath $stdoutPath) {
      $output = @(Get-Content -LiteralPath $stdoutPath -ErrorAction SilentlyContinue | ForEach-Object { [string]$_ })
      Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $stderrPath) {
      $stderr = @(Get-Content -LiteralPath $stderrPath -ErrorAction SilentlyContinue | ForEach-Object { [string]$_ })
      Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
    }
    if ($exitCode -ne 0) {
      $status = "failed"
      $message = "$Name exited with code $exitCode"
    }
  } catch {
    $status = "failed"
    $message = [string]$_
  }
  if ($status -eq "succeeded" -and $WriteStructuredJsonOutput) {
    try {
      $structuredOutput = Convert-FactoryChildStructuredJsonOutput $output
    } catch {
      $status = "failed"
      $message = [string]$_
    }
  }

  $action = [ordered]@{
    name = $Name
    status = $status
    message = $message
    scriptPath = $ScriptPath
    outputPath = $OutputPath
    structuredJsonOutput = $WriteStructuredJsonOutput
    exitCode = $exitCode
    output = $output
    stderr = $stderr
  }
  if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    if ($WriteStructuredJsonOutput -and $status -eq "succeeded") {
      Write-JsonFile $OutputPath $structuredOutput
    } else {
      Write-JsonFile $OutputPath ([pscustomobject]$action)
    }
  }
  $Actions.Add([pscustomobject]$action) | Out-Null
}

function Add-FactoryAcceptanceDiagnostic($Diagnostics, [string]$Code, [string]$Message, $Detail = $null) {
  $entry = [ordered]@{
    code = $Code
    message = $Message
  }
  if ($null -ne $Detail) {
    $entry.detail = $Detail
  }
  $Diagnostics.Add($entry) | Out-Null
}

function Get-CleanBaseFactoryIdentity {
  $computer = Get-CimInstance Win32_ComputerSystem -ErrorAction SilentlyContinue
  return [ordered]@{
    hostName = if ($null -ne $computer) { [string]$computer.Name } else { $env:COMPUTERNAME }
    user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
  }
}

function Assert-CleanBaseFactoryIdentitySafety($Identity) {
  $values = @(
    ${psString(cleanBaseSource)},
    ${psString(cleanBaseSnapshot)},
    [string]$Identity.hostName,
    [string]$Identity.user
  )
  $dirtyMarkers = ${psArray(KNOWN_DIRTY_CLEAN_BASE_SOURCE_MARKERS)}
  $productionMarkers = ${psArray(KNOWN_PRODUCTION_CLEAN_BASE_SOURCE_MARKERS)}
  foreach ($value in $values) {
    $normalized = [string]$value
    if ([string]::IsNullOrWhiteSpace($normalized)) {
      continue
    }
    $lower = $normalized.ToLowerInvariant()
    foreach ($marker in $dirtyMarkers) {
      if ($lower.Contains([string]$marker)) {
        throw "clean-base factory acceptance refuses known dirty-host identity before staging: $normalized"
      }
    }
    foreach ($marker in $productionMarkers) {
      if ($lower.Contains([string]$marker)) {
        throw "clean-base factory acceptance refuses production identity before staging: $normalized"
      }
    }
    $tokens = @($lower -split "[^a-z0-9.-]+" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
    foreach ($token in $tokens) {
      if ($token -eq "vem" -or $token -eq "real") {
        throw "clean-base factory acceptance refuses production identity token before staging: $normalized"
      }
    }
  }
}

function Get-CleanBaseScheduledTaskState([string]$Task) {
  $normalized = $Task.Trim("\\")
  $separator = $normalized.LastIndexOf("\\")
  if ($separator -ge 0) {
    $taskPath = "\\" + $normalized.Substring(0, $separator) + "\\"
    $taskName = $normalized.Substring($separator + 1)
  } else {
    $taskPath = "\\"
    $taskName = $normalized
  }
  $taskObject = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
  if ($null -eq $taskObject) {
    return $null
  }
  return [ordered]@{
    name = $Task
    taskName = $taskName
    taskPath = $taskPath
    state = [string]$taskObject.State
  }
}

function Assert-CleanBasePreflightAbsence {
  $probes = ${psCleanBasePreflightProbeArray()}
  $results = @()
  $dirty = @()
  foreach ($probe in $probes) {
    $observedPaths = @()
    $observedServices = @()
    $observedTasks = @()
    foreach ($path in @($probe.paths)) {
      if (Test-Path -LiteralPath $path) {
        $observedPaths += $path
      }
    }
    foreach ($serviceName in @($probe.services)) {
      $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
      if ($null -ne $service) {
        $observedServices += [ordered]@{
          name = [string]$service.Name
          status = [string]$service.Status
          startType = [string]$service.StartType
        }
      }
    }
    foreach ($taskName in @($probe.tasks)) {
      $task = Get-CleanBaseScheduledTaskState $taskName
      if ($null -ne $task) {
        $observedTasks += $task
      }
    }
    $passed = $observedPaths.Count -eq 0 -and $observedServices.Count -eq 0 -and $observedTasks.Count -eq 0
    $results += [ordered]@{
      code = [string]$probe.code
      status = if ($passed) { "passed" } else { "failed" }
      paths = @($probe.paths)
      services = @($probe.services)
      tasks = @($probe.tasks)
      observed = @($observedPaths)
      observedPaths = @($observedPaths)
      observedServices = @($observedServices)
      observedTasks = @($observedTasks)
    }
    if (-not $passed) {
      $dirty += [string]$probe.code
    }
  }
  if ($dirty.Count -gt 0) {
    throw "clean-base preflight found retained VEM state: $($dirty -join ', ')"
  }
  return @($results)
}

function Test-CleanBaseFactoryAssertionsPassed($Assertions) {
  if ($null -eq $Assertions) {
    return $false
  }
  $required = ${psArray(REQUIRED_CLEAN_BASE_ASSERTIONS)}
  foreach ($name in $required) {
    if ([string]$Assertions.$name.status -ne "passed") {
      return $false
    }
  }
  return $true
}

function Convert-CleanBaseFactoryAssertions($VerifierEvidence, $PreflightAbsence) {
  $checks = $VerifierEvidence.checks
  $display = $checks.display
  $displayLive = $display.live
  $displayExpected = $display.expected
  $machineUiStartupMode = [string]$checks.machineUiStartup.mode
  $machineUiTask = $checks.machineUiStartup.machineUiTask
  $preflightByCode = @{}
  foreach ($probe in @($PreflightAbsence)) {
    $preflightByCode[[string]$probe.code] = $probe
  }
  return [ordered]@{
    displayOrientationResolution = [ordered]@{
      status = if ([string]$displayLive.orientation -eq [string]$displayExpected.orientation -and [int]$displayLive.width -eq [int]$displayExpected.width -and [int]$displayLive.height -eq [int]$displayExpected.height) { "passed" } else { "failed" }
      orientation = [string]$displayExpected.orientation
      widthPx = [int]$displayExpected.width
      heightPx = [int]$displayExpected.height
      live = $displayLive
    }
    sshReachability = [ordered]@{ status = if ([string]$checks.factoryRemoteMaintenanceCapability.opensshServer -eq "available") { "passed" } else { "failed" } }
    tailscaleDefaultAbsent = [ordered]@{ status = if ([string]$checks.factoryRemoteMaintenanceCapability.tailscale -eq "not_installed_by_default") { "passed" } else { "failed" } }
    windowsUpdatePolicy = $checks.windowsUpdatePolicy
    powerPolicy = $checks.powerPolicy
    bootPolicy = $checks.bootPolicy
    securityPosture = $checks.securityPosture
    factoryRemoteMaintenanceCapability = $checks.factoryRemoteMaintenanceCapability
    maintenanceCapability = [ordered]@{
      status = if ([string]$checks.factoryRemoteMaintenanceCapability.status -eq "passed") { "passed" } else { "failed" }
      evidence = $checks.factoryRemoteMaintenanceCapability
    }
    consumerExperienceInterference = $checks.consumerExperienceInterference
    sleepDisabled = [ordered]@{ status = if ([string]$checks.powerPolicy.sleep -eq "disabled") { "passed" } else { "failed" } }
    testsigningOff = [ordered]@{ status = if ([string]$checks.bootPolicy.testsigning -eq "off") { "passed" } else { "failed" } }
    autologonConfigured = [ordered]@{ status = if ([bool]$checks.autoLogon.live.configured -and [bool]$checks.autoLogon.live.force) { "passed" } else { "failed" } }
    startupLauncherMode = [ordered]@{ status = if ($machineUiStartupMode -eq "shell_launcher" -or $machineUiStartupMode -eq "scheduled_task") { "passed" } else { "failed" }; mode = $machineUiStartupMode }
    daemonService = [ordered]@{ status = if ([bool]$checks.daemonService.exists -and [string]$checks.daemonService.startType -eq "Automatic") { "passed" } else { "failed" }; service = $checks.daemonService }
    uiLauncherTask = [ordered]@{ status = if ($machineUiStartupMode -eq "shell_launcher" -or [bool]$machineUiTask.exists) { "passed" } else { "failed" }; task = $machineUiTask }
    runtimeResetGateClean = [ordered]@{ status = "passed"; preflightAbsence = @($PreflightAbsence) }
    hardwareProfileMode = [ordered]@{
      status = if (([string]$checks.manifest.factoryProfile -eq "production" -and [string]$checks.manifest.hardwareMode -eq "production") -or ([string]$checks.manifest.factoryProfile -eq "testbed" -and [string]$checks.manifest.hardwareMode -eq "simulated")) { "passed" } else { "failed" }
      profile = [string]$checks.manifest.factoryProfile
      mode = [string]$checks.manifest.hardwareMode
    }
    startupReachesBringUpOrSalesEligible = [ordered]@{ status = if ([bool]$checks.daemonService.exists -and ($machineUiStartupMode -eq "shell_launcher" -or $machineUiStartupMode -eq "scheduled_task")) { "passed" } else { "failed" }; state = "bring_up" }
    preflightNoMachineIdentity = [ordered]@{ status = [string]$preflightByCode["preflightNoMachineIdentity"].status }
    preflightNoProvisioningProfile = [ordered]@{ status = [string]$preflightByCode["preflightNoProvisioningProfile"].status }
    preflightNoProtectedSecrets = [ordered]@{ status = [string]$preflightByCode["preflightNoProtectedSecrets"].status }
    preflightNoDaemonState = [ordered]@{ status = [string]$preflightByCode["preflightNoDaemonState"].status }
    preflightNoPreviousVemEvidence = [ordered]@{ status = [string]$preflightByCode["preflightNoPreviousVemEvidence"].status }
  }
}

function Invoke-CleanBaseFactoryAcceptance($FactoryActions) {
  $runId = ${psString(runId)}
  $runRoot = ${psString(cleanBaseEvidenceRoot)}
  $stageRoot = Join-Path ${psString(remoteSupportScriptRoot)} "clean-base-staging"
  $acceptancePath = Join-Path $runRoot ${psString(CLEAN_BASE_FACTORY_ACCEPTANCE_FILE_NAME)}
  $preparationOutputPath = Join-Path $runRoot "factory-runtime-preparation.json"
  $verificationOutputPath = Join-Path $runRoot "factory-runtime-verification-action.json"
  $verifierEvidencePath = Join-Path $runRoot "factory-runtime-verification.json"
  $diagnostics = [System.Collections.Generic.List[object]]::new()
  $identity = $null
  $personalizationEvidence = $null
  $preflightAbsence = @()
  $staged = $null

  try {
    $identity = Get-CleanBaseFactoryIdentity
    Assert-CleanBaseFactoryIdentitySafety $identity
    $FactoryActions.Add([pscustomobject]@{
      name = "guard clean-base source identity"
      status = "succeeded"
      message = $null
      identity = $identity
    }) | Out-Null
  } catch {
    Add-FactoryAcceptanceDiagnostic $diagnostics "clean_base_identity_refused" ([string]$_) $identity
    $FactoryActions.Add([pscustomobject]@{
      name = "guard clean-base source identity"
      status = "failed"
      message = [string]$_
      identity = $identity
    }) | Out-Null
  }

  if ($diagnostics.Count -eq 0) {
    try {
      $personalizationEvidence = [ordered]@{
        profile = ${psString(cleanBaseFactoryProfile)}
        source = "trusted_protected_gate"
        credentials = "not_logged"
        wireGuardPrivateKey = "not-supplied; generated-locally"
      }
      if (-not [string]::IsNullOrWhiteSpace(${psString(options.remotePersonalizationMediaPath ?? "")})) {
        $FactoryActions.Add([pscustomobject]@{
          name = "mount clean-base Factory Personalization Media"
          status = "succeeded"
          message = $null
          personalizationEvidence = $personalizationEvidence
        }) | Out-Null
      } else {
        throw "Factory Personalization Media staging path is missing"
      }
    } catch {
      Add-FactoryAcceptanceDiagnostic $diagnostics "factory_personalization_failed" ([string]$_) $personalizationEvidence
      $FactoryActions.Add([pscustomobject]@{
        name = "mount clean-base Factory Personalization Media"
        status = "failed"
        message = [string]$_
        personalizationEvidence = $personalizationEvidence
      }) | Out-Null
    }
  }

  if ($diagnostics.Count -eq 0) {
    try {
      $preflightAbsence = Assert-CleanBasePreflightAbsence
      $FactoryActions.Add([pscustomobject]@{
        name = "verify clean-base preflight absence"
        status = "succeeded"
        message = $null
        probes = @($preflightAbsence)
      }) | Out-Null
    } catch {
      Add-FactoryAcceptanceDiagnostic $diagnostics "clean_base_preflight_failed" ([string]$_) @($preflightAbsence)
      $FactoryActions.Add([pscustomobject]@{
        name = "verify clean-base preflight absence"
        status = "failed"
        message = [string]$_
        probes = @($preflightAbsence)
      }) | Out-Null
    }
  }

  if ($diagnostics.Count -eq 0) {
    try {
      $staged = Copy-FactoryAcceptanceInputs $stageRoot
      $FactoryActions.Add([pscustomobject]@{
        name = "stage clean-base factory inputs"
        status = "succeeded"
        message = $null
        evidenceRoot = $runRoot
        stageRoot = $stageRoot
        staged = $staged
      }) | Out-Null
    } catch {
      Add-FactoryAcceptanceDiagnostic $diagnostics "factory_input_staging_failed" ([string]$_)
      $FactoryActions.Add([pscustomobject]@{
        name = "stage clean-base factory inputs"
        status = "failed"
        message = [string]$_
        evidenceRoot = $runRoot
        staged = $null
      }) | Out-Null
    }
  }

  if ($diagnostics.Count -eq 0 -and $null -ne $staged) {
    Invoke-FactoryChildPowerShell -Actions $FactoryActions -Name "run scripted clean-base factory runtime preparation" -ScriptPath ([string]$staged.prepareScript) -Arguments @{
      DaemonArtifactPath = [string]$staged.daemonArtifactPath
      DaemonSha256 = [string]$staged.daemonSha256
      MachineUiArtifactPath = [string]$staged.machineUiArtifactPath
      MachineUiSha256 = [string]$staged.machineUiSha256
      EnvironmentName = ${psString(cleanBaseEnvironmentName)}
      DeploymentBatch = ${psString(`clean-base-${cleanBaseFactoryProfile}-v1`)}
      ProvisioningEndpoint = ${psString(platform.apiBaseUrl)}
      MqttUrl = ${psString(platform.mqttUrl)}
      HardwareMode = ${psString(cleanBaseHardwareMode)}
      HardwareModel = ${psString(options.factoryHardwareModel ?? "")}
      TopologyIdentity = ${psString(options.factoryTopologyIdentity ?? "")}
      TopologyVersion = ${psString(options.factoryTopologyVersion ?? "")}
      ExpectedDisplayWidth = "1080"
      ExpectedDisplayHeight = "1920"
      ExpectedDisplayOrientation = "portrait"
      ExpectedKioskUser = "VEMKiosk"
      ExpectedMaintenanceUser = ${psString(cleanBaseMaintenanceUser)}
      ExpectedAutoLogonUser = "VEMKiosk"
      ExpectedKioskShell = '"C:\\VEM\\bringup\\machine.exe"'
      TargetLayoutVersion = "win10-runtime-layout/v1"
      FactoryProfile = ${psString(cleanBaseFactoryProfile)}
      FactoryMediaRoot = ${psString(cleanBaseFactoryMediaRoot)}
      VisionConfigurationSourcePath = ${psString(cleanBaseVisionConfigurationSourcePath)}
      PersonalizationMediaPath = ${psString(options.remotePersonalizationMediaPath ?? "")}
      ResetExistingVemState = $false
      OpenSshPackagePath = ${psString(options.remoteOpenSshPackagePath ?? "")}
      OpenSshPackageSource = "local-pinned"
      OpenSshPackageVersion = ${psString(options.openSshPackageVersion ?? "")}
      OpenSshPackageSha256 = ${psString(options.openSshPackageSha256 ?? "")}
      OpenSshApprovedSignerThumbprint = ${psString(options.openSshApprovedSignerThumbprint ?? "")}
      OpenSshApprovedRootThumbprint = ${psString(options.openSshApprovedRootThumbprint ?? "")}
      WireGuardPackagePath = ${psString(options.remoteWireGuardPackagePath ?? "")}
      WireGuardPackageSource = "local-pinned"
      WireGuardPackageVersion = ${psString(options.wireGuardPackageVersion ?? "")}
      WireGuardPackageSha256 = ${psString(options.wireGuardPackageSha256 ?? "")}
      WireGuardApprovedSignerThumbprint = ${psString(options.wireGuardApprovedSignerThumbprint ?? "")}
      WireGuardApprovedRootThumbprint = ${psString(options.wireGuardApprovedRootThumbprint ?? "")}
      MaintenanceSshCaPublicKeyPath = ${psString(options.remoteMaintenanceCaPublicKeyPath ?? "")}
      MaintenanceSshCaPublicKeySha256 = ${psString(options.maintenanceCaPublicKeySha256 ?? "")}
      MaintenanceRunnerSourceAllowlist = ${psArray(splitCsvOption(options.maintenanceRunnerSourceAllowlist))}
      MaintenanceMaintainerSourceAllowlist = ${psArray(splitCsvOption(options.maintenanceMaintainerSourceAllowlist))}
      MaintenanceWireGuardListenAddress = ${psString(options.maintenanceWireGuardListenAddress ?? "")}
    } -OutputPath $preparationOutputPath -WriteStructuredJsonOutput $true
    $preparationAction = @($FactoryActions | Where-Object { [string]$_.name -eq "run scripted clean-base factory runtime preparation" } | Select-Object -Last 1)
    if ($preparationAction.Count -eq 0 -or [string]$preparationAction[0].status -ne "succeeded") {
      Add-FactoryAcceptanceDiagnostic $diagnostics "factory_preparation_failed" "Factory runtime preparation failed." $preparationAction[0]
    }
  }

  if ($diagnostics.Count -eq 0 -and $null -ne $staged) {
    Invoke-FactoryChildPowerShell -Actions $FactoryActions -Name "run scripted clean-base factory runtime verifier" -ScriptPath ([string]$staged.verifierScript) -Arguments @{
      ManifestPath = "C:\\ProgramData\\VEM\\factory\\factory-runtime-manifest.json"
      EvidencePath = $verifierEvidencePath
    } -OutputPath $verificationOutputPath -WriteStructuredJsonOutput $true
    $verifierAction = @($FactoryActions | Where-Object { [string]$_.name -eq "run scripted clean-base factory runtime verifier" } | Select-Object -Last 1)
    if ($verifierAction.Count -eq 0 -or [string]$verifierAction[0].status -ne "succeeded") {
      Add-FactoryAcceptanceDiagnostic $diagnostics "factory_verifier_failed" "Factory runtime verifier failed." $verifierAction[0]
    }
  }

  $verifierEvidence = if (Test-Path -LiteralPath $verifierEvidencePath -PathType Leaf) {
    Read-JsonFile $verifierEvidencePath
  } else {
    $null
  }
  if ($diagnostics.Count -eq 0 -and ($null -eq $verifierEvidence -or [bool]$verifierEvidence.ok -ne $true)) {
    Add-FactoryAcceptanceDiagnostic $diagnostics "factory_verifier_failed" "Factory runtime verifier evidence did not pass." $verifierEvidence
  }

  $factoryWindowsBaselinePolicy = ${psString(factoryWindowsBaselinePolicyJson)} | ConvertFrom-Json
  $assertions = if ($null -ne $verifierEvidence) {
    Convert-CleanBaseFactoryAssertions $verifierEvidence $preflightAbsence
  } else {
    [ordered]@{
      runtimeResetGateClean = [ordered]@{ status = if ($preflightAbsence.Count -gt 0) { "passed" } else { "failed" }; preflightAbsence = @($preflightAbsence) }
    }
  }
  $assertionsPassed = Test-CleanBaseFactoryAssertionsPassed $assertions
  if ($diagnostics.Count -eq 0 -and -not $assertionsPassed) {
    Add-FactoryAcceptanceDiagnostic $diagnostics "clean_base_assertions_failed" "One or more converted clean-base assertions did not pass." $assertions
  }
  $passed = $diagnostics.Count -eq 0 -and $assertionsPassed
  $report = [ordered]@{
    schemaVersion = "clean-base-factory-acceptance-report/v1"
    kind = "clean-base-factory-acceptance"
    runId = $runId
    result = if ($passed) { "passed" } else { "failed" }
    ok = $passed
    dryRun = $false
    factoryProfile = ${psString(cleanBaseFactoryProfile)}
    source = [ordered]@{
      kind = "clean-windows-base"
      uri = ${psString(cleanBaseSource)}
      snapshot = ${psString(cleanBaseSnapshot)}
      identity = $identity
    }
    factoryWindowsBaselinePolicy = $factoryWindowsBaselinePolicy
    artifacts = [ordered]@{
      daemonSha256 = if ($null -ne $staged) { [string]$staged.daemonSha256 } else { ${psString(expectedDaemonArtifactSha256)} }
      machineUiSha256 = if ($null -ne $staged) { [string]$staged.machineUiSha256 } else { ${psString(expectedMachineUiArtifactSha256)} }
      source = if ($null -ne $staged) { [string]$staged.artifactSource } else { "uploaded_local_artifacts" }
      webView2Sidecar = if ($null -ne $staged) { [string]$staged.machineUiSidecarPath } else { $null }
    }
    readiness = [ordered]@{
      cleanBasePreparationAcceptance = if ($passed) { "passed" } else { "failed" }
      runtimeReady = "not_asserted"
      simulatedHardwareReady = "not_asserted"
      sellReady = "not_asserted"
    }
    assertions = $assertions
    diagnostics = @($diagnostics)
    evidence = [ordered]@{
      factoryProfile = ${psString(cleanBaseFactoryProfile)}
      preparationOutput = $preparationOutputPath
      verificationAction = $verificationOutputPath
      verifierEvidence = $verifierEvidencePath
      factoryRuntimeVerification = $verifierEvidence
      preflightAbsence = @($preflightAbsence)
      actions = @($FactoryActions)
    }
  }
  Write-JsonFile $acceptancePath ([pscustomobject]$report)
  return [ordered]@{
    runId = $runId
    evidenceRoot = $runRoot
    acceptancePath = $acceptancePath
    preparationOutputPath = $preparationOutputPath
    verificationOutputPath = $verificationOutputPath
    verifierEvidencePath = $verifierEvidencePath
    staged = $staged
    identity = $identity
    personalizationEvidence = $personalizationEvidence
    preflightAbsence = @($preflightAbsence)
    report = $report
  }
}

function Test-ReadyFileReadableByKioskUser([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) {
    return $false
  }
  try {
    $acl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    foreach ($rule in @($acl.Access)) {
      $identity = [string]$rule.IdentityReference
      $rights = [string]$rule.FileSystemRights
      if (
        $rule.AccessControlType -eq "Allow" -and
        ($identity.EndsWith("\\VEMKiosk", [StringComparison]::OrdinalIgnoreCase) -or
          $identity -eq "BUILTIN\\Users" -or
          $identity -eq "Everyone") -and
        ($rights.Contains("Read") -or $rights.Contains("FullControl"))
      ) {
        return $true
      }
    }
  } catch {
    return $false
  }
  return $false
}

function Convert-DaemonRuntimeEvidence($DaemonIpc) {
  return [ordered]@{
    ipcReachable = [bool]$DaemonIpc.healthz.observed -or [bool]$DaemonIpc.readyz.observed -or [bool]$DaemonIpc.config.observed
    healthz = [ordered]@{
      backendOnline = [bool]$DaemonIpc.healthz.backendOnline
      mqttConnected = [bool]$DaemonIpc.healthz.mqttConnected
      hardwareOnline = [bool]$DaemonIpc.healthz.hardwareOnline
      scannerOnline = [bool]$DaemonIpc.healthz.scannerOnline
    }
    readyz = [ordered]@{
      ready = [bool]$DaemonIpc.readyz.ready
    }
  }
}

function New-RuntimeAcceptanceAssertion([string]$Status, [bool]$Asserted) {
  return [ordered]@{
    status = $Status
    asserted = $Asserted
  }
}

function Add-RuntimeAcceptanceDiagnostic($Diagnostics, [string]$Code, [string]$Message) {
  $Diagnostics.Add([ordered]@{
    code = $Code
    message = $Message
  }) | Out-Null
}

function Get-VisionLoopbackListenerBinding([int]$ExpectedProcessId) {
  $listeners = $null
  $source = $null
  if ($null -ne (Get-Command -Name Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
    try {
      $listeners = @(Get-NetTCPConnection -State Listen -LocalPort 7892 -ErrorAction Stop | Where-Object {
        [string]$_.LocalAddress -ceq "127.0.0.1"
      })
      $source = "Get-NetTCPConnection"
    } catch {
      $listeners = $null
    }
  }
  if ($null -eq $listeners) {
    $netstatPath = Join-Path $env:SystemRoot "System32\\netstat.exe"
    $listeners = @()
    foreach ($line in @(& $netstatPath -ano -p tcp)) {
      $match = [regex]::Match([string]$line, '^\\s*TCP\\s+127\\.0\\.0\\.1:7892\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$')
      if ($match.Success) {
        $listeners += [pscustomobject]@{ OwningProcess = $match.Groups[1].Value }
      }
    }
    $source = "netstat"
  }
  if ($listeners.Count -ne 1) {
    throw "Vision must have exactly one 127.0.0.1:7892 LISTEN owner; found $($listeners.Count)"
  }
  [int]$listenerProcessId = 0
  if (
    -not [int]::TryParse([string]$listeners[0].OwningProcess, [ref]$listenerProcessId) -or
    $listenerProcessId -lt 1
  ) {
    throw "Vision 127.0.0.1:7892 LISTEN owner has an invalid process identity"
  }
  if ($listenerProcessId -ne $ExpectedProcessId) {
    throw "Vision selected active process $ExpectedProcessId does not own 127.0.0.1:7892 LISTEN (owner $listenerProcessId)"
  }
  return [ordered]@{
    processId = $listenerProcessId
    ownerCount = $listeners.Count
    source = $source
  }
}

function Test-VisionProtocolTimestamp($Value) {
  if ($Value -isnot [string] -or $Value -notmatch '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$') {
    return $false
  }
  $timestampWithoutFraction = [regex]::Replace($Value, '\\.\\d+(?=Z$)', '')
  [DateTime]$parsed = [DateTime]::MinValue
  return [DateTime]::TryParseExact(
    $timestampWithoutFraction,
    "yyyy-MM-dd'T'HH:mm:ss'Z'",
    [Globalization.CultureInfo]::InvariantCulture,
    ([Globalization.DateTimeStyles]::AssumeUniversal -bor [Globalization.DateTimeStyles]::AdjustToUniversal),
    [ref]$parsed
  )
}

function Get-VisionInstalledRuntimeBinding {
  $selectionPath = "C:\\ProgramData\\VEM\\vision\\current.json"
  $activeProcessPath = "C:\\ProgramData\\VEM\\vision\\process-state\\active-process.json"
  if (-not (Test-Path -LiteralPath $selectionPath -PathType Leaf)) {
    throw "Vision current selection is missing"
  }
  if (-not (Test-Path -LiteralPath $activeProcessPath -PathType Leaf)) {
    throw "Vision active process record is missing"
  }
  $selection = Get-Content -LiteralPath $selectionPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  foreach ($name in @("revision", "bundleDigest", "installDirectory", "entrypoint", "metadataPath")) {
    if ($null -eq $selection.PSObject.Properties[$name] -or [string]::IsNullOrWhiteSpace([string]$selection.$name)) {
      throw "Vision current selection is missing $name"
    }
  }
  $metadata = Get-Content -LiteralPath ([string]$selection.metadataPath) -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  foreach ($name in @("bundleDigest", "installDirectory", "entrypoint", "entrypointDigest", "descriptor")) {
    if ($null -eq $metadata.PSObject.Properties[$name]) {
      throw "Vision release metadata is missing $name"
    }
  }
  if (
    $metadata.bundleDigest -cne $selection.bundleDigest -or
    $metadata.installDirectory -cne $selection.installDirectory -or
    $metadata.entrypoint -cne $selection.entrypoint -or
    $null -eq $metadata.descriptor.PSObject.Properties["releaseVersion"] -or
    [string]::IsNullOrWhiteSpace([string]$metadata.descriptor.releaseVersion)
  ) {
    throw "Vision release metadata does not bind the current selection"
  }
  $entrypoint = [IO.Path]::GetFullPath((Join-Path ([string]$selection.installDirectory) ([string]$selection.entrypoint)))
  if (-not (Test-Path -LiteralPath $entrypoint -PathType Leaf)) {
    throw "Vision selected entrypoint is missing"
  }
  $active = Get-Content -LiteralPath $activeProcessPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  $activeKeys = @($active.PSObject.Properties.Name | Sort-Object)
  $expectedActiveKeys = @("bundleDigest", "creationTimeUtcTicks", "executableDigest", "executablePath", "processId", "selectionRevision" | Sort-Object)
  if (
    ($activeKeys -join "|") -cne ($expectedActiveKeys -join "|") -or
    $active.bundleDigest -cne $selection.bundleDigest -or
    $active.selectionRevision -cne $selection.revision -or
    $active.executablePath -cne $entrypoint -or
    $active.executableDigest -cne $metadata.entrypointDigest
  ) {
    throw "Vision active process record does not bind the current selection"
  }
  [int]$processId = 0
  if (
    -not [int]::TryParse([string]$active.processId, [ref]$processId) -or
    $processId -lt 1 -or
    $active.creationTimeUtcTicks -isnot [Int64] -or
    $active.creationTimeUtcTicks -lt 1
  ) {
    throw "Vision active process record has an invalid process identity"
  }
  $process = Get-Process -Id $processId -ErrorAction Stop
  try {
    if (
      $process.HasExited -or
      $process.StartTime.ToUniversalTime().Ticks -ne $active.creationTimeUtcTicks -or
      $process.Path -cne $entrypoint -or
      ("sha256:" + (Get-FileHash -LiteralPath $process.Path -Algorithm SHA256).Hash.ToLowerInvariant()) -cne $metadata.entrypointDigest
    ) {
      throw "Vision active process does not bind the selected executable"
    }
  } finally {
    $process.Dispose()
  }
  $listenerBinding = Get-VisionLoopbackListenerBinding -ExpectedProcessId $processId
  return [ordered]@{
    bound = $true
    releaseVersion = [string]$metadata.descriptor.releaseVersion
    bundleDigest = [string]$selection.bundleDigest
    selectionRevision = [string]$selection.revision
    processId = $processId
    executablePath = $entrypoint
    listenerProcessId = $listenerBinding.processId
    listenerOwnerCount = $listenerBinding.ownerCount
    listenerBindingSource = $listenerBinding.source
  }
}

function Get-VisionRuntimeEvidence {
  $evidence = [ordered]@{
    healthReachable = $false
    healthStatus = $null
    healthProtocol = $null
    healthModule = $null
    healthMockScenario = $null
    version = $null
    cameraReady = $null
    modelReady = $null
    installedProcessBound = $false
    selectedReleaseVersion = $null
    activeProcessId = $null
    listenerBound = $false
    listenerProcessId = $null
    listenerOwnerCount = $null
    listenerBindingSource = $null
    webSocketConnected = $false
    readyProtocol = $null
    readyType = $null
    readyMessageId = $null
    readyTimestamp = $null
    readyServerName = $null
    readyServerVersion = $null
    readyCameraReady = $null
    readyModelReady = $null
    readyCapabilities = @()
    error = $null
  }
  $deadline = (Get-Date).AddSeconds(45)
  $lastError = $null
  while ((Get-Date) -lt $deadline) {
    $socket = $null
    $cancellation = $null
    try {
      $runtimeBinding = Get-VisionInstalledRuntimeBinding
      $evidence.installedProcessBound = [bool]$runtimeBinding.bound
      $evidence.selectedReleaseVersion = [string]$runtimeBinding.releaseVersion
      $evidence.activeProcessId = $runtimeBinding.processId
      $evidence.listenerBound = $true
      $evidence.listenerProcessId = $runtimeBinding.listenerProcessId
      $evidence.listenerOwnerCount = $runtimeBinding.listenerOwnerCount
      $evidence.listenerBindingSource = [string]$runtimeBinding.listenerBindingSource
      $remainingSeconds = [Math]::Max(1, [Math]::Ceiling(($deadline - (Get-Date)).TotalSeconds))
      $healthTimeoutSeconds = [Math]::Min(3, $remainingSeconds)
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:7892/health" -Method Get -TimeoutSec $healthTimeoutSeconds -ErrorAction Stop
      if (
        $health.status -isnot [string] -or
        $health.status -notin @("ok", "degraded") -or
        $health.module -isnot [string] -or
        $health.module -cne "vision" -or
        $health.protocol -isnot [string] -or
        $health.protocol -cne "vem.vision.v1" -or
        $health.version -isnot [string] -or
        [string]::IsNullOrWhiteSpace($health.version) -or
        $health.version -cne $runtimeBinding.releaseVersion -or
        $health.mockScenario -isnot [bool] -or
        $health.mockScenario -ne $false -or
        $health.cameraReady -isnot [bool] -or
        $health.modelReady -isnot [bool] -or
        $health.modelReady -ne $true
      ) {
        throw "Vision health does not satisfy the selected installed runtime contract"
      }
      $evidence.healthReachable = $true
      $evidence.healthStatus = [string]$health.status
      $evidence.healthProtocol = [string]$health.protocol
      $evidence.healthModule = [string]$health.module
      $evidence.healthMockScenario = $health.mockScenario
      $evidence.version = [string]$health.version
      $evidence.cameraReady = $health.cameraReady
      $evidence.modelReady = $health.modelReady

      $socket = [Net.WebSockets.ClientWebSocket]::new()
      $socket.Options.SetRequestHeader("Origin", "http://tauri.localhost")
      $webSocketTimeoutSeconds = [Math]::Min(5, $remainingSeconds)
      $cancellation = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds($webSocketTimeoutSeconds))
      $socket.ConnectAsync([Uri]"ws://127.0.0.1:7892/ws", $cancellation.Token).GetAwaiter().GetResult()
      $message = [ordered]@{
        protocol = "vem.vision.v1"
        type = "vision.hello"
        messageId = "factory-runtime-hello"
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        payload = [ordered]@{
          protocolVersion = 1
          capabilities = @("profile_push", "presence_status", "person_departed", "ambient_light", "try_on_session")
          clientRole = "machine"
          machineCode = "VEM-TESTBED-RUNTIME-ACCEPTANCE"
        }
      }
      $messageBytes = [Text.Encoding]::UTF8.GetBytes(($message | ConvertTo-Json -Depth 8 -Compress))
      $sendSegment = [ArraySegment[byte]]::new($messageBytes)
      $socket.SendAsync($sendSegment, [Net.WebSockets.WebSocketMessageType]::Text, $true, $cancellation.Token).GetAwaiter().GetResult()
      $maxMessageBytes = 65536
      $messageStream = New-Object IO.MemoryStream
      try {
        do {
          $buffer = New-Object byte[] 4096
          $received = $socket.ReceiveAsync([ArraySegment[byte]]::new($buffer), $cancellation.Token).GetAwaiter().GetResult()
          if ($received.MessageType -ne [Net.WebSockets.WebSocketMessageType]::Text) {
            throw "Vision handshake must return a text message"
          }
          if (($messageStream.Length + $received.Count) -gt $maxMessageBytes) {
            throw "Vision handshake response exceeds $maxMessageBytes bytes"
          }
          if ($received.Count -gt 0) {
            $messageStream.Write($buffer, 0, $received.Count)
          }
        } while (-not $received.EndOfMessage)
        $ready = [Text.Encoding]::UTF8.GetString($messageStream.ToArray()) | ConvertFrom-Json -ErrorAction Stop
      } finally {
        $messageStream.Dispose()
      }
      $requiredCapabilities = @("profile_push", "presence_status", "person_departed", "ambient_light", "try_on_session")
      if (
        $null -eq $ready -or
        $ready.protocol -isnot [string] -or
        $ready.protocol -cne "vem.vision.v1" -or
        $ready.type -isnot [string] -or
        $ready.type -cne "vision.ready" -or
        $ready.messageId -isnot [string] -or
        [string]::IsNullOrWhiteSpace($ready.messageId) -or
        $ready.messageId.Length -gt 128 -or
        -not (Test-VisionProtocolTimestamp $ready.timestamp) -or
        $null -eq $ready.PSObject.Properties["payload"] -or
        $ready.payload -isnot [System.Management.Automation.PSCustomObject] -or
        $ready.payload.serverName -isnot [string] -or
        [string]::IsNullOrWhiteSpace($ready.payload.serverName) -or
        $ready.payload.serverName.Length -gt 128 -or
        $ready.payload.serverVersion -isnot [string] -or
        [string]::IsNullOrWhiteSpace($ready.payload.serverVersion) -or
        $ready.payload.serverVersion.Length -gt 64 -or
        $ready.payload.serverVersion -cne $health.version -or
        $ready.payload.cameraReady -isnot [bool] -or
        $ready.payload.cameraReady -ne $health.cameraReady -or
        $ready.payload.modelReady -isnot [bool] -or
        $ready.payload.modelReady -ne $true -or
        $ready.payload.modelReady -ne $health.modelReady -or
        $ready.payload.capabilities -isnot [array] -or
        (@($ready.payload.capabilities | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) -or $_.Length -gt 64 }).Count -ne 0) -or
        (@($requiredCapabilities | Where-Object { $ready.payload.capabilities -cnotcontains $_ }).Count -ne 0)
      ) {
        throw "Vision WebSocket ready does not satisfy the selected installed runtime contract"
      }
      $evidence.webSocketConnected = $true
      $evidence.readyProtocol = [string]$ready.protocol
      $evidence.readyType = [string]$ready.type
      $evidence.readyMessageId = [string]$ready.messageId
      $evidence.readyTimestamp = [string]$ready.timestamp
      $evidence.readyServerName = [string]$ready.payload.serverName
      $evidence.readyServerVersion = [string]$ready.payload.serverVersion
      $evidence.readyCameraReady = $ready.payload.cameraReady
      $evidence.readyModelReady = $ready.payload.modelReady
      $evidence.readyCapabilities = @($ready.payload.capabilities)
      return $evidence
    } catch {
      $lastError = $_
    } finally {
      if ($null -ne $socket) { $socket.Dispose() }
      if ($null -ne $cancellation) { $cancellation.Dispose() }
    }
    if ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 500
    }
  }
  $evidence.error = "Vision runtime did not become ready within 45 seconds: $lastError"
  return $evidence
}

function Test-RuntimeAcceptanceTauriHashRouteUrl([string]$Url) {
  return Test-TauriHashRouteUrl $Url
}

function Classify-RuntimeAcceptanceReport($Facts) {
  $diagnostics = [System.Collections.Generic.List[object]]::new()
  $zeroHash = "0000000000000000000000000000000000000000000000000000000000000000"

  if (-not ([string]$Facts.target.machineCode).StartsWith("VEM-TESTBED-", [StringComparison]::Ordinal)) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "testbed_machine_identity_required" "Machine Runtime Testbed MVP reports must use a VEM-TESTBED-* machine identity."
  }
  $observedMachineCode = if ($null -ne $Facts.provisioning) { [string]$Facts.provisioning.machineCode } else { "" }
  if ([string]::IsNullOrWhiteSpace($observedMachineCode)) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_config_machine_identity_missing" "Runtime acceptance must include the daemon-observed machine identity from config IPC."
  } elseif (-not $observedMachineCode.StartsWith("VEM-TESTBED-", [StringComparison]::Ordinal)) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_config_machine_identity_required" "Daemon-observed machine identity must be a VEM-TESTBED-* machine identity."
  } elseif ($observedMachineCode -ne [string]$Facts.target.machineCode) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_config_machine_identity_mismatch" "Daemon-observed machine identity must match the requested testbed target."
  }
  if ($Facts.artifacts.daemonSha256 -eq $zeroHash) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_artifact_hash_missing" "Runtime acceptance requires a SHA-256 hash for vending-daemon.exe."
  }
  if ($Facts.artifacts.machineUiSha256 -eq $zeroHash) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_ui_artifact_hash_missing" "Runtime acceptance requires a SHA-256 hash for machine.exe."
  }
  if (-not [bool]$Facts.readyFile.exists) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "ready_file_missing" "Daemon ready file must exist before runtime-ready can pass."
  }
  if (-not [bool]$Facts.readyFile.readableByKioskUser) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "ready_file_not_readable_by_kiosk" "Daemon ready file must be readable by the VEMKiosk user."
  }
  if (-not [bool]$Facts.readyFile.ipcEndpointPresent -or -not [bool]$Facts.readyFile.tokenPresent) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_ipc_handoff_missing" "Ready file must include the daemon IPC endpoint and token."
  }
  if (-not [bool]$Facts.daemonRuntime.ipcReachable) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_ipc_unreachable" "Daemon IPC must be reachable through the ready-file handoff."
  }
  if (
    -not [bool]$Facts.serviceState.daemonService.installed -or
    -not [bool]$Facts.serviceState.daemonService.running -or
    [string]$Facts.serviceState.daemonService.startupType -ne "automatic"
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_service_not_running" "Vending Daemon must be installed, running, and configured for automatic startup."
  }
  if ([string]$Facts.startupBringup.machineUiStartup.mode -eq "scheduled_task") {
    if (-not [bool]$Facts.serviceState.machineUiTask.exists) {
      Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_ui_task_missing" "VEMMachineUI scheduled task must exist before runtime-ready can pass."
    }
    if (-not [bool]$Facts.serviceState.machineUiTask.enabled) {
      Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_ui_task_disabled" "VEMMachineUI scheduled task must be enabled before runtime-ready can pass."
    }
    if ([string]$Facts.serviceState.machineUiTask.runAsUser -ne "VEMKiosk") {
      Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_ui_task_user_mismatch" "VEMMachineUI scheduled task must run as the VEMKiosk user."
    }
  }
  if ([string]$Facts.startupBringup.configuredBy -ne "scripts/windows/setup-scheduled-tasks.ps1" -or -not [bool]$Facts.startupBringup.productionBringup) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "production_bringup_required" "Fresh Bring-Up Acceptance must use the production bring-up script path."
  }
  if ([bool]$Facts.startupBringup.daemonOwnedInitialization) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_owned_startup_initialization" "Winlogon auto-logon and customer startup must not be daemon-owned initialization."
  }
  if (-not [bool]$Facts.startupBringup.autoLogon.configured) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "winlogon_autologon_missing" "Winlogon auto-logon must be configured by production bring-up before runtime-ready can pass."
  }
  if ([string]$Facts.startupBringup.autoLogon.user -ne "VEMKiosk") {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "winlogon_autologon_user_mismatch" "Winlogon auto-logon must target the VEMKiosk customer session."
  }
  if (-not [bool]$Facts.startupBringup.autoLogon.force) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "winlogon_force_autologon_missing" "Winlogon ForceAutoLogon must be enabled for unattended cold boot acceptance."
  }
  if (-not [bool]$Facts.startupBringup.machineUiStartup.configured) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_ui_startup_missing" "Machine UI startup must be configured by production bring-up."
  }
  if ([string]$Facts.startupBringup.machineUiStartup.runAsUser -ne "VEMKiosk") {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_ui_startup_user_mismatch" "Machine UI startup must target the VEMKiosk customer session."
  }
  if ([string]$Facts.startupBringup.machineUiStartup.mode -eq "scheduled_task") {
    $machineUiStartupCommand = @($Facts.startupBringup.startupCommands | Where-Object {
      [string]$_.name -eq "VEMMachineUI" -or [string]$_.name -eq "\\VEMMachineUI"
    } | Select-Object -First 1)

    if ($machineUiStartupCommand.Count -eq 0 -or -not [bool]$machineUiStartupCommand[0].exists) {
      Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_ui_startup_command_missing" "Production bring-up must provide live VEMMachineUI startup command evidence."
    } else {
      $commandEvidence = $machineUiStartupCommand[0]
      if (-not [bool]$commandEvidence.enabled) {
        Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_ui_startup_command_disabled" "VEMMachineUI startup command must be enabled."
      }
      if ([string]$commandEvidence.runAsUser -ne "VEMKiosk") {
        Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_ui_startup_command_user_mismatch" "VEMMachineUI startup command must run as the VEMKiosk user."
      }
      if ([string]$commandEvidence.command -ne "C:\\Windows\\System32\\wscript.exe") {
        Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_ui_startup_command_path_mismatch" "VEMMachineUI startup command must use the production wscript launcher path."
      }
      if (-not ([string]$commandEvidence.arguments).Contains("C:\\VEM\\bringup\\launch-machine-ui.vbs")) {
        Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_ui_startup_arguments_mismatch" "VEMMachineUI startup arguments must point at the production machine UI launcher."
      }
      if ([string]$commandEvidence.workingDirectory -ne "C:\\VEM\\bringup") {
        Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_ui_startup_working_directory_mismatch" "VEMMachineUI startup working directory must be the production bring-up directory."
      }
    }
  }
  if (-not [bool]$Facts.provisioning.provisioned) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_provisioning_incomplete" "Machine Provisioning must complete before runtime-ready can pass."
  }
  if (-not [bool]$Facts.provisioning.usedDaemonIpcTaskExecute) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_provisioning_bypassed_daemon_ipc" "Machine Provisioning must use the daemon IPC claim path."
  }
  if (-not [bool]$Facts.daemonRuntime.readyz.ready) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_readyz_not_ready" "Daemon readyz must report ready before runtime-ready can pass."
  }
  if (-not [bool]$Facts.daemonRuntime.healthz.backendOnline) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "backend_connectivity_failed" "Daemon health must report backend connectivity."
  }
  if (-not [bool]$Facts.daemonRuntime.healthz.mqttConnected) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "mqtt_connectivity_failed" "Daemon health must report MQTT connectivity."
  }
  if (-not [bool]$Facts.serviceState.visionTask.exists -or -not [bool]$Facts.serviceState.visionTask.enabled) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "vision_task_not_ready" "The installed Vision runtime task must exist and be enabled."
  }
  if (
    -not [bool]$Facts.visionRuntime.healthReachable -or
    [string]$Facts.visionRuntime.healthStatus -notin @("ok", "degraded") -or
    [string]$Facts.visionRuntime.healthProtocol -ne "vem.vision.v1" -or
    [string]$Facts.visionRuntime.healthModule -ne "vision" -or
    $Facts.visionRuntime.healthMockScenario -ne $false -or
    [string]::IsNullOrWhiteSpace([string]$Facts.visionRuntime.version) -or
    -not [bool]$Facts.visionRuntime.modelReady
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "vision_health_not_ready" "The installed Vision runtime must expose a healthy vem.vision.v1 service with loaded models."
  }
  if (
    -not [bool]$Facts.visionRuntime.installedProcessBound -or
    [string]::IsNullOrWhiteSpace([string]$Facts.visionRuntime.selectedReleaseVersion) -or
    [string]$Facts.visionRuntime.version -ne [string]$Facts.visionRuntime.selectedReleaseVersion -or
    $Facts.visionRuntime.activeProcessId -isnot [int] -or
    $Facts.visionRuntime.activeProcessId -lt 1 -or
    -not [bool]$Facts.visionRuntime.listenerBound -or
    $Facts.visionRuntime.listenerProcessId -isnot [int] -or
    $Facts.visionRuntime.listenerProcessId -ne $Facts.visionRuntime.activeProcessId -or
    $Facts.visionRuntime.listenerOwnerCount -ne 1 -or
    [string]$Facts.visionRuntime.listenerBindingSource -notin @("Get-NetTCPConnection", "netstat")
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "vision_installed_process_not_bound" "Vision acceptance must bind the listener to the selected installed release and its recorded active process."
  }
  if (
    -not [bool]$Facts.visionRuntime.webSocketConnected -or
    [string]$Facts.visionRuntime.readyProtocol -ne "vem.vision.v1" -or
    [string]$Facts.visionRuntime.readyType -ne "vision.ready" -or
    $Facts.visionRuntime.readyMessageId -isnot [string] -or
    [string]::IsNullOrWhiteSpace($Facts.visionRuntime.readyMessageId) -or
    $Facts.visionRuntime.readyMessageId.Length -gt 128 -or
    -not (Test-VisionProtocolTimestamp $Facts.visionRuntime.readyTimestamp) -or
    $Facts.visionRuntime.readyServerName -isnot [string] -or
    [string]::IsNullOrWhiteSpace($Facts.visionRuntime.readyServerName) -or
    $Facts.visionRuntime.readyServerName.Length -gt 128 -or
    $Facts.visionRuntime.readyServerVersion -isnot [string] -or
    [string]::IsNullOrWhiteSpace($Facts.visionRuntime.readyServerVersion) -or
    $Facts.visionRuntime.readyServerVersion.Length -gt 64 -or
    [string]$Facts.visionRuntime.readyServerVersion -ne [string]$Facts.visionRuntime.version -or
    $Facts.visionRuntime.readyCameraReady -isnot [bool] -or
    $Facts.visionRuntime.readyCameraReady -ne $Facts.visionRuntime.cameraReady -or
    $Facts.visionRuntime.readyModelReady -isnot [bool] -or
    $Facts.visionRuntime.readyModelReady -ne $true -or
    $Facts.visionRuntime.readyModelReady -ne $Facts.visionRuntime.modelReady -or
    $Facts.visionRuntime.readyCapabilities -isnot [array] -or
    (@($Facts.visionRuntime.readyCapabilities | Where-Object { $_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_) -or $_.Length -gt 64 }).Count -ne 0) -or
    (@(@("profile_push", "presence_status", "person_departed", "ambient_light", "try_on_session") | Where-Object { $Facts.visionRuntime.readyCapabilities -cnotcontains $_ }).Count -ne 0)
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "vision_protocol_not_ready" "The installed Vision runtime must complete the vem.vision.v1 hello handshake."
  }
  if (-not [bool]$Facts.kioskRuntime.webviewRunning) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "kiosk_webview_missing" "Machine Runtime Console must be running as a Tauri WebView in the active VEMKiosk session."
  }
  if ([string]$Facts.kioskRuntime.sessionUser -ne "VEMKiosk") {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "kiosk_session_user_mismatch" "Machine Runtime Console must run in the VEMKiosk customer session."
  }
  if (
    $Facts.kioskRuntime.processId -isnot [int] -or
    [int]$Facts.kioskRuntime.machineProcessCount -ne 1 -or
    [string]$Facts.kioskRuntime.machineExecutablePath -cne "C:\VEM\bringup\machine.exe"
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "kiosk_normal_process_not_unique" "Runtime acceptance requires exactly one installed machine.exe in the active VEMKiosk session."
  }
  if (
    $null -eq $Facts.kioskRuntime.sessionId -or
    $null -eq $Facts.displayEvidence.interactiveDesktopDisplayBaseline.sessionId -or
    $null -eq $Facts.displayEvidence.portraitKioskAcceptance.sessionId
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "kiosk_session_id_missing" "Runtime acceptance requires observed interactive VEMKiosk session ids."
  }
  if (
    $Facts.kioskRuntime.sessionId -ne $Facts.displayEvidence.interactiveDesktopDisplayBaseline.sessionId -or
    $Facts.kioskRuntime.sessionId -ne $Facts.displayEvidence.portraitKioskAcceptance.sessionId
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "kiosk_session_id_mismatch" "Machine Runtime Console evidence must match the active VEMKiosk interactive session."
  }
  if ($Facts.kioskDesktopEscape.desktopVisible -eq $true) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "kiosk_desktop_visible" "VEMKiosk normal UI path must not expose the Windows desktop."
  }
  if ($Facts.kioskDesktopEscape.taskbarVisible -eq $true) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "kiosk_taskbar_visible" "VEMKiosk normal UI path must not expose the Windows taskbar."
  }
  if ($Facts.kioskDesktopEscape.startMenuVisible -eq $true) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "kiosk_start_menu_visible" "VEMKiosk normal UI path must not expose the Windows Start menu."
  }
  if ($Facts.kioskDesktopEscape.edgeReachable -eq $true) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "kiosk_edge_reachable" "VEMKiosk normal UI path must not reach Microsoft Edge."
  }
  if ($Facts.kioskDesktopEscape.fileExplorerReachable -eq $true) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "kiosk_file_explorer_reachable" "VEMKiosk normal UI path must not reach File Explorer."
  }
  if ([string]$Facts.displayEvidence.portraitKioskAcceptance.sessionUser -ne "VEMKiosk") {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "portrait_kiosk_session_user_mismatch" "Portrait Kiosk Acceptance must be captured from the VEMKiosk customer session."
  }
  if (
    [string]$Facts.displayEvidence.interactiveDesktopDisplayBaseline.status -ne "passed" -or
    [int]$Facts.displayEvidence.interactiveDesktopDisplayBaseline.widthPx -ne 1080 -or
    [int]$Facts.displayEvidence.interactiveDesktopDisplayBaseline.heightPx -ne 1920
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "interactive_desktop_display_baseline_missing" "Interactive Desktop Display Baseline must pass at exactly 1080x1920 before runtime-ready can pass."
  }
  if (
    [string]$Facts.displayEvidence.portraitKioskAcceptance.status -ne "passed" -or
    [string]$Facts.displayEvidence.portraitKioskAcceptance.source -ne "interactive_kiosk_session" -or
    [int]$Facts.displayEvidence.portraitKioskAcceptance.widthPx -ne 1080 -or
    [int]$Facts.displayEvidence.portraitKioskAcceptance.heightPx -ne 1920
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "portrait_kiosk_acceptance_missing" "Portrait Kiosk Acceptance requires 1080x1920 evidence from the interactive kiosk session."
  }

  return [ordered]@{
    schemaVersion = "runtime-acceptance-report/v1"
    mode = $Facts.mode
    target = $Facts.target
    artifacts = $Facts.artifacts
    displayEvidence = $Facts.displayEvidence
    serviceState = $Facts.serviceState
    startupBringup = $Facts.startupBringup
    readyFile = $Facts.readyFile
    provisioning = $Facts.provisioning
    daemonRuntime = $Facts.daemonRuntime
    visionRuntime = $Facts.visionRuntime
    kioskRuntime = $Facts.kioskRuntime
    kioskDesktopEscape = $Facts.kioskDesktopEscape
    result = [ordered]@{
      runtimeReady = if ($diagnostics.Count -eq 0) { New-RuntimeAcceptanceAssertion "passed" $true } else { New-RuntimeAcceptanceAssertion "failed" $false }
      simulatedHardwareReady = [ordered]@{
        status = "not_asserted"
        asserted = $false
      }
      sellReady = [ordered]@{
        status = "not_asserted"
        asserted = $false
      }
    }
    diagnostics = @($diagnostics)
  }
}

function Get-RuntimeAcceptanceReport($ProvisioningActions = @()) {
  $inventory = Get-InventoryFacts $ProvisioningActions
  $factsSubset = $inventory.runtimeAcceptanceFactsSubset
  $daemonIpc = Get-DaemonIpcInventoryEvidence "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json"
  $daemonRuntime = Convert-DaemonRuntimeEvidence $daemonIpc
  $readyFilePath = "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json"
  $facts = [ordered]@{
    mode = "fresh_bring_up"
    target = $factsSubset.target
    artifacts = [ordered]@{
      daemonSha256 = Get-ArtifactSha256 "C:\\VEM\\bringup\\vending-daemon.exe"
      machineUiSha256 = Get-ArtifactSha256 "C:\\VEM\\bringup\\machine.exe"
    }
    displayEvidence = $factsSubset.displayEvidence
    serviceState = $factsSubset.serviceState
    startupBringup = $factsSubset.startupBringup
    readyFile = [ordered]@{
      exists = [bool]$daemonIpc.readyFile.exists
      readableByKioskUser = Test-ReadyFileReadableByKioskUser $readyFilePath
      ipcEndpointPresent = [bool]$daemonIpc.readyFile.ipcEndpointPresent
      tokenPresent = [bool]$daemonIpc.readyFile.tokenPresent
    }
    provisioning = [ordered]@{
      provisioned = [bool]$factsSubset.provisioning.provisioned
      usedDaemonIpcTaskExecute = [bool]$factsSubset.provisioning.usedDaemonIpcTaskExecute
      machineCode = if ([string]::IsNullOrWhiteSpace($daemonIpc.config.machineCode)) { $null } else { [string]$daemonIpc.config.machineCode }
    }
    daemonRuntime = [ordered]@{
      ipcReachable = $daemonRuntime.ipcReachable
      healthz = $daemonRuntime.healthz
      readyz = $daemonRuntime.readyz
    }
    visionRuntime = Get-VisionRuntimeEvidence
    kioskRuntime = $factsSubset.kioskRuntime
    kioskDesktopEscape = $factsSubset.kioskDesktopEscape
  }
  $runtimeAcceptanceReport = Classify-RuntimeAcceptanceReport $facts
  $runtimeAcceptanceReportPath = ${psString(RUNTIME_ACCEPTANCE_REPORT_FILE)}
  $runtimeAcceptanceReportDirectory = Split-Path -Parent $runtimeAcceptanceReportPath
  if (-not (Test-Path -LiteralPath $runtimeAcceptanceReportDirectory)) {
    New-Item -ItemType Directory -Path $runtimeAcceptanceReportDirectory -Force | Out-Null
  }
  $runtimeAcceptanceReportJson = $runtimeAcceptanceReport | ConvertTo-Json -Depth 40
  Set-Content -LiteralPath $runtimeAcceptanceReportPath -Value $runtimeAcceptanceReportJson -Encoding UTF8
  return [ordered]@{
    path = $runtimeAcceptanceReportPath
    report = $runtimeAcceptanceReport
  }
}

function Classify-SimulatedHardwareSaleFlowReport($Facts) {
  $diagnostics = [System.Collections.Generic.List[object]]::new()

  if (-not ([string]$Facts.target.machineCode).StartsWith("VEM-TESTBED-", [StringComparison]::Ordinal)) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "testbed_machine_identity_required" "Simulated hardware sale-flow evidence must use a VEM-TESTBED-* machine identity."
  }
  if ([string]$Facts.provisioning.machineCode -ne [string]$Facts.target.machineCode) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "daemon_config_machine_identity_mismatch" "Daemon-observed machine identity must match the requested testbed target."
  }
  if ([string]$Facts.runtimeState.hardwareMode -ne "simulated") {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "simulated_hardware_mode_required" "Simulated hardware sale-flow evidence must be captured in Simulated Hardware Mode."
  }
  if ([string]$Facts.runtimeState.bringUpState -ne "simulated_hardware_ready") {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "simulated_hardware_ready_state_missing" "Runtime state must report simulated_hardware_ready before simulated sale flow evidence can pass."
  }
  if (-not [bool]$Facts.runtimeState.uiDiagnosticsExplicit) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "ui_simulated_hardware_diagnostics_missing" "Machine UI diagnostics must explicitly identify Simulated Hardware Mode."
  }
  if (-not [bool]$Facts.platformSetup.ephemeral) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "ephemeral_platform_stack_required" "Simulated hardware sale-flow evidence must use an ephemeral platform stack."
  }
  if (
    [string]$Facts.platformSetup.evidenceStatus -ne "prepared" -or
    [string]$Facts.platformSetup.preparedRunId -ne [string]$Facts.provisioning.claim.runId -or
    [string]$Facts.platformSetup.target -ne [string]$Facts.target.platformTarget
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "ephemeral_platform_evidence_required" "Simulated hardware sale-flow evidence must prove ephemeral platform setup for the same run and target."
  }
  if (
    (Test-SharedPlatformTarget $Facts.target.platformTarget) -or
    (Test-SharedPlatformTarget $Facts.platformSetup.target) -or
    (Test-SharedPlatformTarget $Facts.platformSetup.apiBaseUrl) -or
    (Test-SharedPlatformTarget $Facts.platformSetup.mqttUrl)
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "shared_platform_target_rejected" "Simulated hardware sale-flow evidence must not target the shared vem-vps platform."
  }
  if (-not [bool]$Facts.platformSetup.mockPaymentReady) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "mock_payment_readiness_missing" "Ephemeral platform setup must prepare mock payment readiness for the sale flow."
  }
  if (
    -not [bool]$Facts.provisioning.provisioned -or
    -not [bool]$Facts.provisioning.usedMachineClaimCodePath -or
    -not [bool]$Facts.provisioning.usedDaemonIpcTaskExecute -or
    -not [bool]$Facts.provisioning.profileApplied -or
    [string]$Facts.provisioning.profile.status -ne "applied" -or
    -not [bool]$Facts.provisioning.profile.machineSecretConfigured -or
    -not [bool]$Facts.provisioning.profile.mqttSigningSecretConfigured
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "machine_claim_profile_path_incomplete" "Testbed provisioning must use the Machine Claim Code path through daemon IPC and apply the platform profile."
  }
  if (
    [string]$Facts.provisioning.claim.runId -ne [string]$Facts.platformSetup.preparedRunId -or
    [string]$Facts.provisioning.claim.status -ne "provisioned" -or
    -not ([string]$Facts.provisioning.claim.endpoint).EndsWith("/v1/bring-up/tasks/execute", [StringComparison]::OrdinalIgnoreCase) -or
    [int]$Facts.provisioning.claim.httpStatus -ne 200
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "fresh_machine_claim_evidence_required" "Simulated hardware sale-flow evidence must include a successful daemon IPC claim from the same run."
  }
  if (-not [bool]$Facts.topology.verified) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "hardware_topology_not_verified" "Daemon must verify the expected hardware slot topology before simulated sale flow."
  }
  $lowerControllerPort = [string]$Facts.daemonSerialConfiguration.lowerControllerPort
  $scannerPort = [string]$Facts.daemonSerialConfiguration.scannerPort
  if ([string]$Facts.daemonSerialConfiguration.hardwareAdapter -ne "serial") {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "serial_lower_controller_adapter_required" "Simulated hardware acceptance requires hardwareAdapter=serial; daemon mock adapters are not serial evidence."
  }
  if ([string]$Facts.daemonSerialConfiguration.scannerAdapter -ne "serial_text") {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "serial_scanner_adapter_required" "Simulated hardware acceptance requires scannerAdapter=serial_text."
  }
  if (
    -not (Test-WindowsComPath $lowerControllerPort) -or
    -not (Test-WindowsComPath $scannerPort) -or
    -not [bool]$Facts.daemonSerialConfiguration.lowerControllerPortObserved -or
    -not [bool]$Facts.daemonSerialConfiguration.scannerPortObserved
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "windows_com_path_evidence_required" "Both daemon adapters must use observed Windows COM paths; TCP and unobserved paths are not acceptance evidence."
  }
  if (
    [string]::IsNullOrWhiteSpace($lowerControllerPort) -or
    [string]::IsNullOrWhiteSpace($scannerPort) -or
    $lowerControllerPort.Equals($scannerPort, [StringComparison]::OrdinalIgnoreCase)
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "distinct_virtual_com_mapping_required" "Lower-controller and scanner evidence must bind two distinct virtual COM mappings."
  }
  if (
    -not [bool]$Facts.planogram.syncedFromPlatform -or
    -not [bool]$Facts.planogram.applied -or
    -not [bool]$Facts.planogram.acknowledged -or
    [string]$Facts.planogram.syncStatus -ne "acknowledged" -or
    [string]::IsNullOrWhiteSpace($Facts.planogram.acknowledgmentId)
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "platform_planogram_not_acknowledged" "Daemon must sync, apply, and acknowledge the platform planogram before simulated sale flow."
  }
  if ([string]$Facts.stock.planogramVersion -ne [string]$Facts.planogram.planogramVersion) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "stock_planogram_mismatch" "Initial stock evidence must be recorded against the active acknowledged planogram."
  }
  if ([int]$Facts.stock.saleableSlots -lt 1 -or [int]$Facts.stock.totalOnHand -lt 1) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "initial_stock_missing" "Initial stock must be established through stock attestation or stock movement paths."
  }
  if ([string]$Facts.stock.uploadStatus -ne "accepted" -or [string]::IsNullOrWhiteSpace($Facts.stock.platformMovementId)) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "stock_upload_not_accepted" "Initial stock evidence must include an accepted platform stock movement or attestation upload."
  }
  if (
    -not [bool]$Facts.sale.saleViewReady -or
    [string]::IsNullOrWhiteSpace($Facts.sale.orderId) -or
    [string]::IsNullOrWhiteSpace($Facts.sale.orderNo) -or
    [string]$Facts.sale.orderStatus -ne "fulfilled" -or
    [string]$Facts.sale.paymentMethod -ne "payment_code" -or
    [string]$Facts.sale.paymentProviderCode -ne "mock" -or
    [string]::IsNullOrWhiteSpace($Facts.sale.paymentId) -or
    [string]::IsNullOrWhiteSpace($Facts.sale.paymentNo) -or
    [string]$Facts.sale.paymentStatus -ne "succeeded" -or
    -not [bool]$Facts.sale.paymentSucceeded -or
    [string]::IsNullOrWhiteSpace($Facts.sale.vendingCommandId) -or
    -not [bool]$Facts.sale.dispenseSimulated -or
    [string]$Facts.sale.dispenseResult -ne "dispensed" -or
    -not [bool]$Facts.sale.dispenseSucceeded -or
    [string]$Facts.sale.customerResult -ne "success"
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "simulated_customer_sale_not_successful" "Simulated payment and simulated dispense must reach a successful customer-facing result."
  }
  if (
    [string]$Facts.platformState.paymentStatus -ne "succeeded" -or
    [string]$Facts.platformState.fulfillmentStatus -ne "dispensed" -or
    -not [bool]$Facts.platformState.stockMovementAccepted -or
    [string]$Facts.platformState.postSaleDispenseMovement.status -ne "accepted" -or
    [string]::IsNullOrWhiteSpace([string]$Facts.platformState.postSaleDispenseMovement.movementId) -or
    [string]$Facts.platformState.postSaleDispenseMovement.orderId -ne [string]$Facts.sale.orderId -or
    [string]$Facts.platformState.postSaleDispenseMovement.vendingCommandId -ne [string]$Facts.sale.vendingCommandId -or
    [int]$Facts.platformState.postSaleDispenseMovement.quantity -ne 1 -or
    [int]$Facts.platformState.postSaleDispenseMovement.deltaQuantity -ne -1 -or
    $null -eq $Facts.platformState.postSaleDispenseMovement.beforeQuantity -or
    $null -eq $Facts.platformState.postSaleDispenseMovement.afterQuantity -or
    ([int]$Facts.platformState.postSaleDispenseMovement.beforeQuantity - [int]$Facts.platformState.postSaleDispenseMovement.afterQuantity) -ne [int]$Facts.platformState.postSaleDispenseMovement.quantity
  ) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "platform_sale_state_not_updated" "Platform/testbed state must bind this fulfilled sale to an accepted post-sale dispense movement and its inventory delta."
  }

  return [ordered]@{
    schemaVersion = "simulated-hardware-sale-flow/v1"
    mode = $Facts.mode
    target = $Facts.target
    runtimeState = $Facts.runtimeState
    provisioning = $Facts.provisioning
    platformSetup = $Facts.platformSetup
    topology = $Facts.topology
    daemonSerialConfiguration = $Facts.daemonSerialConfiguration
    guestSerialEvidence = $Facts.guestSerialEvidence
    planogram = $Facts.planogram
    stock = $Facts.stock
    sale = $Facts.sale
    platformState = $Facts.platformState
    result = [ordered]@{
      simulatedHardwareReady = if ($diagnostics.Count -eq 0) { New-RuntimeAcceptanceAssertion "not_asserted" $false } else { New-RuntimeAcceptanceAssertion "failed" $false }
      sellReady = [ordered]@{
        status = "not_asserted"
        asserted = $false
      }
    }
    diagnostics = @($diagnostics)
  }
}

function Test-SharedPlatformTarget($Value) {
  $text = ([string]$Value).ToLowerInvariant()
  return $text.Contains("vem-vps") -or $text.Contains("118.25.104.160")
}

function Test-WindowsComPath([string]$Value) {
  return -not [string]::IsNullOrWhiteSpace($Value) -and $Value -match '^COM[1-9][0-9]*$'
}

function Get-WindowsComPortEvidence([string]$Port) {
  $normalizedPort = ([string]$Port).Trim().ToUpperInvariant()
  if (-not (Test-WindowsComPath $normalizedPort)) {
    return [ordered]@{ port = $null; observed = $false }
  }
  try {
    $observed = @(
      Get-CimInstance -ClassName Win32_SerialPort -ErrorAction Stop | Where-Object {
        ([string]$_.DeviceID).Equals($normalizedPort, [StringComparison]::OrdinalIgnoreCase)
      }
    ).Count -eq 1
    return [ordered]@{ port = $normalizedPort; observed = $observed }
  } catch {
    return [ordered]@{ port = $normalizedPort; observed = $false }
  }
}

function Assert-SimulatedSaleFlowPreMutationTarget($Target, $DaemonMachineCode, $DaemonApiBaseUrl, $DaemonMqttUrl, [string]$HardwareMode, $PlatformSetup) {
  if (-not ([string]$Target.machineCode).StartsWith("VEM-TESTBED-", [StringComparison]::Ordinal)) {
    return [ordered]@{ ok = $false; code = "testbed_machine_identity_required" }
  }
  if ([string]$DaemonMachineCode -ne [string]$Target.machineCode) {
    return [ordered]@{ ok = $false; code = "daemon_machine_identity_mismatch" }
  }
  if ($HardwareMode -ne "simulated") {
    return [ordered]@{ ok = $false; code = "simulated_hardware_mode_required" }
  }
  if (
    (Test-SharedPlatformTarget $Target.platformTarget) -or
    (Test-SharedPlatformTarget $PlatformSetup.target) -or
    (Test-SharedPlatformTarget $PlatformSetup.apiBaseUrl) -or
    (Test-SharedPlatformTarget $PlatformSetup.mqttUrl)
  ) {
    return [ordered]@{ ok = $false; code = "shared_platform_target_rejected" }
  }
  if ([string]$PlatformSetup.evidenceStatus -ne "prepared" -or [string]$PlatformSetup.target -ne [string]$Target.platformTarget) {
    return [ordered]@{ ok = $false; code = "ephemeral_platform_evidence_required" }
  }
  if ([string]$DaemonApiBaseUrl -ne [string]$PlatformSetup.apiBaseUrl -or [string]$DaemonMqttUrl -ne [string]$PlatformSetup.mqttUrl) {
    return [ordered]@{ ok = $false; code = "ephemeral_platform_target_mismatch" }
  }
  return [ordered]@{ ok = $true; code = "pre_mutation_target_verified" }
}

function Get-HardwareMappingFaultProbeContext(
  [string]$ContextPath,
  [string]$RunId
) {
  if (-not (Test-Path -LiteralPath $ContextPath -PathType Leaf)) {
    throw "hardware mapping fault probe requires a successful sale-prepare context"
  }

  $Context = Read-JsonFile $ContextPath
  if ([string]$Context.runId -ne [string]$RunId) {
    throw "hardware mapping fault probe context belongs to a different run"
  }
  if (
    $null -eq $Context.successfulPrepare -or
    [string]$Context.successfulPrepare.runId -ne [string]$RunId -or
    [string]$Context.successfulPrepare.status -ne "succeeded" -or
    [string]$Context.successfulPrepare.phase -ne "prepare" -or
    [string]::IsNullOrWhiteSpace([string]$Context.successfulPrepare.orderId) -or
    [string]::IsNullOrWhiteSpace([string]$Context.successfulPrepare.paymentId)
  ) {
    throw "hardware mapping fault probe context has no successful sale-prepare baseline"
  }
  if (
    $null -eq $Context.saleView -or
    [string]::IsNullOrWhiteSpace([string]$Context.saleView.planogramVersion) -or
    $null -eq $Context.selectedItem -or
    [string]::IsNullOrWhiteSpace([string]$Context.selectedItem.inventoryId) -or
    [string]::IsNullOrWhiteSpace([string]$Context.selectedItem.slotId) -or
    [string]::IsNullOrWhiteSpace([string]$Context.selectedItem.slotCode)
  ) {
    throw "hardware mapping fault probe context has no saleable baseline item"
  }
  if ($null -eq $Context.paymentOptions -or $null -eq $Context.paymentOptions.options) {
    throw "hardware mapping fault probe context has no payment options"
  }

  $contextPaymentOptions = @($Context.paymentOptions.options | Where-Object {
    $null -ne $_ -and
    $_.disabled -ne $true -and
    [string]$_.method -ne "payment_code" -and
    -not [string]::IsNullOrWhiteSpace([string]$_.optionKey) -and
    -not [string]::IsNullOrWhiteSpace([string]$_.method) -and
    -not [string]::IsNullOrWhiteSpace([string]$_.providerCode)
  })
  $paymentOption = @($contextPaymentOptions | Where-Object {
    [string]$_.method -eq "qr_code"
  } | Select-Object -First 1)
  if ($paymentOption.Count -eq 0) {
    $paymentOption = @($contextPaymentOptions | Select-Object -First 1)
  }
  if ($paymentOption.Count -eq 0) {
    throw "hardware mapping fault probe requires an available non-scanner payment option"
  }

  return [ordered]@{
    selectedItem = $Context.selectedItem
    planogramVersion = [string]$Context.saleView.planogramVersion
    paymentOption = $paymentOption[0]
  }
}

function Resolve-HardwareMappingFaultPaymentOption(
  $ContextPaymentOption,
  [string]$BaseUrl,
  $Headers
) {
  $livePaymentOptions = Invoke-IpcJson "GET" "$BaseUrl/v1/payment-options" $Headers
  $matchingOption = @($livePaymentOptions.options | Where-Object {
    $_.disabled -ne $true -and
    [string]$_.optionKey -eq [string]$ContextPaymentOption.optionKey -and
    [string]$_.method -eq [string]$ContextPaymentOption.method -and
    [string]$_.providerCode -eq [string]$ContextPaymentOption.providerCode
  } | Select-Object -First 1)
  if ($matchingOption.Count -eq 0) {
    throw "hardware mapping fault probe payment option is no longer available"
  }
  $saleReadiness = Invoke-IpcJson "GET" "$BaseUrl/v1/sale-readiness" $Headers
  $readyPaymentOption = @($saleReadiness.components.paymentOptions.methods | Where-Object {
    $_.ready -eq $true -and
    [string]$_.method -eq [string]$ContextPaymentOption.method -and
    [string]$_.providerCode -eq [string]$ContextPaymentOption.providerCode
  } | Select-Object -First 1)
  if ($readyPaymentOption.Count -eq 0) {
    throw "hardware mapping fault probe payment option is not ready"
  }
  return [ordered]@{
    option = $matchingOption[0]
    ready = $true
  }
}

function Invoke-HardwareMappingFaultProbe(
  [string]$BaseUrl,
  $Headers,
  $DaemonIpc,
  [string]$ContextPath,
  [string]$RunId
) {
  $healthz = $DaemonIpc.healthz
  $readyz = $DaemonIpc.readyz
  $readinessBlockingCodes = @($readyz.blockingCodes | ForEach-Object { [string]$_ })
  $mappingFault = [ordered]@{
    healthzObserved = $null -ne $healthz -and $healthz.observed -eq $true
    readyzObserved = $null -ne $readyz -and $readyz.observed -eq $true
    hardwareOnline = if ($null -ne $healthz) { [bool]$healthz.hardwareOnline } else { $null }
    readinessBlockingCodes = $readinessBlockingCodes
    exactLowerControllerBlocker =
      $readinessBlockingCodes.Count -eq 1 -and
      $readinessBlockingCodes[0] -eq "LOWER_CONTROLLER_UNAVAILABLE"
    adapterSession = [ordered]@{
      serialSessionId = ${psString(process.env.VEM_VM_HOST_FAULT_SESSION_ID ?? "")}
      startOperationReference = ${psString(process.env.VEM_VM_HOST_FAULT_START_OPERATION_REFERENCE ?? "")}
      deviceMappingDigest = ${psString(process.env.VEM_VM_HOST_FAULT_DEVICE_MAPPING_DIGEST ?? "")}
      faultStartedAt = ${psString(process.env.VEM_VM_HOST_FAULT_STARTED_AT ?? "")}
    }
  }
  $transactionEntry = [ordered]@{
    endpoint = "/v1/intents/create-order"
    attempted = $false
    rejected = $false
    statusCode = $null
    responseCode = $null
    readinessBlockingCodes = $readinessBlockingCodes
    responseBlockingCodes = @()
    context = $null
    request = $null
    orderId = $null
    paymentId = $null
    vendingCommandId = $null
  }

  if (
    $mappingFault.healthzObserved -ne $true -or
    $mappingFault.readyzObserved -ne $true -or
    $healthz.hardwareOnline -ne $false -or
    $null -eq $readyz
  ) {
    throw "hardware mapping fault probe requires observed unhealthy daemon IPC healthz and readyz"
  }

  $probeContext = Get-HardwareMappingFaultProbeContext $ContextPath $RunId
  $resolvedPaymentOption = Resolve-HardwareMappingFaultPaymentOption $probeContext.paymentOption $BaseUrl $Headers
  $paymentOption = $resolvedPaymentOption.option
  $createOrderRequest = [ordered]@{
    inventoryId = [string]$probeContext.selectedItem.inventoryId
    quantity = 1
    planogramVersion = [string]$probeContext.planogramVersion
    slotId = [string]$probeContext.selectedItem.slotId
    slotCode = [string]$probeContext.selectedItem.slotCode
    paymentMethod = [string]$paymentOption.method
    paymentProviderCode = [string]$paymentOption.providerCode
    profileSnapshot = [ordered]@{ source = "hardware_mapping_fault_probe"; runId = $RunId }
  }
  $transactionEntry.context = [ordered]@{
    runId = $RunId
    successfulPrepare = [ordered]@{
      runId = $RunId
      status = "succeeded"
      phase = "prepare"
    }
    selectedItem = [ordered]@{
      inventoryId = [string]$probeContext.selectedItem.inventoryId
      slotId = [string]$probeContext.selectedItem.slotId
      slotCode = [string]$probeContext.selectedItem.slotCode
    }
    planogramVersion = [string]$probeContext.planogramVersion
    paymentOption = [ordered]@{
      optionKey = [string]$paymentOption.optionKey
      method = [string]$paymentOption.method
      providerCode = [string]$paymentOption.providerCode
      ready = [bool]$resolvedPaymentOption.ready
    }
  }
  $transactionEntry.request = $createOrderRequest
  $transactionEntry.attempted = $true
  try {
    Invoke-IpcJson "POST" "$BaseUrl/v1/intents/create-order" $Headers $createOrderRequest | Out-Null
    $transactionEntry.responseCode = "transaction_creation_accepted"
  } catch {
    $rejection = Get-HttpErrorInfo $_
    $transactionEntry.statusCode = $rejection.statusCode
    $transactionEntry.responseCode = Convert-ClaimFailureClassification $rejection
    $transactionEntry.responseBlockingCodes = @(Get-NetworkSaleResponseBlockingCodes $rejection)
    $transactionEntry.rejected =
      $transactionEntry.statusCode -eq 400 -and
      $transactionEntry.responseCode -eq "create_order_blocked" -and
      $transactionEntry.responseBlockingCodes.Count -eq 1 -and
      $transactionEntry.responseBlockingCodes[0] -eq "LOWER_CONTROLLER_UNAVAILABLE"
  }

  return [ordered]@{
    mappingFault = $mappingFault
    transactionEntry = $transactionEntry
  }
}

function Wait-PlatformAcceptedStockAttestation(
  [string]$BaseUrl,
  $Headers,
  [string]$AttestationId,
  [string]$PlanogramVersion
) {
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  do {
    $readiness = Invoke-IpcJson "GET" "$BaseUrl/v1/sale-readiness" $Headers
    $saleView = Invoke-IpcJson "GET" "$BaseUrl/v1/sale-view" $Headers
    $physicalStockAttestation = $readiness.components.physicalStockAttestation
    $saleableSlots = @($saleView.items | Where-Object {
      [string]$_.slotSalesState -eq "sale_ready" -and [int]$_.saleableStock -gt 0
    })

    if ([string]$physicalStockAttestation.status -eq "pending") {
      if ($saleableSlots.Count -gt 0) {
        throw "PHYSICAL_STOCK_ATTESTATION_PENDING must not expose saleable stock"
      }
    } elseif ([string]$physicalStockAttestation.status -eq "ready") {
      if (
        [string]$physicalStockAttestation.attestationId -ne $AttestationId -or
        [string]$physicalStockAttestation.planogramVersion -ne $PlanogramVersion
      ) {
        throw "Platform accepted stock evidence does not match the submitted attestation"
      }
      if ($saleableSlots.Count -eq 0) {
        throw "Platform accepted stock attestation did not produce a sale-ready slot"
      }
      return [ordered]@{
        readiness = $readiness
        saleView = $saleView
        evidence = $physicalStockAttestation
      }
    } elseif (
      [string]$physicalStockAttestation.code -eq "PHYSICAL_STOCK_ATTESTATION_REJECTED" -or
      [string]$physicalStockAttestation.code -eq "PHYSICAL_STOCK_ATTESTATION_UPLOAD_FAILED"
    ) {
      throw "Platform rejected simulated stock attestation: $($physicalStockAttestation.message)"
    }

    Start-Sleep -Milliseconds 500
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "timed out waiting for Platform-accepted simulated stock attestation"
}

function Invoke-SimulatedHardwareSaleFlow($ProvisioningActions = @()) {
  $reportPath = ${psString(SIMULATED_HARDWARE_SALE_FLOW_REPORT_FILE)}
  $contextPath = ${psString(SIMULATED_HARDWARE_SALE_CONTEXT_FILE)}
  $salePhase = ${psString(options.salePhase ?? "single")}
  $ready = $null
  $baseUrl = $null
  $headers = $null
  $bringUp = $null
  $configSummary = $null
  $daemonIpcBeforeMutation = $null
  $syncPlanogram = $null
  $saleViewBeforeStock = $null
  $attestation = $null
  $saleView = $null
  $paymentOptions = $null
  $renderedSaleBinding = $null
  $currentTransaction = $null
  $postSaleDispenseMovement = $null
  $selectedItem = $null
  $flowError = $null
  $effectiveProvisioningActions = @($ProvisioningActions)

  try {
    $ready = Read-JsonFile ${psString(bringUpPlan.arguments.DaemonReadyFile)}
    if ([string]::IsNullOrWhiteSpace($ready.ipcToken)) {
      throw "ipcToken missing from daemon ready file"
    }
    $baseUrl = Get-IpcBaseUrl $ready
    $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }

    if ($salePhase -eq "complete") {
      if (-not (Test-Path -LiteralPath $contextPath -PathType Leaf)) {
        throw "simulated sale fixture context is missing"
      }
      $context = Read-JsonFile $contextPath
      if ([string]$context.kind -ne "simulated_hardware_sale_fixture") {
        throw "simulated sale completion requires fixture-only context"
      }
      $renderedSaleBinding = ${psString(options.saleBindingJson ?? "")} | ConvertFrom-Json
      foreach ($field in @("orderId", "paymentId", "orderNo")) {
        if ([string]::IsNullOrWhiteSpace([string]$renderedSaleBinding.$field)) {
          throw "simulated sale completion requires rendered $field"
        }
      }
      $bringUp = $context.bringUp
      $configSummary = $context.configSummary
      $daemonIpcBeforeMutation = $context.daemonIpcBeforeMutation
      $syncPlanogram = $context.syncPlanogram
      $saleViewBeforeStock = $context.saleViewBeforeStock
      $attestation = $context.attestation
      $saleView = $context.saleView
      $paymentOptions = $context.paymentOptions
      $selectedItem = $context.selectedItem
      $effectiveProvisioningActions = @($context.provisioningActions)
    } else {
    $bringUp = Invoke-IpcJson "GET" "$baseUrl/v1/bring-up" $headers
    $configSummary = Invoke-IpcJson "GET" "$baseUrl/v1/config/summary" $headers
    $daemonIpcBeforeMutation = Get-DaemonIpcInventoryEvidence ${psString(bringUpPlan.arguments.DaemonReadyFile)}
    $hardwareMappingFaultProbeRequired =
      $daemonIpcBeforeMutation.healthz.observed -eq $true -and
      $daemonIpcBeforeMutation.healthz.hardwareOnline -eq $false
    if ($hardwareMappingFaultProbeRequired) {
      throw "fixture-only sale setup requires healthy serial hardware before customer checkout"
    }
    $platformSetupGuardEvidence = [ordered]@{
      target = ${psString(ephemeralPlatformSetup?.target ?? "")}
      apiBaseUrl = ${psString(ephemeralPlatformSetup?.apiBaseUrl ?? "")}
      mqttUrl = ${psString(ephemeralPlatformSetup?.mqttUrl ?? "")}
      evidenceStatus = "prepared"
    }
    $preMutationGuard = Assert-SimulatedSaleFlowPreMutationTarget ([ordered]@{
      machineCode = ${psString(machineCode)}
      platformTarget = ${psString(platformTarget)}
    }) $daemonIpcBeforeMutation.config.machineCode $daemonIpcBeforeMutation.config.apiBaseUrl $daemonIpcBeforeMutation.config.mqttUrl ([string]$bringUp.hardwareMode) $platformSetupGuardEvidence
    if (-not [bool]$preMutationGuard.ok) {
      throw "simulated sale-flow pre-mutation target guard failed: $($preMutationGuard.code)"
    }

    $syncPlanogram = Invoke-IpcJson "POST" "$baseUrl/v1/stock/planogram/sync" $headers
    $saleViewBeforeStock = Invoke-IpcJson "GET" "$baseUrl/v1/sale-view" $headers
    $selectedItem = @($saleViewBeforeStock.items | Where-Object {
      -not [string]::IsNullOrWhiteSpace($_.slotId) -and
      -not [string]::IsNullOrWhiteSpace($_.slotCode) -and
      -not [string]::IsNullOrWhiteSpace($_.sku)
    } | Select-Object -First 1)
    if ($selectedItem.Count -eq 0) {
      throw "sale view does not contain a slot for simulated stock attestation"
    }
    $selectedItem = $selectedItem[0]
    $stockQuantity = if ([int]$selectedItem.physicalStock -gt 0) { [int]$selectedItem.physicalStock } elseif ([int]$selectedItem.parLevel -gt 0) { [int]$selectedItem.parLevel } else { 1 }
    $attestationPayload = [ordered]@{
      attestationId = "SIM-HW-${runId}"
      planogramVersion = [string]$saleViewBeforeStock.planogramVersion
      operatorId = "testbed-orchestrator"
      slots = @($saleViewBeforeStock.items | ForEach-Object {
        [ordered]@{
          slotId = [string]$_.slotId
          slotCode = [string]$_.slotCode
          sku = [string]$_.sku
          quantity = if ([int]$_.physicalStock -gt 0) { [int]$_.physicalStock } elseif ([int]$_.parLevel -gt 0) { [int]$_.parLevel } else { 1 }
          enabled = $true
        }
      })
    }
    $attestationSubmission = Invoke-IpcJson "POST" "$baseUrl/v1/stock/attestation" $headers $attestationPayload
    $stockAcceptance = Wait-PlatformAcceptedStockAttestation $baseUrl $headers ([string]$attestationPayload.attestationId) ([string]$attestationPayload.planogramVersion)
    $saleView = $stockAcceptance.saleView
    $selectedItem = @($saleView.items | Where-Object {
      [string]$_.slotSalesState -eq "sale_ready" -and [int]$_.saleableStock -gt 0
    } | Select-Object -First 1)
    $attestation = [ordered]@{
      attestationId = [string]$stockAcceptance.evidence.attestationId
      accepted = $true
      status = "accepted"
      uploadStatus = "accepted"
      acceptedAt = [string]$stockAcceptance.evidence.attestedAt
      platformMovementId = ("{0}:{1}" -f [string]$stockAcceptance.evidence.attestationId, [string]$selectedItem.slotId)
      submission = $attestationSubmission
    }
    if ($selectedItem.Count -eq 0) {
      throw "sale view does not contain a sale-ready simulated slot after stock attestation"
    }
    $selectedItem = $selectedItem[0]
    $paymentOptions = Invoke-IpcJson "GET" "$baseUrl/v1/payment-options" $headers
    if ($salePhase -eq "fixture") {
      Write-JsonFile $contextPath ([ordered]@{
        kind = "simulated_hardware_sale_fixture"
        runId = ${psString(runId)}
        fixture = [ordered]@{
          planogramVersion = [string]$saleView.planogramVersion
          selectedItem = $selectedItem
          stockAttestationId = [string]$attestation.attestationId
          paymentOptionCount = @($paymentOptions.options).Count
        }
        bringUp = $bringUp
        configSummary = $configSummary
        daemonIpcBeforeMutation = $daemonIpcBeforeMutation
        syncPlanogram = $syncPlanogram
        saleViewBeforeStock = $saleViewBeforeStock
        attestation = $attestation
        saleView = $saleView
        paymentOptions = $paymentOptions
        selectedItem = $selectedItem
        provisioningActions = @($ProvisioningActions)
      })
    }
    }
    if ($salePhase -eq "complete") {
      $deadline = [DateTime]::UtcNow.AddSeconds(120)
      do {
        $currentTransaction = Invoke-IpcJson "GET" "$baseUrl/v1/transactions/current" $headers
        if (
          [string]$currentTransaction.vending.status -eq "succeeded" -or
          [string]$currentTransaction.vending.status -eq "failed" -or
          [string]$currentTransaction.paymentStatus -eq "failed"
        ) { break }
        Start-Sleep -Milliseconds 500
      } while ([DateTime]::UtcNow -lt $deadline)
    }
  } catch {
    $flowError = [string]$_
  }

  $daemonIpc = if ($null -ne $daemonIpcBeforeMutation) { $daemonIpcBeforeMutation } else { Get-DaemonIpcInventoryEvidence ${psString(bringUpPlan.arguments.DaemonReadyFile)} }
  $provisioningFacts = Convert-ProvisioningFacts $daemonIpc @($effectiveProvisioningActions)
  $activePlanogramVersion = if ($null -ne $saleView -and -not [string]::IsNullOrWhiteSpace($saleView.planogramVersion)) {
    [string]$saleView.planogramVersion
  } elseif ($null -ne $saleViewBeforeStock -and -not [string]::IsNullOrWhiteSpace($saleViewBeforeStock.planogramVersion)) {
    [string]$saleViewBeforeStock.planogramVersion
  } else {
    "unknown"
  }
  $saleableSlots = if ($null -ne $saleView) {
    @($saleView.items | Where-Object { [int]$_.saleableStock -gt 0 -and [string]$_.slotSalesState -eq "sale_ready" }).Count
  } else {
    0
  }
  $totalOnHand = if ($null -ne $saleView) {
    $stockSum = @($saleView.items | Measure-Object -Property physicalStock -Sum).Sum
    if ($null -eq $stockSum) { 0 } else { [int]$stockSum }
  } else {
    0
  }
  $paymentStatus = if ($null -ne $currentTransaction -and -not [string]::IsNullOrWhiteSpace($currentTransaction.paymentStatus)) {
    [string]$currentTransaction.paymentStatus
  } else {
    "unknown"
  }
  $fulfillmentStatus = if ([string]$currentTransaction.vending.status -eq "succeeded") {
    "dispensed"
  } elseif ([string]$currentTransaction.vending.status -eq "failed") {
    "dispense_failed"
  } else {
    "unknown"
  }
  $orderStatus = if ($null -ne $currentTransaction -and -not [string]::IsNullOrWhiteSpace($currentTransaction.orderStatus)) {
    [string]$currentTransaction.orderStatus
  } else {
    "unknown"
  }
  $planogramAcknowledgmentId = if ($null -ne $syncPlanogram -and -not [string]::IsNullOrWhiteSpace($syncPlanogram.acknowledgmentId)) {
    [string]$syncPlanogram.acknowledgmentId
  } elseif ($null -ne $syncPlanogram -and -not [string]::IsNullOrWhiteSpace($syncPlanogram.ackId)) {
    [string]$syncPlanogram.ackId
  } else {
    $null
  }
  $planogramSyncStatus = if ($null -ne $syncPlanogram -and -not [string]::IsNullOrWhiteSpace($syncPlanogram.status)) {
    $rawPlanogramStatus = [string]$syncPlanogram.status
    if (@("acknowledged", "failed", "missing") -contains $rawPlanogramStatus) {
      $rawPlanogramStatus
    } elseif ($null -ne $planogramAcknowledgmentId) {
      "acknowledged"
    } else {
      "missing"
    }
  } elseif ($null -ne $planogramAcknowledgmentId) {
    "acknowledged"
  } elseif ($null -ne $syncPlanogram) {
    "missing"
  } else {
    "failed"
  }
  $stockUploadStatus = if ($null -ne $attestation -and -not [string]::IsNullOrWhiteSpace($attestation.uploadStatus)) {
    $rawStockUploadStatus = [string]$attestation.uploadStatus
    if (@("accepted", "rejected", "missing") -contains $rawStockUploadStatus) {
      $rawStockUploadStatus
    } elseif ([bool]$attestation.accepted) {
      "accepted"
    } else {
      "missing"
    }
  } elseif ($null -ne $attestation -and -not [string]::IsNullOrWhiteSpace($attestation.status)) {
    $rawStockStatus = [string]$attestation.status
    if (@("accepted", "rejected", "missing") -contains $rawStockStatus) {
      $rawStockStatus
    } elseif ([bool]$attestation.accepted) {
      "accepted"
    } else {
      "missing"
    }
  } elseif ($null -ne $attestation -and [bool]$attestation.accepted) {
    "accepted"
  } elseif ($null -ne $attestation) {
    "missing"
  } else {
    "failed"
  }
  $platformMovementId = if ($null -ne $attestation -and -not [string]::IsNullOrWhiteSpace($attestation.platformMovementId)) {
    [string]$attestation.platformMovementId
  } elseif ($null -ne $attestation -and -not [string]::IsNullOrWhiteSpace($attestation.stockMovementId)) {
    [string]$attestation.stockMovementId
  } elseif ($null -ne $attestation -and -not [string]::IsNullOrWhiteSpace($attestation.movementId)) {
    [string]$attestation.movementId
  } else {
    $null
  }
  $orderId = if ($null -ne $currentTransaction -and -not [string]::IsNullOrWhiteSpace($currentTransaction.orderId)) {
    [string]$currentTransaction.orderId
  } else {
    $null
  }
  $orderNo = if ($null -ne $currentTransaction -and -not [string]::IsNullOrWhiteSpace($currentTransaction.orderNo)) {
    [string]$currentTransaction.orderNo
  } else {
    $null
  }
  $paymentNo = if ($null -ne $currentTransaction -and -not [string]::IsNullOrWhiteSpace($currentTransaction.paymentNo)) {
    [string]$currentTransaction.paymentNo
  } else {
    $null
  }
  $paymentId = if ($null -ne $currentTransaction -and -not [string]::IsNullOrWhiteSpace($currentTransaction.paymentId)) {
    [string]$currentTransaction.paymentId
  } else {
    $null
  }
  $observedReservationIds = @()
  $reservationSource = "not_exposed"
  if ($null -ne $currentTransaction -and $null -ne $currentTransaction.PSObject.Properties["reservations"]) {
    $reservationSource = "current_transaction.reservations"
    foreach ($reservation in @($currentTransaction.reservations)) {
      if ($null -ne $reservation -and -not [string]::IsNullOrWhiteSpace([string]$reservation.reservationId)) {
        $observedReservationIds += [string]$reservation.reservationId
      }
    }
  } elseif ($null -ne $currentTransaction -and $null -ne $currentTransaction.PSObject.Properties["reservationId"]) {
    $reservationSource = "current_transaction.reservationId"
    if (-not [string]::IsNullOrWhiteSpace([string]$currentTransaction.reservationId)) {
      $observedReservationIds += [string]$currentTransaction.reservationId
    }
  }
  $reservationEvidence = [ordered]@{
    source = $reservationSource
    exposed = $reservationSource -ne "not_exposed"
    rawRecordCount = @($observedReservationIds).Count
  }
  if ($salePhase -eq "complete" -and (
    $orderId -ne [string]$renderedSaleBinding.orderId -or
    $paymentId -ne [string]$renderedSaleBinding.paymentId -or
    $orderNo -ne [string]$renderedSaleBinding.orderNo
  )) {
    throw "completed simulated sale does not match the rendered payment binding"
  }
  $vendingCommandId = if ($null -ne $currentTransaction -and -not [string]::IsNullOrWhiteSpace($currentTransaction.vending.commandId)) {
    [string]$currentTransaction.vending.commandId
  } elseif ($null -ne $currentTransaction -and -not [string]::IsNullOrWhiteSpace($currentTransaction.dispenseCommandId)) {
    [string]$currentTransaction.dispenseCommandId
  } else {
    $null
  }
  $lowerControllerCom = Get-WindowsComPortEvidence ([string]$daemonIpc.config.serialPortPath)
  $scannerCom = Get-WindowsComPortEvidence ([string]$daemonIpc.config.scannerSerialPortPath)
  if ($null -ne $orderId -and $null -ne $vendingCommandId) {
    $orderQuery = [uri]::EscapeDataString($orderId)
    $commandQuery = [uri]::EscapeDataString($vendingCommandId)
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      try {
        $postSaleDispenseMovement = Invoke-IpcJson "GET" "$baseUrl/v1/stock/movements/dispense-confirmation?orderId=$orderQuery&vendingCommandId=$commandQuery" $headers
        break
      } catch {
        Start-Sleep -Seconds 1
      }
    }
  }
  $dispenseResult = if ($fulfillmentStatus -eq "dispensed") {
    "dispensed"
  } elseif ($fulfillmentStatus -eq "dispense_failed") {
    "failed"
  } else {
    "unknown"
  }
  $observedOrderIds = @($orderId)
  $observedPaymentIds = @($paymentId)
  $observedOrderNos = @($orderNo)
  $observedCommandIds = @($vendingCommandId)
  $observedMovementIds = @()
  if ($null -ne $postSaleDispenseMovement) {
    $observedMovementIds += [string]$postSaleDispenseMovement.movementId
  }

  $facts = [ordered]@{
    mode = "simulated_hardware_fresh_bring_up_sale_flow"
    target = [ordered]@{
      testbedName = "win10-vem-e2e"
      machineCode = ${psString(machineCode)}
      platformTarget = ${psString(platformTarget)}
    }
    runtimeState = [ordered]@{
      hardwareMode = if ($null -ne $bringUp -and -not [string]::IsNullOrWhiteSpace($bringUp.hardwareMode)) { [string]$bringUp.hardwareMode } else { "unknown" }
      hardwareModel = if ($null -ne $configSummary -and $null -ne $configSummary.factoryManifest -and -not [string]::IsNullOrWhiteSpace($configSummary.factoryManifest.hardwareModel)) { [string]$configSummary.factoryManifest.hardwareModel } else { "unknown" }
      bringUpState = if ($null -ne $bringUp -and -not [string]::IsNullOrWhiteSpace($bringUp.state)) { [string]$bringUp.state } else { "unknown" }
      uiDiagnosticsExplicit = $null -ne $bringUp -and [string]$bringUp.hardwareMode -eq "simulated"
    }
    daemonHealth = [ordered]@{
      hardwareOnline = [bool]$daemonIpc.healthz.hardwareOnline
      scannerOnline = [bool]$daemonIpc.healthz.scannerOnline
    }
    provisioning = [ordered]@{
      provisioned = [bool]$provisioningFacts.provisioned
      usedMachineClaimCodePath = [bool]$provisioningFacts.usedDaemonIpcTaskExecute
      usedDaemonIpcTaskExecute = [bool]$provisioningFacts.usedDaemonIpcTaskExecute
      profileApplied = [bool]$provisioningFacts.machineSecretConfigured -and [bool]$provisioningFacts.mqttSigningSecretConfigured
      machineCode = $provisioningFacts.machineCode
      claim = $provisioningFacts.claim
      profile = $provisioningFacts.profile
    }
    platformSetup = [ordered]@{
      ephemeral = $true
      preparedRunId = ${psString(runId)}
      target = ${psString(ephemeralPlatformSetup?.target ?? "")}
      apiBaseUrl = ${psString(ephemeralPlatformSetup?.apiBaseUrl ?? "")}
      mqttUrl = ${psString(ephemeralPlatformSetup?.mqttUrl ?? "")}
      evidenceStatus = "prepared"
      claimPath = ${psString(ephemeralPlatformSetup?.claimPath ?? "/api/machines/claim")}
      mockPaymentReady = ${ephemeralPlatformSetup?.mockPaymentReady ? "$true" : "$false"} -and $null -ne $paymentOptions -and @($paymentOptions.options | Where-Object { [string]$_.method -eq "payment_code" -and [string]$_.providerCode -eq "mock" }).Count -gt 0
    }
    topology = [ordered]@{
      expectedIdentity = ${psString(ephemeralPlatformSetup?.hardwareTopologyIdentity ?? "unknown")}
      expectedVersion = ${psString(ephemeralPlatformSetup?.hardwareTopologyVersion ?? "unknown")}
      verified = $null -ne $bringUp -and @($bringUp.diagnostics | Where-Object { [string]$_.component -eq "topology" -or [string]$_.code -match "TOPOLOGY|HARDWARE_SLOT" }).Count -eq 0 -and [string]$bringUp.state -ne "topology_mismatch"
    }
    daemonSerialConfiguration = [ordered]@{
      hardwareAdapter = if ($null -ne $daemonIpc.config.hardwareAdapter) { [string]$daemonIpc.config.hardwareAdapter } else { "unknown" }
      scannerAdapter = if ($null -ne $daemonIpc.config.scannerAdapter) { [string]$daemonIpc.config.scannerAdapter } else { "unknown" }
      lowerControllerPort = $lowerControllerCom.port
      scannerPort = $scannerCom.port
      lowerControllerPortObserved = [bool]$lowerControllerCom.observed
      scannerPortObserved = [bool]$scannerCom.observed
    }
    guestSerialEvidence = [ordered]@{
      status = "pending_host_serial_conformance"
      serialSessionId = $null
      deviceMappingDigest = $null
      scannerInputTransport = $null
      mappings = @()
      frames = @()
    }
    planogram = [ordered]@{
      syncedFromPlatform = $null -ne $syncPlanogram
      applied = $activePlanogramVersion -ne "unknown"
      acknowledged = $null -ne $syncPlanogram
      acknowledgmentId = $planogramAcknowledgmentId
      syncStatus = $planogramSyncStatus
      planogramVersion = $activePlanogramVersion
      slotCount = if ($null -ne $saleView) { @($saleView.items).Count } else { 0 }
    }
    stock = [ordered]@{
      establishedBy = "stock_attestation"
      evidenceId = "SIM-HW-${runId}"
      uploadStatus = $stockUploadStatus
      platformMovementId = $platformMovementId
      planogramVersion = $activePlanogramVersion
      saleableSlots = $saleableSlots
      totalOnHand = $totalOnHand
    }
    sale = [ordered]@{
      saleViewReady = $saleableSlots -gt 0
      selectedSlotCode = if ($null -ne $selectedItem -and -not [string]::IsNullOrWhiteSpace($selectedItem.slotCode)) { [string]$selectedItem.slotCode } else { "unknown" }
      orderId = $orderId
      orderNo = $orderNo
      orderStatus = $orderStatus
      paymentMethod = "payment_code"
      paymentProviderCode = "mock"
      paymentId = $paymentId
      paymentNo = $paymentNo
      paymentStatus = $paymentStatus
      paymentSucceeded = $paymentStatus -eq "succeeded"
      vendingCommandId = $vendingCommandId
      dispenseSimulated = $true
      dispenseResult = $dispenseResult
      dispenseSucceeded = $fulfillmentStatus -eq "dispensed"
      customerResult = if ($paymentStatus -eq "succeeded" -and $fulfillmentStatus -eq "dispensed") { "success" } elseif ($null -ne $flowError) { "failed" } else { "unknown" }
    }
    platformState = [ordered]@{
      orderStatus = $orderStatus
      paymentStatus = $paymentStatus
      fulfillmentStatus = $fulfillmentStatus
      stockMovementAccepted = $null -ne $postSaleDispenseMovement -and [string]$postSaleDispenseMovement.status -eq "accepted"
      postSaleDispenseMovement = [ordered]@{
        movementId = if ($null -ne $postSaleDispenseMovement) { [string]$postSaleDispenseMovement.movementId } else { $null }
        orderId = if ($null -ne $postSaleDispenseMovement) { [string]$postSaleDispenseMovement.orderId } else { $null }
        vendingCommandId = if ($null -ne $postSaleDispenseMovement) { [string]$postSaleDispenseMovement.vendingCommandId } else { $null }
        quantity = if ($null -ne $postSaleDispenseMovement) { [int]$postSaleDispenseMovement.quantity } else { $null }
        beforeQuantity = if ($null -ne $postSaleDispenseMovement) { [int]$postSaleDispenseMovement.beforeQuantity } else { $null }
        afterQuantity = if ($null -ne $postSaleDispenseMovement) { [int]$postSaleDispenseMovement.afterQuantity } else { $null }
        deltaQuantity = if ($null -ne $postSaleDispenseMovement) { [int]$postSaleDispenseMovement.deltaQuantity } else { $null }
        status = if ($null -ne $postSaleDispenseMovement -and [string]$postSaleDispenseMovement.status -eq "accepted") { "accepted" } else { "missing" }
      }
      reservation = $reservationEvidence
      observedIdentities = [ordered]@{
        orderIds = @($observedOrderIds)
        paymentIds = @($observedPaymentIds)
        reservationIds = @($observedReservationIds)
        orderNos = @($observedOrderNos)
        commandIds = @($observedCommandIds)
        movementIds = @($observedMovementIds)
      }
    }
  }

  $report = if ($salePhase -eq "fixture") {
    [ordered]@{
      schemaVersion = "simulated-hardware-sale-fixture/v1"
      phase = "fixture"
      fixture = [ordered]@{
        planogramVersion = $facts.planogram.planogramVersion
        stockAttestationId = $facts.stock.evidenceId
        saleableSlots = $facts.stock.saleableSlots
        paymentMethodReady = $facts.platformSetup.mockPaymentReady
      }
      runtimeState = $facts.runtimeState
      daemonHealth = $facts.daemonHealth
      topology = $facts.topology
      result = [ordered]@{
        simulatedHardwareReady = New-RuntimeAcceptanceAssertion "fixture_ready" $true
        sellReady = [ordered]@{ status = "not_asserted"; asserted = $false }
      }
      diagnostics = @()
    }
  } else {
    $classified = Classify-SimulatedHardwareSaleFlowReport $facts
    $classified["phase"] = "complete"
    $classified["hostSerialEvidencePending"] = $true
    $classified
  }
  if ($null -ne $flowError) {
    $diagnostics = [System.Collections.Generic.List[object]]::new()
    foreach ($diagnostic in @($report.diagnostics)) {
      $diagnostics.Add($diagnostic) | Out-Null
    }
    Add-RuntimeAcceptanceDiagnostic $diagnostics "simulated_sale_flow_error" $flowError
    $report.diagnostics = @($diagnostics)
    $report.result.simulatedHardwareReady = New-RuntimeAcceptanceAssertion "failed" $false
  }
  Write-JsonFile $reportPath $report
  return [ordered]@{
    path = $reportPath
    report = $report
  }
}

function Invoke-ResetStep($Actions, [string]$Name, [scriptblock]$Script) {
  $status = "succeeded"
  $message = $null
  try {
    & $Script
  } catch {
    $status = "failed"
    $message = [string]$_
  }
  $Actions.Add([pscustomobject]@{
    name = $Name
    status = $status
    message = $message
  }) | Out-Null
}

function Assert-ResetPostcondition($Actions, [string]$Name, [scriptblock]$Condition) {
  $status = "succeeded"
  $message = $null
  try {
    if (-not (& $Condition)) {
      $status = "failed"
      $message = "postcondition failed"
    }
  } catch {
    $status = "failed"
    $message = [string]$_
  }
  $Actions.Add([pscustomobject]@{
    name = $Name
    status = $status
    message = $message
  }) | Out-Null
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
  $daemonService = Get-ServiceStateOrNull -Name "VemVendingDaemon"
  $machineUiTask = Get-ScheduledTaskEvidence -TaskName "VEMMachineUI" -TaskPath "\\"
  $maintenanceUiTask = Get-ScheduledTaskEvidence -TaskName "VEMMaintenanceUI" -TaskPath "\\"
  $visionTask = Get-ScheduledTaskEvidence -TaskName "StartVisionServer" -TaskPath "\\VEM\\"
  $readyFile = Test-PathEvidence "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json"
  $daemonConfig = Test-PathEvidence "C:\\ProgramData\\VEM\\vending-daemon\\machine-config.json"
  $startupBringup = Get-StartupBringupEvidence
  $daemonIpc = Get-DaemonIpcInventoryEvidence "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json"
  $provisioningFacts = Convert-ProvisioningFacts $daemonIpc (@($ProvisioningActions) + @(Get-PersistedProvisioningActions))
  $runtimeAcceptanceFactsSubset = [ordered]@{
    mode = "fresh_bring_up"
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
    serviceState = [ordered]@{
      daemonService = [ordered]@{
        installed = $null -ne $daemonService
        running = $null -ne $daemonService -and $daemonService.status -eq "Running"
        startupType = if ($null -ne $daemonService) { $daemonService.startType.ToLowerInvariant() } else { "unknown" }
      }
      machineUiTask = [ordered]@{
        name = "VEMMachineUI"
        exists = [bool]$machineUiTask.exists
        enabled = [bool]$machineUiTask.enabled
        runAsUser = if ([string]::IsNullOrWhiteSpace($machineUiTask.runAsUser)) { "unknown" } else { [string]$machineUiTask.runAsUser }
      }
      visionTask = [ordered]@{
        name = "VEM\\StartVisionServer"
        exists = [bool]$visionTask.exists
        enabled = [bool]$visionTask.enabled
        runAsUser = if ([string]::IsNullOrWhiteSpace($visionTask.runAsUser)) { "unknown" } else { [string]$visionTask.runAsUser }
      }
    }
    startupBringup = $startupBringup
    readyFile = $daemonIpc.readyFile
    provisioning = $provisioningFacts
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
      maintenance = Get-LocalUserEvidence "YKDZ"
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
      daemonService = $daemonService
      machineUiTask = $machineUiTask
      maintenanceUiTask = $maintenanceUiTask
      visionTask = $visionTask
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
      scheduledTasksAvailable = $null -ne (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue)
      serviceControlAvailable = $null -ne (Get-Command sc.exe -ErrorAction SilentlyContinue)
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
$bringUpActions = [System.Collections.Generic.List[object]]::new()
$provisioningActions = [System.Collections.Generic.List[object]]::new()
$factoryActions = [System.Collections.Generic.List[object]]::new()
$factoryAcceptancePaths = $null
$simulatedHardwareSaleFlowResult = $null

if ($mode -eq "reset" -or $mode -eq "inventory-reset") {
${serviceStops}
${taskRemovals}
${fileRemovals}
${directoryRemovals}
}

if ($mode -eq "bring-up") {
  Invoke-ProductionBringUp $bringUpActions
}

if ($mode -eq "provision") {
  Invoke-TestbedProvisioningClaim $provisioningActions
}

if ($mode -eq "clean-base-factory-acceptance") {
  $factoryAcceptancePaths = Invoke-CleanBaseFactoryAcceptance $factoryActions
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
$inventoryAfterBringUp = if ($mode -eq "bring-up") { Get-InventoryFacts } else { $null }
$inventoryAfterProvision = if ($mode -eq "provision") { Get-InventoryFacts $provisioningActions } else { $null }
$runtimeAcceptanceReportResult = if ($mode -eq "runtime-acceptance") { Get-RuntimeAcceptanceReport $provisioningActions } else { $null }
$runtimeAcceptanceReport = if ($null -ne $runtimeAcceptanceReportResult) { $runtimeAcceptanceReportResult.report } else { $null }
$simulatedHardwareSaleFlowReport = if ($null -ne $simulatedHardwareSaleFlowResult) { $simulatedHardwareSaleFlowResult.report } else { $null }
$actionsOk = (((@($resetActions) + @($bringUpActions) + @($provisioningActions) + @($factoryActions)) | Where-Object { $_.status -eq "failed" } | Measure-Object | Select-Object -ExpandProperty Count) -eq 0)
$runtimeAcceptanceOk = if ($mode -eq "runtime-acceptance") {
  $null -ne $runtimeAcceptanceReport -and [string]$runtimeAcceptanceReport.result.runtimeReady.status -eq "passed"
} else {
  $true
}
$cleanBaseFactoryAcceptanceOk = if ($mode -eq "clean-base-factory-acceptance") {
  $null -ne $factoryAcceptancePaths -and $null -ne $factoryAcceptancePaths.report -and [bool]$factoryAcceptancePaths.report.ok
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
  ok = $actionsOk -and $runtimeAcceptanceOk -and $cleanBaseFactoryAcceptanceOk -and $simulatedHardwareSaleFlowOk
  mode = $mode
  inventory = $inventoryBefore
  cleanBaseFactoryAcceptance = if ($mode -eq "clean-base-factory-acceptance") {
    if ($null -ne $factoryAcceptancePaths) { $factoryAcceptancePaths.report } else { $null }
  } else {
    $null
  }
  reset = [ordered]@{
    plan = $resetPlan
    actions = @($resetActions)
    idempotent = $true
  }
  bringUp = [ordered]@{
    plan = [ordered]@{
      setupScript = ${psString(bringUpPlan.setupScript)}
      requiredSecretEnvironment = ${psArray(bringUpPlan.requiredSecretEnvironment)}
      arguments = [ordered]@{
${bringUpReportArgumentLines}
      }
      switches = ${psArray(bringUpPlan.switches)}
    }
    actions = @($bringUpActions)
  }
  provisioning = [ordered]@{
    actions = @($provisioningActions)
  }
  inventoryAfterReset = $inventoryAfter
  inventoryAfterBringUp = $inventoryAfterBringUp
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
    options.remote ?? DEFAULT_CONTROLLED_MAINTENANCE_REMOTE,
  ];
}

function factoryAcceptanceRemoteStagingPaths(options = {}) {
  const remoteTempRoot =
    options.mode === "clean-base-factory-acceptance"
      ? "C:\\Windows\\Temp"
      : "C:\\Users\\YKDZ\\AppData\\Local\\Temp";
  const remoteSupportScriptRoot = `${remoteTempRoot}\\vem-factory-acceptance-staging`;
  return {
    remoteTempRoot,
    remoteSupportScriptRoot,
    remoteScriptPath: `${remoteTempRoot}\\vem-factory-acceptance-run.ps1`,
  };
}

export function createFactoryAcceptanceCancellationController({
  cleanupRemoteFactoryStaging,
  cleanupLocalFactoryStaging,
  removeLocalTempDirectory,
}) {
  let cancellationSignal = null;
  let cleanupFailure = null;
  const abortController = new AbortController();

  const cleanupStep = (name, action) => {
    try {
      if (action() !== true) {
        cleanupFailure ??= `${name} cleanup verification failed`;
      }
    } catch (error) {
      cleanupFailure ??=
        error instanceof Error
          ? `${name} cleanup failed: ${error.message}`
          : `${name} cleanup failed`;
    }
  };

  return {
    requestCancellation(signal) {
      if (!cancellationSignal) {
        cancellationSignal = signal;
        abortController.abort(
          new Error(`factory acceptance cancelled by ${signal}`),
        );
      }
    },
    throwIfCancellationRequested() {
      if (cancellationSignal) {
        throw new Error(
          `factory acceptance cancelled by ${cancellationSignal}`,
        );
      }
    },
    finalize() {
      cleanupStep("local factory staging", cleanupLocalFactoryStaging);
      cleanupStep("remote factory staging", cleanupRemoteFactoryStaging);
      cleanupStep(
        "local factory temporary directory",
        removeLocalTempDirectory,
      );
      if (cleanupFailure) {
        const cancellation = cancellationSignal
          ? ` after ${cancellationSignal}`
          : "";
        throw new Error(
          `factory staging cleanup verification failed${cancellation}: ${cleanupFailure}`,
        );
      }
      this.throwIfCancellationRequested();
    },
    get state() {
      return { cancellationSignal, cleanupFailure };
    },
    get signal() {
      return abortController.signal;
    },
  };
}

export function installFactoryAcceptanceSignalHandlers(
  controller,
  signalSource = process,
) {
  const handlers = new Map(
    ["SIGINT", "SIGTERM"].map((signal) => [
      signal,
      () => controller.requestCancellation(signal),
    ]),
  );
  for (const [signal, handler] of handlers) {
    signalSource.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      signalSource.removeListener(signal, handler);
    }
  };
}

export function cleanupFactoryAcceptanceStaging(
  options = {},
  {
    spawn = spawnSync,
    localTempDirectory = join(tmpdir(), "vem-factory-acceptance-staging"),
    cleanupLocal = true,
  } = {},
) {
  if (options.mode !== "clean-base-factory-acceptance") {
    throw new Error(
      "factory staging cleanup requires a factory acceptance mode",
    );
  }
  const { remoteSupportScriptRoot, remoteScriptPath } =
    factoryAcceptanceRemoteStagingPaths(options);
  const sshOptions = { ...options };
  if (options.mode === "clean-base-factory-acceptance") {
    mkdirSync(localTempDirectory, { recursive: true, mode: 0o700 });
    sshOptions.sshKnownHostsPath = join(localTempDirectory, "known_hosts");
  }
  let remoteCleaned = false;
  try {
    const sshCommand = buildSshCommand(sshOptions);
    const cleanup = spawn(
      sshCommand[0],
      [
        ...sshCommand.slice(1),
        `powershell -NoProfile -ExecutionPolicy Bypass -Command "Remove-Item -LiteralPath ${quotePowerShellSingleQuoted(remoteScriptPath)} -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ${quotePowerShellSingleQuoted(remoteSupportScriptRoot)} -Recurse -Force -ErrorAction SilentlyContinue; if (Test-Path -LiteralPath ${quotePowerShellSingleQuoted(remoteSupportScriptRoot)}) { throw 'factory staging cleanup retained protected media' }"`,
      ],
      {
        encoding: "utf8",
        stdio: "ignore",
        env: nonQueryChildEnvironment(),
      },
    );
    remoteCleaned = cleanup.status === 0;
  } finally {
    if (cleanupLocal) {
      rmSync(localTempDirectory, { recursive: true, force: true });
    }
  }
  const localCleaned = cleanupLocal ? !existsSync(localTempDirectory) : true;
  return { localCleaned, remoteCleaned };
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
  const remote = options.remote ?? DEFAULT_CONTROLLED_MAINTENANCE_REMOTE;
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

export function buildCleanBaseRemoteIdentityProbeCommand() {
  return buildEncodedPowerShellCommand(`
$ErrorActionPreference = 'SilentlyContinue'
$computer = Get-CimInstance Win32_ComputerSystem
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
[pscustomobject]@{
  hostName = [string]$computer.Name
  user = [string]$identity.Name
} | ConvertTo-Json -Depth 10
`);
}

export function buildCleanBaseRemotePreflightAbsenceProbeCommand() {
  const probesJson = JSON.stringify(CLEAN_BASE_PREFLIGHT_ABSENCE_PROBES);
  return buildEncodedPowerShellCommand(`
$ErrorActionPreference = 'Stop'
$probes = '${probesJson.replaceAll("'", "''")}' | ConvertFrom-Json

function Get-CleanBaseScheduledTaskState([string]$Task) {
  $normalized = $Task.Trim("\\")
  $separator = $normalized.LastIndexOf("\\")
  if ($separator -ge 0) {
    $taskPath = "\\" + $normalized.Substring(0, $separator) + "\\"
    $taskName = $normalized.Substring($separator + 1)
  } else {
    $taskPath = "\\"
    $taskName = $normalized
  }
  $taskObject = Get-ScheduledTask -TaskName $taskName -TaskPath $taskPath -ErrorAction SilentlyContinue
  if ($null -eq $taskObject) {
    return $null
  }
  return [ordered]@{
    name = $Task
    taskName = $taskName
    taskPath = $taskPath
    state = [string]$taskObject.State
  }
}

$results = @()
foreach ($probe in @($probes)) {
  $observedPaths = @()
  $observedServices = @()
  $observedTasks = @()
  foreach ($path in @($probe.paths)) {
    if (Test-Path -LiteralPath $path) {
      $observedPaths += [string]$path
    }
  }
  foreach ($serviceName in @($probe.services)) {
    $service = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($null -ne $service) {
      $observedServices += [ordered]@{
        name = [string]$service.Name
        status = [string]$service.Status
        startType = [string]$service.StartType
      }
    }
  }
  foreach ($taskName in @($probe.tasks)) {
    $task = Get-CleanBaseScheduledTaskState $taskName
    if ($null -ne $task) {
      $observedTasks += $task
    }
  }
  $passed = $observedPaths.Count -eq 0 -and $observedServices.Count -eq 0 -and $observedTasks.Count -eq 0
  $results += [ordered]@{
    code = [string]$probe.code
    status = if ($passed) { "passed" } else { "failed" }
    paths = @($probe.paths)
    services = @($probe.services)
    tasks = @($probe.tasks)
    observed = @($observedPaths)
    observedPaths = @($observedPaths)
    observedServices = @($observedServices)
    observedTasks = @($observedTasks)
  }
}

[pscustomobject]@{
  ok = @($results | Where-Object { [string]$_.status -ne "passed" }).Count -eq 0
  probes = @($results)
} | ConvertTo-Json -Depth 20
`);
}

function assertCleanBaseRemoteIdentityProbe(options, sshCommand) {
  if (options.mode !== "clean-base-factory-acceptance") {
    return;
  }
  const probeCommand = buildCleanBaseRemoteIdentityProbeCommand();
  const result = spawnSync(
    sshCommand[0],
    [...sshCommand.slice(1), probeCommand],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: nonQueryChildEnvironment(),
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `clean-base factory acceptance could not verify remote identity before staging: ${
        result.stderr || result.stdout || `ssh exited ${result.status}`
      }`,
    );
  }
  let identity;
  try {
    identity = JSON.parse(result.stdout || "null");
  } catch {
    throw new Error(
      `clean-base factory acceptance remote identity probe returned invalid JSON: ${result.stdout}`,
    );
  }
  const refusal = classifyUnsafeCleanBaseSource(identity);
  if (refusal) {
    throw new Error(
      `clean-base factory acceptance refuses ${refusal} remote identity before staging`,
    );
  }
}

function assertCleanBaseRemotePreflightAbsenceProbe(options, sshCommand) {
  if (options.mode !== "clean-base-factory-acceptance") {
    return;
  }
  const probeCommand = buildCleanBaseRemotePreflightAbsenceProbeCommand();
  const result = spawnSync(
    sshCommand[0],
    [...sshCommand.slice(1), probeCommand],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: nonQueryChildEnvironment(),
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `clean-base factory acceptance could not verify retained-state absence before staging: ${
        result.stderr || result.stdout || `ssh exited ${result.status}`
      }`,
    );
  }
  let preflight;
  try {
    preflight = JSON.parse(result.stdout || "null");
  } catch {
    throw new Error(
      `clean-base factory acceptance remote retained-state preflight returned invalid JSON: ${result.stdout}`,
    );
  }
  if (preflight?.ok !== true) {
    const failed = Array.isArray(preflight?.probes)
      ? preflight.probes
          .filter((probe) => probe?.status !== "passed")
          .map((probe) => probe?.code)
      : ["unknown"];
    throw new Error(
      `clean-base factory acceptance retained-state preflight failed before staging: ${failed.join(
        ", ",
      )}`,
    );
  }
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
  if (mode === "clean-base-factory-acceptance") {
    try {
      const output = JSON.parse(String(stdout ?? ""));
      return output?.ok === true &&
        output?.cleanBaseFactoryAcceptance?.ok === true
        ? 0
        : 1;
    } catch {
      return 1;
    }
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
  win10-vem-e2e.mjs [--mode inventory|reset|inventory-reset|bring-up|provision|runtime-acceptance|simulated-hardware-sale-flow|clean-base-factory-acceptance|validate-clean-base-evidence|factory-image-delivery-unit|factory-preclaim-verify|vm-runtime-acceptance] [--run-id ID] [--claim-code CODE] [--ephemeral-platform-evidence PATH] [--ephemeral-api-base-url URL] [--ephemeral-mqtt-url URL] [--clean-base-source SOURCE] [--clean-base-snapshot SNAPSHOT] [--clean-base-evidence PATH] [--daemon-artifact PATH] [--machine-ui-artifact PATH] [--daemon-artifact-sha256 HASH] [--machine-ui-artifact-sha256 HASH] [--factory-profile production|testbed] [--factory-media-root PATH] [--vision-configuration-source-path PATH] [--factory-hardware-model MODEL] [--factory-topology-identity ID] [--factory-topology-version VERSION] [--openssh-package PATH] [--openssh-package-sha256 HASH] [--openssh-package-version VERSION] [--openssh-approved-signer-thumbprint SHA1] [--openssh-approved-root-thumbprint SHA1] [--wireguard-package PATH] [--wireguard-package-sha256 HASH] [--wireguard-package-version VERSION] [--wireguard-approved-signer-thumbprint SHA1] [--wireguard-approved-root-thumbprint SHA1] [--maintenance-ca-public-key PATH] [--maintenance-ca-sha256 HASH] [--maintenance-wireguard-listen-address IP] [--maintenance-runner-source-allowlist CSV] [--maintenance-maintainer-source-allowlist CSV] [--allow-clean-base-prepare] [--remote USER@HOST] [--ssh-port PORT] [--expected-testbed-user USER] --identity KEY --certificate CERT [--dry-run] [--out PATH]

Defaults target the documented Machine Runtime Testbed:
  --remote ${DEFAULT_CONTROLLED_MAINTENANCE_REMOTE}
  --mode inventory

Bring-up mode invokes C:\\VEM\\bringup\\scripts\\setup-scheduled-tasks.ps1 on the remote host and requires VEM_KIOSK_PASSWORD, VEM_MAINTENANCE_PASSWORD, and VEM_AUTOLOGON_PASSWORD in the remote PowerShell environment.

Provision mode starts and reads the daemon IPC, applies only pre-claim platform endpoints, obtains its current claim task cursor, and claims the prepared testbed identity through daemon IPC /v1/bring-up/tasks/execute.

Runtime-acceptance mode writes C:\\ProgramData\\VEM\\vending-daemon\\runtime-acceptance-report.json on the remote host and includes the same report in stdout; use --out to save the SSH response locally.

Simulated hardware sale-flow mode writes C:\\ProgramData\\VEM\\vending-daemon\\simulated-hardware-sale-flow.json on the remote host and includes the same report in stdout. It requires --ephemeral-platform-evidence from service-api testbed:prepare-ephemeral-platform, an explicit non-shared --platform-target, a same-run daemon IPC claim, simulated hardware mode, platform planogram sync, stock attestation upload acceptance, mock payment readiness, and simulated dispense success.

Clean-base factory acceptance mode prepares an explicitly identified existing clean Windows base or VM source. Dry-run emits the checklist, absence probes, report path, and destructive gate. Live preparation requires --allow-clean-base-prepare, stages daemon/UI artifacts plus WebView2Loader.dll, runs factory preparation and verifier scripts, writes clean-base-factory-acceptance.json, and must not use the known dirty testbed or production machine identities as clean-base proof.
Clean-base factory acceptance requires an explicit profile, hardware/topology metadata, fixed local OpenSSH and WireGuard packages, approved Authenticode signer/root thumbprints, one profile-bound CA public key, a WireGuard listen address, and explicit runner and maintainer role pools. A production run also requires --factory-media-root and --vision-configuration-source-path, which must already be accessible on the clean Windows base for the child Factory preparation entrypoint. The clean-base path stages under C:\Windows\Temp and does not infer YKDZ, platform host identity, simulator, or production platform metadata. No Windows Capability, online package, shared WireGuard private key, maintenance password input, or password SSH fallback is accepted.

Validate-clean-base-evidence mode validates a clean-base factory acceptance report before VM runtime acceptance consumes it.

Factory-image-delivery-unit mode reads a completed clean-base factory acceptance report and writes a sanitized Factory Image Delivery Unit report that indexes source identity, declared inputs, artifacts, manifest, preparation logs, verifier evidence, screenshots/session availability, readiness, and acceptance evidence without mutating a VM.

Factory-preclaim-verify mode connects only through an adapter-discovered certificate SSH endpoint, invokes the Factory ISO-installed verifier without preparation, and emits structured baseline and unclaimed-identity evidence before approved-base capture.

VM runtime acceptance mode is the CI/manual gate entrypoint. It verifies the restored approved preclaim base through certificate-only SSH, then runs ephemeral platform setup, runtime acceptance, and simulated hardware sale-flow in one non-interactive sequence. It requires --run-id, a non-shared --platform-target, VEM_EPHEMERAL_DATABASE_URL, explicit --ephemeral-api-base-url/--ephemeral-mqtt-url, and certificate SSH inputs. Reports and logs are written under artifacts/vm-runtime-acceptance/<run-id>/.
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
    } else if (arg === "--approved-runtime-base") {
      options.approvedRuntimeBase = next;
      index += 1;
    } else if (arg === "--machine-code-prefix") {
      options.machineCodePrefix = next;
      index += 1;
    } else if (arg === "--clean-base-source") {
      options.cleanBaseSource = next;
      index += 1;
    } else if (arg === "--clean-base-snapshot") {
      options.cleanBaseSnapshot = next;
      index += 1;
    } else if (arg === "--clean-base-evidence") {
      options.cleanBaseEvidence = next;
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
    } else if (arg === "--maintenance-ingress-source-allowlist") {
      options.maintenanceIngressSourceAllowlist = next;
      index += 1;
    } else if (arg === "--factory-profile") {
      options.factoryProfile = next;
      index += 1;
    } else if (arg === "--factory-media-root") {
      options.factoryMediaRoot = next;
      index += 1;
    } else if (arg === "--vision-configuration-source-path") {
      options.visionConfigurationSourcePath = next;
      index += 1;
    } else if (arg === "--factory-iso") {
      options.factoryIso = next;
      index += 1;
    } else if (arg === "--factory-guest-endpoint-json") {
      options.factoryGuestEndpointJson = next;
      index += 1;
    } else if (arg === "--maintenance-relay-session-json") {
      options.maintenanceRelaySession = parseJsonObjectArgument(arg, next);
      index += 1;
    } else if (arg === "--maintenance-endpoint-policy-json") {
      options.maintenanceEndpointPolicy = parseJsonObjectArgument(arg, next);
      index += 1;
    } else if (arg === "--factory-assembly-mode") {
      options.factoryAssemblyMode = next;
      index += 1;
    } else if (arg === "--factory-manifest") {
      options.factoryManifest = next;
      index += 1;
    } else if (arg === "--factory-provenance") {
      options.factoryProvenance = next;
      index += 1;
    } else if (arg === "--factory-provenance-digest") {
      options.factoryProvenanceDigest = next;
      index += 1;
    } else if (arg === "--factory-manifest-path") {
      options.factoryManifestPath = next;
      index += 1;
    } else if (arg === "--factory-provenance-path") {
      options.factoryProvenancePath = next;
      index += 1;
    } else if (arg === "--factory-iso-path") {
      options.factoryIsoPath = next;
      index += 1;
    } else if (arg === "--factory-udf-extractor") {
      options.factoryUdfExtractorPath = next;
      index += 1;
    } else if (arg === "--factory-udf-writer") {
      options.factoryUdfWriterPath = next;
      index += 1;
    } else if (arg === "--factory-wimlib") {
      options.factoryWimlibPath = next;
      index += 1;
    } else if (arg === "--openssh-package") {
      options.openSshPackage = next;
      index += 1;
    } else if (arg === "--openssh-package-sha256") {
      options.openSshPackageSha256 = next;
      index += 1;
    } else if (arg === "--openssh-package-version") {
      options.openSshPackageVersion = next;
      index += 1;
    } else if (arg === "--openssh-approved-signer-thumbprint") {
      options.openSshApprovedSignerThumbprint = next;
      index += 1;
    } else if (arg === "--openssh-approved-root-thumbprint") {
      options.openSshApprovedRootThumbprint = next;
      index += 1;
    } else if (arg === "--wireguard-package") {
      options.wireGuardPackage = next;
      index += 1;
    } else if (arg === "--wireguard-package-sha256") {
      options.wireGuardPackageSha256 = next;
      index += 1;
    } else if (arg === "--wireguard-package-version") {
      options.wireGuardPackageVersion = next;
      index += 1;
    } else if (arg === "--wireguard-approved-signer-thumbprint") {
      options.wireGuardApprovedSignerThumbprint = next;
      index += 1;
    } else if (arg === "--wireguard-approved-root-thumbprint") {
      options.wireGuardApprovedRootThumbprint = next;
      index += 1;
    } else if (arg === "--maintenance-ca-public-key") {
      options.maintenanceCaPublicKey = next;
      index += 1;
    } else if (arg === "--maintenance-ca-sha256") {
      options.maintenanceCaPublicKeySha256 = next;
      index += 1;
    } else if (arg === "--maintenance-wireguard-listen-address") {
      options.maintenanceWireGuardListenAddress = next;
      index += 1;
    } else if (arg === "--factory-hardware-model") {
      options.factoryHardwareModel = next;
      index += 1;
    } else if (arg === "--factory-topology-identity") {
      options.factoryTopologyIdentity = next;
      index += 1;
    } else if (arg === "--factory-topology-version") {
      options.factoryTopologyVersion = next;
      index += 1;
    } else if (arg === "--maintenance-runner-source-allowlist") {
      options.maintenanceRunnerSourceAllowlist = next;
      index += 1;
    } else if (arg === "--maintenance-maintainer-source-allowlist") {
      options.maintenanceMaintainerSourceAllowlist = next;
      index += 1;
    } else if (arg === "--allow-clean-base-prepare") {
      options.allowCleanBasePrepare = true;
    } else if (arg === "--expected-testbed-user") {
      options.expectedTestbedUser = next;
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--cleanup-factory-staging") {
      options.cleanupFactoryStaging = true;
    } else if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function parseJsonObjectArgument(option, value) {
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an object");
    return parsed;
  } catch {
    throw new Error(`${option} must be a JSON object`);
  }
}

function applyFactoryGuestEndpoint(options) {
  if (
    options.maintenanceEndpointPolicy !== undefined &&
    options.maintenanceRelaySession === undefined
  ) {
    throw new Error(
      "--maintenance-endpoint-policy-json requires --maintenance-relay-session-json",
    );
  }
  if (!options.factoryGuestEndpointJson) return options;
  let endpoint;
  try {
    endpoint = JSON.parse(options.factoryGuestEndpointJson);
  } catch {
    throw new Error(
      "--factory-guest-endpoint-json must be adapter-discovered endpoint JSON",
    );
  }
  if (
    endpoint?.protocol !== "ssh" ||
    typeof endpoint.host !== "string" ||
    isIP(endpoint.host) === 0 ||
    ["0.0.0.0", "::", "127.0.0.1", "::1"].includes(endpoint.host) ||
    !Number.isInteger(endpoint.port) ||
    endpoint.port !== 22 ||
    !["discovered", "authenticated"].includes(endpoint.reachability) ||
    !options.expectedTestbedUser ||
    options.remote ||
    options.sshPort
  ) {
    throw new Error(
      "Factory verification and post-claim acceptance require an adapter-discovered SSH endpoint, --expected-testbed-user, and no caller-supplied remote or SSH port",
    );
  }
  if (endpoint.transport === "testbed-runner-direct") {
    if (
      endpoint.relayProof !== undefined ||
      ![
        "factory-preclaim-verify",
        "provision",
        "runtime-acceptance",
        "vm-runtime-acceptance",
      ].includes(options.mode)
    ) {
      throw new Error(
        "testbed runner-direct Factory endpoint is valid only for Factory lifecycle SSH without Relay proof",
      );
    }
  } else if (endpoint.transport !== "wireguard") {
    throw new Error(
      "Factory endpoint transport must be wireguard or testbed-runner-direct",
    );
  }
  return {
    ...options,
    remote: `${options.expectedTestbedUser}@${endpoint.host}`,
    sshPort: endpoint.port,
    sshHostKeyAlias:
      options.sshHostKeyAlias ??
      `vem-factory-${normalizeEphemeralRunId(options.runId).toLowerCase()}`,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => {
    try {
      const options = applyFactoryGuestEndpoint(
        parseArgs(process.argv.slice(2)),
      );
      if (options.help) {
        usage();
        process.exit(0);
      }
      if (options.cleanupFactoryStaging === true) {
        const cleanup = cleanupFactoryAcceptanceStaging(options);
        if (!cleanup.localCleaned || !cleanup.remoteCleaned) {
          throw new Error("factory staging cleanup verification failed");
        }
        process.exitCode = 0;
        return;
      }
      options.factoryMediaAdmission =
        await admitFactoryMediaBeforeAcceptance(options);
      if (options.mode === "factory-preclaim-verify") {
        const ownsSshTrust = !options.sshKnownHostsPath;
        const localTempDirectory = ownsSshTrust
          ? mkdtempSync(join(tmpdir(), "vem-factory-preclaim-"))
          : null;
        try {
          if (ownsSshTrust) {
            options.sshKnownHostsPath = join(localTempDirectory, "known_hosts");
          }
          const sshCommand = buildSshCommand(options);
          const remoteScript = buildRemotePowerShellScript(options);
          const remoteCommand = buildStdinPowerShellCommand();
          const result = await runTransientSshOperation(
            sshCommand[0],
            [...sshCommand.slice(1), remoteCommand],
            {
              input: `${remoteScript}\n`,
              maxAttempts: 72,
              retryDelayMs: 5000,
            },
          );
          if (result.stderr) process.stderr.write(result.stderr);
          const report = parseStructuredSshVerifierEvidence(result.stdout);
          if (report === null) {
            throw new Error(
              "factory-preclaim-verify did not return structured verifier evidence",
            );
          }
          const sanitizedReport = sanitizeFactoryPreclaimReport(report);
          process.stdout.write(`${JSON.stringify(sanitizedReport, null, 2)}\n`);
          if (options.out) writeJsonOutput(options.out, sanitizedReport);
          if (result.status !== 0 || report.ok !== true) {
            process.exitCode = 1;
          }
        } finally {
          if (ownsSshTrust) {
            rmSync(localTempDirectory, { recursive: true, force: true });
          }
        }
        return;
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
      if (options.mode === "clean-base-factory-acceptance") {
        const plan = buildCleanBaseFactoryAcceptancePlan(options);
        if (options.dryRun) {
          if (options.out) {
            writeJsonOutput(options.out, plan);
          }
          console.log(JSON.stringify(plan, null, 2));
          process.exit(0);
        }
        if (options.allowCleanBasePrepare !== true) {
          throw new Error(
            "clean-base factory acceptance live mode requires --allow-clean-base-prepare",
          );
        }
      }
      if (options.mode === "validate-clean-base-evidence") {
        if (!options.cleanBaseEvidence) {
          throw new Error(
            "validate-clean-base-evidence requires --clean-base-evidence",
          );
        }
        const validation = validateCleanBaseFactoryAcceptanceEvidenceFile(
          options.cleanBaseEvidence,
        );
        process.stdout.write(`${JSON.stringify(validation, null, 2)}\n`);
        process.exit(validation.status === "passed" ? 0 : 1);
      }
      if (options.mode === "factory-image-delivery-unit") {
        const report = runFactoryImageDeliveryUnit(options);
        console.error(`wrote report: ${report.reportPath}`);
        if (!options.out) {
          process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        }
        process.exit(report.ok ? 0 : 1);
      }
      assertCleanBaseRemoteSafety(options);
      const cleanBaseArtifacts = resolveCleanBaseArtifactInputs(options);
      const cleanBaseFactoryCapability =
        resolveCleanBaseFactoryCapabilityInputs(options);
      if (cleanBaseArtifacts) {
        options.daemonArtifactSha256 = cleanBaseArtifacts.daemonSha256;
        options.machineUiArtifactSha256 = cleanBaseArtifacts.machineUiSha256;
      }
      if (cleanBaseFactoryCapability) {
        options.openSshPackageSha256 =
          cleanBaseFactoryCapability.openSshPackageSha256;
        options.wireGuardPackageSha256 =
          cleanBaseFactoryCapability.wireGuardPackageSha256;
        options.maintenanceCaPublicKeySha256 =
          cleanBaseFactoryCapability.maintenanceCaPublicKeySha256;
        options.maintenanceRunnerSourceAllowlist =
          cleanBaseFactoryCapability.runnerSources.join(",");
        options.maintenanceMaintainerSourceAllowlist =
          cleanBaseFactoryCapability.maintainerSources.join(",");
      }
      const { remoteTempRoot, remoteSupportScriptRoot, remoteScriptPath } =
        factoryAcceptanceRemoteStagingPaths(options);
      const remoteUploadedArtifactRoot = `${remoteSupportScriptRoot}\\input-artifacts`;
      if (options.mode === "clean-base-factory-acceptance") {
        options.remoteSupportScriptRoot = remoteSupportScriptRoot;
        options.remoteUploadedArtifactRoot = remoteUploadedArtifactRoot;
        options.remotePersonalizationMediaPath = `${remoteSupportScriptRoot}\\personalization\\factory-personalization-media.json`;
        if (cleanBaseFactoryCapability) {
          options.remoteOpenSshPackagePath = `${remoteUploadedArtifactRoot}\\${basename(options.openSshPackage)}`;
          options.remoteWireGuardPackagePath = `${remoteUploadedArtifactRoot}\\${basename(options.wireGuardPackage)}`;
          options.remoteMaintenanceCaPublicKeyPath = `${remoteUploadedArtifactRoot}\\maintenance-ca.pub`;
        }
      }
      const factoryAcceptanceMode =
        options.mode === "clean-base-factory-acceptance";
      const localTempDirectory = factoryAcceptanceMode
        ? join(tmpdir(), "vem-factory-acceptance-staging")
        : mkdtempSync(join(tmpdir(), "vem-win10-e2e-"));
      if (factoryAcceptanceMode) {
        // A deterministic local root makes retained secret staging visible and
        // removable before retry after a prior uncatchable interruption.
        rmSync(localTempDirectory, { recursive: true, force: true });
        mkdirSync(localTempDirectory, { recursive: true, mode: 0o700 });
      }
      if (
        !options.sshKnownHostsPath &&
        (options.mode === "clean-base-factory-acceptance" ||
          options.factoryGuestEndpointJson)
      ) {
        options.sshKnownHostsPath = join(localTempDirectory, "known_hosts");
      }
      const script = buildRemotePowerShellScript(options);
      const sshCommand = buildSshCommand(options);
      assertCleanBaseRemoteIdentityProbe(options, sshCommand);
      assertCleanBaseRemotePreflightAbsenceProbe(options, sshCommand);
      // The host-owned secret file is opened only after the remote identity and
      // retained-state gates have accepted this clean-base target.
      const personalizationMedia =
        options.dryRun === true
          ? null
          : await resolveHostOwnedFactoryPersonalizationMedia(options);
      const localPersonalizationStaging = personalizationMedia
        ? await createFactoryPersonalizationStagingCopy({
            snapshot: personalizationMedia.snapshot,
            stagingRoot: join(localTempDirectory, "factory-personalization"),
          })
        : null;
      const localScriptPath = join(localTempDirectory, "run.ps1");
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
              bringUpPlan: buildBringUpPlan(options),
              runId:
                options.mode === "simulated-hardware-sale-flow"
                  ? sanitizeRunId(options.runId)
                  : null,
              cleanBaseFactoryCapability: cleanBaseFactoryCapability
                ? {
                    openSshPackageSha256:
                      cleanBaseFactoryCapability.openSshPackageSha256,
                    wireGuardPackageSha256:
                      cleanBaseFactoryCapability.wireGuardPackageSha256,
                    maintenanceCaPublicKeySha256:
                      cleanBaseFactoryCapability.maintenanceCaPublicKeySha256,
                    runnerSources: cleanBaseFactoryCapability.runnerSources,
                    maintainerSources:
                      cleanBaseFactoryCapability.maintainerSources,
                  }
                : null,
            },
            null,
            2,
          ),
        );
        rmSync(localTempDirectory, { recursive: true, force: true });
        process.exitCode = 0;
        return;
      }

      const cleanupRemoteFactoryStaging = () =>
        factoryAcceptanceMode
          ? cleanupFactoryAcceptanceStaging(options, {
              localTempDirectory,
              cleanupLocal: false,
            }).remoteCleaned
          : true;
      const cleanupLocalFactoryStaging = () => {
        if (!localPersonalizationStaging) {
          return true;
        }
        rmSync(join(localTempDirectory, "factory-personalization"), {
          recursive: true,
          force: true,
        });
        return !existsSync(join(localTempDirectory, "factory-personalization"));
      };
      const cancellation = createFactoryAcceptanceCancellationController({
        cleanupRemoteFactoryStaging,
        cleanupLocalFactoryStaging,
        removeLocalTempDirectory: () => {
          rmSync(localTempDirectory, { recursive: true, force: true });
          return !existsSync(localTempDirectory);
        },
      });
      const removeSignalHandlers =
        installFactoryAcceptanceSignalHandlers(cancellation);

      try {
        // Clear a deterministic retained root before every retry. This also covers
        // an earlier catchable cancellation; uncatchable loss is cleaned here on
        // the next invocation.
        cancellation.throwIfCancellationRequested();
        if (!cleanupRemoteFactoryStaging()) {
          throw new Error(
            "factory stale staging cleanup verification failed before retry",
          );
        }
        writeFileSync(localScriptPath, script, "utf8");
        const upload = await runTransientSshOperation(
          scpCommand[0],
          scpCommand.slice(1),
          { signal: cancellation.signal },
        );
        cancellation.throwIfCancellationRequested();
        if (upload.stdout) {
          process.stdout.write(upload.stdout);
        }
        if (upload.stderr) {
          process.stderr.write(upload.stderr);
        }
        if (upload.status !== 0) {
          throw new Error(
            `Factory acceptance script upload failed with status ${upload.status ?? 1}`,
          );
        }

        if (options.mode === "clean-base-factory-acceptance") {
          const personalizationDirectory = `${remoteSupportScriptRoot}\\personalization`;
          const createSupportRootCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; function Assert-VemFactoryPersonalizationAcl([string]\$Path, [bool]\$Directory) { \$acl = Get-Acl -LiteralPath \$Path -ErrorAction Stop; \$admin = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544'); \$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18'); \$owner = (New-Object System.Security.Principal.NTAccount(\$acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value; if (\$owner -ne \$admin.Value -or -not \$acl.AreAccessRulesProtected) { throw 'factory personalization ACL owner or inheritance is unsafe' }; \$rules = @(@(\$acl.Access) | Where-Object { -not \$_.IsInherited }); if (\$rules.Count -ne 2 -or @('\$system', '\$admin').Count -ne 2) { throw 'factory personalization ACL rule count is unsafe' }; foreach (\$rule in \$rules) { \$sid = \$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if (\$sid -notin @('S-1-5-18', 'S-1-5-32-544') -or \$rule.AccessControlType -ne 'Allow' -or (\$rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'factory personalization ACL grants an unsafe principal or right' } } }; New-Item -ItemType Directory -Path ${quotePowerShellSingleQuoted(remoteSupportScriptRoot)} -Force | Out-Null; New-Item -ItemType Directory -Path ${quotePowerShellSingleQuoted(remoteUploadedArtifactRoot)} -Force | Out-Null; New-Item -ItemType Directory -Path ${quotePowerShellSingleQuoted(personalizationDirectory)} -Force | Out-Null; \$acl = Get-Acl -LiteralPath ${quotePowerShellSingleQuoted(personalizationDirectory)}; \$acl.SetAccessRuleProtection(\$true, \$false); foreach (\$rule in @(\$acl.Access)) { [void]\$acl.RemoveAccessRuleAll(\$rule) }; \$admin = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544'); \$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18'); \$acl.SetOwner(\$admin); foreach (\$sid in @(\$system, \$admin)) { \$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(\$sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))) }; Set-Acl -LiteralPath ${quotePowerShellSingleQuoted(personalizationDirectory)} -AclObject \$acl; & icacls.exe ${quotePowerShellSingleQuoted(personalizationDirectory)} /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null; if (\$LASTEXITCODE -ne 0) { throw 'icacls failed to protect factory personalization staging' }; Assert-VemFactoryPersonalizationAcl -Path ${quotePowerShellSingleQuoted(personalizationDirectory)} -Directory \$true"`;
          const createSupportRoot = await runTransientSshOperation(
            sshCommand[0],
            [...sshCommand.slice(1), createSupportRootCommand],
            { signal: cancellation.signal },
          );
          if (createSupportRoot.stdout) {
            process.stdout.write(createSupportRoot.stdout);
          }
          if (createSupportRoot.stderr) {
            process.stderr.write(createSupportRoot.stderr);
          }
          if (createSupportRoot.status !== 0) {
            throw new Error(
              `Factory personalization staging ACL setup failed with status ${createSupportRoot.status ?? 1}`,
            );
          }

          for (const scriptName of FACTORY_SUPPORT_SCRIPT_NAMES) {
            const supportUpload = buildScpCommand(
              `scripts/windows/${scriptName}`,
              `${remoteSupportScriptRoot}\\${scriptName}`,
              options,
            );
            const uploadSupportScript = await runTransientSshOperation(
              supportUpload[0],
              supportUpload.slice(1),
              { signal: cancellation.signal },
            );
            if (uploadSupportScript.stdout) {
              process.stdout.write(uploadSupportScript.stdout);
            }
            if (uploadSupportScript.stderr) {
              process.stderr.write(uploadSupportScript.stderr);
            }
            if (uploadSupportScript.status !== 0) {
              throw new Error(
                `Factory support script upload failed with status ${uploadSupportScript.status ?? 1}`,
              );
            }
          }

          const artifactUploads = [
            ["daemonArtifact", "vending-daemon.exe"],
            ["machineUiArtifact", "machine.exe"],
            [
              "machineUiSidecarArtifact",
              "WebView2Loader.dll",
              options.machineUiArtifact
                ? resolveMachineUiSidecarArtifactPath(options.machineUiArtifact)
                : null,
            ],
          ];
          if (cleanBaseFactoryCapability) {
            artifactUploads.push(
              ["openSshPackage", basename(options.openSshPackage)],
              ["wireGuardPackage", basename(options.wireGuardPackage)],
              ["maintenanceCaPublicKey", "maintenance-ca.pub"],
            );
          }
          for (const [
            optionName,
            remoteFileName,
            explicitLocalPath,
          ] of artifactUploads) {
            const localPath = explicitLocalPath ?? options[optionName];
            if (!localPath) {
              continue;
            }
            const artifactUpload = buildScpCommand(
              localPath,
              `${remoteUploadedArtifactRoot}\\${remoteFileName}`,
              options,
            );
            const uploadArtifact = await runTransientSshOperation(
              artifactUpload[0],
              artifactUpload.slice(1),
              { signal: cancellation.signal },
            );
            if (uploadArtifact.stdout) {
              process.stdout.write(uploadArtifact.stdout);
            }
            if (uploadArtifact.stderr) {
              process.stderr.write(uploadArtifact.stderr);
            }
            if (uploadArtifact.status !== 0) {
              throw new Error(
                `Factory artifact upload failed with status ${uploadArtifact.status ?? 1}`,
              );
            }
          }
          if (localPersonalizationStaging) {
            const mediaUpload = buildScpCommand(
              localPersonalizationStaging.stagedPath,
              options.remotePersonalizationMediaPath,
              options,
            );
            const uploadedMedia = await runTransientSshOperation(
              mediaUpload[0],
              mediaUpload.slice(1),
              { signal: cancellation.signal },
            );
            if (uploadedMedia.status !== 0) {
              throw new Error("Factory Personalization Media upload failed");
            }
            const verifyMediaAclCommand = `powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference = 'Stop'; \$path = ${quotePowerShellSingleQuoted(options.remotePersonalizationMediaPath)}; if (-not (Test-Path -LiteralPath \$path -PathType Leaf)) { throw 'factory personalization media is missing' }; \$acl = Get-Acl -LiteralPath \$path -ErrorAction Stop; \$acl.SetAccessRuleProtection(\$true, \$false); foreach (\$rule in @(\$acl.Access)) { [void]\$acl.RemoveAccessRuleAll(\$rule) }; \$admin = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544'); \$system = New-Object System.Security.Principal.SecurityIdentifier('S-1-5-18'); \$acl.SetOwner(\$admin); foreach (\$sid in @(\$system, \$admin)) { \$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(\$sid, 'FullControl', 'None', 'None', 'Allow'))) }; Set-Acl -LiteralPath \$path -AclObject \$acl; & icacls.exe \$path /inheritance:r /grant:r '*S-1-5-18:F' '*S-1-5-32-544:F' | Out-Null; if (\$LASTEXITCODE -ne 0) { throw 'icacls failed to protect factory personalization media' }; \$acl = Get-Acl -LiteralPath \$path -ErrorAction Stop; \$owner = (New-Object System.Security.Principal.NTAccount(\$acl.Owner)).Translate([System.Security.Principal.SecurityIdentifier]).Value; \$rules = @(@(\$acl.Access) | Where-Object { -not \$_.IsInherited }); if (\$owner -ne \$admin.Value -or -not \$acl.AreAccessRulesProtected -or \$rules.Count -ne 2) { throw 'factory personalization media ACL is unsafe' }; foreach (\$rule in \$rules) { \$sid = \$rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value; if (\$sid -notin @('S-1-5-18', 'S-1-5-32-544') -or \$rule.AccessControlType -ne 'Allow' -or (\$rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'factory personalization media ACL grants an unsafe principal or right' } }"`;
            const verifiedMediaAcl = await runTransientSshOperation(
              sshCommand[0],
              [...sshCommand.slice(1), verifyMediaAclCommand],
              { signal: cancellation.signal },
            );
            if (verifiedMediaAcl.status !== 0) {
              throw new Error(
                "Factory Personalization Media ACL verification failed before Windows reads it",
              );
            }
          }
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
        cancellation.throwIfCancellationRequested();
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
        try {
          cancellation.finalize();
        } finally {
          removeSignalHandlers();
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      usage();
      process.exitCode =
        error instanceof Error && /cancelled by SIG/.test(error.message)
          ? 128
          : 2;
    }
  })();
}
