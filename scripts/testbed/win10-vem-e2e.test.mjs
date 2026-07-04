import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildBringUpPlan,
  buildResetPlan,
  buildRemotePowerShellScript,
  buildSshCommand,
  assertResetPlanPreservesTestbed,
  buildPreClaimPublicConfig,
  buildProvisioningFacts,
  buildReadyFileEvidence,
  buildInteractiveDesktopDisplayBaseline,
  buildKioskRuntimeEvidence,
  buildPortraitKioskAcceptance,
  classifyProvisioningFailure,
  evaluateFirstClaimPrecondition,
  findActiveKioskSession,
  isStrictTauriHashRouteUrl,
} from "./win10-vem-e2e.mjs";

describe("win10-vem-e2e reset planning", () => {
  it("requires an active VEMKiosk interactive Windows session for display acceptance", () => {
    assert.equal(
      findActiveKioskSession([
        {
          user: "YKDZ",
          sessionId: 0,
          state: "Active",
          source: "ssh_service_session",
        },
      ]),
      null,
    );

    const activeKioskSession = findActiveKioskSession([
      {
        user: "VEMKiosk",
        sessionId: 3,
        state: "Active",
        source: "quser",
      },
    ]);

    assert.deepEqual(activeKioskSession, {
      user: "VEMKiosk",
      sessionId: 3,
      state: "Active",
      source: "quser",
    });

    assert.deepEqual(
      buildInteractiveDesktopDisplayBaseline({
        activeSession: null,
        screen: { widthPx: 1080, heightPx: 1920 },
      }),
      {
        status: "missing",
        widthPx: 0,
        heightPx: 0,
        sessionUser: "unknown",
        sessionId: null,
        source: "interactive_desktop_screen",
      },
    );
  });

  it("does not accept SSH-only 1024x768 dimensions as the interactive desktop baseline", () => {
    const activeSession = findActiveKioskSession([
      {
        user: "VEMKiosk",
        sessionId: 3,
        state: "Active",
        source: "quser",
      },
    ]);

    const baseline = buildInteractiveDesktopDisplayBaseline({
      activeSession,
      screen: {
        widthPx: 1024,
        heightPx: 768,
        source: "ssh_service_session",
      },
    });

    assert.deepEqual(baseline, {
      status: "failed",
      widthPx: 1024,
      heightPx: 768,
      sessionUser: "VEMKiosk",
      sessionId: 3,
      source: "interactive_desktop_screen",
    });
    assert.deepEqual(buildPortraitKioskAcceptance(baseline), {
      status: "failed",
      widthPx: 1024,
      heightPx: 768,
      sessionUser: "VEMKiosk",
      sessionId: 3,
      source: "interactive_kiosk_session",
    });

    assert.equal(
      buildInteractiveDesktopDisplayBaseline({
        activeSession,
        screen: {
          widthPx: 1080,
          heightPx: 1920,
          source: "ssh_service_session",
        },
      }).status,
      "failed",
    );
  });

  it("requires a strict tauri.localhost hash-route URL for WebView runtime acceptance", () => {
    assert.equal(isStrictTauriHashRouteUrl("http://tauri.localhost/#/"), true);
    assert.equal(
      isStrictTauriHashRouteUrl("http://tauri.localhost/#/maintenance"),
      true,
    );
    assert.equal(isStrictTauriHashRouteUrl("http://tauri.localhost/"), false);
    assert.equal(
      isStrictTauriHashRouteUrl("http://tauri.localhost.evil/#/"),
      false,
    );
    assert.equal(
      isStrictTauriHashRouteUrl("http://127.0.0.1/?u=tauri.localhost/#/"),
      false,
    );
  });

  it("requires CDP and machine.exe evidence from the active VEMKiosk session", () => {
    const activeSession = {
      user: "VEMKiosk",
      sessionId: 3,
      state: "Active",
      source: "quser",
    };
    const machineProcesses = [
      { processId: 500, ownerUser: "VEMKiosk", sessionId: 3 },
    ];

    assert.deepEqual(
      buildKioskRuntimeEvidence({
        activeSession,
        machineProcesses,
        cdpTargets: [],
      }),
      {
        webviewRunning: false,
        url: "unavailable:no-tauri-hash-route-target",
        sessionUser: "VEMKiosk",
        sessionId: 3,
        processId: 500,
        cdpAvailable: true,
        error: "kiosk_webview_not_verified",
      },
    );

    assert.equal(
      buildKioskRuntimeEvidence({
        activeSession,
        machineProcesses,
        cdpTargets: [{ url: "http://tauri.localhost/" }],
      }).webviewRunning,
      false,
    );

    assert.equal(
      buildKioskRuntimeEvidence({
        activeSession,
        machineProcesses: [
          { processId: 501, ownerUser: "VEMKiosk", sessionId: 7 },
        ],
        cdpTargets: [{ url: "http://tauri.localhost/#/" }],
      }).webviewRunning,
      false,
    );

    assert.equal(
      buildKioskRuntimeEvidence({
        activeSession,
        machineProcesses,
        cdpTargets: [{ url: "http://tauri.localhost/#/" }],
      }).webviewRunning,
      true,
    );
  });

  it("plans production bring-up through the shared Windows setup script", () => {
    const plan = buildBringUpPlan();

    assert.equal(
      plan.setupScript,
      "C:\\VEM\\bringup\\scripts\\setup-scheduled-tasks.ps1",
    );
    assert.deepEqual(plan.requiredSecretEnvironment, [
      "VEM_KIOSK_PASSWORD",
      "VEM_MAINTENANCE_PASSWORD",
      "VEM_AUTOLOGON_PASSWORD",
    ]);
    assert.equal(plan.arguments.KioskUser, "VEMKiosk");
    assert.equal(plan.arguments.MaintenanceUser, "YKDZ");
    assert.equal(plan.arguments.RunAsUser, "YKDZ");
    assert.equal(plan.arguments.KioskPassword, "$env:VEM_KIOSK_PASSWORD");
    assert.equal(
      plan.arguments.MaintenancePassword,
      "$env:VEM_MAINTENANCE_PASSWORD",
    );
    assert.equal(
      plan.arguments.AutoLogonPassword,
      "$env:VEM_AUTOLOGON_PASSWORD",
    );
    assert.deepEqual(plan.switches, [
      "ConfigureKioskAccounts",
      "UseKioskAccount",
      "ConfigureAutoLogon",
    ]);
  });

  it("plans only VEM runtime and registration artifacts for reset", () => {
    const plan = buildResetPlan();

    assert.deepEqual(plan.stopServices, ["VemVendingDaemon"]);
    assert.deepEqual(plan.unregisterScheduledTasks, [
      "VEMMachineUI",
      "VEMMaintenanceUI",
      "VEM\\StartVisionServer",
    ]);
    assert.deepEqual(plan.removeDirectories, [
      "C:\\VEM\\bringup",
      "C:\\VEM\\updates",
      "C:\\VEM\\vision",
      "C:\\ProgramData\\VEM\\vending-daemon",
    ]);
    assert.deepEqual(plan.removeFiles, [
      "C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready.json",
    ]);
    assert.deepEqual(plan.preservedResources, [
      "Windows OS",
      "display setup",
      "Tailscale",
      "OpenSSH",
      "WebView2",
      "YKDZ maintenance account",
      "base networking",
    ]);

    assert.doesNotThrow(() => assertResetPlanPreservesTestbed(plan));
  });

  it("rejects reset plans that target preserved testbed prerequisites", () => {
    const protectedPaths = [
      "C:\\Windows\\System32\\OpenSSH",
      "C:\\Program Files\\Tailscale",
      "C:\\Program Files\\OpenSSH",
      "C:\\Program Files (x86)\\Microsoft\\EdgeWebView",
      "C:\\Users\\YKDZ",
      "C:\\ProgramData\\Tailscale",
      "C:\\ProgramData\\ssh",
    ];

    for (const path of protectedPaths) {
      assert.throws(
        () =>
          assertResetPlanPreservesTestbed({
            ...buildResetPlan(),
            removeDirectories: [path],
          }),
        /protected testbed resource/,
      );
    }

    for (const service of ["Tailscale", "sshd"]) {
      assert.throws(
        () =>
          assertResetPlanPreservesTestbed({
            ...buildResetPlan(),
            stopServices: [service],
          }),
        /protected testbed resource/,
      );
    }

    for (const task of [
      "Tailscale",
      "sshd",
      "MicrosoftEdgeUpdateTaskMachineCore",
    ]) {
      assert.throws(
        () =>
          assertResetPlanPreservesTestbed({
            ...buildResetPlan(),
            unregisterScheduledTasks: [task],
          }),
        /protected testbed resource/,
      );
    }
  });

  it("builds an inventory-and-reset script with required evidence and idempotent cleanup", () => {
    const script = buildRemotePowerShellScript({
      mode: "inventory-reset",
      platformTarget: "vem-vps",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(script, /Get-CimInstance Win32_OperatingSystem/);
    assert.match(script, /WindowsIdentity/);
    assert.match(script, /Test-LocalAdmin/);
    assert.match(script, /tailscaleCommand = Get-CommandEvidence "tailscale"/);
    assert.match(script, /Get-ServiceStateOrNull -Name "sshd"/);
    assert.match(script, /Get-WebView2Presence/);
    assert.match(script, /Get-DisplayEvidence/);
    assert.match(script, /artifactConsumerPrerequisites/);
    assert.match(script, /Stop-Service -Name 'VemVendingDaemon'/);
    assert.match(script, /Unregister-ScheduledTask -TaskName 'VEMMachineUI'/);
    assert.match(
      script,
      /Unregister-ScheduledTask -TaskName 'VEMMaintenanceUI'/,
    );
    assert.match(
      script,
      /Unregister-ScheduledTask -TaskName 'StartVisionServer' -TaskPath '\\VEM\\'/,
    );
    assert.match(script, /Remove-Item -LiteralPath 'C:\\VEM\\bringup'/);
    assert.match(script, /-ErrorAction SilentlyContinue/);
    assert.match(script, /maintenanceUiTask/);
    assert.match(script, /runtimeAcceptanceFactsSubset/);
    assert.doesNotMatch(script, /Remove-Item -LiteralPath 'C:\\Windows/);
    assert.doesNotMatch(script, /Remove-LocalUser/);
    assert.doesNotMatch(script, /Remove-Item -LiteralPath 'C:\\Users\\YKDZ/);
    assert.doesNotMatch(
      script,
      /Remove-Item -LiteralPath 'C:\\ProgramData\\Tailscale/,
    );
    assert.doesNotMatch(
      script,
      /Remove-Item -LiteralPath 'C:\\ProgramData\\ssh/,
    );
  });

  it("quotes PowerShell literals without expanding variable or subexpression syntax", () => {
    const script = buildRemotePowerShellScript({
      mode: "inventory",
      platformTarget: "target's-$($bad)",
      machineCode: "VEM-TESTBED-$($env:USERNAME)-01",
    });

    assert.match(script, /machineCode = 'VEM-TESTBED-\$\(\$env:USERNAME\)-01'/);
    assert.match(script, /platformTarget = 'target''s-\$\(\$bad\)'/);
    assert.doesNotMatch(
      script,
      /machineCode = "VEM-TESTBED-\$\(\$env:USERNAME\)-01"/,
    );
  });

  it("reports cleanup and reset postcondition failures instead of masking them", () => {
    const script = buildRemotePowerShellScript({ mode: "inventory-reset" });

    assert.match(
      script,
      /Stop-Service -Name 'VemVendingDaemon' -Force -ErrorAction Stop/,
    );
    assert.match(
      script,
      /Unregister-ScheduledTask -TaskName 'VEMMachineUI' -TaskPath '\\' -Confirm:\$false -ErrorAction Stop/,
    );
    assert.match(
      script,
      /Remove-Item -LiteralPath 'C:\\VEM\\bringup' -Recurse -Force -ErrorAction Stop/,
    );
    assert.doesNotMatch(
      script,
      /Stop-Service -Name 'VemVendingDaemon'[^\n]*SilentlyContinue/,
    );
    assert.doesNotMatch(
      script,
      /Unregister-ScheduledTask -TaskName 'VEMMachineUI'[^\n]*SilentlyContinue/,
    );
    assert.doesNotMatch(
      script,
      /Remove-Item -LiteralPath 'C:\\VEM\\bringup'[^\n]*SilentlyContinue/,
    );
    assert.match(script, /function Assert-ResetPostcondition/);
    assert.match(
      script,
      /Assert-ResetPostcondition \$resetActions "service VemVendingDaemon removed"/,
    );
    assert.match(
      script,
      /Assert-ResetPostcondition \$resetActions "scheduled task VEMMachineUI removed"/,
    );
    assert.match(
      script,
      /Assert-ResetPostcondition \$resetActions "directory C:\\VEM\\bringup removed"/,
    );
    assert.match(script, /\$LASTEXITCODE -ne 0/);
  });

  it("emits a runtime acceptance facts subset using shared-contract field shapes", () => {
    const script = buildRemotePowerShellScript({
      mode: "inventory",
      platformTarget: "vem-vps",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(script, /function Convert-DisplayDimensionsEvidence/);
    assert.match(script, /runtimeAcceptanceFactsSubset = \[ordered\]@{/);
    assert.doesNotMatch(script, /runtimeAcceptanceFragment/);
    assert.doesNotMatch(script, /compatibleWith/);
    assert.match(script, /mode = "fresh_bring_up"/);
    assert.match(script, /testbedName = "win10-vem-e2e"/);
    assert.match(script, /hostDisplayBaseline = \$displayDimensionsEvidence/);
    assert.match(
      script,
      /sshServiceSessionScreenDimensions = \$displayDimensionsEvidence/,
    );
    assert.match(
      script,
      /interactiveDesktopDisplayBaseline = \$interactiveDesktopDisplayBaseline/,
    );
    assert.match(script, /portraitKioskAcceptance = \$portraitKioskAcceptance/);
    assert.match(script, /status = "observed"/);
    assert.match(script, /widthPx = \[int\]\$screen.widthPx/);
    assert.match(script, /heightPx = \[int\]\$screen.heightPx/);
    assert.match(script, /serviceState = \[ordered\]@{/);
    assert.match(script, /startupBringup = \$startupBringup/);
    assert.match(script, /function Get-StartupBringupEvidence/);
    assert.match(
      script,
      /C:\\ProgramData\\VEM\\vending-daemon\\startup-bringup-evidence\.json/,
    );
    assert.match(script, /configuredBy = "missing"/);
    assert.match(script, /productionBringup = \$false/);
    assert.match(script, /daemonOwnedInitialization = \$true/);
    assert.match(script, /startupCommands = \$startupCommands/);
    assert.match(script, /readyFile = \[ordered\]@{/);
    assert.match(script, /provisioning = \[ordered\]@{/);
    assert.match(script, /runtimeAcceptanceReportPreparation = \[ordered\]@{/);
    assert.match(script, /completeness = "partial_missing_required_facts"/);
    assert.match(
      script,
      /missingRequiredFacts = @\("artifacts", "daemonRuntime"\)/,
    );
    assert.match(script, /runtimeReadyAssertion = \[ordered\]@{/);
    assert.match(script, /status = "not_asserted"/);
    assert.match(script, /factsSubset = \$runtimeAcceptanceFactsSubset/);
  });

  it("builds kiosk acceptance from interactive VEMKiosk evidence instead of SSH display dimensions", () => {
    const script = buildRemotePowerShellScript({
      mode: "inventory",
      platformTarget: "vem-vps",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(script, /function Get-InteractiveDesktopDisplayEvidence/);
    assert.match(script, /function Get-InteractiveWindowsSessionEvidence/);
    assert.match(script, /quser 2>&1/);
    assert.match(script, /activeKioskSessionId/);
    assert.match(script, /function Get-CurrentDesktopScreenDimensions/);
    assert.match(script, /EnumDisplaySettings/);
    assert.match(
      script,
      /function Convert-InteractiveDisplayDimensionsEvidence/,
    );
    assert.match(script, /function Convert-PortraitKioskAcceptanceEvidence/);
    assert.match(script, /"interactive_kiosk_session"/);
    assert.match(script, /"VEMKiosk"/);
    assert.match(script, /sessionId = if \(\$null -ne \$Display\.sessionId\)/);
    assert.match(
      script,
      /widthPx -eq 1080 -and \$Dimensions.heightPx -eq 1920/,
    );
    assert.match(script, /portraitKioskAcceptance = \$portraitKioskAcceptance/);
    assert.doesNotMatch(
      script,
      /portraitKioskAcceptance = \$displayDimensionsEvidence/,
    );
    assert.doesNotMatch(
      script,
      /interactiveDesktopDisplayBaseline = \$displayDimensionsEvidence/,
    );
    assert.doesNotMatch(script, /GetWindowRect/);
    assert.doesNotMatch(script, /machine\.exe-main-window/);
  });

  it("builds kiosk runtime evidence from same-session machine.exe and strict tauri WebView URL", () => {
    const script = buildRemotePowerShellScript({
      mode: "inventory",
      platformTarget: "vem-vps",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(script, /function Get-KioskRuntimeEvidence/);
    assert.match(script, /Win32_Process -Filter "name = 'machine.exe'"/);
    assert.match(script, /Invoke-CimMethod .* -MethodName GetOwner/);
    assert.match(script, /http:\/\/127\.0\.0\.1:9222\/json/);
    assert.match(script, /function Test-TauriHashRouteUrl/);
    assert.match(script, /\$uri\.Host -eq "tauri\.localhost"/);
    assert.match(script, /\$uri\.Fragment\.StartsWith\("#\/"\)/);
    assert.match(script, /\$_\.sessionId -eq \$ActiveKioskSession\.sessionId/);
    assert.match(script, /webviewRunning = \$kioskRuntime.webviewRunning/);
    assert.match(script, /url = \$kioskRuntime.url/);
    assert.match(script, /sessionUser = \$kioskRuntime.sessionUser/);
    assert.match(script, /sessionId = \$kioskRuntime.sessionId/);
  });

  it("builds a bring-up script that invokes production setup with testbed-safe arguments", () => {
    const script = buildRemotePowerShellScript({ mode: "bring-up" });

    assert.match(script, /function Invoke-ProductionBringUp/);
    assert.match(
      script,
      /\$setupScript = 'C:\\VEM\\bringup\\scripts\\setup-scheduled-tasks\.ps1'/,
    );
    assert.match(script, /Assert-RequiredSecretEnvironment \$secretName/);
    assert.match(script, /'VEM_KIOSK_PASSWORD'/);
    assert.match(script, /'VEM_MAINTENANCE_PASSWORD'/);
    assert.match(script, /'VEM_AUTOLOGON_PASSWORD'/);
    assert.match(script, /'KioskUser' = 'VEMKiosk'/);
    assert.match(script, /'MaintenanceUser' = 'YKDZ'/);
    assert.match(script, /'RunAsUser' = 'YKDZ'/);
    assert.match(script, /'KioskPassword' = \$env:VEM_KIOSK_PASSWORD/);
    assert.match(
      script,
      /'MaintenancePassword' = \$env:VEM_MAINTENANCE_PASSWORD/,
    );
    assert.match(script, /'AutoLogonPassword' = \$env:VEM_AUTOLOGON_PASSWORD/);
    assert.match(script, /\$setupArgs\['ConfigureKioskAccounts'\] = \$true/);
    assert.match(script, /\$setupArgs\['UseKioskAccount'\] = \$true/);
    assert.match(script, /\$setupArgs\['ConfigureAutoLogon'\] = \$true/);
    assert.match(
      script,
      /'DaemonExe' = 'C:\\VEM\\bringup\\vending-daemon.exe'/,
    );
    assert.match(script, /'MachineUiExe' = 'C:\\VEM\\bringup\\machine.exe'/);
    assert.match(
      script,
      /'StartupBringupEvidenceFile' = 'C:\\ProgramData\\VEM\\vending-daemon\\startup-bringup-evidence.json'/,
    );
    assert.match(script, /& \$setupScript @setupArgs/);
    assert.doesNotMatch(script, /1256987/);
    assert.doesNotMatch(script, /AllowBlankAutoLogonPassword/);
  });

  it("rejects a reset-plus-bring-up shortcut that would delete the setup script before using it", () => {
    assert.throws(
      () =>
        buildRemotePowerShellScript({
          mode: "inventory-reset-bring-up",
        }),
      /unsupported mode: inventory-reset-bring-up/,
    );

    const script = buildRemotePowerShellScript({ mode: "bring-up" });

    assert.doesNotMatch(script, /inventory-reset-bring-up/);
    assert.match(script, /\$mode -eq "bring-up"/);
    assert.match(script, /Invoke-ProductionBringUp \$bringUpActions/);
    assert.match(script, /inventoryAfterBringUp/);
  });

  it("builds a provision script that claims through daemon IPC without direct secret writes", () => {
    const script = buildRemotePowerShellScript({
      mode: "provision",
      claimCode: "ABCD-2345",
      machineCode: "VEM-TESTBED-WINVM-01",
      platformTarget: "vem-vps",
    });

    assert.match(script, /function Invoke-TestbedProvisioningClaim/);
    assert.match(
      script,
      /C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready\.json/,
    );
    assert.match(script, /Authorization = "Bearer \$\(\$ready\.ipcToken\)"/);
    assert.match(script, /Invoke-IpcJson "PUT" "\$baseUrl\/v1\/config"/);
    assert.match(
      script,
      /apiBaseUrl = 'http:\/\/118\.25\.104\.160:26849\/api'/,
    );
    assert.match(script, /mqttUrl = 'mqtt:\/\/118\.25\.104\.160:1883'/);
    assert.match(
      script,
      /Invoke-IpcJson "POST" "\$baseUrl\/v1\/provisioning\/claim"/,
    );
    assert.match(script, /usedDaemonIpcClaimPath = \$true/);
    assert.match(script, /machineCode = \$claimResult\.machineCode/);
    assert.match(script, /provisioned = \$configEvidence\.provisioned/);
    assert.match(script, /claimResult = \[ordered\]@{/);
    assert.match(script, /restartRequested = \$null/);
    assert.match(script, /credentialFlags = \[ordered\]@{/);
    assert.match(script, /machineSecretConfigured = \$false/);
    assert.match(script, /mqttSigningSecretConfigured = \$false/);
    assert.match(script, /mqttPasswordConfigured = \$false/);
    assert.match(script, /provisioningIssues = @\(\)/);
    assert.match(script, /healthzAfterClaim = Get-SafeHealthzEvidence/);
    assert.match(script, /readyzAfterClaim = Get-SafeReadyzEvidence/);
    assert.doesNotMatch(script, /machineSecret\s*=/);
    assert.doesNotMatch(script, /mqttSigningSecret\s*=/);
    assert.doesNotMatch(script, /mqttPassword\s*=/);
    assert.doesNotMatch(script, /vms_local/);
  });

  it("emits provision diagnostics for missing ready file and token failures", () => {
    const script = buildRemotePowerShellScript({
      mode: "provision",
      claimCode: "ABCD-2345",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(
      script,
      /Read-JsonFile 'C:\\ProgramData\\VEM\\vending-daemon\\daemon-ready\.json'/,
    );
    assert.match(script, /throw "file not found: \$Path"/);
    assert.match(script, /ipcToken missing from daemon ready file/);
    assert.match(script, /healthzUrl missing from daemon ready file/);
    assert.match(script, /invalid healthzUrl in daemon ready file/);
  });

  it("classifies failed daemon IPC claim responses in provision evidence", () => {
    const script = buildRemotePowerShellScript({
      mode: "provision",
      claimCode: "ABCD-2345",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(script, /function Get-HttpErrorInfo/);
    assert.match(script, /function Convert-ClaimFailureClassification/);
    assert.match(script, /claimStatus = "failed"/);
    assert.match(
      script,
      /claimFailureCode = Convert-ClaimFailureClassification \$claimError/,
    );
    assert.match(script, /claimHttpStatus = \$claimError.statusCode/);
    assert.match(
      script,
      /daemon IPC claim failed: \$\(\$evidence.claimFailureCode\)/,
    );
    assert.match(script, /claimStatus = "provisioned"/);
  });

  it("rejects non-testbed identities before generating provisioning orchestration", () => {
    assert.throws(
      () =>
        buildRemotePowerShellScript({
          mode: "provision",
          claimCode: "ABCD-2345",
          machineCode: "VEM-WIN10-REAL-01",
        }),
      /dedicated testbed identity/,
    );

    const script = buildRemotePowerShellScript({
      mode: "provision",
      claimCode: "ABCD-2345",
      machineCode: "VEM-TESTBED-WINVM-01",
    });

    assert.match(
      script,
      /refusing to provision over non-testbed configured identity/,
    );
    assert.match(script, /daemon IPC claim returned non-testbed identity/);
    assert.match(
      script,
      /daemon IPC claim returned unexpected testbed identity/,
    );
  });

  it("derives provisioning facts from daemon config and actual claim action evidence", () => {
    assert.deepEqual(
      buildProvisioningFacts({
        configSnapshot: {
          provisioned: true,
          public: { machineCode: "VEM-TESTBED-WINVM-01" },
          machineSecretConfigured: true,
          mqttSigningSecretConfigured: true,
          mqttPasswordConfigured: false,
          provisioningIssues: [],
        },
        actions: [
          {
            evidence: {
              usedDaemonIpcClaimPath: true,
              endpoint: "http://127.0.0.1:3921/v1/provisioning/claim",
              claimStatus: "provisioned",
            },
          },
        ],
      }),
      {
        provisioned: true,
        usedDaemonIpcClaimPath: true,
        machineCode: "VEM-TESTBED-WINVM-01",
        machineSecretConfigured: true,
        mqttSigningSecretConfigured: true,
        mqttPasswordConfigured: false,
        provisioningIssues: [],
      },
    );

    assert.equal(
      buildProvisioningFacts({
        configSnapshot: { provisioned: false, public: {} },
        actions: [
          {
            evidence: {
              usedDaemonIpcClaimPath: true,
              endpoint: "http://127.0.0.1:3921/v1/config",
              claimStatus: "not_attempted",
            },
          },
        ],
      }).usedDaemonIpcClaimPath,
      false,
    );
    assert.equal(
      buildProvisioningFacts({
        configSnapshot: {
          provisioned: false,
          public: {},
          provisioningIssues: ["machine_profile_persistence_failed"],
        },
        actions: [
          {
            evidence: {
              usedDaemonIpcClaimPath: true,
              endpoint: "http://127.0.0.1:3921/v1/provisioning/claim",
              claimStatus: "failed",
              claimFailureCode: "machine_profile_persistence_failed",
            },
          },
        ],
      }).usedDaemonIpcClaimPath,
      true,
    );
  });

  it("summarizes daemon ready evidence for missing ready, token, and endpoint failures", () => {
    assert.deepEqual(buildReadyFileEvidence(null), {
      exists: false,
      ipcEndpointPresent: false,
      tokenPresent: false,
      error: "ready_file_missing",
    });
    assert.deepEqual(
      buildReadyFileEvidence({
        healthzUrl: "http://127.0.0.1:3921/healthz",
      }),
      {
        exists: true,
        ipcEndpointPresent: true,
        tokenPresent: false,
        error: "ipc_token_missing",
      },
    );
    assert.deepEqual(
      buildReadyFileEvidence({
        ipcToken: "token-1",
        healthzUrl: "http://127.0.0.1:3921/status",
      }),
      {
        exists: true,
        ipcEndpointPresent: true,
        tokenPresent: true,
        error: "healthz_url_invalid",
      },
    );
  });

  it("rejects stale real or testbed config before first-claim provisioning", () => {
    assert.deepEqual(evaluateFirstClaimPrecondition({ public: {} }), {
      ok: true,
      code: "ready_for_first_claim",
      message: null,
    });
    assert.equal(
      evaluateFirstClaimPrecondition({
        provisioned: true,
        public: { machineCode: "VEM-TESTBED-WINVM-01" },
      }).code,
      "already_provisioned",
    );
    assert.equal(
      evaluateFirstClaimPrecondition({
        public: {},
        machineSecretConfigured: true,
      }).code,
      "credentials_configured",
    );
    assert.equal(
      evaluateFirstClaimPrecondition({
        public: { machineCode: "VEM-WIN10-REAL-01" },
      }).code,
      "non_testbed_identity",
    );
    assert.equal(
      evaluateFirstClaimPrecondition({
        public: { machineCode: "VEM-TESTBED-OLD-01" },
      }).code,
      "stale_final_identity",
    );
    assert.equal(
      evaluateFirstClaimPrecondition({
        public: {
          runtimeEndpoints: { machineApiBasePath: "/api/machines/M001" },
        },
      }).code,
      "stale_final_identity",
    );
  });

  it("builds pre-claim public config with platform endpoints and no final identity/profile fields", () => {
    assert.deepEqual(
      buildPreClaimPublicConfig(
        {
          machineCode: "VEM-TESTBED-OLD-01",
          machineId: "machine-id",
          machineName: "old",
          machineStatus: "active",
          machineLocationLabel: "old site",
          apiBaseUrl: "http://old/api",
          mqttUrl: "mqtt://old",
          mqttUsername: "old-user",
          mqttClientId: "old-client",
          hardwareAdapter: "serial",
          scannerAdapter: "serial_text",
          runtimeEndpoints: { machineApiBasePath: "/api/machines/old" },
          hardwareProfile: { profile: "production" },
          paymentCapability: { profile: "production" },
          provisioningMetadata: { profileVersion: 1 },
        },
        {
          apiBaseUrl: "http://118.25.104.160:26849/api",
          mqttUrl: "mqtt://118.25.104.160:1883",
        },
      ),
      {
        machineCode: null,
        machineId: null,
        machineName: null,
        machineStatus: null,
        machineLocationLabel: null,
        apiBaseUrl: "http://118.25.104.160:26849/api",
        mqttUrl: "mqtt://118.25.104.160:1883",
        mqttUsername: null,
        mqttClientId: null,
        hardwareAdapter: "serial",
        scannerAdapter: "serial_text",
        runtimeEndpoints: null,
        hardwareProfile: null,
        paymentCapability: null,
        provisioningMetadata: null,
      },
    );
  });

  it("classifies provision claim failures without exposing claim codes or secrets", () => {
    assert.equal(
      classifyProvisioningFailure({
        statusCode: 400,
        body: { code: "machine_claim_invalid_or_expired" },
      }),
      "machine_claim_invalid_or_expired",
    );
    assert.equal(
      classifyProvisioningFailure({
        statusCode: 503,
        body: { code: "machine_claim_backend_unavailable" },
      }),
      "machine_claim_backend_unavailable",
    );
    assert.equal(
      classifyProvisioningFailure({
        statusCode: 500,
        body: { code: "machine_profile_persistence_failed" },
      }),
      "machine_profile_persistence_failed",
    );
    assert.equal(classifyProvisioningFailure({ statusCode: 502 }), "http_502");
    assert.equal(classifyProvisioningFailure({}), "request_failed");
  });

  it("builds the documented Tailscale/OpenSSH command without requiring the real VM in tests", () => {
    assert.deepEqual(buildSshCommand(), [
      "ssh",
      "-o",
      "ConnectTimeout=30",
      "-o",
      "ProxyCommand=none",
      "YKDZ@100.68.189.11",
    ]);
    assert.deepEqual(
      buildSshCommand({
        proxyCommand:
          "tailscale --socket=/tmp/tailscale-devcontainer-run/tailscaled.sock nc %h %p",
      }),
      [
        "ssh",
        "-o",
        "ConnectTimeout=30",
        "-o",
        "ProxyCommand=tailscale --socket=/tmp/tailscale-devcontainer-run/tailscaled.sock nc %h %p",
        "YKDZ@100.68.189.11",
      ],
    );
  });
});
