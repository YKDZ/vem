import type { RoleStatus } from "@vem/shared";

import { get, patch, post } from "./request";

export type Role = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isBuiltin: boolean;
  status: RoleStatus;
  permissionCodes: string[];
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listRoles(
  query?: Record<string, unknown>,
): Promise<PageResult<Role>> {
  return await get<PageResult<Role>>("/roles", { params: query });
}

export async function createRole(body: {
  code: string;
  name: string;
  description?: string | null;
  status?: string;
  permissionCodes?: string[];
}): Promise<Role> {
  return await post<Role>("/roles", body);
}

export async function updateRole(
  id: string,
  body: {
    code?: string;
    name?: string;
    description?: string | null;
    status?: string;
    permissionCodes?: string[];
  },
): Promise<Role> {
  return await patch<Role>(`/roles/${id}`, body);
}

export async function listPermissions(): Promise<string[]> {
  return await get<string[]>("/permissions");
}
