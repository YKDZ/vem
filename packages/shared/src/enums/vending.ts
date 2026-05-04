import { z } from "zod";

export const vendingCommandStatusSchema = z.enum([
  "pending",
  "sent",
  "acknowledged",
  "succeeded",
  "failed",
  "timeout",
]);
export type VendingCommandStatus = z.infer<typeof vendingCommandStatusSchema>;
export const vendingCommandStatuses = vendingCommandStatusSchema.options;
