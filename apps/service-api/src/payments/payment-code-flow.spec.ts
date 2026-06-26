import { ConflictException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { InventoryService } from "../inventory/inventory.service";
import type { RefundsService } from "../refunds/refunds.service";
import type { PaymentProviderConfigService } from "./payment-provider-config.service";
import type {
  PaymentProviderRuntimeConfig,
  ProviderPaymentCodeChargeResult,
  ProviderPaymentCodeQueryResult,
  ProviderPaymentCodeReverseResult,
} from "./payment-provider.interface";
import type { PaymentProviderRegistry } from "./payment-provider.registry";

import { OrdersService } from "../orders/orders.service";
import { PaymentCodeOrchestratorService } from "./payment-code-orchestrator.service";

type OrchestratorPrivateMethods = {
  wait(ms: number): Promise<void>;
  confirmAttempt(
    attemptId: string,
    providerCode: string,
    config: PaymentProviderRuntimeConfig,
  ): Promise<void>;
};

type FlowAttemptStatus =
  | "created"
  | "submitting"
  | "user_confirming"
  | "querying"
  | "succeeded"
  | "failed"
  | "reversing"
  | "reversed"
  | "unknown"
  | "manual_handling"
  | "canceled";

type FlowAttempt = {
  id: string;
  paymentId: string;
  orderId: string;
  providerId: string;
  paymentProviderConfigId: string;
  providerPaymentNo: string;
  attemptNo: number;
  status: FlowAttemptStatus;
  isActive: boolean;
  amountCents: number;
  currency: string;
  authCodeHash: string;
  authCodeMasked: string;
  source: string;
  scannerHealthJson: Record<string, unknown> | null;
  providerTradeNo: string | null;
  providerStatus: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  rawPayloadJson: Record<string, unknown> | null;
  manualReason: string | null;
  submittedAt: Date | null;
  lastCheckedAt: Date | null;
  reversedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const FLOW_AUTH_CODE = "28763443825664394";
const baseFlowConfig: PaymentProviderRuntimeConfig = {
  providerCode: "alipay",
  merchantNo: null,
  appId: null,
  publicConfigJson: {},
  sensitiveConfigJson: {},
};

function maskCode(authCode: string): string {
  const trimmed = authCode.trim();
  if (trimmed.length <= 8) return `${trimmed.slice(0, 2)}****`;
  return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

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
    listMachinePaymentOptionsForMachine: vi.fn().mockResolvedValue({
      machineId: "mach-001",
      options: [],
    }),
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
    ),
    db,
    paymentProviderRegistry,
  };
}

function makeFlowHarness(overrides?: {
  chargeResponses?: ProviderPaymentCodeChargeResult[];
  queryResponses?: ProviderPaymentCodeQueryResult[];
  reverseResponses?: ProviderPaymentCodeReverseResult[];
  config?: PaymentProviderRuntimeConfig;
}) {
  const insertedAttemptRows: FlowAttempt[] = [];
  const attemptById = new Map<string, FlowAttempt>();
  const attemptByKey = new Map<string, FlowAttempt>();
  const config = overrides?.config ?? baseFlowConfig;
  const payment = {
    id: "payment-1",
    paymentNo: "PAY-PC-001",
    amountCents: 300,
    status: "pending",
    providerCode: config.providerCode,
    providerId: "provider-1",
    orderId: "order-1",
    machineId: "machine-1",
  };
  const orderState = {
    nextAction: "wait_payment" as
      | "wait_payment"
      | "dispensing"
      | "manual_handling",
  };
  const chargeQueue = [...(overrides?.chargeResponses ?? [])];
  const queryQueue = [...(overrides?.queryResponses ?? [])];
  const reverseQueue = [...(overrides?.reverseResponses ?? [])];
  const vendingService = {
    createAndDispatchCommands: vi.fn().mockResolvedValue(undefined),
  };
  const appliedEvents = new Set<string>();

  function replaceAttempt(updated: FlowAttempt): FlowAttempt {
    attemptById.set(updated.id, updated);
    for (const [key, value] of attemptByKey.entries()) {
      if (value.id === updated.id) {
        attemptByKey.set(key, updated);
      }
    }
    return updated;
  }

  const attempts = {
    createOrReplay: vi.fn().mockImplementation(async (input) => {
      const existing = attemptByKey.get(input.idempotencyKey);
      if (existing) {
        return { payment, attempt: existing, replayed: true };
      }

      const active = Array.from(attemptById.values()).find(
        (item) => item.orderId === payment.orderId && item.isActive,
      );
      if (active) {
        throw new ConflictException("payment_code_attempt_in_progress");
      }

      const attemptNo = insertedAttemptRows.length + 1;
      const attempt: FlowAttempt = {
        id: `attempt-${attemptNo}`,
        paymentId: payment.id,
        orderId: payment.orderId,
        providerId: payment.providerId,
        paymentProviderConfigId: "cfg-1",
        providerPaymentNo: `PCA${String(attemptNo).padStart(3, "0")}`,
        attemptNo,
        status: "created",
        isActive: true,
        amountCents: payment.amountCents,
        currency: "CNY",
        authCodeHash: `hash:${input.authCode.trim().length}`,
        authCodeMasked: maskCode(input.authCode),
        source: input.source,
        scannerHealthJson: input.scannerHealthJson ?? null,
        providerTradeNo: null,
        providerStatus: null,
        failureCode: null,
        failureMessage: null,
        rawPayloadJson: {
          source: input.source,
          scannerHealth: input.scannerHealthJson ?? null,
        },
        manualReason: null,
        submittedAt: null,
        lastCheckedAt: null,
        reversedAt: null,
        finishedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      insertedAttemptRows.push(attempt);
      attemptById.set(attempt.id, attempt);
      attemptByKey.set(input.idempotencyKey, attempt);
      return { payment, attempt, replayed: false };
    }),
    markStatus: vi.fn().mockImplementation(async (id, status, patch = {}) => {
      const current = attemptById.get(id);
      if (!current) throw new Error(`attempt ${id} not found`);
      const next = replaceAttempt({
        ...current,
        ...patch,
        status,
        isActive:
          patch.isActive ??
          !["succeeded", "failed", "reversed", "canceled"].includes(status),
        updatedAt: new Date(),
      });
      return next;
    }),
    markStatusIfCurrentStatusIn: vi
      .fn()
      .mockImplementation(async (id, status, allowedStatuses, patch = {}) => {
        const current = attemptById.get(id);
        if (!current) throw new Error(`attempt ${id} not found`);
        if (!allowedStatuses.includes(current.status)) return null;
        const next = replaceAttempt({
          ...current,
          ...patch,
          status,
          isActive:
            patch.isActive ??
            !["succeeded", "failed", "reversed", "canceled"].includes(status),
          updatedAt: new Date(),
        });
        return next;
      }),
    getById: vi.fn().mockImplementation(async (id) => {
      const row = attemptById.get(id);
      if (!row) throw new Error(`attempt ${id} not found`);
      return row;
    }),
    getContextById: vi.fn().mockImplementation(async (id) => {
      const attempt = attemptById.get(id);
      if (!attempt) throw new Error(`attempt ${id} not found`);
      return {
        attempt,
        paymentNo: payment.paymentNo,
        orderNo: "ORD-PC-001",
        machineId: payment.machineId,
        providerCode: payment.providerCode,
        providerConfigId: "cfg-1",
      };
    }),
  };

  const provider = {
    chargePaymentCode: vi.fn().mockImplementation(async () => {
      return (
        chargeQueue.shift() ?? {
          status: "succeeded",
          providerTradeNo: "ALI-TXN-001",
          providerStatus: "TRADE_SUCCESS",
          rawPayload: { code: "10000" },
        }
      );
    }),
    queryPaymentCode: vi.fn().mockImplementation(async () => {
      return (
        queryQueue.shift() ?? {
          status: "processing",
          providerTradeNo: "ALI-TXN-001",
          providerStatus: "WAIT_BUYER_PAY",
          rawPayload: { trade_status: "WAIT_BUYER_PAY" },
        }
      );
    }),
    reversePaymentCode: vi.fn().mockImplementation(async () => {
      return (
        reverseQueue.shift() ?? {
          status: "reversed",
          recall: false,
          providerStatus: "TRADE_CLOSED",
          rawPayload: { action: "cancel" },
        }
      );
    }),
  };

  const registry = {
    getPaymentCodeProvider: vi.fn().mockReturnValue(provider),
  };
  const configService = {
    resolveForPayment: vi.fn().mockResolvedValue(config),
    resolveForExistingPayment: vi.fn().mockResolvedValue(config),
  };
  const paymentsService = {
    applyProviderPaymentResult: vi.fn().mockImplementation(async (input) => {
      if (appliedEvents.has(input.providerEventId)) return false;
      appliedEvents.add(input.providerEventId);
      if (input.status === "succeeded") {
        orderState.nextAction = "dispensing";
        await vendingService.createAndDispatchCommands(payment.orderId);
      }
      return true;
    }),
  };

  const service = new PaymentCodeOrchestratorService(
    attempts as never,
    registry as never,
    configService as never,
    paymentsService as never,
  );

  return {
    service,
    provider,
    vendingService,
    insertedAttemptRows,
    orderState,
    seedAttempt(
      partial: Partial<FlowAttempt>,
      idempotencyKey?: string,
    ): FlowAttempt {
      const attemptNo = insertedAttemptRows.length + 1;
      const seeded: FlowAttempt = {
        id: `attempt-${attemptNo}`,
        paymentId: payment.id,
        orderId: payment.orderId,
        providerId: payment.providerId,
        paymentProviderConfigId: "cfg-1",
        providerPaymentNo: `PCA${String(attemptNo).padStart(3, "0")}`,
        attemptNo,
        status: "querying",
        isActive: true,
        amountCents: payment.amountCents,
        currency: "CNY",
        authCodeHash: "hash:18",
        authCodeMasked: "2876****4394",
        source: "serial_text",
        scannerHealthJson: null,
        providerTradeNo: "ALI-TXN-SEEDED",
        providerStatus: null,
        failureCode: null,
        failureMessage: null,
        rawPayloadJson: null,
        manualReason: null,
        submittedAt: new Date(),
        lastCheckedAt: null,
        reversedAt: null,
        finishedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...partial,
      };
      insertedAttemptRows.push(seeded);
      attemptById.set(seeded.id, seeded);
      if (idempotencyKey) {
        attemptByKey.set(idempotencyKey, seeded);
      }
      return seeded;
    },
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

  it("submits payment code successfully once, redacts stored attempts, and replays by idempotency key", async () => {
    const {
      service,
      provider,
      vendingService,
      insertedAttemptRows,
      orderState,
    } = makeFlowHarness();

    const first = await service.submit({
      orderNo: "ORD-PC-001",
      machineCode: "M-001",
      authCode: FLOW_AUTH_CODE,
      idempotencyKey: "idem-success",
      source: "serial_text",
      scannerHealth: {
        online: true,
        adapter: "serial_text",
        port: "/dev/ttyUSB1",
        message: "scanner ready",
      },
      clientIp: "127.0.0.1",
    });
    const replay = await service.submit({
      orderNo: "ORD-PC-001",
      machineCode: "M-001",
      authCode: FLOW_AUTH_CODE,
      idempotencyKey: "idem-success",
      source: "serial_text",
      scannerHealth: {
        online: true,
        adapter: "serial_text",
        port: "/dev/ttyUSB1",
        message: "scanner ready",
      },
      clientIp: "127.0.0.1",
    });

    expect(first.status).toBe("succeeded");
    expect(first.nextAction).toBe("dispensing");
    expect(replay.status).toBe("succeeded");
    expect(orderState.nextAction).toBe("dispensing");
    expect(JSON.stringify(insertedAttemptRows)).not.toContain(FLOW_AUTH_CODE);
    expect(provider.chargePaymentCode).toHaveBeenCalledTimes(1);
    expect(vendingService.createAndDispatchCommands).toHaveBeenCalledTimes(1);
  });

  it("returns retryable failure when provider rejects the scanned code", async () => {
    const { service, provider, orderState } = makeFlowHarness({
      chargeResponses: [
        {
          status: "failed",
          providerTradeNo: null,
          providerStatus: "AUTH_CODE_INVALID",
          failureCode: "AUTH_CODE_INVALID",
          failureMessage: "付款码已失效",
          rawPayload: { sub_code: "AUTH_CODE_INVALID" },
        },
      ],
    });

    const result = await service.submit({
      orderNo: "ORD-PC-002",
      machineCode: "M-001",
      authCode: FLOW_AUTH_CODE,
      idempotencyKey: "idem-failed",
      source: "serial_text",
      scannerHealth: {
        online: true,
        adapter: "serial_text",
        port: "/dev/ttyUSB1",
        message: "scanner ready",
      },
      clientIp: "127.0.0.1",
    });

    expect(result.status).toBe("failed");
    expect(result.canRetry).toBe(true);
    expect(orderState.nextAction).toBe("wait_payment");
    expect(provider.chargePaymentCode).toHaveBeenCalledTimes(1);
  });

  it("rejects a different idempotency key while an active attempt exists", async () => {
    const { service, provider, seedAttempt } = makeFlowHarness();
    seedAttempt(
      {
        status: "user_confirming",
        isActive: true,
      },
      "idem-active",
    );

    await expect(
      service.submit({
        orderNo: "ORD-PC-003",
        machineCode: "M-001",
        authCode: FLOW_AUTH_CODE,
        idempotencyKey: "idem-active-new",
        source: "serial_text",
        scannerHealth: {
          online: true,
          adapter: "serial_text",
          port: "/dev/ttyUSB1",
          message: "scanner ready",
        },
        clientIp: "127.0.0.1",
      }),
    ).rejects.toThrow(ConflictException);

    expect(provider.chargePaymentCode).not.toHaveBeenCalled();
  });

  it("moves unknown attempts into manual_handling and replay does not allow retry", async () => {
    const config: PaymentProviderRuntimeConfig = {
      providerCode: "alipay",
      merchantNo: null,
      appId: null,
      publicConfigJson: {
        paymentCodePollIntervalSeconds: 1,
        paymentCodeMaxConfirmSeconds: 1,
        paymentCodeReverseMaxAttempts: 3,
      },
      sensitiveConfigJson: {},
    };
    const { service, provider, seedAttempt } = makeFlowHarness({
      config,
      queryResponses: [
        {
          status: "processing",
          providerTradeNo: "ALI-TXN-MANUAL",
          providerStatus: "WAIT_BUYER_PAY",
          rawPayload: { trade_status: "WAIT_BUYER_PAY" },
        },
      ],
      reverseResponses: [
        {
          status: "unknown",
          recall: true,
          providerStatus: "SYSTEMERROR",
          rawPayload: { err_code: "SYSTEMERROR" },
        },
        {
          status: "unknown",
          recall: true,
          providerStatus: "SYSTEMERROR",
          rawPayload: { err_code: "SYSTEMERROR" },
        },
        {
          status: "unknown",
          recall: true,
          providerStatus: "SYSTEMERROR",
          rawPayload: { err_code: "SYSTEMERROR" },
        },
      ],
    });
    const attempt = seedAttempt(
      {
        status: "querying",
        providerTradeNo: "ALI-TXN-MANUAL",
        providerPaymentNo: "PCA999",
      },
      "idem-manual",
    );
    const privateApi = service as unknown as OrchestratorPrivateMethods;
    vi.spyOn(privateApi, "wait").mockResolvedValue(undefined);
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(2_000);

    await privateApi.confirmAttempt(attempt.id, "alipay", config);

    const replay = await service.submit({
      orderNo: "ORD-PC-004",
      machineCode: "M-001",
      authCode: FLOW_AUTH_CODE,
      idempotencyKey: "idem-manual",
      source: "serial_text",
      scannerHealth: {
        online: true,
        adapter: "serial_text",
        port: "/dev/ttyUSB1",
        message: "scanner ready",
      },
      clientIp: "127.0.0.1",
    });

    expect(provider.queryPaymentCode).toHaveBeenCalledTimes(1);
    expect(provider.reversePaymentCode).toHaveBeenCalledTimes(3);
    expect(replay.status).toBe("manual_handling");
    expect(replay.nextAction).toBe("manual_handling");
    expect(replay.canRetry).toBe(false);
  });
});
