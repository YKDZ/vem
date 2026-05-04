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
