import { z } from "zod";

import { defineAdminEndpointContract } from "../admin-api-contract";
import {
  adminUserStatusSchema,
  permissionCodeSchema,
  roleStatusSchema,
} from "../enums/access";
import { createPageResultSchema, pageQuerySchema } from "./pagination";

const noPathParamsSchema = z.strictObject({});
const noQuerySchema = z.strictObject({});
const noBodySchema = z.strictObject({});

const uniquePermissionCodesSchema = z
  .array(permissionCodeSchema)
  .superRefine((codes, ctx) => {
    const seen = new Set<string>();
    codes.forEach((code, index) => {
      if (seen.has(code)) {
        ctx.addIssue({
          code: "custom",
          message: "Permission codes must be unique",
          path: [index],
        });
      }
      seen.add(code);
    });
  });

export const adminUserQuerySchema = z.strictObject({
  username: z.string().max(64).optional(),
  status: adminUserStatusSchema.optional(),
});

export const adminUserListQuerySchema = adminUserQuerySchema.extend(
  pageQuerySchema.shape,
);

const adminUserWriteFields = {
  username: z.string().min(3).max(64),
  password: z.string().min(12).max(128),
  displayName: z.string().min(1).max(64),
  mobile: z.string().max(32).nullable().optional(),
  email: z.email().nullable().optional(),
  status: adminUserStatusSchema,
  roleIds: z.array(z.uuid()),
};

export const createAdminUserSchema = z.strictObject({
  ...adminUserWriteFields,
  status: adminUserStatusSchema.default("active"),
  roleIds: z.array(z.uuid()).default([]),
});

export const updateAdminUserSchema = z
  .strictObject(adminUserWriteFields)
  .partial();

export const adminUserResponseSchema = z.strictObject({
  id: z.uuid(),
  username: z.string().min(1).max(64),
  displayName: z.string().min(1).max(64),
  mobile: z.string().max(32).nullable(),
  email: z.email().nullable(),
  status: adminUserStatusSchema,
  roles: z.array(z.uuid()),
  lastLoginAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const adminUserPageResponseSchema = createPageResultSchema(
  adminUserResponseSchema,
);

export const adminListAdminUsersContract = defineAdminEndpointContract({
  method: "GET",
  path: "/admin-users",
  pathParamsSchema: noPathParamsSchema,
  querySchema: adminUserListQuerySchema,
  bodySchema: noBodySchema,
  responseSchema: adminUserPageResponseSchema,
});

export const adminCreateAdminUserContract = defineAdminEndpointContract({
  method: "POST",
  path: "/admin-users",
  pathParamsSchema: noPathParamsSchema,
  querySchema: noQuerySchema,
  bodySchema: createAdminUserSchema,
  responseSchema: adminUserResponseSchema,
});

export const adminUpdateAdminUserContract = defineAdminEndpointContract({
  method: "PATCH",
  path: "/admin-users/:id",
  pathParamsSchema: z.strictObject({ id: z.uuid() }),
  querySchema: noQuerySchema,
  bodySchema: updateAdminUserSchema,
  responseSchema: adminUserResponseSchema,
});

export const roleQuerySchema = z.strictObject({
  keyword: z.string().max(64).optional(),
  status: roleStatusSchema.optional(),
});

export const roleListQuerySchema = roleQuerySchema.extend(
  pageQuerySchema.shape,
);

const roleWriteFields = {
  code: z.string().min(2).max(64),
  name: z.string().min(1).max(64),
  description: z.string().max(500).nullable().optional(),
  status: roleStatusSchema,
  permissionCodes: uniquePermissionCodesSchema,
};

export const createRoleSchema = z.strictObject({
  ...roleWriteFields,
  status: roleStatusSchema.default("active"),
  permissionCodes: uniquePermissionCodesSchema.default([]),
});

export const updateRoleSchema = z.strictObject(roleWriteFields).partial();

export const adminRoleResponseSchema = z.strictObject({
  id: z.uuid(),
  code: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  description: z.string().max(500).nullable(),
  isBuiltin: z.boolean(),
  status: roleStatusSchema,
  permissionCodes: uniquePermissionCodesSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const adminRolePageResponseSchema = createPageResultSchema(
  adminRoleResponseSchema,
);

export const adminPermissionCodeListQuerySchema = z.strictObject({});
export const adminPermissionCodeListResponseSchema =
  uniquePermissionCodesSchema;

export const adminListRolesContract = defineAdminEndpointContract({
  method: "GET",
  path: "/roles",
  pathParamsSchema: noPathParamsSchema,
  querySchema: roleListQuerySchema,
  bodySchema: noBodySchema,
  responseSchema: adminRolePageResponseSchema,
});

export const adminCreateRoleContract = defineAdminEndpointContract({
  method: "POST",
  path: "/roles",
  pathParamsSchema: noPathParamsSchema,
  querySchema: noQuerySchema,
  bodySchema: createRoleSchema,
  responseSchema: adminRoleResponseSchema,
});

export const adminUpdateRoleContract = defineAdminEndpointContract({
  method: "PATCH",
  path: "/roles/:id",
  pathParamsSchema: z.strictObject({ id: z.uuid() }),
  querySchema: noQuerySchema,
  bodySchema: updateRoleSchema,
  responseSchema: adminRoleResponseSchema,
});

export const adminListPermissionCodesContract = defineAdminEndpointContract({
  method: "GET",
  path: "/permissions",
  pathParamsSchema: noPathParamsSchema,
  querySchema: adminPermissionCodeListQuerySchema,
  bodySchema: noBodySchema,
  responseSchema: adminPermissionCodeListResponseSchema,
});

export type AdminUserListQuery = z.infer<typeof adminUserListQuerySchema>;
export type AdminCreateUserRequest = z.infer<typeof createAdminUserSchema>;
export type AdminUpdateUserRequest = z.infer<typeof updateAdminUserSchema>;
export type AdminUserResponse = z.infer<typeof adminUserResponseSchema>;
export type AdminUserPageResponse = z.infer<typeof adminUserPageResponseSchema>;

export type AdminRoleListQuery = z.infer<typeof roleListQuerySchema>;
export type AdminCreateRoleRequest = z.infer<typeof createRoleSchema>;
export type AdminUpdateRoleRequest = z.infer<typeof updateRoleSchema>;
export type AdminRoleResponse = z.infer<typeof adminRoleResponseSchema>;
export type AdminRolePageResponse = z.infer<typeof adminRolePageResponseSchema>;
