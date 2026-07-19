import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  parseSerialFulfillmentErrorGuestArgs,
  validateSerialFulfillmentErrorEvidence,
} from "./serial-fulfillment-error-guest-full.mjs";

const sale = {
  orderId: "order-20",
  paymentId: "payment-20",
  orderNo: "ORDER-20",
};
const liveSale = { ...sale, vendingCommandId: "command-20" };
const BASE_E6_TIME_MS = Date.parse("2026-07-18T08:00:00.000Z");

function e6Frame(opcode, offsetMs, partial = {}) {
  return {
    parsedOpcode: opcode,
    capturedAt: new Date(BASE_E6_TIME_MS + offsetMs).toISOString(),
    ...partial,
  };
}

function evidence(overrides = {}) {
  return {
    baseline: {
      platform: {
        raw: { inventories: [{ id: "inventory-20", onHandQty: 7 }] },
      },
    },
    final: {
      platform: {
        raw: {
          orders: [{ id: sale.orderId, status: "refunded" }],
          payments: [{ id: sale.paymentId, orderId: sale.orderId }],
          commands: [{ id: liveSale.vendingCommandId, orderId: sale.orderId }],
          movements: [],
          inventories: [{ id: "inventory-20", onHandQty: 7 }],
        },
      },
    },
    sale,
    liveSale,
    daemon: { orderId: sale.orderId, paymentId: sale.paymentId },
    serial: {
      saleBinding: {
        orderId: sale.orderId,
        paymentId: sale.paymentId,
        vendingCommandId: liveSale.vendingCommandId,
      },
      rawFrames: [
        e6Frame("VEND", 0),
        e6Frame("F0", 1_000),
        e6Frame("E5", 16_000),
        e6Frame("E5", 26_000),
        e6Frame("F1", 28_000),
        e6Frame("E6", 35_000),
      ],
    },
    ui: {
      route: "#/result/dispense_failed",
      trace: [{ type: "dispense_failure" }],
    },
    ...overrides,
  };
}

describe("serial fulfillment error guest full", () => {
  it("parses an installed Windows full guest contract", () => {
    assert.deepEqual(
      parseSerialFulfillmentErrorGuestArgs([
        "--mode",
        "full",
        "--guest-input",
        "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
        "--handoff",
        "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
        "--out",
        "C:\\ProgramData\\VEM\\testbed\\serial-fulfillment-error.json",
      ]),
      {
        mode: "full",
        guestInputPath: "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
        handoffPath:
          "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
        outPath: "C:\\ProgramData\\VEM\\testbed\\serial-fulfillment-error.json",
        fixtureKey: null,
      },
    );
  });

  it("waits for serial bindings and payment capability before entering checkout flow", () => {
    const source = readFileSync(
      new URL("./serial-fulfillment-error-guest-full.mjs", import.meta.url),
      "utf8",
    );
    assert.match(source, /await-daemon-binding-and-capability/);
    assert.match(source, /waitForHardwareBindings/);
    assert.match(source, /handoff,\s*session/);
    assert.match(source, /waitForSaleStartCapability/);
  });

  it("accepts only a bound E6 terminal journey with no F2, movement, or stock delta", () => {
    assert.deepEqual(validateSerialFulfillmentErrorEvidence(evidence()), {
      orderStatus: "refunded",
      paymentId: sale.paymentId,
      commandId: liveSale.vendingCommandId,
      inventoryDelta: 0,
    });
  });

  it("rejects an accidental F2 or customer success projection", () => {
    assert.throws(
      () =>
        validateSerialFulfillmentErrorEvidence(
          evidence({
            serial: {
              ...evidence().serial,
              rawFrames: [
                ...evidence().serial.rawFrames,
                { parsedOpcode: "F2" },
              ],
            },
          }),
        ),
      /must not contain F2/,
    );
    assert.throws(
      () =>
        validateSerialFulfillmentErrorEvidence(
          evidence({ ui: { route: "#/result/success" } }),
        ),
      /must end on dispense_failed/,
    );
  });

  it("accepts strict E6 timing around the 15s/25s timeout warnings", () => {
    assert.deepEqual(
      validateSerialFulfillmentErrorEvidence(
        evidence({
          serial: {
            ...evidence().serial,
            rawFrames: [
              e6Frame("VEND", 0),
              e6Frame("F0", 0),
              e6Frame("E5", 15_000),
              e6Frame("E5", 25_000),
              e6Frame("F1", 25_000),
              e6Frame("E6", 40_000),
            ],
          },
        }),
      ).orderStatus,
      "refunded",
    );
  });

  it("rejects E6 frames that violate 15s/25s pickup timeout spacing", () => {
    assert.throws(
      () =>
        validateSerialFulfillmentErrorEvidence(
          evidence({
            serial: {
              ...evidence().serial,
              rawFrames: [
                e6Frame("VEND", 0),
                e6Frame("F0", 0),
                e6Frame("E5", 8_000),
                e6Frame("E5", 17_000),
                e6Frame("F1", 20_000),
                e6Frame("E6", 35_000),
              ],
            },
          }),
        ),
      /first pickup timeout warning timing must be within the timeout window/,
    );
  });
});
