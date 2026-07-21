import { describe, expect, it } from "vitest";

import {
  type RuntimeAcceptanceFacts,
  classifyRuntimeAcceptanceReport,
  runtimeAcceptanceReportSchema,
} from "./runtime-acceptance";

function runtimeReadyFacts(): RuntimeAcceptanceFacts {
  return {
    mode: "installed_runtime",
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
        sessionId: 3,
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
        sessionId: 3,
        source: "interactive_kiosk_session",
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
      usedDaemonIpcTaskExecute: true,
      machineCode: "VEM-TESTBED-WINVM-01",
    },
    daemonRuntime: {
      processRunning: true,
      processId: 42,
      processUser: "Admin",
      executablePath: "C:\\VEM\\bringup\\vending-daemon.exe",
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
      sessionId: 3,
      processId: 43,
      machineProcessCount: 1,
      machineExecutablePath: "C:\\VEM\\bringup\\machine.exe",
    },
  };
}

describe("Runtime Acceptance Report contract", () => {
  it("classifies a fresh bring-up as runtime-ready without asserting non-goal readiness", () => {
    const report = classifyRuntimeAcceptanceReport(runtimeReadyFacts());

    expect(runtimeAcceptanceReportSchema.parse(report)).toEqual(report);
    expect(report.schemaVersion).toBe("runtime-acceptance-report/v1");
    expect(report.mode).toBe("installed_runtime");
    expect(report.target.machineCode).toBe("VEM-TESTBED-WINVM-01");
    expect(report.provisioning.machineCode).toBe("VEM-TESTBED-WINVM-01");
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
      name: "observed daemon config identity is missing",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.provisioning.machineCode = null;
      },
      code: "daemon_config_machine_identity_missing",
    },
    {
      name: "observed daemon config identity is not a testbed identity",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.provisioning.machineCode = "VEM-WIN10-REAL-01";
      },
      code: "daemon_config_machine_identity_required",
    },
    {
      name: "observed daemon config identity does not match the target",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.provisioning.machineCode = "VEM-TESTBED-OLD-01";
      },
      code: "daemon_config_machine_identity_mismatch",
    },
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
      name: "the manually started daemon process is missing",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.daemonRuntime.processRunning = false;
      },
      code: "daemon_process_not_ready",
    },
    {
      name: "the Machine UI process uses the wrong path",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.kioskRuntime.machineExecutablePath = "C:\\VEM\\machine.exe";
      },
      code: "machine_ui_process_not_ready",
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
        facts.provisioning.usedDaemonIpcTaskExecute = false;
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
    {
      name: "kiosk WebView is tauri.localhost without a hash route",
      mutate: (facts: RuntimeAcceptanceFacts) => {
        facts.kioskRuntime.url = "http://tauri.localhost/";
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
          sessionId: 3,
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
      sessionId: 3,
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

  it("fails runtime-ready when WebView evidence is from a different Windows session", () => {
    const facts = runtimeReadyFacts();
    facts.kioskRuntime.sessionId = 7;

    const report = classifyRuntimeAcceptanceReport(facts);

    expect(report.result.runtimeReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(report.diagnostics).toContainEqual({
      code: "kiosk_session_id_mismatch",
      message:
        "Machine Runtime Console evidence must match the active VEMKiosk interactive session.",
    });
  });

  it("parses failed reports with missing interactive session ids", () => {
    const facts = runtimeReadyFacts();
    facts.displayEvidence.interactiveDesktopDisplayBaseline = {
      status: "missing",
      widthPx: 0,
      heightPx: 0,
      sessionUser: "unknown",
      sessionId: null,
    };
    facts.displayEvidence.portraitKioskAcceptance = {
      status: "failed",
      widthPx: 0,
      heightPx: 0,
      sessionUser: "unknown",
      sessionId: null,
      source: "interactive_kiosk_session",
    };
    facts.kioskRuntime = {
      webviewRunning: false,
      url: "unavailable:no-tauri-hash-route-target",
      sessionUser: "unknown",
      sessionId: null,
      processId: null,
      machineProcessCount: 0,
      machineExecutablePath: "unknown",
    };

    const report = classifyRuntimeAcceptanceReport(facts);

    expect(runtimeAcceptanceReportSchema.parse(report)).toEqual(report);
    expect(report.result.runtimeReady).toEqual({
      status: "failed",
      asserted: false,
    });
    expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "kiosk_session_id_missing",
    );
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
