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
          statusDeliveries: [
            {
              deliveryId: "payment-status-payment-1-succeeded",
              status: "succeeded",
              deliveredAt: "2026-07-15T00:00:01.750Z",
              payload: {
                orderId: identity.orderId,
                paymentId: identity.paymentId,
                transactionId: identity.transactionId,
                paymentStatus: "succeeded",
              },
            },
          ],
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
          creationCount: 1,
        },
        stockMovement: {
          movementId: "movement-1",
          orderId: identity.orderId,
          transactionId: identity.transactionId,
          commandId: "command-1",
          quantity: -1,
          status: "accepted",
          creationCount: 1,
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
        observationId: "observation-payment-1",
        observedAt: "2026-07-15T00:00:01.000Z",
        route: "payment",
        identitySource: "customer_payment_surface",
        renderedQrSource: "data:image/svg+xml,expected-qr",
        expectedQrSource: "data:image/svg+xml,expected-qr",
        ...identity,
      },
      {
        observationId: "observation-fulfillment-1",
        observedAt: "2026-07-15T00:00:02.000Z",
        route: "fulfillment",
        identitySource: "router_transaction_state",
        renderedQrSource: null,
        expectedQrSource: null,
        ...identity,
      },
      {
        observationId: "observation-result-1",
        observedAt: "2026-07-15T00:00:03.000Z",
        route: "result",
        identitySource: "router_transaction_state",
        renderedQrSource: null,
        expectedQrSource: null,
        ...identity,
      },
    ],
    disturbanceInjections: [
      {
        injectionId: "injection-1",
        kind: "catalog_refresh",
        injectedAt: "2026-07-15T00:00:01.500Z",
        barrier: "payment_qr_presented",
        barrierObservationId: "observation-payment-1",
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

  it("accepts the same succeeded payment status twice with one fulfillment side effect chain", () => {
    const facts = completeFacts();
    facts.disturbanceInjections[0].kind = "duplicate_payment_status";
    facts.transactions[0].payment.statusDeliveries.push({
      ...facts.transactions[0].payment.statusDeliveries[0],
      deliveredAt: "2026-07-15T00:00:01.800Z",
    });

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics,
    ).toEqual([]);
  });

  it("rejects a third failed delivery appended to duplicate succeeded statuses", () => {
    const facts = completeFacts();
    facts.disturbanceInjections[0].kind = "duplicate_payment_status";
    facts.transactions[0].payment.statusDeliveries.push(
      {
        ...facts.transactions[0].payment.statusDeliveries[0],
        deliveredAt: "2026-07-15T00:00:01.800Z",
      },
      {
        ...facts.transactions[0].payment.statusDeliveries[0],
        deliveryId: "payment-status-payment-1-failed",
        status: "failed",
        deliveredAt: "2026-07-15T00:00:01.900Z",
      },
    );

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("payment_status_delivery_count_mismatch");
  });

  it("rejects duplicate succeeded deliveries with a different payload", () => {
    const facts = completeFacts();
    facts.disturbanceInjections[0].kind = "duplicate_payment_status";
    facts.transactions[0].payment.statusDeliveries.push({
      ...facts.transactions[0].payment.statusDeliveries[0],
      deliveredAt: "2026-07-15T00:00:01.800Z",
      payload: {
        ...facts.transactions[0].payment.statusDeliveries[0].payload,
        transactionId: "unrelated-transaction",
      },
    });

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("payment_status_delivery_count_mismatch");
  });

  it("rejects duplicate fulfillment command or stock movement creation", () => {
    const facts = completeFacts();
    const record = facts.transactions[0];
    if (!record.vendingCommand || !record.stockMovement) {
      throw new Error("complete fulfillment evidence missing");
    }
    record.vendingCommand.creationCount = 2;
    record.stockMovement.creationCount = 2;

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("fulfillment_side_effect_count_mismatch");
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

  it("rejects a rendered QR image source unrelated to its declared payload", () => {
    const facts = completeFacts();
    facts.timeline[0].renderedQrSource =
      "data:image/svg+xml,unrelated-rendered-qr";

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("rendered_payment_qr_source_mismatch");
  });

  it("rejects a timeline whose observation timestamps move backwards", () => {
    const facts = completeFacts();
    facts.timeline[1].observedAt = "2026-07-15T00:00:00.500Z";

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("timeline_observed_at_not_nondecreasing");
  });

  it("rejects Fulfillment before Payment even when timestamps are equal", () => {
    const facts = completeFacts();
    const payment = facts.timeline[0];
    const fulfillment = facts.timeline[1];
    const result = facts.timeline[2];
    const observedAt = payment.observedAt;
    facts.timeline = [
      { ...fulfillment, observedAt },
      { ...payment, observedAt },
      { ...result, observedAt },
    ];

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("timeline_route_sequence_invalid");
  });

  it("rejects duplicate observation IDs and a non-unique barrier resolution", () => {
    const facts = completeFacts();
    facts.timeline[1].observationId = facts.timeline[0].observationId;

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual(
      expect.arrayContaining([
        "timeline_observation_id_not_unique",
        "disturbance_barrier_payment_qr_mismatch",
      ]),
    );
  });

  it.each([
    ["before payment", "2026-07-15T00:00:00.500Z"],
    ["after result", "2026-07-15T00:00:03.500Z"],
  ])("rejects an injection %s", (_label, injectedAt) => {
    const facts = completeFacts();
    facts.disturbanceInjections[0].injectedAt = injectedAt;

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toContain("disturbance_outside_payment_result_interval");
  });

  it("rejects an appended route event timestamped inside the active interval", () => {
    const facts = completeFacts();
    facts.timeline.push({
      ...facts.timeline[0],
      observedAt: "2026-07-15T00:00:02.500Z",
      route: "home",
    });

    expect(
      classifyBrowserInstalledKioskSaleContract(facts).diagnostics.map(
        (diagnostic) => diagnostic.code,
      ),
    ).toEqual(
      expect.arrayContaining([
        "timeline_observed_at_not_nondecreasing",
        "active_transaction_route_replaced",
      ]),
    );
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
