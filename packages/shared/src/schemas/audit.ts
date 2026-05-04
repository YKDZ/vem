import { z } from "zod";

export const auditLogQuerySchema = z.object({
  adminUserId: z.uuid().optional(),
  action: z.string().max(128).optional(),
  resourceType: z.string().max(64).optional(),
  resourceId: z.uuid().optional(),
  createdFrom: z.iso.datetime().optional(),
  createdTo: z.iso.datetime().optional(),
});
