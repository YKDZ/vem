import { describe, expect, it } from "vitest";

import {
  transactionSnapshotSchema,
  type TransactionSnapshot,
} from "@/daemon/schemas";

import { projectCustomerCheckoutView } from "./customer-checkout-view";

function awaitingPaymentTransaction(
  overrides: Partial<TransactionSnapshot> = {},
): TransactionSnapshot {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-PAYMENT-001",
    productSummary: null,
    paymentNo: "PAY-PAYMENT-001",
    paymentMethod: "qr_code",
    paymentProvider: "alipay",
    paymentUrl: "https://pay.example/qr",
    paymentStatus: "pending",
    orderStatus: "pending_payment",
    totalAmountCents: 1200,
    vending: null,
    nextAction: "wait_payment",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-06-11T06:20:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-06-11T06:16:32.320Z",
    ...overrides,
  };
}

function dispensingTransaction(
  overrides: Partial<TransactionSnapshot> = {},
): TransactionSnapshot {
  return {
    orderId: "550e8400-e29b-41d4-a716-446655440020",
    orderNo: "ORD-DISPENSING-001",
    productSummary: null,
    paymentNo: "PAY-DISPENSING-001",
    paymentMethod: "payment_code",
    paymentProvider: "alipay",
    paymentUrl: null,
    paymentStatus: "succeeded",
    orderStatus: "paid",
    totalAmountCents: 1200,
    vending: {
      commandNo: "CMD-DISPENSING-001",
      status: "sent",
      lastError: null,
      pickupReminder: {
        stage: "pickup_timeout_warning",
        level: "urgent",
        message: "请尽快取走商品",
        warningNo: 2,
        reportedAt: "2026-06-11T06:16:40.000Z",
        remainingSeconds: 12,
      },
    },
    nextAction: "dispensing",
    maskedAuthCode: null,
    paymentCodeAttempt: null,
    expiresAt: "2026-06-11T06:20:00.000Z",
    errorCode: null,
    errorMessage: null,
    operatorHint: null,
    updatedAt: "2026-06-11T06:16:32.320Z",
    ...overrides,
  };
}

function successfulTransaction(
  overrides: Partial<TransactionSnapshot> = {},
): TransactionSnapshot {
  return {
    ...dispensingTransaction(),
    orderNo: "ORD-SUCCESS-001",
    paymentNo: "PAY-SUCCESS-001",
    paymentStatus: "succeeded",
    orderStatus: "fulfilled",
    vending: {
      commandNo: "CMD-SUCCESS-001",
      status: "succeeded",
      lastError: null,
    },
    nextAction: "success",
    ...overrides,
  };
}

describe("Customer Checkout View Projection", () => {
  it("validates paid and dispensing transaction snapshots with strict vocabulary", () => {
    expect(
      transactionSnapshotSchema.safeParse(
        dispensingTransaction({ orderStatus: "paid" }),
      ).success,
    ).toBe(true);
    expect(
      transactionSnapshotSchema.safeParse(
        dispensingTransaction({ orderStatus: "dispensing" }),
      ).success,
    ).toBe(true);
  });

  it("projects awaiting QR payment as cancelable payment stage", () => {
    const view = projectCustomerCheckoutView({
      transaction: awaitingPaymentTransaction(),
      nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
      dismissedTerminalOrderNos: [],
      restored: false,
    });

    expect(view.stage).toBe("payment");
    expect(view.routeTarget).toEqual({ name: "payment" });
    expect(view.orderCredential).toBe("ORD-PAYMENT-001");
    expect(view.payment).toMatchObject({
      method: "qr_code",
      provider: "alipay",
      paymentUrl: "https://pay.example/qr",
      expiresAt: "2026-06-11T06:20:00.000Z",
      totalAmountCents: 1200,
      canCancel: true,
      cancelDisabledReason: null,
      display: {
        kind: "qr",
        state: "pending",
      },
    });
  });

  it("exposes customer journey facts for event observation without raw next action", () => {
    const payment = projectCustomerCheckoutView({
      transaction: awaitingPaymentTransaction(),
      nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
      dismissedTerminalOrderNos: [],
      restored: true,
    });
    const dispensing = projectCustomerCheckoutView({
      transaction: dispensingTransaction(),
      nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
      dismissedTerminalOrderNos: [],
      restored: false,
    });
    const refunded = projectCustomerCheckoutView({
      transaction: successfulTransaction({
        orderNo: "ORD-REFUNDED-001",
        nextAction: "refunded",
        orderStatus: "refunded",
        paymentStatus: "refunded",
        vending: {
          commandNo: "CMD-REFUNDED-001",
          status: "failed",
          lastError: "slot jammed",
        },
      }),
      nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
      dismissedTerminalOrderNos: [],
      restored: false,
    });

    expect(payment.customerEventObservation).toEqual({
      phase: "awaiting_payment",
      orderCredential: "ORD-PAYMENT-001",
      journeyFact: "payment_requested",
      pickupCue: null,
      restored: true,
    });
    expect(dispensing.customerEventObservation).toEqual({
      phase: "dispensing",
      orderCredential: "ORD-DISPENSING-001",
      journeyFact: "dispense_started",
      pickupCue: "urgent",
      restored: false,
    });
    expect(refunded.customerEventObservation).toEqual({
      phase: "refund_completed_result",
      orderCredential: "ORD-REFUNDED-001",
      journeyFact: "refund_resolved",
      pickupCue: null,
      restored: false,
    });
    expect(
      Object.prototype.hasOwnProperty.call(
        dispensing.customerEventObservation,
        "nextAction",
      ),
    ).toBe(false);
  });

  it("projects in-flight payment-code attempts as not cancelable", () => {
    const view = projectCustomerCheckoutView({
      transaction: awaitingPaymentTransaction({
        paymentMethod: "payment_code",
        paymentUrl: null,
        paymentCodeAttempt: {
          attemptNo: 1,
          status: "querying",
          maskedAuthCode: "2876****4394",
          source: "serial_text",
          idempotencyKey: "ORD-PAYMENT-001:attempt-1",
          submittedAt: "2026-06-11T06:16:30.000Z",
          lastCheckedAt: null,
          canRetry: false,
          message: "正在确认支付结果",
        },
      }),
      nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
      dismissedTerminalOrderNos: [],
      restored: false,
    });

    expect(view.stage).toBe("payment");
    expect(view.payment).toMatchObject({
      method: "payment_code",
      canCancel: false,
      cancelDisabledReason: "payment_code_in_flight",
      display: {
        kind: "payment_code",
        state: "in_flight",
        attemptStatus: "querying",
        maskedAuthCode: "2876****4394",
      },
    });
  });

  it("projects payment-code ready, retryable, and blocked display states", () => {
    const ready = projectCustomerCheckoutView({
      transaction: awaitingPaymentTransaction({
        paymentMethod: "payment_code",
        paymentUrl: null,
        paymentCodeAttempt: null,
      }),
      nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
      dismissedTerminalOrderNos: [],
      restored: false,
    });
    const retryable = projectCustomerCheckoutView({
      transaction: awaitingPaymentTransaction({
        paymentMethod: "payment_code",
        paymentUrl: null,
        paymentCodeAttempt: {
          attemptNo: 1,
          status: "failed",
          maskedAuthCode: "2876****4394",
          source: "serial_text",
          idempotencyKey: "ORD-PAYMENT-001:attempt-1",
          submittedAt: "2026-06-11T06:16:30.000Z",
          lastCheckedAt: null,
          canRetry: true,
          message: "Payment failed: retry with a fresh code",
        },
      }),
      nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
      dismissedTerminalOrderNos: [],
      restored: false,
    });
    const blocked = projectCustomerCheckoutView({
      transaction: awaitingPaymentTransaction({
        paymentMethod: "payment_code",
        paymentUrl: null,
        paymentCodeAttempt: {
          attemptNo: 1,
          status: "failed",
          maskedAuthCode: "2876****4394",
          source: "serial_text",
          idempotencyKey: "ORD-PAYMENT-001:attempt-1",
          submittedAt: "2026-06-11T06:16:30.000Z",
          lastCheckedAt: null,
          canRetry: false,
          message: "Provider returned a hard failure",
        },
      }),
      nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
      dismissedTerminalOrderNos: [],
      restored: false,
    });

    expect(ready.payment?.display).toMatchObject({
      kind: "payment_code",
      state: "ready",
    });
    expect(retryable.payment?.display).toMatchObject({
      kind: "payment_code",
      state: "retryable",
    });
    expect(blocked.payment?.display).toMatchObject({
      kind: "payment_code",
      state: "blocked",
    });
  });

  it("treats missing payment method or amount in a payment transaction as a contract problem", () => {
    expect(() =>
      projectCustomerCheckoutView({
        transaction: awaitingPaymentTransaction({ paymentMethod: null }),
        nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
        dismissedTerminalOrderNos: [],
        restored: false,
      }),
    ).toThrow("payment transaction snapshot missing payment method");
    expect(() =>
      projectCustomerCheckoutView({
        transaction: awaitingPaymentTransaction({ totalAmountCents: null }),
        nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
        dismissedTerminalOrderNos: [],
        restored: false,
      }),
    ).toThrow("payment transaction snapshot missing total amount");
  });

  it("projects paid dispensing snapshots to dispensing intent and route target", () => {
    const view = projectCustomerCheckoutView({
      transaction: dispensingTransaction(),
      nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
      dismissedTerminalOrderNos: [],
      restored: false,
    });

    expect(view).toMatchObject({
      stage: "dispensing",
      routeTarget: { path: "/dispensing" },
      orderCredential: "ORD-DISPENSING-001",
      dispensing: {
        customerVisibleError: null,
        pickupReminder: {
          stage: "pickup_timeout_warning",
          urgency: "urgent",
          remainingSeconds: 12,
          warningNo: 2,
          reportedAt: "2026-06-11T06:16:40.000Z",
        },
      },
    });
    expect(JSON.stringify(view)).not.toContain("请尽快取走商品");
  });

  it("does not project reset completion as a customer pickup reminder", () => {
    const resetCompletedReminderSnapshot = {
      ...dispensingTransaction(),
      vending: {
        commandNo: "CMD-DISPENSING-001",
        status: "sent",
        lastError: null,
        pickupReminder: {
          stage: "reset_completed",
          level: "info",
          message: "设备已复位完成",
          warningNo: null,
          reportedAt: "2026-06-11T06:16:40.000Z",
          remainingSeconds: null,
        },
      },
    };

    expect(
      transactionSnapshotSchema.safeParse(resetCompletedReminderSnapshot)
        .success,
    ).toBe(false);

    const view = projectCustomerCheckoutView({
      transaction: dispensingTransaction({
        vending: {
          commandNo: "CMD-DISPENSING-001",
          status: "sent",
          lastError: null,
          pickupReminder: null,
        },
      }),
      nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
      dismissedTerminalOrderNos: [],
      restored: false,
    });

    expect(view.dispensing?.pickupReminder).toBeNull();
    expect(view.customerEventObservation.pickupCue).toBeNull();
  });

  it("projects successful terminal snapshots to success result with sale-ready return policy", () => {
    expect(
      transactionSnapshotSchema.safeParse(successfulTransaction()).success,
    ).toBe(true);

    const view = projectCustomerCheckoutView({
      transaction: successfulTransaction(),
      nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
      dismissedTerminalOrderNos: [],
      restored: false,
      readiness: {
        saleReady: true,
        suggestedRoute: "catalog",
        requiresMaintenanceReview: false,
      },
    });

    expect(view).toMatchObject({
      stage: "result",
      routeTarget: { name: "result", params: { kind: "success" } },
      orderCredential: "ORD-SUCCESS-001",
      result: {
        kind: "success",
        orderCredentialBehavior: "hidden",
        returnPolicy: {
          canAutoReturn: true,
          canManualReturn: true,
          targetRoute: "catalog",
          requiresMaintenanceReview: false,
        },
      },
    });
  });

  it("projects dismissed successful terminal snapshots to no active customer transaction", () => {
    const view = projectCustomerCheckoutView({
      transaction: successfulTransaction(),
      nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
      dismissedTerminalOrderNos: ["ORD-SUCCESS-001"],
      restored: true,
      readiness: {
        saleReady: true,
        suggestedRoute: "catalog",
        requiresMaintenanceReview: false,
      },
    });

    expect(view).toMatchObject({
      stage: "none",
      routeTarget: { name: "catalog" },
      orderCredential: null,
      result: null,
      restored: true,
    });
  });

  it("keeps successful terminal results from auto-returning when sale readiness is blocked", () => {
    const view = projectCustomerCheckoutView({
      transaction: successfulTransaction(),
      nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
      dismissedTerminalOrderNos: [],
      restored: false,
      readiness: {
        saleReady: false,
        suggestedRoute: "maintenance",
        requiresMaintenanceReview: true,
      },
    });

    expect(view).toMatchObject({
      stage: "result",
      result: {
        kind: "success",
        returnPolicy: {
          canAutoReturn: false,
          canManualReturn: true,
          targetRoute: "maintenance",
          requiresMaintenanceReview: true,
        },
      },
    });
    expect(view.routeTarget).toEqual({
      name: "result",
      params: { kind: "success" },
    });
  });

  it("projects exceptional terminal results with explicit display and conservative return policy", () => {
    const cases: Array<{
      nextAction: NonNullable<TransactionSnapshot["nextAction"]>;
      orderStatus: TransactionSnapshot["orderStatus"];
      paymentStatus: TransactionSnapshot["paymentStatus"];
      displayIntent: NonNullable<
        ReturnType<typeof projectCustomerCheckoutView>["result"]
      >["displayIntent"];
      detailIntent: NonNullable<
        ReturnType<typeof projectCustomerCheckoutView>["result"]
      >["detailIntent"];
      canManualReturnWhenReady: boolean;
      canManualReturnWhenUnknown: boolean;
      canManualReturnWhenMaintenanceLocked: boolean;
    }> = [
      {
        nextAction: "dispense_failed",
        orderStatus: "dispense_failed",
        paymentStatus: "succeeded",
        displayIntent: "dispense_failure",
        detailIntent: "dispense_failure",
        canManualReturnWhenReady: true,
        canManualReturnWhenUnknown: false,
        canManualReturnWhenMaintenanceLocked: false,
      },
      {
        nextAction: "refund_pending",
        orderStatus: "refund_pending",
        paymentStatus: "refund_pending",
        displayIntent: "refund_pending",
        detailIntent: null,
        canManualReturnWhenReady: false,
        canManualReturnWhenUnknown: false,
        canManualReturnWhenMaintenanceLocked: false,
      },
      {
        nextAction: "refunded",
        orderStatus: "refunded",
        paymentStatus: "refunded",
        displayIntent: "refunded",
        detailIntent: null,
        canManualReturnWhenReady: true,
        canManualReturnWhenUnknown: false,
        canManualReturnWhenMaintenanceLocked: true,
      },
      {
        nextAction: "manual_handling",
        orderStatus: "manual_handling",
        paymentStatus: "succeeded",
        displayIntent: "manual_handling",
        detailIntent: "dispense_result_unknown",
        canManualReturnWhenReady: false,
        canManualReturnWhenUnknown: false,
        canManualReturnWhenMaintenanceLocked: false,
      },
      {
        nextAction: "payment_failed",
        orderStatus: "canceled",
        paymentStatus: "failed",
        displayIntent: "payment_failed",
        detailIntent: null,
        canManualReturnWhenReady: true,
        canManualReturnWhenUnknown: false,
        canManualReturnWhenMaintenanceLocked: true,
      },
      {
        nextAction: "payment_expired",
        orderStatus: "payment_expired",
        paymentStatus: "expired",
        displayIntent: "payment_expired",
        detailIntent: null,
        canManualReturnWhenReady: true,
        canManualReturnWhenUnknown: false,
        canManualReturnWhenMaintenanceLocked: true,
      },
      {
        nextAction: "closed",
        orderStatus: "closed",
        paymentStatus: "canceled",
        displayIntent: "closed",
        detailIntent: null,
        canManualReturnWhenReady: true,
        canManualReturnWhenUnknown: false,
        canManualReturnWhenMaintenanceLocked: true,
      },
    ];

    for (const testCase of cases) {
      const transaction = successfulTransaction({
        orderNo: `ORD-${testCase.nextAction}`,
        nextAction: testCase.nextAction,
        orderStatus: testCase.orderStatus,
        paymentStatus: testCase.paymentStatus,
        vending:
          testCase.nextAction === "payment_failed" ||
          testCase.nextAction === "payment_expired" ||
          testCase.nextAction === "closed"
            ? null
            : {
                commandNo: `CMD-${testCase.nextAction}`,
                status:
                  testCase.nextAction === "refunded"
                    ? "failed"
                    : "result_unknown",
                lastError: "operator-only diagnostic",
              },
      });

      expect(transactionSnapshotSchema.safeParse(transaction).success).toBe(
        true,
      );

      const readyView = projectCustomerCheckoutView({
        transaction,
        nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
        dismissedTerminalOrderNos: [],
        restored: false,
        readiness: {
          saleReady: true,
          suggestedRoute: "catalog",
          requiresMaintenanceReview: false,
        },
      });

      expect(readyView).toMatchObject({
        stage: "result",
        routeTarget: { name: "result", params: { kind: testCase.nextAction } },
        orderCredential: `ORD-${testCase.nextAction}`,
        result: {
          kind: testCase.nextAction,
          displayIntent: testCase.displayIntent,
          detailIntent: testCase.detailIntent,
          orderCredentialBehavior: "shown",
          returnPolicy: {
            canAutoReturn: false,
            canManualReturn: testCase.canManualReturnWhenReady,
            targetRoute: "catalog",
            requiresMaintenanceReview: false,
          },
        },
      });

      const unknownReadinessView = projectCustomerCheckoutView({
        transaction,
        nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
        dismissedTerminalOrderNos: [],
        restored: false,
      });

      expect(unknownReadinessView.result?.returnPolicy).toMatchObject({
        canAutoReturn: false,
        canManualReturn: testCase.canManualReturnWhenUnknown,
        targetRoute: "offline",
      });

      const maintenanceLockedView = projectCustomerCheckoutView({
        transaction,
        nowMs: new Date("2026-06-11T06:16:32.320Z").getTime(),
        dismissedTerminalOrderNos: [],
        restored: false,
        readiness: {
          saleReady: false,
          suggestedRoute: "maintenance",
          requiresMaintenanceReview: true,
        },
      });

      expect(maintenanceLockedView.result?.returnPolicy).toMatchObject({
        canAutoReturn: false,
        canManualReturn: testCase.canManualReturnWhenMaintenanceLocked,
        targetRoute: "maintenance",
        requiresMaintenanceReview: true,
      });
    }
  });
});
