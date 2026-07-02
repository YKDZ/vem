import { describe, expect, it, vi } from "vitest";

import type {
  FulfillmentDrillOrder,
  FulfillmentDrillStore,
} from "./fulfillment-drills.service";

import {
  DrizzleFulfillmentDrillStore,
  FulfillmentDrillsService,
  fulfillmentDrillRecoveryActionsForScenario,
} from "./fulfillment-drills.service";

class MemoryFulfillmentDrillStore implements FulfillmentDrillStore {
  readonly orders = new Map<string, FulfillmentDrillOrder>();
  readonly recoveryActions: Array<{
    orderId: string;
    action: string;
    reason: string;
  }> = [];
  private next = 1;

  async getOrder(orderId: string): Promise<FulfillmentDrillOrder | null> {
    return this.orders.get(orderId) ?? null;
  }

  async createDrillOrder(input: {
    machineId: string;
    scenario: FulfillmentDrillOrder["scenario"];
    actorAdminUserId: string;
    reason: string;
    createdAt: Date;
  }): Promise<FulfillmentDrillOrder> {
    const id = `order-${this.next++}`;
    const order: FulfillmentDrillOrder = {
      orderId: id,
      orderNo: `DRILL-ORD-${this.next}`,
      paymentId: `payment-${this.next}`,
      paymentNo: `DRILL-PAY-${this.next}`,
      commandId: `command-${this.next}`,
      commandNo: `DRILL-VC-${this.next}`,
      scenario: input.scenario,
      isDrill: true,
      isTest: true,
      status:
        input.scenario === "maintenance_lock_required"
          ? "manual_handling"
          : "dispense_failed",
      paymentStatus: "succeeded",
      fulfillmentState:
        input.scenario === "unknown_dispense_result"
          ? "manual_handling"
          : "dispense_failed",
      availableRecoveryActions: fulfillmentDrillRecoveryActionsForScenario(
        input.scenario,
      ),
      audit: {
        actorAdminUserId: input.actorAdminUserId,
        reason: input.reason,
        scenario: input.scenario,
        createdAt: input.createdAt.toISOString(),
      },
    };
    this.orders.set(id, order);
    return order;
  }

  async applyRecoveryAction(input: {
    order: FulfillmentDrillOrder;
    action: string;
    actorAdminUserId: string;
    reason: string;
    createdAt: Date;
  }): Promise<FulfillmentDrillOrder> {
    this.recoveryActions.push({
      orderId: input.order.orderId,
      action: input.action,
      reason: input.reason,
    });
    const recovered: FulfillmentDrillOrder = {
      ...input.order,
      status:
        input.action === "confirm_dispensed"
          ? "fulfilled"
          : input.action === "request_refund"
            ? "refund_pending"
            : "manual_handling",
      fulfillmentState:
        input.action === "confirm_dispensed" ? "dispensed" : "manual_handling",
      availableRecoveryActions:
        input.action === "confirm_not_dispensed"
          ? ["request_refund", "compensation_dispense"]
          : [],
      latestRecovery: {
        action: input.action,
        actorAdminUserId: input.actorAdminUserId,
        reason: input.reason,
        createdAt: input.createdAt.toISOString(),
        simulationOnly: true,
      },
    };
    this.orders.set(input.order.orderId, recovered);
    return recovered;
  }
}

function makeService(store = new MemoryFulfillmentDrillStore()) {
  const auditService = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    service: new FulfillmentDrillsService(store, auditService as never),
    store,
    auditService,
  };
}

describe("FulfillmentDrillsService", () => {
  it.each([
    ["dispense_failed", ["confirm_not_dispensed", "request_refund"]],
    ["unknown_dispense_result", ["confirm_dispensed", "confirm_not_dispensed"]],
    ["pickup_timeout", ["confirm_dispensed", "confirm_not_dispensed"]],
    ["maintenance_lock_required", ["confirm_not_dispensed"]],
  ] as const)(
    "exposes protected recovery actions for %s",
    (scenario, expectedActions) => {
      expect(fulfillmentDrillRecoveryActionsForScenario(scenario)).toEqual(
        expectedActions,
      );
    },
  );

  it("creates an auditable paid drill order without targeting customer orders", async () => {
    const { service, auditService } = makeService();

    const result = await service.createDrill(
      "admin-1",
      {
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        scenario: "unknown_dispense_result",
        reason: "pre-launch unknown dispense recovery rehearsal",
      },
      new Date("2026-06-27T03:00:00.000Z"),
    );

    expect(result).toMatchObject({
      isDrill: true,
      isTest: true,
      scenario: "unknown_dispense_result",
      paymentStatus: "succeeded",
      audit: {
        actorAdminUserId: "admin-1",
        reason: "pre-launch unknown dispense recovery rehearsal",
        scenario: "unknown_dispense_result",
        createdAt: "2026-06-27T03:00:00.000Z",
      },
    });
    expect(auditService.record).toHaveBeenCalledWith({
      adminUserId: "admin-1",
      action: "orders.fulfillment_drill.create",
      resourceType: "order",
      resourceId: result.orderId,
      beforeJson: {},
      afterJson: expect.objectContaining({
        isDrill: true,
        isTest: true,
        scenario: "unknown_dispense_result",
        reason: "pre-launch unknown dispense recovery rehearsal",
        simulationOnly: true,
      }),
    });
  });

  it("refuses recovery against real customer orders", async () => {
    const store = new MemoryFulfillmentDrillStore();
    store.orders.set("order-real", {
      orderId: "order-real",
      orderNo: "ORD-REAL",
      paymentId: "payment-real",
      paymentNo: "PAY-REAL",
      commandId: "command-real",
      commandNo: "VC-REAL",
      scenario: "dispense_failed",
      isDrill: false,
      isTest: false,
      status: "dispense_failed",
      paymentStatus: "succeeded",
      fulfillmentState: "dispense_failed",
      availableRecoveryActions: [],
    });
    const { service } = makeService(store);

    await expect(
      service.applyRecoveryAction("order-real", "admin-1", {
        action: "request_refund",
        reason: "must not target a real order",
      }),
    ).rejects.toThrow("cannot target real customer orders");
  });

  it("records simulation evidence for each protected recovery action", async () => {
    const { service, store, auditService } = makeService();

    const actions = [
      "confirm_dispensed",
      "confirm_not_dispensed",
      "request_refund",
      "compensation_dispense",
    ] as const;

    await Promise.all(
      actions.map(async (action) => {
        const drill = await service.createDrill("admin-1", {
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          scenario:
            action === "request_refund" || action === "compensation_dispense"
              ? "dispense_failed"
              : "unknown_dispense_result",
          reason: `create ${action} drill`,
        });
        if (action === "request_refund" || action === "compensation_dispense") {
          await service.applyRecoveryAction(drill.orderId, "admin-2", {
            action: "confirm_not_dispensed",
            reason: "operator confirmed no item left the machine",
          });
        }

        const result = await service.applyRecoveryAction(
          drill.orderId,
          "admin-2",
          {
            action,
            reason: `operator rehearsed ${action}`,
          },
          new Date("2026-06-27T03:05:00.000Z"),
        );

        expect(result.latestRecovery).toMatchObject({
          action,
          actorAdminUserId: "admin-2",
          reason: `operator rehearsed ${action}`,
          simulationOnly: true,
        });
      }),
    );

    expect(store.recoveryActions.map((entry) => entry.action)).toContain(
      "request_refund",
    );
    expect(store.recoveryActions.map((entry) => entry.action)).toContain(
      "compensation_dispense",
    );
    expect(auditService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "orders.fulfillment_drill.recovery.request_refund",
        afterJson: expect.objectContaining({
          simulationOnly: true,
          action: "request_refund",
        }),
      }),
    );
  });
});

describe("DrizzleFulfillmentDrillStore", () => {
  function makeGetOrderDb(
    recoveryRows: Array<{ action: string; status: string }>,
  ) {
    const drillProfile = {
      kind: "protected_fulfillment_drill",
      isDrill: true,
      isTest: true,
      scenario: "unknown_dispense_result",
      audit: {
        actorAdminUserId: "admin-1",
        reason: "pre-launch fulfillment recovery rehearsal",
        scenario: "unknown_dispense_result",
        createdAt: "2026-06-27T03:00:00.000Z",
      },
    };
    const orderQuery = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([
          {
            orderId: "order-drill",
            orderNo: "DRILL-ORD-1",
            status: "manual_handling",
            fulfillmentState: "manual_handling",
            orderIsDrill: true,
            profileSnapshot: drillProfile,
            paymentId: "payment-drill",
            paymentNo: "DRILL-PAY-1",
            paymentStatus: "succeeded",
            paymentIsDrill: true,
            commandId: "command-drill",
            commandNo: "DRILL-CMD-1",
          },
        ]),
      }),
    };
    const recoveryQuery = {
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(recoveryRows),
      }),
    };

    return {
      select: vi
        .fn()
        .mockReturnValueOnce(orderQuery)
        .mockReturnValueOnce(recoveryQuery),
    };
  }

  it.each(["request_refund", "compensation_dispense"] as const)(
    "does not re-expose terminal recovery action after %s completes",
    async (terminalAction) => {
      const store = new DrizzleFulfillmentDrillStore(
        makeGetOrderDb([
          { action: "confirm_not_dispensed", status: "completed" },
          { action: terminalAction, status: "completed" },
        ]) as never,
      );

      await expect(store.getOrder("order-drill")).resolves.toMatchObject({
        orderId: "order-drill",
        availableRecoveryActions: [],
      });
    },
  );
});
