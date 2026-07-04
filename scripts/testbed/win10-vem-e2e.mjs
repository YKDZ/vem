#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";

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

const PLATFORM_TARGETS = {
  "vem-vps": {
    apiBaseUrl: "http://118.25.104.160:26849/api",
    mqttUrl: "mqtt://118.25.104.160:1883",
  },
};

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

export function buildBringUpPlan(options = {}) {
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
    },
    switches: [
      "ConfigureKioskAccounts",
      "UseKioskAccount",
      "ConfigureAutoLogon",
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

function present(value) {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return true;
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

function toNullableSessionId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

function normalizeSessionEvidence(session) {
  return {
    user: normalizeWindowsUser(session?.user),
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
    normalizedSessions.find(
      (session) =>
        session.user === EXPECTED_KIOSK_USER &&
        session.sessionId !== null &&
        normalizeSessionState(session.state) === "active" &&
        session.source !== "ssh_service_session",
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
    session?.user === EXPECTED_KIOSK_USER &&
    session.sessionId !== null &&
    normalizeSessionState(session.state) === "active" &&
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
  if (facts.provisioning?.usedDaemonIpcClaimPath !== true) {
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
    facts.kioskRuntime?.webviewRunning !== true ||
    !isStrictTauriHashRouteUrl(facts.kioskRuntime?.url)
  ) {
    addDiagnostic(
      diagnostics,
      "kiosk_webview_missing",
      "Machine Runtime Console must be running as a Tauri WebView serving tauri.localhost with a hash route.",
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
  cdpTargets = [],
} = {}) {
  const session = activeSession
    ? normalizeSessionEvidence(activeSession)
    : null;
  const process = Array.isArray(machineProcesses)
    ? machineProcesses.find(
        (candidate) =>
          normalizeWindowsUser(candidate?.ownerUser) === EXPECTED_KIOSK_USER &&
          toNullableSessionId(candidate?.sessionId) === session?.sessionId,
      )
    : null;
  const target = Array.isArray(cdpTargets)
    ? cdpTargets.find((candidate) => isStrictTauriHashRouteUrl(candidate?.url))
    : null;
  const webviewRunning = Boolean(session && process && target);

  return {
    webviewRunning,
    url: target?.url ?? "unavailable:no-tauri-hash-route-target",
    sessionUser: session?.user ?? "unknown",
    sessionId: session?.sessionId ?? null,
    processId: process?.processId ?? null,
    cdpAvailable: Array.isArray(cdpTargets),
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
  const usedDaemonIpcClaimPath = actionList.some((action) => {
    const evidence = action?.evidence ?? {};
    return (
      evidence.usedDaemonIpcClaimPath === true &&
      String(evidence.endpoint ?? "").endsWith("/v1/provisioning/claim") &&
      ["provisioned", "failed"].includes(String(evidence.claimStatus ?? ""))
    );
  });
  return {
    provisioned: configSnapshot?.provisioned === true,
    usedDaemonIpcClaimPath,
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
      "Tailscale",
      "OpenSSH",
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

function psArgumentValue(value) {
  if (String(value).startsWith("$env:")) {
    return String(value);
  }
  return psString(value);
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
  const platformTarget = options.platformTarget ?? "vem-vps";
  const machineCode = options.machineCode ?? "VEM-TESTBED-WINVM-01";
  const supportedModes = [
    "inventory",
    "reset",
    "inventory-reset",
    "bring-up",
    "provision",
    "runtime-acceptance",
  ];
  if (!supportedModes.includes(mode)) {
    throw new Error(`unsupported mode: ${mode}`);
  }
  assertTestbedMachineCode(machineCode);
  if (
    mode === "provision" &&
    !Object.hasOwn(PLATFORM_TARGETS, platformTarget)
  ) {
    throw new Error(`unsupported platform target: ${platformTarget}`);
  }
  const platform =
    PLATFORM_TARGETS[platformTarget] ?? PLATFORM_TARGETS["vem-vps"];
  const claimCode = options.claimCode ?? "";
  if (mode === "provision" && String(claimCode).trim().length === 0) {
    throw new Error("provision mode requires --claim-code");
  }

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

function Invoke-IpcJson([string]$Method, [string]$Uri, $Headers, $Body = $null) {
  if ($null -eq $Body) {
    return Invoke-RestMethod -Method $Method -Uri $Uri -Headers $Headers -TimeoutSec 20
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

function New-PreClaimPublicConfig($Public) {
  return [ordered]@{
    machineCode = $null
    machineId = $null
    machineName = $null
    machineStatus = $null
    machineLocationLabel = $null
    apiBaseUrl = ${psString(platform.apiBaseUrl)}
    mqttUrl = ${psString(platform.mqttUrl)}
    mqttUsername = $null
    mqttClientId = $null
    hardwareAdapter = $Public.hardwareAdapter
    serialPortPath = $Public.serialPortPath
    lowerControllerUsbIdentity = $Public.lowerControllerUsbIdentity
    scannerAdapter = $Public.scannerAdapter
    scannerSerialPortPath = $Public.scannerSerialPortPath
    scannerUsbIdentity = $Public.scannerUsbIdentity
    scannerBaudRate = $Public.scannerBaudRate
    scannerFrameSuffix = $Public.scannerFrameSuffix
    visionEnabled = $Public.visionEnabled
    visionWsUrl = $Public.visionWsUrl
    visionRequestTimeoutMs = $Public.visionRequestTimeoutMs
    machineAudioVolume = $Public.machineAudioVolume
    audioCueSettings = $Public.audioCueSettings
    kioskMode = $Public.kioskMode
    stockMovementRetentionDays = $Public.stockMovementRetentionDays
    runtimeEndpoints = $null
    hardwareProfile = $null
    paymentCapability = $null
    provisioningMetadata = $null
  }
}

function Convert-ConfigSnapshotEvidence($Config) {
  if ($null -eq $Config) {
    return [ordered]@{
      observed = $false
      provisioned = $false
      machineCode = $null
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
      $evidence.config = Convert-ConfigSnapshotEvidence (Invoke-IpcJson "GET" "$baseUrl/v1/config" $headers)
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
  $usedClaimPath = $false
  foreach ($action in @($ProvisioningActions)) {
    $actionEvidence = $action.evidence
    if (
      $null -ne $actionEvidence -and
      [bool]$actionEvidence.usedDaemonIpcClaimPath -and
      ([string]$actionEvidence.endpoint).EndsWith("/v1/provisioning/claim", [StringComparison]::OrdinalIgnoreCase) -and
      @("provisioned", "failed") -contains [string]$actionEvidence.claimStatus
    ) {
      $usedClaimPath = $true
    }
  }

  return [ordered]@{
    provisioned = [bool]$DaemonIpc.config.provisioned
    usedDaemonIpcClaimPath = $usedClaimPath
    machineCode = $DaemonIpc.config.machineCode
    machineSecretConfigured = [bool]$DaemonIpc.config.machineSecretConfigured
    mqttSigningSecretConfigured = [bool]$DaemonIpc.config.mqttSigningSecretConfigured
    mqttPasswordConfigured = [bool]$DaemonIpc.config.mqttPasswordConfigured
    provisioningIssues = @($DaemonIpc.config.provisioningIssues | ForEach-Object { [string]$_ })
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

function Invoke-TestbedProvisioningClaim($Actions) {
  $status = "succeeded"
  $message = $null
  $evidence = [ordered]@{
    usedDaemonIpcClaimPath = $false
    readyFile = ${psString(bringUpPlan.arguments.DaemonReadyFile)}
    endpoint = $null
    expectedMachineCode = ${psString(machineCode)}
    platformTarget = ${psString(platformTarget)}
    apiBaseUrl = ${psString(platform.apiBaseUrl)}
    mqttUrl = ${psString(platform.mqttUrl)}
    preClaimConfigApplied = $false
    claimStatus = "not_attempted"
    claimFailureCode = $null
    claimHttpStatus = $null
    claimResult = [ordered]@{
      restartRequested = $null
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

    $ready = Read-JsonFile ${psString(bringUpPlan.arguments.DaemonReadyFile)}
    if ([string]::IsNullOrWhiteSpace($ready.ipcToken)) {
      throw "ipcToken missing from daemon ready file"
    }
    $baseUrl = Get-IpcBaseUrl $ready
    $headers = @{ Authorization = "Bearer $($ready.ipcToken)" }

    $configBefore = Invoke-IpcJson "GET" "$baseUrl/v1/config" $headers
    $public = $configBefore.public
    Assert-FirstClaimConfig $configBefore

    $public = New-PreClaimPublicConfig $public
    $configPayload = [ordered]@{
      public = $public
      secrets = $null
    }
    $configBeforeClaim = Invoke-IpcJson "PUT" "$baseUrl/v1/config" $headers $configPayload
    $evidence.preClaimConfigApplied = $true

    $claimPayload = [ordered]@{ claimCode = ${psString(claimCode)} }
    $evidence.endpoint = "$baseUrl/v1/provisioning/claim"
    $evidence.usedDaemonIpcClaimPath = $true
    try {
      $claimResult = Invoke-IpcJson "POST" "$baseUrl/v1/provisioning/claim" $headers $claimPayload
      $evidence.claimStatus = "provisioned"
      $evidence.machineCode = $claimResult.machineCode
      $evidence.claimResult.restartRequested = if ($null -ne $claimResult.restartRequested) { [bool]$claimResult.restartRequested } else { $null }
    } catch {
      $claimError = Get-HttpErrorInfo $_
      $evidence.claimStatus = "failed"
      $evidence.claimFailureCode = Convert-ClaimFailureClassification $claimError
      $evidence.claimHttpStatus = $claimError.statusCode
      throw "daemon IPC claim failed: $($evidence.claimFailureCode)"
    }

    $evidence.healthzAfterClaim = Get-SafeHealthzEvidence $baseUrl
    $evidence.readyzAfterClaim = Get-SafeReadyzEvidence $baseUrl
    $configAfter = Invoke-IpcJson "GET" "$baseUrl/v1/config" $headers
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
    $_.user -eq "VEMKiosk" -and $_.state -eq "Active"
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
    $_.user -eq "VEMKiosk" -and $_.state -eq "Active" -and $_.source -ne "ssh_service_session"
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
        source = "webview_cdp"
        error = $null
      }
    }
    return [pscustomobject]@{
      available = $true
      url = "unavailable:no-tauri-hash-route-target"
      source = "webview_cdp"
      error = "no_tauri_hash_route_target"
    }
  } catch {
    return [pscustomobject]@{
      available = $false
      url = "unavailable:webview-cdp"
      source = "webview_cdp"
      error = [string]$_
    }
  }
}

function Get-KioskRuntimeEvidence($ActiveKioskSession) {
  $machineProcesses = @(Get-MachineUiProcessEvidence)
  $kioskProcess = @($machineProcesses | Where-Object {
    $null -ne $ActiveKioskSession -and
    $_.ownerUser -eq "VEMKiosk" -and
    $_.sessionId -eq $ActiveKioskSession.sessionId
  } | Select-Object -First 1)
  $cdp = Get-WebViewCdpUrlEvidence
  return [ordered]@{
    webviewRunning = $kioskProcess.Count -gt 0 -and (Test-TauriHashRouteUrl ([string]$cdp.url))
    url = [string]$cdp.url
    sessionUser = if ($null -ne $ActiveKioskSession) { [string]$ActiveKioskSession.user } else { "unknown" }
    source = $cdp.source
    processId = if ($kioskProcess.Count -gt 0) { $kioskProcess[0].processId } else { $null }
    sessionId = if ($null -ne $ActiveKioskSession) { [int]$ActiveKioskSession.sessionId } else { $null }
    cdpAvailable = [bool]$cdp.available
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
  if (-not [bool]$Facts.provisioning.usedDaemonIpcClaimPath) {
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
  if (-not [bool]$Facts.kioskRuntime.webviewRunning -or -not (Test-RuntimeAcceptanceTauriHashRouteUrl ([string]$Facts.kioskRuntime.url))) {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "kiosk_webview_missing" "Machine Runtime Console must be running as a Tauri WebView serving tauri.localhost with a hash route."
  }
  if ([string]$Facts.kioskRuntime.sessionUser -ne "VEMKiosk") {
    Add-RuntimeAcceptanceDiagnostic $diagnostics "kiosk_session_user_mismatch" "Machine Runtime Console must run in the VEMKiosk customer session."
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
    kioskRuntime = $Facts.kioskRuntime
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
      usedDaemonIpcClaimPath = [bool]$factsSubset.provisioning.usedDaemonIpcClaimPath
      machineCode = if ([string]::IsNullOrWhiteSpace($daemonIpc.config.machineCode)) { $null } else { [string]$daemonIpc.config.machineCode }
    }
    daemonRuntime = [ordered]@{
      ipcReachable = $daemonRuntime.ipcReachable
      healthz = $daemonRuntime.healthz
      readyz = $daemonRuntime.readyz
    }
    kioskRuntime = $factsSubset.kioskRuntime
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
  $daemonService = Get-ServiceStateOrNull -Name "VemVendingDaemon"
  $machineUiTask = Get-ScheduledTaskEvidence -TaskName "VEMMachineUI" -TaskPath "\\"
  $maintenanceUiTask = Get-ScheduledTaskEvidence -TaskName "VEMMaintenanceUI" -TaskPath "\\"
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
    }
    startupBringup = $startupBringup
    readyFile = $daemonIpc.readyFile
    provisioning = $provisioningFacts
    kioskRuntime = [ordered]@{
      webviewRunning = $kioskRuntime.webviewRunning
      url = $kioskRuntime.url
      sessionUser = $kioskRuntime.sessionUser
      sessionId = $kioskRuntime.sessionId
    }
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
      tailscaleCommand = Get-CommandEvidence "tailscale"
      tailscaleService = Get-ServiceStateOrNull -Name "Tailscale"
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
      visionTask = Get-ScheduledTaskEvidence -TaskName "StartVisionServer" -TaskPath "\\VEM\\"
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

$inventoryAfter = if ($mode -eq "inventory-reset") { Get-InventoryFacts } else { $null }
$inventoryAfterBringUp = if ($mode -eq "bring-up") { Get-InventoryFacts } else { $null }
$inventoryAfterProvision = if ($mode -eq "provision") { Get-InventoryFacts $provisioningActions } else { $null }
$runtimeAcceptanceReportResult = if ($mode -eq "runtime-acceptance") { Get-RuntimeAcceptanceReport $provisioningActions } else { $null }
$runtimeAcceptanceReport = if ($null -ne $runtimeAcceptanceReportResult) { $runtimeAcceptanceReportResult.report } else { $null }
$actionsOk = (((@($resetActions) + @($bringUpActions) + @($provisioningActions)) | Where-Object { $_.status -eq "failed" } | Measure-Object | Select-Object -ExpandProperty Count) -eq 0)
$runtimeAcceptanceOk = if ($mode -eq "runtime-acceptance") {
  $null -ne $runtimeAcceptanceReport -and [string]$runtimeAcceptanceReport.result.runtimeReady.status -eq "passed"
} else {
  $true
}

[pscustomobject]@{
  ok = $actionsOk -and $runtimeAcceptanceOk
  mode = $mode
  inventory = $inventoryBefore
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
} | ConvertTo-Json -Depth 40
`;
}

export function buildSshCommand(options = {}) {
  const remote = options.remote ?? "YKDZ@100.68.189.11";
  const sshArgs = ["-o", "ConnectTimeout=30"];
  if (options.proxyCommand) {
    sshArgs.push("-o", `ProxyCommand=${options.proxyCommand}`);
  } else if (options.sshConfig !== true) {
    sshArgs.push("-o", "ProxyCommand=none");
  }
  if (options.identity) {
    sshArgs.push("-i", options.identity);
  }
  return ["ssh", ...sshArgs, remote];
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
  win10-vem-e2e.mjs [--mode inventory|reset|inventory-reset|bring-up|provision|runtime-acceptance] [--claim-code CODE] [--remote USER@HOST] [--ssh-config] [--proxy-command CMD] [--identity KEY] [--dry-run] [--out PATH]

Defaults target the documented Machine Runtime Testbed:
  --remote YKDZ@100.68.189.11
  --mode inventory

Bring-up mode invokes C:\\VEM\\bringup\\scripts\\setup-scheduled-tasks.ps1 on the remote host and requires VEM_KIOSK_PASSWORD, VEM_MAINTENANCE_PASSWORD, and VEM_AUTOLOGON_PASSWORD in the remote PowerShell environment.

Provision mode reads the daemon ready file, applies only pre-claim platform endpoints, and claims the prepared testbed identity through daemon IPC /v1/provisioning/claim.

Runtime-acceptance mode writes C:\\ProgramData\\VEM\\vending-daemon\\runtime-acceptance-report.json on the remote host and includes the same report in stdout; use --out to save the SSH response locally.
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
    } else if (arg === "--identity") {
      options.identity = next;
      index += 1;
    } else if (arg === "--proxy-command") {
      options.proxyCommand = next;
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
    } else if (arg === "--out") {
      options.out = next;
      index += 1;
    } else if (arg === "--ssh-config") {
      options.sshConfig = true;
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

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      usage();
      process.exit(0);
    }
    const script = buildRemotePowerShellScript(options);
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const sshCommand = buildSshCommand(options);
    const remoteCommand = `powershell -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;

    if (options.dryRun) {
      console.log(
        JSON.stringify(
          {
            sshCommand,
            remoteCommand,
            resetPlan: assertResetPlanPreservesTestbed(buildResetPlan()),
            bringUpPlan: buildBringUpPlan(options),
          },
          null,
          2,
        ),
      );
      process.exit(0);
    }

    const result = spawnSync(
      sshCommand[0],
      [...sshCommand.slice(1), remoteCommand],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
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
    process.exit(
      getRuntimeAcceptanceExitStatus({
        mode: options.mode,
        sshStatus: result.status,
        stdout: result.stdout,
      }),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exit(2);
  }
}
