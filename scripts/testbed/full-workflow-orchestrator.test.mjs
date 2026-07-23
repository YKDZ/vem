import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  buildWorkflowTrackCommands,
  clearWholeMachineLockIfPresent,
  ensureFixtureStockReady,
  fixtureAllocationForTrack,
  replaceSerialSessionAndUpdateHandoff,
  restoreCatalogHomeFromClient,
  waitForCatalogHomeState,
  replaceUnavailableTestbedLowerController,
  returnToCatalogFromClient,
  FULL_WORKFLOW_TRACK_DESCRIPTORS,
  reloadRuntimeHandoff,
  refreshDaemonReadyHandoff,
  runSerialTrackLifecycle,
  waitForPlatformFixtureStock,
  waitForBusinessHardwareReady,
} from "./full-workflow-orchestrator.mjs";

describe("full workflow serial lifecycle", () => {
  it("reloads runtime identities changed by a track restart", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-handoff-reload-"));
    const handoffPath = join(root, "handoff.json");
    const handoff = { cdp: { targetId: "old-target" } };
    writeFileSync(
      handoffPath,
      JSON.stringify({ cdp: { targetId: "new-target" } }),
    );

    assert.equal(
      reloadRuntimeHandoff(handoffPath, handoff).cdp.targetId,
      "new-target",
    );
  });

  it("replaces an aborted serial session for the next business set", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-handoff-session-"));
    const handoffPath = join(root, "handoff.json");
    const handoff = {
      commissioningSerialSession: { sessionId: "serial-1" },
    };
    writeFileSync(handoffPath, JSON.stringify(handoff));
    const calls = [];
    await replaceSerialSessionAndUpdateHandoff({
      guestInput: {
        runId: "RUN-1",
        machineCode: "VEM-1",
        hostControlPlane: {
          targetIdentity: "vm-target://1",
          runtimeBaseIdentity: "runtime-base://1",
        },
      },
      handoff,
      handoffPath,
      sessionId: "serial-1",
      control: async (_input, path) => {
        calls.push(path);
        return path.endsWith("/start") ? { sessionId: "serial-2" } : {};
      },
    });
    assert.deepEqual(calls, [
      "/v1/serial-sessions/serial-1/abort",
      "/v1/serial-sessions/start",
    ]);
    assert.equal(handoff.commissioningSerialSession.sessionId, "serial-2");
    assert.equal(
      JSON.parse(readFileSync(handoffPath, "utf8")).commissioningSerialSession
        .sessionId,
      "serial-2",
    );
  });

  it("restores a stopped pickup session before waiting for the next set hardware", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-pickup-recovery-"));
    const handoffPath = join(root, "handoff.json");
    const handoff = {
      commissioningSerialSession: { sessionId: "pickup-control-plane-session" },
    };
    writeFileSync(handoffPath, JSON.stringify(handoff));
    let replacementStarted = false;
    const calls = [];

    await replaceSerialSessionAndUpdateHandoff({
      guestInput: {
        runId: "RUN-1",
        machineCode: "VEM-1",
        hostControlPlane: {
          targetIdentity: "vm-target://1",
          runtimeBaseIdentity: "runtime-base://1",
        },
      },
      handoff,
      handoffPath,
      sessionId: "pickup-control-plane-session",
      control: async (_input, path) => {
        calls.push(path);
        if (path.endsWith("/start")) {
          replacementStarted = true;
          return { sessionId: "pickup-replacement-session" };
        }
        return {};
      },
    });
    const ready = await waitForBusinessHardwareReady({
      daemonGet: async (path) => {
        calls.push(path);
        const available = replacementStarted;
        return path === "/v1/hardware-bindings"
          ? { roles: [{ role: "lower_controller", ready: available }] }
          : { canStartSale: available };
      },
      timeoutMs: 100,
      pollMs: 1,
    });

    assert.equal(
      handoff.commissioningSerialSession.sessionId,
      "pickup-replacement-session",
    );
    assert.equal(
      JSON.parse(readFileSync(handoffPath, "utf8")).commissioningSerialSession
        .sessionId,
      "pickup-replacement-session",
    );
    assert.equal(ready.capability.canStartSale, true);
    assert.deepEqual(calls, [
      "/v1/serial-sessions/pickup-control-plane-session/abort",
      "/v1/serial-sessions/start",
      "/v1/hardware-bindings",
      "/v1/sale-start-capability",
    ]);
  });

  it("waits for the lower controller and sale capability before the next set", async () => {
    let reads = 0;
    const result = await waitForBusinessHardwareReady({
      daemonGet: async (path) => {
        const ready = reads++ >= 2;
        return path === "/v1/hardware-bindings"
          ? { roles: [{ role: "lower_controller", ready }] }
          : { canStartSale: ready };
      },
      timeoutMs: 100,
      pollMs: 1,
    });
    assert.equal(result.lower.ready, true);
    assert.equal(result.capability.canStartSale, true);
  });

  it("replaces only an explicitly unavailable testbed lower-controller session", async () => {
    const replaced = [];
    const result = await replaceUnavailableTestbedLowerController({
      capability: {
        blockers: [{ code: "LOWER_CONTROLLER_UNAVAILABLE" }],
      },
      sessionId: "serial-1",
      replaceSerialSession: async (sessionId) => {
        replaced.push(sessionId);
        return { sessionId: "serial-2" };
      },
    });
    assert.deepEqual(replaced, ["serial-1"]);
    assert.deepEqual(result, {
      replaced: true,
      replacement: { sessionId: "serial-2" },
    });

    assert.deepEqual(
      await replaceUnavailableTestbedLowerController({
        capability: { blockers: [{ code: "PLATFORM_UNREACHABLE" }] },
        sessionId: "serial-2",
        replaceSerialSession: async () => {
          throw new Error("must not replace for another blocker");
        },
      }),
      { replaced: false },
    );
  });

  it("uses the production self-check and clear endpoints for a persisted whole-machine lock", async () => {
    const posts = [];
    let capabilityRead = 0;
    const result = await clearWholeMachineLockIfPresent({
      daemonGet: async () => ({
        blockers:
          capabilityRead++ === 0 ? [{ code: "WHOLE_MACHINE_LOCKED" }] : [],
      }),
      daemonPost: async (path, body) => {
        posts.push({ path, body });
        return { cleared: true };
      },
    });
    assert.equal(result.cleared, true);
    assert.deepEqual(posts, [
      { path: "/v1/hardware/self-check", body: {} },
      {
        path: "/v1/maintenance/whole-machine-lock/clear",
        body: { operatorNote: "testbed business-set handoff recovery" },
      },
    ]);
  });

  it("restores only the fixture owned by the current business set", () => {
    const allocation = {
      sale: { slotDisplayLabel: "A1", onHandQty: 3 },
      fulfillmentRecovery: { slotDisplayLabel: "A4", onHandQty: 3 },
    };
    assert.deepEqual(
      fixtureAllocationForTrack(allocation, { fixtureKey: "sale" }),
      { sale: allocation.sale },
    );
    assert.equal(
      fixtureAllocationForTrack(allocation, {
        fixtureKey: "environmentControl",
      }),
      null,
    );
  });
  it("owns canonical business-set selection, runners, fixture allocations, and evidence policy in one table", () => {
    assert.deepEqual(
      FULL_WORKFLOW_TRACK_DESCRIPTORS.map((track) => track.name),
      [
        "commissioning",
        "sale",
        "scannerPayment",
        "visionExperience",
        "pickupProtocol",
        "presenceAndAudio",
        "ipcRecovery",
        "fulfillmentRecovery",
        "paymentRecovery",
        "paymentProvider",
        "stockMaintenance",
        "hardwareLifecycle",
        "localOperations",
        "environmentControl",
      ],
    );
    assert.deepEqual(
      FULL_WORKFLOW_TRACK_DESCRIPTORS.filter((track) => track.core).map(
        (track) => track.name,
      ),
      ["sale", "stockMaintenance"],
    );
    for (const track of FULL_WORKFLOW_TRACK_DESCRIPTORS.filter(
      (candidate) => candidate.runner,
    )) {
      assert.match(track.runner.reportFileName, /\.json$/);
      assert.match(track.runner.artifactDirectory, /artifacts$/);
      assert.equal(track.evidence.passed.screenshot, true);
      assert.equal(track.evidence.failed.primaryReason, true);
      assert.equal(track.evidence.failed.diagnostic, true);
      assert.equal(track.evidence.failed.screenshot, false);
    }
  });

  it("keeps warm VM selection separate from full business-check semantics", () => {
    const plan = buildWorkflowTrackCommands({
      mode: "fast",
      focus: ["visionExperience", "presenceAndAudio", "environmentControl"],
      guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      handoffPath:
        "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
      outPath: "C:\\ProgramData\\VEM\\testbed\\full-workflow-tracks.json",
    });
    const vision = plan.tracks.find(
      (track) => track.key === "visionExperience",
    );
    assert.equal(vision.fixtureKey, "visionExperience");
    for (const track of plan.tracks.filter(
      (entry) => entry.runner.kind === "node",
    )) {
      const modeIndex = track.command.indexOf("--mode");
      assert.equal(track.command[modeIndex + 1], "full");
    }
  });

  it("captures and judges each terminal state before bounded recovery while continuing after a failure", async () => {
    const calls = [];
    const tracks = FULL_WORKFLOW_TRACK_DESCRIPTORS.filter(
      (track) => track.runner && track.name !== "commissioning",
    ).slice(0, 2);
    const result = await runSerialTrackLifecycle({
      tracks,
      now: (() => {
        let value = 0;
        return () => new Date(`2026-07-19T00:00:0${value++}.000Z`);
      })(),
      runTrack(track) {
        calls.push(`run:${track.key}`);
        return {
          status: track.key === "sale" ? "failed" : "passed",
          exitCode: track.key === "sale" ? 1 : 0,
          stdout: "child output",
          stderr: track.key === "fast" ? "primary failure" : "",
          report: { ok: track.key !== "sale" },
        };
      },
      async captureTerminal(track) {
        calls.push(`terminal:${track.key}`);
        return {
          ok: track.key !== "sale",
          facts: { route: "#/result/failure" },
          reason:
            track.key === "sale" ? "terminal route is not recoverable" : null,
        };
      },
      async recover(track) {
        calls.push(`recover:${track.key}`);
        return { ok: true, actions: ["returnToCatalog"] };
      },
    });

    assert.deepEqual(calls, [
      "run:sale",
      "terminal:sale",
      "recover:sale",
      "run:scannerPayment",
      "terminal:scannerPayment",
      "recover:scannerPayment",
    ]);
    assert.equal(result[0].businessStatus, "failed");
    assert.equal(result[0].failureStage, "child");
    assert.equal(result[0].terminal.ok, false);
    assert.equal(result[0].handoffRecovery.ok, true);
    assert.equal(result[1].businessStatus, "failed");
    assert.equal(result[1].durationMs, 1_000);
    assert.equal(result[1].handoffRecovery.durationMs, 1_000);
  });

  it("halts a warm run after fixture recovery fails and retains its recovery evidence", async () => {
    const calls = [];
    const tracks = FULL_WORKFLOW_TRACK_DESCRIPTORS.filter(
      (track) => track.runner && track.name !== "commissioning",
    ).slice(0, 2);
    const result = await runSerialTrackLifecycle({
      tracks,
      haltOnRecoveryFailure: true,
      runTrack: async (track) => {
        calls.push(`run:${track.key}`);
        return {
          status: "passed",
          exitCode: 0,
          report: {
            schemaVersion: "vem-fast-route-stress-sale/v2",
            ok: true,
            summary: {
              orderId: "order-1",
              paymentId: "payment-1",
              vendingCommandId: "command-1",
              protocol: ["VEND", "F0", "F1", "F2"],
              daemonStockDeltaAfterF2: -1,
              platformStockDeltaAfterF2: -1,
              visionEventId: "vision-1",
              repeatedPhysicalTouchTraceId: 1,
            },
          },
        };
      },
      captureTerminal: async (track) => {
        calls.push(`terminal:${track.key}`);
        return { ok: true, facts: { route: "#/catalog" } };
      },
      recover: async (track) => {
        calls.push(`recover:${track.key}`);
        return {
          ok: false,
          actions: ["restoreFixtureStock"],
          errors: ["fixture stock did not become sale-ready"],
          evidence: {
            fixtureStock: { targetQuantity: 1, daemon: { changed: true } },
          },
        };
      },
    });

    assert.deepEqual(calls, ["run:sale", "terminal:sale", "recover:sale"]);
    assert.equal(result.length, 1);
    assert.equal(result[0].businessStatus, "failed");
    assert.equal(result[0].failureStage, "handoff-recovery");
    assert.deepEqual(result[0].handoffRecovery.evidence.fixtureStock, {
      targetQuantity: 1,
      daemon: { changed: true },
    });
  });

  it("refreshes the shared handoff when the daemon rotates its ready generation", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-daemon-ready-"));
    const handoffPath = join(root, "handoff.json");
    const readyPath = join(root, "daemon-ready.json");
    writeFileSync(
      handoffPath,
      JSON.stringify({
        daemon: {
          ready: {
            healthzUrl: "http://127.0.0.1:41000/healthz",
            readyzUrl: "http://127.0.0.1:41000/readyz",
            ipcToken: "token-1",
            generation: "generation-1",
          },
        },
      }),
    );
    writeFileSync(
      readyPath,
      JSON.stringify({
        healthzUrl: "http://127.0.0.1:42000/healthz",
        readyzUrl: "http://127.0.0.1:42000/readyz",
        ipcToken: "token-2",
        generation: "generation-2",
      }),
    );

    const handoff = refreshDaemonReadyHandoff({ handoffPath, readyPath });

    assert.equal(
      handoff.daemon.ready.healthzUrl,
      "http://127.0.0.1:42000/healthz",
    );
    assert.equal(
      JSON.parse(readFileSync(handoffPath, "utf8")).daemon.ready.generation,
      "generation-2",
    );
  });

  it("records a preflight failure and continues to the next track", async () => {
    const reportPath = join(
      mkdtempSync(join(tmpdir(), "vem-workflow-preflight-report-")),
      "sale.json",
    );
    writeFileSync(reportPath, JSON.stringify({ ok: true }));
    const calls = [];
    const result = await runSerialTrackLifecycle({
      tracks: [
        {
          ...FULL_WORKFLOW_TRACK_DESCRIPTORS.find(
            (track) => track.name === "sale",
          ),
          key: "sale",
          reportPath,
        },
        {
          ...FULL_WORKFLOW_TRACK_DESCRIPTORS.find(
            (track) => track.name === "scannerPayment",
          ),
          key: "scannerPayment",
          reportPath: join(
            mkdtempSync(join(tmpdir(), "vem-workflow-next-report-")),
            "scanner.json",
          ),
        },
      ],
      beforeTrack(track) {
        calls.push(`preflight:${track.key}`);
        if (track.key === "sale") throw new Error("ready file was rotating");
      },
      runTrack(track) {
        calls.push(`run:${track.key}`);
        return { status: "passed", exitCode: 0, report: { ok: true } };
      },
      captureTerminal: async (track, { report }) => {
        if (track.key === "sale") assert.equal(report, null);
        return { ok: true, facts: {} };
      },
      recover: async () => ({ ok: true, actions: [] }),
    });

    assert.deepEqual(calls, [
      "preflight:sale",
      "preflight:scannerPayment",
      "run:scannerPayment",
    ]);
    assert.equal(result[0].businessStatus, "failed");
    assert.match(result[0].error, /ready file was rotating/);
    assert.equal(result[0].reportOk, null);
    assert.equal(existsSync(reportPath), false);
    assert.equal(result[1].businessStatus, "failed");
  });

  it("preserves child stderr when a failed process produced no report", async () => {
    const root = mkdtempSync(join(tmpdir(), "vem-workflow-child-error-"));
    const [result] = await runSerialTrackLifecycle({
      tracks: [
        {
          ...FULL_WORKFLOW_TRACK_DESCRIPTORS.find(
            (track) => track.name === "localOperations",
          ),
          reportPath: join(root, "local-operations.json"),
        },
      ],
      runTrack: async () => ({
        status: "failed",
        exitCode: 1,
        stderr: "Error: exact child startup failure",
      }),
      captureTerminal: async () => ({ ok: true, facts: {} }),
      recover: async () => ({ ok: true, actions: [] }),
    });
    assert.equal(result.reportOk, null);
    assert.equal(result.error, "Error: exact child startup failure");
  });

  it("uses the production stock maintenance task to restore fixture slots before a track", async () => {
    const posts = [];
    let saleViewReads = 0;
    const result = await ensureFixtureStockReady({
      fixtureAllocation: {
        fast: { slotId: "slot-1", slotDisplayLabel: "A1", onHandQty: 3 },
        scanner: { slotId: "slot-2", slotDisplayLabel: "A2", onHandQty: 4 },
      },
      async daemonGet(path) {
        if (path === "/v1/stock/maintenance-task") {
          return {
            taskId: "stock-count-01",
            mode: "recovery_count",
            slots: [
              {
                slotId: "slot-1",
                slotDisplayLabel: "stale-A1",
                currentQuantity: 0,
              },
              {
                slotId: "slot-2",
                slotDisplayLabel: "stale-A2",
                currentQuantity: 1,
              },
              {
                slotId: "slot-9",
                slotDisplayLabel: "stale-A9",
                currentQuantity: 2,
              },
            ],
          };
        }
        saleViewReads += 1;
        return {
          items: [
            {
              slotId: "slot-1",
              slotDisplayLabel: "A1",
              slotSalesState: saleViewReads > 1 ? "sale_ready" : "needs_count",
              saleableStock: saleViewReads > 1 ? 3 : 0,
              physicalStock: saleViewReads > 1 ? 3 : 0,
            },
            {
              slotId: "slot-2",
              slotDisplayLabel: "A2",
              slotSalesState: "sale_ready",
              saleableStock: 4,
              physicalStock: 4,
            },
          ],
        };
      },
      async daemonPost(path, body) {
        posts.push({ path, body });
        return {};
      },
      pollMs: 0,
    });

    assert.deepEqual(result, {
      changed: true,
      taskId: "stock-count-01",
      mode: "recovery_count",
    });
    assert.deepEqual(posts, [
      {
        path: "/v1/stock/maintenance-task",
        body: {
          taskId: "stock-count-01",
          mode: "recovery_count",
          slots: [
            { slotId: "slot-1", quantity: 3 },
            { slotId: "slot-2", quantity: 4 },
            { slotId: "slot-9", quantity: 2 },
          ],
        },
      },
    ]);
  });

  it("waits for the daemon stock-sync watcher to establish an acknowledged planogram", async () => {
    let taskReads = 0;
    let saleViewReads = 0;
    const result = await ensureFixtureStockReady({
      fixtureAllocation: {
        fast: { slotId: "slot-1", slotDisplayLabel: "A1", onHandQty: 3 },
      },
      async daemonGet(path) {
        if (path === "/v1/stock/maintenance-task") {
          taskReads += 1;
          throw new Error("active acknowledged planogram is required");
        }
        saleViewReads += 1;
        return {
          items: [
            {
              slotId: "slot-1",
              slotDisplayLabel: "A1",
              slotSalesState: saleViewReads >= 3 ? "sale_ready" : "needs_count",
              saleableStock: saleViewReads >= 3 ? 3 : 0,
              physicalStock: saleViewReads >= 3 ? 3 : 0,
            },
          ],
        };
      },
      daemonPost: async () => {
        throw new Error("stock write was not expected");
      },
      pollMs: 0,
    });
    assert.deepEqual(result, { changed: false });
    assert.equal(taskReads, 2);
  });

  it("refills a consumed fixture through the production maintenance task", async () => {
    const posts = [];
    let saleViewReads = 0;
    const result = await ensureFixtureStockReady({
      fixtureAllocation: {
        fast: { slotId: "slot-1", slotDisplayLabel: "A1", onHandQty: 3 },
      },
      async daemonGet(path) {
        if (path === "/v1/stock/maintenance-task") {
          return {
            taskId: "stock-refill-01",
            mode: "routine_refill",
            slots: [
              { slotId: "slot-1", slotDisplayLabel: "A1", currentQuantity: 2 },
              { slotId: "slot-2", slotDisplayLabel: "A2", currentQuantity: 3 },
            ],
          };
        }
        saleViewReads += 1;
        return {
          items: [
            {
              slotId: "slot-1",
              slotDisplayLabel: "A1",
              slotSalesState: "sale_ready",
              saleableStock: saleViewReads > 1 ? 3 : 2,
              physicalStock: saleViewReads > 1 ? 3 : 2,
            },
          ],
        };
      },
      async daemonPost(path, body) {
        posts.push({ path, body });
        return {};
      },
      pollMs: 0,
    });
    assert.equal(result.mode, "routine_refill");
    assert.deepEqual(posts[0].body.slots, [{ slotId: "slot-1", addition: 1 }]);
  });

  it("waits for a zero-addition historical refill projection without rewriting unrelated slots", async () => {
    const posts = [];
    const reads = [];
    let saleViewReads = 0;
    let projectionReads = 0;
    const result = await ensureFixtureStockReady({
      fixtureAllocation: {
        stockMaintenance: {
          slotId: "slot-1",
          slotDisplayLabel: "A1",
          onHandQty: 3,
        },
      },
      async daemonGet(path) {
        reads.push(path);
        if (path === "/v1/stock/maintenance-task") {
          return {
            taskId: "historical-refill-01",
            mode: "routine_refill",
            status: "pending",
            slots: [
              { slotId: "slot-1", currentQuantity: 3 },
              { slotId: "slot-2", currentQuantity: 9 },
            ],
          };
        }
        if (
          path === "/v1/stock/maintenance-tasks/historical-refill-01/projection"
        ) {
          projectionReads += 1;
          return {
            taskId: "historical-refill-01",
            mode: "routine_refill",
            status: projectionReads > 1 ? "complete" : "pending",
            slots: [
              {
                slotId: "slot-1",
                submittedAddition: 2,
                previewQuantity: 3,
                syncStatus: "accepted",
              },
              {
                slotId: "slot-2",
                submittedAddition: 4,
                previewQuantity: 9,
                syncStatus: "accepted",
              },
            ],
          };
        }
        saleViewReads += 1;
        return {
          items: [
            {
              slotId: "slot-1",
              slotSalesState: saleViewReads > 1 ? "sale_ready" : "needs_count",
              saleableStock: 3,
              physicalStock: 3,
            },
          ],
        };
      },
      async daemonPost(path, body) {
        posts.push({ path, body });
      },
      pollMs: 0,
    });

    assert.deepEqual(result, {
      changed: false,
      taskId: "historical-refill-01",
      mode: "routine_refill",
      projection: {
        taskId: "historical-refill-01",
        mode: "routine_refill",
        status: "complete",
        slots: [
          {
            slotId: "slot-1",
            submittedAddition: 2,
            previewQuantity: 3,
            syncStatus: "accepted",
          },
          {
            slotId: "slot-2",
            submittedAddition: 4,
            previewQuantity: 9,
            syncStatus: "accepted",
          },
        ],
      },
    });
    assert.deepEqual(posts, []);
    assert.ok(
      reads.includes(
        "/v1/stock/maintenance-tasks/historical-refill-01/projection",
      ),
    );
  });

  it("rejects a historical refill projection that does not cover the allocated fixture", async () => {
    await assert.rejects(
      () =>
        ensureFixtureStockReady({
          fixtureAllocation: {
            stockMaintenance: {
              slotId: "slot-1",
              slotDisplayLabel: "A1",
              onHandQty: 3,
            },
          },
          async daemonGet(path) {
            if (path === "/v1/stock/maintenance-task") {
              return {
                taskId: "historical-refill-01",
                mode: "routine_refill",
                status: "complete",
                slots: [{ slotId: "slot-1", currentQuantity: 3 }],
              };
            }
            if (path.includes("/projection")) {
              return {
                taskId: "historical-refill-01",
                mode: "routine_refill",
                status: "complete",
                slots: [],
              };
            }
            return {
              items: [
                {
                  slotId: "slot-1",
                  slotSalesState: "frozen",
                  saleableStock: 3,
                  physicalStock: 3,
                },
              ],
            };
          },
          daemonPost: async () => assert.fail("must not rewrite stock"),
          pollMs: 0,
        }),
      /projection does not satisfy allocated fixtures/,
    );
  });

  it("restores an overstocked warm fixture to its exact baseline through physical stock attestation", async () => {
    const posts = [];
    let saleViewReads = 0;
    const result = await ensureFixtureStockReady({
      fixtureAllocation: {
        stockMaintenance: {
          slotId: "slot-01",
          slotDisplayLabel: "A1",
          onHandQty: 1,
        },
      },
      async daemonGet(path) {
        if (path === "/v1/stock/maintenance-task") {
          return {
            taskId: "stock-refill-01",
            mode: "routine_refill",
            slots: [
              { slotId: "slot-01", slotDisplayLabel: "A1", currentQuantity: 2 },
            ],
          };
        }
        saleViewReads += 1;
        return {
          planogramVersion: "PLAN-01",
          items: [
            {
              slotId: "slot-01",
              slotDisplayLabel: "A1",
              sku: "SKU-01",
              slotSalesState: "sale_ready",
              saleableStock: saleViewReads > 1 ? 1 : 2,
              physicalStock: saleViewReads > 1 ? 1 : 2,
            },
            {
              slotId: "slot-02",
              slotDisplayLabel: "A2",
              sku: "SKU-02",
              slotSalesState: "frozen",
              saleableStock: 0,
              physicalStock: 3,
            },
          ],
        };
      },
      async daemonPost(path, body) {
        posts.push({ path, body });
        return {};
      },
      pollMs: 0,
    });

    assert.equal(result.changed, true);
    assert.equal(result.mode, "physical_stock_attestation");
    assert.match(result.taskId, /^testbed-stock-recovery-\d+$/);
    assert.equal(posts[0].path, "/v1/stock/attestation");
    assert.equal(posts[0].body.attestationId, result.taskId);
    assert.deepEqual(posts[0].body, {
      attestationId: result.taskId,
      planogramVersion: "PLAN-01",
      operatorId: "testbed-orchestrator",
      slots: [
        {
          slotId: "slot-01",
          sku: "SKU-01",
          quantity: 1,
          enabled: true,
        },
        {
          slotId: "slot-02",
          sku: "SKU-02",
          quantity: 3,
          enabled: false,
        },
      ],
    });
  });

  it("uses physical stock attestation when fixture quantities are full but sales state is frozen", async () => {
    const posts = [];
    let saleViewReads = 0;
    const result = await ensureFixtureStockReady({
      fixtureAllocation: {
        fast: { slotId: "slot-01", slotDisplayLabel: "A1", onHandQty: 3 },
      },
      async daemonGet(path) {
        if (path === "/v1/stock/maintenance-task") {
          return {
            taskId: "stock-refill-01",
            mode: "routine_refill",
            slots: [
              { slotId: "slot-01", slotDisplayLabel: "A1", currentQuantity: 3 },
            ],
          };
        }
        saleViewReads += 1;
        return {
          planogramVersion: "PLAN-01",
          items: [
            {
              slotId: "slot-01",
              slotDisplayLabel: "A1",
              sku: "SKU-01",
              slotSalesState: saleViewReads > 1 ? "sale_ready" : "frozen",
              saleableStock: saleViewReads > 1 ? 3 : 0,
              physicalStock: 3,
            },
          ],
        };
      },
      async daemonPost(path, body) {
        posts.push({ path, body });
        return {};
      },
      pollMs: 0,
    });
    assert.equal(result.mode, "physical_stock_attestation");
    assert.equal(posts[0].path, "/v1/stock/attestation");
    assert.equal(posts[0].body.planogramVersion, "PLAN-01");
    assert.deepEqual(posts[0].body.slots, [
      {
        slotId: "slot-01",
        sku: "SKU-01",
        quantity: 3,
        enabled: true,
      },
    ]);
  });

  it("skips stock maintenance when every fixture slot is already sale-ready", async () => {
    let postCount = 0;
    const result = await ensureFixtureStockReady({
      fixtureAllocation: {
        fast: { slotId: "slot-1", slotDisplayLabel: "A1", onHandQty: 3 },
      },
      daemonGet: async () => ({
        items: [
          {
            slotId: "slot-1",
            slotDisplayLabel: "A1",
            slotSalesState: "sale_ready",
            saleableStock: 3,
            physicalStock: 3,
          },
        ],
      }),
      daemonPost: async () => {
        postCount += 1;
      },
    });
    assert.deepEqual(result, { changed: false });
    assert.equal(postCount, 0);
  });

  it("accepts a routine refill no-op projection when fixture stock is already satisfied", async () => {
    let postCount = 0;
    let saleViewReads = 0;
    const reads = [];
    const result = await ensureFixtureStockReady({
      fixtureAllocation: {
        localOperations: {
          slotId: "slot-1",
          slotDisplayLabel: "A1",
          onHandQty: 3,
        },
      },
      async daemonGet(path) {
        reads.push(path);
        if (path === "/v1/stock/maintenance-task") {
          return {
            taskId: "stock-refill-02",
            mode: "routine_refill",
            status: "ready",
            slots: [{ slotId: "slot-1", currentQuantity: 3 }],
          };
        }
        if (path === "/v1/stock/maintenance-tasks/stock-refill-02/projection") {
          return {
            taskId: "stock-refill-02",
            mode: "routine_refill",
            status: "ready",
            slots: [
              {
                slotId: "slot-1",
                submittedAddition: null,
                previewQuantity: null,
                syncStatus: "not_submitted",
              },
            ],
          };
        }
        saleViewReads += 1;
        return {
          items: [
            {
              slotId: "slot-1",
              slotDisplayLabel: "A1",
              slotSalesState: saleViewReads > 1 ? "sale_ready" : "needs_count",
              saleableStock: 3,
              physicalStock: 3,
            },
          ],
        };
      },
      async daemonPost() {
        postCount += 1;
      },
      pollMs: 0,
    });

    assert.deepEqual(result, {
      changed: false,
      taskId: "stock-refill-02",
      mode: "routine_refill",
      projection: {
        taskId: "stock-refill-02",
        mode: "routine_refill",
        status: "ready",
        slots: [
          {
            slotId: "slot-1",
            submittedAddition: null,
            previewQuantity: null,
            syncStatus: "not_submitted",
          },
        ],
      },
    });
    assert.equal(postCount, 0);
    assert.equal(saleViewReads, 2);
    assert.ok(
      reads.includes("/v1/stock/maintenance-tasks/stock-refill-02/projection"),
    );
  });

  it("waits for asynchronous stock upload to settle in the authoritative platform", async () => {
    let inventoryReads = 0;
    const calls = [];
    const result = await waitForPlatformFixtureStock({
      guestInput: {
        serviceApi: { adminUsername: "admin", adminPassword: "secret" },
      },
      fixtureAllocation: {
        pickupProtocol: {
          inventoryId: "inventory-5",
          slotDisplayLabel: "A5",
          onHandQty: 3,
        },
      },
      request: async (_input, path, options) => {
        calls.push({ path, options });
        if (path === "/auth/login") return { accessToken: "token-1" };
        inventoryReads += 1;
        return {
          items: [
            {
              id: "inventory-5",
              onHandQty: inventoryReads === 1 ? 2 : 3,
              reservedQty: 0,
            },
          ],
        };
      },
      pollMs: 0,
    });
    assert.equal(inventoryReads, 2);
    assert.deepEqual(result.inventories, [
      {
        inventoryId: "inventory-5",
        expectedOnHandQty: 3,
        onHandQty: 3,
        reservedQty: 0,
      },
    ]);
    assert.deepEqual(calls[0], {
      path: "/auth/login",
      options: {
        method: "POST",
        body: { username: "admin", password: "secret" },
      },
    });
    assert.equal(calls[1].options.token, "token-1");
  });

  it("returns from payment route via customer cancel entry then back to catalog", async () => {
    const calls = [];
    const routeIdentity = { route: "#/catalog" };
    const routeByRoute = new Map([["PAYMENT_RETURN", "#/catalog"]]);
    const result = await returnToCatalogFromClient({
      client: { id: "client" },
      evaluateExpressionFn: async () => "#/payment",
      activateVisibleSelectorFn: async (_client, selector) => {
        calls.push(selector);
        if (selector === '[data-test="payment-cancel"]:not(:disabled)') {
          return { selector };
        }
      },
      waitForRouteFn: async (_client, expected) => {
        calls.push(`wait:${expected.source || expected}`);
        return { route: routeByRoute.get("PAYMENT_RETURN") };
      },
    });
    assert.equal(result, routeIdentity.route);
    assert.deepEqual(calls, [
      '[data-test="payment-cancel"]:not(:disabled)',
      "wait:^(?:#\\/catalog|#\\/result(?:\\/|$)|#\\/checkout|#\\/products(?:\\/|$))",
    ]);
  });

  it("waits for production startup to leave boot without forcing navigation", async () => {
    const calls = [];
    const result = await returnToCatalogFromClient({
      client: { id: "client" },
      evaluateExpressionFn: async () => "#/boot",
      activateVisibleSelectorFn: async () => {
        throw new Error("boot must not use a customer control");
      },
      waitForRouteFn: async (_client, expected, options) => {
        calls.push({ expected, options });
        return { route: "#/catalog" };
      },
    });
    assert.equal(result, "#/catalog");
    assert.deepEqual(calls, [
      {
        expected: "#/catalog",
        options: { timeoutMs: 30_000, pollMs: 250 },
      },
    ]);
  });

  it("returns from a selected category to the Catalog home through the visible control", async () => {
    const calls = [];
    const result = await restoreCatalogHomeFromClient({
      client: { id: "client" },
      async returnToCatalogFn() {
        calls.push("catalog");
      },
      async evaluateExpressionFn(_client, expression) {
        calls.push(`evaluate:${expression}`);
        return true;
      },
      async activateVisibleSelectorFn(_client, selector, options) {
        calls.push({ selector, options });
      },
      async waitForRouteFn(_client, route, options) {
        calls.push({ route, options });
        return { route };
      },
      async waitForCatalogHomeStateFn({
        client,
        evaluateExpressionFn,
        timeoutMs,
      }) {
        assert.deepEqual(client, { id: "client" });
        assert.equal(typeof evaluateExpressionFn, "function");
        calls.push({ homeStateTimeoutMs: timeoutMs });
        return "#/catalog";
      },
    });
    assert.equal(result, "#/catalog");
    assert.deepEqual(calls, [
      "catalog",
      'evaluate:Boolean(document.querySelector(".catalog-back-button"))',
      {
        selector: ".catalog-back-button",
        options: { kind: "touch", timeoutMs: 10_000 },
      },
      {
        route: "#/catalog",
        options: { timeoutMs: 10_000, pollMs: 250 },
      },
      {
        homeStateTimeoutMs: 10_000,
      },
    ]);
  });

  it("waits for the Catalog home marker after back disappears", async () => {
    const states = [
      { homeMarkerVisible: false, categoryBackVisible: true },
      { homeMarkerVisible: true, categoryBackVisible: false },
    ];
    assert.equal(
      await waitForCatalogHomeState({
        client: { id: "client" },
        evaluateExpressionFn: async () => states.shift(),
        timeoutMs: 100,
        pollMs: 0,
      }),
      "#/catalog",
    );
  });

  it("does not treat persistent boot, offline, or maintenance routes as catalog", async () => {
    for (const route of ["#/boot", "#/offline", "#/maintenance"]) {
      await assert.rejects(
        () =>
          returnToCatalogFromClient({
            client: { id: "client" },
            evaluateExpressionFn: async () => route,
            waitForRouteFn: async () => {
              throw new Error(`${route} did not reach catalog`);
            },
            activateVisibleSelectorFn: async () => {
              throw new Error("no customer return control");
            },
          }),
        /did not reach catalog|no supported customer return control/,
      );
    }
  });

  it("accepts an automatic return to catalog while activating a stale route control", async () => {
    const routes = ["#/result/success", "#/catalog"];
    const result = await returnToCatalogFromClient({
      client: { id: "client" },
      evaluateExpressionFn: async () => routes.shift() ?? "#/catalog",
      activateVisibleSelectorFn: async () => {
        throw new Error("result control disappeared");
      },
      waitForRouteFn: async () => {
        throw new Error("route wait must not be needed");
      },
    });
    assert.equal(result, "#/catalog");
  });

  it("reports payment cancellation failure when the payment-cancel control is disabled", async () => {
    await assert.rejects(
      returnToCatalogFromClient({
        client: { id: "client" },
        evaluateExpressionFn: async () => "#/payment",
        activateVisibleSelectorFn: async () => {
          throw new Error("payment-cancel control is disabled");
        },
        waitForRouteFn: async () => {
          throw new Error("payment route remained active");
        },
      }),
      /payment-cancel control is disabled/,
    );
  });

  it("waits for transaction cancellation to project away from payment when its control disappeared", async () => {
    const calls = [];
    const result = await returnToCatalogFromClient({
      client: { id: "client" },
      evaluateExpressionFn: async () => "#/payment",
      activateVisibleSelectorFn: async (_client, selector) => {
        calls.push(selector);
        if (selector.includes("payment-cancel")) {
          throw new Error(
            "payment control disappeared after daemon cancellation",
          );
        }
        return { selector };
      },
      waitForRouteFn: async (_client, expected) => {
        calls.push(`wait:${expected.source || expected}`);
        return expected === "#/catalog"
          ? { route: "#/catalog" }
          : { route: "#/result/payment_failed" };
      },
    });
    assert.equal(result, "#/catalog");
    assert.deepEqual(calls, [
      '[data-test="payment-cancel"]:not(:disabled)',
      "wait:^(?:#\\/catalog|#\\/result(?:\\/|$)|#\\/checkout|#\\/products(?:\\/|$))",
      ".result-return-button, .failure-return-button",
      "wait:#/catalog",
    ]);
  });
});
