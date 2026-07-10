import {
  auditLogResponseSchema,
  createHumanMaintenanceSessionRequestSchema,
  maintenanceAccessAuditListQuerySchema,
  maintenanceAccessOverviewResponseSchema,
  maintenanceSessionListQuerySchema,
  maintenanceSessionResponseSchema,
  type AuditLogResponse,
  type MaintenanceAccessOverviewResponse,
  type MaintenanceSessionResponse,
} from "@vem/shared";
import { z } from "zod";

import { getContract, postContract } from "./request";

export async function getMaintenanceAccessOverview(): Promise<MaintenanceAccessOverviewResponse> {
  return await getContract(
    "/maintenance-access",
    z.strictObject({}),
    maintenanceAccessOverviewResponseSchema,
    {},
  );
}

export async function createMaintenanceSession(
  body: z.input<typeof createHumanMaintenanceSessionRequestSchema>,
): Promise<MaintenanceSessionResponse> {
  return await postContract(
    "/maintenance-access/sessions",
    createHumanMaintenanceSessionRequestSchema,
    maintenanceSessionResponseSchema,
    body,
  );
}

export async function getMaintenanceAudit(
  query: z.input<typeof maintenanceAccessAuditListQuerySchema> = {},
): Promise<AuditLogResponse[]> {
  return await getContract(
    "/maintenance-access/audit",
    maintenanceAccessAuditListQuerySchema,
    auditLogResponseSchema.array(),
    query,
  );
}

export async function getMaintenanceSessions(
  query: z.input<typeof maintenanceSessionListQuerySchema> = {},
): Promise<MaintenanceSessionResponse[]> {
  return await getContract(
    "/maintenance-access/sessions",
    maintenanceSessionListQuerySchema,
    maintenanceSessionResponseSchema.array(),
    query,
  );
}

export async function revokeMaintenanceSession(
  sessionId: string,
): Promise<MaintenanceSessionResponse> {
  return await postContract(
    `/maintenance-access/sessions/${sessionId}/revoke`,
    z.undefined(),
    maintenanceSessionResponseSchema,
    undefined,
  );
}
