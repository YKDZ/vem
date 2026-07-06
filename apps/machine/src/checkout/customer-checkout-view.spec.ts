import { describe, expect, it } from "vitest";

import type { TransactionSnapshot } from "@/daemon/schemas";

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

describe("Customer Checkout View Projection", () => {
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
});
