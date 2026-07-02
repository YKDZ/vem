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

function mockUpdateSetCapture(
  db: ReturnType<typeof makeDb>,
  updateSets: Record<string, unknown>[],
  terminalClaims: boolean[] = [true],
) {
  let terminalClaimIndex = 0;
  db.update.mockReturnValue({
    set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
      updateSets.push(values);
      return {
        where: vi.fn().mockImplementation(() => {
          const whereResult = Promise.resolve(undefined) as Promise<void> & {
            returning: ReturnType<typeof vi.fn>;
          };
          whereResult.returning = vi
            .fn()
            .mockImplementation(() =>
              Promise.resolve(
                terminalClaims[terminalClaimIndex++] ? [{ id: "rfd-001" }] : [],
              ),
            );
          return whereResult;
        }),
      };
    }),
  });
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

  it("provider timeout/5xx keeps refund processing and records uncertainty trail", async () => {
    const db = makeDb();
    const paymentRow = makeBasePaymentRow();
    const initialRefundRow = makeRefundRow();
    const insertedValues: Record<string, unknown>[] = [];
    const updateSets: Record<string, unknown>[] = [];

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

    mockUpdateSetCapture(db, updateSets);
    db.insert.mockReturnValue({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        insertedValues.push(values);
        return Object.assign(Promise.resolve(undefined), {
          onConflictDoNothing: vi.fn().mockResolvedValue([]),
          returning: vi.fn().mockResolvedValue([]),
        });
      }),
    });

    const refundPayment = vi
      .fn()
      .mockRejectedValue(new Error("WeChat Pay request failed: 500"));
    const service = makeService({ db, refundPayment });

    const result = await service.requestFullRefund({
      orderId: "ord-001",
      reason: "admin_refund",
    });

    expect(result.status).toBe("processing");
    expect(updateSets).toContainEqual(
      expect.objectContaining({ status: "processing" }),
    );
    expect(updateSets).not.toContainEqual(
      expect.objectContaining({ status: "failed" }),
    );
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        eventType: "refund.request_uncertain",
        status: "processing",
      }),
    );
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
    mockUpdateSetCapture(db, updateSets);
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
    mockUpdateSetCapture(db, updateSets);
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

  it("provider throws: keeps partial refund processing for later reconciliation", async () => {
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
    mockUpdateSetCapture(db, updateSets);
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

    expect(result.status).toBe("processing");
    expect(updateSets).not.toContainEqual(
      expect.objectContaining({ status: "failed" }),
    );
    expect(insertedValues).toContainEqual(
      expect.objectContaining({
        eventType: "refund.request_uncertain",
        status: "processing",
      }),
    );
  });
});

describe("RefundsService partial refund terminal states", () => {
  it("manual refund query skips protected payment drill refunds without calling provider", async () => {
    const db = makeDb();
    const queryRefund = vi.fn();
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    ...makeRefundRow({
                      id: "rfd-drill-001",
                      refundNo: "DRILL-RFD001",
                    }),
                    providerCode: "mock",
                    providerId: "prov-mock",
                    paymentNo: "DRILL-PAY001",
                    providerTradeNo: "DRILL-ORD001",
                    machineId: "mach-001",
                    providerConfigId: null,
                    fulfillmentState: "manual_handling",
                    isDrill: true,
                    paymentIsDrill: true,
                    orderIsDrill: true,
                  },
                ]),
              }),
            }),
          }),
        }),
      }),
    });

    const service = makeService({ db, queryRefund });

    await expect(
      service.queryRefund("rfd-drill-001", "manual"),
    ).resolves.toEqual({
      status: "processing",
      reconciled: false,
      reason: "protected_payment_drill",
    });
    expect(queryRefund).not.toHaveBeenCalled();
  });

  it("scheduled refund reconciliation skips protected payment drill refunds", async () => {
    const db = makeDb();
    const queryRefund = vi.fn();
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    ...makeRefundRow({
                      id: "rfd-drill-001",
                      refundNo: "DRILL-RFD001",
                    }),
                    providerCode: "mock",
                    providerId: "prov-mock",
                    paymentNo: "DRILL-PAY001",
                    providerTradeNo: "DRILL-ORD001",
                    machineId: "mach-001",
                    providerConfigId: null,
                    fulfillmentState: "manual_handling",
                    isDrill: true,
                    paymentIsDrill: true,
                    orderIsDrill: true,
                  },
                ]),
              }),
            }),
          }),
        }),
      }),
    });

    const service = makeService({ db, queryRefund });

    await service.reconcileProcessingRefunds(
      new Date("2026-06-27T09:00:00.000Z"),
    );

    expect(queryRefund).not.toHaveBeenCalled();
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

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
    mockUpdateSetCapture(db, updateSets);

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

  it("records max_attempts_exceeded once and excludes the refund from later scheduled scans", async () => {
    const db = makeDb();
    const insertValues: Record<string, unknown>[] = [];
    const refundRow = makeRefundRow({
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
                      fulfillmentState: "manual_handling",
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
          where: vi.fn().mockResolvedValue([{ total: 12 }]),
        }),
      })
      .mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([]),
                }),
              }),
            }),
          }),
        }),
      });
    db.insert.mockReturnValue({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        insertValues.push(values);
        return Promise.resolve(undefined);
      }),
    });
    const queryRefund = vi.fn();
    const service = makeService({ db, queryRefund });
    const now = new Date("2026-06-05T00:01:00.000Z");

    await service.reconcileProcessingRefunds(now);
    await service.reconcileProcessingRefunds(now);

    expect(queryRefund).not.toHaveBeenCalled();
    expect(
      insertValues.filter(
        (values) => values["status"] === "max_attempts_exceeded",
      ),
    ).toHaveLength(1);
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
    mockUpdateSetCapture(db, updateSets);
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

describe("RefundsService.queryRefund", () => {
  function mockProcessingRefundSelect(
    db: ReturnType<typeof makeDb>,
    refundRow = makeRefundRow(),
  ) {
    db.select.mockReturnValueOnce({
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
                    fulfillmentState: "manual_handling",
                  },
                ]),
              }),
            }),
          }),
        }),
      }),
    });
    db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ total: 0 }]),
      }),
    });
  }

  it("manual query success applies refunded projection and records attempt", async () => {
    const db = makeDb();
    const updateSets: Record<string, unknown>[] = [];
    mockProcessingRefundSelect(db);

    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "attempt-1" }]),
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "event-1" }]),
        }),
      }),
    });
    mockUpdateSetCapture(db, updateSets);

    const queryRefund = vi.fn().mockResolvedValue({
      status: "succeeded",
      providerRefundNo: "RF_001",
      refundedAt: new Date("2026-06-05T00:00:00.000Z"),
      rawPayload: { refund_status: "SUCCESS" },
    });
    const service = makeService({ db, queryRefund });

    const result = await service.queryRefund("rfd-001", "manual");

    expect(queryRefund).toHaveBeenCalledWith(
      expect.objectContaining({
        refundNo: "RFD001",
        paymentNo: "PAY_WX_001",
        providerTradeNo: "TXN_WX_001",
        amountCents: 500,
      }),
    );
    expect(result).toEqual({ status: "succeeded", reconciled: true });
    expect(updateSets).toContainEqual(
      expect.objectContaining({ status: "refunded" }),
    );
    expect(updateSets).toContainEqual(
      expect.objectContaining({
        status: "succeeded",
        providerRefundStatus: "succeeded",
      }),
    );
  });

  it("manual query confirmed failure is the only terminal failed path", async () => {
    const db = makeDb();
    const updateSets: Record<string, unknown>[] = [];
    mockProcessingRefundSelect(db);

    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "attempt-1" }]),
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "event-1" }]),
        }),
      }),
    });
    mockUpdateSetCapture(db, updateSets);

    const queryRefund = vi.fn().mockResolvedValue({
      status: "failed",
      providerRefundNo: "RF_001",
      refundedAt: null,
      rawPayload: { refund_status: "FAIL" },
    });
    const service = makeService({ db, queryRefund });

    const result = await service.queryRefund("rfd-001", "manual");

    expect(result).toEqual({ status: "failed", reconciled: true });
    expect(updateSets).toContainEqual(
      expect.objectContaining({ status: "failed" }),
    );
    expect(updateSets).toContainEqual(
      expect.objectContaining({
        status: "failed",
        providerRefundStatus: "failed",
      }),
    );
  });

  it("manual query network error records attempt without failing refund", async () => {
    const db = makeDb();
    const updateSets: Record<string, unknown>[] = [];
    mockProcessingRefundSelect(db);

    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "attempt-1" }]),
      }),
    });
    db.update.mockReturnValue({
      set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        updateSets.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    });

    const queryRefund = vi.fn().mockRejectedValue(new Error("gateway timeout"));
    const service = makeService({ db, queryRefund });

    const result = await service.queryRefund("rfd-001", "manual");

    expect(result).toEqual({
      status: "processing",
      reconciled: false,
      reason: "query_failed",
    });
    expect(updateSets).toContainEqual(
      expect.objectContaining({
        status: "network_error",
        errorCode: "query_failed",
        errorMessage: "gateway timeout",
      }),
    );
    expect(updateSets).not.toContainEqual(
      expect.objectContaining({ status: "failed" }),
    );
  });

  it("manual query keeps provider processing refunds non-terminal", async () => {
    const db = makeDb();
    const updateSets: Record<string, unknown>[] = [];
    mockProcessingRefundSelect(db);

    db.insert.mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "attempt-1" }]),
      }),
    });
    mockUpdateSetCapture(db, updateSets);

    const queryRefund = vi.fn().mockResolvedValue({
      status: "processing",
      providerRefundNo: "RF_001",
      refundedAt: null,
      rawPayload: { refund_status: "PROCESSING" },
    });
    const service = makeService({ db, queryRefund });

    const result = await service.queryRefund("rfd-001", "manual");

    expect(result).toEqual({
      status: "processing",
      reconciled: false,
      reason: "provider_processing",
    });
    expect(updateSets).toContainEqual(
      expect.objectContaining({
        status: "processing",
        providerRefundNo: "RF_001",
      }),
    );
    expect(updateSets).toContainEqual(
      expect.objectContaining({
        status: "processing",
        providerRefundStatus: "processing",
      }),
    );
    expect(updateSets).not.toContainEqual(
      expect.objectContaining({ status: "refunded" }),
    );
  });

  it("manual duplicate terminal query records already_terminal without duplicate domain events", async () => {
    const db = makeDb();
    const insertValues: Record<string, unknown>[] = [];
    const updateSets: Record<string, unknown>[] = [];
    mockProcessingRefundSelect(db);

    db.insert.mockReturnValue({
      values: vi.fn().mockImplementation((values: Record<string, unknown>) => {
        insertValues.push(values);
        return {
          returning: vi.fn().mockResolvedValue([{ id: "attempt-1" }]),
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "event-1" }]),
          }),
        };
      }),
    });
    mockUpdateSetCapture(db, updateSets, [false]);

    const queryRefund = vi.fn().mockResolvedValue({
      status: "succeeded",
      providerRefundNo: "RF_001",
      refundedAt: new Date("2026-06-05T00:00:00.000Z"),
      rawPayload: { refund_status: "SUCCESS" },
    });
    const service = makeService({ db, queryRefund });

    const result = await service.queryRefund("rfd-001", "manual");

    expect(result).toEqual({
      status: "succeeded",
      reconciled: false,
      reason: "already_terminal",
    });
    expect(insertValues).toHaveLength(1);
    expect(insertValues).not.toContainEqual(
      expect.objectContaining({ eventType: "refund.succeeded" }),
    );
    expect(updateSets).toContainEqual(
      expect.objectContaining({ status: "already_terminal" }),
    );
    expect(updateSets).not.toContainEqual(
      expect.objectContaining({ status: "refunded" }),
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
