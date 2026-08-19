import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  runStartupOwnerAcceptance,
  startupArtifactDirectory,
  validateStartupOwnerReadinessEvidence,
} from "./startup-owner-acceptance.ts";

function passingEvidence(mode = "fast") {
  return {
    schemaVersion: "vem-installed-runtime-startup-acceptance/v1",
    ownerManifest: {
      schemaVersion: "vem-runtime-owners/v1",
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
        taskState: "Running",
        processCount: 1,
        sessionId: 3,
        route: "#/catalog",
      },
      vision: {
        taskState: "Running",
        processCount: 1,
        workerCount: 2,
        sessionId: 3,
      },
    },
    modeEvidence:
      mode === "full"
        ? {
            mode,
            source: "windows_reboot_logon_probe",
            boot: {
              marker: "boot:20260724:001",
              observedAt: "2026-07-24T08:00:00.000Z",
            },
            logon: {
              marker: "logon:VEMKiosk:3:001",
              user: "VEMKiosk",
              sessionId: 3,
              observedAt: "2026-07-24T08:00:05.000Z",
            },
          }
        : {
            mode,
            source: "installed_owner_stop_start",
            ownerRestartMarker: "owner-restart:001",
          },
  };
}

describe("installed runtime startup-owner acceptance", () => {
  it("uses the registry artifact-root name beside its report", () => {
    assert.equal(
      startupArtifactDirectory("/tmp/vem/startup-owner-readiness.json"),
      "/tmp/vem/startup-owner-readiness-artifacts",
    );
  });

  it("accepts exactly one installed owner for daemon, Machine UI, and Vision", () => {
    const summary = validateStartupOwnerReadinessEvidence(passingEvidence());

    assert.deepEqual(summary, {
      daemonService: "VemVendingDaemon",
      machineUiTask: "VEMMachineUI",
      visionTask: "VEMVisionRuntime",
      kioskSessionId: 3,
      catalogRoute: "#/catalog",
      modeEvidence: {
        source: "installed_owner_stop_start",
        ownerRestartMarker: "owner-restart:001",
      },
    });
  });

  it("accepts AtLogon launcher tasks that return to Ready after starting their child process", () => {
    const evidence = passingEvidence();
    evidence.observation.machineUi.taskState = "Ready";
    evidence.observation.vision.taskState = "Ready";

    assert.equal(
      validateStartupOwnerReadinessEvidence(evidence).catalogRoute,
      "#/catalog",
    );
  });

  it("counts the listener-owning Vision main as the owner while retaining fork-worker evidence", () => {
    const evidence = passingEvidence();

    assert.equal(
      validateStartupOwnerReadinessEvidence(evidence).visionTask,
      "VEMVisionRuntime",
    );

    evidence.observation.vision.processCount = 3;
    assert.throws(
      () => validateStartupOwnerReadinessEvidence(evidence),
      /Vision must run in the active VEMKiosk session/,
    );

    evidence.observation.vision.processCount = 1;
    evidence.observation.vision.workerCount = -1;
    assert.throws(
      () => validateStartupOwnerReadinessEvidence(evidence),
      /Vision worker count must be a non-negative integer/,
    );
  });

  it("rejects an absent owner projection instead of accepting direct-launch smoke", () => {
    const report = runStartupOwnerAcceptance({
      mode: "fast",
      handoff: {},
      fixtureKey: "startup",
    });

    assert.equal(report.ok, false);
    assert.match(report.diagnostics[0], /owner readiness projection is absent/);
  });

  it("rejects duplicate or cross-session runtime owners", () => {
    const duplicateDaemon = passingEvidence();
    duplicateDaemon.observation.daemon.processCount = 2;
    assert.throws(
      () => validateStartupOwnerReadinessEvidence(duplicateDaemon),
      /daemon process count must be exactly one/,
    );

    const crossSessionMachine = passingEvidence();
    crossSessionMachine.observation.machineUi.sessionId = 4;
    assert.throws(
      () => validateStartupOwnerReadinessEvidence(crossSessionMachine),
      /Machine UI must run in the active VEMKiosk session/,
    );
  });

  it("requires reboot and VEMKiosk logon markers before full startup can pass", () => {
    assert.throws(
      () => validateStartupOwnerReadinessEvidence(passingEvidence(), "full"),
      /must declare full mode/,
    );
    const missingBoot = passingEvidence("full");
    missingBoot.modeEvidence.boot.marker = "";
    assert.throws(
      () => validateStartupOwnerReadinessEvidence(missingBoot, "full"),
      /full reboot boot marker/,
    );
    assert.equal(
      runStartupOwnerAcceptance({
        mode: "full",
        handoff: { startupOwnerReadiness: passingEvidence("full") },
        fixtureKey: "startup",
      }).ok,
      true,
    );
  });
});
