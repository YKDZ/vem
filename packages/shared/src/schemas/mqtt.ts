import { z } from "zod";

export const commandAckPayloadSchema = z
  .object({
    messageId: z.string().min(1).max(128).optional(),
  })
  .loose();

export const dispenseCommandPayloadSchema = z.object({
  commandNo: z.string().min(1).max(64),
  orderNo: z.string().min(1).max(64),
  slot: z.object({
    layerNo: z.int().min(1),
    cellNo: z.int().min(1),
    slotCode: z.string().min(1).max(32),
  }),
  quantity: z.int().positive(),
  timeoutSeconds: z.int().positive(),
});

export const dispenseResultPayloadSchema = z.object({
  commandNo: z.string().min(1).max(64),
  success: z.boolean(),
  errorCode: z.string().nullable(),
  message: z.string(),
  reportedAt: z.iso.datetime(),
});
