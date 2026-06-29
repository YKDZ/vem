import { describe, expect, it, vi } from "vitest";

import type {
  PaymentDrillOrder,
  PaymentDrillStore,
} from "./payment-drills.service";

import {
  PaymentDrillsService,
  paymentDrillRecoveryActionsForScenario,
} from "./payment-drills.service";

class MemoryPaymentDrillStore implements PaymentDrillStore {
  readonly orders = new Map<string, PaymentDrillOrder>();
  readonly recoveryActions: Array<{
    orderId: string;
    action: string;
    reason: string;
  }> = [];
  private next = 1;

  async getOrder(orderId: string): Promise<PaymentDrillOrder | null> {
    return this.orders.get(orderId) ?? null;
  }

  async createDrillOrder(input: {
    machineId: string;
    scenario: PaymentDrillOrder["scenario"];
    actorAdminUserId: string;
    reason: string;
    createdAt: Date;
  }): Promise<PaymentDrillOrder> {
    const id = `order-${this.next++}`;
    const order: PaymentDrillOrder = {
      orderId: id,
      orderNo: `DRILL-ORD-${this.next}`,
      paymentId: `payment-${this.next}`,
      paymentNo: `DRILL-PAY-${this.next}`,
      scenario: input.scenario,
      isDrill: true,
      isTest: true,
      status: "pending_payment",
      paymentStatus: "processing",
      availableRecoveryActions:
        input.scenario === "qr_reconcile_failed"
          ? ["reconcile_qr", "mark_manual_handling"]
          : ["mark_manual_handling"],
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
    order: PaymentDrillOrder;
    action: string;
    actorAdminUserId: string;
    reason: string;
    createdAt: Date;
  }): Promise<PaymentDrillOrder> {
    this.recoveryActions.push({
      orderId: input.order.orderId,
      action: input.action,
      reason: input.reason,
    });
    const recovered: PaymentDrillOrder = {
      ...input.order,
      status: input.action === "reconcile_qr" ? "paid" : "manual_handling",
      paymentStatus:
        input.action === "reconcile_qr" ? "succeeded" : "manual_handling",
      availableRecoveryActions: [],
      latestRecovery: {
        action: input.action,
        actorAdminUserId: input.actorAdminUserId,
        reason: input.reason,
        createdAt: input.createdAt.toISOString(),
      },
    };
    this.orders.set(input.order.orderId, recovered);
    return recovered;
  }
}

function makeService(store = new MemoryPaymentDrillStore()) {
  const auditService = { record: vi.fn().mockResolvedValue(undefined) };
  return {
    service: new PaymentDrillsService(store, auditService as never),
    store,
    auditService,
  };
}

describe("PaymentDrillsService", () => {
  it.each([
    [
      "payment_code_unknown",
      ["query_payment_code", "reverse_payment_code", "mark_manual_handling"],
    ],
    [
      "user_confirming_timeout",
      ["query_payment_code", "reverse_payment_code", "mark_manual_handling"],
    ],
    [
      "query_failed_then_reversed",
      ["reverse_payment_code", "mark_manual_handling"],
    ],
    ["qr_reconcile_failed", ["reconcile_qr", "mark_manual_handling"]],
    ["refund_required", ["request_refund", "mark_manual_handling"]],
    ["manual_handling", ["mark_manual_handling"]],
  ] as const)(
    "exposes recovery drill actions for %s",
    (scenario, expectedActions) => {
      expect(paymentDrillRecoveryActionsForScenario(scenario)).toEqual(
        expectedActions,
      );
    },
  );

  it("creates an auditable drill order instead of targeting customer orders", async () => {
    const { service, auditService } = makeService();

    const result = await service.createDrill(
      "admin-1",
      {
        machineId: "550e8400-e29b-41d4-a716-446655440000",
        scenario: "qr_reconcile_failed",
        reason: "pre-launch QR recovery rehearsal",
      },
      new Date("2026-06-27T02:00:00.000Z"),
    );

    expect(result).toMatchObject({
      scenario: "qr_reconcile_failed",
      isDrill: true,
      isTest: true,
      audit: {
        actorAdminUserId: "admin-1",
        reason: "pre-launch QR recovery rehearsal",
        scenario: "qr_reconcile_failed",
        createdAt: "2026-06-27T02:00:00.000Z",
      },
    });
    expect(auditService.record).toHaveBeenCalledWith({
      adminUserId: "admin-1",
      action: "payments.drill.create",
      resourceType: "order",
      resourceId: result.orderId,
      beforeJson: {},
      afterJson: expect.objectContaining({
        isDrill: true,
        scenario: "qr_reconcile_failed",
        reason: "pre-launch QR recovery rehearsal",
      }),
    });
  });

  it("recovers only drill orders and records the drill recovery audit", async () => {
    const { service, auditService } = makeService();
    const drill = await service.createDrill("admin-1", {
      machineId: "550e8400-e29b-41d4-a716-446655440000",
      scenario: "qr_reconcile_failed",
      reason: "create drill",
    });

    const result = await service.applyRecoveryAction(
      drill.orderId,
      "admin-2",
      {
        action: "reconcile_qr",
        reason: "operator completed QR reconciliation rehearsal",
      },
      new Date("2026-06-27T02:05:00.000Z"),
    );

    expect(result).toMatchObject({
      orderId: drill.orderId,
      status: "paid",
      paymentStatus: "succeeded",
      latestRecovery: {
        action: "reconcile_qr",
        actorAdminUserId: "admin-2",
        reason: "operator completed QR reconciliation rehearsal",
        createdAt: "2026-06-27T02:05:00.000Z",
      },
    });
    expect(auditService.record).toHaveBeenLastCalledWith({
      adminUserId: "admin-2",
      action: "payments.drill.recovery.reconcile_qr",
      resourceType: "order",
      resourceId: drill.orderId,
      beforeJson: expect.objectContaining({
        scenario: "qr_reconcile_failed",
        isDrill: true,
      }),
      afterJson: expect.objectContaining({
        action: "reconcile_qr",
        reason: "operator completed QR reconciliation rehearsal",
        scenario: "qr_reconcile_failed",
        isDrill: true,
      }),
    });
  });
});
