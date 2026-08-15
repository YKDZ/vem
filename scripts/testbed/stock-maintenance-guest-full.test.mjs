import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  admitFreshSerialSessionForSale,
  buildFastRouteStressSaleSuccessReport,
  runCleanupStep,
} from "./fast-route-stress-sale.mjs";
import {
  parseDaemonPayload,
  parseServiceApiEnvelope,
  parseStockMaintenanceGuestArgs,
  saleEvidence,
  validateStockMaintenanceReport,
} from "./stock-maintenance-guest-full.mjs";

async function producerSaleReport({
  runId = "RUN-STOCK-1",
  outerReplacementSessionId = "stock-pre-admission-session",
  freshSessionId = "producer-fresh-session",
  cleanupOverrides = {},
} = {}) {
  const guestInput = {
    runId,
    machineCode: "VEM-STOCK-1",
    hostControlPlane: {
      targetIdentity: "vm-target://stock",
      runtimeBaseIdentity: "runtime-base://stock",
    },
  };
  const handoff = {
    commissioningSerialSession: { sessionId: outerReplacementSessionId },
  };
  const controls = [];
  const control = async (_input, path) => {
    controls.push(path);
    if (path.endsWith(`/${outerReplacementSessionId}/abort`)) {
      return { aborted: true };
    }
    if (path === "/v1/serial-sessions/start")
      return { sessionId: freshSessionId };
    if (path.endsWith(`/${freshSessionId}/abort`)) {
      return { sessionId: freshSessionId, aborted: true };
    }
    throw new Error(`unexpected serial control path: ${path}`);
  };
  const admission = await admitFreshSerialSessionForSale({
    guestInput,
    handoff,
    handoffPath: "C:\\handoff.json",
    control,
    daemonGet: async () => ({ canStartSale: true }),
    armCreateOrderGate: async () => ({ state: "open" }),
    writeJsonFile: () => {},
    waitForHardwareReady: async () => ({
      lower: { ready: true },
      capability: { canStartSale: true },
    }),
  });
  const reopened = await runCleanupStep(
    "reopen payment create gate",
    async () => ({
      state: "open",
      ...cleanupOverrides.reopened,
    }),
  );
  const verified = await runCleanupStep(
    "verify payment create gate",
    async () => ({
      status: { state: "open", pending: null, ...cleanupOverrides.verified },
    }),
  );
  const aborted = await runCleanupStep("abort serial session", async () => ({
    ...(await control(
      guestInput,
      `/v1/serial-sessions/${freshSessionId}/abort`,
    )),
    ...cleanupOverrides.aborted,
  }));
  return {
    sale: buildFastRouteStressSaleSuccessReport({
      mode: "full",
      runId,
      machineCode: guestInput.machineCode,
      resultRoute: "#/result/success",
      sessionStart: admission.serialSession,
      serialStart: admission,
      summary: {
        orderId: "order-stock-1",
        paymentId: "payment-stock-1",
        paymentNo: "PAY-STOCK-1",
        vendingCommandId: "command-stock-1",
        commandNo: "COMMAND-STOCK-1",
        movementId: "sale-movement-1",
        serialSessionId: freshSessionId,
      },
      cleanup: [reopened, verified, aborted],
    }),
    controls,
  };
}

function report() {
  return {
    schemaVersion: "vem-stock-maintenance-guest-full/v1",
    ok: true,
    runId: "RUN-STOCK-1",
    handoffSerialSessionId: "session-stock-2",
    fixture: {
      slotDisplayLabel: "B2",
      sku: "TSC-LOCAL-007",
      slotId: "550e8400-e29b-41d4-a716-446655440007",
      inventoryId: "inventory-stock-1",
      catalogKey: "product:stock-product-1",
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
      handoff: {
        previousControlPlaneSessionId: "stock-handoff-0",
        replacementControlPlaneSessionId: "stock-pre-admission-1",
      },
      gateCleanup: {
        paymentGateOpen: true,
        paymentGateVerified: true,
        serialSessionInactive: true,
        serialSessionId: "session-stock-1",
        freshControlPlaneSessionId: "session-stock-1",
        lowerControllerReady: true,
        saleStartReady: true,
      },
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
      visibleDetailStock: {
        route: "#/products/product:stock-product-1",
        catalogKey: "product:stock-product-1",
        variantId: "variant-stock-1",
        saleableStock: 2,
        text: "库存：2",
      },
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
      handoff: {
        previousControlPlaneSessionId: "stock-handoff-1",
        replacementControlPlaneSessionId: "stock-pre-admission-2",
      },
      gateCleanup: {
        paymentGateOpen: true,
        paymentGateVerified: true,
        serialSessionInactive: true,
        serialSessionId: "session-stock-2",
        freshControlPlaneSessionId: "session-stock-2",
        lowerControllerReady: true,
        saleStartReady: true,
      },
    },
    terminal: {
      daemon: {
        physicalStock: 1,
        saleableStock: 1,
        slotSalesState: "sale_ready",
      },
      platform: { onHandQty: 1, reservedQty: 0 },
      visibleDetailStock: {
        route: "#/products/product:stock-product-1",
        catalogKey: "product:stock-product-1",
        variantId: "variant-stock-1",
        saleableStock: 1,
        text: "库存：1",
      },
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
  it("accepts the producer's B-to-C fresh session cleanup evidence after stock handoff", async () => {
    const handoff = {
      previousControlPlaneSessionId: "stock-handoff-session",
      replacementControlPlaneSessionId: "stock-pre-admission-session",
    };
    const produced = await producerSaleReport();
    const sale = produced.sale;
    const evidence = saleEvidence(sale, "RUN-STOCK-1", handoff);

    assert.deepEqual(evidence.gateCleanup, {
      paymentGateOpen: true,
      paymentGateVerified: true,
      serialSessionInactive: true,
      serialSessionId: "producer-fresh-session",
      freshControlPlaneSessionId: "producer-fresh-session",
      lowerControllerReady: true,
      saleStartReady: true,
    });
    assert.equal(evidence.controlPlaneSessionId, "producer-fresh-session");
    assert.deepEqual(produced.controls, [
      "/v1/serial-sessions/stock-pre-admission-session/abort",
      "/v1/serial-sessions/start",
      "/v1/serial-sessions/producer-fresh-session/abort",
    ]);
  });

  it("rejects a producer report whose fresh serial admission cannot start a sale", async () => {
    const handoff = {
      previousControlPlaneSessionId: "stock-handoff-session",
      replacementControlPlaneSessionId: "stock-pre-admission-session",
    };
    const { sale } = await producerSaleReport();
    sale.serial.start.hardware.capability.canStartSale = false;

    assert.throws(
      () => saleEvidence(sale, "RUN-STOCK-1", handoff),
      /independent session cleanup evidence/,
    );
  });

  it("rejects cleanup evidence with a mismatched session or missing required label", async () => {
    const handoff = {
      previousControlPlaneSessionId: "stock-handoff-session",
      replacementControlPlaneSessionId: "stock-pre-admission-session",
    };
    for (const mutate of [
      async (sale) => {
        sale.cleanup[2].detail.aborted = false;
      },
      async (sale) => {
        sale.runId = "RUN-OTHER";
      },
      async (sale) => {
        sale.handoffSerialSessionId = "other-session";
      },
      async (sale) => {
        sale.cleanup = sale.cleanup.filter(
          (step) => step.label !== "reopen payment create gate",
        );
      },
      async (sale) => {
        sale.cleanup = sale.cleanup.filter(
          (step) => step.label !== "verify payment create gate",
        );
      },
      async (sale) => {
        sale.serial.start.serialSession.sessionId = "other-session";
      },
      async (sale) => {
        sale.serial.start.hardware.lower.ready = false;
      },
      async (sale) => {
        sale.controlPlaneSessionId = "stock-pre-admission-session";
      },
    ]) {
      const produced = await producerSaleReport();
      const sale = produced.sale;
      await mutate(sale);
      assert.throws(
        () => saleEvidence(sale, "RUN-STOCK-1", handoff),
        /independent session cleanup evidence/,
      );
    }
  });

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

  it("allows the maintenance route while waiting for the operator return to catalog", () => {
    const source = readFileSync(
      new URL("./stock-maintenance-guest-full.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /async function returnToCatalogFromMaintenance[\s\S]*waitForRoute\(client, "#\/catalog"[\s\S]*forbiddenRoutes: \[\]/,
    );
  });

  it("sets the refill input through the installed UI input path before submitting", () => {
    const source = readFileSync(
      new URL("./stock-maintenance-guest-full.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /async function enterRoutineRefill[\s\S]*element\.value = "";[\s\S]*dispatchEvent\(new Event\("input", \{ bubbles: true \}\)\)/,
    );
    assert.match(
      source,
      /async function enterRoutineRefill[\s\S]*Input\.insertText[\s\S]*stock-maintenance-submit/,
    );
  });

  it("returns the customer result page to Catalog before opening stock maintenance", () => {
    const source = readFileSync(
      new URL("./stock-maintenance-guest-full.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /client = await connectUi\(handoff\);\s*await returnCustomerResultToCatalog\(client\);\s*await openStockMaintenance\(client\);/,
    );
  });

  it("primes a real Catalog touch session before each stock sale child flow", () => {
    const source = readFileSync(
      new URL("./stock-maintenance-guest-full.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /async function primeCatalogTouchSession/);
    assert.match(
      source,
      /activateVisibleSelector\(client, "\[data-test='catalog-page'\]"/,
    );
    assert.match(
      source,
      /await returnCustomerResultToCatalog\(client\);\s*await primeCatalogTouchSession\(client\);/,
    );
    assert.match(
      source,
      /await primeCatalogTouchSession\(client\);\s*await client\.close\(\);\s*client = null;\s*await openPaymentCreateGate\(input\);\s*const second = await runSale/,
    );
    assert.doesNotMatch(
      source,
      /touchscreenSessionActive\s*===\s*true\)\s*return boundary/,
    );
    assert.equal(
      source.match(/await openPaymentCreateGate\(input\);/g)?.length,
      2,
    );
    assert.match(source, /"--scenario",\s*"sale-only"/);
    assert.match(source, /reportError\.slice\(0, 2_048\)/);
  });

  it("verifies restored saleability through the category detail flow", () => {
    const source = readFileSync(
      new URL("./stock-maintenance-guest-full.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /await returnToCatalogFromMaintenance\(client\);\s*report\.restored\.visibleDetailStock = await observeProductDetailStock\(/,
    );
    assert.doesNotMatch(source, /visible restored fixture saleability/);
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

  it("rejects persisted stock evidence that loses the exact cleanup session", () => {
    const incomplete = report();
    incomplete.secondSale.gateCleanup.serialSessionId = "other-session";
    assert.throws(
      () => validateStockMaintenanceReport(incomplete),
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
