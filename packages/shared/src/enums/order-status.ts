import { z } from "zod";

export const orderStatusSchema = z.enum([
  "pending_payment",
  "payment_expired",
  "canceled",
  "paid",
  "dispensing",
  "fulfilled",
  "dispense_failed",
  "manual_handling",
  "refund_pending",
  "refunded",
  "closed",
]);
export type OrderStatus = z.infer<typeof orderStatusSchema>;
export const orderStatuses = orderStatusSchema.options;

export const orderSourceSchema = z.enum(["machine_ui", "admin", "api"]);
export type OrderSource = z.infer<typeof orderSourceSchema>;
export const orderSources = orderSourceSchema.options;

export const orderPaymentStateSchema = z.enum([
  "awaiting_payment",
  "paid",
  "payment_failed",
  "payment_expired",
  "canceled",
  "refund_pending",
  "partial_refund_pending",
  "manual_handling",
  "refunded",
  "partial_refunded",
]);
export type OrderPaymentState = z.infer<typeof orderPaymentStateSchema>;
export const orderPaymentStates = orderPaymentStateSchema.options;

export const orderFulfillmentStateSchema = z.enum([
  "awaiting_fulfillment",
  "dispensing",
  "dispensed",
  "partial_dispensed",
  "dispense_failed",
  "manual_handling",
  "canceled",
]);
export type OrderFulfillmentState = z.infer<typeof orderFulfillmentStateSchema>;
export const orderFulfillmentStates = orderFulfillmentStateSchema.options;

export const orderLineFulfillmentStatusSchema = z.enum([
  "pending",
  "dispensing",
  "dispensed",
  "dispense_failed",
  "manual_handling",
]);
export type OrderLineFulfillmentStatus = z.infer<
  typeof orderLineFulfillmentStatusSchema
>;
export const orderLineFulfillmentStatuses =
  orderLineFulfillmentStatusSchema.options;

export const orderLineRefundStatusSchema = z.enum([
  "not_required",
  "pending",
  "refunded",
  "failed",
  "manual_handling",
]);
export type OrderLineRefundStatus = z.infer<typeof orderLineRefundStatusSchema>;
export const orderLineRefundStatuses = orderLineRefundStatusSchema.options;
