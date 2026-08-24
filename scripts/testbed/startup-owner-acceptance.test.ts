import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runStartupOwnerAcceptance } from "./startup-owner-acceptance.ts";

function fullEvidence() {
  return {
    schemaVersion: "vem-installed-runtime-startup-acceptance/v1",
    ownerManifest: {
      schemaVersion: "vem-runtime-owners/v1",
      installedAt: "2026-08-24T12:00:00.0000000Z",
      owners: {
        daemon: {
          name: "VemVendingDaemon",
          account: "LocalSystem",
          startType: "Automatic",
        },
        machineUi: {
          name: "VEMMachineUI",
          trigger: "AtLogon",
          user: "VEMKiosk",
        },
        vision: {
          name: "VEMVisionRuntime",
          trigger: "AtLogon",
          user: "VEMKiosk",
        },
      },
    },
    observation: {
      source: "windows_service_task_process_session_probe",
      daemon: { status: "Running", processCount: 1, ready: true },
      kioskSession: { user: "VEMKiosk", sessionId: 3, active: true },
      machineUi: {
        taskState: "Ready",
        processCount: 1,
        sessionId: 3,
        route: "#/catalog",
      },
      vision: {
        taskState: "Ready",
        processCount: 1,
        workerCount: 2,
        sessionId: 3,
      },
    },
    modeEvidence: {
      mode: "full",
      source: "windows_reboot_logon_probe",
      boot: {
        marker: "boot:VEM-VM:20260824120500000Z",
        startedAt: "2026-08-24T12:05:00.000Z",
        observedAt: "2026-08-24T12:05:20.000Z",
      },
      logon: {
        marker: "logon:VEMKiosk:3:1787573120000",
        user: "VEMKiosk",
        sessionId: 3,
        observedAt: "2026-08-24T12:05:20.000Z",
      },
      tasks: {
        machineUi: {
          name: "VEMMachineUI",
          state: "Ready",
          lastRunTime: "2026-08-24T12:05:08.000Z",
          lastTaskResult: 0,
        },
        vision: {
          name: "VEMVisionRuntime",
          state: "Ready",
          lastRunTime: "2026-08-24T12:05:09.000Z",
          lastTaskResult: 0,
        },
      },
    },
  };
}

function run(evidence = fullEvidence()) {
  return runStartupOwnerAcceptance({
    mode: "full",
    fixtureKey: "startup",
    handoff: { startupOwnerReadiness: evidence },
  });
}

describe("installed runtime startup lifecycle evidence", () => {
  it("accepts owners installed before a real reboot and triggered after it", () => {
    const report = run();
    assert.equal(report.ok, true);
    assert.equal(report.mode, "full");
  });

  it("rejects a current-boot marker fabricated after warm owner starts", () => {
    const evidence = fullEvidence();
    evidence.ownerManifest.installedAt = "2026-08-24T12:06:00.000Z";

    const report = run(evidence);

    assert.equal(report.ok, false);
    assert.equal(report.failedStage, "boot");
    assert.equal(report.reasonCode, "reboot_not_after_owner_install");
  });

  it("rejects an owner task that did not run after the accepted reboot", () => {
    const evidence = fullEvidence();
    evidence.modeEvidence.tasks.vision.lastRunTime = "2026-08-24T11:59:00.000Z";

    const report = run(evidence);

    assert.equal(report.ok, false);
    assert.equal(report.failedStage, "vision_owner");
    assert.equal(report.reasonCode, "task_not_triggered_after_reboot");
  });

  it("preserves the first AtLogon action exit code instead of accepting process luck", () => {
    const evidence = fullEvidence();
    evidence.modeEvidence.tasks.machineUi.lastTaskResult = 0xc000013a;

    const report = run(evidence);

    assert.equal(report.ok, false);
    assert.equal(report.failedStage, "machine_ui_owner");
    assert.equal(report.reasonCode, "task_action_failed");
    assert.match(String(report.diagnostics), /0xC000013A/);
  });
});
