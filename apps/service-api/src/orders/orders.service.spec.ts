import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { InventoryService } from "../inventory/inventory.service";
import type { PaymentProviderConfigService } from "../payments/payment-provider-config.service";
import type { PaymentProviderRegistry } from "../payments/payment-provider.registry";
import type { RefundsService } from "../refunds/refunds.service";

import { OrdersService } from "./orders.service";

function makeDb() {
  return {
    select: vi.fn(),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    transaction: vi
      .fn()
      .mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn(undefined),
      ),
  };
}

function makeService(overrides: {
  db?: ReturnType<typeof makeDb>;
  registry?: Partial<PaymentProviderRegistry>;
  configService?: Partial<PaymentProviderConfigService>;
}) {
  const db = overrides.db ?? makeDb();
  const registry: PaymentProviderRegistry = {
    get: vi.fn(),
    has: vi.fn().mockReturnValue(false),
    register: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    ...overrides.registry,
  } as unknown as PaymentProviderRegistry;
  const configService: PaymentProviderConfigService = {
    resolveForPayment: vi.fn().mockResolvedValue({
      providerCode: "mock",
      merchantNo: null,
      appId: null,
      publicConfigJson: {},
      sensitiveConfigJson: {},
    }),
    listMachinePaymentOptionsForMachine: vi.fn().mockResolvedValue({
      machineId: "mach-1",
      options: [],
    }),
    ...overrides.configService,
  } as unknown as PaymentProviderConfigService;
  const inventoryService: InventoryService = {
    reserveForOrder: vi.fn().mockResolvedValue(undefined),
    reserveItems: vi.fn().mockResolvedValue(undefined),
  } as unknown as InventoryService;
  const refundsService: RefundsService = {
    requestRefund: vi.fn().mockResolvedValue(undefined),
  } as unknown as RefundsService;

  return new OrdersService(
    db as never,
    inventoryService,
    registry,
    configService,
    refundsService,
  );
}

describe("OrdersService", () => {
  describe("createMachineOrder", () => {
    it("throws NotFoundException when machine not found", async () => {
      const db = makeDb();
      // machine lookup returns empty
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

      const service = makeService({ db });
      await expect(
        service.createMachineOrder({
          machineCode: "M001",
          items: [{ inventoryId: "inv-1", quantity: 1 }],
          paymentMethod: "qr_code",
          paymentProviderCode: "wechat_pay",
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it("throws ConflictException when machine is not online", async () => {
      const db = makeDb();
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { id: "mach-1", code: "M001", status: "offline" },
            ]),
        }),
      });

      const service = makeService({ db });
      await expect(
        service.createMachineOrder({
          machineCode: "M001",
          items: [{ inventoryId: "inv-1", quantity: 1 }],
          paymentMethod: "qr_code",
          paymentProviderCode: "wechat_pay",
        }),
      ).rejects.toThrow(ConflictException);
    });

    it("rejects mock method with alipay provider before creating local draft", async () => {
      const db = makeDb();
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { id: "mach-1", code: "M001", status: "online" },
            ]),
        }),
      });

      const service = makeService({ db });
      await expect(
        service.createMachineOrder({
          machineCode: "M001",
          items: [
            {
              inventoryId: "550e8400-e29b-41d4-a716-446655440000",
              quantity: 1,
            },
          ],
          paymentMethod: "mock",
          paymentProviderCode: "alipay",
        }),
      ).rejects.toThrow(ConflictException);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("rejects qr_code without provider before creating local draft", async () => {
      const db = makeDb();
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { id: "mach-1", code: "M001", status: "online" },
            ]),
        }),
      });

      const service = makeService({ db });
      await expect(
        service.createMachineOrder({
          machineCode: "M001",
          items: [
            {
              inventoryId: "550e8400-e29b-41d4-a716-446655440000",
              quantity: 1,
            },
          ],
          paymentMethod: "qr_code",
        }),
      ).rejects.toThrow(ConflictException);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("uses paymentProviderCode (wechat_pay) instead of paymentMethod (qr_code) to look up provider", async () => {
      const db = makeDb();

      const createPaymentIntent = vi.fn().mockResolvedValue({
        paymentUrl: "https://qr.wechat.com/abc",
        providerTradeNo: null,
      });
      const provider = { createPaymentIntent };

      // machine lookup
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { id: "mach-1", code: "M001", status: "online" },
            ]),
        }),
      });

      // transaction: we provide a custom tx implementation
      db.transaction.mockImplementation(
        async (fn: (tx: unknown) => unknown) => {
          const tx = {
            select: vi.fn(),
            insert: vi.fn(),
            update: vi.fn(),
          };

          // tx select 1: available inventory rows
          tx.select.mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  innerJoin: vi.fn().mockReturnValue({
                    where: vi.fn().mockResolvedValue([
                      {
                        inventoryId: "inv-1",
                        variantId: "var-1",
                        productName: "Cola",
                        sku: "COLA-355",
                        size: null,
                        color: null,
                        unitPriceCents: 300,
                        slotId: "slot-1",
                        slotCode: "A1",
                        layerNo: 1,
                        cellNo: 1,
                      },
                    ]),
                  }),
                }),
              }),
            }),
          });

          // tx select 2: provider lookup by providerCode
          tx.select.mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi
                .fn()
                .mockResolvedValue([{ id: "prov-1", code: "wechat_pay" }]),
            }),
          });

          // tx insert order
          tx.insert.mockReturnValueOnce({
            values: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue([{ id: "ord-1", orderNo: "ORD001" }]),
            }),
          });

          // tx insert inventory reservations (reduce loop)
          tx.insert.mockReturnValue({
            values: vi.fn().mockReturnValue({
              onConflictDoNothing: vi.fn().mockResolvedValue([]),
              returning: vi.fn().mockResolvedValue([
                {
                  id: "pay-1",
                  paymentNo: "PAY001",
                  paymentUrl: "https://qr.wechat.com/abc",
                  expiresAt: new Date(Date.now() + 900_000),
                  amountCents: 300,
                },
              ]),
            }),
          });

          // tx update orders.paymentId
          tx.update.mockReturnValue({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([]),
            }),
          });

          return fn(tx);
        },
      );

      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
        configService: {
          resolveForPayment: vi.fn().mockResolvedValue({
            providerCode: "wechat_pay",
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }),
        },
      });

      await service.createMachineOrder({
        machineCode: "M001",
        items: [{ inventoryId: "inv-1", quantity: 1 }],
        paymentMethod: "qr_code",
        paymentProviderCode: "wechat_pay",
      });

      // Registry.get must be called with "wechat_pay", NOT "qr_code"
      const getCallArgs = (
        service as unknown as {
          paymentProviderRegistry: { get: ReturnType<typeof vi.fn> };
        }
      ).paymentProviderRegistry.get.mock.calls;
      expect(getCallArgs[0]?.[0]).toBe("wechat_pay");
    });

    it("records payment.method as qr_code even when paymentProviderCode is wechat_pay", async () => {
      const db = makeDb();
      const createPaymentIntent = vi.fn().mockResolvedValue({
        paymentUrl: "https://qr.wechat.com/xyz",
        providerTradeNo: null,
      });
      const provider = { createPaymentIntent };

      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockResolvedValue([
              { id: "mach-1", code: "M001", status: "online" },
            ]),
        }),
      });

      let insertedPaymentMethod: string | undefined;
      db.transaction.mockImplementation(
        async (fn: (tx: unknown) => unknown) => {
          const tx = {
            select: vi.fn(),
            insert: vi.fn(),
            update: vi.fn(),
          };
          tx.select.mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  innerJoin: vi.fn().mockReturnValue({
                    where: vi.fn().mockResolvedValue([
                      {
                        inventoryId: "inv-2",
                        variantId: "var-2",
                        productName: "Water",
                        sku: "WTR-500",
                        size: null,
                        color: null,
                        unitPriceCents: 200,
                        slotId: "slot-2",
                        slotCode: "B1",
                        layerNo: 1,
                        cellNo: 2,
                      },
                    ]),
                  }),
                }),
              }),
            }),
          });
          tx.select.mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi
                .fn()
                .mockResolvedValue([{ id: "prov-1", code: "wechat_pay" }]),
            }),
          });
          tx.insert.mockReturnValueOnce({
            values: vi.fn().mockReturnValue({
              returning: vi
                .fn()
                .mockResolvedValue([{ id: "ord-2", orderNo: "ORD002" }]),
            }),
          });
          // Capture payment insert values
          tx.insert.mockImplementation((_table: unknown) => ({
            values: vi
              .fn()
              .mockImplementation((vals: Record<string, unknown>) => {
                if (typeof vals?.method === "string") {
                  insertedPaymentMethod = vals.method;
                }
                return {
                  onConflictDoNothing: vi.fn().mockResolvedValue([]),
                  returning: vi.fn().mockResolvedValue([
                    {
                      id: "pay-2",
                      paymentNo: "PAY002",
                      paymentUrl: "https://qr.wechat.com/xyz",
                      expiresAt: new Date(Date.now() + 900_000),
                      amountCents: 200,
                    },
                  ]),
                };
              }),
          }));
          tx.update.mockReturnValue({
            set: vi
              .fn()
              .mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
          });
          return fn(tx);
        },
      );

      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue(provider),
        } as unknown as PaymentProviderRegistry,
      });

      await service.createMachineOrder({
        machineCode: "M001",
        items: [{ inventoryId: "inv-2", quantity: 1 }],
        paymentMethod: "qr_code",
        paymentProviderCode: "wechat_pay",
      });

      expect(insertedPaymentMethod).toBe("qr_code");
    });
  });

  describe("listMachinePaymentOptions", () => {
    it("returns alipay when listMachinePaymentOptionsForMachine resolves with alipay", async () => {
      const configService: Partial<PaymentProviderConfigService> = {
        listMachinePaymentOptionsForMachine: vi.fn().mockResolvedValue({
          machineId: "mach-1",
          options: [
            {
              providerCode: "alipay",
              method: "qr_code",
              displayName: "支付宝",
              description: "支付宝扫码",
              icon: "alipay",
              recommended: true,
            },
          ],
        }),
      };
      const service = makeService({ configService });
      const result = await service.listMachinePaymentOptions("mach-1");
      expect(result.options).toHaveLength(1);
      expect(result.options[0]?.providerCode).toBe("alipay");
    });

    it("returns empty options when listMachinePaymentOptionsForMachine returns none", async () => {
      const configService: Partial<PaymentProviderConfigService> = {
        listMachinePaymentOptionsForMachine: vi.fn().mockResolvedValue({
          machineId: "mach-1",
          options: [],
        }),
      };
      const service = makeService({ configService });
      const result = await service.listMachinePaymentOptions("mach-1");
      expect(result.options).toHaveLength(0);
    });

    it("returns both alipay and wechat_pay when both are available", async () => {
      const configService: Partial<PaymentProviderConfigService> = {
        listMachinePaymentOptionsForMachine: vi.fn().mockResolvedValue({
          machineId: "mach-1",
          options: [
            {
              providerCode: "alipay",
              method: "qr_code",
              displayName: "支付宝",
              description: "支付宝扫码",
              icon: "alipay",
              recommended: true,
            },
            {
              providerCode: "wechat_pay",
              method: "qr_code",
              displayName: "微信支付",
              description: "微信扫码",
              icon: "wechat",
              recommended: false,
            },
          ],
        }),
      };
      const service = makeService({ configService });
      const result = await service.listMachinePaymentOptions("mach-1");
      expect(result.options).toHaveLength(2);
      expect(result.options.map((o) => o.providerCode)).toEqual([
        "alipay",
        "wechat_pay",
      ]);
    });

    it("does not expose sensitive config in the response", async () => {
      const configService: Partial<PaymentProviderConfigService> = {
        listMachinePaymentOptionsForMachine: vi.fn().mockResolvedValue({
          machineId: "mach-1",
          options: [
            {
              providerCode: "alipay",
              method: "qr_code",
              displayName: "支付宝",
              description: "支付宝扫码",
              icon: "alipay",
              recommended: true,
            },
          ],
        }),
      };
      const service = makeService({ configService });
      const result = await service.listMachinePaymentOptions("mach-1");
      const resultStr = JSON.stringify(result);
      expect(resultStr).not.toContain("sensitiveConfigJson");
      expect(resultStr).not.toContain("privateKey");
    });
  });
});

// ---- transaction boundary tests -------------------------------------------

type OrdersDbHarness = {
  select: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
  insertedPaymentStatus?: string;
  updatedPaymentStatus?: string;
  orderStatusEvents: Array<{
    orderId: string;
    toStatus: string;
    reason: string;
  }>;
};

function makeOrdersService(overrides: {
  db?: OrdersDbHarness;
  inventoryService?: Partial<InventoryService>;
  paymentProviderRegistry?: Partial<PaymentProviderRegistry>;
  configService?: Partial<PaymentProviderConfigService>;
}) {
  const db = overrides.db ?? makeOrdersDbForSuccessfulLocalDraft();
  const inventoryService: InventoryService = {
    reserveForOrder: vi.fn().mockResolvedValue(undefined),
    releaseReservation: vi.fn().mockResolvedValue(undefined),
    reserveItems: vi.fn().mockResolvedValue(undefined),
    ...overrides.inventoryService,
  } as unknown as InventoryService;
  const registry: PaymentProviderRegistry = {
    get: vi.fn().mockReturnValue({
      createPaymentIntent: vi.fn().mockResolvedValue({
        providerTradeNo: null,
        paymentUrl: "https://qr.example/test",
      }),
    }),
    has: vi.fn().mockReturnValue(true),
    register: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    ...overrides.paymentProviderRegistry,
  } as unknown as PaymentProviderRegistry;
  const configService: PaymentProviderConfigService = {
    resolveForPayment: vi.fn().mockResolvedValue({
      id: "cfg-001",
      providerCode: "alipay",
      providerId: "prov-001",
      machineId: null,
      merchantNo: null,
      appId: null,
      publicConfigJson: {},
      sensitiveConfigJson: {},
    }),
    listMachinePaymentOptionsForMachine: vi.fn().mockResolvedValue({
      machineId: "mach-1",
      options: [],
    }),
    ...overrides.configService,
  } as unknown as PaymentProviderConfigService;
  const refundsService: RefundsService = {
    requestRefund: vi.fn().mockResolvedValue(undefined),
  } as unknown as RefundsService;

  return new OrdersService(
    db as never,
    inventoryService,
    registry,
    configService,
    refundsService,
  );
}

function makeProviderSelectResult() {
  const providerRows = [{ id: "prov-001", code: "alipay" }];
  const idRows = [{ id: "prov-001" }];
  const whereResult = Object.assign(Promise.resolve(providerRows), {
    limit: vi.fn().mockResolvedValue(idRows),
  });
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(whereResult),
    }),
  };
}

function makeGenericTx(db: OrdersDbHarness) {
  const tx = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };

  // First select: inventory (with innerJoin chain)
  tx.select.mockReturnValueOnce({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([
              {
                inventoryId: "inv-001",
                variantId: "var-001",
                productName: "Cola",
                sku: "COLA-355",
                size: null,
                color: null,
                unitPriceCents: 300,
                slotId: "slot-001",
                slotCode: "A1",
                layerNo: 1,
                cellNo: 1,
              },
            ]),
          }),
        }),
      }),
    }),
  });

  // Subsequent selects: provider lookup and findProviderIdForCode
  tx.select.mockReturnValue(makeProviderSelectResult());

  // First insert: orders
  tx.insert.mockReturnValueOnce({
    values: vi.fn().mockReturnValue({
      returning: vi
        .fn()
        .mockResolvedValue([
          { id: "ord-001", orderNo: "ORD001", totalAmountCents: 300 },
        ]),
    }),
  });

  // Generic insert for orderItems, payments, orderStatusEvents, paymentEvents
  tx.insert.mockImplementation((_: unknown) => ({
    values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
      if (
        typeof vals?.paymentNo === "string" &&
        typeof vals?.status === "string"
      ) {
        db.insertedPaymentStatus = vals.status;
      }
      if (
        typeof vals?.toStatus === "string" &&
        typeof vals?.reason === "string"
      ) {
        db.orderStatusEvents.push({
          orderId: String(vals.orderId ?? ""),
          toStatus: String(vals.toStatus),
          reason: String(vals.reason),
        });
      }
      return {
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "evt-001" }]),
        }),
        returning: vi
          .fn()
          .mockResolvedValue([
            { id: "pay-001", paymentNo: "PAY001", amountCents: 300 },
          ]),
      };
    }),
  }));

  tx.update.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  });

  return tx;
}

function makeGenericTxForCancellation(db: OrdersDbHarness) {
  const tx = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  };

  // All selects in cancellation tx are findProviderIdForCode
  tx.select.mockReturnValue(makeProviderSelectResult());

  // Generic insert for paymentEvents, orderStatusEvents
  tx.insert.mockReturnValue({
    values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
      if (
        typeof vals?.toStatus === "string" &&
        typeof vals?.reason === "string"
      ) {
        db.orderStatusEvents.push({
          orderId: String(vals.orderId ?? ""),
          toStatus: String(vals.toStatus),
          reason: String(vals.reason),
        });
      }
      return {
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
      };
    }),
  });

  tx.update.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([]),
    }),
  });

  return tx;
}

function makeOrdersDbForSuccessfulLocalDraft(options?: {
  transactionFinished?: () => void;
}): OrdersDbHarness {
  const harness: OrdersDbHarness = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    orderStatusEvents: [],
  };

  // Machine lookup: returns online machine
  harness.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi
        .fn()
        .mockResolvedValue([
          { id: "mach-001", code: "M-001", status: "online" },
        ]),
    }),
  });

  // Transaction runs callback and calls transactionFinished after
  let txCallCount = 0;
  harness.transaction.mockImplementation(
    async (fn: (tx: unknown) => unknown) => {
      txCallCount += 1;
      const tx =
        txCallCount === 1
          ? makeGenericTx(harness)
          : makeGenericTxForCancellation(harness);
      const result = await fn(tx);
      if (txCallCount === 1) {
        options?.transactionFinished?.();
      }
      return result;
    },
  );

  // Outer db.update (for payment update outside tx, after refactoring)
  harness.update.mockReturnValue({
    set: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
      if (typeof vals?.status === "string") {
        harness.updatedPaymentStatus = vals.status;
      }
      return { where: vi.fn().mockResolvedValue([]) };
    }),
  });

  // Outer db.insert (for paymentEvents in cancelProviderIntentAfterDbFailure)
  harness.insert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue([]),
    }),
  });

  return harness;
}

function makeOrdersDbForPaymentUpdateFailure(): OrdersDbHarness {
  const db = makeOrdersDbForSuccessfulLocalDraft();
  db.update = vi.fn(() => ({
    set: vi.fn(() => ({
      where: vi.fn().mockRejectedValue(new Error("payment update failed")),
    })),
  }));
  return db;
}

describe("OrdersService (transaction boundary)", () => {
  describe("createMachineOrder", () => {
    it("calls provider outside transaction (transaction finishes before provider is called)", async () => {
      const callOrder: string[] = [];

      const createPaymentIntent = vi.fn().mockImplementation(async () => {
        callOrder.push("createPaymentIntent");
        return {
          providerTradeNo: null,
          paymentUrl: "weixin://wxpay/bizpayurl?pr=test",
        };
      });

      const db = makeOrdersDbForSuccessfulLocalDraft({
        transactionFinished: () => callOrder.push("transactionFinished"),
      });
      const service = makeOrdersService({
        db,
        paymentProviderRegistry: {
          get: vi.fn().mockReturnValue({ createPaymentIntent }),
          has: vi.fn().mockReturnValue(true),
        },
      });

      await service.createMachineOrder({
        machineCode: "M-001",
        items: [{ inventoryId: "inv-001", quantity: 1 }],
        paymentMethod: "qr_code",
        paymentProviderCode: "alipay",
      });

      const txIdx = callOrder.indexOf("transactionFinished");
      const piIdx = callOrder.indexOf("createPaymentIntent");
      expect(txIdx).toBeGreaterThan(-1);
      expect(piIdx).toBeGreaterThan(-1);
      expect(txIdx).toBeLessThan(piIdx);
      expect(db.insertedPaymentStatus).toBe("created");
      expect(db.updatedPaymentStatus).toBe("pending");
    });

    it("cancels local order and releases reservation when provider create intent fails", async () => {
      const createPaymentIntent = vi
        .fn()
        .mockRejectedValue(new Error("provider timeout"));
      const releaseReservation = vi.fn().mockResolvedValue(undefined);

      const db = makeOrdersDbForSuccessfulLocalDraft();
      const service = makeOrdersService({
        db,
        inventoryService: { releaseReservation },
        paymentProviderRegistry: {
          get: vi.fn().mockReturnValue({ createPaymentIntent }),
          has: vi.fn().mockReturnValue(true),
        },
      });

      await expect(
        service.createMachineOrder({
          machineCode: "M-001",
          items: [{ inventoryId: "inv-001", quantity: 1 }],
          paymentMethod: "qr_code",
          paymentProviderCode: "alipay",
        }),
      ).rejects.toThrow("provider timeout");

      expect(releaseReservation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orderId: "ord-001",
          inventoryId: "inv-001",
          quantity: 1,
          reason: "payment_failed",
        }),
      );
      expect(db.orderStatusEvents).toContainEqual(
        expect.objectContaining({
          orderId: "ord-001",
          toStatus: "canceled",
          reason: "provider_create_failed",
        }),
      );
    });

    it("calls provider cancel when provider succeeded but payment update fails", async () => {
      const cancelPayment = vi.fn().mockResolvedValue({ status: "canceled" });
      const createPaymentIntent = vi.fn().mockResolvedValue({
        providerTradeNo: null,
        paymentUrl: "https://qr.example/PAY001",
      });

      const db = makeOrdersDbForPaymentUpdateFailure();
      const service = makeOrdersService({
        db,
        paymentProviderRegistry: {
          get: vi.fn().mockReturnValue({ createPaymentIntent, cancelPayment }),
          has: vi.fn().mockReturnValue(true),
        },
      });

      await expect(
        service.createMachineOrder({
          machineCode: "M-001",
          items: [{ inventoryId: "inv-001", quantity: 1 }],
          paymentMethod: "qr_code",
          paymentProviderCode: "alipay",
        }),
      ).rejects.toThrow("payment update failed");

      expect(cancelPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentNo: expect.any(String),
          providerTradeNo: null,
        }),
      );
    });
  });
});
