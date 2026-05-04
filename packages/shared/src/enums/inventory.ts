import { z } from "zod";

export const inventoryReservationStatusSchema = z.enum([
  "active",
  "confirmed",
  "released",
  "expired",
]);
export type InventoryReservationStatus = z.infer<
  typeof inventoryReservationStatusSchema
>;
export const inventoryReservationStatuses =
  inventoryReservationStatusSchema.options;

export const inventoryMovementReasonSchema = z.enum([
  "refill",
  "adjust",
  "purchase_reserved",
  "purchase_confirmed",
  "reservation_released",
  "refund_return",
  "hardware_sync",
]);
export type InventoryMovementReason = z.infer<
  typeof inventoryMovementReasonSchema
>;
export const inventoryMovementReasons = inventoryMovementReasonSchema.options;
