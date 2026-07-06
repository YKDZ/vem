import { z } from "zod";

import {
  maintenanceWorkOrderPrioritySchema,
  maintenanceWorkOrderStatusSchema,
  notificationSeveritySchema,
  notificationStatusSchema,
  notificationTargetTypeSchema,
  notificationTypeSchema,
} from "../enums/notification";
import { createPageResultSchema } from "./pagination";

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

export const adminMaintenanceWorkOrderListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: maintenanceWorkOrderStatusSchema.optional(),
});

export const adminMaintenanceWorkOrderResolveRequestSchema = z.strictObject({
  resolutionNote: z.string().trim().min(1).max(1000),
});

export const adminMaintenanceWorkOrderResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  workOrderNo: z.string().min(1).max(64),
  machineId: z.string().min(1).max(128).nullable(),
  slotId: z.string().min(1).max(128).nullable(),
  orderId: z.string().min(1).max(128).nullable(),
  commandId: z.string().min(1).max(128).nullable(),
  title: z.string().min(1).max(128),
  description: z.string().min(1),
  priority: maintenanceWorkOrderPrioritySchema,
  status: maintenanceWorkOrderStatusSchema,
  assigneeAdminUserId: z.string().min(1).max(128).nullable(),
  resolutionNote: z.string().nullable(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});

export const adminMaintenanceWorkOrderPageResponseSchema =
  createPageResultSchema(adminMaintenanceWorkOrderResponseSchema);

export const adminNotificationListQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: notificationStatusSchema.optional(),
});

export const adminNotificationResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  type: notificationTypeSchema,
  title: z.string().min(1).max(128),
  severity: notificationSeveritySchema,
  resourceType: z.string().max(64).nullable(),
  resourceId: z.string().min(1).max(128).nullable(),
  status: notificationStatusSchema,
  createdAt: z.iso.datetime(),
});

export const adminNotificationPageResponseSchema = createPageResultSchema(
  adminNotificationResponseSchema,
);

export const notificationAdminNoBodySchema = z.strictObject({});

export const notificationReadResponseSchema = z.strictObject({
  id: z.string().min(1).max(128),
  status: z.literal("read"),
  updatedAt: z.iso.datetime(),
});

export type UpsertNotificationTargetInput = z.infer<
  typeof upsertNotificationTargetSchema
>;
export type UpdateMaintenanceWorkOrderInput = z.infer<
  typeof updateMaintenanceWorkOrderSchema
>;
export type AdminMaintenanceWorkOrderResolveRequest = z.infer<
  typeof adminMaintenanceWorkOrderResolveRequestSchema
>;
export type AdminMaintenanceWorkOrderResponse = z.infer<
  typeof adminMaintenanceWorkOrderResponseSchema
>;
export type AdminNotificationResponse = z.infer<
  typeof adminNotificationResponseSchema
>;
export type NotificationReadResponse = z.infer<
  typeof notificationReadResponseSchema
>;
