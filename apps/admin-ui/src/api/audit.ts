import type { z } from "zod";

import {
  adminListAuditLogsContract,
  type AuditLogPageResponse,
  type AuditLogResponse,
  type PageResult,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export type AuditLog = AuditLogResponse;
export type { PageResult };

export async function listAuditLogs(
  query?: z.input<typeof adminListAuditLogsContract.querySchema>,
): Promise<AuditLogPageResponse> {
  return await callAdminEndpointContract(adminListAuditLogsContract, {
    query: query ?? {},
  });
}
