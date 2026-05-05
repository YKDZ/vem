import type { AdminUserStatus } from "@vem/shared";

import { get, patch, post } from "./request";

export type AdminUser = {
  id: string;
  username: string;
  displayName: string;
  mobile: string | null;
  email: string | null;
  status: AdminUserStatus;
  roles: string[];
  lastLoginAt: string | null;
  createdAt: string;
};

export type PageResult<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
};

export async function listAdminUsers(
  query?: Record<string, unknown>,
): Promise<PageResult<AdminUser>> {
  return await get<PageResult<AdminUser>>("/admin-users", { params: query });
}

export async function createAdminUser(body: {
  username: string;
  password: string;
  displayName: string;
  mobile?: string | null;
  email?: string | null;
  status?: string;
  roleIds?: string[];
}): Promise<AdminUser> {
  return await post<AdminUser>("/admin-users", body);
}

export async function updateAdminUser(
  id: string,
  body: {
    username?: string;
    password?: string;
    displayName?: string;
    mobile?: string | null;
    email?: string | null;
    status?: string;
    roleIds?: string[];
  },
): Promise<AdminUser> {
  return await patch<AdminUser>(`/admin-users/${id}`, body);
}
