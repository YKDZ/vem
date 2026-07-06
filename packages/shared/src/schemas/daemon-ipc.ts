import { z } from "zod";

import { orderStatusSchema } from "../enums/order-status";
import {
  paymentCodeAttemptStatusSchema,
  paymentMethodSchema,
  paymentStatusSchema,
} from "../enums/payment-status";
import { vendingCommandStatusSchema } from "../enums/vending";

export const daemonIpcCheckoutFlowActionSchema = z.enum([
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

export type DaemonIpcCheckoutFlowAction = z.infer<
  typeof daemonIpcCheckoutFlowActionSchema
>;

export const daemonIpcMachinePaymentProviderSchema = z.enum([
  "mock",
  "wechat_pay",
  "alipay",
]);

export const daemonIpcPaymentCodeSourceSchema = z.enum([
  "serial_text",
  "tauri_scanner",
  "browser_test",
  "manual_dev",
]);

export const daemonIpcPickupReminderSchema = z
  .object({
    stage: z
      .enum([
        "outlet_opened",
        "pickup_waiting",
        "pickup_completed",
        "pickup_timeout_warning",
      ])
      .optional(),
    level: z.enum(["info", "warning", "urgent"]),
    message: z.string(),
    warningNo: z.number().int().positive().nullable(),
    reportedAt: z.string(),
    remainingSeconds: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const daemonIpcVendingSummarySchema = z
  .object({
    commandNo: z.string().nullable(),
    status: vendingCommandStatusSchema.nullable(),
    lastError: z.string().nullable(),
    pickupReminder: daemonIpcPickupReminderSchema.nullable().optional(),
  })
  .strict();

export const daemonIpcPaymentCodeAttemptSummarySchema = z
  .object({
    attemptNo: z.number().int().positive().nullable(),
    status: paymentCodeAttemptStatusSchema.nullable(),
    maskedAuthCode: z.string().nullable(),
    source: daemonIpcPaymentCodeSourceSchema.nullable(),
    idempotencyKey: z.string().nullable(),
    submittedAt: z.string().nullable(),
    lastCheckedAt: z.string().nullable(),
    canRetry: z.boolean(),
    message: z.string().nullable(),
  })
  .strict();

export const daemonIpcTransactionSnapshotSchema = z
  .object({
    orderId: z.string().nullable(),
    orderNo: z.string().nullable(),
    productSummary: z.unknown().nullable(),
    paymentNo: z.string().nullable(),
    paymentMethod: paymentMethodSchema.nullable(),
    paymentProvider: daemonIpcMachinePaymentProviderSchema.nullable(),
    paymentUrl: z.string().nullable(),
    paymentStatus: paymentStatusSchema.nullable(),
    orderStatus: orderStatusSchema.nullable(),
    totalAmountCents: z.number().int().nonnegative().nullable(),
    vending: daemonIpcVendingSummarySchema.nullable(),
    nextAction: daemonIpcCheckoutFlowActionSchema
      .nullable()
      .optional()
      .transform((value) => value ?? null),
    maskedAuthCode: z.string().nullable(),
    paymentCodeAttempt: daemonIpcPaymentCodeAttemptSummarySchema.nullable(),
    expiresAt: z.string().nullable(),
    errorCode: z.string().nullable(),
    errorMessage: z.string().nullable(),
    operatorHint: z.string().nullable(),
    updatedAt: z.string(),
  })
  .strict()
  .superRefine((snapshot, ctx) => {
    if (snapshot.orderNo && !snapshot.nextAction) {
      ctx.addIssue({
        code: "custom",
        path: ["nextAction"],
        message: "current transaction snapshots must include nextAction",
      });
    }
    if (snapshot.orderNo && snapshot.nextAction === "wait_payment") {
      if (!snapshot.paymentMethod) {
        ctx.addIssue({
          code: "custom",
          path: ["paymentMethod"],
          message:
            "awaiting-payment transaction snapshots must include paymentMethod",
        });
      }
      if (snapshot.totalAmountCents === null) {
        ctx.addIssue({
          code: "custom",
          path: ["totalAmountCents"],
          message:
            "awaiting-payment transaction snapshots must include totalAmountCents",
        });
      }
    }
  });

export type DaemonIpcTransactionSnapshot = z.infer<
  typeof daemonIpcTransactionSnapshotSchema
>;
export type DaemonIpcPaymentCodeAttemptSummary = z.infer<
  typeof daemonIpcPaymentCodeAttemptSummarySchema
>;
export type DaemonIpcVendingSummary = z.infer<
  typeof daemonIpcVendingSummarySchema
>;
