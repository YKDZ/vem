import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runStartupOwnerAcceptance } from "./startup-owner-acceptance.ts";
import {
  buildStartupRebootStabilityReport,
  type StartupRebootObservationInput,
} from "./startup-reboot-stability.ts";

const commit = "a".repeat(40);
type JsonRecord = Record<string, unknown>;

function recordValue(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

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
        readiness: {
          health: {
            status: "ok",
            protocol: "vem.vision.v2",
            module: "vision",
            mockScenario: "off",
            cameraReady: true,
          },
          handshake: {
            protocol: "vem.vision.v2",
            type: "vision.ready",
            messageId: "vision-ready-1",
            timestamp: "2026-08-24T12:05:18.000Z",
            serverName: "vending-vision",
            cameraReady: true,
            tryOnReady: true,
            visionBusinessReady: true,
            businessReadinessDiagnostic: "ready",
            schemaVersion: "2.0.0",
            bundleVersion: "2026-08-24",
            contractDigest: "e".repeat(64),
            capabilities: [
              "profile_push",
              "presence_status",
              "person_departed",
              "try_on",
            ],
          },
        },
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
    commit,
  });
}

function acceptedObservation({
  ordinal,
  installedAt,
  ownerConfigurationSha256 = "b".repeat(64),
}: {
  ordinal: number;
  installedAt: string;
  ownerConfigurationSha256?: string;
}): JsonRecord {
  return {
    schemaVersion: "vem-installed-runtime-startup-acceptance/v1",
    ok: true,
    mode: "full",
    commit,
    summary: {
      ownerInstalledAt: installedAt,
      ownerConfigurationSha256,
      modeEvidence: {
        source: "windows_reboot_logon_probe",
        bootMarker: `boot:VEM-VM:${ordinal}`,
        bootStartedAt: `2026-08-24T12:${String(ordinal).padStart(2, "0")}:00.000Z`,
        bootObservedAt: `2026-08-24T12:${String(ordinal).padStart(2, "0")}:20.000Z`,
        logonMarker: `logon:VEMKiosk:3:${ordinal}`,
        logonObservedAt: `2026-08-24T12:${String(ordinal).padStart(2, "0")}:20.000Z`,
        tasks: {},
      },
    },
  };
}

function releaseObservations(): StartupRebootObservationInput[] {
  const passOneInstalledAt = "2026-08-24T11:00:00.0000000Z";
  const passTwoInstalledAt = "2026-08-24T11:30:00.0000000Z";
  return [
    {
      source: "reconstructed_full_pass",
      pass: 1,
      reportPath: "/reports/pass-1/startup-owner-readiness.json",
      report: acceptedObservation({
        ordinal: 1,
        installedAt: passOneInstalledAt,
      }),
    },
    {
      source: "reconstructed_full_pass",
      pass: 2,
      reportPath: "/reports/pass-2/startup-owner-readiness.json",
      report: acceptedObservation({
        ordinal: 2,
        installedAt: passTwoInstalledAt,
      }),
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      source: "same_install_repeat",
      pass: 2,
      reportPath: `/reports/reboot-${index + 3}.json`,
      report: acceptedObservation({
        ordinal: index + 3,
        installedAt: passTwoInstalledAt,
      }),
    })),
  ];
}

describe("installed runtime startup lifecycle evidence", () => {
  it("accepts owners installed before a real reboot and triggered after it", () => {
    const report = run();
    assert.equal(report.ok, true);
    assert.equal(report.mode, "full");
    assert.equal(report.commit, commit);
    assert.equal(
      recordValue(report.summary).ownerInstalledAt,
      "2026-08-24T12:00:00.0000000Z",
    );
    assert.match(
      String(recordValue(report.summary).ownerConfigurationSha256),
      /^[a-f0-9]{64}$/,
    );
    assert.deepEqual(recordValue(report.summary).visionReadiness, {
      protocol: "vem.vision.v2",
      cameraReady: true,
      tryOnReady: true,
      visionBusinessReady: true,
      capabilities: [
        "profile_push",
        "presence_status",
        "person_departed",
        "try_on",
      ],
      contractDigest: "e".repeat(64),
    });
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

  it("requires camera, try-on, and complete generated V2 handshake readiness", () => {
    const cases = [
      {
        reasonCode: "vision_camera_not_ready",
        mutate(evidence: ReturnType<typeof fullEvidence>) {
          evidence.observation.vision.readiness.health.cameraReady = false;
        },
      },
      {
        reasonCode: "vision_try_on_not_ready",
        mutate(evidence: ReturnType<typeof fullEvidence>) {
          evidence.observation.vision.readiness.handshake.tryOnReady = false;
        },
      },
      {
        reasonCode: "vision_capability_incomplete",
        mutate(evidence: ReturnType<typeof fullEvidence>) {
          evidence.observation.vision.readiness.handshake.capabilities = [
            "profile_push",
            "presence_status",
            "person_departed",
          ];
        },
      },
    ];

    for (const testCase of cases) {
      const evidence = fullEvidence();
      testCase.mutate(evidence);
      const report = run(evidence);
      assert.equal(report.ok, false);
      assert.equal(report.failedStage, "vision_readiness");
      assert.equal(report.reasonCode, testCase.reasonCode);
    }
  });
});

describe("startup reboot release stability", () => {
  it("accepts ten same-commit and same-owner observations without rebuilding repeated samples", () => {
    const report = buildStartupRebootStabilityReport({
      commit,
      observations: releaseObservations(),
    });

    assert.equal(report.ok, true);
    assert.equal(report.sampleCount, 10);
    assert.equal(report.reconstructedPassCount, 2);
    assert.equal(report.sameInstallRepeatCount, 8);
    assert.match(String(report.observationListSha256), /^[a-f0-9]{64}$/);
  });

  it("fails closed on the first failed startup observation", () => {
    const observations = releaseObservations();
    observations[4].report = {
      schemaVersion: "vem-installed-runtime-startup-acceptance/v1",
      ok: false,
      mode: "full",
      commit,
      failedStage: "vision_owner",
      reasonCode: "task_action_failed",
      diagnostics: ["VEMVisionRuntime action failed with 0xC000013A"],
    };

    const report = buildStartupRebootStabilityReport({
      commit,
      observations,
    });

    assert.equal(report.ok, false);
    assert.match(
      String(arrayValue(report.gateFailures)[0]),
      /observation 5 failed/,
    );
    assert.equal(recordValue(report.firstFailure).observation, 5);
    assert.equal(
      recordValue(report.firstFailure).reasonCode,
      "task_action_failed",
    );
  });

  it("rejects owner drift, commit drift, duplicate boots, and missing samples", () => {
    const cases = [
      {
        expected: /owner configuration differs/,
        mutate(observations: ReturnType<typeof releaseObservations>) {
          recordValue(observations[6].report.summary).ownerConfigurationSha256 =
            "c".repeat(64);
        },
      },
      {
        expected: /commit differs/,
        mutate(observations: ReturnType<typeof releaseObservations>) {
          observations[6].report.commit = "d".repeat(40);
        },
      },
      {
        expected: /boot marker is not unique/,
        mutate(observations: ReturnType<typeof releaseObservations>) {
          recordValue(
            recordValue(observations[6].report.summary).modeEvidence,
          ).bootMarker = recordValue(
            recordValue(observations[5].report.summary).modeEvidence,
          ).bootMarker;
        },
      },
      {
        expected: /at least 10/,
        mutate(observations: ReturnType<typeof releaseObservations>) {
          observations.pop();
        },
      },
    ];

    for (const testCase of cases) {
      const observations = releaseObservations();
      testCase.mutate(observations);
      const report = buildStartupRebootStabilityReport({
        commit,
        observations,
      });
      assert.equal(report.ok, false);
      assert.match(String(report.gateFailures), testCase.expected);
    }
  });
});
