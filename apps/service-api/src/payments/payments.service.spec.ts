import { NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import type { AppConfigService } from "../config/app-config.service";
import type { InventoryService } from "../inventory/inventory.service";
import type { VendingService } from "../vending/vending.service";
import type { AuditService } from "../audit/audit.service";
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
    listCandidateConfigsForProvider: vi.fn().mockResolvedValue([]),
    resolveForPayment: vi.fn().mockResolvedValue({
      providerCode: "mock",
      merchantNo: null,
      appId: null,
      publicConfigJson: {},
      sensitiveConfigJson: {},
    }),
    ...overrides.configService,
  } as unknown as PaymentProviderConfigService;
  const vendingService: VendingService = {
    createAndDispatchCommands: vi.fn().mockResolvedValue(undefined),
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
  } as unknown as AuditService;
  const secretService: PaymentConfigSecretService = {
    encrypt: vi.fn().mockReturnValue({ encrypted: "xxx" }),
    decrypt: vi.fn().mockReturnValue({}),
    summarize: vi.fn().mockReturnValue({ keys: [] }),
  } as unknown as PaymentConfigSecretService;

  return new PaymentsService(
    db as never,
    inventoryService,
    vendingService,
    appConfig,
    registry,
    auditService,
    secretService,
    configService,
  );
}

// ---- tests ------------------------------------------------------------------

describe("PaymentsService", () => {
  describe("reconcilePendingPayments", () => {
    it("applies succeeded status and calls createAndDispatchCommands once", async () => {
      const createAndDispatchCommands = vi.fn().mockResolvedValue(undefined);
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

      // Call 2 (in tx): check existing event by providerEventId
      const call2 = {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]), // no existing event
          }),
        }),
      };

      // Call 3 (in tx): load payment+order for applyPaymentStatusUpdate
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
        .mockReturnValueOnce(call2)
        .mockReturnValueOnce(call3);

      db.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn(db),
      );

      // insert event → success (no .returning() in applyPaymentStatusUpdate insert)
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockResolvedValue([]),
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
        vendingService: { createAndDispatchCommands },
      });

      const { reconciled } = await service.reconcilePendingPayments();
      expect(reconciled).toBe(1);
      expect(queryPayment).toHaveBeenCalledOnce();
      expect(createAndDispatchCommands).toHaveBeenCalledWith("ord-001");
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

  describe("handleProviderWebhook", () => {
    it("returns {handled:true,duplicate:true} when event already processed", async () => {
      const handleWebhook = vi.fn().mockResolvedValue({
        paymentNo: "PAY001",
        eventType: "provider.payment.succeeded",
        providerEventId: "EVT001",
        signatureValid: true,
        paymentStatus: "succeeded",
        rawPayload: {},
      });
      const provider = { handleWebhook };

      const db = makeDb();
      // find payment by paymentNo+providerCode → found
      db.select
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            innerJoin: vi.fn().mockReturnValue({
              where: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  { id: "pay-001", providerId: "prov-001", status: "pending", orderId: "ord-001" },
                ]),
              }),
            }),
          }),
        });

      // insert event → no rows (duplicate)
      db.insert.mockReturnValue({
        values: vi.fn().mockReturnValue({
          onConflictDoNothing: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([]), // empty = duplicate
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

      const result = await service.handleProviderWebhook(
        "wechat_pay",
        {},
        { resource: {} },
        "",
      );
      expect(result).toMatchObject({ handled: true, duplicate: true });
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
      db.select.mockReturnValueOnce({
        from: vi.fn().mockReturnValue({
          innerJoin: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([]), // not found
            }),
          }),
        }),
      });

      const service = makeService({
        db,
        registry: { get: vi.fn().mockReturnValue(provider) } as unknown as PaymentProviderRegistry,
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
      expect(result).toMatchObject({ handled: false, reason: "payment_not_found" });
    });

    it("propagates UnauthorizedException from provider.handleWebhook (invalid signature)", async () => {
      const { UnauthorizedException } = await import("@nestjs/common");
      const handleWebhook = vi.fn().mockRejectedValue(
        new UnauthorizedException("signature invalid"),
      );
      const provider = { handleWebhook };

      const db = makeDb();

      const service = makeService({
        db,
        registry: { get: vi.fn().mockReturnValue(provider) } as unknown as PaymentProviderRegistry,
        configService: {
          listCandidateConfigsForProvider: vi.fn().mockResolvedValue([]),
        },
      });

      await expect(
        service.handleProviderWebhook("wechat_pay", {}, {}, "tampered"),
      ).rejects.toThrow(UnauthorizedException);
    });
  });

  describe("markMockSucceeded (mock payment disabled)", () => {
    it("throws NotFoundException when paymentMockEnabled is false", async () => {
      const service = makeService({});
      // Override config to disable mock
      (service as unknown as { config: { paymentMockEnabled: boolean } }).config = {
        paymentMockEnabled: false,
      };
      await expect(service.markMockSucceeded("PAY001", "admin")).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe("listProviderConfigs", () => {
    it("returns provider configs with providerCode and derivedNotifyUrl (no sensitiveConfigJson)", async () => {
      const db = makeDb();
      const providerConfigRow = {
        id: "cfg-001",
        providerId: "prov-001",
        providerCode: "wechat_pay",
        providerName: "微信支付",
        machineId: null,
        merchantNo: "MCH001",
        appId: "APP001",
        publicConfigJson: { certificateSerialNo: "ABCDEF" },
        configEncryptedJson: null,
        status: "enabled",
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
        derivedNotifyUrl: "http://localhost:3000/api/payments/webhooks/wechat_pay",
      });
      expect(results[0]).not.toHaveProperty("sensitiveConfigJson");
      expect(results[0]).not.toHaveProperty("configEncryptedJson");
    });
  });

  describe("upsertProviderConfig", () => {
    it("creates new config and calls auditService.record with create action", async () => {
      const db = makeDb();
      const mockRecord = vi.fn().mockResolvedValue(undefined);
      const mockEncrypt = vi.fn().mockReturnValue({ encrypted: "xxx" });
      const mockDecrypt = vi.fn().mockReturnValue({});
      const mockSummarize = vi.fn().mockReturnValue({ keys: [] });

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
        { get: vi.fn(), has: vi.fn().mockReturnValue(false), register: vi.fn(), list: vi.fn().mockReturnValue([]) } as never,
        auditService,
        secretService,
        { listCandidateConfigsForProvider: vi.fn(), resolveForPayment: vi.fn() } as never,
      );

      await service.upsertProviderConfig("admin-1", {
        providerCode: "wechat_pay",
        machineId: null,
        merchantNo: "MCH001",
        appId: "APP001",
        publicConfigJson: { certificateSerialNo: "SN123" },
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
});
