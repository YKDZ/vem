import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildBringUpPlan,
  buildResetPlan,
  buildRemotePowerShellScript,
  buildSshCommand,
  assertResetPlanPreservesTestbed,
} from "./win10-vem-e2e.mjs";

describe("win10-vem-e2e reset planning", () => {
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
