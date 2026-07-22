import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyRestartedRuntimeHandoff,
  buildInstalledRuntimeRestartScript,
  collectAudioPreferencePersistenceEvidence,
  canonicalPlanogramSlot,
  manualDispenseFrames,
  normalizeAudioPreferences,
  parseLocalOperationsGuestArgs,
  runLocalOperationsGuest,
  validateLocalOperationsEvidence,
} from "./local-operations-guest-full.mjs";

describe("local operations guest full", () => {
  it("parses the installed guest contract", () => {
    assert.equal(
      parseLocalOperationsGuestArgs([
        "--mode",
        "full",
        "--guest-input",
        "C:\\input.json",
        "--handoff",
        "C:\\handoff.json",
        "--out",
        "C:\\out.json",
      ]).mode,
      "full",
    );
  });
  it("uses canonical slotDisplayLabel and planogram identity", () => {
    assert.deepEqual(
      canonicalPlanogramSlot(
        {
          planogramVersion: "P-8",
          items: [
            {
              slotDisplayLabel: "R7C1",
              slotId: "slot-7",
              inventoryId: "inv-7",
            },
          ],
        },
        "R7C1",
      ).planogramVersion,
      "P-8",
    );
    assert.throws(
      () =>
        canonicalPlanogramSlot({ planogramVersion: "P-8", items: [] }, "R7C1"),
      /unavailable/,
    );
  });
  it("isolates serial frames emitted by the manual operation", () => {
    const heartbeat = { parsedOpcode: "AB" };
    const vend = {
      direction: "daemon-to-controller",
      parsedOpcode: "VEND",
    };
    assert.deepEqual(
      manualDispenseFrames(
        { rawFrames: [heartbeat] },
        { rawFrames: [heartbeat, vend] },
      ),
      [vend],
    );
  });
  it("requires business evidence without gating on VM touch-keyboard support", () => {
    const report = {
      schemaVersion: "vem-local-operations-guest-full/v1",
      ok: true,
      boundaries: { daemon: true, hardwareSelfCheck: true, serial: true },
      planogram: {
        canonical: true,
        planogramVersion: "P-8",
        slotDisplayLabel: "R7C1",
      },
      manualDispense: { slotDisplayLabel: "R7C1", outcome: "completed" },
      systemTouchKeyboard: {
        ok: false,
        blocking: false,
        error: "Windows input pane rejected the virtual-keyboard host",
      },
    };
    assert.equal(validateLocalOperationsEvidence(report).canonical, true);
    assert.throws(
      () =>
        validateLocalOperationsEvidence({
          ...report,
          planogram: { ...report.planogram, canonical: false },
        }),
      /boundary/,
    );
  });
  it("normalizes and compares audio preferences deterministically", () => {
    assert.deepEqual(
      normalizeAudioPreferences({
        volume: 0.349,
        cuesEnabled: 1,
        presenceCuesEnabled: "",
        transactionCuesEnabled: true,
      }),
      {
        volume: 0.35,
        cuesEnabled: true,
        presenceCuesEnabled: false,
        transactionCuesEnabled: true,
      },
    );
  });
  it("restarts the daemon with its authoritative data directory", () => {
    const script = buildInstalledRuntimeRestartScript({
      daemonDataDirectory: "C:\\ProgramData\\VEM\\vending-daemon",
    });
    assert.match(script, /--data-dir/);
    assert.match(script, /daemonDataDirectory/);
    assert.match(script, /Start-ScheduledTask/);
  });
  it("refreshes handoff daemon and CDP facts after the runtime restarts", () => {
    const handoff = {
      daemon: {
        executablePath: "C:\\VEM\\bringup\\vending-daemon.exe",
        processId: 11,
        ready: {
          healthzUrl: "http://127.0.0.1:7001/healthz",
          readyzUrl: "http://127.0.0.1:7001/readyz",
          ipcToken: "old-token",
          generation: "old-generation",
        },
      },
      machine: {
        executablePath: "C:\\VEM\\bringup\\machine.exe",
        processId: 21,
        sessionId: 3,
        principal: "VEM\\Operator",
      },
      cdp: {
        endpoint: "http://127.0.0.1:9222",
        targetId: "old-target",
        listenerProcessId: 31,
        machineAncestorProcessId: 21,
      },
    };
    const next = applyRestartedRuntimeHandoff(handoff, {
      ready: {
        healthzUrl: "http://127.0.0.1:7615/healthz",
        readyzUrl: "http://127.0.0.1:7615/readyz",
        ipcToken: "new-token",
        generation: "new-generation",
      },
      observedRuntime: {
        daemon: {
          processId: 12,
          executablePath: "C:\\VEM\\bringup\\vending-daemon.exe",
        },
        machine: {
          processId: 22,
          executablePath: "C:\\VEM\\bringup\\machine.exe",
          sessionId: 4,
          principal: "VEM\\Operator",
        },
        cdp: {
          endpoint: "http://127.0.0.1:9222",
          listenerProcessId: 32,
          machineAncestorProcessId: 22,
        },
      },
      target: { id: "new-target" },
    });

    assert.equal(next.daemon.processId, 12);
    assert.equal(next.daemon.ready.generation, "new-generation");
    assert.equal(next.machine.processId, 22);
    assert.equal(next.cdp.targetId, "new-target");
    assert.equal(next.cdp.listenerProcessId, 32);
  });
  it("proves audio preference persistence and restores enabled defaults", async () => {
    const handoff = {
      daemon: {
        ready: {
          healthzUrl: "http://127.0.0.1:7615/healthz",
          readyzUrl: "http://127.0.0.1:7615/readyz",
          ipcToken: "token-1",
          generation: "gen-1",
        },
      },
      cdp: {
        endpoint: "http://127.0.0.1:9222",
        targetId: "target-1",
      },
    };
    const state = {
      audio: {
        volume: 0.7,
        cuesEnabled: true,
        presenceCuesEnabled: true,
        transactionCuesEnabled: true,
      },
    };
    const evidence = await collectAudioPreferencePersistenceEvidence(
      { handoff, handoffPath: "C:\\handoff.json" },
      {
        withUiClient: async (_handoff, operation) => operation({ fake: true }),
        ensureMaintenanceExperienceTask: async () => {},
        setUiAudioPreferences: async (_client, expected) => {
          state.audio = normalizeAudioPreferences(expected);
          return state.audio;
        },
        readUiAudioPreferences: async () => state.audio,
        daemonRequest: async (_handoff, path) => {
          assert.equal(path, "/v1/runtime-configuration");
          return { experience: { audio: state.audio } };
        },
        restartRuntime: async (runtimeHandoff, handoffPath) => {
          assert.equal(handoffPath, "C:\\handoff.json");
          runtimeHandoff.daemon.ready = {
            healthzUrl: "http://127.0.0.1:7616/healthz",
            readyzUrl: "http://127.0.0.1:7616/readyz",
            ipcToken: "token-2",
            generation: "gen-2",
          };
          runtimeHandoff.cdp.targetId = "target-2";
          return {
            daemon: { ...runtimeHandoff.daemon, processId: 101 },
            machine: {
              executablePath: "C:\\VEM\\bringup\\machine.exe",
              processId: 202,
              sessionId: 4,
              principal: "VEM\\Operator",
            },
            cdp: {
              endpoint: "http://127.0.0.1:9222",
              targetId: "target-2",
              listenerProcessId: 303,
              machineAncestorProcessId: 202,
            },
            ready: { ...runtimeHandoff.daemon.ready },
          };
        },
      },
    );

    assert.deepEqual(evidence.preRestart.ui, {
      volume: 0.35,
      cuesEnabled: false,
      presenceCuesEnabled: false,
      transactionCuesEnabled: false,
    });
    assert.deepEqual(evidence.postRestart.daemon, evidence.preRestart.daemon);
    assert.equal(evidence.restartedRuntime.ready.ipcToken, "token-2");
    assert.deepEqual(evidence.restoredDefaults.ui, {
      volume: 0.7,
      cuesEnabled: true,
      presenceCuesEnabled: true,
      transactionCuesEnabled: true,
    });
    assert.deepEqual(state.audio, evidence.restoredDefaults.daemon);
  });
  it("adds audio persistence evidence to the runner report", async () => {
    const writes = [];
    let evidenceReads = 0;
    const input = {
      runId: "RUN-07",
      machineCode: "VEM-TESTBED-01",
      fixtureAllocation: {
        localOperations: { slotDisplayLabel: "R7C1" },
      },
      hostControlPlane: {
        endpoint: "http://127.0.0.1:7788",
        token: "host-token",
        targetIdentity: "target-01",
        runtimeBaseIdentity: "runtime-base-01",
      },
    };
    const handoff = {
      daemon: {
        ready: {
          healthzUrl: "http://127.0.0.1:7615/healthz",
          readyzUrl: "http://127.0.0.1:7615/readyz",
          ipcToken: "daemon-token",
        },
      },
    };
    const result = await runLocalOperationsGuest(
      {
        mode: "full",
        guestInputPath: "C:\\guest-input.json",
        handoffPath: "C:\\handoff.json",
        outPath: "C:\\report.json",
        fixtureKey: null,
      },
      {
        readJson: (path) => (path === "C:\\guest-input.json" ? input : handoff),
        writeJson: (path, value) => writes.push({ path, value }),
        waitForSerialBoundary: async () => ({ ok: true }),
        controlRequest: async (_input, path) => {
          if (path === "/v1/serial-sessions/start")
            return { sessionId: "serial-07" };
          if (path === "/v1/serial-sessions/serial-07/evidence") {
            evidenceReads += 1;
            return evidenceReads === 1
              ? { rawFrames: [{ parsedOpcode: "AB" }] }
              : {
                  rawFrames: [
                    { parsedOpcode: "AB" },
                    { parsedOpcode: "VEND" },
                    { parsedOpcode: "F0" },
                    { parsedOpcode: "F1" },
                    { parsedOpcode: "AF" },
                    { parsedOpcode: "F2" },
                  ],
                };
          }
          if (
            path === "/v1/serial-sessions/serial-07/release-f0" ||
            path === "/v1/serial-sessions/serial-07/release-f2" ||
            path === "/v1/serial-sessions/serial-07/abort"
          ) {
            return { ok: true };
          }
          if (path === "/v1/serial-sessions/serial-07/wait-frame") {
            return { ok: true };
          }
          throw new Error(`unexpected control path: ${path}`);
        },
        daemonRequest: async (_handoff, path) => {
          if (path === "/v1/sale-view") {
            return {
              planogramVersion: "P-8",
              items: [
                {
                  slotDisplayLabel: "R7C1",
                  slotId: "slot-7",
                  inventoryId: "inv-7",
                },
              ],
            };
          }
          if (path === "/v1/hardware/self-check") return { online: true };
          if (path === "/v1/hardware-bindings")
            return { lowerController: true };
          if (path === "/v1/maintenance/manual-dispense-diagnostic") {
            return { outcome: "completed", diagnosticId: "diag-07" };
          }
          throw new Error(`unexpected daemon path: ${path}`);
        },
        collectAudioPreferencePersistenceEvidence: async () => ({
          target: {
            volume: 0.35,
            cuesEnabled: false,
            presenceCuesEnabled: false,
            transactionCuesEnabled: false,
          },
          defaults: {
            volume: 0.7,
            cuesEnabled: true,
            presenceCuesEnabled: true,
            transactionCuesEnabled: true,
          },
          preRestart: { ui: { ok: true }, daemon: { ok: true } },
          postRestart: { ui: { ok: true }, daemon: { ok: true } },
          restoredDefaults: { ui: { ok: true }, daemon: { ok: true } },
          restartedRuntime: { ready: { ipcToken: "token-2" } },
        }),
        runInstalledSystemTouchKeyboardAcceptance: async () => ({
          ok: true,
          blocking: false,
        }),
      },
    );

    assert.equal(result.ok, true);
    assert.equal(
      result.audioPreferencePersistence.restartedRuntime.ready.ipcToken,
      "token-2",
    );
    assert.equal(writes.at(-1).path, "C:\\report.json");
    assert.equal(
      writes.at(-1).value.audioPreferencePersistence.target.volume,
      0.35,
    );
  });
});
