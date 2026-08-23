import type { z } from "zod";

import {
  adminListNotificationsContract,
  adminMarkNotificationReadContract,
  type AdminNotificationResponse,
  type NotificationReadResponse,
  type PageResult,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export type Notification = AdminNotificationResponse;
export type { PageResult };

export async function listNotifications(
  query?: z.input<typeof adminListNotificationsContract.querySchema>,
): Promise<PageResult<Notification>> {
  return await callAdminEndpointContract(adminListNotificationsContract, {
    query: query ?? {},
  });
}

export async function markNotificationRead(
  id: string,
): Promise<NotificationReadResponse> {
  return await callAdminEndpointContract(adminMarkNotificationReadContract, {
    pathParams: { id },
  });
}
