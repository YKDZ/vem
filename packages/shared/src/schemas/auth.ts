import { z } from "zod";

import { permissionCodeSchema } from "../enums/access";

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
