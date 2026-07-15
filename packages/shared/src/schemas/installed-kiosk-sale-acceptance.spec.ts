import { describe, expect, it } from "vitest";

import {
  browserInstalledKioskSaleContractFactsSchema,
  classifyBrowserInstalledKioskSaleContract,
  type BrowserInstalledKioskSaleContractFacts,
  type InstalledKioskSaleLinkedTransaction,
} from "./installed-kiosk-sale-acceptance";

function completeFacts(): BrowserInstalledKioskSaleContractFacts {
  const identity = {
    orderId: "order-1",
    paymentId: "payment-1",
    transactionId: "transaction-1",
    paymentUrl: "https://pay.example.test/order-1",
  };
  return {
    source: "browser_ui_contract",
    transactions: [
      {
        checkout: { idempotencyKey: "checkout-attempt-1" },
        order: {
          orderId: identity.orderId,
          checkoutIdempotencyKey: "checkout-attempt-1",
          status: "fulfilled",
        },
        reservation: {
          reservationId: "reservation-1",
          orderId: identity.orderId,
          status: "consumed",
        },
        payment: {
          paymentId: identity.paymentId,
          orderId: identity.orderId,
          reservationId: "reservation-1",
          paymentUrl: identity.paymentUrl,
          status: "succeeded",
        },
        transaction: {
          transactionId: identity.transactionId,
          orderId: identity.orderId,
          paymentId: identity.paymentId,
          reservationId: "reservation-1",
          status: "succeeded",
        },
        vendingCommand: {
          commandId: "command-1",
          orderId: identity.orderId,
          transactionId: identity.transactionId,
          status: "succeeded",
        },
        stockMovement: {
          movementId: "movement-1",
          orderId: identity.orderId,
          transactionId: identity.transactionId,
          commandId: "command-1",
          quantity: -1,
          status: "accepted",
        },
        fulfillment: {
          status: "succeeded",
          orderId: identity.orderId,
          transactionId: identity.transactionId,
          commandId: "command-1",
          stockMovementId: "movement-1",
        },
      },
    ],
    timeline: [
      {
        observedAt: "2026-07-15T00:00:01.000Z",
        route: "payment",
        ...identity,
      },
      {
        observedAt: "2026-07-15T00:00:02.000Z",
        route: "fulfillment",
        ...identity,
      },
      {
        observedAt: "2026-07-15T00:00:03.000Z",
        route: "result",
        ...identity,
      },
    ],
    disturbanceInjections: [
      {
        injectionId: "injection-1",
        kind: "catalog_refresh",
        injectedAt: "2026-07-15T00:00:01.500Z",
        barrier: "payment_qr_presented",
        count: 1,
        outcome: "completed",
      },
    ],
  };
}

describe("browser Installed Kiosk Sale UI contract", () => {
  it("accepts one linked UI mock transaction without claiming platform acceptance", () => {
    const facts = completeFacts();

    expect(browserInstalledKioskSaleContractFactsSchema.parse(facts)).toEqual(
      facts,
    );
    expect(classifyBrowserInstalledKioskSaleContract(facts)).toEqual({
      schemaVersion: "installed-kiosk-sale-ui-contract/v1",
      source: "browser_ui_contract",
      assertionScope: "ui_contract_only",
      status: "passed",
      diagnostics: [],
    });
  });

  it.each(["windows_vm_runtime", "factory_iso_overlay"])(
    "rejects %s as a browser debug evidence source",
    (source) => {
      expect(
        browserInstalledKioskSaleContractFactsSchema.safeParse({
          ...completeFacts(),
          source,
        }).success,
      ).toBe(false);
    },
  );

  it.each<{
    boundary: string;
    breakBinding: (record: InstalledKioskSaleLinkedTransaction) => void;
  }>([
    {
      boundary: "checkout -> order",
      breakBinding: (record) => {
        record.order.checkoutIdempotencyKey = "unrelated-checkout";
      },
    },
    {
      boundary: "order -> reservation",
      breakBinding: (record) => {
        record.reservation.orderId = "unrelated-order";
      },
    },
    {
      boundary: "reservation -> payment",
      breakBinding: (record) => {
        record.payment.reservationId = "unrelated-reservation";
      },
    },
    {
      boundary: "payment -> transaction",
      breakBinding: (record) => {
        record.transaction.paymentId = "unrelated-payment";
      },
    },
    {
      boundary: "transaction -> vending command",
      breakBinding: (record) => {
        if (!record.vendingCommand) throw new Error("command missing");
        record.vendingCommand.transactionId = "unrelated-transaction";
      },
    },
    {
      boundary: "vending command -> stock movement",
      breakBinding: (record) => {
        if (!record.stockMovement) throw new Error("stock movement missing");
        record.stockMovement.commandId = "unrelated-command";
      },
    },
    {
      boundary: "stock movement -> fulfillment",
      breakBinding: (record) => {
        if (!record.fulfillment) throw new Error("fulfillment missing");
        record.fulfillment.stockMovementId = "unrelated-stock-movement";
      },
    },
  ])("rejects an unrelated ID at $boundary", ({ breakBinding }) => {
    const facts = completeFacts();
    breakBinding(facts.transactions[0]);

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("transaction_identity_binding_mismatch");
  });

  it("rejects a transaction that skips final fulfillment", () => {
    const facts = completeFacts();
    const record = facts.transactions[0];
    if (!record) throw new Error("complete transaction missing");
    record.order.status = "dispensing";
    record.transaction.status = "dispensing";
    record.vendingCommand = null;
    record.stockMovement = null;
    record.fulfillment = null;

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("final_fulfillment_not_successful");
  });

  it("rejects a stale QR on any active route observation", () => {
    const facts = completeFacts();
    facts.timeline[1].paymentUrl = "https://pay.example.test/stale-order";

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("timeline_payment_qr_mismatch");
  });

  it.each(["home", "maintenance"] as const)(
    "rejects a transient %s route during an active transaction",
    (route) => {
      const facts = completeFacts();
      facts.timeline.splice(1, 0, {
        ...facts.timeline[0],
        observedAt: "2026-07-15T00:00:01.500Z",
        route,
      });

      expect(
        classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
          (diagnostic) => diagnostic.code,
        ),
      ).toContain("active_transaction_route_replaced");
    },
  );

  it("rejects repeated disturbance IDs, counts, and failed outcomes", () => {
    const facts = completeFacts();
    facts.disturbanceInjections[0].count = 2;
    facts.disturbanceInjections[0].outcome = "failed";
    facts.disturbanceInjections.push({
      ...facts.disturbanceInjections[0],
    });

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual(
      expect.arrayContaining([
        "disturbance_not_exactly_once",
        "disturbance_injection_id_not_unique",
        "disturbance_count_not_exactly_once",
        "disturbance_outcome_not_completed",
      ]),
    );
  });
});
