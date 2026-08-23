import type { z } from "zod";

import {
  adminCreateAdminUserContract,
  adminListAdminUsersContract,
  adminUpdateAdminUserContract,
  type AdminUserPageResponse,
  type AdminUserResponse,
  type PageResult,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export type AdminUser = AdminUserResponse;
export type { PageResult };

export async function listAdminUsers(
  query?: z.input<typeof adminListAdminUsersContract.querySchema>,
): Promise<AdminUserPageResponse> {
  return await callAdminEndpointContract(adminListAdminUsersContract, {
    query: query ?? {},
  });
}

export async function createAdminUser(
  body: z.input<typeof adminCreateAdminUserContract.bodySchema>,
): Promise<AdminUser> {
  return await callAdminEndpointContract(adminCreateAdminUserContract, {
    body,
  });
}

export async function updateAdminUser(
  id: string,
  body: z.input<typeof adminUpdateAdminUserContract.bodySchema>,
): Promise<AdminUser> {
  return await callAdminEndpointContract(adminUpdateAdminUserContract, {
    pathParams: { id },
    body,
  });
}
