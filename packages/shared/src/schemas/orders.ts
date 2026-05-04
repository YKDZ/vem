import { z } from "zod";

import { orderStatusSchema } from "../enums/order-status";
import { paymentMethodSchema } from "../enums/payment-status";

export const orderQuerySchema = z.object({
  orderNo: z.string().max(64).optional(),
  machineId: z.uuid().optional(),
  status: orderStatusSchema.optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
});

export const machineOrderItemSchema = z.object({
  inventoryId: z.uuid(),
  quantity: z.int().positive(),
});

export const createMachineOrderSchema = z.object({
  machineCode: z.string().min(1).max(64),
  items: z.array(machineOrderItemSchema).min(1).max(10),
  paymentMethod: paymentMethodSchema,
  profileSnapshot: z.record(z.string(), z.unknown()).optional(),
});
