import type { PermissionCode } from "@vem/shared";

import { get, post } from "./request";

export type CurrentAdmin = {
  id: string;
  username: string;
  displayName: string;
  roles: string[];
  permissions: PermissionCode[];
};

export type LoginResponse = {
  accessToken: string;
  refreshToken?: string;
};

export async function loginApi(input: {
  username: string;
  password: string;
}): Promise<LoginResponse> {
  return await post<LoginResponse, typeof input>("/auth/login", input);
}

export async function meApi(): Promise<CurrentAdmin> {
  return await get<CurrentAdmin>("/auth/me");
}

export async function refreshApi(refreshToken: string): Promise<LoginResponse> {
  return await post<LoginResponse, { refreshToken: string }>("/auth/refresh", {
    refreshToken,
  });
}
