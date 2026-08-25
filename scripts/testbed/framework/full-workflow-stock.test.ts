import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ensureFixtureStockReady } from "../full-workflow-orchestrator.ts";

describe("full workflow stock preparation", () => {
  it("submits the active slot identity when a warm run replaced fixture UUIDs", async () => {
    let stockReady = false;
    const posts: Array<{ path: string; body: unknown }> = [];
    const saleView = () => ({
      planogramVersion: "LOCAL-TESTBED-CURRENT",
      items: [
        {
          slotId: "current-slot",
          rowNo: 1,
          cellNo: 1,
          sku: "TSC-LOCAL-002",
          physicalStock: stockReady ? 3 : 1,
          saleableStock: stockReady ? 3 : 1,
          slotSalesState: "sale_ready",
        },
      ],
    });

    await ensureFixtureStockReady({
      fixtureAllocation: {
        sale: {
          slotId: "stale-allocated-slot",
          rowNo: 1,
          cellNo: 1,
          sku: "TSC-LOCAL-002",
          onHandQty: 3,
        },
      },
      daemonGet: async (path) => {
        if (path === "/v1/sale-view") return saleView();
        if (path === "/v1/stock/maintenance-task") {
          return {
            taskId: "refill-1",
            mode: "routine_refill",
            status: "available",
            slots: [{ slotId: "current-slot", currentQuantity: 1 }],
          };
        }
        throw new Error(`unexpected GET ${path}`);
      },
      daemonPost: async (path, body) => {
        posts.push({ path, body });
        stockReady = true;
        return { ok: true };
      },
      timeoutMs: 100,
      pollMs: 1,
    });

    assert.deepEqual(posts, [
      {
        path: "/v1/stock/maintenance-task",
        body: {
          taskId: "refill-1",
          mode: "routine_refill",
          slots: [{ slotId: "current-slot", addition: 2 }],
        },
      },
    ]);
  });
});
