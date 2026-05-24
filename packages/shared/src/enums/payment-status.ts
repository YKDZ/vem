import { z } from "zod";

export const paymentProviderTypeSchema = z.enum([
  "mock",
  "wechat_pay",
  "alipay",
  "qr_code",
  "face_pay",
  "aggregate",
]);
export type PaymentProviderType = z.infer<typeof paymentProviderTypeSchema>;
export const paymentProviderTypes = paymentProviderTypeSchema.options;

export const paymentProviderStatusSchema = z.enum(["enabled", "disabled"]);
export type PaymentProviderStatus = z.infer<typeof paymentProviderStatusSchema>;
export const paymentProviderStatuses = paymentProviderStatusSchema.options;

export const paymentMethodSchema = z.enum([
  "mock",
  "qr_code",
  "payment_code",
  "face_pay",
]);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;
export const paymentMethods = paymentMethodSchema.options;

export const paymentStatusSchema = z.enum([
  "created",
  "pending",
  "processing",
  "succeeded",
  "failed",
  "expired",
  "canceled",
  "refund_pending",
  "refunded",
  "partial_refunded",
]);
export type PaymentStatus = z.infer<typeof paymentStatusSchema>;
export const paymentStatuses = paymentStatusSchema.options;

export const paymentCodeAttemptStatusSchema = z.enum([
  "created",
  "submitting",
  "user_confirming",
  "querying",
  "succeeded",
  "failed",
  "reversing",
  "reversed",
  "unknown",
  "manual_handling",
  "canceled",
]);
export type PaymentCodeAttemptStatus = z.infer<
  typeof paymentCodeAttemptStatusSchema
>;
export const paymentCodeAttemptStatuses =
  paymentCodeAttemptStatusSchema.options;

export const refundStatusSchema = z.enum([
  "created",
  "processing",
  "succeeded",
  "failed",
  "canceled",
]);
export type RefundStatus = z.infer<typeof refundStatusSchema>;
export const refundStatuses = refundStatusSchema.options;
