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
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn().mockImplementation(
      async (fn: (tx: unknown) => unknown) => fn(undefined),
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
          where: vi.fn().mockResolvedValue([
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
          where: vi.fn().mockResolvedValue([
            { id: "mach-1", code: "M001", status: "online" },
          ]),
        }),
      });

      // transaction: we provide a custom tx implementation
      db.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
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
            where: vi.fn().mockResolvedValue([
              { id: "prov-1", code: "wechat_pay" },
            ]),
          }),
        });

        // tx insert order
        tx.insert.mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([
              { id: "ord-1", orderNo: "ORD001" },
            ]),
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
      });

      const service = makeService({
        db,
        registry: { get: vi.fn().mockReturnValue(provider) } as unknown as PaymentProviderRegistry,
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
      const getCallArgs = (service as unknown as {
        paymentProviderRegistry: { get: ReturnType<typeof vi.fn> };
      }).paymentProviderRegistry.get.mock.calls;
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
          where: vi.fn().mockResolvedValue([
            { id: "mach-1", code: "M001", status: "online" },
          ]),
        }),
      });

      let insertedPaymentMethod: string | undefined;
      db.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
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
            where: vi.fn().mockResolvedValue([{ id: "prov-1", code: "wechat_pay" }]),
          }),
        });
        tx.insert.mockReturnValueOnce({
          values: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ id: "ord-2", orderNo: "ORD002" }]),
          }),
        });
        // Capture payment insert values
        tx.insert.mockImplementation((_table: unknown) => ({
          values: vi.fn().mockImplementation((vals: Record<string, unknown>) => {
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
          set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }),
        });
        return fn(tx);
      });

      const service = makeService({
        db,
        registry: { get: vi.fn().mockReturnValue(provider) } as unknown as PaymentProviderRegistry,
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
});
