import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  parseDaemonPayload,
  parseServiceApiEnvelope,
  parseStockMaintenanceGuestArgs,
  validateStockMaintenanceReport,
} from "./stock-maintenance-guest-full.mjs";

function report() {
  return {
    schemaVersion: "vem-stock-maintenance-guest-full/v1",
    ok: true,
    runId: "RUN-STOCK-1",
    fixture: {
      slotDisplayLabel: "B2",
      sku: "TSC-LOCAL-007",
      slotId: "550e8400-e29b-41d4-a716-446655440007",
      inventoryId: "inventory-stock-1",
      initialQuantity: 1,
    },
    movementCursor: {
      inventoryId: "inventory-stock-1",
      capturedAt: "2026-07-22T00:00:00.000Z",
      baselineItemIds: ["movement-before-1"],
    },
    firstSale: {
      runId: "RUN-STOCK-1",
      orderId: "order-stock-1",
      paymentId: "payment-stock-1",
      paymentNo: "PAY-STOCK-1",
      commandId: "command-stock-1",
      commandNo: "COMMAND-STOCK-1",
      fulfillmentMovementId: "sale-movement-1",
      controlPlaneSessionId: "session-stock-1",
      serialSessionId: "serial-stock-1",
      resultRoute: "#/result/success",
      gateCleanup: { paymentGateOpen: true, serialSessionInactive: true },
    },
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
      projection: {
        taskStatus: "complete",
        slotSyncStatus: "accepted",
        movementId: "refill-task-1:550e8400-e29b-41d4-a716-446655440007",
        movementType: "planned_refill",
        source: "local_maintenance",
        attributedTo: "local_operations",
        platformRawMovementId: "raw-refill-1",
      },
      platformMovement: {
        id: "refill-movement-1",
        inventoryId: "inventory-stock-1",
        reason: "hardware_sync",
        deltaQty: 2,
        taskId: "refill-task-1",
        note: "machine_stock_movement:raw-refill-1",
      },
    },
    restored: {
      daemon: {
        physicalStock: 2,
        saleableStock: 2,
        slotSalesState: "sale_ready",
      },
      platform: { onHandQty: 2, reservedQty: 0 },
    },
    secondSale: {
      runId: "RUN-STOCK-1",
      orderId: "order-stock-2",
      paymentId: "payment-stock-2",
      paymentNo: "PAY-STOCK-2",
      commandId: "command-stock-2",
      commandNo: "COMMAND-STOCK-2",
      fulfillmentMovementId: "sale-movement-2",
      controlPlaneSessionId: "session-stock-2",
      serialSessionId: "serial-stock-2",
      resultRoute: "#/result/success",
      gateCleanup: { paymentGateOpen: true, serialSessionInactive: true },
    },
    terminal: {
      daemon: {
        physicalStock: 1,
        saleableStock: 1,
        slotSalesState: "sale_ready",
      },
      platform: { onHandQty: 1, reservedQty: 0 },
      movements: {
        saleDecrementOrderIds: ["order-stock-1", "order-stock-2"],
        salePlatformMovementIds: [
          "sale-platform-movement-1",
          "sale-platform-movement-2",
        ],
        salePlatformMovements: [
          { id: "sale-platform-movement-1", orderId: "order-stock-1" },
          { id: "sale-platform-movement-2", orderId: "order-stock-2" },
        ],
        refillDeltas: [2],
      },
    },
    screenshots: {
      unavailable: {
        ref: "unavailable.png",
        route: "#/maintenance?source=operator",
        slotId: "550e8400-e29b-41d4-a716-446655440007",
        slotDisplayLabel: "B2",
      },
      refillConfirmed: {
        ref: "refill-confirmed.png",
        route: "#/maintenance?source=operator",
        slotId: "550e8400-e29b-41d4-a716-446655440007",
        slotDisplayLabel: "B2",
      },
      restoredSaleability: {
        ref: "restored.png",
        route: "#/catalog",
        slotId: "550e8400-e29b-41d4-a716-446655440007",
        slotDisplayLabel: "B2",
      },
    },
  };
}

describe("stock maintenance guest full", () => {
  it("keeps daemon bare JSON separate from the Service API success envelope", () => {
    const daemonTask = {
      taskId: "refill-task-1",
      mode: "routine_refill",
      status: "complete",
    };
    assert.deepEqual(parseDaemonPayload(daemonTask), daemonTask);
    assert.throws(
      () => parseDaemonPayload({ code: 0, data: daemonTask }),
      /bare JSON/,
    );

    assert.deepEqual(parseServiceApiEnvelope({ code: 0, data: daemonTask }), {
      taskId: "refill-task-1",
      mode: "routine_refill",
      status: "complete",
    });
    assert.throws(
      () => parseServiceApiEnvelope(daemonTask),
      /success envelope/,
    );
  });

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
      slotDisplayLabel: "B2",
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

  it("rejects a refill report without the accepted task projection identity", () => {
    const incomplete = report();
    incomplete.maintenance.projection = null;
    assert.throws(
      () => validateStockMaintenanceReport(incomplete),
      /task projection/,
    );
  });

  it("requires the maintenance projection to retain movement attribution", () => {
    const incomplete = report();
    delete incomplete.maintenance.projection.attributedTo;
    assert.throws(
      () => validateStockMaintenanceReport(incomplete),
      /task projection/,
    );
  });

  it("requires exactly three post-cursor platform movements bound to the task and both sales", () => {
    for (const invalid of [
      (value) => value.movementCursor.baselineItemIds.push("refill-movement-1"),
      (value) =>
        value.movementCursor.baselineItemIds.push("sale-platform-movement-1"),
      (value) => {
        value.terminal.movements.salePlatformMovements[1].id =
          "refill-movement-1";
      },
      (value) => {
        value.maintenance.platformMovement.taskId = "other-task";
      },
      (value) => {
        value.maintenance.platformMovement.note =
          "machine_stock_movement:other-raw-movement";
      },
      (value) => {
        value.terminal.movements.salePlatformMovements[1].orderId =
          "other-order";
      },
    ]) {
      const invalidReport = report();
      invalid(invalidReport);
      assert.throws(
        () => validateStockMaintenanceReport(invalidReport),
        /1-to-0-to-2-to-1 evidence/,
      );
    }
  });
});
