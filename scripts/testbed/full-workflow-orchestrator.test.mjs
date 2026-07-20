import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  ensureFixtureStockReady,
  returnToCatalogFromClient,
  FULL_WORKFLOW_TRACK_DESCRIPTORS,
  refreshDaemonReadyHandoff,
  runSerialTrackLifecycle,
} from "./full-workflow-orchestrator.mjs";

describe("full workflow serial lifecycle", () => {
  it("owns the fixed full order, artifacts, fixture allocations, and result-specific evidence policy in one table", () => {
    assert.deepEqual(
      FULL_WORKFLOW_TRACK_DESCRIPTORS.map((track) => track.key),
      [
        "fast",
        "scanner",
        "visionTryOn",
        "delayedPickup",
        "ipcRecovery",
        "fulfillmentFailure",
      ],
    );
    assert.deepEqual(
      FULL_WORKFLOW_TRACK_DESCRIPTORS.map((track) => track.fixtureKey),
      [
        "fast",
        "scanner",
        "visionTryOn",
        "delayedPickup",
        "ipcRecovery",
        "fulfillmentFailure",
      ],
    );
    for (const track of FULL_WORKFLOW_TRACK_DESCRIPTORS) {
      assert.match(track.reportFileName, /\.json$/);
      assert.match(track.artifactDirectory, /artifacts$/);
      assert.equal(track.evidence.passed.screenshot, true);
      assert.equal(track.evidence.failed.primaryReason, true);
      assert.equal(track.evidence.failed.diagnostic, true);
      assert.equal(track.evidence.failed.screenshot, false);
    }
  });

  it("captures and judges each terminal state before bounded recovery while continuing after a failure", async () => {
    const calls = [];
    const tracks = FULL_WORKFLOW_TRACK_DESCRIPTORS.slice(0, 2);
    const result = await runSerialTrackLifecycle({
      tracks,
      now: (() => {
        let value = 0;
        return () => new Date(`2026-07-19T00:00:0${value++}.000Z`);
      })(),
      runTrack(track) {
        calls.push(`run:${track.key}`);
        return {
          status: track.key === "fast" ? "failed" : "passed",
          exitCode: track.key === "fast" ? 1 : 0,
          stdout: "child output",
          stderr: track.key === "fast" ? "primary failure" : "",
          report: { ok: track.key !== "fast" },
        };
      },
      async captureTerminal(track) {
        calls.push(`terminal:${track.key}`);
        return {
          ok: track.key !== "fast",
          facts: { route: "#/result/failure" },
          reason:
            track.key === "fast" ? "terminal route is not recoverable" : null,
        };
      },
      async recover(track) {
        calls.push(`recover:${track.key}`);
        return { ok: true, actions: ["returnToCatalog"] };
      },
    });

    assert.deepEqual(calls, [
      "run:fast",
      "terminal:fast",
      "recover:fast",
      "run:scanner",
      "terminal:scanner",
      "recover:scanner",
    ]);
    assert.equal(result[0].businessStatus, "failed");
    assert.equal(result[0].failureStage, "child");
    assert.equal(result[0].terminal.ok, false);
    assert.equal(result[0].handoffRecovery.ok, true);
    assert.equal(result[1].businessStatus, "passed");
    assert.equal(result[1].durationMs, 1_000);
    assert.equal(result[1].handoffRecovery.durationMs, 1_000);
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
    const calls = [];
    const result = await runSerialTrackLifecycle({
      tracks: FULL_WORKFLOW_TRACK_DESCRIPTORS.slice(0, 2),
      beforeTrack(track) {
        calls.push(`preflight:${track.key}`);
        if (track.key === "fast") throw new Error("ready file was rotating");
      },
      runTrack(track) {
        calls.push(`run:${track.key}`);
        return { status: "passed", exitCode: 0, report: { ok: true } };
      },
      captureTerminal: async () => ({ ok: true, facts: {} }),
      recover: async () => ({ ok: true, actions: [] }),
    });

    assert.deepEqual(calls, [
      "preflight:fast",
      "preflight:scanner",
      "run:scanner",
    ]);
    assert.equal(result[0].businessStatus, "failed");
    assert.match(result[0].error, /ready file was rotating/);
    assert.equal(result[1].businessStatus, "passed");
  });

  it("uses the production stock maintenance task to restore fixture slots before a track", async () => {
    const posts = [];
    let saleViewReads = 0;
    const result = await ensureFixtureStockReady({
      fixtureAllocation: {
        fast: { slotCode: "A1", onHandQty: 3 },
        scanner: { slotCode: "A2", onHandQty: 4 },
      },
      async daemonGet(path) {
        if (path === "/v1/stock/maintenance-task") {
          return {
            taskId: "stock-count-01",
            mode: "recovery_count",
            slots: [
              { slotCode: "A1", currentQuantity: 0 },
              { slotCode: "A2", currentQuantity: 1 },
              { slotCode: "A9", currentQuantity: 2 },
            ],
          };
        }
        saleViewReads += 1;
        return {
          items: [
            {
              slotCode: "A1",
              slotSalesState: saleViewReads > 1 ? "sale_ready" : "needs_count",
              saleableStock: saleViewReads > 1 ? 3 : 0,
              physicalStock: saleViewReads > 1 ? 3 : 0,
            },
            {
              slotCode: "A2",
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
            { slotCode: "A1", quantity: 3 },
            { slotCode: "A2", quantity: 4 },
            { slotCode: "A9", quantity: 2 },
          ],
        },
      },
    ]);
  });

  it("waits for the daemon stock-sync watcher to establish an acknowledged planogram", async () => {
    let taskReads = 0;
    let saleViewReads = 0;
    const result = await ensureFixtureStockReady({
      fixtureAllocation: { fast: { slotCode: "A1", onHandQty: 3 } },
      async daemonGet(path) {
        if (path === "/v1/stock/maintenance-task") {
          taskReads += 1;
          throw new Error("active acknowledged planogram is required");
        }
        saleViewReads += 1;
        return {
          items: [
            {
              slotCode: "A1",
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
      fixtureAllocation: { fast: { slotCode: "A1", onHandQty: 3 } },
      async daemonGet(path) {
        if (path === "/v1/stock/maintenance-task") {
          return {
            taskId: "stock-refill-01",
            mode: "routine_refill",
            slots: [
              { slotCode: "A1", currentQuantity: 2 },
              { slotCode: "A2", currentQuantity: 3 },
            ],
          };
        }
        saleViewReads += 1;
        return {
          items: [
            {
              slotCode: "A1",
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
    assert.deepEqual(posts[0].body.slots, [{ slotCode: "A1", addition: 1 }]);
  });

  it("uses physical stock attestation when fixture quantities are full but sales state is frozen", async () => {
    const posts = [];
    let saleViewReads = 0;
    const result = await ensureFixtureStockReady({
      fixtureAllocation: { fast: { slotCode: "A1", onHandQty: 3 } },
      async daemonGet(path) {
        if (path === "/v1/stock/maintenance-task") {
          return {
            taskId: "stock-refill-01",
            mode: "routine_refill",
            slots: [{ slotCode: "A1", currentQuantity: 3 }],
          };
        }
        saleViewReads += 1;
        return {
          planogramVersion: "PLAN-01",
          items: [
            {
              slotId: "slot-01",
              slotCode: "A1",
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
        slotCode: "A1",
        sku: "SKU-01",
        quantity: 3,
        enabled: true,
      },
    ]);
  });

  it("skips stock maintenance when every fixture slot is already sale-ready", async () => {
    let postCount = 0;
    const result = await ensureFixtureStockReady({
      fixtureAllocation: { fast: { slotCode: "A1", onHandQty: 3 } },
      daemonGet: async () => ({
        items: [
          {
            slotCode: "A1",
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

  it("reports payment cancellation failure when the payment-cancel control is disabled", async () => {
    await assert.rejects(
      returnToCatalogFromClient({
        client: { id: "client" },
        evaluateExpressionFn: async () => "#/payment",
        activateVisibleSelectorFn: async () => {
          throw new Error("payment-cancel control is disabled");
        },
        waitForRouteFn: async () => ({ route: "#/catalog" }),
      }),
      /payment-cancel control is disabled/,
    );
  });
});
