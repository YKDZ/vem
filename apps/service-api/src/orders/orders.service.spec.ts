import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { InventoryService } from "../inventory/inventory.service";
import type { PaymentProviderConfigService } from "../payments/payment-provider-config.service";
import type { PaymentProviderRegistry } from "../payments/payment-provider.registry";
import type { PaymentsService } from "../payments/payments.service";
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
  inventoryService?: Partial<InventoryService>;
  registry?: Partial<PaymentProviderRegistry>;
  configService?: Partial<PaymentProviderConfigService>;
  paymentsService?: Partial<PaymentsService>;
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
    releaseReservation: vi.fn().mockResolvedValue(undefined),
    ...overrides.inventoryService,
  } as unknown as InventoryService;
  const refundsService: RefundsService = {
    requestRefund: vi.fn().mockResolvedValue(undefined),
  } as unknown as RefundsService;
  const paymentsServiceBase = {
    reconcilePendingPaymentOnRead: vi
      .fn()
      .mockResolvedValue({ status: "pending", reconciled: false }),
  };
  const paymentsService = Object.assign(
    {},
    paymentsServiceBase,
    overrides.paymentsService ?? {},
  ) as unknown as PaymentsService;

  return new OrdersService(
    db as never,
    inventoryService,
    registry,
    configService,
    refundsService,
    paymentsService,
  );
}

function makeJoinedSelectResult(rows: unknown[]) {
  return {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(rows),
          }),
        }),
      }),
    }),
  };
}

function makeEmptyLatestSelectResult() {
  return {
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  };
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
          items: [
            {
              inventoryId: "inv-1",
              quantity: 1,
              planogramVersion: "PLAN-ACTIVE",
              slotId: "slot-1",
              slotCode: "A1",
            },
          ],
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
          items: [
            {
              inventoryId: "inv-1",
              quantity: 1,
              planogramVersion: "PLAN-ACTIVE",
              slotId: "slot-1",
              slotCode: "A1",
            },
          ],
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
              planogramVersion: "PLAN-ACTIVE",
              slotId: "550e8400-e29b-41d4-a716-446655440001",
              slotCode: "A1",
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
              planogramVersion: "PLAN-ACTIVE",
              slotId: "550e8400-e29b-41d4-a716-446655440001",
              slotCode: "A1",
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
                        productId: "prod-1",
                        productName: "Cola",
                        sku: "COLA-355",
                        size: null,
                        color: null,
                        unitPriceCents: 300,
                        slotId: "slot-1",
                        slotCode: "A1",
                        slotStatus: "enabled",
                        layerNo: 1,
                        cellNo: 1,
                        variantStatus: "active",
                        productStatus: "active",
                      },
                    ]),
                  }),
                }),
              }),
            }),
          });

          // tx select 2: active acknowledged planogram context
          tx.select.mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([{ id: "pg-slot-1" }]),
              }),
            }),
          });

          // tx select 3: provider lookup by providerCode
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
        items: [
          {
            inventoryId: "inv-1",
            quantity: 1,
            planogramVersion: "PLAN-ACTIVE",
            slotId: "slot-1",
            slotCode: "A1",
          },
        ],
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
                        productId: "prod-2",
                        productName: "Water",
                        sku: "WTR-500",
                        size: null,
                        color: null,
                        unitPriceCents: 200,
                        slotId: "slot-2",
                        slotCode: "B1",
                        slotStatus: "enabled",
                        layerNo: 1,
                        cellNo: 2,
                        variantStatus: "active",
                        productStatus: "active",
                      },
                    ]),
                  }),
                }),
              }),
            }),
          });
          tx.select.mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([{ id: "pg-slot-2" }]),
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
        items: [
          {
            inventoryId: "inv-2",
            quantity: 1,
            planogramVersion: "PLAN-ACTIVE",
            slotId: "slot-2",
            slotCode: "B1",
          },
        ],
        paymentMethod: "qr_code",
        paymentProviderCode: "wechat_pay",
      });

      expect(insertedPaymentMethod).toBe("qr_code");
    });

    it("creates payment_code order without calling provider.createPaymentIntent", async () => {
      const db = makeOrdersDbForSuccessfulLocalDraft();
      const createPaymentIntent = vi.fn();
      const service = makeOrdersService({
        db,
        paymentProviderRegistry: {
          get: vi.fn().mockReturnValue({ createPaymentIntent }),
          has: vi.fn().mockReturnValue(true),
        },
      });

      const result = await service.createMachineOrder({
        machineCode: "M-001",
        items: [
          {
            inventoryId: "inv-001",
            quantity: 1,
            planogramVersion: "PLAN-ACTIVE",
            slotId: "slot-001",
            slotCode: "A1",
          },
        ],
        paymentMethod: "payment_code",
        paymentProviderCode: "alipay",
      });

      expect(createPaymentIntent).not.toHaveBeenCalled();
      expect(result.paymentUrl).toBeNull();
      expect(db.updatedPaymentStatus).toBe("pending");
    });

    it("rejects payment_code without a real provider before creating local draft", async () => {
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
              planogramVersion: "PLAN-ACTIVE",
              slotId: "550e8400-e29b-41d4-a716-446655440001",
              slotCode: "A1",
            },
          ],
          paymentMethod: "payment_code",
        }),
      ).rejects.toThrow(ConflictException);
      expect(db.transaction).not.toHaveBeenCalled();
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
  insertedOrderItems: Array<Record<string, unknown>>;
  inventoryRows?: Array<Record<string, unknown>>;
  planogramContextRows?: Array<{
    planogramVersion: string;
    slotId: string;
    slotCode: string;
    inventoryId: string;
  }>;
};

function makeOrdersService(overrides: {
  db?: OrdersDbHarness;
  inventoryService?: Partial<InventoryService>;
  paymentProviderRegistry?: Partial<PaymentProviderRegistry>;
  configService?: Partial<PaymentProviderConfigService>;
  paymentsService?: Partial<PaymentsService>;
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
  const paymentsServiceBase = {
    reconcilePendingPaymentOnRead: vi
      .fn()
      .mockResolvedValue({ status: "pending", reconciled: false }),
  };
  const paymentsService = Object.assign(
    {},
    paymentsServiceBase,
    overrides.paymentsService ?? {},
  ) as unknown as PaymentsService;

  return new OrdersService(
    db as never,
    inventoryService,
    registry,
    configService,
    refundsService,
    paymentsService,
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

  const inventoryRows = db.inventoryRows ?? [
    {
      inventoryId: "inv-001",
      variantId: "var-001",
      productId: "prod-001",
      productName: "Cola",
      sku: "COLA-355",
      size: null,
      color: null,
      unitPriceCents: 300,
      slotId: "slot-001",
      slotCode: "A1",
      slotStatus: "enabled",
      layerNo: 1,
      cellNo: 1,
      variantStatus: "active",
      productStatus: "active",
    },
  ];
  const inventorySelectResult = {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue(inventoryRows),
          }),
        }),
      }),
    }),
  };
  const planogramSelectResult = {
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(db.planogramContextRows ?? []),
      }),
    }),
  };
  let selectCallCount = 0;
  let planogramContextSelectConsumed = false;
  tx.select.mockImplementation((selection?: Record<string, unknown>) => {
    selectCallCount += 1;
    if (selectCallCount === 1) return inventorySelectResult;
    if (
      db.planogramContextRows !== undefined &&
      !planogramContextSelectConsumed &&
      selection &&
      Object.keys(selection).length === 1 &&
      Object.hasOwn(selection, "id")
    ) {
      planogramContextSelectConsumed = true;
      return planogramSelectResult;
    }
    return makeProviderSelectResult();
  });

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
      if (vals?.productSnapshot && typeof vals.productSnapshot === "object") {
        db.insertedOrderItems.push(vals);
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
      if (vals?.productSnapshot && typeof vals.productSnapshot === "object") {
        db.insertedOrderItems.push(vals);
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
  inventoryRows?: Array<Record<string, unknown>>;
  planogramContextRows?: Array<{
    planogramVersion: string;
    slotId: string;
    slotCode: string;
    inventoryId: string;
  }>;
}): OrdersDbHarness {
  const harness: OrdersDbHarness = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    orderStatusEvents: [],
    insertedOrderItems: [],
    inventoryRows: options?.inventoryRows,
    planogramContextRows: options?.planogramContextRows ?? [
      {
        planogramVersion: "PLAN-ACTIVE",
        slotId: "slot-001",
        slotCode: "A1",
        inventoryId: "inv-001",
      },
    ],
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
    it("rejects machine order line without planogram slot context before reserving inventory", async () => {
      const reserveForOrder = vi.fn().mockResolvedValue(undefined);
      const db = makeOrdersDbForSuccessfulLocalDraft();
      const service = makeOrdersService({
        db,
        inventoryService: { reserveForOrder },
      });

      await expect(
        service.createMachineOrder({
          machineCode: "M-001",
          items: [{ inventoryId: "inv-001", quantity: 1 } as never],
          paymentMethod: "payment_code",
          paymentProviderCode: "alipay",
        }),
      ).rejects.toThrow(ConflictException);

      expect(reserveForOrder).not.toHaveBeenCalled();
    });

    it("rejects mismatched machine order line context before reserving inventory", async () => {
      const reserveForOrder = vi.fn().mockResolvedValue(undefined);
      const db = makeOrdersDbForSuccessfulLocalDraft();
      const service = makeOrdersService({
        db,
        inventoryService: { reserveForOrder },
      });

      await expect(
        service.createMachineOrder({
          machineCode: "M-001",
          items: [
            {
              inventoryId: "inv-001",
              quantity: 1,
              planogramVersion: "PLAN-ACTIVE",
              slotId: "slot-other",
              slotCode: "A1",
            },
          ],
          paymentMethod: "payment_code",
          paymentProviderCode: "alipay",
        }),
      ).rejects.toThrow(ConflictException);

      expect(reserveForOrder).not.toHaveBeenCalled();
    });

    it("rejects a faulted machine slot before reserving inventory", async () => {
      const reserveForOrder = vi.fn().mockResolvedValue(undefined);
      const db = makeOrdersDbForSuccessfulLocalDraft({
        inventoryRows: [
          {
            inventoryId: "inv-001",
            variantId: "var-001",
            productId: "prod-001",
            productName: "Cola",
            sku: "COLA-355",
            size: null,
            color: null,
            unitPriceCents: 300,
            slotId: "slot-001",
            slotCode: "A1",
            slotStatus: "faulted",
            layerNo: 1,
            cellNo: 1,
            variantStatus: "active",
            productStatus: "active",
          },
        ],
      });
      const service = makeOrdersService({
        db,
        inventoryService: { reserveForOrder },
      });

      await expect(
        service.createMachineOrder({
          machineCode: "M-001",
          items: [
            {
              inventoryId: "inv-001",
              quantity: 1,
              planogramVersion: "PLAN-ACTIVE",
              slotId: "slot-001",
              slotCode: "A1",
            },
          ],
          paymentMethod: "payment_code",
          paymentProviderCode: "alipay",
        }),
      ).rejects.toThrow("Slot A1 is not available");

      expect(reserveForOrder).not.toHaveBeenCalled();
    });

    it("rejects machine order line when planogram context is not active and acknowledged", async () => {
      const reserveForOrder = vi.fn().mockResolvedValue(undefined);
      const db = makeOrdersDbForSuccessfulLocalDraft({
        planogramContextRows: [],
      });
      const service = makeOrdersService({
        db,
        inventoryService: { reserveForOrder },
      });

      await expect(
        service.createMachineOrder({
          machineCode: "M-001",
          items: [
            {
              inventoryId: "inv-001",
              quantity: 1,
              planogramVersion: "PLAN-UNACKED",
              slotId: "slot-001",
              slotCode: "A1",
            },
          ],
          paymentMethod: "payment_code",
          paymentProviderCode: "alipay",
        }),
      ).rejects.toThrow(ConflictException);

      expect(reserveForOrder).not.toHaveBeenCalled();
    });

    it("reserves inventory when machine order line context matches active acknowledged planogram", async () => {
      const reserveForOrder = vi.fn().mockResolvedValue(undefined);
      const db = makeOrdersDbForSuccessfulLocalDraft({
        planogramContextRows: [
          {
            planogramVersion: "PLAN-ACTIVE",
            slotId: "slot-001",
            slotCode: "A1",
            inventoryId: "inv-001",
          },
        ],
      });
      const service = makeOrdersService({
        db,
        inventoryService: { reserveForOrder },
      });

      const result = await service.createMachineOrder({
        machineCode: "M-001",
        items: [
          {
            inventoryId: "inv-001",
            quantity: 1,
            planogramVersion: "PLAN-ACTIVE",
            slotId: "slot-001",
            slotCode: "A1",
          },
        ],
        paymentMethod: "payment_code",
        paymentProviderCode: "alipay",
      });

      expect(result.orderNo).toBe("ORD001");
      expect(reserveForOrder).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orderId: "ord-001",
          inventoryId: "inv-001",
          quantity: 1,
        }),
      );
    });

    it("persists machine order line planogram and mapping snapshot for later dispense confirmation", async () => {
      const db = makeOrdersDbForSuccessfulLocalDraft({
        planogramContextRows: [
          {
            planogramVersion: "PLAN-ACTIVE",
            slotId: "slot-001",
            slotCode: "A1",
            inventoryId: "inv-001",
          },
        ],
      });
      const service = makeOrdersService({ db });

      await service.createMachineOrder({
        machineCode: "M-001",
        items: [
          {
            inventoryId: "inv-001",
            quantity: 1,
            planogramVersion: "PLAN-ACTIVE",
            slotId: "slot-001",
            slotCode: "A1",
          },
        ],
        paymentMethod: "payment_code",
        paymentProviderCode: "alipay",
      });

      expect(db.insertedOrderItems[0]?.productSnapshot).toEqual(
        expect.objectContaining({
          productId: "prod-001",
          variantId: "var-001",
          inventoryId: "inv-001",
          planogramVersion: "PLAN-ACTIVE",
          slotId: "slot-001",
          slotCode: "A1",
          vendingCommandQuantity: 1,
        }),
      );
    });

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
        items: [
          {
            inventoryId: "inv-001",
            quantity: 1,
            planogramVersion: "PLAN-ACTIVE",
            slotId: "slot-001",
            slotCode: "A1",
          },
        ],
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
        .mockRejectedValue(new Error("provider invalid request"));
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
          items: [
            {
              inventoryId: "inv-001",
              quantity: 1,
              planogramVersion: "PLAN-ACTIVE",
              slotId: "slot-001",
              slotCode: "A1",
            },
          ],
          paymentMethod: "qr_code",
          paymentProviderCode: "alipay",
        }),
      ).rejects.toThrow("provider invalid request");

      expect(releaseReservation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          orderId: "ord-001",
          inventoryId: "inv-001",
          quantity: 1,
          reason: "payment_failed",
        }),
      );
      expect(createPaymentIntent).toHaveBeenCalledOnce();
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
          items: [
            {
              inventoryId: "inv-001",
              quantity: 1,
              planogramVersion: "PLAN-ACTIVE",
              slotId: "slot-001",
              slotCode: "A1",
            },
          ],
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

  describe("cancelMachineOrder", () => {
    it("cancels an unpaid machine order and releases active reservations", async () => {
      const db = makeDb();
      const releaseReservation = vi.fn().mockResolvedValue(undefined);
      const row = {
        orderId: "ord-1",
        orderNo: "ORD001",
        machineId: "mach-1",
        machineCode: "M001",
        orderStatus: "pending_payment",
        paymentState: "awaiting_payment",
        fulfillmentState: "awaiting_fulfillment",
        totalAmountCents: 300,
        paymentId: "pay-1",
        paymentNo: "PAY001",
        paymentMethod: "qr_code",
        paymentStatus: "created",
        paymentUrl: "https://pay.example/qr",
        paymentExpiresAt: null,
        paidAt: null,
        failedReason: null,
        providerId: "provider-mock",
        providerCode: "mock",
        paymentProviderCode: "mock",
        providerTradeNo: null,
        providerConfigId: null,
      };
      const canceledRow = {
        ...row,
        orderStatus: "canceled",
        paymentState: "canceled",
        fulfillmentState: "canceled",
        paymentStatus: "canceled",
      };
      const tx = {
        select: vi
          .fn()
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                where: vi.fn().mockResolvedValue([row]),
              }),
            }),
          })
          .mockReturnValueOnce({
            from: vi.fn().mockReturnValue({
              where: vi
                .fn()
                .mockResolvedValue([{ inventoryId: "inv-1", quantity: 2 }]),
            }),
          }),
        insert: vi.fn().mockReturnValue({
          values: vi.fn().mockReturnValue({
            onConflictDoNothing: vi.fn().mockResolvedValue([]),
          }),
        }),
        update: vi
          .fn()
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ id: "pay-1" }]),
              }),
            }),
          })
          .mockReturnValueOnce({
            set: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                returning: vi.fn().mockResolvedValue([{ id: "ord-1" }]),
              }),
            }),
          }),
      };

      db.select
        .mockReturnValueOnce(makeJoinedSelectResult([row]))
        .mockReturnValueOnce(makeJoinedSelectResult([canceledRow]))
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult());
      db.transaction.mockImplementationOnce(
        async (cb: (txArg: typeof tx) => Promise<unknown>) => await cb(tx),
      );

      const service = makeService({
        db,
        inventoryService: { releaseReservation },
      });

      const result = await service.cancelMachineOrder("ORD001", {
        machineCode: "M001",
      });

      expect(result).toMatchObject({
        orderNo: "ORD001",
        orderStatus: "canceled",
        paymentState: "canceled",
        fulfillmentState: "canceled",
        nextAction: "closed",
      });
      expect(releaseReservation).toHaveBeenCalledWith(tx, {
        orderId: "ord-1",
        inventoryId: "inv-1",
        quantity: 2,
        reason: "canceled",
      });
    });

    it("does not cancel or release reservations when payment succeeds before the transaction update", async () => {
      const db = makeDb();
      const releaseReservation = vi.fn().mockResolvedValue(undefined);
      const row = {
        orderId: "ord-1",
        orderNo: "ORD001",
        machineId: "mach-1",
        machineCode: "M001",
        orderStatus: "pending_payment",
        paymentState: "awaiting_payment",
        fulfillmentState: "awaiting_fulfillment",
        totalAmountCents: 300,
        paymentId: "pay-1",
        paymentNo: "PAY001",
        paymentMethod: "qr_code",
        paymentStatus: "created",
        paymentUrl: "https://pay.example/qr",
        paymentExpiresAt: null,
        paidAt: null,
        failedReason: null,
        providerId: "provider-mock",
        providerCode: "mock",
        paymentProviderCode: "mock",
        providerTradeNo: null,
        providerConfigId: null,
      };
      const tx = {
        select: vi.fn().mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockResolvedValue([
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
        insert: vi.fn(),
        update: vi.fn(),
      };

      db.select.mockReturnValueOnce(makeJoinedSelectResult([row]));
      db.transaction.mockImplementationOnce(
        async (cb: (txArg: typeof tx) => Promise<unknown>) => await cb(tx),
      );

      const service = makeService({
        db,
        inventoryService: { releaseReservation },
      });

      await expect(
        service.cancelMachineOrder("ORD001", { machineCode: "M001" }),
      ).rejects.toThrow(ConflictException);
      expect(tx.insert).not.toHaveBeenCalled();
      expect(tx.update).not.toHaveBeenCalled();
      expect(releaseReservation).not.toHaveBeenCalled();
    });
  });

  describe("getMachineOrderStatus", () => {
    function machineOrderStatusRow(overrides: Record<string, unknown> = {}) {
      return {
        orderId: "ord-1",
        orderNo: "ORD001",
        machineCode: "M001",
        orderStatus: "pending_payment",
        paymentState: "awaiting_payment",
        fulfillmentState: "awaiting_fulfillment",
        totalAmountCents: 300,
        paymentId: "pay-1",
        paymentNo: "PAY001",
        paymentMethod: "qr_code",
        paymentStatus: "pending",
        paymentUrl: "https://example.com/qr",
        paymentCreatedAt: new Date(),
        paymentExpiresAt: null,
        paidAt: null,
        failedReason: null,
        paymentProviderCode: "alipay",
        ...overrides,
      };
    }

    it("tries immediate reconcile for pending qr_code and returns refreshed status", async () => {
      const db = makeDb();
      const reconcilePendingPaymentOnRead = vi
        .fn()
        .mockResolvedValue({ status: "succeeded", reconciled: true });
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([
                    {
                      orderId: "ord-1",
                      orderNo: "ORD001",
                      machineCode: "M001",
                      orderStatus: "pending_payment",
                      paymentState: "awaiting_payment",
                      fulfillmentState: "awaiting_fulfillment",
                      totalAmountCents: 300,
                      paymentId: "pay-1",
                      paymentNo: "PAY001",
                      paymentMethod: "qr_code",
                      paymentStatus: "pending",
                      paymentUrl: "https://example.com/qr",
                      paymentExpiresAt: null,
                      paidAt: null,
                      failedReason: null,
                      paymentProviderCode: "alipay",
                    },
                  ]),
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
                  where: vi.fn().mockResolvedValue([
                    {
                      orderId: "ord-1",
                      orderNo: "ORD001",
                      machineCode: "M001",
                      orderStatus: "paid",
                      paymentState: "paid",
                      fulfillmentState: "awaiting_fulfillment",
                      totalAmountCents: 300,
                      paymentId: "pay-1",
                      paymentNo: "PAY001",
                      paymentMethod: "qr_code",
                      paymentStatus: "succeeded",
                      paymentUrl: "https://example.com/qr",
                      paymentExpiresAt: null,
                      paidAt: new Date("2026-05-24T13:00:00.000Z"),
                      failedReason: null,
                      paymentProviderCode: "alipay",
                    },
                  ]),
                }),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        });

      const service = makeService({
        db,
        paymentsService: { reconcilePendingPaymentOnRead },
      });
      const result = await service.getMachineOrderStatus("ORD001", {
        machineCode: "M001",
      });

      expect(reconcilePendingPaymentOnRead).toHaveBeenCalledWith("pay-1");
      expect(result.orderStatus).toBe("paid");
      expect(result.paymentState).toBe("paid");
      expect(result.fulfillmentState).toBe("awaiting_fulfillment");
      expect(result.payment.status).toBe("succeeded");
      expect(result.nextAction).toBe("dispensing");
    });

    it("hides a freshly unconfirmed qr_code URL while provider readiness is processing", async () => {
      const db = makeDb();
      const row = machineOrderStatusRow({
        paymentStatus: "processing",
        paymentCreatedAt: new Date(),
      });
      db.select
        .mockReturnValueOnce(makeJoinedSelectResult([row]))
        .mockReturnValueOnce(makeJoinedSelectResult([row]))
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult());

      const service = makeService({ db });
      const result = await service.getMachineOrderStatus("ORD001", {
        machineCode: "M001",
      });

      expect(result.payment.status).toBe("processing");
      expect(result.payment.paymentUrl).toBeNull();
      expect(result.nextAction).toBe("wait_payment");
    });

    it("exposes an unconfirmed qr_code URL after the fallback display delay", async () => {
      const db = makeDb();
      const row = machineOrderStatusRow({
        paymentStatus: "processing",
        paymentCreatedAt: new Date(Date.now() - 31_000),
      });
      db.select
        .mockReturnValueOnce(makeJoinedSelectResult([row]))
        .mockReturnValueOnce(makeJoinedSelectResult([row]))
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult());

      const service = makeService({ db });
      const result = await service.getMachineOrderStatus("ORD001", {
        machineCode: "M001",
      });

      expect(result.payment.status).toBe("processing");
      expect(result.payment.paymentUrl).toBe("https://example.com/qr");
      expect(result.nextAction).toBe("wait_payment");
    });

    it("includes paymentCodeAttempt summary without plaintext auth code", async () => {
      const db = makeDb();
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([
                    {
                      orderId: "ord-1",
                      orderNo: "ORD001",
                      machineCode: "M001",
                      orderStatus: "pending_payment",
                      paymentState: "awaiting_payment",
                      fulfillmentState: "awaiting_fulfillment",
                      totalAmountCents: 300,
                      paymentId: "pay-1",
                      paymentNo: "PAY001",
                      paymentMethod: "payment_code",
                      paymentStatus: "pending",
                      paymentUrl: null,
                      paymentExpiresAt: null,
                      paidAt: null,
                      failedReason: null,
                      paymentProviderCode: "alipay",
                    },
                  ]),
                }),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    attemptNo: 1,
                    status: "user_confirming",
                    maskedAuthCode: "2876****4394",
                    source: "serial_text",
                    idempotencyKey: "idem-1",
                    submittedAt: new Date("2026-05-24T10:00:00.000Z"),
                    lastCheckedAt: new Date("2026-05-24T10:00:02.000Z"),
                    failureMessage: null,
                    isActive: true,
                  },
                ]),
              }),
            }),
          }),
        });

      const service = makeService({ db });
      const result = await service.getMachineOrderStatus("ORD001", {
        machineCode: "M001",
      });

      expect(result.paymentCodeAttempt).toMatchObject({
        attemptNo: 1,
        status: "user_confirming",
        maskedAuthCode: "2876****4394",
        source: "serial_text",
        canRetry: false,
      });
      expect(JSON.stringify(result)).not.toContain("28763443825664394");
    });

    it("describes reversed paymentCodeAttempt as retryable", async () => {
      const db = makeDb();
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([
                    {
                      orderId: "ord-1",
                      orderNo: "ORD001",
                      machineCode: "M001",
                      orderStatus: "pending_payment",
                      paymentState: "awaiting_payment",
                      fulfillmentState: "awaiting_fulfillment",
                      totalAmountCents: 300,
                      paymentId: "pay-1",
                      paymentNo: "PAY001",
                      paymentMethod: "payment_code",
                      paymentStatus: "pending",
                      paymentUrl: null,
                      paymentExpiresAt: null,
                      paidAt: null,
                      failedReason: null,
                      paymentProviderCode: "alipay",
                    },
                  ]),
                }),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    attemptNo: 1,
                    status: "reversed",
                    maskedAuthCode: "2876****4394",
                    source: "serial_text",
                    idempotencyKey: "idem-1",
                    submittedAt: new Date("2026-05-24T10:00:00.000Z"),
                    lastCheckedAt: new Date("2026-05-24T10:00:30.000Z"),
                    failureMessage: null,
                    isActive: false,
                  },
                ]),
              }),
            }),
          }),
        });

      const service = makeService({ db });
      const result = await service.getMachineOrderStatus("ORD001", {
        machineCode: "M001",
      });

      expect(result.paymentCodeAttempt).toMatchObject({
        status: "reversed",
        canRetry: true,
        message: "本次付款码交易已撤销，请刷新付款码后重试",
      });
      expect(result.nextAction).toBe("wait_payment");
    });

    it("sanitizes technical paymentCodeAttempt timeout messages while reversing", async () => {
      const db = makeDb();
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([
                    {
                      orderId: "ord-1",
                      orderNo: "ORD001",
                      machineCode: "M001",
                      orderStatus: "pending_payment",
                      paymentState: "awaiting_payment",
                      fulfillmentState: "awaiting_fulfillment",
                      totalAmountCents: 300,
                      paymentId: "pay-1",
                      paymentNo: "PAY001",
                      paymentMethod: "payment_code",
                      paymentStatus: "pending",
                      paymentUrl: null,
                      paymentExpiresAt: null,
                      paidAt: null,
                      failedReason: null,
                      paymentProviderCode: "alipay",
                    },
                  ]),
                }),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    attemptNo: 1,
                    status: "reversing",
                    maskedAuthCode: "2876****4394",
                    source: "serial_text",
                    idempotencyKey: "idem-1",
                    submittedAt: new Date("2026-05-24T10:00:00.000Z"),
                    lastCheckedAt: new Date("2026-05-24T10:00:30.000Z"),
                    failureMessage:
                      "HttpClient Request error: Request timeout for 5000 ms",
                    isActive: true,
                  },
                ]),
              }),
            }),
          }),
        });

      const service = makeService({ db });
      const result = await service.getMachineOrderStatus("ORD001", {
        machineCode: "M001",
      });

      expect(result.paymentCodeAttempt).toMatchObject({
        status: "reversing",
        canRetry: false,
        message: "支付结果未确认，正在撤销本次付款码交易",
      });
      expect(JSON.stringify(result)).not.toContain("Request timeout");
      expect(result.nextAction).toBe("wait_payment");
    });

    it("returns manual_handling nextAction for unresolved paymentCodeAttempt", async () => {
      const db = makeDb();
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              innerJoin: vi.fn().mockReturnValue({
                innerJoin: vi.fn().mockReturnValue({
                  where: vi.fn().mockResolvedValue([
                    {
                      orderId: "ord-1",
                      orderNo: "ORD001",
                      machineCode: "M001",
                      orderStatus: "pending_payment",
                      paymentState: "awaiting_payment",
                      fulfillmentState: "awaiting_fulfillment",
                      totalAmountCents: 300,
                      paymentId: "pay-1",
                      paymentNo: "PAY001",
                      paymentMethod: "payment_code",
                      paymentStatus: "pending",
                      paymentUrl: null,
                      paymentExpiresAt: null,
                      paidAt: null,
                      failedReason: null,
                      paymentProviderCode: "alipay",
                    },
                  ]),
                }),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    attemptNo: 1,
                    status: "manual_handling",
                    maskedAuthCode: "2876****4394",
                    source: "serial_text",
                    idempotencyKey: "idem-1",
                    submittedAt: new Date("2026-05-24T10:00:00.000Z"),
                    lastCheckedAt: new Date("2026-05-24T10:00:30.000Z"),
                    failureMessage:
                      "HttpClient Request error: Request timeout for 5000 ms",
                    isActive: true,
                  },
                ]),
              }),
            }),
          }),
        });

      const service = makeService({ db });
      const result = await service.getMachineOrderStatus("ORD001", {
        machineCode: "M001",
      });

      expect(result.paymentCodeAttempt).toMatchObject({
        status: "manual_handling",
        canRetry: false,
        message: "支付结果待人工处理，请联系工作人员",
      });
      expect(result.nextAction).toBe("manual_handling");
    });
  });
});
