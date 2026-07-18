import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  buildFastRouteStressScenarioSteps,
  parseFastRouteStressSaleArgs,
  summarizeFastRouteStressSale,
} from "./fast-route-stress-sale.mjs";

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

  it("summarizes a single correlated sale and rejects pre-F2 stock drift", () => {
    const summary = summarizeFastRouteStressSale({
      runtimeTrace: [
        { type: "navigation", reasonCode: "customer_touch_payment_submit" },
        { type: "navigation", reasonCode: "presence_departed_guarded" },
      ],
      renderedSale: {
        orderId: "order-1",
        paymentId: "payment-1",
        orderNo: "ORD-1",
      },
      platform: {
        baseline: {
          raw: {
            orders: [],
            payments: [],
            commands: [],
            movements: [],
          },
        },
        beforeF2: {
          raw: {
            orders: [{ id: "order-1" }],
            payments: [{ id: "payment-1", orderId: "order-1" }],
            commands: [{ id: "command-1", orderId: "order-1" }],
            movements: [],
          },
        },
        afterF2: {
          raw: {
            orders: [{ id: "order-1" }],
            payments: [{ id: "payment-1", orderId: "order-1" }],
            commands: [{ id: "command-1", orderId: "order-1" }],
            movements: [
              {
                id: "movement-1",
                orderItemId: "item-1",
                orderNo: "ORD-1",
                commandNo: "CMD-1",
                quantity: 1,
              },
            ],
          },
        },
      },
      daemon: {
        beforeF2: { items: [{ slotCode: "A1", saleableStock: 3 }] },
        afterF2: { items: [{ slotCode: "A1", saleableStock: 2 }] },
      },
      mqttMessages: [{ topic: "vem/machines/VEM-TESTBED-LOCAL/commands/dispense" }],
      serial: {
        lowerControllerEvents: [
          "dispense-request",
          "dispense-ack",
          "dispense-result",
        ],
        lowerControllerRecords: [
          {
            event: "dispense-request",
            capturedFrame: {
              sequence: 3,
              digest: `sha256:${"a".repeat(64)}`,
              byteLength: 16,
            },
          },
          {
            event: "dispense-ack",
            capturedFrame: {
              sequence: 4,
              digest: `sha256:${"b".repeat(64)}`,
              byteLength: 16,
            },
          },
          {
            event: "dispense-result",
            capturedFrame: {
              sequence: 5,
              digest: `sha256:${"c".repeat(64)}`,
              byteLength: 16,
            },
          },
        ],
      },
    });

    assert.equal(summary.counts.ordersCreated, 1);
    assert.equal(summary.counts.paymentsCreated, 1);
    assert.equal(summary.counts.commandsCreated, 1);
    assert.equal(summary.counts.mqttCommands, 1);
    assert.equal(summary.counts.platformMovementsAfterF2, 1);
    assert.equal(summary.counts.platformMovementsBeforeF2, 0);
    assert.equal(summary.counts.daemonSaleableDeltaBeforeF2, 0);
    assert.equal(summary.counts.daemonSaleableDeltaAfterF2, -1);
    assert.deepEqual(
      summary.serial.protocolFrames.map((frame) => frame.stage),
      ["F0", "F1", "F2"],
    );
    assert.deepEqual(
      summary.serial.protocolFrames.map((frame) => frame.event),
      ["dispense-request", "dispense-ack", "dispense-result"],
    );
  });

  it("anchors the tracer in production-equivalent runtime surfaces", () => {
    const implementation = readFileSync(
      new URL("./fast-route-stress-sale.mjs", import.meta.url),
      "utf8",
    );
    assert.match(implementation, /Input\.dispatchTouchEvent/);
    assert.match(implementation, /__VEM_MACHINE_RUNTIME_TRACE__/);
    assert.match(implementation, /payment_code:mock/);
    assert.match(implementation, /vision\/control\/departure/);
    assert.match(implementation, /--import", "tsx", "apps\/vision-mock\/src\/server\.ts/);
    assert.match(implementation, /run-vm-host-adapter/);
    assert.doesNotMatch(implementation, /simulatedHardwareSaleFlow/);
    assert.doesNotMatch(implementation, /factory-route-competition/);
  });
});
