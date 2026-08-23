import { z } from "zod";

import { defineAdminEndpointContract } from "../admin-api-contract";
import { permissionCodeSchema } from "../enums/access";

const noPathParamsSchema = z.strictObject({});
const noQuerySchema = z.strictObject({});
const noBodySchema = z.strictObject({});

export const loginRequestSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(8).max(128),
});

export const loginResponseSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
});

export const currentAdminUserSchema = z.object({
  id: z.uuid(),
  username: z.string(),
  displayName: z.string(),
  roles: z.array(z.string()),
  permissions: z.array(permissionCodeSchema),
});

export const adminGetCurrentAdminContract = defineAdminEndpointContract({
  method: "GET",
  path: "/auth/me",
  pathParamsSchema: noPathParamsSchema,
  querySchema: noQuerySchema,
  bodySchema: noBodySchema,
  responseSchema: currentAdminUserSchema,
});
