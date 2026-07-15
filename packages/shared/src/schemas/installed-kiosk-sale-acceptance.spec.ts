import { describe, expect, it } from "vitest";

import {
  classifyInstalledKioskSaleAcceptance,
  type InstalledKioskSaleAcceptanceFacts,
} from "./installed-kiosk-sale-acceptance";

function completeFacts(): InstalledKioskSaleAcceptanceFacts {
  return {
    profile: "browser_fast_feedback",
    disturbance: "none",
    correlation: {
      checkoutIdempotencyKeys: ["checkout-attempt-1"],
      orderIds: ["order-1"],
      paymentIds: ["payment-1"],
      reservationIds: ["reservation-1"],
      transactionIds: ["order-1"],
      vendingCommandIds: ["command-1"],
      stockMovementIds: ["movement-1"],
      paymentUrls: ["https://pay.example.test/order-1"],
    },
    timeline: [
      {
        observedAt: "2026-07-15T00:00:00.000Z",
        route: "home",
        transactionId: null,
      },
      {
        observedAt: "2026-07-15T00:00:01.000Z",
        route: "payment",
        transactionId: "order-1",
      },
      {
        observedAt: "2026-07-15T00:00:02.000Z",
        route: "fulfillment",
        transactionId: "order-1",
      },
      {
        observedAt: "2026-07-15T00:00:03.000Z",
        route: "result",
        transactionId: "order-1",
      },
    ],
    counts: {
      orderCreation: 1,
      paymentStatusDeliveries: 1,
      vendingCommandCreation: 1,
      stockMovementCreation: 1,
    },
  };
}

describe("Installed Kiosk Sale Acceptance oracle", () => {
  it("accepts one UI-initiated transaction through payment, fulfillment, and result", () => {
    expect(classifyInstalledKioskSaleAcceptance(completeFacts())).toMatchObject(
      {
        schemaVersion: "installed-kiosk-sale-acceptance/v1",
        status: "passed",
        diagnostics: [],
      },
    );
  });

  it("fails a payment-route flash and duplicate stock movement", () => {
    const facts = completeFacts();
    facts.timeline.splice(2, 0, {
      observedAt: "2026-07-15T00:00:01.500Z",
      route: "maintenance",
      transactionId: "order-1",
    });
    facts.correlation.stockMovementIds.push("movement-2");
    facts.counts.stockMovementCreation = 2;

    expect(
      classifyInstalledKioskSaleAcceptance(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual(
      expect.arrayContaining([
        "active_transaction_route_replaced",
        "stock_movement_not_exactly_once",
      ]),
    );
  });
});
