import type { z } from "zod";

import {
  adminCreateRoleContract,
  adminListPermissionCodesContract,
  adminListRolesContract,
  adminUpdateRoleContract,
  type AdminRolePageResponse,
  type AdminRoleResponse,
  type PageResult,
  type PermissionCode,
} from "@vem/shared";

import { callAdminEndpointContract } from "./request";

export type Role = AdminRoleResponse;
export type { PageResult };

export async function listRoles(
  query?: z.input<typeof adminListRolesContract.querySchema>,
): Promise<AdminRolePageResponse> {
  return await callAdminEndpointContract(adminListRolesContract, {
    query: query ?? {},
  });
}

export async function createRole(
  body: z.input<typeof adminCreateRoleContract.bodySchema>,
): Promise<Role> {
  return await callAdminEndpointContract(adminCreateRoleContract, { body });
}

export async function updateRole(
  id: string,
  body: z.input<typeof adminUpdateRoleContract.bodySchema>,
): Promise<Role> {
  return await callAdminEndpointContract(adminUpdateRoleContract, {
    pathParams: { id },
    body,
  });
}

export async function listPermissions(): Promise<PermissionCode[]> {
  return await callAdminEndpointContract(adminListPermissionCodesContract, {});
}
