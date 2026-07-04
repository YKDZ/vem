import { z } from "zod";

const EXPECTED_KIOSK_USER = "VEMKiosk";
const TESTBED_MACHINE_CODE_PREFIX = "VEM-TESTBED-";
const PORTRAIT_WIDTH_PX = 1080;
const PORTRAIT_HEIGHT_PX = 1920;
const EXPECTED_MACHINE_UI_TASK_NAME = "VEMMachineUI";
const EXPECTED_MACHINE_UI_COMMAND = "C:\\Windows\\System32\\wscript.exe";
const EXPECTED_MACHINE_UI_LAUNCHER = "C:\\VEM\\bringup\\launch-machine-ui.vbs";
const EXPECTED_MACHINE_UI_WORKING_DIRECTORY = "C:\\VEM\\bringup";
const sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);
const sessionIdSchema = z.int().nonnegative();

const displayDimensionsEvidenceSchema = z.strictObject({
  status: z.enum(["passed", "failed", "observed", "missing"]),
  widthPx: z.int().nonnegative(),
  heightPx: z.int().nonnegative(),
});

const startupCommandEvidenceSchema = z.strictObject({
  name: z.string().min(1),
  exists: z.boolean(),
  enabled: z.boolean(),
  runAsUser: z.string().nullable(),
  command: z.string().nullable(),
  arguments: z.string().nullable(),
  workingDirectory: z.string().nullable(),
});

export const runtimeAcceptanceFactsSchema = z.strictObject({
  mode: z.literal("fresh_bring_up"),
  target: z.strictObject({
    testbedName: z.string().min(1),
    machineCode: z.string().min(1),
    platformTarget: z.string().min(1),
  }),
  artifacts: z.strictObject({
    daemonSha256: sha256Schema,
    machineUiSha256: sha256Schema,
  }),
  displayEvidence: z.strictObject({
    hostDisplayBaseline: displayDimensionsEvidenceSchema,
    interactiveDesktopDisplayBaseline: displayDimensionsEvidenceSchema.extend({
      sessionUser: z.string().min(1),
      sessionId: sessionIdSchema,
    }),
    sshServiceSessionScreenDimensions: displayDimensionsEvidenceSchema,
    portraitKioskAcceptance: displayDimensionsEvidenceSchema.extend({
      sessionUser: z.string().min(1),
      sessionId: sessionIdSchema,
      source: z.enum(["interactive_kiosk_session", "ssh_service_session"]),
    }),
  }),
  serviceState: z.strictObject({
    daemonService: z.strictObject({
      installed: z.boolean(),
      running: z.boolean(),
      startupType: z.enum(["automatic", "manual", "disabled", "unknown"]),
    }),
    machineUiTask: z.strictObject({
      name: z.string().min(1),
      exists: z.boolean(),
      enabled: z.boolean(),
      runAsUser: z.string().min(1),
    }),
  }),
  startupBringup: z.strictObject({
    configuredBy: z.string().min(1),
    productionBringup: z.boolean(),
    daemonOwnedInitialization: z.boolean(),
    autoLogon: z.strictObject({
      configured: z.boolean(),
      user: z.string().min(1),
      domain: z.string().min(1),
      force: z.boolean(),
    }),
    machineUiStartup: z.strictObject({
      configured: z.boolean(),
      mode: z.enum(["scheduled_task", "shell_launcher"]),
      runAsUser: z.string().min(1),
      command: z.string().min(1),
    }),
    startupCommands: z.array(startupCommandEvidenceSchema),
  }),
  readyFile: z.strictObject({
    exists: z.boolean(),
    readableByKioskUser: z.boolean(),
    ipcEndpointPresent: z.boolean(),
    tokenPresent: z.boolean(),
  }),
  provisioning: z.strictObject({
    provisioned: z.boolean(),
    usedDaemonIpcClaimPath: z.boolean(),
  }),
  daemonRuntime: z.strictObject({
    ipcReachable: z.boolean(),
    healthz: z.strictObject({
      backendOnline: z.boolean(),
      mqttConnected: z.boolean(),
      hardwareOnline: z.boolean().optional(),
      scannerOnline: z.boolean().optional(),
    }),
    readyz: z.strictObject({
      ready: z.boolean(),
    }),
  }),
  kioskRuntime: z.strictObject({
    webviewRunning: z.boolean(),
    url: z.string().min(1),
    sessionUser: z.string().min(1),
    sessionId: sessionIdSchema,
  }),
});

export const runtimeAcceptanceDiagnosticSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
});

export const runtimeAcceptanceAssertionSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("passed"), asserted: z.literal(true) }),
  z.strictObject({ status: z.literal("failed"), asserted: z.literal(false) }),
  z.strictObject({
    status: z.literal("not_asserted"),
    asserted: z.literal(false),
  }),
]);

export const runtimeAcceptanceReportSchema = runtimeAcceptanceFactsSchema
  .extend({
    schemaVersion: z.literal("runtime-acceptance-report/v1"),
    result: z.strictObject({
      runtimeReady: runtimeAcceptanceAssertionSchema,
      simulatedHardwareReady: runtimeAcceptanceAssertionSchema,
      sellReady: runtimeAcceptanceAssertionSchema,
    }),
    diagnostics: z.array(runtimeAcceptanceDiagnosticSchema),
  })
  .superRefine((report, ctx) => {
    if (report.result.simulatedHardwareReady.status !== "not_asserted") {
      ctx.addIssue({
        code: "custom",
        path: ["result", "simulatedHardwareReady"],
        message:
          "runtime-acceptance-report/v1 must not assert simulated-hardware-ready.",
      });
    }
    if (report.result.sellReady.status !== "not_asserted") {
      ctx.addIssue({
        code: "custom",
        path: ["result", "sellReady"],
        message: "runtime-acceptance-report/v1 must not assert sell-ready.",
      });
    }
  });

export type RuntimeAcceptanceFacts = z.infer<
  typeof runtimeAcceptanceFactsSchema
>;
export type RuntimeAcceptanceReport = z.infer<
  typeof runtimeAcceptanceReportSchema
>;
export type RuntimeAcceptanceDiagnostic = z.infer<
  typeof runtimeAcceptanceDiagnosticSchema
>;

function isStrictTauriHashRouteUrl(value: string): boolean {
  try {
    const url = new URL(value);
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

export function classifyRuntimeAcceptanceReport(
  facts: RuntimeAcceptanceFacts,
): RuntimeAcceptanceReport {
  const diagnostics: RuntimeAcceptanceDiagnostic[] = [];
  const addDiagnostic = (code: string, message: string) => {
    diagnostics.push({ code, message });
  };

  if (!facts.target.machineCode.startsWith(TESTBED_MACHINE_CODE_PREFIX)) {
    addDiagnostic(
      "testbed_machine_identity_required",
      "Machine Runtime Testbed MVP reports must use a VEM-TESTBED-* machine identity.",
    );
  }
  if (!facts.readyFile.exists) {
    addDiagnostic(
      "ready_file_missing",
      "Daemon ready file must exist before runtime-ready can pass.",
    );
  }
  if (!facts.readyFile.readableByKioskUser) {
    addDiagnostic(
      "ready_file_not_readable_by_kiosk",
      "Daemon ready file must be readable by the VEMKiosk user.",
    );
  }
  if (!facts.readyFile.ipcEndpointPresent || !facts.readyFile.tokenPresent) {
    addDiagnostic(
      "daemon_ipc_handoff_missing",
      "Ready file must include the daemon IPC endpoint and token.",
    );
  }
  if (!facts.daemonRuntime.ipcReachable) {
    addDiagnostic(
      "daemon_ipc_unreachable",
      "Daemon IPC must be reachable through the ready-file handoff.",
    );
  }
  if (
    !facts.serviceState.daemonService.installed ||
    !facts.serviceState.daemonService.running ||
    facts.serviceState.daemonService.startupType !== "automatic"
  ) {
    addDiagnostic(
      "daemon_service_not_running",
      "Vending Daemon must be installed, running, and configured for automatic startup.",
    );
  }
  if (facts.startupBringup.machineUiStartup.mode === "scheduled_task") {
    if (!facts.serviceState.machineUiTask.exists) {
      addDiagnostic(
        "machine_ui_task_missing",
        "VEMMachineUI scheduled task must exist before runtime-ready can pass.",
      );
    }
    if (!facts.serviceState.machineUiTask.enabled) {
      addDiagnostic(
        "machine_ui_task_disabled",
        "VEMMachineUI scheduled task must be enabled before runtime-ready can pass.",
      );
    }
    if (facts.serviceState.machineUiTask.runAsUser !== EXPECTED_KIOSK_USER) {
      addDiagnostic(
        "machine_ui_task_user_mismatch",
        "VEMMachineUI scheduled task must run as the VEMKiosk user.",
      );
    }
  }
  if (
    facts.startupBringup.configuredBy !==
      "scripts/windows/setup-scheduled-tasks.ps1" ||
    !facts.startupBringup.productionBringup
  ) {
    addDiagnostic(
      "production_bringup_required",
      "Fresh Bring-Up Acceptance must use the production bring-up script path.",
    );
  }
  if (facts.startupBringup.daemonOwnedInitialization) {
    addDiagnostic(
      "daemon_owned_startup_initialization",
      "Winlogon auto-logon and customer startup must not be daemon-owned initialization.",
    );
  }
  if (!facts.startupBringup.autoLogon.configured) {
    addDiagnostic(
      "winlogon_autologon_missing",
      "Winlogon auto-logon must be configured by production bring-up before runtime-ready can pass.",
    );
  }
  if (facts.startupBringup.autoLogon.user !== EXPECTED_KIOSK_USER) {
    addDiagnostic(
      "winlogon_autologon_user_mismatch",
      "Winlogon auto-logon must target the VEMKiosk customer session.",
    );
  }
  if (!facts.startupBringup.autoLogon.force) {
    addDiagnostic(
      "winlogon_force_autologon_missing",
      "Winlogon ForceAutoLogon must be enabled for unattended cold boot acceptance.",
    );
  }
  if (!facts.startupBringup.machineUiStartup.configured) {
    addDiagnostic(
      "machine_ui_startup_missing",
      "Machine UI startup must be configured by production bring-up.",
    );
  }
  if (facts.startupBringup.machineUiStartup.runAsUser !== EXPECTED_KIOSK_USER) {
    addDiagnostic(
      "machine_ui_startup_user_mismatch",
      "Machine UI startup must target the VEMKiosk customer session.",
    );
  }
  if (facts.startupBringup.machineUiStartup.mode === "scheduled_task") {
    const machineUiStartupCommand = facts.startupBringup.startupCommands.find(
      (command) =>
        command.name === EXPECTED_MACHINE_UI_TASK_NAME ||
        command.name === `\\${EXPECTED_MACHINE_UI_TASK_NAME}`,
    );

    if (!machineUiStartupCommand?.exists) {
      addDiagnostic(
        "machine_ui_startup_command_missing",
        "Production bring-up must provide live VEMMachineUI startup command evidence.",
      );
    } else {
      if (!machineUiStartupCommand.enabled) {
        addDiagnostic(
          "machine_ui_startup_command_disabled",
          "VEMMachineUI startup command must be enabled.",
        );
      }
      if (machineUiStartupCommand.runAsUser !== EXPECTED_KIOSK_USER) {
        addDiagnostic(
          "machine_ui_startup_command_user_mismatch",
          "VEMMachineUI startup command must run as the VEMKiosk user.",
        );
      }
      if (machineUiStartupCommand.command !== EXPECTED_MACHINE_UI_COMMAND) {
        addDiagnostic(
          "machine_ui_startup_command_path_mismatch",
          "VEMMachineUI startup command must use the production wscript launcher path.",
        );
      }
      if (
        !machineUiStartupCommand.arguments?.includes(
          EXPECTED_MACHINE_UI_LAUNCHER,
        )
      ) {
        addDiagnostic(
          "machine_ui_startup_arguments_mismatch",
          "VEMMachineUI startup arguments must point at the production machine UI launcher.",
        );
      }
      if (
        machineUiStartupCommand.workingDirectory !==
        EXPECTED_MACHINE_UI_WORKING_DIRECTORY
      ) {
        addDiagnostic(
          "machine_ui_startup_working_directory_mismatch",
          "VEMMachineUI startup working directory must be the production bring-up directory.",
        );
      }
    }
  }
  if (!facts.provisioning.provisioned) {
    addDiagnostic(
      "machine_provisioning_incomplete",
      "Machine Provisioning must complete before runtime-ready can pass.",
    );
  }
  if (!facts.provisioning.usedDaemonIpcClaimPath) {
    addDiagnostic(
      "machine_provisioning_bypassed_daemon_ipc",
      "Machine Provisioning must use the daemon IPC claim path.",
    );
  }
  if (!facts.daemonRuntime.readyz.ready) {
    addDiagnostic(
      "daemon_readyz_not_ready",
      "Daemon readyz must report ready before runtime-ready can pass.",
    );
  }
  if (!facts.daemonRuntime.healthz.backendOnline) {
    addDiagnostic(
      "backend_connectivity_failed",
      "Daemon health must report backend connectivity.",
    );
  }
  if (!facts.daemonRuntime.healthz.mqttConnected) {
    addDiagnostic(
      "mqtt_connectivity_failed",
      "Daemon health must report MQTT connectivity.",
    );
  }
  if (
    !facts.kioskRuntime.webviewRunning ||
    !isStrictTauriHashRouteUrl(facts.kioskRuntime.url)
  ) {
    addDiagnostic(
      "kiosk_webview_missing",
      "Machine Runtime Console must be running as a Tauri WebView serving tauri.localhost with a hash route.",
    );
  }
  if (facts.kioskRuntime.sessionUser !== EXPECTED_KIOSK_USER) {
    addDiagnostic(
      "kiosk_session_user_mismatch",
      "Machine Runtime Console must run in the VEMKiosk customer session.",
    );
  }
  if (
    facts.kioskRuntime.sessionId !==
      facts.displayEvidence.interactiveDesktopDisplayBaseline.sessionId ||
    facts.kioskRuntime.sessionId !==
      facts.displayEvidence.portraitKioskAcceptance.sessionId
  ) {
    addDiagnostic(
      "kiosk_session_id_mismatch",
      "Machine Runtime Console evidence must match the active VEMKiosk interactive session.",
    );
  }
  if (
    facts.displayEvidence.portraitKioskAcceptance.sessionUser !==
    EXPECTED_KIOSK_USER
  ) {
    addDiagnostic(
      "portrait_kiosk_session_user_mismatch",
      "Portrait Kiosk Acceptance must be captured from the VEMKiosk customer session.",
    );
  }
  if (
    facts.displayEvidence.interactiveDesktopDisplayBaseline.status !==
      "passed" ||
    facts.displayEvidence.interactiveDesktopDisplayBaseline.widthPx !==
      PORTRAIT_WIDTH_PX ||
    facts.displayEvidence.interactiveDesktopDisplayBaseline.heightPx !==
      PORTRAIT_HEIGHT_PX
  ) {
    addDiagnostic(
      "interactive_desktop_display_baseline_missing",
      "Interactive Desktop Display Baseline must pass at exactly 1080x1920 before runtime-ready can pass.",
    );
  }
  if (
    facts.displayEvidence.portraitKioskAcceptance.status !== "passed" ||
    facts.displayEvidence.portraitKioskAcceptance.source !==
      "interactive_kiosk_session" ||
    facts.displayEvidence.portraitKioskAcceptance.widthPx !==
      PORTRAIT_WIDTH_PX ||
    facts.displayEvidence.portraitKioskAcceptance.heightPx !==
      PORTRAIT_HEIGHT_PX
  ) {
    addDiagnostic(
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
          ? { status: "passed", asserted: true }
          : { status: "failed", asserted: false },
      simulatedHardwareReady: { status: "not_asserted", asserted: false },
      sellReady: { status: "not_asserted", asserted: false },
    },
    diagnostics,
  };
}
