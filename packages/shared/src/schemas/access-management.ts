import { z } from "zod";

import {
  adminUserStatusSchema,
  permissionCodeSchema,
  roleStatusSchema,
} from "../enums/access";

export const adminUserQuerySchema = z.object({
  username: z.string().max(64).optional(),
  status: adminUserStatusSchema.optional(),
});

export const createAdminUserSchema = z.object({
  username: z.string().min(3).max(64),
  password: z.string().min(12).max(128),
  displayName: z.string().min(1).max(64),
  mobile: z.string().max(32).nullable().optional(),
  email: z.email().nullable().optional(),
  status: adminUserStatusSchema.default("active"),
  roleIds: z.array(z.uuid()).default([]),
});

export const updateAdminUserSchema = createAdminUserSchema
  .omit({ password: true })
  .partial()
  .extend({
    password: z.string().min(12).max(128).optional(),
    roleIds: z.array(z.uuid()).optional(),
  });

export const roleQuerySchema = z.object({
  keyword: z.string().max(64).optional(),
  status: roleStatusSchema.optional(),
});

export const createRoleSchema = z.object({
  code: z.string().min(2).max(64),
  name: z.string().min(1).max(64),
  description: z.string().max(500).nullable().optional(),
  status: roleStatusSchema.default("active"),
  permissionCodes: z.array(permissionCodeSchema).default([]),
});

export const updateRoleSchema = createRoleSchema.partial().extend({
  permissionCodes: z.array(permissionCodeSchema).optional(),
});
