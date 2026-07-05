import type { z } from "zod";

import {
  adminPermissionCodeListQuerySchema,
  adminPermissionCodeListResponseSchema,
  adminRolePageResponseSchema,
  adminRoleResponseSchema,
  createRoleSchema,
  roleListQuerySchema,
  updateRoleSchema,
  type AdminRolePageResponse,
  type AdminRoleResponse,
  type PermissionCode,
} from "@vem/shared";

import { getContract, patchContract, postContract } from "./request";

export type Role = AdminRoleResponse;
export type PageResult<T> = AdminRolePageResponse & { items: T[] };

export async function listRoles(
  query?: z.input<typeof roleListQuerySchema>,
): Promise<AdminRolePageResponse> {
  return await getContract(
    "/roles",
    roleListQuerySchema,
    adminRolePageResponseSchema,
    query ?? {},
  );
}

export async function createRole(
  body: z.input<typeof createRoleSchema>,
): Promise<Role> {
  return await postContract(
    "/roles",
    createRoleSchema,
    adminRoleResponseSchema,
    body,
  );
}

export async function updateRole(
  id: string,
  body: z.input<typeof updateRoleSchema>,
): Promise<Role> {
  return await patchContract(
    `/roles/${id}`,
    updateRoleSchema,
    adminRoleResponseSchema,
    body,
  );
}

export async function listPermissions(): Promise<PermissionCode[]> {
  return await getContract(
    "/permissions",
    adminPermissionCodeListQuerySchema,
    adminPermissionCodeListResponseSchema,
    {},
  );
}
