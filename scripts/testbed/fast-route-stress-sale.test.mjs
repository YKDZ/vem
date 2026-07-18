import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  buildFastRouteStressSaleFailureReport,
  buildFastRouteStressScenarioSteps,
  dispatchRepeatedPaymentTouch,
  parseFastRouteStressSaleArgs,
  shutdownControlledVisionMock,
  validateFastRouteStressSaleEvidence,
} from "./fast-route-stress-sale.mjs";

function validEvidence() {
  const inventory = { id: "inventory-1", slotId: "slot-1", onHandQty: 3, reservedQty: 0 };
  const baselineRaw = {
    orders: [], orderItems: [], payments: [], commands: [], movements: [], inventories: [inventory],
  };
  const beforeF0Raw = {
    orders: [{ id: "order-1", orderNo: "ORD-1" }],
    orderItems: [{ id: "item-1", orderId: "order-1", inventoryId: "inventory-1", slotId: "slot-1", quantity: 1 }],
    payments: [{ id: "payment-1", orderId: "order-1", paymentNo: "PAY-1" }],
    commands: [{ id: "command-1", commandNo: "CMD-1", orderId: "order-1", orderItemId: "item-1", slotId: "slot-1" }],
    movements: [],
    inventories: [inventory],
  };
  const inFlightRaw = structuredClone(beforeF0Raw);
  return {
    saleCorrelationId: "sale-1",
    machineCode: "VEM-TESTBED-LOCAL",
    renderedSale: { orderId: "order-1", paymentId: "payment-1", orderNo: "ORD-1" },
    liveSale: { orderId: "order-1", paymentId: "payment-1", orderNo: "ORD-1", vendingCommandId: "command-1" },
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
      baseline: { scope: { machineCode: "VEM-TESTBED-LOCAL", machineId: "machine-1" }, raw: baselineRaw },
      beforeF0: { scope: { machineCode: "VEM-TESTBED-LOCAL", machineId: "machine-1" }, raw: beforeF0Raw },
      afterF1BeforeF2: { scope: { machineCode: "VEM-TESTBED-LOCAL", machineId: "machine-1" }, raw: inFlightRaw },
      afterF2: {
        scope: { machineCode: "VEM-TESTBED-LOCAL", machineId: "machine-1" },
        raw: {
          ...inFlightRaw,
          movements: [{ id: "movement-1", orderItemId: "item-1", orderNo: "ORD-1", commandNo: "CMD-1", inventoryId: "inventory-1", slotId: "slot-1", quantity: 1 }],
          inventories: [{ ...inventory, onHandQty: 2 }],
        },
      },
    },
    daemon: {
      baseline: { items: [{ inventoryId: "inventory-1", slotId: "slot-1", slotCode: "R2C5", layerNo: 2, cellNo: 5, saleableStock: 3 }] },
      beforeF0: { items: [{ inventoryId: "inventory-1", slotId: "slot-1", slotCode: "R2C5", layerNo: 2, cellNo: 5, saleableStock: 3 }] },
      afterF1BeforeF2: { items: [{ inventoryId: "inventory-1", slotId: "slot-1", slotCode: "R2C5", layerNo: 2, cellNo: 5, saleableStock: 3 }] },
      afterF2: { items: [{ inventoryId: "inventory-1", slotId: "slot-1", slotCode: "R2C5", layerNo: 2, cellNo: 5, saleableStock: 2 }] },
    },
    ui: {
      beforeF0: { route: "#/payment", result: null },
      afterF1BeforeF2: { route: "#/dispensing", result: null },
      afterF2: { route: "#/result/success", result: { kind: "success", orderId: "order-1", paymentId: "payment-1", orderNo: "ORD-1", commandId: "command-1" } },
    },
    visionDelivery: {
      ok: true,
      eventId: "departure-event-1",
      timestamp: "2026-07-18T04:00:00.000Z",
      connectedRuntimeClients: 1,
      acceptedDeliveries: 1,
    },
    runtimeTrace: [{
      type: "navigation",
      intentType: "presence.departed",
      sourceEventId: "departure-event-1",
      decision: "rejected",
      reasonCode: "touchscreen_session_active",
      fromRoute: "#/checkout",
      finalRoute: "#/checkout",
      at: "2026-07-18T04:00:00.100Z",
    }, {
      type: "transaction_surface",
      id: 2,
      at: "2026-07-18T04:00:01.000Z",
      recordedAt: "2026-07-18T04:00:01.000Z",
      route: "#/result/success",
      stage: "result",
      orderId: "order-1",
      paymentId: "payment-1",
      orderNo: "ORD-1",
      commandId: "command-1",
      resultKind: "success",
      resultDisplayIntent: "success",
    }],
    mqttMessages: [{
      topic: "vem/machines/VEM-TESTBED-LOCAL/commands/dispense",
      payload: { messageId: "command:CMD-1", machineCode: "VEM-TESTBED-LOCAL", payload: { commandNo: "CMD-1", orderNo: "ORD-1", slot: { slotCode: "R2C5", layerNo: 2, cellNo: 5 }, quantity: 1 } },
    }],
    serial: {
      sessionId: "serial-session-1",
      rawFrames: [
        { sequence: 1, direction: "daemon-to-controller", rawFrameHex: "55020531", opcode: 2, parsedOpcode: "VEND" },
        { sequence: 2, direction: "controller-to-daemon", rawFrameHex: "55F0", opcode: 240, parsedOpcode: "F0" },
        { sequence: 3, direction: "controller-to-daemon", rawFrameHex: "55F1", opcode: 241, parsedOpcode: "F1" },
        { sequence: 4, direction: "controller-to-daemon", rawFrameHex: "55F2", opcode: 242, parsedOpcode: "F2" },
      ],
    },
  };
}

describe("fast route stress sale tracer", () => {
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

  it("accepts exactly one fully correlated sale across real temporal boundaries", () => {
    const summary = validateFastRouteStressSaleEvidence(validEvidence());
    assert.deepEqual(summary.protocol, ["VEND", "F0", "F1", "F2"]);
    assert.equal(summary.orderNo, "ORD-1");
    assert.equal(summary.commandNo, "CMD-1");
    assert.equal(summary.slotCode, "R2C5");
    assert.equal(summary.platformStockDeltaAfterF2, -1);
    assert.equal(summary.daemonStockDeltaAfterF2, -1);
    assert.equal(summary.saleStartCapabilityRevision, 7);
    assert.deepEqual(summary.uiViewport, { width: 1080, height: 1920 });
    assert.deepEqual(summary.runtimeTraceCorrelation.rawFrames, [
      { parsedOpcode: "F0", rawFrameHex: "55F0" },
      { parsedOpcode: "F1", rawFrameHex: "55F1" },
      { parsedOpcode: "F2", rawFrameHex: "55F2" },
    ]);
  });

  it("fails closed when raw serial direction/order is inferred from semantic event names", () => {
    const evidence = validEvidence();
    evidence.serial.rawFrames[0] = { ...evidence.serial.rawFrames[0], parsedOpcode: "F0" };
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /raw serial frame 1 F0 must match the 2-byte production frame 55 F0/,
    );
  });

  it("fails closed when the raw inbound production bytes are not exact 55 F0/F1/F2 frames", () => {
    const evidence = validEvidence();
    evidence.serial.rawFrames[1] = { ...evidence.serial.rawFrames[1], rawFrameHex: "55F000" };
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
    evidence.runtimeTrace = [];
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /Vision departure requires a connected installed runtime client/,
    );
  });

  it("fails closed when runtime trace does not bind the exact departed eventId", () => {
    const evidence = validEvidence();
    evidence.runtimeTrace[0].sourceEventId = "departure-event-other";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /guarded Vision departure navigation effect for the accepted eventId/,
    );
  });

  it("fails closed when Vision departure is not anchored inside the gated pending payment creation interval", () => {
    const evidence = validEvidence();
    evidence.createOrderGate.releasedAt = "2026-07-18T03:59:59.950Z";
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /Vision departure must occur while payment creation is explicitly pending/,
    );
  });

  it("fails closed when the runtime trace has no correlated result surface", () => {
    const evidence = validEvidence();
    evidence.runtimeTrace = evidence.runtimeTrace.filter(
      (entry) => entry.type !== "transaction_surface",
    );
    assert.throws(
      () => validateFastRouteStressSaleEvidence(evidence),
      /runtime trace must expose a correlated result surface/,
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
    assert.match(implementation, /payments\/mock\/\$\{encodeURIComponent\(paymentNo\)\}\/complete/);
    assert.match(implementation, /vision\/control\/departure/);
    assert.match(implementation, /mock-payment-create-gate\/arm/);
    assert.match(implementation, /mock-payment-create-gate\/status/);
    assert.match(implementation, /mock-payment-create-gate\/release/);
    assert.match(implementation, /release-f0/);
    assert.match(implementation, /platform-log/);
    assert.match(implementation, /snapshots:/);
    assert.match(implementation, /--import", "tsx", "apps\/vision-mock\/src\/server\.ts/);
    assert.match(implementation, /control\/status/);
    assert.match(implementation, /shutdownControlledVisionMock/);
    assert.match(
      implementation,
      /did not release port 7892 after SIGTERM/,
    );
    assert.match(implementation, /installed UI viewport must be exactly 1080x1920/);
    assert.match(
      implementation,
      /sale-start-capability must expose a ready mock:mock payment option/,
    );
    assert.doesNotMatch(implementation, /fastSale\.createOrderGate\.statePath/);
    assert.match(implementation, /run-vm-host-adapter/);
    assert.doesNotMatch(implementation, /simulatedHardwareSaleFlow/);
    assert.doesNotMatch(implementation, /factory-route-competition/);
    assert.doesNotMatch(implementation, /scannerCode/);
  });

  it("exports an explicit controlled vision mock shutdown path", () => {
    assert.equal(typeof shutdownControlledVisionMock, "function");
  });
});
