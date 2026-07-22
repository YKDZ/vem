import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { describe, it } from "node:test";

import {
  buildFastRouteStressSaleFailureReport,
  buildFastRouteStressScenarioSteps,
  combineCleanupError,
  dispatchRepeatedPaymentTouch,
  parseFastRouteStressSaleArgs,
  runCleanupStep,
  settlePendingCreateOrder,
  shutdownControlledVisionMock,
  startContinuousCdpLocationHashObservation,
  waitForSaleStartReady,
  waitForGuardedVisionDepartureTrace,
  validateFastRouteStressSaleEvidence,
} from "./fast-route-stress-sale.mjs";

async function listenOnAvailablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to allocate a TCP port");
  }
  return { server, port: address.port };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("controlled vision mock shutdown", () => {
  it("forces an unresponsive child to exit and fails when it remains alive", async () => {
    const child = new EventEmitter();
    child.exitCode = null;
    const signals = [];
    child.kill = (signal) => {
      signals.push(signal);
      return true;
    };

    await assert.rejects(
      () => shutdownControlledVisionMock(child, 10, 0),
      /did not exit/,
    );
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  });

  it("fails when the Vision port cannot be rebound after the child exits", async () => {
    const { server, port } = await listenOnAvailablePort();
    const child = new EventEmitter();
    child.exitCode = null;
    child.kill = () => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
      return true;
    };

    try {
      await assert.rejects(
        () => shutdownControlledVisionMock(child, 100, port),
        new RegExp(`did not release port ${port}`),
      );
    } finally {
      await closeServer(server);
    }
  });
});

describe("pending create-order cleanup", () => {
  it("cancels the correlated active transaction and waits for terminal state", async () => {
    const reads = [
      null,
      {
        paymentNo: "PAY-1",
        orderNo: "ORD-1",
        orderStatus: "pending_payment",
        nextAction: "wait_payment",
      },
      {
        paymentNo: "PAY-1",
        orderNo: "ORD-1",
        orderStatus: "canceled",
        nextAction: "closed",
      },
    ];
    const canceled = [];
    let clock = 0;
    const result = await settlePendingCreateOrder({
      paymentNo: "PAY-1",
      readTransaction: async () => (reads.length > 0 ? reads.shift() : null),
      cancelTransaction: async (transaction) =>
        canceled.push(transaction.orderNo),
      wait: async () => undefined,
      now: () => clock++,
    });

    assert.equal(result.orderStatus, "canceled");
    assert.deepEqual(canceled, ["ORD-1"]);
  });
});

function validEvidence() {
  const inventory = {
    id: "inventory-1",
    slotId: "slot-1",
    onHandQty: 3,
    reservedQty: 0,
  };
  const baselineRaw = {
    orders: [],
    orderItems: [],
    payments: [],
    commands: [],
    movements: [],
    inventories: [inventory],
  };
  const beforeF0Raw = {
    orders: [
      {
        id: "order-1",
        orderNo: "ORD-1",
        status: "dispensing",
        paymentState: "paid",
        fulfillmentState: "dispensing",
      },
    ],
    orderItems: [
      {
        id: "item-1",
        orderId: "order-1",
        inventoryId: "inventory-1",
        slotId: "slot-1",
        quantity: 1,
      },
    ],
    payments: [
      {
        id: "payment-1",
        orderId: "order-1",
        paymentNo: "PAY-1",
        status: "succeeded",
      },
    ],
    commands: [
      {
        id: "command-1",
        commandNo: "CMD-1",
        orderId: "order-1",
        orderItemId: "item-1",
        slotId: "slot-1",
        commandKind: "dispatch",
        status: "sent",
      },
    ],
    movements: [],
    inventories: [inventory],
  };
  const inFlightRaw = structuredClone(beforeF0Raw);
  const platformReport = (raw, capturedAt) => ({
    source: "authoritative_ephemeral_platform_database",
    capturedAt,
    scope: { machineCode: "VEM-TESTBED-LOCAL", machineId: "machine-1" },
    raw,
  });
  const rawFrame = (sequence, parsedOpcode, capturedAt) => ({
    sequence,
    direction:
      parsedOpcode === "VEND" ? "daemon-to-controller" : "controller-to-daemon",
    rawFrameHex: parsedOpcode === "VEND" ? "55020531" : `55${parsedOpcode}`,
    opcode: parsedOpcode === "VEND" ? 2 : Number.parseInt(parsedOpcode, 16),
    parsedOpcode,
    capturedAt,
    sessionId: "serial-session-1",
    boundaryId: `host-pty:serial-session-1:${sequence}`,
    provenance: "host_pty_raw_serial_journal",
  });
  return {
    saleCorrelationId: "sale-1",
    controlPlaneSessionId: "fast-sale-session-1",
    machineCode: "VEM-TESTBED-LOCAL",
    renderedSale: {
      orderId: "order-1",
      paymentId: "payment-1",
      orderNo: "ORD-1",
    },
    liveSale: {
      orderId: "order-1",
      paymentId: "payment-1",
      orderNo: "ORD-1",
      vendingCommandId: "command-1",
    },
    createOrderGate: {
      controlPlane: "mock-payment-create-gate",
      armedAt: "2026-07-18T03:59:59.800Z",
      paymentNo: "PAY-1",
      pendingObservedAt: "2026-07-18T03:59:59.900Z",
      releasedAt: "2026-07-18T04:00:00.200Z",
    },
    saleStartCapability: {
      revision: 7,
      canStartSale: true,
      paymentOptions: {
        options: [
          {
            optionKey: "mock:mock",
            providerCode: "mock",
            method: "mock",
            ready: true,
            disabledReason: null,
          },
        ],
      },
    },
    uiViewport: {
      innerWidth: 1080,
      innerHeight: 1920,
      documentClientWidth: 1080,
      documentClientHeight: 1920,
      visualViewportWidth: 1080,
      visualViewportHeight: 1920,
    },
    platform: {
      baseline: platformReport(baselineRaw, "2026-07-18T03:59:59.500Z"),
      beforeF0: platformReport(beforeF0Raw, "2026-07-18T04:00:00.900Z"),
      afterF1BeforeF2: platformReport(inFlightRaw, "2026-07-18T04:00:02.500Z"),
      afterF2: platformReport(
        {
          ...inFlightRaw,
          orders: [
            {
              ...inFlightRaw.orders[0],
              status: "fulfilled",
              fulfillmentState: "dispensed",
            },
          ],
          commands: [{ ...inFlightRaw.commands[0], status: "succeeded" }],
          movements: [
            {
              id: "movement-1",
              orderItemId: "item-1",
              orderNo: "ORD-1",
              commandNo: "CMD-1",
              inventoryId: "inventory-1",
              slotId: "slot-1",
              quantity: 1,
            },
          ],
          inventories: [{ ...inventory, onHandQty: 2 }],
        },
        "2026-07-18T04:00:04.500Z",
      ),
    },
    daemon: {
      baseline: {
        items: [
          {
            inventoryId: "inventory-1",
            slotId: "slot-1",
            slotDisplayLabel: "R2C5",
            rowNo: 2,
            cellNo: 5,
            physicalStock: 3,
            saleableStock: 3,
          },
        ],
      },
      beforeF0: {
        items: [
          {
            inventoryId: "inventory-1",
            slotId: "slot-1",
            slotDisplayLabel: "R2C5",
            rowNo: 2,
            cellNo: 5,
            physicalStock: 3,
            saleableStock: 2,
          },
        ],
      },
      afterF1BeforeF2: {
        items: [
          {
            inventoryId: "inventory-1",
            slotId: "slot-1",
            slotDisplayLabel: "R2C5",
            rowNo: 2,
            cellNo: 5,
            physicalStock: 3,
            saleableStock: 2,
          },
        ],
      },
      afterF2: {
        items: [
          {
            inventoryId: "inventory-1",
            slotId: "slot-1",
            slotDisplayLabel: "R2C5",
            rowNo: 2,
            cellNo: 5,
            physicalStock: 2,
            saleableStock: 2,
          },
        ],
      },
    },
    ui: {
      beforeF0: { route: "#/payment", result: null },
      afterF1BeforeF2: { route: "#/dispensing", result: null },
      afterF2: {
        route: "#/result/success",
        result: {
          kind: "success",
          orderId: "order-1",
          paymentId: "payment-1",
          orderNo: "ORD-1",
          commandId: "command-1",
        },
      },
    },
    visionDelivery: {
      ok: true,
      eventId: "departure-event-1",
      timestamp: "2026-07-18T04:00:00.000Z",
      requestedAt: "2026-07-18T04:00:00.000Z",
      completedAt: "2026-07-18T04:00:00.050Z",
      connectedRuntimeClients: 1,
      acceptedDeliveries: 1,
    },
    noCatalogTraceBoundary: {
      source: "installed_machine_runtime_trace_cdp",
      entryCount: 0,
      capturedAt: "2026-07-18T03:59:59.700Z",
    },
    repeatedPaymentTouch: {
      traceEntryId: 3,
      pendingConfirmedAt: "2026-07-18T03:59:59.900Z",
      releaseRequestedAt: "2026-07-18T04:00:00.200Z",
      preDispatchTraceBoundary: {
        source: "installed_machine_runtime_trace_cdp",
        entryCount: 2,
        capturedAt: "2026-07-18T04:00:00.110Z",
      },
    },
    continuousCdpLocationHash: {
      source: "cdp_page_navigation_events_and_location_hash",
      startedAt: "2026-07-18T03:59:59.700Z",
      initialHash: "#/catalog",
      armedAt: "2026-07-18T03:59:59.710Z",
      terminalAt: "2026-07-18T04:00:04.010Z",
      terminalHash: "#/result/success",
      entries: [
        {
          sequence: 1,
          method: "Page.navigatedWithinDocument",
          locationHash: "#/products/product-1",
          observedAt: "2026-07-18T03:59:59.710Z",
        },
        {
          sequence: 2,
          method: "Page.navigatedWithinDocument",
          locationHash: "#/checkout",
          observedAt: "2026-07-18T03:59:59.800Z",
        },
        {
          sequence: 3,
          method: "Page.navigatedWithinDocument",
          locationHash: "#/payment",
          observedAt: "2026-07-18T04:00:00.150Z",
        },
        {
          sequence: 4,
          method: "Page.navigatedWithinDocument",
          locationHash: "#/result/success",
          observedAt: "2026-07-18T04:00:04.000Z",
        },
      ],
    },
    machineRuntimeTrace: {
      source: "installed_machine_runtime_trace_cdp",
      capturedAt: "2026-07-18T04:00:04.100Z",
      entries: [
        {
          type: "navigation",
          id: 1,
          intentType: "customer.touch",
          decision: "accepted",
          reasonCode: "touchscreen_session_renewed",
          fromRoute: "#/checkout",
          decidedRoute: null,
          finalRoute: null,
          targetRoute: null,
          at: "2026-07-18T03:59:59.850Z",
        },
        {
          type: "navigation",
          id: 2,
          intentType: "presence.departed",
          sourceEventId: "departure-event-1",
          decision: "rejected",
          reasonCode: "touchscreen_session_active",
          fromRoute: "#/checkout",
          finalRoute: "#/checkout",
          at: "2026-07-18T04:00:00.100Z",
        },
        {
          type: "navigation",
          id: 3,
          intentType: "customer.touch",
          decision: "accepted",
          reasonCode: "touchscreen_session_renewed",
          fromRoute: "#/checkout",
          decidedRoute: null,
          finalRoute: null,
          targetRoute: null,
          at: "2026-07-18T04:00:00.125Z",
        },
        {
          type: "navigation",
          id: 4,
          intentType: "transaction.projection",
          decision: "accepted",
          reasonCode: "transaction_projection",
          fromRoute: "#/checkout",
          finalRoute: "#/payment",
          at: "2026-07-18T04:00:00.150Z",
          transactionOrderNo: "ORD-1",
        },
        {
          type: "transaction_surface",
          id: 5,
          at: "2026-07-18T04:00:04.000Z",
          recordedAt: "2026-07-18T04:00:04.000Z",
          route: "#/result/success",
          stage: "result",
          orderId: "order-1",
          paymentId: "payment-1",
          orderNo: "ORD-1",
          commandId: "command-1",
          resultKind: "success",
          resultDisplayIntent: "success",
        },
      ],
    },
    mqttMessages: [
      {
        topic: "vem/machines/VEM-TESTBED-LOCAL/commands/dispense",
        payload: {
          messageId: "command:CMD-1",
          machineCode: "VEM-TESTBED-LOCAL",
          payload: {
            commandNo: "CMD-1",
            orderNo: "ORD-1",
            slot: { slotDisplayLabel: "R2C5", rowNo: 2, cellNo: 5 },
            quantity: 1,
          },
        },
      },
    ],
    serial: {
      sessionId: "serial-session-1",
      rawFrames: [
        rawFrame(1, "VEND", "2026-07-18T04:00:00.950Z"),
        rawFrame(2, "F0", "2026-07-18T04:00:01.000Z"),
        rawFrame(3, "F1", "2026-07-18T04:00:02.000Z"),
        rawFrame(4, "F2", "2026-07-18T04:00:03.000Z"),
      ],
    },
  };
}

describe("fast route stress sale tracer", () => {
  it("awaits the correlated guarded Vision departure effect", async () => {
    let reads = 0;
    const result = await waitForGuardedVisionDepartureTrace(null, "vision-1", {
      timeoutMs: 100,
      sleepFn: async () => {},
      readTrace: async () => {
        reads += 1;
        return reads < 2
          ? []
          : [
              {
                type: "navigation",
                intentType: "presence.departed",
                sourceEventId: "vision-1",
                decision: "rejected",
                reasonCode: "active_transaction_route",
                finalRoute: "#/payment",
              },
            ];
      },
    });
    assert.equal(result.sourceEventId, "vision-1");
    assert.equal(reads, 2);
  });

  it("waits for the guarded Vision departure after its stability window", async () => {
    let elapsedMs = 0;
    const result = await waitForGuardedVisionDepartureTrace(null, "vision-1", {
      now: () => elapsedMs,
      sleepFn: async (delayMs) => {
        elapsedMs += delayMs;
      },
      readTrace: async () =>
        elapsedMs < 10_000
          ? []
          : [
              {
                type: "navigation",
                intentType: "presence.departed",
                sourceEventId: "vision-1",
                decision: "rejected",
                reasonCode: "active_transaction_route",
                finalRoute: "#/payment",
              },
            ],
    });

    assert.equal(result.sourceEventId, "vision-1");
    assert.equal(elapsedMs, 10_000);
  });

  it("parses a guest-local tracer contract with handoff and guest input evidence", () => {
    const options = parseFastRouteStressSaleArgs([
      "--mode",
      "fast",
      "--guest-input",
      "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      "--handoff",
      "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
      "--out",
      "C:\\ProgramData\\VEM\\testbed\\fast-route-stress-sale.json",
    ]);

    assert.equal(options.mode, "fast");
    assert.equal(
      options.guestInputPath,
      "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
    );
    assert.equal(
      options.handoffPath,
      "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
    );
  });

  it("drives only physical touch navigation and repeats checkout submit during payment creation", () => {
    const steps = buildFastRouteStressScenarioSteps();
    assert.deepEqual(
      steps.map((step) => step.name),
      [
        "catalog category",
        "catalog product",
        "buy",
        "payment option",
        "payment submit",
        "payment submit repeat",
      ],
    );
    assert.equal(
      steps.every((step) => step.type === "customer-activation"),
      true,
    );
    assert.equal(
      steps.every((step) => (step.inputKind ?? "touch") === "touch"),
      true,
    );
  });

  it("dispatches the repeated payment touch at the original coordinates after DOM disablement", async () => {
    const calls = [];
    const client = {
      async send(method, params) {
        calls.push({ method, params });
        return {};
      },
    };
    const result = await dispatchRepeatedPaymentTouch(client, {
      center: { x: 412.5, y: 1711.25 },
    });

    assert.deepEqual(
      calls.map(({ method, params }) => ({
        method,
        type: params.type,
        point: params.touchPoints[0] ?? null,
      })),
      [
        {
          method: "Input.dispatchTouchEvent",
          type: "touchStart",
          point: { x: 412.5, y: 1711.25, radiusX: 1, radiusY: 1, force: 1 },
        },
        {
          method: "Input.dispatchTouchEvent",
          type: "touchEnd",
          point: null,
        },
      ],
    );
    assert.deepEqual(result.originalPoint, { x: 412.5, y: 1711.25 });
  });

  it("waits for sale readiness and a stable Catalog before observing customer navigation", async () => {
    let nowMs = 0;
    let sample = 0;
    const capability = { canStartSale: true, revision: 7 };
    const result = await waitForSaleStartReady({}, {}, 5_000, {
      now: () => nowMs,
      readRoute: async () => {
        sample += 1;
        return sample === 1
          ? "#/catalog"
          : sample === 2
            ? "#/boot"
            : "#/catalog";
      },
      readCapability: async () =>
        sample < 3 ? { canStartSale: false } : capability,
      wait: async (durationMs) => {
        nowMs += durationMs;
      },
    });

    assert.equal(result, capability);
    assert.ok(sample >= 7);
  });

  it("captures root as the first CDP transition away from Catalog without runtime trace input", async () => {
    const handlers = new Map();
    let locationHash = "#/catalog";
    let tick = 0;
    const client = {
      on(method, handler) {
        handlers.set(method, handler);
        return () => handlers.delete(method);
      },
      async send(method) {
        assert.equal(method, "Runtime.evaluate");
        return { result: { value: locationHash } };
      },
    };
    const observer = await startContinuousCdpLocationHashObservation(client, {
      clock: () => new Date(1_000 + tick++),
    });

    handlers.get("Page.navigatedWithinDocument")({
      url: "http://tauri.localhost/",
    });
    locationHash = "#/result/success";

    assert.throws(
      () => observer.throwIfFailed(),
      /continuous CDP location\.hash observation reached Catalog or root/,
    );
    assert.deepEqual(
      observer.snapshot().entries.map((entry) => entry.locationHash),
      [""],
    );
    observer.stop();
  });

  it("accepts exactly one fully correlated sale across real temporal boundaries", () => {
    const summary = validateFastRouteStressSaleEvidence(validEvidence());
    assert.deepEqual(summary.protocol, ["VEND", "F0", "F1", "F2"]);
    assert.equal(summary.orderNo, "ORD-1");
    assert.equal(summary.commandNo, "CMD-1");
    assert.equal(summary.slotDisplayLabel, "R2C5");
    assert.equal(summary.platformStockDeltaAfterF2, -1);
    assert.equal(summary.daemonStockDeltaAfterF2, -1);
    assert.equal(summary.saleStartCapabilityRevision, 7);
    assert.equal(summary.projectionRefreshReason, "transaction_projection");
    assert.equal(summary.projectionRefreshRoute, "#/payment");
    assert.equal(summary.repeatedPhysicalTouchTraceId, 3);
    assert.equal(summary.repeatedPhysicalTouchAt, "2026-07-18T04:00:00.125Z");
    assert.deepEqual(summary.uiViewport, { width: 1080, height: 1920 });
    assert.deepEqual(summary.runtimeTraceCorrelation.rawFrames, [
      {
        parsedOpcode: "F0",
        rawFrameHex: "55F0",
        capturedAt: "2026-07-18T04:00:01.000Z",
        boundaryId: "host-pty:serial-session-1:2",
        sessionId: "serial-session-1",
        provenance: "host_pty_raw_serial_journal",
      },
      {
        parsedOpcode: "F1",
        rawFrameHex: "55F1",
        capturedAt: "2026-07-18T04:00:02.000Z",
        boundaryId: "host-pty:serial-session-1:3",
        sessionId: "serial-session-1",
        provenance: "host_pty_raw_serial_journal",
      },
      {
        parsedOpcode: "F2",
        rawFrameHex: "55F2",
        capturedAt: "2026-07-18T04:00:03.000Z",
        boundaryId: "host-pty:serial-session-1:4",
        sessionId: "serial-session-1",
        provenance: "host_pty_raw_serial_journal",
      },
    ]);
  });

  it("accepts consecutive repeated lower-controller status reports", () => {
    const evidence = validEvidence();
    const [vend, f0, f1, f2] = evidence.serial.rawFrames;
    evidence.serial.rawFrames = [
      vend,
      f0,
      { ...f0, capturedAt: "2026-07-18T04:00:01.100Z" },
      f1,
      { ...f1, capturedAt: "2026-07-18T04:00:02.100Z" },
      f2,
      { ...f2, capturedAt: "2026-07-18T04:00:03.100Z" },
    ];

    const summary = validateFastRouteStressSaleEvidence(evidence);

    assert.deepEqual(summary.protocol, ["VEND", "F0", "F1", "F2"]);
  });

  it("fails closed when raw serial direction/order is inferred from semantic event names", () => {
    const evidence = validEvidence();
    evidence.serial.rawFrames[0] = {
      ...evidence.serial.rawFrames[0],
      parsedOpcode: "F0",
    };
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /raw serial frame 1 F0 must match the 2-byte production frame 55 F0/,
    );
  });

  it("fails closed when the raw inbound production bytes are not exact 55 F0/F1/F2 frames", () => {
    const evidence = validEvidence();
    evidence.serial.rawFrames[1] = {
      ...evidence.serial.rawFrames[1],
      rawFrameHex: "55F000",
    };
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /raw serial frame 2 F0 must match the 2-byte production frame 55 F0/,
    );
  });

  it("fails closed on success UI or stock movement before inbound F2", () => {
    const evidence = validEvidence();
    evidence.ui.afterF1BeforeF2.result = { kind: "success" };
    evidence.platform.afterF1BeforeF2.raw.inventories[0].onHandQty = 2;
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /UI must not show success before inbound F2/,
    );
  });

  it("fails closed when the installed UI viewport is not exact 1080x1920 portrait", () => {
    const evidence = validEvidence();
    evidence.uiViewport.innerHeight = 1080;
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /installed UI viewport must be exactly 1080x1920/,
    );
  });

  it("fails closed when sale-start-capability does not expose the ready mock option", () => {
    const evidence = validEvidence();
    evidence.saleStartCapability.paymentOptions.options = [];
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /sale-start-capability must expose a ready mock:mock payment option/,
    );
  });

  it("fails closed when Vision departure has no accepted installed-runtime delivery or guarded trace", () => {
    const evidence = validEvidence();
    evidence.visionDelivery.connectedRuntimeClients = 0;
    evidence.visionDelivery.acceptedDeliveries = 0;
    evidence.machineRuntimeTrace.entries = [];
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /Vision departure requires a connected installed runtime client/,
    );
  });

  it("fails closed when runtime trace does not bind the exact departed eventId", () => {
    const evidence = validEvidence();
    evidence.machineRuntimeTrace.entries.find(
      (entry) => entry.intentType === "presence.departed",
    ).sourceEventId = "departure-event-other";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /guarded Vision departure navigation effect for the accepted eventId/,
    );
  });

  it("fails closed when Vision departure is not anchored inside the gated pending payment creation interval", () => {
    const evidence = validEvidence();
    evidence.repeatedPaymentTouch.releaseRequestedAt =
      "2026-07-18T03:59:59.950Z";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /Vision departure must occur while payment creation is explicitly pending/,
    );
  });

  it("fails closed when the repeated physical touch has no installed-runtime trace after its pre-dispatch boundary", () => {
    const evidence = validEvidence();
    evidence.machineRuntimeTrace.entries =
      evidence.machineRuntimeTrace.entries.filter((entry) => entry.id !== 3);
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /repeated physical customer\.touch after its pre-dispatch boundary/,
    );
  });

  it("fails closed on a pre-Vision decided Catalog navigation after the stressed customer flow begins", () => {
    const evidence = validEvidence();
    const preVisionTouch = evidence.machineRuntimeTrace.entries.find(
      (entry) => entry.id === 1,
    );
    preVisionTouch.decidedRoute = "#/catalog";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /actual or decided Catalog navigation after the stressed customer flow began/,
    );
  });

  it("fails closed on transient Catalog or root CDP location.hash even when the runtime trace reset hides it", () => {
    for (const forbiddenHash of ["#/catalog", "", "#/"]) {
      const evidence = validEvidence();
      evidence.noCatalogTraceBoundary.entryCount = 99;
      evidence.continuousCdpLocationHash.entries.splice(2, 0, {
        sequence: 99,
        method: "Page.navigatedWithinDocument",
        locationHash: forbiddenHash,
        observedAt: "2026-07-18T04:00:00.120Z",
      });
      assert.throws(
        () => validateFastRouteStressSaleEvidence(evidence),
        /continuous CDP location\.hash observation reached Catalog or root/,
      );
    }
  });

  it("fails closed when the runtime trace has no correlated result surface", () => {
    const evidence = validEvidence();
    evidence.machineRuntimeTrace.entries =
      evidence.machineRuntimeTrace.entries.filter(
        (entry) => entry.type !== "transaction_surface",
      );
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /runtime trace must expose a correlated result surface/,
    );
  });

  it("does not compare unsynchronised Windows and host raw-journal clocks", () => {
    const evidence = validEvidence();
    const resultSurface = evidence.machineRuntimeTrace.entries.find(
      (entry) => entry.type === "transaction_surface",
    );
    resultSurface.at = "2026-07-18T04:00:02.000Z";
    resultSurface.recordedAt = "2026-07-18T04:00:02.000Z";
    assert.doesNotThrow(() => validateFastRouteStressSaleEvidence(evidence));
  });

  it("fails closed when F0/F1/F2 do not retain host raw journal provenance", () => {
    const evidence = validEvidence();
    evidence.serial.rawFrames[2].capturedAt = "2026-07-18T04:00:01.000Z";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /host raw F0\/F1\/F2 capturedAt values must be strictly ordered/,
    );
  });

  it("fails closed when the real transaction projection refresh is missing after Vision departure", () => {
    const evidence = validEvidence();
    evidence.machineRuntimeTrace.entries =
      evidence.machineRuntimeTrace.entries.filter(
        (entry) => entry.intentType !== "transaction.projection",
      );
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /real transaction projection refresh/,
    );
  });

  it("fails closed when MQTT command or serial slot is not correlated to the order", () => {
    const evidence = validEvidence();
    evidence.mqttMessages[0].payload.payload.commandNo = "CMD-OTHER";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /MQTT vend command must correlate commandNo CMD-1/,
    );
  });

  it("fails closed when the repeated touch creates a late duplicate order or payment", () => {
    const evidence = validEvidence();
    evidence.platform.afterF2.raw.orders = [
      ...evidence.platform.afterF2.raw.orders,
      { id: "order-2", orderNo: "ORD-2" },
    ];
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /duplicate order, payment, or vending command appeared after inbound F2/,
    );
  });

  it("fails closed when the pre-F0 boundary does not already hold the correlated command", () => {
    const evidence = validEvidence();
    evidence.platform.beforeF0.raw.commands = [];
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /before inbound F0 the correlated order, payment, and vending command must already exist exactly once/,
    );
  });

  it("fails closed when authoritative pre-F0 payment status or paymentNo is not the gated payment", () => {
    const wrongStatus = validEvidence();
    wrongStatus.platform.beforeF0.raw.payments[0].status = "pending";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(wrongStatus),
      /authoritative pre-F0 payment status must be succeeded/,
    );

    const wrongPaymentNo = validEvidence();
    wrongPaymentNo.platform.beforeF0.raw.payments[0].paymentNo = "PAY-OTHER";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(wrongPaymentNo),
      /authoritative pre-F0 paymentNo must match the create-order gate paymentNo/,
    );
  });

  it("rejects synthetic authorized as a pre-F0 payment status", () => {
    const evidence = validEvidence();
    evidence.platform.beforeF0.raw.payments[0].status = "authorized";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /authoritative pre-F0 payment status must be succeeded/,
    );
  });

  it("fails closed when post-F2 paymentNo or succeeded status drifts from pre-F0", () => {
    const wrongPaymentNo = validEvidence();
    wrongPaymentNo.platform.afterF2.raw.payments[0].paymentNo = "PAY-OTHER";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(wrongPaymentNo),
      /authoritative post-F2 payment must retain the gated paymentNo and succeeded status/,
    );

    const wrongStatus = validEvidence();
    wrongStatus.platform.afterF2.raw.payments[0].status = "pending";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(wrongStatus),
      /authoritative post-F2 payment must retain the gated paymentNo and succeeded status/,
    );
  });

  it("fails closed when authoritative post-F2 order or command status is not terminal", () => {
    const evidence = validEvidence();
    evidence.platform.afterF2.raw.orders[0].status = "dispensing";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /authoritative post-F2 order and dispatch command must be fulfilled, paid, dispensed, and succeeded/,
    );
  });

  it("preserves bounded failure evidence snapshots and collected log references", () => {
    const report = buildFastRouteStressSaleFailureReport({
      mode: "fast",
      stage: "snapshot-before-f0",
      error: new Error("before F0 gate timed out"),
      controlPlaneSessionId: "fast-sale-session-1",
      liveSale: { orderId: "order-1", paymentId: "payment-1" },
      runtimeTrace: [{ type: "navigation", at: "2026-07-18T04:00:00.000Z" }],
      snapshots: {
        platform: {
          baseline: { scope: { machineCode: "VEM-TESTBED-LOCAL" } },
          beforeF0: { scope: { machineCode: "VEM-TESTBED-LOCAL" } },
          afterF1BeforeF2: { scope: { machineCode: "VEM-TESTBED-LOCAL" } },
          afterF2: { scope: { machineCode: "VEM-TESTBED-LOCAL" } },
        },
        daemon: {
          baseline: { items: [] },
          beforeF0: { items: [] },
          afterF1BeforeF2: { items: [] },
          afterF2: { items: [] },
        },
      },
      hostEvidence: {
        references: {
          simulatorLog: "/tmp/fast-route/simulator.log",
        },
      },
      checkpoints: [
        { screenshot: { ref: "/tmp/fast-route/failure-before-f0.png" } },
      ],
      logs: {
        daemonStdout: { ref: "/tmp/fast-route/daemon-stdout.tail.log" },
        daemonStderr: { ref: "/tmp/fast-route/daemon-stderr.tail.log" },
        platform: { ref: "/tmp/fast-route/platform-service-api.log" },
        platformError: "journalctl exited with 1: stdout was empty",
        simulator: "/tmp/fast-route/simulator.log",
      },
    });

    assert.equal(report.ok, false);
    assert.deepEqual(Object.keys(report.snapshots.platform), [
      "baseline",
      "beforeF0",
      "afterF1BeforeF2",
      "afterF2",
    ]);
    assert.deepEqual(Object.keys(report.snapshots.daemon), [
      "baseline",
      "beforeF0",
      "afterF1BeforeF2",
      "afterF2",
      "failureCurrentTransaction",
    ]);
    assert.deepEqual(report.logs.platform, {
      ref: "/tmp/fast-route/platform-service-api.log",
    });
    assert.equal(
      report.logs.platformError,
      "journalctl exited with 1: stdout was empty",
    );
    assert.equal(report.logs.simulator, "/tmp/fast-route/simulator.log");
    assert.deepEqual(report.logs.failureScreenshots, [
      "/tmp/fast-route/failure-before-f0.png",
    ]);
  });

  it("anchors the tracer in production-equivalent runtime surfaces", () => {
    const implementation = readFileSync(
      new URL("./fast-route-stress-sale.mjs", import.meta.url),
      "utf8",
    );
    assert.match(implementation, /Input\.dispatchTouchEvent/);
    assert.match(implementation, /__VEM_MACHINE_RUNTIME_TRACE__/);
    assert.match(implementation, /mock:mock/);
    assert.match(
      implementation,
      /payments\/mock\/\$\{encodeURIComponent\(paymentNo\)\}\/complete/,
    );
    assert.match(implementation, /vision\/control\/departure/);
    assert.match(implementation, /mock-payment-create-gate\/arm/);
    assert.match(implementation, /mock-payment-create-gate\/status/);
    assert.match(implementation, /mock-payment-create-gate\/release/);
    assert.match(
      implementation,
      /handoff\.commissioningSerialSession[\s\S]*commissioningSession \?\?[\s\S]*serial-sessions\/start/,
    );
    assert.match(implementation, /release-f0/);
    assert.match(implementation, /platform-log/);
    assert.match(implementation, /snapshots:/);
    assert.match(
      implementation,
      /--import",\s*"tsx",\s*"apps\/vision-mock\/src\/server\.ts/,
    );
    assert.match(implementation, /control\/status/);
    assert.match(implementation, /shutdownControlledVisionMock/);
    assert.match(implementation, /did not release port.*after SIGTERM/);
    assert.match(
      implementation,
      /installed UI viewport must be exactly 1080x1920/,
    );
    assert.match(
      implementation,
      /sale-start-capability must expose a ready mock:mock payment option/,
    );
    assert.match(implementation, /installed_machine_runtime_trace_cdp/);
    assert.match(implementation, /customer\.touch/);
    assert.match(implementation, /pre-dispatch trace boundary/);
    assert.match(implementation, /no-Catalog trace boundary/);
    assert.match(implementation, /actual or decided Catalog navigation/);
    assert.match(implementation, /Page\.navigatedWithinDocument/);
    assert.match(implementation, /Page\.frameNavigated/);
    assert.match(implementation, /Runtime\.evaluate\(location\.hash\)/);
    assert.doesNotMatch(implementation, /\["authorized", "succeeded"\]/);
    assert.match(implementation, /terminal post-F2 order\/command state/);
    assert.match(implementation, /host_pty_raw_serial_journal/);
    assert.doesNotMatch(implementation, /observe-payment/);
    assert.doesNotMatch(implementation, /observe-result/);
    assert.doesNotMatch(implementation, /fastSale\.createOrderGate\.statePath/);
    assert.match(implementation, /run-vm-host-adapter/);
    assert.doesNotMatch(implementation, /simulatedHardwareSaleFlow/);
    assert.doesNotMatch(implementation, /scannerCode/);
  });

  it("exports an explicit controlled vision mock shutdown path", () => {
    assert.equal(typeof shutdownControlledVisionMock, "function");
  });

  it("retries controlled departure until the persistent runtime client accepts it", () => {
    const source = readFileSync(
      new URL("./fast-route-stress-sale.mjs", import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /async function dispatchVisionDeparture[\s\S]*Date\.now\(\) \+ 15_000[\s\S]*await sleep\(250\)/,
    );
  });

  it("waits for a protocol-registered Vision runtime before customer input", () => {
    const source = readFileSync(
      new URL("./fast-route-stress-sale.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /waitForControlledVisionRuntimeClient/);
    assert.match(source, /connectedRuntimeClients\) >= 1/);
    assert.ok(
      source.indexOf("await waitForControlledVisionRuntimeClient") <
        source.indexOf('stage = "physical-catalog-to-checkout"'),
    );
  });

  it("aggregates cleanup failures without dropping the primary error", async () => {
    const primary = new Error("sale flow failed");
    let cleanup;
    await assert.rejects(async () => {
      await runCleanupStep("reopen payment create gate", async () => {
        throw new Error("gate status unavailable");
      });
    });
    try {
      await runCleanupStep("reopen payment create gate", async () => {
        throw new Error("gate status unavailable");
      });
    } catch (error) {
      cleanup = error;
    }
    const combined = combineCleanupError(primary, [cleanup]);
    assert.equal(combined instanceof AggregateError, true);
    assert.equal(combined.errors[0], primary);
    assert.match(combined.message, /sale flow failed/);
    assert.match(combined.message, /reopen payment create gate failed/);
  });

  it("contains fail-closed cleanup for gate reopen, serial abort, and vision shutdown", () => {
    const implementation = readFileSync(
      new URL("./fast-route-stress-sale.mjs", import.meta.url),
      "utf8",
    );

    assert.match(
      implementation,
      /runCleanupStep\("reopen payment create gate"/,
    );
    assert.match(implementation, /mock-payment-create-gate\/status/);
    assert.match(
      implementation,
      /payment create gate did not return to open with no pending payment/,
    );
    assert.match(implementation, /runCleanupStep\("abort serial session"/);
    assert.match(
      implementation,
      /serial session abort did not confirm inactive state/,
    );
    assert.match(
      implementation,
      /runCleanupStep\(\s*"stop controlled vision mock"/,
    );
  });
});
