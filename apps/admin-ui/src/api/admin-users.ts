import type { z } from "zod";

import {
  adminUserListQuerySchema,
  adminUserPageResponseSchema,
  adminUserResponseSchema,
  createAdminUserSchema,
  updateAdminUserSchema,
  type AdminUserPageResponse,
  type AdminUserResponse,
} from "@vem/shared";

import { getContract, patchContract, postContract } from "./request";

export type AdminUser = AdminUserResponse;
export type PageResult<T> = AdminUserPageResponse & { items: T[] };

export async function listAdminUsers(
  query?: z.input<typeof adminUserListQuerySchema>,
): Promise<AdminUserPageResponse> {
  return await getContract(
    "/admin-users",
    adminUserListQuerySchema,
    adminUserPageResponseSchema,
    query ?? {},
  );
}

export async function createAdminUser(
  body: z.input<typeof createAdminUserSchema>,
): Promise<AdminUser> {
  return await postContract(
    "/admin-users",
    createAdminUserSchema,
    adminUserResponseSchema,
    body,
  );
}

export async function updateAdminUser(
  id: string,
  body: z.input<typeof updateAdminUserSchema>,
): Promise<AdminUser> {
  return await patchContract(
    `/admin-users/${id}`,
    updateAdminUserSchema,
    adminUserResponseSchema,
    body,
  );
}
