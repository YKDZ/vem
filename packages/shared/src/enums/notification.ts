import { z } from "zod";

export const notificationTargetTypeSchema = z.enum([
  "in_app",
  "sms",
  "wechat",
  "email",
]);
export type NotificationTargetType = z.infer<
  typeof notificationTargetTypeSchema
>;
export const notificationTargetTypes = notificationTargetTypeSchema.options;

export const notificationTypeSchema = z.enum([
  "low_stock",
  "sold_out",
  "machine_offline",
  "payment_failed",
  "dispense_failed",
]);
export type NotificationType = z.infer<typeof notificationTypeSchema>;
export const notificationTypes = notificationTypeSchema.options;

export const notificationSeveritySchema = z.enum([
  "info",
  "warning",
  "critical",
]);
export type NotificationSeverity = z.infer<typeof notificationSeveritySchema>;
export const notificationSeverities = notificationSeveritySchema.options;

export const notificationStatusSchema = z.enum(["unread", "read", "archived"]);
export type NotificationStatus = z.infer<typeof notificationStatusSchema>;
export const notificationStatuses = notificationStatusSchema.options;

export const notificationDeliveryStatusSchema = z.enum([
  "pending",
  "sent",
  "failed",
]);
export type NotificationDeliveryStatus = z.infer<
  typeof notificationDeliveryStatusSchema
>;
export const notificationDeliveryStatuses =
  notificationDeliveryStatusSchema.options;
