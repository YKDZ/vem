import { z } from "zod";

import { defineAdminEndpointContract } from "../admin-api-contract";
import { createPageResultSchema, pageQuerySchema } from "./pagination";

const noPathParamsSchema = z.strictObject({});
const noBodySchema = z.strictObject({});

export const auditLogQuerySchema = z.object({
  adminUserId: z.uuid().optional(),
  action: z.string().max(128).optional(),
  resourceType: z.string().max(64).optional(),
  resourceId: z.uuid().optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
});

export const auditLogListQuerySchema = auditLogQuerySchema.extend(
  pageQuerySchema.shape,
);

const auditJsonFieldSchema = z.record(z.string(), z.unknown());

export const auditLogResponseSchema = z.strictObject({
  id: z.uuid(),
  adminUserId: z.uuid().nullable(),
  action: z.string().min(1).max(128),
  resourceType: z.string().min(1).max(64),
  resourceId: z.string().max(128).nullable(),
  beforeJson: auditJsonFieldSchema.nullable(),
  afterJson: auditJsonFieldSchema.nullable(),
  createdAt: z.iso.datetime(),
});

export const auditLogPageResponseSchema = createPageResultSchema(
  auditLogResponseSchema,
);

export const adminListAuditLogsContract = defineAdminEndpointContract({
  method: "GET",
  path: "/audit-logs",
  pathParamsSchema: noPathParamsSchema,
  querySchema: auditLogListQuerySchema,
  bodySchema: noBodySchema,
  responseSchema: auditLogPageResponseSchema,
});

export type AuditLogListQuery = z.infer<typeof auditLogListQuerySchema>;
export type AuditLogResponse = z.infer<typeof auditLogResponseSchema>;
export type AuditLogPageResponse = z.infer<typeof auditLogPageResponseSchema>;
