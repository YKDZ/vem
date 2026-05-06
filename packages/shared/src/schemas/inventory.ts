import { z } from "zod";

export const inventoryQuerySchema = z.object({
  machineId: z.uuid().optional(),
  slotId: z.uuid().optional(),
  variantId: z.uuid().optional(),
});

export const refillInventorySchema = z.object({
  inventoryId: z.uuid(),
  quantity: z.int().positive(),
  note: z.string().max(500).optional(),
});

export const adjustInventorySchema = z.object({
  inventoryId: z.uuid(),
  deltaQty: z.int(),
  note: z.string().min(1).max(500),
});

export const createInventorySchema = z
  .object({
    machineId: z.uuid(),
    slotId: z.uuid(),
    variantId: z.uuid(),
    onHandQty: z.int().min(0),
    reservedQty: z.int().min(0).default(0),
    lowStockThreshold: z.int().min(0).default(1),
    note: z.string().max(500).optional(),
  })
  .superRefine((val, ctx) => {
    if (val.reservedQty > val.onHandQty) {
      ctx.addIssue({
        code: "custom",
        path: ["reservedQty"],
        message: "reservedQty cannot exceed onHandQty",
      });
    }
  });
