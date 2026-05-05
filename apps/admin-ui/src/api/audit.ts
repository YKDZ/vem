import { get } from "./request";

export type AuditLog = {
  id: string;
  adminUserId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  beforeJson: Record<string, unknown> | null;
  afterJson: Record<string, unknown> | null;
  createdAt: string;
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listAuditLogs(
  query?: Record<string, unknown>,
): Promise<PageResult<AuditLog>> {
  return await get<PageResult<AuditLog>>("/audit-logs", { params: query });
}
