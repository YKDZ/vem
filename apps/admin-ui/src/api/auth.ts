import { post } from "./request";

export type LoginResponse = {
  accessToken: string;
  refreshToken?: string;
};

export async function loginApi(input: {
  username: string;
  password: string;
}): Promise<LoginResponse> {
  return await post<LoginResponse>("/auth/login", input);
}

export async function refreshApi(refreshToken: string): Promise<LoginResponse> {
  return await post<LoginResponse>("/auth/refresh", {
    refreshToken,
  });
}
