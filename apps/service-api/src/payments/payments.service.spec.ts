import { NotFoundException } from "@nestjs/common";
import { paymentProviderConfigSchema } from "@vem/shared";
import { describe, expect, it, vi } from "vitest";

import type { AuditService } from "../audit/audit.service";
import type { AppConfigService } from "../config/app-config.service";
import type { InventoryService } from "../inventory/inventory.service";
import type { RefundsService } from "../refunds/refunds.service";
import type { VendingService } from "../vending/vending.service";
import type { PaymentConfigSecretService } from "./payment-config-secret.service";
import type { PaymentProviderConfigService } from "./payment-provider-config.service";
import type { PaymentProviderRegistry } from "./payment-provider.registry";

import { PaymentsService } from "./payments.service";

// ---- helpers ---------------------------------------------------------------

function makeDb() {
  const chain = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    execute: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(),
  };

  // Default transaction passes through
  chain.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    return fn(chain);
  });

  // Default select chains
  chain.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        }),
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
      where: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([]),
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            offset: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
    }),
  });

  chain.insert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "evt-001" }]),
      }),
    }),
  });

  chain.update.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  });

  return chain;
}

function makeService(overrides: {
  db?: ReturnType<typeof makeDb>;
  registry?: Partial<PaymentProviderRegistry>;
  configService?: Partial<PaymentProviderConfigService>;
  vendingService?: Partial<VendingService>;
  inventoryService?: Partial<InventoryService>;
  auditService?: Partial<AuditService>;
  refundsService?: Partial<RefundsService>;
}) {
  const db = overrides.db ?? makeDb();
  const registry: PaymentProviderRegistry = {
    get: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    register: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    ...overrides.registry,
  } as unknown as PaymentProviderRegistry;
  const configServiceOverrides = overrides.configService ?? {};
  const configService: PaymentProviderConfigService = {
    listCandidateConfigsForProvider: vi.fn().mockResolvedValue([]),
    listWebhookCandidateConfigsForProvider: vi.fn().mockResolvedValue([]),
    resolveForPayment: vi.fn().mockResolvedValue({
      providerCode: "mock",
      merchantNo: null,
      appId: null,
      publicConfigJson: {},
      sensitiveConfigJson: {},
    }),
    resolveForExistingPayment: vi.fn().mockResolvedValue({
      providerCode: "mock",
      merchantNo: null,
      appId: null,
      publicConfigJson: {},
      sensitiveConfigJson: {},
    }),
    ...configServiceOverrides,
  } as unknown as PaymentProviderConfigService;
  if (
    !("listWebhookCandidateConfigsForProvider" in configServiceOverrides) &&
    "listCandidateConfigsForProvider" in configServiceOverrides
  ) {
    configService.listWebhookCandidateConfigsForProvider =
      configService.listCandidateConfigsForProvider.bind(configService);
  }
  const vendingService: VendingService = {
    createAndDispatchCommands: vi.fn().mockResolvedValue(undefined),
    createPendingDispatchCommands: vi.fn().mockResolvedValue([]),
    dispatchPendingCommandsForOrder: vi.fn().mockResolvedValue([]),
    ...overrides.vendingService,
  } as unknown as VendingService;
  const inventoryService: InventoryService = {
    confirmReservation: vi.fn().mockResolvedValue(undefined),
    ...overrides.inventoryService,
  } as unknown as InventoryService;
  const appConfig: AppConfigService = {
    paymentMockEnabled: true,
    buildPaymentNotifyUrl: (code: string) =>
      `http://localhost:3000/api/payments/webhooks/${code}`,
    getPaymentNotifyUrlStaticCheck: (code: string) => ({
      providerCode: code,
      notifyUrl: `http://localhost:3000/api/payments/webhooks/${code}`,
      configuredBaseUrl: "http://localhost:3000/api/payments/webhooks",
      baseUrlValid: true,
    }),
  } as unknown as AppConfigService;
  const auditService: AuditService = {
    record: vi.fn().mockResolvedValue(undefined),
    ...overrides.auditService,
  } as unknown as AuditService;
  const secretService: PaymentConfigSecretService = {
    encrypt: vi.fn().mockReturnValue({ encrypted: "xxx" }),
    decrypt: vi.fn().mockReturnValue({}),
    summarize: vi.fn().mockReturnValue({}),
  } as unknown as PaymentConfigSecretService;
  const refundsService: RefundsService = {
    applyProviderRefundWebhook: vi.fn().mockResolvedValue({ handled: true }),
    requestFullRefund: vi.fn(),
    queryRefund: vi.fn(),
    ...overrides.refundsService,
  } as unknown as RefundsService;

  return new PaymentsService(
    db as never,
    inventoryService,
    vendingService,
    appConfig,
    registry,
    auditService,
    secretService,
    configService,
    {
      start: vi.fn().mockResolvedValue("attempt-1"),
      finish: vi.fn().mockResolvedValue(undefined),
    } as never,
    refundsService,
  );
}

// ---- tests ------------------------------------------------------------------

describe("PaymentsService", () => {
  describe("listRefunds", () => {
    it("projects drill markers in the admin refund list", async () => {
      const db = makeDb();
      let selectedFields: Record<string, unknown> | undefined;

      db.select
        .mockImplementationOnce((fields: Record<string, unknown>) => {
          selectedFields = fields;
          return {
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  innerJoin: vi.fn().mockReturnValue({
                    where: vi.fn().mockReturnValue({
                      orderBy: vi.fn().mockReturnValue({
                        limit: vi.fn().mockReturnValue({
                          offset: vi.fn().mockResolvedValue([]),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          };
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([{ total: 0 }]),
                }),
              }),
            }),
          }),
        });

      const service = makeService({ db });

      await service.listRefunds({ page: 1, pageSize: 20 });

      expect(selectedFields).toEqual(
        expect.objectContaining({
          isDrill: expect.anything(),
          isTest: expect.anything(),
          scenario: expect.anything(),
        }),
      );
    });

    it("selects recent reconciliation attempts for the admin refund trail", async () => {
      const db = makeDb();
      let selectedFields: Record<string, unknown> | undefined;

      db.select
        .mockImplementationOnce((fields: Record<string, unknown>) => {
          selectedFields = fields;
          return {
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  innerJoin: vi.fn().mockReturnValue({
                    where: vi.fn().mockReturnValue({
                      orderBy: vi.fn().mockReturnValue({
                        limit: vi.fn().mockReturnValue({
                          offset: vi.fn().mockResolvedValue([]),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          };
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([{ total: 0 }]),
                }),
              }),
            }),
          }),
        });

      const service = makeService({ db });

      await service.listRefunds({ page: 1, pageSize: 20 });

      expect(selectedFields).toEqual(
        expect.objectContaining({
          latestReconciliationStatus: expect.anything(),
          reconciliationAttempts: expect.anything(),
        }),
      );
    });

    it("applies the refund reason filter", async () => {
      const db = makeDb();
      const whereArgs: unknown[] = [];

      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockImplementation((whereArg: unknown) => {
                    whereArgs.push(whereArg);
                    return {
                      orderBy: vi.fn().mockReturnValue({
                        limit: vi.fn().mockReturnValue({
                          offset: vi.fn().mockResolvedValue([]),
                        }),
                      }),
                    };
                  }),
                }),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockImplementation((whereArg: unknown) => {
                    whereArgs.push(whereArg);
                    return Promise.resolve([{ total: 0 }]);
                  }),
                }),
              }),
            }),
          }),
        });

      const service = makeService({ db });

      await service.listRefunds({
        page: 1,
        pageSize: 20,
        reason: "auto_dispense_failed",
      });

      expect(whereArgs).toHaveLength(2);
      expect(whereArgs.every((whereArg) => whereArg !== undefined)).toBe(true);
    });
  });

  describe("listPayments", () => {
    it("projects drill markers in the admin payment list", async () => {
      const db = makeDb();
      let selectedFields: Record<string, unknown> | undefined;

      db.select
        .mockImplementationOnce((fields: Record<string, unknown>) => {
          selectedFields = fields;
          return {
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockReturnValue({
                    orderBy: vi.fn().mockReturnValue({
                      limit: vi.fn().mockReturnValue({
                        offset: vi.fn().mockResolvedValue([]),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          };
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([{ total: 0 }]),
              }),
            }),
          }),
        });

      const service = makeService({ db });

      await service.listPayments({ page: 1, pageSize: 20 });

      expect(selectedFields).toEqual(
        expect.objectContaining({
          isDrill: expect.anything(),
          isTest: expect.anything(),
          scenario: expect.anything(),
        }),
      );
    });
  });

  describe("applyProviderPaymentResult", () => {
    it("dispatches only once for duplicate providerEventId", async () => {
      const createPendingDispatchCommands = vi.fn().mockResolvedValue([]);
      const dispatchPendingCommandsForOrder = vi.fn().mockResolvedValue([]);
      const db = makeDb();
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  paymentId: "pay-001",
                  orderId: "ord-001",
                  providerId: "prov-001",
                },
              ]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                {
                  paymentId: "pay-001",
                  paymentStatus: "pending",
                  providerId: "prov-001",
                  orderId: "ord-001",
                  orderStatus: "pending_payment",
                  paymentState: "awaiting_payment",
                  fulfillmentState: "awaiting_fulfillment",
                },
              ]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    orderStatus: "paid",
                    paymentState: "paid",
                    fulfillmentState: "awaiting_fulfillment",
                    paymentStatus: "succeeded",
                  },
                ]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  paymentId: "pay-001",
                  orderId: "ord-001",
                  providerId: "prov-001",
                },
              ]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([{ id: "evt-1" }]),
            }),
          }),
        });

      const service = makeService({
        db,
        vendingService: {
          createPendingDispatchCommands,
          dispatchPendingCommandsForOrder,
        },
      });

      await service.applyProviderPaymentResult({
        paymentId: "pay-001",
        providerTradeNo: "TXN-001",
        status: "succeeded",
        eventType: "payment_code.succeeded",
        providerEventId: "payment_code:PCA001:succeeded",
        rawPayload: {
          out_trade_no: "PAY001",
          total_amount: "1.00",
          app_id: "app-001",
          seller_id: "seller-001",
          trade_status: "TRADE_SUCCESS",
        },
      });
      await service.applyProviderPaymentResult({
        paymentId: "pay-001",
        providerTradeNo: "TXN-001",
        status: "succeeded",
        eventType: "payment_code.succeeded",
        providerEventId: "payment_code:PCA001:succeeded",
        rawPayload: {},
      });

      expect(createPendingDispatchCommands).toHaveBeenCalledTimes(1);
      expect(createPendingDispatchCommands).toHaveBeenCalledWith(db, "ord-001");
      expect(dispatchPendingCommandsForOrder).toHaveBeenCalledTimes(1);
      expect(dispatchPendingCommandsForOrder).toHaveBeenCalledWith("ord-001");
    });

    it("does not dispatch when a late success arrives after cancellation", async () => {
      const createAndDispatchCommands = vi.fn();
      const db = makeDb();
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  paymentId: "pay-001",
                  orderId: "ord-001",
                  providerId: "prov-001",
                },
              ]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                {
                  paymentId: "pay-001",
                  paymentStatus: "canceled",
                  providerId: "prov-001",
                  orderId: "ord-001",
                  orderStatus: "canceled",
                  fulfillmentState: "canceled",
                },
              ]),
            }),
          }),
        });

      const service = makeService({
        db,
        vendingService: { createAndDispatchCommands },
      });

      const applied = await service.applyProviderPaymentResult({
        paymentId: "pay-001",
        providerTradeNo: "TXN-LATE",
        status: "succeeded",
        eventType: "payment_code.succeeded",
        providerEventId: "payment_code:PCA-LATE:succeeded",
        rawPayload: {},
      });

      expect(applied).toBe(false);
      expect(createAndDispatchCommands).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it("does not apply or dispatch provider success for unknown incident-locked payments", async () => {
      const createAndDispatchCommands = vi.fn();
      const db = makeDb();
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  paymentId: "pay-unknown-001",
                  orderId: "ord-unknown-001",
                  providerId: "prov-001",
                },
              ]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                {
                  paymentId: "pay-unknown-001",
                  paymentStatus: "unknown",
                  providerId: "prov-001",
                  orderId: "ord-unknown-001",
                  orderStatus: "pending_payment",
                  paymentState: "awaiting_payment",
                  fulfillmentState: "awaiting_fulfillment",
                },
              ]),
            }),
          }),
        });

      const service = makeService({
        db,
        vendingService: { createAndDispatchCommands },
      });

      const applied = await service.applyProviderPaymentResult({
        paymentId: "pay-unknown-001",
        providerTradeNo: "TXN-UNKNOWN-LATE",
        status: "succeeded",
        eventType: "payment_code.succeeded",
        providerEventId: "payment_code:PCA-UNKNOWN-LATE:succeeded",
        rawPayload: {},
      });

      expect(applied).toBe(false);
      expect(createAndDispatchCommands).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    });

    it("does not cancel an already succeeded payment on a late failure", async () => {
      const db = makeDb();
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  paymentId: "pay-001",
                  orderId: "ord-001",
                  providerId: "prov-001",
                },
              ]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
                {
                  paymentId: "pay-001",
                  paymentStatus: "succeeded",
                  providerId: "prov-001",
                  orderId: "ord-001",
                  orderStatus: "paid",
                  fulfillmentState: "awaiting_fulfillment",
                },
              ]),
            }),
          }),
        });

      const service = makeService({ db });

      const applied = await service.applyProviderPaymentResult({
        paymentId: "pay-001",
        providerTradeNo: "TXN-LATE",
        status: "failed",
        eventType: "payment_code.failed",
        providerEventId: "payment_code:PCA-LATE:failed",
        rawPayload: {},
      });

      expect(applied).toBe(false);
      expect(db.update).not.toHaveBeenCalled();
    });
  });

  describe("reconcilePendingPayments", () => {
    it("skips drill payments without calling the provider", async () => {
      const queryPayment = vi.fn();
      const provider = { queryPayment };

      const db = makeDb();
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: "pay-drill-001",
                    paymentNo: "DRILL-PAY001",
                    providerId: "prov-001",
                    providerCode: "wechat_pay",
                    providerTradeNo: "DRILL-ORD001",
                    orderId: "ord-drill-001",
                    machineId: "mach-001",
                    providerConfigId: null,
                    isDrill: true,
                  },
                ]),
              }),
            }),
          }),
        }),
      });

      const service = makeService({
        db,
        registry: {
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
      });

      const { reconciled } = await service.reconcilePendingPayments();

      expect(reconciled).toBe(0);
      expect(queryPayment).not.toHaveBeenCalled();
    });

    it("applies succeeded status and dispatches the durable command once", async () => {
      const dispatchPendingCommandsForOrder = vi
        .fn()
        .mockResolvedValue(undefined);
      const queryPayment = vi.fn().mockResolvedValue({
        status: "succeeded",
        providerTradeNo: "TXN001",
        rawPayload: {},
      });
      const provider = { queryPayment };

      const db = makeDb();

      // Call 1: reconcile SELECT pending payments
      const call1 = {
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: "pay-001",
                    paymentNo: "PAY001",
                    providerId: "prov-001",
                    providerCode: "wechat_pay",
                    providerTradeNo: null,
                    orderId: "ord-001",
                    machineId: "mach-001",
                  },
                ]),
              }),
            }),
          }),
        }),
      };

      // Call 2: count previous paymentReconciliationAttempts → 0
      const countCall = {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ total: 0 }]),
        }),
      };

      // Call 3 (in tx): check existing event by providerEventId
      const call2 = {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]), // no existing event
          }),
        }),
      };

      // Call 4 (in tx): load payment+order for applyPaymentStatusUpdate
      // .from().innerJoin().where() — awaited directly (no .limit())
      const call3 = {
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                paymentId: "pay-001",
                paymentStatus: "pending",
                orderId: "ord-001",
                orderStatus: "pending_payment",
              },
            ]),
          }),
        }),
      };

      db.select
        .mockReturnValueOnce(call1)
        .mockReturnValueOnce(countCall)
        .mockReturnValueOnce(call2)
        .mockReturnValueOnce(call3);

      db.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn(db),
      );

      // insert event → success (no .returning() in applyPaymentStatusUpdate insert)
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "evt-001" }]),
          }),
          returning: vi.fn().mockResolvedValue([{ id: "evt-001" }]),
        }),
      });

      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const service = makeService({
        db,
        registry: {
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        vendingService: { dispatchPendingCommandsForOrder },
      });

      const { reconciled } = await service.reconcilePendingPayments();
      expect(reconciled).toBe(1);
      expect(queryPayment).toHaveBeenCalledOnce();
      expect(dispatchPendingCommandsForOrder).toHaveBeenCalledWith("ord-001");
    });

    it("skips createAndDispatchCommands when status remains pending", async () => {
      const createAndDispatchCommands = vi.fn();
      const queryPayment = vi.fn().mockResolvedValue({ status: "pending" });
      const provider = { queryPayment };

      const db = makeDb();
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: "pay-002",
                    paymentNo: "PAY002",
                    providerId: "prov-001",
                    providerCode: "wechat_pay",
                    providerTradeNo: null,
                    orderId: "ord-002",
                    machineId: "mach-001",
                  },
                ]),
              }),
            }),
          }),
        }),
      });

      const service = makeService({
        db,
        registry: {
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        vendingService: { createAndDispatchCommands },
      });

      const { reconciled } = await service.reconcilePendingPayments();
      expect(reconciled).toBe(0);
      expect(createAndDispatchCommands).not.toHaveBeenCalled();
    });
  });

  describe("reconcilePendingPaymentOnRead", () => {
    it("skips protected payment drill payments without calling the provider", async () => {
      const queryPayment = vi.fn();
      const provider = { queryPayment };
      const db = makeDb();

      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: "pay-drill-001",
                    paymentNo: "DRILL-PAY001",
                    status: "processing",
                    providerId: "prov-001",
                    providerCode: "wechat_pay",
                    providerTradeNo: "DRILL-ORD001",
                    orderId: "ord-drill-001",
                    machineId: "mach-001",
                    providerConfigId: null,
                    isDrill: true,
                    orderIsDrill: true,
                  },
                ]),
              }),
            }),
          }),
        }),
      });
      const service = makeService({
        db,
        registry: {
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
      });

      await expect(
        service.reconcilePendingPaymentOnRead("pay-drill-001"),
      ).resolves.toEqual({
        status: "processing",
        reconciled: false,
        reason: "protected_payment_drill",
      });
      expect(queryPayment).not.toHaveBeenCalled();
    });
  });

  describe("manualReconcile", () => {
    function mockManualPaymentSelect(
      db: ReturnType<typeof makeDb>,
      payment: {
        id?: string;
        paymentNo?: string;
        status?: string;
        providerId?: string;
        providerCode?: string;
        providerTradeNo?: string | null;
        orderId?: string;
        machineId?: string;
        providerConfigId?: string | null;
        isDrill?: boolean;
        orderIsDrill?: boolean;
      },
    ) {
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: "pay-001",
                    paymentNo: "PAY001",
                    status: "processing",
                    providerId: "prov-001",
                    providerCode: "alipay",
                    providerTradeNo: null,
                    orderId: "ord-001",
                    machineId: "mach-001",
                    providerConfigId: null,
                    isDrill: false,
                    orderIsDrill: false,
                    ...payment,
                  },
                ]),
              }),
            }),
          }),
        }),
      });
    }

    function mockManualAttemptCount(db: ReturnType<typeof makeDb>) {
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ total: 0 }]),
        }),
      });
    }

    function mockManualAttemptInsert(db: ReturnType<typeof makeDb>) {
      db.insert.mockReturnValueOnce({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "reconcile-001" }]),
        }),
      });
    }

    it("queries payment incidents with the payment-time provider config", async () => {
      const db = makeDb();
      mockManualPaymentSelect(db, {
        id: "pay-incident-001",
        paymentNo: "PAY-INCIDENT001",
        providerConfigId: "cfg-payment-time",
      });
      mockManualAttemptCount(db);
      mockManualAttemptInsert(db);
      const queryPayment = vi.fn().mockResolvedValue({
        status: "pending",
        providerTradeNo: null,
        rawPayload: {},
      });
      const config = {
        id: "cfg-payment-time",
        providerCode: "alipay",
        merchantNo: "ALI-MERCHANT-OLD",
        appId: "ALI-APP-OLD",
        publicConfigJson: {},
        sensitiveConfigJson: {},
      };
      const resolveForExistingPayment = vi.fn().mockResolvedValue(config);
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue({ queryPayment }),
        } as unknown as PaymentProviderRegistry,
        configService: { resolveForExistingPayment },
      });

      await expect(
        service.handlePaymentIncidentAction("pay-incident-001", "admin-1", {
          action: "query_payment",
          reason: "operator checks uncertain payment before any handling",
        }),
      ).resolves.toMatchObject({
        action: "query_payment",
        status: "pending",
        handled: false,
        message: "支付结果仍待确认",
      });

      expect(resolveForExistingPayment).toHaveBeenCalledWith({
        providerCode: "alipay",
        providerConfigId: "cfg-payment-time",
        machineId: "mach-001",
        providerConfigSnapshotJson: undefined,
      });
      expect(queryPayment).toHaveBeenCalledWith(
        expect.objectContaining({ config }),
      );
    });

    it("closes uncertain QR payment with the payment-time config without dispatching", async () => {
      const db = makeDb();
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockReturnValue({
                  limit: vi.fn().mockResolvedValue([
                    {
                      paymentId: "pay-close-001",
                      paymentNo: "PAY-CLOSE001",
                      method: "qr_code",
                      paymentStatus: "processing",
                      providerId: "prov-alipay",
                      providerCode: "alipay",
                      providerTradeNo: "ALI-TXN-PENDING",
                      providerConfigId: "cfg-payment-time",
                      providerConfigSnapshotJson: {
                        id: "cfg-payment-time",
                        providerCode: "alipay",
                        merchantNo: "ALI-MERCHANT-OLD",
                      },
                      orderId: "ord-close-001",
                      orderStatus: "pending_payment",
                      machineId: "mach-001",
                      isDrill: false,
                      orderIsDrill: false,
                    },
                  ]),
                }),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        });
      const cancelPayment = vi.fn().mockResolvedValue({ status: "canceled" });
      const createAndDispatchCommands = vi.fn();
      const config = {
        id: "cfg-payment-time",
        providerCode: "alipay",
        merchantNo: "ALI-MERCHANT-OLD",
        appId: "ALI-APP-OLD",
        publicConfigJson: {},
        sensitiveConfigJson: {},
      };
      const resolveForExistingPayment = vi.fn().mockResolvedValue(config);
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue({ cancelPayment }),
        } as unknown as PaymentProviderRegistry,
        configService: { resolveForExistingPayment },
        vendingService: { createAndDispatchCommands },
      });

      await expect(
        service.handlePaymentIncidentAction("pay-close-001", "admin-1", {
          action: "close_or_reverse_uncertain_payment",
          reason: "operator closes uncertain QR payment before retry",
        }),
      ).resolves.toMatchObject({
        action: "close_or_reverse_uncertain_payment",
        status: "canceled",
        handled: true,
      });

      expect(resolveForExistingPayment).toHaveBeenCalledWith({
        providerCode: "alipay",
        providerConfigId: "cfg-payment-time",
        machineId: "mach-001",
        providerConfigSnapshotJson: {
          id: "cfg-payment-time",
          providerCode: "alipay",
          merchantNo: "ALI-MERCHANT-OLD",
        },
      });
      expect(cancelPayment).toHaveBeenCalledWith(
        expect.objectContaining({ config }),
      );
      expect(createAndDispatchCommands).not.toHaveBeenCalled();
    });

    it("reports refund handling acceptance as processing until refund is confirmed", async () => {
      const db = makeDb();
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                orderId: "ord-refund-001",
                paymentNo: "PAY-REFUND001",
              },
            ]),
          }),
        }),
      });
      const requestFullRefund = vi.fn().mockResolvedValue({
        refundNo: "RFD-PROCESSING001",
        status: "processing",
        providerRefundNo: "WX-RFD-001",
      });
      const createAndDispatchCommands = vi.fn();
      const service = makeService({
        db,
        refundsService: { requestFullRefund },
        vendingService: { createAndDispatchCommands },
      });

      await expect(
        service.handlePaymentIncidentAction("pay-refund-001", "admin-1", {
          action: "request_refund_handling",
          reason: "dispense failed and operator requested refund handling",
        }),
      ).resolves.toMatchObject({
        action: "request_refund_handling",
        status: "processing",
        handled: false,
        message: "退款请求已提交，等待渠道确认",
      });

      expect(requestFullRefund).toHaveBeenCalledWith({
        orderId: "ord-refund-001",
        reason: "admin_refund",
        requestedByAdminUserId: "admin-1",
      });
      expect(createAndDispatchCommands).not.toHaveBeenCalled();
    });

    it("skips protected payment drill payments without calling the provider", async () => {
      const queryPayment = vi.fn();
      const provider = { queryPayment };
      const db = makeDb();

      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    id: "pay-drill-001",
                    paymentNo: "DRILL-PAY001",
                    status: "processing",
                    providerId: "prov-001",
                    providerCode: "wechat_pay",
                    providerTradeNo: "DRILL-ORD001",
                    orderId: "ord-drill-001",
                    machineId: "mach-001",
                    providerConfigId: null,
                    isDrill: true,
                    orderIsDrill: true,
                  },
                ]),
              }),
            }),
          }),
        }),
      });
      const audit = { record: vi.fn().mockResolvedValue(undefined) };

      const service = makeService({
        db,
        registry: {
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        auditService: audit,
      });

      await expect(
        service.manualReconcile(
          "pay-drill-001",
          "admin-1",
          "operator verified protected drill should not hit provider",
        ),
      ).resolves.toEqual({
        status: "processing",
        reconciled: false,
        reason: "protected_payment_drill",
      });
      expect(queryPayment).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith({
        adminUserId: "admin-1",
        action: "payments.manual_reconcile",
        resourceType: "payment",
        resourceId: "pay-drill-001",
        afterJson: {
          reason: "operator verified protected drill should not hit provider",
          paymentNo: "DRILL-PAY001",
          providerStatus: "processing",
          applied: false,
          outcome: "protected_payment_drill",
        },
      });
    });

    it("audits already-terminal manual reconcile attempts without calling the provider", async () => {
      const queryPayment = vi.fn();
      const db = makeDb();
      mockManualPaymentSelect(db, {
        id: "pay-terminal-001",
        paymentNo: "PAY-TERM001",
        status: "succeeded",
      });
      const audit = { record: vi.fn().mockResolvedValue(undefined) };
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue({ queryPayment }),
        } as unknown as PaymentProviderRegistry,
        auditService: audit,
      });

      await expect(
        service.manualReconcile(
          "pay-terminal-001",
          "admin-2",
          "operator confirmed provider already terminal",
        ),
      ).resolves.toEqual({
        status: "succeeded",
        reconciled: false,
        reason: "already_terminal",
      });

      expect(queryPayment).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          adminUserId: "admin-2",
          resourceId: "pay-terminal-001",
          afterJson: {
            reason: "operator confirmed provider already terminal",
            paymentNo: "PAY-TERM001",
            providerStatus: "succeeded",
            applied: false,
            outcome: "already_terminal",
          },
        }),
      );
    });

    it("audits provider query failures before rethrowing", async () => {
      const db = makeDb();
      mockManualPaymentSelect(db, {
        id: "pay-query-001",
        paymentNo: "PAY-QUERY001",
      });
      mockManualAttemptCount(db);
      mockManualAttemptInsert(db);
      const providerError = new Error("provider timeout");
      const provider = {
        queryPayment: vi.fn().mockRejectedValue(providerError),
      };
      const audit = { record: vi.fn().mockResolvedValue(undefined) };
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        auditService: audit,
      });

      await expect(
        service.manualReconcile(
          "pay-query-001",
          "admin-3",
          "operator retried uncertain payment query",
        ),
      ).rejects.toThrow("provider timeout");

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          adminUserId: "admin-3",
          resourceId: "pay-query-001",
          afterJson: expect.objectContaining({
            reason: "operator retried uncertain payment query",
            paymentNo: "PAY-QUERY001",
            providerStatus: "processing",
            applied: false,
            outcome: "query_failed",
            errorCode: "query_failed",
          }),
        }),
      );
    });

    it("audits still-uncertain provider statuses without leaking raw provider payload", async () => {
      const db = makeDb();
      mockManualPaymentSelect(db, {
        id: "pay-pending-001",
        paymentNo: "PAY-PENDING001",
      });
      mockManualAttemptCount(db);
      mockManualAttemptInsert(db);
      const provider = {
        queryPayment: vi.fn().mockResolvedValue({
          status: "pending",
          providerTradeNo: "ALI-TXN-001",
          rawPayload: {
            auth_code: "28763443825664394",
            access_token: "provider-secret-token",
          },
        }),
      };
      const audit = { record: vi.fn().mockResolvedValue(undefined) };
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        auditService: audit,
      });

      await expect(
        service.manualReconcile(
          "pay-pending-001",
          "admin-4",
          "operator checked provider pending status",
        ),
      ).resolves.toEqual({
        status: "pending",
        reconciled: false,
        reason: "provider_pending",
      });

      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          adminUserId: "admin-4",
          resourceId: "pay-pending-001",
          afterJson: {
            reason: "operator checked provider pending status",
            paymentNo: "PAY-PENDING001",
            providerStatus: "pending",
            applied: false,
            outcome: "provider_pending",
          },
        }),
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
        "28763443825664394",
      );
      expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
        "provider-secret-token",
      );
    });

    it("queries unknown payments instead of treating them as terminal", async () => {
      const db = makeDb();
      mockManualPaymentSelect(db, {
        id: "pay-unknown-001",
        paymentNo: "PAY-UNKNOWN001",
        status: "unknown",
      });
      mockManualAttemptCount(db);
      mockManualAttemptInsert(db);
      const provider = {
        queryPayment: vi.fn().mockResolvedValue({
          status: "processing",
          providerTradeNo: null,
          rawPayload: {},
        }),
      };
      const audit = { record: vi.fn().mockResolvedValue(undefined) };
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        auditService: audit,
      });

      await expect(
        service.manualReconcile(
          "pay-unknown-001",
          "admin-5",
          "operator checks unknown payment",
        ),
      ).resolves.toEqual({
        status: "processing",
        reconciled: false,
        reason: "provider_processing",
      });

      expect(provider.queryPayment).toHaveBeenCalledOnce();
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({
          resourceId: "pay-unknown-001",
          afterJson: expect.objectContaining({
            providerStatus: "processing",
            outcome: "provider_processing",
          }),
        }),
      );
    });
  });

  describe("handleProviderWebhook", () => {
    function makePaymentSelectMock(
      db: ReturnType<typeof makeDb>,
      paymentRows: unknown[],
    ) {
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue(paymentRows),
              }),
            }),
          }),
        }),
      });
    }

    it("returns {handled:true,duplicate:true} when event already processed", async () => {
      const handleWebhook = vi.fn().mockResolvedValue({
        paymentNo: "PAY001",
        eventType: "provider.payment.succeeded",
        providerEventId: "EVT001",
        signatureValid: true,
        paymentStatus: "succeeded",
        rawPayload: {
          out_trade_no: "PAY001",
          total_amount: "1.00",
          app_id: "app-001",
          seller_id: "seller-001",
          trade_status: "TRADE_SUCCESS",
        },
      });
      const provider = { handleWebhook };

      const db = makeDb();
      const dispatchPendingCommandsForOrder = vi
        .fn()
        .mockResolvedValue(undefined);
      makePaymentSelectMock(db, [
        {
          id: "pay-001",
          providerId: "prov-001",
          status: "pending",
          orderId: "ord-001",
          paymentNo: "PAY001",
          amountCents: 100,
          machineId: "mach-001",
        },
      ]);
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: "evt-existing" }]),
          }),
        }),
      });

      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listCandidateConfigsForProvider: vi.fn().mockResolvedValue([
            {
              id: "cfg-duplicate",
              providerCode: "alipay",
              appId: "app-001",
              merchantNo: "seller-001",
              publicConfigJson: {},
              sensitiveConfigJson: {},
            },
          ]),
        },
        vendingService: { dispatchPendingCommandsForOrder },
      });

      const result = await service.handleProviderWebhook(
        "alipay",
        {},
        { resource: {} },
        "",
      );
      expect(result).toMatchObject({ handled: true, duplicate: true });
      expect(dispatchPendingCommandsForOrder).not.toHaveBeenCalled();
    });

    it("returns {handled:false,reason:'payment_not_found'} when paymentNo not in db", async () => {
      const handleWebhook = vi.fn().mockResolvedValue({
        paymentNo: "UNKNOWN",
        eventType: "provider.payment.succeeded",
        providerEventId: "EVT002",
        signatureValid: true,
        paymentStatus: "succeeded",
        rawPayload: {},
      });
      const provider = { handleWebhook };

      const db = makeDb();
      makePaymentSelectMock(db, []); // not found

      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listCandidateConfigsForProvider: vi.fn().mockResolvedValue([]),
        },
      });

      const result = await service.handleProviderWebhook(
        "wechat_pay",
        {},
        {},
        "",
      );
      expect(result).toMatchObject({
        handled: false,
        reason: "payment_not_found",
      });
    });

    it("passes webhook candidate configs that can include payment-time bindings", async () => {
      const oldBoundConfig = {
        id: "cfg-old-bound",
        providerCode: "wechat_pay",
        merchantNo: "MCH-OLD",
        appId: "APP-OLD",
        publicConfigJson: {},
        sensitiveConfigJson: { apiV3Key: "old-secret" },
      };
      const handleWebhook = vi.fn().mockResolvedValue({
        paymentNo: null,
        eventType: "wechat_pay.webhook",
        providerEventId: "WX_EVT_OLD",
        signatureValid: true,
        paymentStatus: "succeeded",
        rawPayload: {},
      });
      const service = makeService({
        registry: {
          get: vi.fn().mockReturnValue({ handleWebhook }),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listWebhookCandidateConfigsForProvider: vi
            .fn()
            .mockResolvedValue([oldBoundConfig]),
        },
      });

      await service.handleProviderWebhook("wechat_pay", {}, {}, "");

      expect(handleWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateConfigs: [oldBoundConfig],
        }),
      );
    });

    it("passes the payment's exact Alipay config binding into signature verification", async () => {
      const handleWebhook = vi.fn().mockResolvedValue({
        eventKind: "payment",
        paymentNo: null,
        eventType: "alipay.webhook",
        providerEventId: "ALI-BOUND-VERIFY",
        signatureValid: true,
        paymentStatus: null,
        rawPayload: {},
      });
      const immutableBinding = {
        id: "cfg-payment-bound",
        providerCode: "alipay",
        merchantNo: "seller-bound",
        appId: "app-bound",
        publicConfigJson: {},
        sensitiveConfigJson: { alipayPublicCertPem: "old-cert" },
      };
      const db = makeDb();
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  providerConfigId: "cfg-payment-bound",
                  providerConfigSnapshotJson: { version: 1 },
                  machineId: "machine-bound",
                },
              ]),
            }),
          }),
        }),
      });
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue({ handleWebhook }),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listWebhookCandidateConfigsForProvider: vi.fn().mockResolvedValue([]),
          resolveForExistingPayment: vi
            .fn()
            .mockResolvedValue(immutableBinding),
        },
      });

      await service.handleProviderWebhook(
        "alipay",
        {},
        { out_trade_no: "PAY-BOUND-VERIFY" },
        "out_trade_no=PAY-BOUND-VERIFY",
      );

      expect(handleWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          expectedConfigId: "cfg-payment-bound",
          expectedConfig: immutableBinding,
        }),
      );
    });

    it("does not let success webhook unlock payment_unknown manual-handling orders or dispatch", async () => {
      const handleWebhook = vi.fn().mockResolvedValue({
        paymentNo: "PAY-UNKNOWN",
        eventType: "wechat_pay.webhook",
        providerEventId: "WX_EVT_LOCKED",
        signatureValid: true,
        paymentStatus: "succeeded",
        providerTradeNo: "TXN-WX-LOCKED",
        rawPayload: {},
        normalizedPayload: {
          outTradeNo: "PAY-UNKNOWN",
          mchId: "MCH001",
          appId: "wx-app-001",
          amountTotal: 1200,
          amountCurrency: "CNY",
          tradeState: "SUCCESS",
        },
        matchedConfigId: "cfg-old",
      });
      const db = makeDb();
      makePaymentSelectMock(db, [
        {
          id: "pay-unknown",
          providerId: "prov-wx",
          status: "unknown",
          orderId: "ord-unknown",
          orderNo: "ORD-UNKNOWN",
          paymentNo: "PAY-UNKNOWN",
          amountCents: 1200,
          machineId: "mach-001",
          providerConfigId: "cfg-old",
          providerConfigSnapshotJson: null,
        },
      ]);
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                paymentId: "pay-unknown",
                paymentStatus: "unknown",
                providerId: "prov-wx",
                orderId: "ord-unknown",
                orderStatus: "manual_handling",
                paymentState: "payment_unknown",
                fulfillmentState: "manual_handling",
              },
            ]),
          }),
        }),
      });
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "evt-locked" }]),
          }),
        }),
      });
      const createAndDispatchCommands = vi.fn();
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue({ handleWebhook }),
        } as unknown as PaymentProviderRegistry,
        vendingService: { createAndDispatchCommands },
      });

      const result = await service.handleProviderWebhook(
        "wechat_pay",
        {},
        {},
        "",
      );

      expect(result).toMatchObject({ handled: true, duplicate: false });
      expect(db.update).not.toHaveBeenCalled();
      expect(createAndDispatchCommands).not.toHaveBeenCalled();
    });

    it("propagates UnauthorizedException from provider.handleWebhook (invalid signature)", async () => {
      const { UnauthorizedException } = await import("@nestjs/common");
      const handleWebhook = vi
        .fn()
        .mockRejectedValue(new UnauthorizedException("signature invalid"));
      const provider = { handleWebhook };

      const db = makeDb();

      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listCandidateConfigsForProvider: vi.fn().mockResolvedValue([]),
        },
      });

      await expect(
        service.handleProviderWebhook("wechat_pay", {}, {}, "tampered"),
      ).rejects.toThrow(UnauthorizedException);
    });

    it("rejects an Alipay callback verified by a different payment config binding", async () => {
      const handleWebhook = vi.fn().mockResolvedValue({
        paymentNo: "PAY_ALI_BINDING",
        eventType: "alipay.webhook",
        providerEventId: "ALI_BINDING_EVT",
        signatureValid: true,
        paymentStatus: "succeeded",
        providerTradeNo: "2024000",
        matchedConfigId: "cfg-rotated",
        rawPayload: {
          out_trade_no: "PAY_ALI_BINDING",
          total_amount: "1.00",
          app_id: "APP-BOUND",
          seller_id: "MERCHANT-BOUND",
          trade_status: "TRADE_SUCCESS",
        },
      });
      const db = makeDb();
      makePaymentSelectMock(db, [
        {
          id: "pay-ali-binding",
          providerId: "prov-alipay",
          status: "pending",
          orderId: "ord-ali-binding",
          orderNo: "ORD-ALI-BINDING",
          paymentNo: "PAY_ALI_BINDING",
          amountCents: 100,
          machineId: "mach-001",
          providerConfigId: "cfg-bound",
          providerConfigSnapshotJson: {},
        },
      ]);
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue({ handleWebhook }),
        } as unknown as PaymentProviderRegistry,
      });

      await expect(
        service.handleProviderWebhook("alipay", {}, {}, ""),
      ).resolves.toMatchObject({
        handled: false,
        reason: "payment_config_binding_mismatch",
      });
    });

    it("alipay: total_amount mismatch → {handled:false, reason:'alipay_total_amount_mismatch'}", async () => {
      const handleWebhook = vi.fn().mockResolvedValue({
        paymentNo: "PAY_ALI001",
        eventType: "alipay.trade.pay",
        providerEventId: "ALI_EVT001",
        signatureValid: true,
        paymentStatus: "succeeded",
        rawPayload: { out_trade_no: "PAY_ALI001", total_amount: "99.99" },
        providerTradeNo: "2024001",
      });
      const provider = { handleWebhook };

      const db = makeDb();
      makePaymentSelectMock(db, [
        {
          id: "pay-ali-001",
          providerId: "prov-alipay",
          status: "pending",
          orderId: "ord-ali-001",
          paymentNo: "PAY_ALI001",
          amountCents: 500,
          machineId: "mach-001",
        },
      ]);
      // Insert for the business_invalid event
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "evt-invalid" }]),
          }),
        }),
      });

      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listCandidateConfigsForProvider: vi.fn().mockResolvedValue([]),
        },
      });

      const result = await service.handleProviderWebhook("alipay", {}, {}, "");
      expect(result).toMatchObject({
        handled: false,
        reason: "alipay_total_amount_mismatch",
      });
    });

    it("alipay: app_id mismatch → {handled:false, reason:'alipay_app_id_mismatch'}", async () => {
      const handleWebhook = vi.fn().mockResolvedValue({
        paymentNo: "PAY_ALI002",
        eventType: "alipay.trade.pay",
        providerEventId: "ALI_EVT002",
        signatureValid: true,
        paymentStatus: "succeeded",
        rawPayload: {
          out_trade_no: "PAY_ALI002",
          total_amount: "1.00",
          app_id: "WRONG_APP",
          seller_id: "MERCH001",
          trade_status: "TRADE_SUCCESS",
        },
        providerTradeNo: "2024002",
      });
      const provider = { handleWebhook };

      const db = makeDb();
      makePaymentSelectMock(db, [
        {
          id: "pay-ali-002",
          providerId: "prov-alipay",
          status: "pending",
          orderId: "ord-ali-002",
          paymentNo: "PAY_ALI002",
          amountCents: 100,
          machineId: "mach-001",
        },
      ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "evt-invalid" }]),
          }),
        }),
      });

      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listCandidateConfigsForProvider: vi.fn().mockResolvedValue([
            {
              providerCode: "alipay",
              appId: "CORRECT_APP",
              merchantNo: "MERCH001",
              publicConfigJson: {},
              sensitiveConfigJson: {},
            },
          ]),
        },
      });

      const result = await service.handleProviderWebhook("alipay", {}, {}, "");
      expect(result).toMatchObject({
        handled: false,
        reason: "alipay_app_id_mismatch",
      });
    });

    it("alipay: seller_id mismatch → {handled:false, reason:'alipay_seller_id_mismatch'}", async () => {
      const handleWebhook = vi.fn().mockResolvedValue({
        paymentNo: "PAY_ALI003",
        eventType: "alipay.trade.pay",
        providerEventId: "ALI_EVT003",
        signatureValid: true,
        paymentStatus: "succeeded",
        rawPayload: {
          out_trade_no: "PAY_ALI003",
          total_amount: "2.00",
          app_id: "APP001",
          seller_id: "WRONG_SELLER",
          trade_status: "TRADE_SUCCESS",
        },
        providerTradeNo: "2024003",
      });
      const provider = { handleWebhook };

      const db = makeDb();
      makePaymentSelectMock(db, [
        {
          id: "pay-ali-003",
          providerId: "prov-alipay",
          status: "pending",
          orderId: "ord-ali-003",
          paymentNo: "PAY_ALI003",
          amountCents: 200,
          machineId: "mach-001",
        },
      ]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "evt-invalid" }]),
          }),
        }),
      });

      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listCandidateConfigsForProvider: vi.fn().mockResolvedValue([
            {
              providerCode: "alipay",
              appId: "APP001",
              merchantNo: "CORRECT_SELLER",
              publicConfigJson: {},
              sensitiveConfigJson: {},
            },
          ]),
        },
      });

      const result = await service.handleProviderWebhook("alipay", {}, {}, "");
      expect(result).toMatchObject({
        handled: false,
        reason: "alipay_seller_id_mismatch",
      });
    });

    // ---- WeChat Pay business field validation tests ----

    function makeWechatWebhookMock(
      overrides?: Partial<{
        outTradeNo: string;
        mchId: string;
        appId: string;
        amountTotal: number;
        amountCurrency: string;
        tradeState: string;
        transactionId: string;
        paymentStatus: string;
        matchedConfigId: string | null;
      }>,
    ) {
      const defaults = {
        outTradeNo: "PAY_WX_001",
        mchId: "MCH001",
        appId: "wx-app-001",
        amountTotal: 500,
        amountCurrency: "CNY",
        tradeState: "SUCCESS",
        transactionId: "TXN_WX_001",
        paymentStatus: "succeeded",
        matchedConfigId: "cfg-001",
      };
      const vals = { ...defaults, ...overrides };
      return vi.fn().mockResolvedValue({
        paymentNo: vals.outTradeNo,
        eventType: "wechat_pay.webhook",
        providerEventId: "WX_EVT_001",
        signatureValid: true,
        paymentStatus: vals.paymentStatus,
        providerTradeNo: vals.transactionId,
        rawPayload: { body: {}, decrypted: {} },
        normalizedPayload: {
          outTradeNo: vals.outTradeNo,
          mchId: vals.mchId,
          appId: vals.appId,
          amountTotal: vals.amountTotal,
          amountCurrency: vals.amountCurrency,
          tradeState: vals.tradeState,
          transactionId: vals.transactionId,
        },
        matchedConfigId: vals.matchedConfigId,
      });
    }

    function makeWechatPaymentRow(paymentNo = "PAY_WX_001", amountCents = 500) {
      return {
        id: "pay-wx-001",
        providerId: "prov-wx",
        status: "pending",
        orderId: "ord-wx-001",
        paymentNo,
        amountCents,
        machineId: "mach-001",
      };
    }

    const wechatCandidateConfig = {
      id: "cfg-001",
      providerCode: "wechat_pay",
      appId: "wx-app-001",
      merchantNo: "MCH001",
      publicConfigJson: {},
      sensitiveConfigJson: {},
    };

    it("wechat_pay: out_trade_no mismatch => {handled:false, reason:'wechat_out_trade_no_mismatch'}", async () => {
      // Simulate: webhook paymentNo = "PAY_WX_001" (DB lookup), but decrypted
      // outTradeNo = "TAMPERED_TRADE_NO" (differs from DB payment's paymentNo)
      const handleWebhook = vi.fn().mockResolvedValue({
        paymentNo: "PAY_WX_001",
        eventType: "wechat_pay.webhook",
        providerEventId: "WX_EVT_TAMPER",
        signatureValid: true,
        paymentStatus: "succeeded",
        providerTradeNo: "TXN_WX_001",
        rawPayload: {},
        normalizedPayload: {
          outTradeNo: "TAMPERED_TRADE_NO", // does not match DB paymentNo "PAY_WX_001"
          mchId: "MCH001",
          appId: "wx-app-001",
          amountTotal: 500,
          amountCurrency: "CNY",
          tradeState: "SUCCESS",
          transactionId: "TXN_WX_001",
        },
        matchedConfigId: "cfg-001",
      });
      const db = makeDb();
      makePaymentSelectMock(db, [makeWechatPaymentRow("PAY_WX_001", 500)]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "evt-invalid" }]),
          }),
        }),
      });
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue({ handleWebhook }),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listCandidateConfigsForProvider: vi
            .fn()
            .mockResolvedValue([wechatCandidateConfig]),
        },
      });
      const result = await service.handleProviderWebhook(
        "wechat_pay",
        {},
        {},
        "",
      );
      expect(result).toMatchObject({
        handled: false,
        reason: "wechat_out_trade_no_mismatch",
      });
    });

    it("wechat_pay: amount.total mismatch => {handled:false, reason:'wechat_amount_total_mismatch'}", async () => {
      const handleWebhook = makeWechatWebhookMock({ amountTotal: 999 }); // payment has amountCents 500
      const db = makeDb();
      makePaymentSelectMock(db, [makeWechatPaymentRow("PAY_WX_001", 500)]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "evt-invalid" }]),
          }),
        }),
      });
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue({ handleWebhook }),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listCandidateConfigsForProvider: vi
            .fn()
            .mockResolvedValue([wechatCandidateConfig]),
        },
      });
      const result = await service.handleProviderWebhook(
        "wechat_pay",
        {},
        {},
        "",
      );
      expect(result).toMatchObject({
        handled: false,
        reason: "wechat_amount_total_mismatch",
      });
    });

    it("wechat_pay: currency mismatch => {handled:false, reason:'wechat_currency_mismatch'}", async () => {
      const handleWebhook = makeWechatWebhookMock({ amountCurrency: "USD" });
      const db = makeDb();
      makePaymentSelectMock(db, [makeWechatPaymentRow()]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "evt-invalid" }]),
          }),
        }),
      });
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue({ handleWebhook }),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listCandidateConfigsForProvider: vi
            .fn()
            .mockResolvedValue([wechatCandidateConfig]),
        },
      });
      const result = await service.handleProviderWebhook(
        "wechat_pay",
        {},
        {},
        "",
      );
      expect(result).toMatchObject({
        handled: false,
        reason: "wechat_currency_mismatch",
      });
    });

    it("wechat_pay: mchid mismatch => {handled:false, reason:'wechat_mchid_mismatch'}", async () => {
      const handleWebhook = makeWechatWebhookMock({ mchId: "WRONG_MCH" });
      const db = makeDb();
      makePaymentSelectMock(db, [makeWechatPaymentRow()]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "evt-invalid" }]),
          }),
        }),
      });
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue({ handleWebhook }),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listCandidateConfigsForProvider: vi
            .fn()
            .mockResolvedValue([wechatCandidateConfig]),
        },
      });
      const result = await service.handleProviderWebhook(
        "wechat_pay",
        {},
        {},
        "",
      );
      expect(result).toMatchObject({
        handled: false,
        reason: "wechat_mchid_mismatch",
      });
    });

    it("wechat_pay: appid mismatch => {handled:false, reason:'wechat_appid_mismatch'}", async () => {
      const handleWebhook = makeWechatWebhookMock({ appId: "WRONG_APP" });
      const db = makeDb();
      makePaymentSelectMock(db, [makeWechatPaymentRow()]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "evt-invalid" }]),
          }),
        }),
      });
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue({ handleWebhook }),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listCandidateConfigsForProvider: vi
            .fn()
            .mockResolvedValue([wechatCandidateConfig]),
        },
      });
      const result = await service.handleProviderWebhook(
        "wechat_pay",
        {},
        {},
        "",
      );
      expect(result).toMatchObject({
        handled: false,
        reason: "wechat_appid_mismatch",
      });
    });

    it("wechat_pay: trade_state not SUCCESS when claimed succeeded => {handled:false, reason:'wechat_trade_state_not_success'}", async () => {
      const handleWebhook = makeWechatWebhookMock({
        tradeState: "USERPAYING",
        paymentStatus: "succeeded",
      });
      const db = makeDb();
      makePaymentSelectMock(db, [makeWechatPaymentRow()]);
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "evt-invalid" }]),
          }),
        }),
      });
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue({ handleWebhook }),
        } as unknown as PaymentProviderRegistry,
        configService: {
          listCandidateConfigsForProvider: vi
            .fn()
            .mockResolvedValue([wechatCandidateConfig]),
        },
      });
      const result = await service.handleProviderWebhook(
        "wechat_pay",
        {},
        {},
        "",
      );
      expect(result).toMatchObject({
        handled: false,
        reason: "wechat_trade_state_not_success",
      });
    });
  });

  describe("markMockSucceeded (mock payment disabled)", () => {
    it("throws NotFoundException when paymentMockEnabled is false", async () => {
      const service = makeService({});
      // Override config to disable mock
      (
        service as unknown as { config: { paymentMockEnabled: boolean } }
      ).config = {
        paymentMockEnabled: false,
      };
      await expect(
        service.markMockSucceeded("PAY001", "admin"),
      ).rejects.toThrow(NotFoundException);
    });

    it("keeps reservations active and does not confirm inventory on payment success", async () => {
      const db = makeDb();
      const confirmReservation = vi.fn().mockResolvedValue(undefined);
      const createPendingDispatchCommands = vi.fn().mockResolvedValue([]);
      const dispatchPendingCommandsForOrder = vi.fn().mockResolvedValue([]);

      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([
                  {
                    paymentId: "pay-001",
                    paymentNo: "PAY001",
                    paymentStatus: "pending",
                    providerId: "prov-mock",
                    providerCode: "mock",
                    orderId: "ord-001",
                    orderStatus: "pending_payment",
                  },
                ]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                inventoryId: "inv-001",
                quantity: 1,
              },
            ]),
          }),
        });

      const service = makeService({
        db,
        inventoryService: { confirmReservation } as unknown as InventoryService,
        vendingService: {
          createPendingDispatchCommands,
          dispatchPendingCommandsForOrder,
        },
      });

      const result = await service.markMockSucceeded("PAY001", "admin-1");

      expect(result).toMatchObject({
        paymentNo: "PAY001",
        status: "succeeded",
        orderId: "ord-001",
        alreadyHandled: false,
      });
      expect(confirmReservation).not.toHaveBeenCalled();
      expect(createPendingDispatchCommands).toHaveBeenCalledWith(db, "ord-001");
      expect(dispatchPendingCommandsForOrder).toHaveBeenCalledWith("ord-001");
    });
  });

  describe("listProviderConfigs", () => {
    it("returns provider configs without sensitive fields and preserves runtime payment-code settings", async () => {
      const db = makeDb();
      const providerConfigRow = {
        id: "cfg-001",
        providerId: "prov-001",
        providerCode: "wechat_pay",
        providerName: "微信支付",
        machineId: null,
        merchantNo: "MCH001",
        appId: "APP001",
        publicConfigJson: {
          certificateSerialNo: "ABCDEF",
          paymentCodeEnabled: true,
          paymentCodePollIntervalSeconds: 3,
          paymentCodeMaxConfirmSeconds: 30,
          paymentCodeReverseDelaySeconds: 0,
        },
        configEncryptedJson: null,
        status: "disabled",
        updatedByAdminUserId: "admin-1",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockResolvedValue([providerConfigRow]),
          }),
        }),
      });
      const service = makeService({ db });
      const results = await service.listProviderConfigs();
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        providerCode: "wechat_pay",
        providerName: "微信支付",
        derivedNotifyUrl:
          "http://localhost:3000/api/payments/webhooks/wechat_pay",
      });
      expect(results[0]).not.toHaveProperty("sensitiveConfigJson");
      expect(results[0]).not.toHaveProperty("configEncryptedJson");
      expect(results[0]?.publicConfigJson).not.toHaveProperty(
        "paymentCodeEnabled",
      );
      expect(results[0]?.publicConfigJson).toEqual({
        certificateSerialNo: "ABCDEF",
        paymentCodePollIntervalSeconds: 3,
        paymentCodeMaxConfirmSeconds: 30,
        paymentCodeReverseDelaySeconds: 0,
      });
    });
  });

  describe("updateProviderConfig", () => {
    it("returns the admin provider config DTO without encrypted secret fields", async () => {
      const db = makeDb();
      const now = new Date("2026-06-26T04:00:00.000Z");
      const existingRow = {
        id: "550e8400-e29b-41d4-a716-446655440011",
        providerId: "550e8400-e29b-41d4-a716-446655440022",
        machineId: null,
        merchantNo: "MCH001",
        appId: "APP001",
        publicConfigJson: {
          mode: "sandbox",
          gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
          keyType: "PKCS8",
        },
        configEncryptedJson: { encrypted: "secret" },
        status: "disabled",
      };
      const updatedRow = {
        ...existingRow,
        merchantNo: "MCH002",
        updatedByAdminUserId: "550e8400-e29b-41d4-a716-446655440033",
        createdAt: now,
        updatedAt: now,
      };

      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([existingRow]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi
                .fn()
                .mockResolvedValue([{ code: "alipay", name: "Alipay" }]),
            }),
          }),
        });
      db.update.mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([updatedRow]),
          }),
        }),
      });

      const service = makeService({ db });
      const result = await service.updateProviderConfig(
        "550e8400-e29b-41d4-a716-446655440011",
        "550e8400-e29b-41d4-a716-446655440033",
        { merchantNo: "MCH002" },
      );

      const parsed = paymentProviderConfigSchema.parse(result);
      expect(parsed).toMatchObject({
        providerCode: "alipay",
        providerName: "Alipay",
        merchantNo: "MCH002",
        derivedNotifyUrl: "http://localhost:3000/api/payments/webhooks/alipay",
        secretStatusJson: expect.any(Object),
      });
      expect(result).not.toHaveProperty("configEncryptedJson");
      expect(result).not.toHaveProperty("sensitiveConfigJson");
    });

    it("preserves runtime payment-code public settings when updating merchant config", async () => {
      const db = makeDb();
      const now = new Date("2026-06-26T04:00:00.000Z");
      const existingRow = {
        id: "550e8400-e29b-41d4-a716-446655440011",
        providerId: "550e8400-e29b-41d4-a716-446655440022",
        machineId: null,
        merchantNo: "MCH001",
        appId: "APP001",
        publicConfigJson: {
          mode: "sandbox",
          gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
          keyType: "PKCS8",
          paymentCodeEnabled: true,
          paymentCodePollIntervalSeconds: 3,
          paymentCodeMaxConfirmSeconds: 30,
        },
        configEncryptedJson: null,
        status: "disabled",
      };
      const updatedPublicConfigJson = {
        mode: "sandbox",
        gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
        keyType: "PKCS8",
        qrExpiresMinutes: 15,
        timeoutCompensationSeconds: 180,
        paymentCodePollIntervalSeconds: 3,
        paymentCodeMaxConfirmSeconds: 30,
      };
      const updatedRow = {
        ...existingRow,
        merchantNo: "MCH002",
        publicConfigJson: updatedPublicConfigJson,
        updatedByAdminUserId: "550e8400-e29b-41d4-a716-446655440033",
        createdAt: now,
        updatedAt: now,
      };
      const set = vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([updatedRow]),
        }),
      });

      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([existingRow]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi
                .fn()
                .mockResolvedValue([{ code: "alipay", name: "Alipay" }]),
            }),
          }),
        });
      db.update.mockReturnValue({ set });

      const service = makeService({ db });
      const result = await service.updateProviderConfig(
        "550e8400-e29b-41d4-a716-446655440011",
        "550e8400-e29b-41d4-a716-446655440033",
        {
          merchantNo: "MCH002",
          publicConfigJson: { timeoutCompensationSeconds: 180 },
        },
      );

      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          publicConfigJson: updatedPublicConfigJson,
        }),
      );
      expect(result.publicConfigJson).toEqual(updatedPublicConfigJson);
      expect(result.publicConfigJson).not.toHaveProperty("paymentCodeEnabled");
    });
  });

  describe("upsertProviderConfig", () => {
    it("returns the admin provider config DTO without encrypted secret fields", async () => {
      const db = makeDb();
      const now = new Date("2026-06-26T04:00:00.000Z");
      const savedRow = {
        id: "550e8400-e29b-41d4-a716-446655440111",
        providerId: "550e8400-e29b-41d4-a716-446655440222",
        providerCode: "alipay",
        providerName: "Alipay",
        machineId: null,
        merchantNo: "MCH001",
        appId: "APP001",
        publicConfigJson: {
          mode: "sandbox",
          gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
          keyType: "PKCS8",
        },
        configEncryptedJson: { encrypted: "secret" },
        status: "enabled",
        updatedByAdminUserId: "550e8400-e29b-41d4-a716-446655440333",
        createdAt: now,
        updatedAt: now,
      };

      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi
                .fn()
                .mockResolvedValue([
                  { id: savedRow.providerId, name: "Alipay" },
                ]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]),
            }),
          }),
        });
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([savedRow]),
        }),
      });

      const service = makeService({ db });
      const result = await service.upsertProviderConfig(
        "550e8400-e29b-41d4-a716-446655440333",
        {
          providerCode: "alipay",
          merchantNo: "MCH001",
          appId: "APP001",
          publicConfigJson: {
            mode: "sandbox",
            gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
            keyType: "PKCS8",
          },
          sensitiveConfigJson: {
            privateKeyPem: "key",
            appCertPem: "app-cert",
            alipayPublicCertPem: "public-cert",
            alipayRootCertPem: "root-cert",
          },
          status: "enabled",
        },
      );

      const parsed = paymentProviderConfigSchema.parse(result);
      expect(parsed).toMatchObject({
        providerCode: "alipay",
        providerName: "Alipay",
        derivedNotifyUrl: "http://localhost:3000/api/payments/webhooks/alipay",
        secretStatusJson: expect.any(Object),
      });
      expect(result).not.toHaveProperty("configEncryptedJson");
      expect(result).not.toHaveProperty("sensitiveConfigJson");
    });

    it("creates new config and calls auditService.record with create action", async () => {
      const db = makeDb();
      const mockRecord = vi.fn().mockResolvedValue(undefined);
      const mockEncrypt = vi.fn().mockReturnValue({ encrypted: "xxx" });
      const mockDecrypt = vi.fn().mockReturnValue({});
      const mockSummarize = vi.fn().mockReturnValue({});

      // 1) find provider
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: "prov-001" }]),
          }),
        }),
      });
      // 2) find existing config → none
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
      // insert returning
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "cfg-new" }]),
        }),
      });

      const secretService: PaymentConfigSecretService = {
        encrypt: mockEncrypt,
        decrypt: mockDecrypt,
        summarize: mockSummarize,
      } as unknown as PaymentConfigSecretService;
      const auditService: AuditService = {
        record: mockRecord,
      } as unknown as AuditService;

      const service = new (await import("./payments.service")).PaymentsService(
        db as never,
        { confirmReservation: vi.fn() } as never,
        { createAndDispatchCommands: vi.fn() } as never,
        {
          paymentMockEnabled: false,
          buildPaymentNotifyUrl: (code: string) =>
            `http://localhost:3000/api/payments/webhooks/${code}`,
          getPaymentNotifyUrlStaticCheck: () => ({}) as never,
        } as never,
        {
          get: vi.fn(),
          has: vi.fn().mockReturnValue(false),
          register: vi.fn(),
          list: vi.fn().mockReturnValue([]),
        } as never,
        auditService,
        secretService,
        {
          listCandidateConfigsForProvider: vi.fn(),
          resolveForPayment: vi.fn(),
          resolveForExistingPayment: vi.fn(),
        } as never,
        {
          start: vi.fn().mockResolvedValue("attempt-1"),
          finish: vi.fn().mockResolvedValue(undefined),
        } as never,
        {
          applyProviderRefundWebhook: vi
            .fn()
            .mockResolvedValue({ handled: true }),
        } as never,
      );

      await service.upsertProviderConfig("admin-1", {
        providerCode: "wechat_pay",
        machineId: null,
        merchantNo: "MCH001",
        appId: "APP001",
        publicConfigJson: {
          certificateSerialNo: "SN123",
          platformCertificateSerialNo: "PLAT_SN123",
        },
        sensitiveConfigJson: {
          apiV3Key: "key",
          privateKeyPem: "pem",
          platformPublicKeyPem: "pub",
        },
        status: "enabled",
      });

      expect(mockRecord).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "payments.provider_config.create",
          resourceType: "payment_provider_config",
        }),
      );
    });

    it("clears nullable merchant identifiers when upsert explicitly sends null", async () => {
      const db = makeDb();
      const existingRow = {
        id: "550e8400-e29b-41d4-a716-446655440111",
        merchantNo: "OLD-MCH",
        appId: "OLD-APP",
        publicConfigJson: {
          mode: "sandbox",
          gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
          keyType: "PKCS8",
        },
        configEncryptedJson: null,
        status: "disabled",
      };
      const now = new Date("2026-06-26T04:00:00.000Z");
      let patch: Record<string, unknown> | undefined;

      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "550e8400-e29b-41d4-a716-446655440222",
                  name: "Alipay",
                },
              ]),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([existingRow]),
            }),
          }),
        });
      db.update.mockReturnValue({
        set: vi.fn((value: Record<string, unknown>) => {
          patch = value;
          return {
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([
                {
                  ...existingRow,
                  ...value,
                  providerId: "550e8400-e29b-41d4-a716-446655440222",
                  createdAt: now,
                  updatedAt: now,
                },
              ]),
            }),
          };
        }),
      });

      const service = makeService({ db });
      const result = await service.upsertProviderConfig(
        "550e8400-e29b-41d4-a716-446655440333",
        {
          providerCode: "alipay",
          merchantNo: null,
          appId: null,
          status: "disabled",
        },
      );

      expect(patch).toMatchObject({
        merchantNo: null,
        appId: null,
      });
      expect(result).toMatchObject({
        merchantNo: null,
        appId: null,
      });
    });

    it("throws ConflictException when enabled wechat_pay config is missing required fields", async () => {
      const { ConflictException } = await import("@nestjs/common");
      const db = makeDb();
      // 1) find provider
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{ id: "prov-001" }]),
          }),
        }),
      });
      // 2) no existing config
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const service = makeService({ db });
      await expect(
        service.upsertProviderConfig("admin-1", {
          providerCode: "wechat_pay",
          machineId: null,
          merchantNo: "MCH001",
          appId: "APP001",
          publicConfigJson: {},
          sensitiveConfigJson: {},
          status: "enabled",
        }),
      ).rejects.toThrow(ConflictException);
    });
  });

  describe("expireOverduePayments", () => {
    function makeOverdueSelectMock(
      db: ReturnType<typeof makeDb>,
      overdueRows: unknown[],
    ) {
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              leftJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue(overdueRows),
              }),
            }),
          }),
        }),
      });
    }

    function makeLocalExpiryTransitionMocks(
      db: ReturnType<typeof makeDb>,
      input: {
        paymentId: string;
        orderId: string;
        expiresAt: Date;
      },
    ) {
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                paymentId: input.paymentId,
                paymentStatus: "pending",
                paymentExpiresAt: input.expiresAt,
                paymentIsDrill: false,
                orderId: input.orderId,
                orderStatus: "pending_payment",
                paymentState: "awaiting_payment",
                fulfillmentState: "awaiting_fulfillment",
                orderIsDrill: false,
              },
            ]),
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
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: input.paymentId }]),
          }),
        }),
      });
    }

    it("query succeeds → calls applyPaymentStatusUpdate + dispatches, no cancel", async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() - 10_000); // 10s ago
      const queryPayment = vi.fn().mockResolvedValue({
        status: "succeeded",
        providerTradeNo: "TXN_ALIPAY_001",
        rawPayload: {},
      });
      const cancelPayment = vi.fn().mockResolvedValue({});
      const provider = { queryPayment, cancelPayment };

      const db = makeDb();
      makeOverdueSelectMock(db, [
        {
          paymentId: "pay-exp-001",
          paymentNo: "PAY_EXP001",
          providerId: "prov-alipay",
          providerCode: "alipay",
          providerTradeNo: null,
          orderId: "ord-exp-001",
          orderStatus: "pending_payment",
          machineId: "mach-001",
          expiresAt,
          publicConfigJson: {},
        },
      ]);

      // nextPaymentReconciliationAttemptNo: count query
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ total: 0 }]),
        }),
      });
      // applyPaymentStatusUpdate: check existing event (none) + select payment+order + insert event + update payment
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]), // no existing event
          }),
        }),
      });
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                paymentId: "pay-exp-001",
                paymentStatus: "pending",
                orderId: "ord-exp-001",
                orderStatus: "pending_payment",
              },
            ]),
          }),
        }),
      });

      const insertedValues: unknown[] = [];
      db.insert.mockImplementation((_table: unknown) => ({
        values: vi.fn().mockImplementation((vals: unknown) => {
          insertedValues.push(vals);
          return {
            onConflictDoNothing: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([{ id: "evt-001" }]),
            }),
            returning: vi.fn().mockResolvedValue([{ id: "attempt-001" }]),
          };
        }),
      }));

      const dispatchPendingCommandsForOrder = vi
        .fn()
        .mockResolvedValue(undefined);
      const service = makeService({
        db,
        registry: {
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        configService: {
          resolveForPayment: vi.fn().mockResolvedValue({
            providerCode: "alipay",
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }),
          resolveForExistingPayment: vi.fn().mockResolvedValue({
            providerCode: "alipay",
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }),
        },
        vendingService: { dispatchPendingCommandsForOrder },
      });

      const result = await service.expireOverduePayments(now);
      expect(queryPayment).toHaveBeenCalled();
      expect(cancelPayment).not.toHaveBeenCalled();
      expect(dispatchPendingCommandsForOrder).toHaveBeenCalledWith(
        "ord-exp-001",
      );
      expect(result.processed).toBeGreaterThanOrEqual(1);
      expect(insertedValues).toContainEqual(
        expect.objectContaining({
          paymentId: "pay-exp-001",
          providerId: "prov-alipay",
          trigger: "expire_compensation",
          attemptNo: 1,
          status: "succeeded",
          providerPaymentStatus: "succeeded",
          providerTradeNo: "TXN_ALIPAY_001",
        }),
      );
    });

    it("query pending inside compensation window → records reconciliation attempt and keeps order pending", async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() - 10_000);
      const queryPayment = vi.fn().mockResolvedValue({
        status: "pending",
        providerTradeNo: null,
        rawPayload: { trade_state: "WAIT_BUYER_PAY" },
      });
      const cancelPayment = vi.fn();
      const provider = { queryPayment, cancelPayment };

      const db = makeDb();
      makeOverdueSelectMock(db, [
        {
          paymentId: "pay-exp-confirming-001",
          paymentNo: "PAY_CONFIRMING001",
          providerId: "prov-alipay",
          providerCode: "alipay",
          providerTradeNo: null,
          orderId: "ord-exp-confirming-001",
          orderStatus: "pending_payment",
          machineId: "mach-001",
          expiresAt,
          publicConfigJson: {},
        },
      ]);
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ total: 0 }]),
        }),
      });

      const insertedValues: unknown[] = [];
      db.insert.mockImplementation((_table: unknown) => ({
        values: vi.fn().mockImplementation((vals: unknown) => {
          insertedValues.push(vals);
          return {
            onConflictDoNothing: vi.fn().mockResolvedValue([]),
            returning: vi.fn().mockResolvedValue([]),
          };
        }),
      }));
      const releaseReservation = vi.fn();
      const service = makeService({
        db,
        registry: {
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        configService: {
          resolveForExistingPayment: vi.fn().mockResolvedValue({
            providerCode: "alipay",
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }),
        },
        inventoryService: {
          releaseReservation,
        } as unknown as InventoryService,
      });

      const result = await service.expireOverduePayments(now);

      expect(result.processed).toBe(0);
      expect(queryPayment).toHaveBeenCalled();
      expect(cancelPayment).not.toHaveBeenCalled();
      expect(releaseReservation).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
      expect(insertedValues).toContainEqual(
        expect.objectContaining({
          paymentId: "pay-exp-confirming-001",
          providerId: "prov-alipay",
          trigger: "expire_compensation",
          attemptNo: 1,
          status: "pending",
          providerPaymentStatus: "pending",
          providerTradeNo: null,
        }),
      );
    });

    it.each(["failed", "expired", "canceled"] as const)(
      "query %s inside compensation window → expires locally without waiting",
      async (providerStatus) => {
        const now = new Date();
        const expiresAt = new Date(now.getTime() - 10_000);
        const queryPayment = vi.fn().mockResolvedValue({
          status: providerStatus,
          providerTradeNo: "TXN_TERMINAL_001",
          rawPayload: { trade_state: providerStatus },
        });
        const cancelPayment = vi.fn();
        const provider = { queryPayment, cancelPayment };

        const db = makeDb();
        makeOverdueSelectMock(db, [
          {
            paymentId: `pay-exp-${providerStatus}-001`,
            paymentNo: `PAY_${providerStatus.toUpperCase()}001`,
            providerId: "prov-alipay",
            providerCode: "alipay",
            providerTradeNo: "TXN_TERMINAL_001",
            orderId: `ord-exp-${providerStatus}-001`,
            orderStatus: "pending_payment",
            machineId: "mach-001",
            expiresAt,
            publicConfigJson: {},
          },
        ]);
        makeLocalExpiryTransitionMocks(db, {
          paymentId: `pay-exp-${providerStatus}-001`,
          orderId: `ord-exp-${providerStatus}-001`,
          expiresAt,
        });
        db.select.mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                inventoryId: "inv-terminal-001",
                quantity: 1,
              },
            ]),
          }),
        });

        const releaseReservation = vi.fn().mockResolvedValue(undefined);
        const service = makeService({
          db,
          registry: {
            has: vi.fn().mockReturnValue(true),
            get: vi.fn().mockReturnValue(provider),
          } as unknown as PaymentProviderRegistry,
          configService: {
            resolveForExistingPayment: vi.fn().mockResolvedValue({
              providerCode: "alipay",
              merchantNo: null,
              appId: null,
              publicConfigJson: {},
              sensitiveConfigJson: {},
            }),
          },
          inventoryService: {
            releaseReservation,
          } as unknown as InventoryService,
        });

        const result = await service.expireOverduePayments(now);

        expect(result.processed).toBe(1);
        expect(queryPayment).toHaveBeenCalled();
        expect(cancelPayment).not.toHaveBeenCalled();
        expect(db.transaction).toHaveBeenCalled();
        expect(releaseReservation).toHaveBeenCalledWith(db, {
          orderId: `ord-exp-${providerStatus}-001`,
          inventoryId: "inv-terminal-001",
          quantity: 1,
          reason: "payment_expired",
        });
      },
    );

    it("query pending + past compensation window → cancel provider → expire locally", async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() - 200_000); // 200s ago, beyond 120s window
      const queryPayment = vi.fn().mockResolvedValue({
        status: "pending",
        providerTradeNo: null,
        rawPayload: {},
      });
      const cancelPayment = vi.fn().mockResolvedValue({});
      const provider = { queryPayment, cancelPayment };

      const db = makeDb();
      makeOverdueSelectMock(db, [
        {
          paymentId: "pay-exp-002",
          paymentNo: "PAY_EXP002",
          providerId: "prov-alipay",
          providerCode: "alipay",
          providerTradeNo: null,
          orderId: "ord-exp-002",
          orderStatus: "pending_payment",
          machineId: "mach-001",
          expiresAt,
          publicConfigJson: {},
        },
      ]);
      makeLocalExpiryTransitionMocks(db, {
        paymentId: "pay-exp-002",
        orderId: "ord-exp-002",
        expiresAt,
      });

      // reservation query resolves directly at .where() level (no .limit() call)
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const service = makeService({
        db,
        registry: {
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        configService: {
          resolveForPayment: vi.fn().mockResolvedValue({
            providerCode: "alipay",
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }),
          resolveForExistingPayment: vi.fn().mockResolvedValue({
            providerCode: "alipay",
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }),
        },
      });

      await service.expireOverduePayments(now);
      expect(queryPayment).toHaveBeenCalled();
      expect(cancelPayment).toHaveBeenCalled();
    });

    it("trade not found after compensation window → expires locally and releases reservation", async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() - 200_000); // 200s ago, beyond 120s window

      const queryPayment = vi
        .fn()
        .mockRejectedValue(new Error("交易不存在 (traceId: sandbox-001)"));
      const cancelPayment = vi.fn();
      const provider = { queryPayment, cancelPayment };

      const db = makeDb();
      makeOverdueSelectMock(db, [
        {
          paymentId: "pay-missing-trade-001",
          paymentNo: "PAY_MISSING001",
          providerId: "prov-alipay",
          providerCode: "alipay",
          providerTradeNo: null,
          orderId: "ord-missing-trade-001",
          orderStatus: "pending_payment",
          machineId: "mach-001",
          expiresAt,
          publicConfigJson: {},
        },
      ]);
      makeLocalExpiryTransitionMocks(db, {
        paymentId: "pay-missing-trade-001",
        orderId: "ord-missing-trade-001",
        expiresAt,
      });

      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([
            {
              inventoryId: "inv-001",
              quantity: 1,
            },
          ]),
        }),
      });

      const releaseReservation = vi.fn().mockResolvedValue(undefined);
      const service = makeService({
        db,
        registry: {
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        configService: {
          resolveForPayment: vi.fn().mockResolvedValue({
            providerCode: "alipay",
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }),
          resolveForExistingPayment: vi.fn().mockResolvedValue({
            providerCode: "alipay",
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }),
        },
        inventoryService: {
          releaseReservation,
        } as unknown as InventoryService,
      });

      const result = await service.expireOverduePayments(now);
      expect(queryPayment).toHaveBeenCalled();
      expect(cancelPayment).not.toHaveBeenCalled();
      expect(releaseReservation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orderId: "ord-missing-trade-001",
          inventoryId: "inv-001",
          quantity: 1,
          reason: "payment_expired",
        }),
      );
      expect(result.processed).toBe(1);
    });

    it("queryPayment throws → processed=0, no releaseReservation, reconciliation attempt inserted", async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() - 10_000);

      const queryPayment = vi.fn().mockRejectedValue(new Error("network down"));
      const provider = { queryPayment };

      const db = makeDb();
      makeOverdueSelectMock(db, [
        {
          paymentId: "pay-fail-001",
          paymentNo: "PAY_FAIL001",
          providerId: "prov-alipay",
          providerCode: "alipay",
          providerTradeNo: null,
          orderId: "ord-fail-001",
          orderStatus: "pending_payment",
          machineId: "mach-001",
          expiresAt,
          publicConfigJson: {},
        },
      ]);

      // nextPaymentReconciliationAttemptNo: count query
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ total: 0 }]),
        }),
      });

      const insertedTables: unknown[] = [];
      const insertedValues: unknown[] = [];
      db.insert.mockImplementation((table: unknown) => ({
        values: vi.fn().mockImplementation((vals: unknown) => {
          insertedTables.push(table);
          insertedValues.push(vals);
          return {
            onConflictDoNothing: vi.fn().mockResolvedValue([]),
            returning: vi.fn().mockResolvedValue([]),
          };
        }),
      }));

      const releaseReservation = vi.fn();
      const service = makeService({
        db,
        registry: {
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        configService: {
          resolveForPayment: vi.fn().mockResolvedValue({
            providerCode: "alipay",
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }),
          resolveForExistingPayment: vi.fn().mockResolvedValue({
            providerCode: "alipay",
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }),
        },
        inventoryService: {
          releaseReservation,
        } as unknown as InventoryService,
      });

      const result = await service.expireOverduePayments(now);
      expect(result.processed).toBe(0);
      expect(releaseReservation).not.toHaveBeenCalled();
      // Should have inserted reconciliation attempt
      const reconIdx = insertedValues.findIndex(
        (v) =>
          typeof v === "object" &&
          v !== null &&
          (v as Record<string, unknown>)["status"] === "network_error",
      );
      expect(reconIdx).toBeGreaterThanOrEqual(0);
    });

    it("queryPayment returns pending and cancelPayment throws → no local expire", async () => {
      const now = new Date();
      const expiresAt = new Date(now.getTime() - 200_000); // beyond compensation window

      const queryPayment = vi.fn().mockResolvedValue({
        status: "pending",
        providerTradeNo: null,
        rawPayload: {},
      });
      const cancelPayment = vi
        .fn()
        .mockRejectedValue(new Error("cancel timeout"));
      const provider = { queryPayment, cancelPayment };

      const db = makeDb();
      makeOverdueSelectMock(db, [
        {
          paymentId: "pay-fail-002",
          paymentNo: "PAY_FAIL002",
          providerId: "prov-alipay",
          providerCode: "alipay",
          providerTradeNo: null,
          orderId: "ord-fail-002",
          orderStatus: "pending_payment",
          machineId: "mach-001",
          expiresAt,
          publicConfigJson: {},
        },
      ]);

      // nextPaymentReconciliationAttemptNo: count query
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ total: 0 }]),
        }),
      });

      const insertedValues: unknown[] = [];
      db.insert.mockImplementation((_table: unknown) => ({
        values: vi.fn().mockImplementation((vals: unknown) => {
          insertedValues.push(vals);
          return {
            onConflictDoNothing: vi.fn().mockResolvedValue([]),
            returning: vi.fn().mockResolvedValue([]),
          };
        }),
      }));

      const releaseReservation = vi.fn();
      const service = makeService({
        db,
        registry: {
          has: vi.fn().mockReturnValue(true),
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        configService: {
          resolveForPayment: vi.fn().mockResolvedValue({
            providerCode: "alipay",
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }),
          resolveForExistingPayment: vi.fn().mockResolvedValue({
            providerCode: "alipay",
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }),
        },
        inventoryService: {
          releaseReservation,
        } as unknown as InventoryService,
      });

      const result = await service.expireOverduePayments(now);
      expect(result.processed).toBe(0);
      expect(releaseReservation).not.toHaveBeenCalled();
      const reconIdx = insertedValues.findIndex(
        (v) =>
          typeof v === "object" &&
          v !== null &&
          (v as Record<string, unknown>)["status"] === "network_error",
      );
      expect(reconIdx).toBeGreaterThanOrEqual(0);
    });
  });
});
