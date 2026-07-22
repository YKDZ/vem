import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseStockMaintenanceGuestArgs,
  validateStockMaintenanceReport,
} from "./stock-maintenance-guest-full.mjs";

function report() {
  return {
    schemaVersion: "vem-stock-maintenance-guest-full/v1",
    ok: true,
    fixture: {
      slotCode: "B2",
      sku: "TSC-LOCAL-007",
      inventoryId: "inventory-stock-1",
      initialQuantity: 1,
    },
    firstSale: { orderId: "order-stock-1" },
    unavailable: {
      daemon: {
        physicalStock: 0,
        saleableStock: 0,
        slotSalesState: "out_of_stock",
      },
      platform: { onHandQty: 0, reservedQty: 0 },
    },
    maintenance: {
      taskId: "refill-task-1",
      addition: 2,
      previewQuantity: 2,
      refillMovementCount: 1,
    },
    restored: {
      daemon: {
        physicalStock: 2,
        saleableStock: 2,
        slotSalesState: "sale_ready",
      },
      platform: { onHandQty: 2, reservedQty: 0 },
    },
    secondSale: { orderId: "order-stock-2" },
    terminal: {
      daemon: {
        physicalStock: 1,
        saleableStock: 1,
        slotSalesState: "sale_ready",
      },
      platform: { onHandQty: 1, reservedQty: 0 },
      movements: {
        saleDecrementOrderIds: ["order-stock-1", "order-stock-2"],
        refillDeltas: [2],
      },
    },
    screenshots: {
      unavailable: { ref: "unavailable.png" },
      refillConfirmed: { ref: "refill-confirmed.png" },
      restoredSaleability: { ref: "restored.png" },
    },
  };
}

describe("stock maintenance guest full", () => {
  it("parses the installed guest runner contract", () => {
    assert.equal(
      parseStockMaintenanceGuestArgs([
        "--mode",
        "full",
        "--guest-input",
        "C:\\guest-input.json",
        "--handoff",
        "C:\\handoff.json",
        "--out",
        "C:\\out.json",
        "--fixture-key",
        "stockMaintenance",
      ]).fixtureKey,
      "stockMaintenance",
    );
  });

  it("requires two identity-correlated sale decrements and one +2 refill", () => {
    assert.deepEqual(validateStockMaintenanceReport(report()), {
      slotCode: "B2",
      firstOrderId: "order-stock-1",
      secondOrderId: "order-stock-2",
    });
    const missingScreenshot = report();
    missingScreenshot.screenshots.refillConfirmed = null;
    assert.throws(
      () => validateStockMaintenanceReport(missingScreenshot),
      /1-to-0-to-2-to-1 evidence/,
    );
  });
});
