import { z } from "zod";

import {
  maintenanceWorkOrderPrioritySchema,
  maintenanceWorkOrderStatusSchema,
  notificationTargetTypeSchema,
} from "../enums/notification";

export const notificationTargetConfigSchema = z.object({
  webhookUrl: z.url().optional(),
  secret: z.string().min(8).optional(),
  email: z.email().optional(),
  mobile: z.string().min(6).max(32).optional(),
});

export const upsertNotificationTargetSchema = z.object({
  name: z.string().min(1).max(128),
  type: notificationTargetTypeSchema,
  targetMasked: z.string().max(128).nullable().optional(),
  configJson: notificationTargetConfigSchema,
  status: z.enum(["enabled", "disabled"]).optional(),
});

export const updateMaintenanceWorkOrderSchema = z.object({
  status: maintenanceWorkOrderStatusSchema.optional(),
  priority: maintenanceWorkOrderPrioritySchema.optional(),
  assigneeAdminUserId: z.uuid().nullable().optional(),
  resolutionNote: z.string().max(1000).nullable().optional(),
});

export type UpsertNotificationTargetInput = z.infer<
  typeof upsertNotificationTargetSchema
>;
export type UpdateMaintenanceWorkOrderInput = z.infer<
  typeof updateMaintenanceWorkOrderSchema
>;
