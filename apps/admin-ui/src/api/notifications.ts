import type { z } from "zod";

import {
  adminNotificationListQuerySchema,
  adminNotificationPageResponseSchema,
  notificationAdminNoBodySchema,
  notificationReadResponseSchema,
  type AdminNotificationResponse,
  type NotificationReadResponse,
  type PageResult,
} from "@vem/shared";

import { getContract, postContract } from "./request";

export type Notification = AdminNotificationResponse;
export type { PageResult };

export async function listNotifications(
  query?: z.input<typeof adminNotificationListQuerySchema>,
): Promise<PageResult<Notification>> {
  return await getContract(
    "/notifications",
    adminNotificationListQuerySchema,
    adminNotificationPageResponseSchema,
    query ?? {},
  );
}

export async function markNotificationRead(
  id: string,
): Promise<NotificationReadResponse> {
  return await postContract(
    `/notifications/${id}/read`,
    notificationAdminNoBodySchema,
    notificationReadResponseSchema,
    {},
  );
}
