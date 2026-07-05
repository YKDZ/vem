import type { z } from "zod";

import {
  auditLogListQuerySchema,
  auditLogPageResponseSchema,
  type AuditLogPageResponse,
  type AuditLogResponse,
  type PageResult,
} from "@vem/shared";

import { getContract } from "./request";

export type AuditLog = AuditLogResponse;
export type { PageResult };

export async function listAuditLogs(
  query?: z.input<typeof auditLogListQuerySchema>,
): Promise<AuditLogPageResponse> {
  return await getContract(
    "/audit-logs",
    auditLogListQuerySchema,
    auditLogPageResponseSchema,
    query ?? {},
  );
}
