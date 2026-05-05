import { get, post } from "./request";

export type Notification = {
  id: string;
  type: string;
  title: string;
  severity: string;
  resourceType: string | null;
  resourceId: string | null;
  status: string;
  createdAt: string;
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listNotifications(
  query?: Record<string, unknown>,
): Promise<PageResult<Notification>> {
  return await get<PageResult<Notification>>("/notifications", {
    params: query,
  });
}

export async function markNotificationRead(id: string): Promise<void> {
  await post<void>(`/notifications/${id}/read`);
}
