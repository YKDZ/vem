import type { PermissionCode } from "@vem/shared";

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
    select: vi.fn().mockImplementation(() => makeEmptyLatestSelectResult()),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "pay-claim", fence: 1 }]),
        }),
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
  refundsService?: Partial<RefundsService>;
  auditService?: { record: ReturnType<typeof vi.fn> };
  vendingService?: {
    resolveCommand?: ReturnType<typeof vi.fn>;
    createCompensationDispenseCommand?: ReturnType<typeof vi.fn>;
  };
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
    assertMachinePaymentChannelAvailable: vi.fn().mockResolvedValue(undefined),
    listMachinePaymentOptionsForMachine: vi.fn().mockResolvedValue({
      machineId: "mach-1",
      options: [],
    }),
    createBindingSnapshot: vi.fn((config: Record<string, unknown>) => ({
      version: 1,
      id: config.id ?? "cfg-1",
      providerCode: config.providerCode,
      merchantNo: config.merchantNo ?? null,
      appId: config.appId ?? null,
      publicConfigJson: config.publicConfigJson ?? {},
      sensitiveConfigEncryptedJson: { encrypted: "test" },
      boundAt: "2026-07-08T00:00:00.000Z",
    })),
    ...overrides.configService,
  } as unknown as PaymentProviderConfigService;
  const inventoryService: InventoryService = {
    reserveForOrder: vi.fn().mockResolvedValue(undefined),
    reserveItems: vi.fn().mockResolvedValue(undefined),
    releaseReservation: vi.fn().mockResolvedValue(undefined),
    ...overrides.inventoryService,
  } as unknown as InventoryService;
  const refundsService: RefundsService = {
    requestFullRefund: vi.fn().mockResolvedValue(undefined),
    ...overrides.refundsService,
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
  const auditService = overrides.auditService ?? {
    record: vi.fn().mockResolvedValue(undefined),
  };
  const vendingService = {
    resolveCommand: vi.fn().mockResolvedValue({}),
    createCompensationDispenseCommand: vi.fn().mockResolvedValue({}),
    ...overrides.vendingService,
  };

  return new OrdersService(
    db as never,
    inventoryService,
    registry,
    configService,
    refundsService,
    auditService as never,
    vendingService as never,
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

function makeQueuedDb(rowsBySelect: unknown[][]) {
  const calls: Array<{
    selection: unknown;
    fromTable: unknown;
    whereArgs: unknown[];
  }> = [];

  class SelectResult implements PromiseLike<unknown[]> {
    constructor(
      private readonly rows: unknown[],
      private readonly call: (typeof calls)[number],
    ) {}

    from(table: unknown) {
      this.call.fromTable = table;
      return this;
    }

    innerJoin() {
      return this;
    }

    leftJoin() {
      return this;
    }

    where(condition: unknown) {
      this.call.whereArgs.push(condition);
      return this;
    }

    orderBy() {
      return this;
    }

    limit() {
      return this;
    }

    offset() {
      return this;
    }

    then<TResult1 = unknown[], TResult2 = never>(
      onfulfilled?:
        | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(this.rows).then(onfulfilled, onrejected);
    }
  }

  return {
    calls,
    select: vi.fn().mockImplementation((selection?: unknown) => {
      const rows = rowsBySelect.shift();
      if (!rows) throw new Error("unexpected select");
      const call = { selection, fromTable: null, whereArgs: [] };
      calls.push(call);
      return new SelectResult(rows, call);
    }),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  };
}

function makeRecoveryDb(
  rowsBySelect: unknown[][],
  options?: { insertError?: Error },
) {
  class SelectResult implements PromiseLike<unknown[]> {
    constructor(private readonly rows: unknown[]) {}

    from() {
      return this;
    }

    innerJoin() {
      return this;
    }

    where() {
      return this;
    }

    orderBy() {
      return this;
    }

    limit() {
      return this;
    }

    then<TResult1 = unknown[], TResult2 = never>(
      onfulfilled?:
        | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
        | null,
      onrejected?:
        | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
        | null,
    ): PromiseLike<TResult1 | TResult2> {
      return Promise.resolve(this.rows).then(onfulfilled, onrejected);
    }
  }

  const tx = {
    select: vi.fn().mockImplementation(() => {
      const rows = rowsBySelect.shift();
      if (!rows) throw new Error("unexpected select");
      return new SelectResult(rows);
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn(() => {
        if (options?.insertError) throw options.insertError;
        return {
          returning: vi.fn().mockResolvedValue([{ id: "recovery-action-1" }]),
        };
      }),
    }),
  };
  const db = {
    transaction: vi
      .fn()
      .mockImplementation(async (fn: (transaction: typeof tx) => unknown) =>
        fn(tx),
      ),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  };
  return { db, tx };
}

function allInvestigationPermissions(): PermissionCode[] {
  return [
    "orders.read",
    "payments.read",
    "inventory.read",
    "maintenanceWorkOrders.read",
    "audit.read",
  ];
}

const dtoDate = new Date("2026-06-26T04:00:00.000Z");

function investigationItem(overrides: Record<string, unknown> = {}) {
  return {
    id: "item-1",
    variantId: "variant-1",
    quantity: 1,
    unitPriceCents: 1200,
    productSnapshot: {},
    ...overrides,
  };
}

function investigationPayment(overrides: Record<string, unknown> = {}) {
  return {
    id: "payment-1",
    paymentNo: "PAY-1",
    orderId: "order-1",
    method: "payment_code",
    status: "succeeded",
    amountCents: 1200,
    providerTradeNo: null,
    expiresAt: null,
    paidAt: dtoDate,
    failedReason: null,
    createdAt: dtoDate,
    updatedAt: dtoDate,
    ...overrides,
  };
}

function investigationPaymentEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "event-1",
    paymentId: "payment-1",
    eventType: "paid",
    providerEventId: "provider-event-1",
    signatureValid: true,
    handledAt: dtoDate,
    createdAt: dtoDate,
    ...overrides,
  };
}

function investigationWebhookAttempt(overrides: Record<string, unknown> = {}) {
  return {
    id: "webhook-1",
    providerCode: "mock",
    paymentId: "payment-1",
    refundId: null,
    eventKind: "payment",
    eventType: "payment.succeeded",
    providerEventId: "provider-event-1",
    paymentNo: "PAY-1",
    refundNo: null,
    orderNo: "ORD-1",
    signatureValid: true,
    businessValid: true,
    handled: true,
    duplicate: false,
    failureReason: null,
    errorCode: null,
    httpStatus: 200,
    createdAt: dtoDate,
    updatedAt: dtoDate,
    ...overrides,
  };
}

function investigationReconciliationAttempt(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "reconcile-1",
    paymentId: "payment-1",
    trigger: "manual",
    attemptNo: 1,
    status: "succeeded",
    providerPaymentStatus: null,
    providerTradeNo: null,
    errorCode: null,
    errorMessage: null,
    nextRetryAt: null,
    startedAt: dtoDate,
    finishedAt: dtoDate,
    createdAt: dtoDate,
    ...overrides,
  };
}

function investigationPaymentCodeAttempt(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "code-1",
    paymentId: "payment-1",
    orderId: "order-1",
    attemptNo: 1,
    providerPaymentNo: "PCA001",
    idempotencyKey: "idem-1",
    status: "reversed",
    isActive: false,
    amountCents: 1200,
    currency: "CNY",
    authCodeMasked: "134***9988",
    source: "scanner",
    providerTradeNo: "ALI-TXN-001",
    providerStatus: "TRADE_CLOSED",
    failureCode: "PAYMENT_CODE_REVERSED",
    failureMessage: "本次付款码交易已撤销，请刷新付款码后重试",
    submittedAt: dtoDate,
    lastCheckedAt: dtoDate,
    reversedAt: dtoDate,
    finishedAt: dtoDate,
    manualReason: "query_timeout_reversed",
    createdAt: dtoDate,
    updatedAt: dtoDate,
    ...overrides,
  };
}

function investigationVendingCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: "command-1",
    commandNo: "VC-1",
    orderId: "order-1",
    machineId: "machine-1",
    machineCode: "VEM-001",
    slotId: "slot-1",
    slotCode: "A1",
    orderItemId: "item-1",
    commandKind: "dispatch",
    recoveryActionId: null,
    status: "failed",
    sentAt: dtoDate,
    ackAt: dtoDate,
    resultAt: dtoDate,
    retryCount: 0,
    lastError: "jammed",
    createdAt: dtoDate,
    updatedAt: dtoDate,
    ...overrides,
  };
}

function investigationInventoryMovement(
  overrides: Record<string, unknown> = {},
) {
  return {
    id: "movement-1",
    inventoryId: "inventory-1",
    deltaQty: 0,
    reason: "purchase_reserved",
    orderId: "order-1",
    operatorAdminUserId: null,
    note: null,
    createdAt: dtoDate,
    ...overrides,
  };
}

function investigationStockLink(overrides: Record<string, unknown> = {}) {
  return {
    id: "raw-1",
    caseTable: "machine_raw_stock_movements",
    rawMovementId: null,
    machineId: "machine-1",
    movementId: "raw-stock-1",
    status: "reconciliation",
    reconciliationReason: "order_context_mismatch",
    platformReviewStatus: "open",
    saleSafetyBlockerState: null,
    saleSafetyBlockerSlotId: null,
    receivedAt: dtoDate,
    ...overrides,
  };
}

function investigationRefund(overrides: Record<string, unknown> = {}) {
  return {
    id: "refund-1",
    refundNo: "RFD-1",
    paymentId: "payment-1",
    orderId: "order-1",
    amountCents: 1200,
    status: "processing",
    providerRefundNo: null,
    reason: "dispense_failed",
    requestedByAdminUserId: null,
    refundedAt: null,
    createdAt: dtoDate,
    updatedAt: dtoDate,
    ...overrides,
  };
}

function investigationWorkOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "work-1",
    workOrderNo: "WO-1",
    machineId: "machine-1",
    slotId: null,
    orderId: "order-1",
    commandId: "command-1",
    title: "Check slot",
    priority: "medium",
    status: "open",
    assigneeAdminUserId: null,
    createdAt: dtoDate,
    updatedAt: dtoDate,
    resolvedAt: null,
    ...overrides,
  };
}

function investigationAuditEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "audit-1",
    adminUserId: null,
    action: "orders.refund_request",
    resourceType: "order",
    resourceId: "order-1",
    ipAddress: null,
    userAgent: null,
    createdAt: dtoDate,
    ...overrides,
  };
}

function collectDebugTokens(value: unknown): string[] {
  const tokens: string[] = [];
  const seen = new WeakSet<object>();

  function visit(current: unknown): void {
    if (
      current === null ||
      current === undefined ||
      typeof current === "function"
    ) {
      return;
    }
    if (typeof current !== "object") {
      tokens.push(String(current));
      return;
    }
    if (seen.has(current)) return;
    seen.add(current);

    const record = current as Record<string, unknown>;
    if (typeof record["name"] === "string") tokens.push(record["name"]);
    if ("value" in record) visit(record["value"]);
    for (const nested of Object.values(record)) visit(nested);
  }

  visit(value);
  return tokens;
}

describe("OrdersService", () => {
  describe("listOrders", () => {
    it("projects drill markers in the admin order list", async () => {
      const db = makeDb();
      let selectedFields: Record<string, unknown> | undefined;

      db.select
        .mockImplementationOnce((fields: Record<string, unknown>) => {
          selectedFields = fields;
          return {
            from: vi.fn().mockReturnValue({
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
          };
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([{ total: 0 }]),
          }),
        });

      const service = makeService({ db });

      await service.listOrders({ page: 1, pageSize: 20 });

      expect(selectedFields).toEqual(
        expect.objectContaining({
          isDrill: expect.anything(),
          isTest: expect.anything(),
          scenario: expect.anything(),
        }),
      );
    });
  });

  describe("getOrderInvestigation", () => {
    it("aggregates payment, fulfillment, inventory, refund, work order, and audit evidence for one order", async () => {
      const paidAt = new Date("2026-06-26T04:00:00.000Z");
      const db = makeQueuedDb([
        [
          {
            id: "order-1",
            orderNo: "ORD-1",
            machineId: "machine-1",
            machineCode: "VEM-001",
            status: "manual_handling",
            paymentState: "paid",
            fulfillmentState: "dispense_failed",
            totalAmountCents: 1200,
            currency: "CNY",
            paidAt,
            dispensedAt: null,
            canceledAt: null,
            createdAt: new Date("2026-06-26T03:59:00.000Z"),
          },
        ],
        [],
        [investigationPayment({ paidAt })],
        [investigationPaymentEvent({ createdAt: paidAt })],
        [investigationWebhookAttempt({ createdAt: paidAt, updatedAt: paidAt })],
        [
          investigationReconciliationAttempt({
            startedAt: paidAt,
            finishedAt: paidAt,
            createdAt: paidAt,
          }),
        ],
        [
          investigationPaymentCodeAttempt({
            lastCheckedAt: new Date("2026-06-26T04:01:00.000Z"),
            reversedAt: new Date("2026-06-26T04:02:00.000Z"),
          }),
        ],
        [investigationVendingCommand({ resultAt: paidAt, createdAt: paidAt })],
        [investigationInventoryMovement({ createdAt: paidAt })],
        [
          investigationStockLink({
            saleSafetyBlockerState: "needs_platform_review",
            receivedAt: paidAt,
          }),
        ],
        [],
        [investigationRefund({ createdAt: paidAt, updatedAt: paidAt })],
        [
          {
            refundId: "refund-1",
            trigger: "manual",
            attemptNo: 1,
            status: "network_error",
            providerRefundStatus: null,
            providerRefundNo: null,
            errorCode: "query_failed",
            errorMessage: "provider timeout",
            nextRetryAt: null,
            startedAt: paidAt,
            finishedAt: paidAt,
            createdAt: paidAt,
          },
        ],
        [{ total: 1 }],
        [],
        [investigationWorkOrder({ createdAt: paidAt, updatedAt: paidAt })],
        [investigationAuditEntry({ createdAt: paidAt })],
        [],
      ]);

      const service = makeService({ db: db as never });

      const investigation = await service.getOrderInvestigation(
        "order-1",
        allInvestigationPermissions(),
      );

      expect(investigation).toMatchObject({
        order: {
          orderNo: "ORD-1",
          machineCode: "VEM-001",
          paymentState: "paid",
          fulfillmentState: "dispense_failed",
        },
        payments: [{ paymentNo: "PAY-1", status: "succeeded" }],
        paymentWebhookAttempts: [{ id: "webhook-1" }],
        paymentReconciliationAttempts: [{ id: "reconcile-1" }],
        paymentCodeAttempts: [
          {
            id: "code-1",
            status: "reversed",
            authCodeMasked: "134***9988",
            manualReason: "query_timeout_reversed",
            protectedDiagnostics: {
              providerPaymentNo: "PCA001",
              providerTradeNo: "ALI-TXN-001",
              providerStatus: "TRADE_CLOSED",
              failureCode: "PAYMENT_CODE_REVERSED",
              failureMessage: "本次付款码交易已撤销，请刷新付款码后重试",
            },
          },
        ],
        vendingCommands: [
          {
            commandNo: "VC-1",
            status: "failed",
            machineCode: "VEM-001",
            slotCode: "A1",
          },
        ],
        fulfillmentProjection: {
          state: "dispense_failed",
          requiresPhysicalOutcomeConfirmation: false,
        },
        inventoryMovements: [{ id: "movement-1" }],
        stockReconciliationLinks: [
          {
            movementId: "raw-stock-1",
            status: "reconciliation",
            platformReviewStatus: "open",
          },
        ],
        refunds: [
          {
            refundNo: "RFD-1",
            status: "processing",
            reconciliationAttempts: [
              {
                trigger: "manual",
                status: "network_error",
                protectedDiagnostics: {
                  errorMessage: "provider timeout",
                },
              },
            ],
          },
        ],
        maintenanceWorkOrders: [{ workOrderNo: "WO-1", status: "open" }],
        adminAuditEntries: [{ action: "orders.refund_request" }],
        orderStatusEvents: [],
      });
      expect(JSON.stringify(investigation.paymentCodeAttempts)).not.toContain(
        "authCodeHash",
      );
      expect(JSON.stringify(investigation.paymentCodeAttempts)).not.toContain(
        "rawPayloadJson",
      );
    });

    it("keeps orders.read users on order detail and fulfillment basics only", async () => {
      const paidAt = new Date("2026-06-26T04:00:00.000Z");
      const db = makeQueuedDb([
        [
          {
            id: "order-1",
            orderNo: "ORD-1",
            machineId: "machine-1",
            machineCode: "VEM-001",
            status: "manual_handling",
            paymentState: "paid",
            fulfillmentState: "dispense_failed",
            totalAmountCents: 1200,
            currency: "CNY",
            paidAt,
            dispensedAt: null,
            canceledAt: null,
            createdAt: paidAt,
          },
        ],
        [investigationItem({ orderId: "order-1" })],
        [investigationVendingCommand({ resultAt: paidAt, createdAt: paidAt })],
        [{ total: 0 }],
        [],
        [],
      ]);

      const service = makeService({ db: db as never });

      await expect(
        service.getOrderInvestigation("order-1", ["orders.read"]),
      ).resolves.toMatchObject({
        items: [{ id: "item-1" }],
        payments: [],
        paymentEvents: [],
        paymentWebhookAttempts: [],
        paymentReconciliationAttempts: [],
        paymentCodeAttempts: [],
        vendingCommands: [{ commandNo: "VC-1" }],
        inventoryMovements: [],
        stockReconciliationLinks: [],
        refunds: [],
        maintenanceWorkOrders: [],
        adminAuditEntries: [],
        orderStatusEvents: [],
      });
      expect(db.select).toHaveBeenCalledTimes(6);
    });

    it("uses explicit payment DTO projections without raw payload or auth hash fields", async () => {
      const paidAt = new Date("2026-06-26T04:00:00.000Z");
      const db = makeQueuedDb([
        [
          {
            id: "order-1",
            orderNo: "ORD-1",
            machineId: "machine-1",
            machineCode: "VEM-001",
            status: "paid",
            paymentState: "paid",
            fulfillmentState: "dispensed",
            totalAmountCents: 1200,
            currency: "CNY",
            paidAt,
            dispensedAt: paidAt,
            canceledAt: null,
            createdAt: paidAt,
          },
        ],
        [],
        [investigationPayment({ paidAt })],
        [investigationPaymentEvent({ createdAt: paidAt })],
        [investigationWebhookAttempt({ createdAt: paidAt, updatedAt: paidAt })],
        [investigationReconciliationAttempt({ createdAt: paidAt })],
        [investigationPaymentCodeAttempt({ createdAt: paidAt })],
        [],
        [investigationRefund({ createdAt: paidAt, updatedAt: paidAt })],
        [],
        [{ total: 1 }],
        [],
        [],
      ]);

      const service = makeService({ db: db as never });

      await service.getOrderInvestigation("order-1", [
        "orders.read",
        "payments.read",
      ]);

      const paymentEventSelection = db.calls.find(
        (call) =>
          typeof call.selection === "object" &&
          call.selection !== null &&
          "eventType" in call.selection &&
          "signatureValid" in call.selection,
      )?.selection as Record<string, unknown>;
      const webhookSelection = db.calls.find(
        (call) =>
          typeof call.selection === "object" &&
          call.selection !== null &&
          "handled" in call.selection &&
          "businessValid" in call.selection,
      )?.selection as Record<string, unknown>;
      const reconciliationSelection = db.calls.find(
        (call) =>
          typeof call.selection === "object" &&
          call.selection !== null &&
          "trigger" in call.selection &&
          "attemptNo" in call.selection,
      )?.selection as Record<string, unknown>;
      const paymentCodeSelection = db.calls.find(
        (call) =>
          typeof call.selection === "object" &&
          call.selection !== null &&
          "authCodeMasked" in call.selection,
      )?.selection as Record<string, unknown>;

      expect(paymentEventSelection).not.toHaveProperty("providerEventId");
      expect(paymentEventSelection).not.toHaveProperty("rawPayloadJson");
      expect(webhookSelection).not.toHaveProperty("providerCode");
      expect(webhookSelection).not.toHaveProperty("providerEventId");
      expect(webhookSelection).not.toHaveProperty("errorCode");
      expect(webhookSelection).not.toHaveProperty("rawBodyExcerpt");
      expect(webhookSelection).not.toHaveProperty("redactedPayloadJson");
      expect(reconciliationSelection).not.toHaveProperty(
        "providerPaymentStatus",
      );
      expect(reconciliationSelection).not.toHaveProperty("providerTradeNo");
      expect(reconciliationSelection).not.toHaveProperty("errorCode");
      expect(reconciliationSelection).not.toHaveProperty("errorMessage");
      expect(reconciliationSelection).not.toHaveProperty("rawPayloadExcerpt");
      expect(reconciliationSelection).not.toHaveProperty("rawPayloadSha256");
      expect(paymentCodeSelection).not.toHaveProperty("providerPaymentNo");
      expect(paymentCodeSelection).not.toHaveProperty("providerTradeNo");
      expect(paymentCodeSelection).not.toHaveProperty("providerStatus");
      expect(paymentCodeSelection).not.toHaveProperty("failureCode");
      expect(paymentCodeSelection).not.toHaveProperty("failureMessage");
      expect(paymentCodeSelection).not.toHaveProperty("authCodeHash");
      expect(paymentCodeSelection).not.toHaveProperty("rawPayloadJson");
      expect(paymentCodeSelection).not.toHaveProperty("scannerHealthJson");
    });

    it("matches audit entries by resource type and id across visible evidence partitions", async () => {
      const paidAt = new Date("2026-06-26T04:00:00.000Z");
      const db = makeQueuedDb([
        [
          {
            id: "order-1",
            orderNo: "ORD-1",
            machineId: "machine-1",
            machineCode: "VEM-001",
            status: "manual_handling",
            paymentState: "paid",
            fulfillmentState: "dispense_failed",
            totalAmountCents: 1200,
            currency: "CNY",
            paidAt,
            dispensedAt: null,
            canceledAt: null,
            createdAt: paidAt,
          },
        ],
        [],
        [investigationPayment({ paidAt })],
        [],
        [],
        [],
        [],
        [investigationVendingCommand({ createdAt: paidAt, updatedAt: paidAt })],
        [investigationInventoryMovement({ createdAt: paidAt })],
        [investigationStockLink({ receivedAt: paidAt })],
        [
          investigationStockLink({
            id: "conflict-1",
            caseTable: "machine_raw_stock_movement_conflicts",
            rawMovementId: "raw-1",
            receivedAt: paidAt,
          }),
        ],
        [investigationRefund({ createdAt: paidAt, updatedAt: paidAt })],
        [],
        [{ total: 1 }],
        [],
        [investigationWorkOrder({ createdAt: paidAt, updatedAt: paidAt })],
        [],
        [],
      ]);

      const service = makeService({ db: db as never });

      const investigation = await service.getOrderInvestigation(
        "order-1",
        allInvestigationPermissions(),
      );

      expect(investigation.stockReconciliationLinks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "conflict-1",
            caseTable: "machine_raw_stock_movement_conflicts",
          }),
        ]),
      );

      const auditWhere = db.calls.find(
        (call) =>
          typeof call.selection === "object" &&
          call.selection !== null &&
          "action" in call.selection &&
          "resourceType" in call.selection,
      )?.whereArgs[0];
      const tokens = collectDebugTokens(auditWhere);

      expect(tokens).toContain("resource_type");
      expect(tokens).toContain("resource_id");
      expect(tokens).toEqual(expect.arrayContaining(["order", "order-1"]));
      expect(tokens).toEqual(expect.arrayContaining(["payment", "payment-1"]));
      expect(tokens).toEqual(expect.arrayContaining(["refund", "refund-1"]));
      expect(tokens).toEqual(
        expect.arrayContaining(["vending_command", "command-1"]),
      );
      expect(tokens).toEqual(
        expect.arrayContaining(["inventory_movement", "movement-1"]),
      );
      expect(tokens).toEqual(
        expect.arrayContaining(["machine_raw_stock_movement", "raw-1"]),
      );
      expect(tokens).toEqual(
        expect.arrayContaining([
          "machine_raw_stock_movement_conflict",
          "conflict-1",
        ]),
      );
      expect(tokens).toEqual(
        expect.arrayContaining(["maintenance_work_order", "work-1"]),
      );
    });

    it("limits raw stock reconciliation evidence to the order machine", async () => {
      const paidAt = new Date("2026-06-26T04:00:00.000Z");
      const db = makeQueuedDb([
        [
          {
            id: "order-1",
            orderNo: "ORD-1",
            machineId: "machine-1",
            machineCode: "VEM-001",
            status: "manual_handling",
            paymentState: "paid",
            fulfillmentState: "dispense_failed",
            totalAmountCents: 1200,
            currency: "CNY",
            paidAt,
            dispensedAt: null,
            canceledAt: null,
            createdAt: paidAt,
          },
        ],
        [],
        [],
        [],
        [],
        [],
        [{ total: 0 }],
        [],
        [],
      ]);

      const service = makeService({ db: db as never });

      await service.getOrderInvestigation("order-1", [
        "orders.read",
        "inventory.read",
      ]);

      const stockWhere = db.calls.find(
        (call) =>
          typeof call.selection === "object" &&
          call.selection !== null &&
          "movementId" in call.selection &&
          "platformReviewStatus" in call.selection,
      )?.whereArgs[0];
      const tokens = collectDebugTokens(stockWhere);

      expect(tokens).toEqual(
        expect.arrayContaining(["machine_id", "machine-1"]),
      );
      expect(tokens).toEqual(expect.arrayContaining(["order-1", "ORD-1"]));
    });
  });

  describe("createRecoveryAction", () => {
    const resultUnknownCommand = {
      id: "command-1",
      commandNo: "CMD-1",
      status: "result_unknown",
      orderStatus: "manual_handling",
      fulfillmentState: "manual_handling",
    };

    it("rejects recovery while the latest command is still in flight", async () => {
      const { db, tx } = makeRecoveryDb([
        [
          {
            ...resultUnknownCommand,
            status: "acknowledged",
            fulfillmentState: "dispensing",
          },
        ],
        [],
        [],
      ]);
      const service = makeService({ db: db as never });

      await expect(
        service.createRecoveryAction("order-1", "admin-1", {
          action: "confirm_dispensed",
          note: "operator tried too early",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.insert).not.toHaveBeenCalled();
    });

    it("confirms not dispensed without immediately requesting a refund", async () => {
      const { db } = makeRecoveryDb([[resultUnknownCommand], [], []]);
      const requestFullRefund = vi.fn().mockResolvedValue({ id: "refund-1" });
      const resolveCommand = vi.fn().mockResolvedValue({
        commandId: "command-1",
        status: "failed",
      });
      const auditService = { record: vi.fn().mockResolvedValue(undefined) };
      const service = makeService({
        db: db as never,
        refundsService: { requestFullRefund },
        auditService,
        vendingService: { resolveCommand },
      });

      await expect(
        service.createRecoveryAction("order-1", "admin-1", {
          action: "confirm_not_dispensed",
          note: "operator found product in slot",
        }),
      ).resolves.toMatchObject({
        action: "confirm_not_dispensed",
        commandId: "command-1",
        status: "failed",
      });
      expect(resolveCommand).toHaveBeenCalledWith("command-1", {
        result: "not_dispensed",
        note: "operator found product in slot",
        requestRefund: false,
      });
      expect(requestFullRefund).not.toHaveBeenCalled();
    });

    it("blocks normal recovery for drill orders before vending or refund side effects", async () => {
      const { db, tx } = makeRecoveryDb([
        [{ ...resultUnknownCommand, isDrill: true }],
        [],
        [],
      ]);
      const requestFullRefund = vi.fn();
      const resolveCommand = vi.fn();
      const service = makeService({
        db: db as never,
        refundsService: { requestFullRefund },
        vendingService: { resolveCommand },
      });

      await expect(
        service.createRecoveryAction("order-1", "admin-1", {
          action: "confirm_dispensed",
          note: "must use protected drill recovery",
        }),
      ).rejects.toThrow(
        "Protected drill recovery uses drill simulation endpoints",
      );
      expect(tx.insert).not.toHaveBeenCalled();
      expect(resolveCommand).not.toHaveBeenCalled();
      expect(requestFullRefund).not.toHaveBeenCalled();
    });

    it("maps recovery action unique violations to conflict", async () => {
      const uniqueViolation = Object.assign(new Error("unique violation"), {
        code: "23505",
      });
      const { db } = makeRecoveryDb([[resultUnknownCommand], [], []], {
        insertError: uniqueViolation,
      });
      const service = makeService({ db: db as never });

      await expect(
        service.createRecoveryAction("order-1", "admin-1", {
          action: "confirm_dispensed",
          note: "duplicate operator action",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("requires completed not-dispensed confirmation before requesting refund", async () => {
      const { db } = makeRecoveryDb([
        [{ ...resultUnknownCommand, status: "failed" }],
        [],
        [],
      ]);
      const requestFullRefund = vi.fn();
      const service = makeService({
        db: db as never,
        refundsService: { requestFullRefund },
      });

      await expect(
        service.createRecoveryAction("order-1", "admin-1", {
          action: "request_refund",
          note: "refund after operator confirmation",
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(requestFullRefund).not.toHaveBeenCalled();
    });

    it("requests refund only after completed not-dispensed confirmation", async () => {
      const { db } = makeRecoveryDb([
        [{ ...resultUnknownCommand, status: "failed" }],
        [
          {
            id: "confirm-action-1",
            commandId: "command-1",
            action: "confirm_not_dispensed",
            status: "completed",
          },
        ],
        [],
      ]);
      const requestFullRefund = vi.fn().mockResolvedValue({
        id: "refund-1",
        refundNo: "RFD-1",
        paymentId: "payment-1",
        orderId: "order-1",
        amountCents: 500,
        status: "created",
        providerRefundNo: null,
        reason: "admin_refund",
        requestedByAdminUserId: "admin-1",
        refundedAt: null,
        createdAt: new Date("2026-07-05T00:00:00.000Z"),
        updatedAt: new Date("2026-07-05T00:00:00.000Z"),
      });
      const service = makeService({
        db: db as never,
        refundsService: { requestFullRefund },
      });

      await expect(
        service.createRecoveryAction("order-1", "admin-1", {
          action: "request_refund",
          note: "refund after operator confirmation",
        }),
      ).resolves.toMatchObject({
        action: "request_refund",
        commandId: "command-1",
        status: "refund_requested",
      });
      expect(requestFullRefund).toHaveBeenCalledWith({
        orderId: "order-1",
        reason: "admin_refund",
        requestedByAdminUserId: "admin-1",
      });
    });
  });

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
      expect(result.paymentId).toBe("pay-001");
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

    it("rejects policy-disabled channel before resolving provider config or creating a draft", async () => {
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
      const assertMachinePaymentChannelAvailable = vi
        .fn()
        .mockRejectedValue(
          new ConflictException("Payment channel is not available"),
        );
      const resolveForPayment = vi.fn();

      const service = makeService({
        db,
        configService: {
          assertMachinePaymentChannelAvailable,
          resolveForPayment,
        },
      });

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
          paymentProviderCode: "alipay",
        }),
      ).rejects.toThrow(ConflictException);

      expect(assertMachinePaymentChannelAvailable).toHaveBeenCalledWith({
        machineId: "mach-1",
        providerCode: "alipay",
        method: "qr_code",
      });
      expect(resolveForPayment).not.toHaveBeenCalled();
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it("rejects provider-incomplete channel before creating a payment_code draft", async () => {
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
      const assertMachinePaymentChannelAvailable = vi
        .fn()
        .mockRejectedValue(
          new ConflictException("Payment channel is not available"),
        );
      const resolveForPayment = vi.fn();

      const service = makeService({
        db,
        configService: {
          assertMachinePaymentChannelAvailable,
          resolveForPayment,
        },
      });

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
          paymentProviderCode: "wechat_pay",
        }),
      ).rejects.toThrow(ConflictException);

      expect(assertMachinePaymentChannelAvailable).toHaveBeenCalledWith({
        machineId: "mach-1",
        providerCode: "wechat_pay",
        method: "payment_code",
      });
      expect(resolveForPayment).not.toHaveBeenCalled();
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

  describe("payment creation idempotency", () => {
    it("joins concurrent provider creation for the same persisted payment", async () => {
      const service = makeService({});
      const internal = service as unknown as {
        createAndPersistPaymentIntent(
          draft: {
            orderId: string;
            orderNo: string;
            paymentId: string;
            paymentNo: string;
            providerCode: string;
            paymentMethod: "qr_code";
            machineId: string;
            totalAmountCents: number;
            expiresAt: Date;
            reservations: [];
          },
          config: null,
        ): Promise<{
          providerTradeNo: string | null;
          paymentUrl: string;
          initialStatus?: "pending" | "processing";
        }>;
        claimAndPersistPaymentIntent: ReturnType<typeof vi.fn>;
      };
      let resolveIntent!: (value: {
        providerTradeNo: string | null;
        paymentUrl: string;
        initialStatus: "pending";
      }) => void;
      const claim = vi
        .spyOn(internal, "claimAndPersistPaymentIntent")
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              resolveIntent = resolve;
            }),
        );
      const draft = {
        orderId: "550e8400-e29b-41d4-a716-446655440030",
        orderNo: "ORD-JOIN",
        paymentId: "550e8400-e29b-41d4-a716-446655440031",
        paymentNo: "PAY-JOIN",
        providerCode: "alipay",
        paymentMethod: "qr_code" as const,
        machineId: "machine-1",
        totalAmountCents: 100,
        expiresAt: new Date("2026-07-14T01:00:00.000Z"),
        reservations: [] as [],
      };

      const first = internal.createAndPersistPaymentIntent(draft, null);
      const second = internal.createAndPersistPaymentIntent(draft, null);

      expect(claim).toHaveBeenCalledTimes(1);
      resolveIntent({
        providerTradeNo: null,
        paymentUrl: "https://qr.alipay.com/join",
        initialStatus: "pending",
      });
      await expect(Promise.all([first, second])).resolves.toEqual([
        {
          providerTradeNo: null,
          paymentUrl: "https://qr.alipay.com/join",
          initialStatus: "pending",
        },
        {
          providerTradeNo: null,
          paymentUrl: "https://qr.alipay.com/join",
          initialStatus: "pending",
        },
      ]);
    });

    it("allows a processing QR payment to restore its QR after reconciliation reports pending", async () => {
      const reconcilePendingPaymentOnRead = vi.fn().mockResolvedValue({
        status: "pending",
        reconciled: true,
        reason: "provider_trade_not_exist",
      });
      const service = makeService({
        paymentsService: { reconcilePendingPaymentOnRead },
        configService: {
          resolveForExistingPayment: vi.fn().mockResolvedValue({
            providerCode: "alipay",
            merchantNo: null,
            appId: null,
            publicConfigJson: {},
            sensitiveConfigJson: {},
          }),
        },
      });
      const internal = service as unknown as {
        restorePaymentCreation(input: Record<string, unknown>): Promise<{
          paymentUrl: string | null;
        }>;
        createAndPersistPaymentIntent: ReturnType<typeof vi.fn>;
      };
      const restoreIntent = vi
        .spyOn(internal, "createAndPersistPaymentIntent")
        .mockResolvedValue({
          providerTradeNo: null,
          paymentUrl: "https://qr.alipay.com/recovered",
          initialStatus: "pending",
        });

      await expect(
        internal.restorePaymentCreation({
          orderId: "550e8400-e29b-41d4-a716-446655440040",
          orderNo: "ORD-RECOVER-QR",
          paymentId: "550e8400-e29b-41d4-a716-446655440041",
          paymentNo: "PAY-RECOVER-QR",
          providerCode: "alipay",
          paymentMethod: "qr_code",
          machineId: "machine-1",
          totalAmountCents: 100,
          expiresAt: new Date("2026-07-14T01:00:00.000Z"),
          reservations: [],
          paymentStatus: "processing",
          paymentUrl: null,
          providerTradeNo: null,
          providerConfigId: null,
          providerConfigSnapshotJson: {},
          intentCreationLeaseExpiresAt: null,
          intentCreationLeaseOwnerToken: null,
          intentCreationLeaseFence: 0,
        }),
      ).resolves.toMatchObject({
        paymentUrl: "https://qr.alipay.com/recovered",
      });

      expect(reconcilePendingPaymentOnRead).toHaveBeenCalledWith(
        "550e8400-e29b-41d4-a716-446655440041",
      );
      expect(restoreIntent).toHaveBeenCalledOnce();
    });

    it("keeps a WAIT_BUYER_PAY recovery in polling and never precreates another QR", async () => {
      const reconcilePendingPaymentOnRead = vi.fn().mockResolvedValue({
        status: "pending",
        reconciled: false,
        reason: "wait_buyer_pay",
      });
      const service = makeService({
        paymentsService: { reconcilePendingPaymentOnRead },
      });
      const internal = service as unknown as {
        restorePaymentCreation(input: Record<string, unknown>): Promise<{
          paymentUrl: string | null;
        }>;
        createAndPersistPaymentIntent: ReturnType<typeof vi.fn>;
      };
      const restoreIntent = vi.spyOn(internal, "createAndPersistPaymentIntent");

      await expect(
        internal.restorePaymentCreation({
          orderId: "550e8400-e29b-41d4-a716-446655440042",
          orderNo: "ORD-WAIT-BUYER-PAY",
          paymentId: "550e8400-e29b-41d4-a716-446655440043",
          paymentNo: "PAY-WAIT-BUYER-PAY",
          providerCode: "alipay",
          paymentMethod: "qr_code",
          machineId: "machine-1",
          totalAmountCents: 100,
          expiresAt: new Date("2026-07-14T01:00:00.000Z"),
          reservations: [],
          paymentStatus: "processing",
          paymentUrl: null,
          providerTradeNo: "ALI-TRADE-1",
          providerConfigId: null,
          providerConfigSnapshotJson: {},
          intentCreationLeaseExpiresAt: null,
          intentCreationLeaseOwnerToken: null,
          intentCreationLeaseFence: 0,
        }),
      ).resolves.toMatchObject({ paymentUrl: null });

      expect(restoreIntent).not.toHaveBeenCalled();
    });

    it("loads the actual active reservations for a persisted checkout recovery", async () => {
      const db = makeQueuedDb([
        [
          {
            orderId: "550e8400-e29b-41d4-a716-446655440050",
            orderNo: "ORD-RESERVATION-RECOVERY",
            paymentId: "550e8400-e29b-41d4-a716-446655440051",
            paymentNo: "PAY-RESERVATION-RECOVERY",
            providerCode: "alipay",
            paymentMethod: "qr_code",
            machineId: "machine-1",
            totalAmountCents: 100,
            expiresAt: new Date("2026-07-14T01:00:00.000Z"),
            paymentStatus: "created",
            paymentUrl: null,
            providerTradeNo: null,
            providerConfigId: null,
            providerConfigSnapshotJson: {},
            intentCreationLeaseExpiresAt: null,
            intentCreationLeaseOwnerToken: null,
            intentCreationLeaseFence: 0,
          },
        ],
        [{ inventoryId: "inventory-1", quantity: 2 }],
      ]);
      const service = makeService({ db });
      const internal = service as unknown as {
        findPaymentCreationByIdempotencyKey(
          machineId: string,
          idempotencyKey: string,
        ): Promise<{
          reservations: Array<{ inventoryId: string; quantity: number }>;
        } | null>;
      };

      await expect(
        internal.findPaymentCreationByIdempotencyKey(
          "machine-1",
          "checkout:real-reservation",
        ),
      ).resolves.toMatchObject({
        reservations: [{ inventoryId: "inventory-1", quantity: 2 }],
      });
    });

    it("does not let a superseded lease cancel or release inventory", async () => {
      const releaseReservation = vi.fn().mockResolvedValue(undefined);
      const tx = {
        update: vi.fn().mockReturnValue({
          set: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              returning: vi.fn().mockResolvedValue([]),
            }),
          }),
        }),
        insert: vi.fn(),
        select: vi.fn(),
      };
      const db = makeDb();
      db.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
        fn(tx),
      );
      const service = makeService({
        db,
        inventoryService: { releaseReservation },
      });
      const internal = service as unknown as {
        cancelLocalCreatedPayment(
          draft: Record<string, unknown>,
          reason: "provider_create_failed",
          error: unknown,
          lease: { ownerToken: string; fence: number; expiresAt: Date },
        ): Promise<void>;
      };

      await internal.cancelLocalCreatedPayment(
        {
          orderId: "550e8400-e29b-41d4-a716-446655440060",
          orderNo: "ORD-LEASE-TAKEOVER",
          paymentId: "550e8400-e29b-41d4-a716-446655440061",
          paymentNo: "PAY-LEASE-TAKEOVER",
          providerCode: "alipay",
          machineId: "machine-1",
          reservations: [{ inventoryId: "inventory-1", quantity: 1 }],
        },
        "provider_create_failed",
        new Error("old owner failed after takeover"),
        {
          ownerToken: "old-owner-token",
          fence: 1,
          expiresAt: new Date(Date.now() + 30_000),
        },
      );

      expect(releaseReservation).not.toHaveBeenCalled();
    });

    it("does not return an old owner's QR when fenced persistence affects zero rows", async () => {
      const db = makeDb();
      let updateCount = 0;
      db.update.mockImplementation(() => ({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockImplementation(async () => {
              updateCount += 1;
              return updateCount === 1 ? [{ id: "pay-1", fence: 1 }] : [];
            }),
          }),
        }),
      }));
      db.select.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([
              {
                paymentUrl: null,
                status: "processing",
                providerTradeNo: "successor-trade",
              },
            ]),
          }),
        }),
      });
      const service = makeService({
        db,
        registry: {
          get: vi.fn().mockReturnValue({
            createPaymentIntent: vi.fn().mockResolvedValue({
              providerTradeNo: null,
              paymentUrl: "https://qr.alipay.com/old-owner",
              initialStatus: "pending",
            }),
          }),
        },
      });
      const internal = service as unknown as {
        claimAndPersistPaymentIntent(
          draft: Record<string, unknown>,
          config: null,
        ): Promise<{ paymentUrl: string; initialStatus: string }>;
      };

      await expect(
        internal.claimAndPersistPaymentIntent(
          {
            orderId: "550e8400-e29b-41d4-a716-446655440070",
            orderNo: "ORD-LEASE-PERSIST-LOST",
            paymentId: "550e8400-e29b-41d4-a716-446655440071",
            paymentNo: "PAY-LEASE-PERSIST-LOST",
            providerCode: "alipay",
            paymentMethod: "qr_code",
            machineId: "machine-1",
            totalAmountCents: 100,
            expiresAt: new Date("2026-07-14T01:00:00.000Z"),
            reservations: [],
          },
          null,
        ),
      ).resolves.toMatchObject({
        paymentUrl: "",
        initialStatus: "processing",
      });
    });

    it("restores the persisted payment instead of allocating another order for the same checkout key", async () => {
      const db = makeQueuedDb([
        [{ id: "machine-1", code: "M001", status: "online" }],
        [
          {
            orderId: "550e8400-e29b-41d4-a716-446655440010",
            orderNo: "ORD-EXISTING",
            paymentId: "550e8400-e29b-41d4-a716-446655440011",
            paymentNo: "PAY-EXISTING",
            providerCode: "alipay",
            paymentMethod: "qr_code",
            machineId: "machine-1",
            totalAmountCents: 100,
            expiresAt: new Date("2026-07-14T01:00:00.000Z"),
            paymentStatus: "pending",
            paymentUrl: "https://qr.alipay.com/existing",
            providerTradeNo: null,
            providerConfigId: "550e8400-e29b-41d4-a716-446655440012",
            providerConfigSnapshotJson: {},
            intentCreationLeaseExpiresAt: null,
            intentCreationLeaseOwnerToken: null,
            intentCreationLeaseFence: 0,
          },
        ],
        [],
      ]);
      const configService = {
        assertMachinePaymentChannelAvailable: vi.fn(),
      };
      const service = makeService({
        db,
        configService: configService as Partial<PaymentProviderConfigService>,
      });

      const result = await service.createMachineOrder({
        machineCode: "M001",
        items: [
          {
            inventoryId: "550e8400-e29b-41d4-a716-446655440002",
            quantity: 1,
            planogramVersion: "PLAN-1",
            slotId: "550e8400-e29b-41d4-a716-446655440001",
            slotCode: "A1",
          },
        ],
        paymentMethod: "qr_code",
        paymentProviderCode: "alipay",
        idempotencyKey: "checkout:restore-existing",
      });

      expect(result).toMatchObject({
        orderNo: "ORD-EXISTING",
        paymentNo: "PAY-EXISTING",
        paymentUrl: "https://qr.alipay.com/existing",
      });
      expect(
        configService.assertMachinePaymentChannelAvailable,
      ).not.toHaveBeenCalled();
    });

    it("reconciles an indeterminate replay before it may retry the same provider payment number", async () => {
      const db = makeQueuedDb([
        [{ id: "machine-1", code: "M001", status: "online" }],
        [
          {
            orderId: "550e8400-e29b-41d4-a716-446655440020",
            orderNo: "ORD-UNCERTAIN",
            paymentId: "550e8400-e29b-41d4-a716-446655440021",
            paymentNo: "PAY-UNCERTAIN",
            providerCode: "alipay",
            paymentMethod: "qr_code",
            machineId: "machine-1",
            totalAmountCents: 100,
            expiresAt: new Date("2026-07-14T01:00:00.000Z"),
            paymentStatus: "processing",
            paymentUrl: null,
            providerTradeNo: null,
            providerConfigId: "550e8400-e29b-41d4-a716-446655440022",
            providerConfigSnapshotJson: {},
            intentCreationLeaseExpiresAt: null,
            intentCreationLeaseOwnerToken: null,
            intentCreationLeaseFence: 0,
          },
        ],
        [],
      ]);
      const reconcilePendingPaymentOnRead = vi.fn().mockResolvedValue({
        status: "processing",
        reconciled: false,
        reason: "provider_processing",
      });
      const registry = { get: vi.fn() };
      const service = makeService({
        db,
        registry,
        paymentsService: { reconcilePendingPaymentOnRead },
      });

      const result = await service.createMachineOrder({
        machineCode: "M001",
        items: [
          {
            inventoryId: "550e8400-e29b-41d4-a716-446655440002",
            quantity: 1,
            planogramVersion: "PLAN-1",
            slotId: "550e8400-e29b-41d4-a716-446655440001",
            slotCode: "A1",
          },
        ],
        paymentMethod: "qr_code",
        paymentProviderCode: "alipay",
        idempotencyKey: "checkout:reconcile-uncertain",
      });

      expect(reconcilePendingPaymentOnRead).toHaveBeenCalledWith(
        "550e8400-e29b-41d4-a716-446655440021",
      );
      expect(registry.get).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        orderNo: "ORD-UNCERTAIN",
        paymentNo: "PAY-UNCERTAIN",
        paymentUrl: null,
      });
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
    assertMachinePaymentChannelAvailable: vi.fn().mockResolvedValue(undefined),
    listMachinePaymentOptionsForMachine: vi.fn().mockResolvedValue({
      machineId: "mach-1",
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
  const auditService = { record: vi.fn().mockResolvedValue(undefined) };
  const vendingService = { resolveCommand: vi.fn().mockResolvedValue({}) };

  return new OrdersService(
    db as never,
    inventoryService,
    registry,
    configService,
    refundsService,
    auditService as never,
    vendingService as never,
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
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "pay-001" }]),
      }),
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
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([{ id: "pay-001" }]),
      }),
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
  const machineRows = [{ id: "mach-001", code: "M-001", status: "online" }];
  const machineWhereResult = Object.assign(Promise.resolve(machineRows), {
    limit: vi.fn().mockResolvedValue([{ id: "pay-claim" }]),
  });
  harness.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue(machineWhereResult),
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
      return {
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "pay-claim", fence: 1 }]),
        }),
      };
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
  let updateCalls = 0;
  db.update = vi.fn(() => ({
    set: vi.fn(() => {
      updateCalls += 1;
      if (updateCalls === 1) {
        return {
          where: vi.fn().mockReturnValue({
            returning: vi
              .fn()
              .mockResolvedValue([{ id: "pay-claim", fence: 1 }]),
          }),
        };
      }
      return {
        where: vi.fn().mockReturnValue({
          returning: vi
            .fn()
            .mockRejectedValue(new Error("payment update failed")),
        }),
      };
    }),
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

    it("cancels locally and releases reservations when provider cancel returns an indeterminate 5xx", async () => {
      const db = makeDb();
      const releaseReservation = vi.fn().mockResolvedValue(undefined);
      const cancelPayment = vi
        .fn()
        .mockRejectedValue(new Error("HTTP 请求错误, status: 504"));
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
        paymentStatus: "processing",
        paymentUrl: "https://pay.example/qr",
        paymentExpiresAt: null,
        paidAt: null,
        failedReason: null,
        providerId: "provider-alipay",
        providerCode: "alipay",
        paymentProviderCode: "alipay",
        providerTradeNo: null,
        providerConfigId: "cfg-1",
        providerConfigSnapshotJson: {
          id: "cfg-1",
          providerCode: "alipay",
          merchantNo: "ALI-OLD",
        },
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
                .mockResolvedValue([{ inventoryId: "inv-1", quantity: 1 }]),
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

      const resolveForExistingPayment = vi.fn().mockResolvedValue({
        providerCode: "alipay",
        merchantNo: "ALI-OLD",
        appId: null,
        publicConfigJson: {},
        sensitiveConfigJson: {},
      });
      const service = makeService({
        db,
        inventoryService: { releaseReservation },
        registry: {
          get: vi.fn().mockReturnValue({ cancelPayment }),
        },
        configService: { resolveForExistingPayment },
      });

      const result = await service.cancelMachineOrder("ORD001", {
        machineCode: "M001",
      });

      expect(cancelPayment).toHaveBeenCalledWith(
        expect.objectContaining({ paymentNo: "PAY001" }),
      );
      expect(resolveForExistingPayment).toHaveBeenCalledWith({
        providerCode: "alipay",
        providerConfigId: "cfg-1",
        machineId: "mach-1",
        providerConfigSnapshotJson: row.providerConfigSnapshotJson,
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
        quantity: 1,
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

    it("does not reconcile-on-read for protected payment drill orders", async () => {
      const db = makeDb();
      const reconcilePendingPaymentOnRead = vi.fn();
      db.select
        .mockReturnValueOnce(
          makeJoinedSelectResult([
            machineOrderStatusRow({
              orderNo: "DRILL-ORD001",
              paymentNo: "DRILL-PAY001",
              isDrill: true,
              isTest: true,
              scenario: "qr_reconcile_failed",
            }),
          ]),
        )
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult());

      const service = makeService({
        db,
        paymentsService: { reconcilePendingPaymentOnRead },
      });

      const result = await service.getMachineOrderStatus("DRILL-ORD001", {
        machineCode: "M001",
      });

      expect(reconcilePendingPaymentOnRead).not.toHaveBeenCalled();
      expect(result.orderNo).toBe("DRILL-ORD001");
      expect(result.payment.status).toBe("pending");
    });

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
        })
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    trigger: "machine_status_poll",
                    attemptNo: 1,
                    status: "succeeded",
                    providerPaymentStatus: "succeeded",
                    errorCode: null,
                    nextRetryAt: null,
                    startedAt: new Date("2026-05-24T13:00:00.000Z"),
                    finishedAt: new Date("2026-05-24T13:00:01.000Z"),
                    createdAt: new Date("2026-05-24T13:00:00.000Z"),
                  },
                ]),
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
      expect(result.payment.reconciliation).toMatchObject({
        trigger: "machine_status_poll",
        attemptNo: 1,
        status: "succeeded",
        providerPaymentStatus: "succeeded",
        startedAt: "2026-05-24T13:00:00.000Z",
        finishedAt: "2026-05-24T13:00:01.000Z",
      });
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

    it("returns manual_handling nextAction for unknown payment uncertainty", async () => {
      const db = makeDb();
      const row = machineOrderStatusRow({
        orderStatus: "manual_handling",
        paymentState: "payment_unknown",
        fulfillmentState: "manual_handling",
        paymentStatus: "unknown",
        paymentUrl: null,
      });
      db.select
        .mockReturnValueOnce(makeJoinedSelectResult([row]))
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult());

      const service = makeService({ db });
      const result = await service.getMachineOrderStatus("ORD001", {
        machineCode: "M001",
      });

      expect(result.paymentState).toBe("payment_unknown");
      expect(result.payment.status).toBe("unknown");
      expect(result.nextAction).toBe("manual_handling");
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

    it("returns manual_handling nextAction for result_unknown vending command", async () => {
      const db = makeDb();
      const row = machineOrderStatusRow({
        orderStatus: "paid",
        paymentState: "paid",
        fulfillmentState: "awaiting_fulfillment",
        paymentStatus: "succeeded",
        paidAt: new Date("2026-06-26T07:00:00.000Z"),
      });
      db.select
        .mockReturnValueOnce(makeJoinedSelectResult([row]))
        .mockReturnValueOnce({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockReturnValue({
              orderBy: vi.fn().mockReturnValue({
                limit: vi.fn().mockResolvedValue([
                  {
                    commandNo: "CMD-UNKNOWN",
                    status: "result_unknown",
                    sentAt: new Date("2026-06-26T07:00:00.000Z"),
                    ackAt: new Date("2026-06-26T07:00:01.000Z"),
                    resultAt: new Date("2026-06-26T07:02:00.000Z"),
                    lastError: "dispense result unknown after command timeout",
                  },
                ]),
              }),
            }),
          }),
        })
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult())
        .mockReturnValueOnce(makeEmptyLatestSelectResult());

      const service = makeService({ db });
      const result = await service.getMachineOrderStatus("ORD001", {
        machineCode: "M001",
      });

      expect(result.vending).toMatchObject({
        commandNo: "CMD-UNKNOWN",
        status: "result_unknown",
      });
      expect(result.nextAction).toBe("manual_handling");
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
