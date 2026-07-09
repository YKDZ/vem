import { z } from "zod";

import { hardwareErrorCodeSchema } from "../enums/hardware";

export const upsertHardwareErrorPolicySchema = z.strictObject({
  errorCode: hardwareErrorCodeSchema.nullable(),
  restoreInventory: z.boolean(),
  faultSlot: z.boolean(),
  requestRefund: z.boolean(),
  createWorkOrder: z.boolean(),
  severity: z.enum(["info", "warning", "critical"]),
});

export const adminHardwareErrorPolicyResponseSchema = z.strictObject({
  id: z.uuid(),
  errorCode: z.string().nullable(),
  restoreInventory: z.boolean(),
  faultSlot: z.boolean(),
  requestRefund: z.boolean(),
  createWorkOrder: z.boolean(),
  severity: z.enum(["info", "warning", "critical"]),
  status: z.enum(["enabled", "disabled"]),
  updatedByAdminUserId: z.uuid().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const adminHardwareErrorPolicyListResponseSchema = z.array(
  adminHardwareErrorPolicyResponseSchema,
);

export type AdminUpsertHardwareErrorPolicyRequest = z.infer<
  typeof upsertHardwareErrorPolicySchema
>;
export type AdminHardwareErrorPolicyResponse = z.infer<
  typeof adminHardwareErrorPolicyResponseSchema
>;
