import { afterEach, describe, expect, it, vi } from "vitest";

import type { InventoryService } from "../inventory/inventory.service";
import type { RefundsService } from "../refunds/refunds.service";
import type { PaymentProviderConfigService } from "./payment-provider-config.service";
import type { PaymentProviderRegistry } from "./payment-provider.registry";

import { OrdersService } from "../orders/orders.service";

function makeOrdersDbForSuccessfulLocalDraft() {
  const db = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
    updatedPaymentStatus: undefined as string | undefined,
  };

  db.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi
        .fn()
        .mockResolvedValue([
          { id: "mach-001", code: "M-001", status: "online" },
        ]),
    }),
  });

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
                  inventoryId: "inv-001",
                  variantId: "var-001",
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
              ]),
            }),
          }),
        }),
      }),
    });

    tx.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: "pg-slot-001" }]),
        }),
      }),
    });

    tx.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi
          .fn()
          .mockReturnValue(
            Object.assign(
              Promise.resolve([{ id: "prov-001", code: "alipay" }]),
              { limit: vi.fn().mockResolvedValue([{ id: "prov-001" }]) },
            ),
          ),
      }),
    });

    tx.insert.mockReturnValueOnce({
      values: vi.fn().mockReturnValue({
        returning: vi
          .fn()
          .mockResolvedValue([
            { id: "ord-001", orderNo: "ORD-PC-001", totalAmountCents: 300 },
          ]),
      }),
    });

    tx.insert.mockImplementation(() => ({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "evt-001" }]),
        }),
        returning: vi.fn().mockResolvedValue([
          {
            id: "pay-001",
            paymentNo: "PAY-PC-001",
            amountCents: 300,
          },
        ]),
      }),
    }));

    tx.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    return await fn(tx);
  });

  db.update.mockReturnValue({
    set: vi.fn().mockImplementation((values: Record<string, unknown>) => {
      if (typeof values.status === "string") {
        db.updatedPaymentStatus = values.status;
      }
      return { where: vi.fn().mockResolvedValue([]) };
    }),
  });

  db.insert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockResolvedValue([]),
    }),
  });

  return db;
}

function makeOrdersService(db = makeOrdersDbForSuccessfulLocalDraft()) {
  const inventoryService: InventoryService = {
    reserveForOrder: vi.fn().mockResolvedValue(undefined),
    reserveItems: vi.fn().mockResolvedValue(undefined),
    releaseReservation: vi.fn().mockResolvedValue(undefined),
  } as unknown as InventoryService;
  const paymentProviderRegistry: PaymentProviderRegistry = {
    get: vi.fn().mockReturnValue({ createPaymentIntent: vi.fn() }),
    has: vi.fn().mockReturnValue(true),
    register: vi.fn(),
    list: vi.fn().mockReturnValue([]),
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
    assertMachinePaymentChannelAvailable: vi.fn().mockResolvedValue(undefined),
    listMachinePaymentOptionsForMachine: vi.fn().mockResolvedValue({
      machineId: "mach-001",
      options: [],
    }),
    createBindingSnapshot: vi.fn((config: Record<string, unknown>) => ({
      version: 1,
      id: config.id ?? "cfg-001",
      providerCode: config.providerCode,
      providerId: config.providerId ?? "prov-001",
      merchantNo: config.merchantNo ?? null,
      appId: config.appId ?? null,
      publicConfigJson: config.publicConfigJson ?? {},
      sensitiveConfigEncryptedJson: { encrypted: "test" },
      boundAt: "2026-07-08T00:00:00.000Z",
    })),
  } as unknown as PaymentProviderConfigService;
  const refundsService: RefundsService = {
    requestRefund: vi.fn().mockResolvedValue(undefined),
  } as unknown as RefundsService;

  return {
    service: new OrdersService(
      db as never,
      inventoryService,
      paymentProviderRegistry,
      configService,
      refundsService,
      { record: vi.fn().mockResolvedValue(undefined) } as never,
      { resolveCommand: vi.fn().mockResolvedValue({}) } as never,
    ),
    db,
    paymentProviderRegistry,
  };
}

describe("payment code flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates payment_code orders without paymentUrl and without provider precreate", async () => {
    const { service, db, paymentProviderRegistry } = makeOrdersService();

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

    expect(result.paymentUrl).toBeNull();
    expect(result.paymentNo).toBe("PAY-PC-001");
    expect(db.updatedPaymentStatus).toBe("pending");
    expect(
      (paymentProviderRegistry.get as ReturnType<typeof vi.fn>).mock.calls,
    ).toHaveLength(0);
  });
});
