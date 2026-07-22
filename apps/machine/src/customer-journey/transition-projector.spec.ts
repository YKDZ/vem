import { describe, expect, it } from "vitest";

import { createCustomerJourneyTransitionProjector } from "./transition-projector";

describe("Customer Journey Transition Projector", () => {
  it("emits a payment transition once when polling only changes timestamps", () => {
    const projector = createCustomerJourneyTransitionProjector();

    projector.project({ transaction: null });

    expect(
      projector.project({
        transaction: {
          orderNo: "ORDER-100",
          nextAction: "wait_payment",
          updatedAt: "2026-07-18T08:00:00.000Z",
          vending: null,
        },
      }),
    ).toMatchObject([
      {
        transitionId: "transaction:ORDER-100:payment-prompt",
        kind: "payment.prompt",
      },
    ]);

    expect(
      projector.project({
        transaction: {
          orderNo: "ORDER-100",
          nextAction: "wait_payment",
          updatedAt: "2026-07-18T08:00:01.000Z",
          vending: null,
        },
      }),
    ).toEqual([]);
  });

  it("uses a restored transaction as baseline without replaying it", () => {
    const projector = createCustomerJourneyTransitionProjector();

    expect(
      projector.project({
        transaction: {
          orderNo: "ORDER-RESTORED",
          nextAction: "wait_payment",
          updatedAt: "2026-07-18T08:00:00.000Z",
          vending: null,
          restored: true,
        },
      }),
    ).toEqual([]);

    expect(
      projector.project({
        transaction: {
          orderNo: "ORDER-RESTORED",
          nextAction: "wait_payment",
          updatedAt: "2026-07-18T08:01:00.000Z",
          vending: null,
        },
      }),
    ).toEqual([]);

    expect(
      projector.project({
        transaction: {
          orderNo: "ORDER-RESTORED",
          nextAction: "dispensing",
          updatedAt: "2026-07-18T08:02:00.000Z",
          vending: null,
        },
      }),
    ).toMatchObject([
      { kind: "payment.succeeded" },
      { kind: "dispensing.started" },
    ]);
  });

  it("projects F0, ordinal E5, F1, and F2 from daemon pickup facts without UI timers", () => {
    const projector = createCustomerJourneyTransitionProjector();
    projector.project({ transaction: null });

    expect(
      projector.project({
        transaction: {
          orderNo: "ORDER-PICKUP",
          nextAction: "dispensing",
          updatedAt: "2026-07-18T08:00:00.000Z",
          vending: {
            status: "dispensing",
            pickupReminder: {
              stage: "outlet_opened",
              level: "info",
              warningNo: null,
              reportedAt: "2026-07-18T08:00:00.000Z",
            },
          },
        },
      }),
    ).toMatchObject([
      { kind: "payment.succeeded" },
      { kind: "dispensing.started" },
      { kind: "pickup.outlet_opened" },
    ]);

    expect(
      projector.project({
        transaction: {
          orderNo: "ORDER-PICKUP",
          nextAction: "dispensing",
          updatedAt: "2026-07-18T08:00:10.000Z",
          vending: {
            status: "dispensing",
            pickupReminder: {
              stage: "pickup_timeout_warning",
              level: "warning",
              warningNo: 1,
              reportedAt: "2026-07-18T08:00:10.000Z",
            },
          },
        },
      }),
    ).toMatchObject([{ kind: "pickup.warning" }]);

    expect(
      projector.project({
        transaction: {
          orderNo: "ORDER-PICKUP",
          nextAction: "dispensing",
          updatedAt: "2026-07-18T08:00:25.000Z",
          vending: {
            status: "dispensing",
            pickupReminder: {
              stage: "pickup_timeout_warning",
              level: "urgent",
              warningNo: 2,
              reportedAt: "2026-07-18T08:00:25.000Z",
            },
          },
        },
      }),
    ).toMatchObject([{ kind: "pickup.urgent" }]);

    expect(
      projector.project({
        transaction: {
          orderNo: "ORDER-PICKUP",
          nextAction: "dispensing",
          updatedAt: "2026-07-18T08:00:30.000Z",
          vending: { status: "dispensing", pickupReminder: null },
        },
      }),
    ).toMatchObject([{ kind: "pickup.resetting" }]);

    expect(
      projector.project({
        transaction: {
          orderNo: "ORDER-PICKUP",
          nextAction: "success",
          updatedAt: "2026-07-18T08:00:31.000Z",
          vending: { status: "succeeded", pickupReminder: null },
        },
      }),
    ).toMatchObject([
      { kind: "pickup.completed" },
      { kind: "dispense.succeeded" },
    ]);
  });

  it("projects payment, refund, and manual handling outcomes from transaction facts", () => {
    const projector = createCustomerJourneyTransitionProjector();
    projector.project({ transaction: null });

    const failed = projector.project({
      transaction: {
        orderNo: "ORDER-FAILED",
        nextAction: "payment_failed",
        updatedAt: "2026-07-18T08:03:00.000Z",
        vending: null,
      },
    });
    expect(failed).toMatchObject([{ kind: "payment.failed" }]);

    const refundPending = projector.project({
      transaction: {
        orderNo: "ORDER-REFUND",
        nextAction: "refund_pending",
        updatedAt: "2026-07-18T08:04:00.000Z",
        vending: null,
      },
    });
    expect(refundPending).toMatchObject([
      { kind: "payment.succeeded" },
      { kind: "refund.pending" },
    ]);

    expect(
      projector.project({
        transaction: {
          orderNo: "ORDER-REFUND",
          nextAction: "refunded",
          updatedAt: "2026-07-18T08:05:00.000Z",
          vending: null,
        },
      }),
    ).toMatchObject([{ kind: "refund.completed" }]);

    expect(
      projector.project({
        transaction: {
          orderNo: "ORDER-MANUAL",
          nextAction: "manual_handling",
          updatedAt: "2026-07-18T08:06:00.000Z",
          vending: null,
        },
      }),
    ).toMatchObject([
      { kind: "payment.succeeded" },
      { kind: "manual_handling.required" },
    ]);
  });

  it.each([
    ["success", "dispense.succeeded"],
    ["payment_failed", "payment.failed"],
    ["payment_expired", "payment.failed"],
    ["dispense_failed", "dispense.failed"],
    ["refund_pending", "refund.pending"],
    ["refunded", "refund.completed"],
    ["manual_handling", "manual_handling.required"],
  ] as const)(
    "projects %s as %s from the transaction protocol",
    (nextAction, kind) => {
      const projector = createCustomerJourneyTransitionProjector();
      const transitions = projector.project({
        transaction: {
          orderNo: `ORDER-${nextAction}`,
          nextAction,
          updatedAt: "2026-07-18T08:10:00.000Z",
          vending: null,
        },
      });

      expect(transitions).toContainEqual(expect.objectContaining({ kind }));
    },
  );

  it.each([
    [
      "single-person Vision presence",
      {
        vision: {
          personPresent: true,
          occupancyState: "single" as const,
          lastSeenAt: "2026-07-18T08:11:00.000Z",
          departedAt: null,
          lastChangedAt: "2026-07-18T08:11:00.000Z",
          edge: "arrival" as const,
          edgeId: "presence-1:arrival",
        },
      },
      "presence.welcome",
    ],
    [
      "crowd Vision presence",
      {
        vision: {
          personPresent: true,
          occupancyState: "multiple" as const,
          lastSeenAt: "2026-07-18T08:12:00.000Z",
          departedAt: null,
          lastChangedAt: "2026-07-18T08:12:00.000Z",
          edge: "arrival" as const,
          edgeId: "presence-1:arrival",
        },
      },
      "privacy.crowd_detected",
    ],
    [
      "Vision departure",
      {
        vision: {
          personPresent: false,
          occupancyState: "none" as const,
          lastSeenAt: "2026-07-18T08:13:00.000Z",
          departedAt: "2026-07-18T08:13:01.000Z",
          lastChangedAt: "2026-07-18T08:13:01.000Z",
          edge: "departure" as const,
          edgeId: "presence-1:departure",
        },
      },
      "presence.departed",
    ],
  ])("projects %s as a stable source transition", (_label, facts, kind) => {
    const projector = createCustomerJourneyTransitionProjector();
    const first = projector.project(facts);
    const repeated = projector.project(facts);

    expect(first).toContainEqual(expect.objectContaining({ kind }));
    expect(repeated).toEqual([]);
  });

  it("projects stable Vision edges once even while a touchscreen session is active", () => {
    const projector = createCustomerJourneyTransitionProjector();
    const touchscreen = {
      personPresent: true,
      source: "local_interaction" as const,
      lastInteractionAt: "2026-07-18T08:20:00.000Z",
    };

    projector.project({ touchscreen });
    expect(
      projector.project({
        touchscreen,
        vision: {
          personPresent: true,
          occupancyState: "single",
          lastSeenAt: "2026-07-18T08:20:01.000Z",
          departedAt: null,
          lastChangedAt: "2026-07-18T08:20:01.000Z",
          edge: "arrival",
          edgeId: "presence-1:arrival",
        },
      }),
    ).toContainEqual(expect.objectContaining({ kind: "presence.welcome" }));
    expect(
      projector.project({
        touchscreen,
        vision: {
          personPresent: false,
          occupancyState: "none",
          lastSeenAt: "2026-07-18T08:20:01.000Z",
          departedAt: "2026-07-18T08:20:02.000Z",
          lastChangedAt: "2026-07-18T08:20:02.000Z",
          edge: "departure",
          edgeId: "presence-2:departure",
        },
      }),
    ).toContainEqual(expect.objectContaining({ kind: "presence.departed" }));
  });

  it("remembers a restored touchscreen fact without replaying it", () => {
    const projector = createCustomerJourneyTransitionProjector();
    const facts = {
      touchscreen: {
        personPresent: true,
        source: "local_interaction" as const,
        lastInteractionAt: "2026-07-18T08:14:00.000Z",
        restored: true,
      },
    };

    expect(projector.project(facts)).toEqual([]);
    expect(
      projector.project({
        touchscreen: { ...facts.touchscreen, restored: false },
      }),
    ).toEqual([]);
  });

  it("remembers a restored Vision fact without replaying it", () => {
    const projector = createCustomerJourneyTransitionProjector();
    const facts = {
      vision: {
        personPresent: true,
        occupancyState: "single" as const,
        lastSeenAt: "2026-07-18T08:15:00.000Z",
        departedAt: null,
        lastChangedAt: "2026-07-18T08:15:00.000Z",
        edge: "arrival" as const,
        edgeId: "presence-restored:arrival",
        restored: true,
      },
    };

    expect(projector.project(facts)).toEqual([]);
    expect(
      projector.project({ vision: { ...facts.vision, restored: false } }),
    ).toEqual([]);
  });

  it("uses semantic touch, presence profile, and departure edges instead of observation times", () => {
    const projector = createCustomerJourneyTransitionProjector();

    const touch = projector.project({
      touchscreen: {
        personPresent: true,
        source: "local_interaction",
        lastInteractionAt: "2026-07-18T08:20:00.000Z",
      },
    });
    const repeatedTouch = projector.project({
      touchscreen: {
        personPresent: true,
        source: "local_interaction",
        lastInteractionAt: "2026-07-18T08:20:10.000Z",
      },
    });
    expect(touch).toMatchObject([
      { transitionId: "touchscreen:session-1:awakened" },
    ]);
    expect(repeatedTouch).toEqual([]);

    const welcome = projector.project({
      vision: {
        personPresent: true,
        occupancyState: "single",
        lastSeenAt: "2026-07-18T08:21:00.000Z",
        departedAt: null,
        lastChangedAt: "2026-07-18T08:21:00.000Z",
        edge: "arrival",
        edgeId: "presence-1:arrival",
      },
    });
    const repeatedPresence = projector.project({
      vision: {
        personPresent: true,
        occupancyState: "single",
        lastSeenAt: "2026-07-18T08:21:10.000Z",
        departedAt: null,
        lastChangedAt: "2026-07-18T08:21:10.000Z",
        edge: "arrival",
        edgeId: "presence-1:arrival",
      },
    });
    const departure = projector.project({
      vision: {
        personPresent: false,
        occupancyState: "none",
        lastSeenAt: "2026-07-18T08:21:10.000Z",
        departedAt: "2026-07-18T08:21:20.000Z",
        lastChangedAt: "2026-07-18T08:21:20.000Z",
        edge: "departure",
        edgeId: "presence-2:departure",
      },
    });
    const repeatedDeparture = projector.project({
      vision: {
        personPresent: false,
        occupancyState: "none",
        lastSeenAt: "2026-07-18T08:21:10.000Z",
        departedAt: "2026-07-18T08:21:30.000Z",
        lastChangedAt: "2026-07-18T08:21:30.000Z",
        edge: "departure",
        edgeId: "presence-2:departure",
      },
    });

    expect(welcome).toMatchObject([
      { transitionId: "vision:presence-1:welcome" },
    ]);
    expect(repeatedPresence).toEqual([]);
    expect(departure).toMatchObject([
      { transitionId: "vision:presence-2:departed" },
    ]);
    expect(repeatedDeparture).toEqual([]);
  });

  it("remembers a restored product selection without replaying it", () => {
    const projector = createCustomerJourneyTransitionProjector();
    const facts = {
      selectedProduct: {
        selectionId: "selection-restored",
        productId: "product-1",
        category: "袜子",
        selectedAt: "2026-07-18T08:16:00.000Z",
        restored: true,
      },
    };

    expect(projector.project(facts)).toEqual([]);
    expect(
      projector.project({
        selectedProduct: { ...facts.selectedProduct, restored: false },
      }),
    ).toEqual([]);
  });

  it("introduces a category once at product-list entry, not at later product selection", () => {
    const projector = createCustomerJourneyTransitionProjector();
    const categoryEntry = {
      entryId: "category-entry-socks-1",
      category: "袜子",
      enteredAt: "2026-07-18T08:16:00.000Z",
    };

    expect(projector.project({ categoryEntry })).toContainEqual(
      expect.objectContaining({
        transitionId: "category:category-entry-socks-1",
        kind: "category.entered",
        productCategory: "袜子",
      }),
    );
    expect(projector.project({ categoryEntry })).toEqual([]);
    expect(
      projector.project({
        categoryEntry,
        selectedProduct: {
          selectionId: "product-selection-socks-1",
          productId: "socks-1",
          category: "袜子",
          selectedAt: "2026-07-18T08:16:01.000Z",
        },
      }),
    ).not.toContainEqual(expect.objectContaining({ kind: "category.entered" }));
  });

  it("does not replay persistent transaction or product states after 256 unrelated identities", () => {
    const projector = createCustomerJourneyTransitionProjector();
    const persistentTransaction = {
      orderNo: "ORDER-PERSISTENT",
      nextAction: "wait_payment" as const,
      updatedAt: "2026-07-18T09:00:00.000Z",
      vending: null,
    };
    expect(
      projector.project({ transaction: persistentTransaction }),
    ).toContainEqual(expect.objectContaining({ kind: "payment.prompt" }));

    for (let index = 0; index < 300; index += 1) {
      const transitions = projector.project({
        selectedProduct: {
          selectionId: `selection-${index}`,
          productId: `product-${index}`,
          category: "袜子",
          selectedAt: null,
        },
        transaction: persistentTransaction,
      });
      expect(transitions).not.toContainEqual(
        expect.objectContaining({ kind: "payment.prompt" }),
      );
    }

    const persistentProduct = {
      selectionId: "selection-persistent",
      productId: "product-persistent",
      category: "袜子",
      selectedAt: null,
    };
    expect(
      projector.project({ selectedProduct: persistentProduct }),
    ).toContainEqual(expect.objectContaining({ kind: "product.selected" }));
    for (let index = 0; index < 300; index += 1) {
      const transitions = projector.project({
        selectedProduct: persistentProduct,
        transaction: {
          orderNo: `ORDER-UNRELATED-${index}`,
          nextAction: "wait_payment",
          updatedAt: "2026-07-18T09:01:00.000Z",
          vending: null,
        },
      });
      expect(transitions).not.toContainEqual(
        expect.objectContaining({ kind: "product.selected" }),
      );
    }
  });

  it("bounds per-order transition and pickup memory and clears closed orders", () => {
    const projector = createCustomerJourneyTransitionProjector();
    for (let index = 0; index < 40; index += 1) {
      projector.project({
        transaction: {
          orderNo: `ORDER-MEMORY-${index}`,
          nextAction: "dispensing",
          updatedAt: "2026-07-18T09:05:00.000Z",
          vending: {
            status: "dispensing",
            pickupReminder: {
              stage: "outlet_opened",
              level: "info",
              warningNo: null,
              reportedAt: "2026-07-18T09:05:00.000Z",
            },
          },
        },
      });
    }

    expect(projector.memoryUsage()).toEqual({
      transactionOrders: 32,
      pickupSeenOrders: 32,
      maxTransactionOrders: 32,
    });
    projector.project({
      transaction: {
        orderNo: "ORDER-MEMORY-39",
        nextAction: "closed",
        updatedAt: "2026-07-18T09:06:00.000Z",
        vending: null,
      },
    });
    expect(projector.memoryUsage()).toEqual({
      transactionOrders: 31,
      pickupSeenOrders: 31,
      maxTransactionOrders: 32,
    });
  });
});
