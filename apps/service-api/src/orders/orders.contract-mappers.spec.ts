import { describe, expect, it } from "vitest";

import {
  mapOrderRecoveryActionDtoToInsert,
  toOrderInvestigationResponse,
  toOrderRecoveryActionResponse,
} from "./orders.contract-mappers";

describe("orders contract mappers", () => {
  it("maps recovery action DTOs into explicit DB inserts", () => {
    expect(
      mapOrderRecoveryActionDtoToInsert({
        orderId: "order-1",
        commandId: "command-1",
        adminUserId: "admin-1",
        body: {
          action: "confirm_not_dispensed",
          note: "  item remained in slot  ",
        },
      }),
    ).toMatchObject({
      orderId: "order-1",
      commandId: "command-1",
      requestedByAdminUserId: "admin-1",
      action: "confirm_not_dispensed",
      status: "started",
      note: "item remained in slot",
    });
  });

  it("assembles recovery action responses through the shared schema", () => {
    expect(
      toOrderRecoveryActionResponse({
        action: "compensation_dispense",
        recoveryActionId: "recovery-1",
        commandId: "command-2",
        commandNo: "CMD-2",
        status: "pending",
      }),
    ).toEqual({
      action: "compensation_dispense",
      recoveryActionId: "recovery-1",
      commandId: "command-2",
      commandNo: "CMD-2",
      status: "pending",
    });
  });

  it("assembles investigation responses explicitly without broad record leakage or synthetic defaults", () => {
    const createdAt = new Date("2026-07-05T00:00:00.000Z");

    const response = toOrderInvestigationResponse({
      order: {
        id: "order-1",
        orderNo: "ORD-1",
        machineId: "machine-1",
        machineCode: "VEM-001",
        status: "manual_handling",
        paymentState: "paid",
        fulfillmentState: "manual_handling",
        totalAmountCents: 500,
        currency: "CNY",
        paidAt: createdAt,
        dispensedAt: null,
        canceledAt: null,
        createdAt,
      },
      items: [
        {
          id: "item-1",
          variantId: "variant-1",
          quantity: 1,
          unitPriceCents: 500,
          productSnapshot: { name: "Test Product" },
          costCents: "must not leak",
        },
      ],
      payments: [],
      paymentEvents: [],
      paymentWebhookAttempts: [],
      paymentReconciliationAttempts: [],
      paymentCodeAttempts: [
        {
          id: "code-1",
          paymentId: "payment-1",
          orderId: "order-1",
          attemptNo: 1,
          providerPaymentNo: "PCA-1",
          idempotencyKey: "idem-1",
          status: "reversed",
          isActive: false,
          amountCents: 500,
          currency: "CNY",
          authCodeMasked: "134***9988",
          source: "scanner",
          providerTradeNo: "ALI-TXN-1",
          providerStatus: "TRADE_CLOSED",
          failureCode: "PAYMENT_CODE_REVERSED",
          failureMessage: "reversed",
          submittedAt: createdAt,
          lastCheckedAt: createdAt,
          reversedAt: createdAt,
          finishedAt: createdAt,
          manualReason: "query_timeout_reversed",
          createdAt,
          updatedAt: createdAt,
          authCodeHash: "must not leak",
        },
      ],
      vendingCommands: [
        {
          id: "command-1",
          commandNo: "CMD-1",
          orderId: "order-1",
          machineId: "machine-1",
          machineCode: "VEM-001",
          slotId: "slot-1",
          slotCode: "A1",
          orderItemId: "item-1",
          commandKind: "dispatch",
          recoveryActionId: null,
          status: "result_unknown",
          sentAt: createdAt,
          ackAt: null,
          resultAt: createdAt,
          retryCount: 0,
          lastError: "unknown result",
          createdAt,
          updatedAt: createdAt,
        },
      ],
      fulfillmentProjection: {
        state: "manual_handling",
        latestCommand: {
          id: "command-1",
          commandNo: "CMD-1",
          orderId: "order-1",
          machineId: "machine-1",
          machineCode: "VEM-001",
          slotId: "slot-1",
          slotCode: "A1",
          orderItemId: "item-1",
          commandKind: "dispatch",
          recoveryActionId: null,
          status: "result_unknown",
          sentAt: createdAt,
          ackAt: null,
          resultAt: createdAt,
          retryCount: 0,
          lastError: "unknown result",
          createdAt,
          updatedAt: createdAt,
        },
        requiresPhysicalOutcomeConfirmation: true,
        availableRecoveryActions: ["confirm_dispensed"],
      },
      inventoryMovements: [],
      stockReconciliationLinks: [],
      refunds: [],
      maintenanceWorkOrders: [],
      adminAuditEntries: [],
      orderStatusEvents: [],
    });

    expect(JSON.stringify(response)).not.toContain("must not leak");
    expect(response.items[0]).toEqual({
      id: "item-1",
      variantId: "variant-1",
      quantity: 1,
      unitPriceCents: 500,
      productSnapshot: { name: "Test Product" },
    });
    expect(response.paymentCodeAttempts[0]).not.toHaveProperty("authCodeHash");

    expect(() =>
      toOrderInvestigationResponse({
        ...response,
        items: [
          {
            id: "item-1",
            quantity: 1,
            unitPriceCents: 500,
            productSnapshot: {},
          },
        ],
      }),
    ).toThrow();
  });
});
