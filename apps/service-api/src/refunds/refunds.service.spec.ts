import { describe, expect, it, vi } from "vitest";

import type { PaymentProviderConfigService } from "../payments/payment-provider-config.service";
import type { PaymentProviderRegistry } from "../payments/payment-provider.registry";

import { RefundsService } from "./refunds.service";

// ---- helpers ---------------------------------------------------------------

function makeDb() {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };

  // Default transaction passes through
  chain.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    return fn(chain);
  });

  return chain;
}

function makeBasePaymentRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    orderId: "ord-001",
    orderStatus: "dispense_failed",
    paymentId: "pay-001",
    paymentNo: "PAY_WX_001",
    providerTradeNo: "TXN_WX_001",
    providerCode: "wechat_pay",
    amountCents: 500,
    machineId: "mach-001",
    providerConfigId: null,
    ...overrides,
  };
}

function makeRefundRow(overrides?: Partial<Record<string, unknown>>) {
  return {
    id: "rfd-001",
    refundNo: "RFD001",
    paymentId: "pay-001",
    orderId: "ord-001",
    amountCents: 500,
    status: "processing",
    reason: "admin_refund",
    requestedByAdminUserId: null,
    providerRefundNo: null,
    refundedAt: null,
    ...overrides,
  };
}

function makeService(options: {
  db?: ReturnType<typeof makeDb>;
  refundPayment?: ReturnType<typeof vi.fn>;
  queryRefund?: ReturnType<typeof vi.fn>;
  supportsPartialRefund?: boolean;
}) {
  const {
    db = makeDb(),
    refundPayment = vi.fn(),
    queryRefund = vi.fn(),
    supportsPartialRefund,
  } = options;

  const registry = {
    has: vi.fn().mockReturnValue(true),
    get: vi
      .fn()
      .mockReturnValue({ refundPayment, queryRefund, supportsPartialRefund }),
  } as unknown as PaymentProviderRegistry;

  const configService = {
    resolveForPayment: vi.fn().mockResolvedValue({
      providerCode: "wechat_pay",
      merchantNo: "MCH001",
      appId: "wx-app-001",
      publicConfigJson: {},
      sensitiveConfigJson: {},
    }),
    resolveForExistingPayment: vi.fn().mockResolvedValue({
      providerCode: "wechat_pay",
      merchantNo: "MCH001",
      appId: "wx-app-001",
      publicConfigJson: {},
      sensitiveConfigJson: {},
    }),
  } as unknown as PaymentProviderConfigService;

  return new RefundsService(db as never, registry, configService);
}

describe("RefundsService.requestFullRefund", () => {
  it("succeeded refund: updates refund.status=succeeded, payment.status=refunded, order.status=refunded", async () => {
    const db = makeDb();
    const paymentRow = makeBasePaymentRow();
    const initialRefundRow = makeRefundRow();
    const updatedRefundRow = makeRefundRow({
      status: "succeeded",
      providerRefundNo: "RF_001",
      refundedAt: new Date(),
    });

    // 1) main transaction: order+payment query
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue([paymentRow]),
              }),
            }),
          }),
        }),
      }),
    });
    // 2) existing refund check → none
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    // 3) failed refund count check → 0
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
    // order update
    db.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    // payment update
    db.insert.mockReturnValueOnce({
      values: vi.fn().mockResolvedValue(undefined),
    });
    // insert refund
    db.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([initialRefundRow]),
      }),
    });
    // insert refundEvents (refund.created, outside tx)
    db.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue(
        Object.assign(Promise.resolve(undefined), {
          onConflictDoNothing: vi.fn().mockResolvedValue([]),
        }),
      ),
    });

    // post-transaction: second transaction for updating after provider call
    db.transaction.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => fn(db),
    );
    db.transaction.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => fn(db),
    );
    // 4) update refund (succeeded)
    db.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedRefundRow]),
        }),
      }),
    });
    // fallback for remaining inserts (orderStatusEvents + refundEvents.succeeded)
    db.insert.mockReturnValue({
      values: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(undefined), {
          onConflictDoNothing: vi.fn().mockResolvedValue([]),
          returning: vi.fn().mockResolvedValue([]),
        }),
      ),
    });

    const refundPayment = vi.fn().mockResolvedValue({
      status: "succeeded",
      providerRefundNo: "RF_001",
      refundedAt: new Date(),
    });

    const service = makeService({ db, refundPayment });

    const result = await service.requestFullRefund({
      orderId: "ord-001",
      reason: "admin_refund",
    });

    expect(refundPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentNo: "PAY_WX_001",
        providerTradeNo: "TXN_WX_001",
        amountCents: 500,
        reason: "admin_refund",
      }),
    );
    expect(result.status).toBe("succeeded");
  });

  it("provider throws: order enters manual_handling, refund status=failed", async () => {
    const db = makeDb();
    const paymentRow = makeBasePaymentRow();
    const initialRefundRow = makeRefundRow();
    const failedRefundRow = makeRefundRow({ status: "failed" });

    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue([paymentRow]),
              }),
            }),
          }),
        }),
      }),
    });
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });
    db.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    });
    db.insert.mockReturnValueOnce({
      values: vi.fn().mockResolvedValue(undefined),
    });
    db.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([initialRefundRow]),
      }),
    });
    // insert refundEvents (refund.created, outside tx)
    db.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue(
        Object.assign(Promise.resolve(undefined), {
          onConflictDoNothing: vi.fn().mockResolvedValue([]),
        }),
      ),
    });

    db.transaction.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => fn(db),
    );
    db.transaction.mockImplementationOnce(
      async (fn: (tx: unknown) => unknown) => fn(db),
    );

    // After provider throws, error handler runs update
    db.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([failedRefundRow]),
        }),
      }),
    });
    // fallback for remaining inserts (orderStatusEvents + refundEvents.failed)
    db.insert.mockReturnValue({
      values: vi.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(undefined), {
          onConflictDoNothing: vi.fn().mockResolvedValue([]),
          returning: vi.fn().mockResolvedValue([]),
        }),
      ),
    });

    const refundPayment = vi
      .fn()
      .mockRejectedValue(new Error("WeChat Pay request failed: 500"));
    const service = makeService({ db, refundPayment });

    const result = await service.requestFullRefund({
      orderId: "ord-001",
      reason: "admin_refund",
    });

    expect(result.status).toBe("failed");
  });

  it("duplicate same order+reason returns existing active refund (idempotent)", async () => {
    const db = makeDb();
    const paymentRow = makeBasePaymentRow();
    const existingRefundRow = makeRefundRow({ status: "processing" });

    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue([paymentRow]),
              }),
            }),
          }),
        }),
      }),
    });
    // existing refund check → already exists (active)
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([existingRefundRow]),
        }),
      }),
    });

    const refundPayment = vi.fn();
    const service = makeService({ db, refundPayment });

    const result = await service.requestFullRefund({
      orderId: "ord-001",
      reason: "admin_refund",
    });

    // Returns existing refund without calling provider
    expect(refundPayment).not.toHaveBeenCalled();
    expect(result.status).toBe("processing");
  });
});

describe("RefundsService.requestPartialRefund", () => {
  it("succeeds through a provider that explicitly supports partial refunds", async () => {
    const db = makeDb();
    const updateSets: Record<string, unknown>[] = [];
    const refundRow = makeRefundRow({
      amountCents: 300,
      reason: "auto_partial_dispense_failed",
    });
    const paymentRow = makeBasePaymentRow({
      orderStatus: "dispense_failed",
      fulfillmentState: "partial_dispensed",
      providerCode: "mock",
      paymentAmountCents: 800,
      amountCents: 800,
    });

    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue([paymentRow]),
              }),
            }),
          }),
        }),
      }),
    });
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    db.update.mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updateSets.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    });
    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([refundRow]),
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
      }),
    });

    const refundPayment = vi.fn().mockResolvedValue({
      status: "succeeded",
      providerRefundNo: "MOCK-RFD001",
      refundedAt: new Date("2026-06-05T00:00:00.000Z"),
    });
    const service = makeService({
      db,
      refundPayment,
      supportsPartialRefund: true,
    });

    const result = await service.requestPartialRefund({
      orderId: "ord-001",
      orderItemIds: ["line-failed"],
      amountCents: 300,
      reason: "auto_partial_dispense_failed",
    });

    expect(refundPayment).toHaveBeenCalledWith(
      expect.objectContaining({
        amountCents: 300,
        totalAmountCents: 800,
        reason: "auto_partial_dispense_failed",
      }),
    );
    expect(result.status).toBe("succeeded");
    expect(updateSets).toContainEqual(
      expect.objectContaining({
        status: "refunded",
        paymentState: "partial_refunded",
        fulfillmentState: "partial_dispensed",
      }),
    );
    expect(updateSets).toContainEqual(
      expect.objectContaining({
        refundStatus: "refunded",
        refundId: refundRow.id,
      }),
    );
  });

  it("routes unsupported partial refunds to manual payment handling without overwriting partial fulfillment", async () => {
    const db = makeDb();
    const updateSets: Record<string, unknown>[] = [];
    const refundPayment = vi.fn();
    const paymentRow = makeBasePaymentRow({
      orderStatus: "dispense_failed",
      fulfillmentState: "partial_dispensed",
      providerCode: "wechat_pay",
      paymentAmountCents: 800,
      amountCents: 800,
    });

    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue([paymentRow]),
              }),
            }),
          }),
        }),
      }),
    });
    db.update.mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updateSets.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    });
    db.insert.mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    });

    const service = makeService({
      db,
      refundPayment,
      supportsPartialRefund: false,
    });

    const result = await service.requestPartialRefund({
      orderId: "ord-001",
      orderItemIds: ["line-failed"],
      amountCents: 300,
      reason: "auto_partial_dispense_failed",
    });

    expect(result.status).toBe("manual_handling");
    expect(refundPayment).not.toHaveBeenCalled();
    expect(updateSets).toContainEqual(
      expect.objectContaining({ refundStatus: "manual_handling" }),
    );
    expect(updateSets).toContainEqual(
      expect.objectContaining({
        status: "manual_handling",
        paymentState: "manual_handling",
        fulfillmentState: "partial_dispensed",
      }),
    );
  });

  it("provider throws: records failed refund event and order transition for admin diagnosis", async () => {
    const db = makeDb();
    const insertedValues: Record<string, unknown>[] = [];
    const updateSets: Record<string, unknown>[] = [];
    const refundRow = makeRefundRow({
      amountCents: 300,
      reason: "auto_partial_dispense_failed",
    });
    const paymentRow = makeBasePaymentRow({
      orderStatus: "dispense_failed",
      fulfillmentState: "partial_dispensed",
      providerCode: "mock",
      paymentAmountCents: 800,
      amountCents: 800,
    });

    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                orderBy: vi.fn().mockResolvedValue([paymentRow]),
              }),
            }),
          }),
        }),
      }),
    });
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });
    db.update.mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updateSets.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    });
    db.insert.mockReturnValue({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        insertedValues.push(values);
        return {
          returning: vi.fn().mockResolvedValue([refundRow]),
          onConflictDoNothing: vi.fn().mockResolvedValue([]),
        };
      }),
    });

    const refundPayment = vi
      .fn()
      .mockRejectedValue(new Error("provider timeout"));
    const service = makeService({
      db,
      refundPayment,
      supportsPartialRefund: true,
    });

    const result = await service.requestPartialRefund({
      orderId: "ord-001",
      orderItemIds: ["line-failed"],
      amountCents: 300,
      reason: "auto_partial_dispense_failed",
    });

    expect(result.status).toBe("failed");
    expect(updateSets).toContainEqual(
      expect.objectContaining({ status: "failed" }),
    );
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        eventType: "refund.failed",
        status: "failed",
      }),
    );
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        reason: "auto_partial_dispense_failed_failed",
        toStatus: "manual_handling",
        metadata: expect.objectContaining({
          refundNo: refundRow.refundNo,
          message: "provider timeout",
        }),
      }),
    );
  });
});

describe("RefundsService partial refund terminal states", () => {
  it("reconciles a processing partial refund to partial_refunded without full-refunding the order", async () => {
    const db = makeDb();
    const updateSets: Record<string, unknown>[] = [];
    const refundRow = makeRefundRow({
      amountCents: 300,
      reason: "auto_partial_dispense_failed",
      providerRefundNo: "MOCK-RFD001",
    });

    db.select
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([
                    {
                      ...refundRow,
                      providerCode: "mock",
                      providerId: "provider-001",
                      paymentNo: "PAY_WX_001",
                      providerTradeNo: "TXN_WX_001",
                      machineId: "mach-001",
                      providerConfigId: null,
                      fulfillmentState: "partial_dispensed",
                    },
                  ]),
                }),
              }),
            }),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ total: 0 }]),
        }),
      });
    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "attempt-1" }]),
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
      }),
    });
    db.update.mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updateSets.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    });

    const queryRefund = vi.fn().mockResolvedValue({
      status: "succeeded",
      providerRefundNo: "MOCK-RFD001",
      refundedAt: new Date("2026-06-05T00:00:00.000Z"),
    });
    const service = makeService({
      db,
      queryRefund,
      supportsPartialRefund: true,
    });

    await service.reconcileProcessingRefunds(
      new Date("2026-06-05T00:01:00.000Z"),
    );

    expect(updateSets).toContainEqual(
      expect.objectContaining({
        refundStatus: "refunded",
        refundId: refundRow.id,
      }),
    );
    expect(updateSets).toContainEqual(
      expect.objectContaining({ status: "partial_refunded" }),
    );
    expect(updateSets).toContainEqual(
      expect.objectContaining({
        paymentState: "partial_refunded",
        fulfillmentState: "partial_dispensed",
      }),
    );
    expect(updateSets).not.toContainEqual(
      expect.objectContaining({ paymentState: "refunded" }),
    );
  });

  it("moves a processing partial refund webhook failure to manual handling and marks only refund lines failed", async () => {
    const db = makeDb();
    const updateSets: Record<string, unknown>[] = [];
    const refundRow = makeRefundRow({
      amountCents: 300,
      reason: "auto_partial_dispense_failed",
      providerRefundNo: "MOCK-RFD001",
    });

    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    refundId: refundRow.id,
                    refundNo: refundRow.refundNo,
                    status: "processing",
                    paymentId: refundRow.paymentId,
                    orderId: refundRow.orderId,
                    providerId: "provider-001",
                    providerRefundNo: refundRow.providerRefundNo,
                    reason: "auto_partial_dispense_failed",
                    fulfillmentState: "partial_dispensed",
                  },
                ]),
              }),
            }),
          }),
        }),
      }),
    });
    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "event-1" }]),
        }),
      }),
    });
    db.update.mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updateSets.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    });
    const service = makeService({ db, supportsPartialRefund: true });

    const result = await service.applyProviderRefundWebhook({
      providerCode: "mock",
      refundNo: refundRow.refundNo,
      providerRefundNo: "MOCK-RFD001",
      paymentNo: null,
      providerEventId: "provider-event-1",
      eventType: "mock.refund.webhook",
      refundStatus: "failed",
      rawPayload: { refundNo: refundRow.refundNo },
      signatureValid: true,
    });

    expect(result.handled).toBe(true);
    expect(updateSets).toContainEqual(
      expect.objectContaining({
        refundStatus: "failed",
        refundId: refundRow.id,
      }),
    );
    expect(updateSets).toContainEqual(
      expect.objectContaining({ status: "manual_handling" }),
    );
    expect(updateSets).toContainEqual(
      expect.objectContaining({
        paymentState: "manual_handling",
        fulfillmentState: "partial_dispensed",
      }),
    );
    expect(updateSets).not.toContainEqual(
      expect.objectContaining({ paymentState: "refunded" }),
    );
  });
});

describe("RefundsService lifecycle", () => {
  it("onApplicationShutdown clears reconcile timer", () => {
    const service = makeService({});
    service.onModuleInit();
    // @ts-expect-error - accessing private field for testing
    expect(service.reconcileTimer).toBeDefined();
    service.onApplicationShutdown();
    // @ts-expect-error - accessing private field for testing
    expect(service.reconcileTimer).toBeUndefined();
  });
});
