import type {
  AdminNotificationResponse,
  NotificationReadResponse,
} from "@vem/shared";

import { notifications } from "@vem/db";
import {
  adminNotificationResponseSchema,
  notificationReadResponseSchema,
} from "@vem/shared";

type NotificationUpdate = Partial<typeof notifications.$inferInsert>;

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export function mapNotificationReadToPatch(
  updatedAt = new Date(),
): NotificationUpdate {
  return {
    status: "read",
    updatedAt,
  } satisfies NotificationUpdate;
}

export function toAdminNotificationResponse(
  row: typeof notifications.$inferSelect,
): AdminNotificationResponse {
  const response = {
    id: row.id,
    type: row.type,
    title: row.title,
    severity: row.severity,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    status: row.status,
    createdAt: toIsoString(row.createdAt),
  } satisfies AdminNotificationResponse;
  return adminNotificationResponseSchema.parse(response);
}

export function toNotificationReadResponse(
  row: typeof notifications.$inferSelect,
): NotificationReadResponse {
  const response = {
    id: row.id,
    status: "read",
    updatedAt: toIsoString(row.updatedAt),
  } satisfies NotificationReadResponse;
  return notificationReadResponseSchema.parse(response);
}
