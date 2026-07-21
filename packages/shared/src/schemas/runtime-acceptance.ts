import { z } from "zod";

const EXPECTED_KIOSK_USER = "VEMKiosk";
const TESTBED_MACHINE_CODE_PREFIX = "VEM-TESTBED-";
const PORTRAIT_WIDTH_PX = 1080;
const PORTRAIT_HEIGHT_PX = 1920;
const EXPECTED_DAEMON_USER = "Admin";
const EXPECTED_DAEMON_PATH = "C:\\VEM\\bringup\\vending-daemon.exe";
const EXPECTED_MACHINE_UI_PATH = "C:\\VEM\\bringup\\machine.exe";
const sha256Schema = z.string().regex(/^[a-fA-F0-9]{64}$/);
const sessionIdSchema = z.int().nonnegative().nullable();

const displayDimensionsEvidenceSchema = z.strictObject({
  status: z.enum(["passed", "failed", "observed", "missing"]),
  widthPx: z.int().nonnegative(),
  heightPx: z.int().nonnegative(),
});

export const runtimeAcceptanceFactsSchema = z.strictObject({
  mode: z.literal("installed_runtime"),
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
  readyFile: z.strictObject({
    exists: z.boolean(),
    readableByKioskUser: z.boolean(),
    ipcEndpointPresent: z.boolean(),
    tokenPresent: z.boolean(),
  }),
  provisioning: z.strictObject({
    provisioned: z.boolean(),
    usedDaemonIpcTaskExecute: z.boolean(),
    machineCode: z.string().min(1).nullable(),
  }),
  daemonRuntime: z.strictObject({
    processRunning: z.boolean(),
    processId: z.int().positive().nullable(),
    processUser: z.string().min(1),
    executablePath: z.string().min(1),
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
    processId: z.int().positive().nullable(),
    machineProcessCount: z.int().nonnegative(),
    machineExecutablePath: z.string().min(1),
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
  const observedMachineCode = facts.provisioning.machineCode;
  if (observedMachineCode === null) {
    addDiagnostic(
      "daemon_config_machine_identity_missing",
      "Runtime acceptance must include the daemon-observed machine identity from config IPC.",
    );
  } else if (!observedMachineCode.startsWith(TESTBED_MACHINE_CODE_PREFIX)) {
    addDiagnostic(
      "daemon_config_machine_identity_required",
      "Daemon-observed machine identity must be a VEM-TESTBED-* machine identity.",
    );
  } else if (observedMachineCode !== facts.target.machineCode) {
    addDiagnostic(
      "daemon_config_machine_identity_mismatch",
      "Daemon-observed machine identity must match the requested testbed target.",
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
    !facts.daemonRuntime.processRunning ||
    facts.daemonRuntime.processId === null ||
    facts.daemonRuntime.processUser !== EXPECTED_DAEMON_USER ||
    facts.daemonRuntime.executablePath !== EXPECTED_DAEMON_PATH
  ) {
    addDiagnostic(
      "daemon_process_not_ready",
      "The manually started daemon process must run as Admin from C:\\VEM\\bringup\\vending-daemon.exe.",
    );
  }
  if (
    facts.kioskRuntime.processId === null ||
    facts.kioskRuntime.machineProcessCount !== 1 ||
    facts.kioskRuntime.machineExecutablePath !== EXPECTED_MACHINE_UI_PATH
  ) {
    addDiagnostic(
      "machine_ui_process_not_ready",
      "The manually started Machine UI must be the unique VEMKiosk process from C:\\VEM\\bringup\\machine.exe.",
    );
  }
  if (!facts.provisioning.provisioned) {
    addDiagnostic(
      "machine_provisioning_incomplete",
      "Machine Provisioning must complete before runtime-ready can pass.",
    );
  }
  if (!facts.provisioning.usedDaemonIpcTaskExecute) {
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
    facts.kioskRuntime.sessionId === null ||
    facts.displayEvidence.interactiveDesktopDisplayBaseline.sessionId ===
      null ||
    facts.displayEvidence.portraitKioskAcceptance.sessionId === null
  ) {
    addDiagnostic(
      "kiosk_session_id_missing",
      "Runtime acceptance requires observed interactive VEMKiosk session ids.",
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
