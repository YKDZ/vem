import { describe, expect, it } from "vitest";

import {
  daemonIpcCheckoutFlowActionSchema,
  daemonIpcDispenseProgressObservationStageSchema,
  daemonIpcPickupReminderSchema,
  daemonIpcTransactionSnapshotSchema,
  machineOrderStatusNextActionSchema,
} from ".";

describe("Daemon IPC Contract Area", () => {
  const awaitingPaymentTransaction = {
    orderId: "550e8400-e29b-41d4-a716-446655440010",
    orderNo: "ORD-IPC-001",
    productSummary: null,
    paymentNo: "PAY-IPC-001",
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
  };

  it("publishes the strict Checkout Flow Action vocabulary", () => {
    expect(daemonIpcCheckoutFlowActionSchema.options).toEqual([
      "wait_payment",
      "dispensing",
      "success",
      "payment_failed",
      "payment_expired",
      "dispense_failed",
      "refund_pending",
      "refunded",
      "manual_handling",
      "closed",
    ]);

    expect(() =>
      daemonIpcCheckoutFlowActionSchema.parse("submit_payment"),
    ).toThrow();
    expect(() =>
      daemonIpcCheckoutFlowActionSchema.parse("collect_goods"),
    ).toThrow();
    expect(() =>
      daemonIpcCheckoutFlowActionSchema.parse("unsupported_checkout_action"),
    ).toThrow();
  });

  it("requires legal Checkout Flow Action for transaction snapshots with an order credential", () => {
    expect(
      daemonIpcTransactionSnapshotSchema.parse(awaitingPaymentTransaction)
        .nextAction,
    ).toBe("wait_payment");

    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: "submit_payment",
      }),
    ).toThrow();
    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: "collect_goods",
      }),
    ).toThrow();
    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: "unsupported_checkout_action",
      }),
    ).toThrow();
    expect(() => {
      const { nextAction: _nextAction, ...missingNextAction } =
        awaitingPaymentTransaction;
      return daemonIpcTransactionSnapshotSchema.parse(missingNextAction);
    }).toThrow();
  });

  it("rejects unknown fields in transaction snapshots and nested daemon-owned objects", () => {
    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        extraDaemonField: true,
      }),
    ).toThrow();

    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: "dispensing",
        vending: {
          commandNo: "CMD-IPC-001",
          status: "pending",
          lastError: null,
          extraVendingField: true,
        },
      }),
    ).toThrow();

    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        nextAction: "dispensing",
        vending: {
          commandNo: "CMD-IPC-001",
          status: "pending",
          lastError: null,
          pickupReminder: {
            stage: "pickup_waiting",
            level: "warning",
            message: "Please collect goods",
            warningNo: 1,
            reportedAt: "2026-06-11T06:18:00.000Z",
            extraPickupReminderField: true,
          },
        },
      }),
    ).toThrow();

    expect(() =>
      daemonIpcTransactionSnapshotSchema.parse({
        ...awaitingPaymentTransaction,
        paymentMethod: "payment_code",
        paymentCodeAttempt: {
          attemptNo: 1,
          status: "pending",
          maskedAuthCode: "2876****4394",
          source: "tauri_scanner",
          idempotencyKey: "ORD-IPC-001:attempt-1",
          submittedAt: "2026-06-11T06:16:30.000Z",
          lastCheckedAt: null,
          canRetry: false,
          message: null,
          extraPaymentCodeAttemptField: true,
        },
      }),
    ).toThrow();
  });

  it("keeps the order-facing next action export as a compatibility alias", () => {
    expect(machineOrderStatusNextActionSchema).toBe(
      daemonIpcCheckoutFlowActionSchema,
    );
    expect(machineOrderStatusNextActionSchema.parse("success")).toBe("success");
  });

  it("separates protocol-backed dispense progress observations from checkout pickup reminders", () => {
    expect(daemonIpcDispenseProgressObservationStageSchema.options).toEqual([
      "outlet_opened",
      "pickup_waiting",
      "pickup_timeout_warning",
      "pickup_completed",
      "reset_completed",
    ]);

    expect(
      daemonIpcDispenseProgressObservationStageSchema.parse("reset_completed"),
    ).toBe("reset_completed");
    expect(() =>
      daemonIpcPickupReminderSchema.parse({
        stage: "reset_completed",
        level: "info",
        message: "device reset completed",
        warningNo: null,
        reportedAt: "2026-06-11T06:18:00.000Z",
      }),
    ).toThrow();
  });
});
