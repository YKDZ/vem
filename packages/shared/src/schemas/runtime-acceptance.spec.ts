import { describe, expect, it } from "vitest";

import {
  type RuntimeAcceptanceFacts,
  classifyRuntimeAcceptanceReport,
  runtimeAcceptanceReportSchema,
} from "./runtime-acceptance";

function runtimeReadyFacts(): RuntimeAcceptanceFacts {
  return {
    mode: "fresh_bring_up",
    target: {
      testbedName: "win10-vem-e2e",
      machineCode: "VEM-TESTBED-WINVM-01",
      platformTarget: "vem-vps",
    },
    artifacts: {
      daemonSha256: "a".repeat(64),
      machineUiSha256: "b".repeat(64),
    },
    displayEvidence: {
      hostDisplayBaseline: {
        status: "passed",
        widthPx: 1080,
        heightPx: 1920,
      },
      interactiveDesktopDisplayBaseline: {
        status: "passed",
        widthPx: 1080,
        heightPx: 1920,
        sessionUser: "VEMKiosk",
      },
      sshServiceSessionScreenDimensions: {
        status: "observed",
        widthPx: 1024,
        heightPx: 768,
      },
      portraitKioskAcceptance: {
        status: "passed",
        widthPx: 1080,
        heightPx: 1920,
        sessionUser: "VEMKiosk",
        source: "interactive_kiosk_session",
      },
    },
    serviceState: {
      daemonService: {
        installed: true,
        running: true,
        startupType: "automatic",
      },
      machineUiTask: {
        name: "VEMMachineUI",
        exists: true,
        enabled: true,
        runAsUser: "VEMKiosk",
      },
    },
    readyFile: {
      exists: true,
      readableByKioskUser: true,
      ipcEndpointPresent: true,
      tokenPresent: true,
    },
    provisioning: {
      provisioned: true,
      usedDaemonIpcClaimPath: true,
    },
    daemonRuntime: {
      ipcReachable: true,
      healthz: {
        backendOnline: true,
        mqttConnected: true,
      },
      readyz: {
        ready: true,
      },
    },
    kioskRuntime: {
      webviewRunning: true,
      url: "http://tauri.localhost/#/",
      sessionUser: "VEMKiosk",
    },
  };
}

describe("Runtime Acceptance Report contract", () => {
  it("classifies a fresh bring-up as runtime-ready without asserting non-goal readiness", () => {
    const report = classifyRuntimeAcceptanceReport(runtimeReadyFacts());

    expect(runtimeAcceptanceReportSchema.parse(report)).toEqual(report);
    expect(report.schemaVersion).toBe("runtime-acceptance-report/v1");
    expect(report.mode).toBe("fresh_bring_up");
    expect(report.target.machineCode).toBe("VEM-TESTBED-WINVM-01");
    expect(report.result.runtimeReady).toEqual({
      status: "passed",
      asserted: true,
    });
    expect(report.result.simulatedHardwareReady).toEqual({
      status: "not_asserted",
      asserted: false,
    });
    expect(report.result.sellReady).toEqual({
      status: "not_asserted",
      asserted: false,
    });
    expect(report.diagnostics).toEqual([]);
  });

  it("fails runtime-ready when the daemon ready file is missing", () => {
    const report = classifyRuntimeAcceptanceReport({
      ...runtimeReadyFacts(),
      readyFile: {
        exists: false,
        readableByKioskUser: false,
        ipcEndpointPresent: false,
        tokenPresent: false,
      },
    });

    expect(report.result.runtimeReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(report.diagnostics).toContainEqual({
      code: "ready_file_missing",
      message: "Daemon ready file must exist before runtime-ready can pass.",
    });
  });

  it.each([
    {
      name: "ready file is not readable by the kiosk user",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.readyFile.readableByKioskUser = false;
      },
      code: "ready_file_not_readable_by_kiosk",
    },
    {
      name: "daemon IPC endpoint or token is absent",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.readyFile.ipcEndpointPresent = false;
      },
      code: "daemon_ipc_handoff_missing",
    },
    {
      name: "daemon IPC cannot be reached",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.daemonRuntime.ipcReachable = false;
      },
      code: "daemon_ipc_unreachable",
    },
    {
      name: "VEMMachineUI task is missing",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.serviceState.machineUiTask.exists = false;
      },
      code: "machine_ui_task_missing",
    },
    {
      name: "VEMMachineUI task is disabled",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.serviceState.machineUiTask.enabled = false;
      },
      code: "machine_ui_task_disabled",
    },
    {
      name: "VEMMachineUI task is bound to the wrong user",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.serviceState.machineUiTask.runAsUser = "YKDZ";
      },
      code: "machine_ui_task_user_mismatch",
    },
    {
      name: "daemon service is not running automatically",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.serviceState.daemonService.running = false;
      },
      code: "daemon_service_not_running",
    },
    {
      name: "machine provisioning has not completed",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.provisioning.provisioned = false;
      },
      code: "machine_provisioning_incomplete",
    },
    {
      name: "machine provisioning bypassed daemon IPC claim",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.provisioning.usedDaemonIpcClaimPath = false;
      },
      code: "machine_provisioning_bypassed_daemon_ipc",
    },
    {
      name: "daemon readyz is not ready",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.daemonRuntime.readyz.ready = false;
      },
      code: "daemon_readyz_not_ready",
    },
    {
      name: "backend connectivity is down",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.daemonRuntime.healthz.backendOnline = false;
      },
      code: "backend_connectivity_failed",
    },
    {
      name: "MQTT connectivity is down",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.daemonRuntime.healthz.mqttConnected = false;
      },
      code: "mqtt_connectivity_failed",
    },
    {
      name: "kiosk WebView is not serving tauri.localhost",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.kioskRuntime.url = "http://localhost:5173/#/";
      },
      code: "kiosk_webview_missing",
    },
  ])("fails runtime-ready when $name", ({ mutate, code }) => {
    const facts = runtimeReadyFacts();
    mutate(facts);

    const report = classifyRuntimeAcceptanceReport(facts);

    expect(report.result.runtimeReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      code,
    );
  });

  it("does not let SSH service-session dimensions satisfy Portrait Kiosk Acceptance", () => {
    const report = classifyRuntimeAcceptanceReport({
      ...runtimeReadyFacts(),
      displayEvidence: {
        ...runtimeReadyFacts().displayEvidence,
        sshServiceSessionScreenDimensions: {
          status: "observed",
          widthPx: 1080,
          heightPx: 1920,
        },
        portraitKioskAcceptance: {
          status: "passed",
          widthPx: 1080,
          heightPx: 1920,
          sessionUser: "VEMKiosk",
          source: "ssh_service_session",
        },
      },
    });

    expect(report.displayEvidence.sshServiceSessionScreenDimensions).toEqual({
      status: "observed",
      widthPx: 1080,
      heightPx: 1920,
    });
    expect(report.result.runtimeReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "portrait_kiosk_acceptance_missing",
    );
  });

  it("fails runtime-ready when the interactive desktop baseline is not exact portrait 1080x1920", () => {
    const facts = runtimeReadyFacts();
    facts.displayEvidence.interactiveDesktopDisplayBaseline = {
      status: "passed",
      widthPx: 1920,
      heightPx: 1080,
      sessionUser: "VEMKiosk",
    };

    const report = classifyRuntimeAcceptanceReport(facts);

    expect(report.result.runtimeReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(report.diagnostics).toContainEqual({
      code: "interactive_desktop_display_baseline_missing",
      message:
        "Interactive Desktop Display Baseline must pass at exactly 1080x1920 before runtime-ready can pass.",
    });
  });

  it("fails runtime-ready when the MVP report uses a real production machine identity", () => {
    const facts = runtimeReadyFacts();
    facts.target.machineCode = "VEM-WIN10-REAL-01";

    const report = classifyRuntimeAcceptanceReport(facts);

    expect(report.result.runtimeReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(report.diagnostics).toContainEqual({
      code: "testbed_machine_identity_required",
      message:
        "Machine Runtime Testbed MVP reports must use a VEM-TESTBED-* machine identity.",
    });
  });

  it("fails runtime-ready when the customer WebView is not running in the kiosk user session", () => {
    const facts = runtimeReadyFacts();
    facts.kioskRuntime.sessionUser = "YKDZ";

    const report = classifyRuntimeAcceptanceReport(facts);

    expect(report.result.runtimeReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(report.diagnostics).toContainEqual({
      code: "kiosk_session_user_mismatch",
      message:
        "Machine Runtime Console must run in the VEMKiosk customer session.",
    });
  });

  it("fails runtime-ready when Portrait Kiosk Acceptance was captured from a non-kiosk user session", () => {
    const facts = runtimeReadyFacts();
    facts.displayEvidence.portraitKioskAcceptance.sessionUser = "YKDZ";

    const report = classifyRuntimeAcceptanceReport(facts);

    expect(report.result.runtimeReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(report.diagnostics).toContainEqual({
      code: "portrait_kiosk_session_user_mismatch",
      message:
        "Portrait Kiosk Acceptance must be captured from the VEMKiosk customer session.",
    });
  });

  it("keeps real hardware and simulator readiness as non-goals for the MVP", () => {
    const facts = runtimeReadyFacts();
    facts.daemonRuntime.healthz.hardwareOnline = false;
    facts.daemonRuntime.healthz.scannerOnline = false;

    const report = classifyRuntimeAcceptanceReport(facts);

    expect(report.result.runtimeReady).toEqual({
      status: "passed",
      asserted: true,
    });
    expect(report.result.simulatedHardwareReady.status).toBe("not_asserted");
    expect(report.result.sellReady.status).toBe("not_asserted");
    expect(report.diagnostics).toEqual([]);
  });

  it("rejects MVP reports that assert sell-ready", () => {
    const report = classifyRuntimeAcceptanceReport(runtimeReadyFacts());
    const parsed = runtimeAcceptanceReportSchema.safeParse({
      ...report,
      result: {
        ...report.result,
        sellReady: { status: "passed", asserted: true },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects MVP reports that assert simulated-hardware-ready", () => {
    const report = classifyRuntimeAcceptanceReport(runtimeReadyFacts());
    const parsed = runtimeAcceptanceReportSchema.safeParse({
      ...report,
      result: {
        ...report.result,
        simulatedHardwareReady: { status: "passed", asserted: true },
      },
    });

    expect(parsed.success).toBe(false);
  });
});
