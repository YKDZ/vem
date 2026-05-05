import axios, { AxiosError, type AxiosRequestConfig, type AxiosResponse } from "axios";

export type ApiResponse<T> = {
  code: number;
  message: string;
  data: T;
};

type RefreshTokenResponse = {
  accessToken: string;
  refreshToken?: string;
};

type RetryableRequestConfig = AxiosRequestConfig & {
  _retry?: boolean;
};

const ACCESS_TOKEN_KEY = "vem.admin.accessToken";
const REFRESH_TOKEN_KEY = "vem.admin.refreshToken";

export const tokenStorage = {
  getAccessToken: (): string | null => localStorage.getItem(ACCESS_TOKEN_KEY),
  getRefreshToken: (): string | null => localStorage.getItem(REFRESH_TOKEN_KEY),
  setTokens(accessToken: string, refreshToken?: string): void {
    localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
    if (refreshToken) localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  },
  clear(): void {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  },
};

const authRequest = axios.create({
  baseURL: "/api",
  timeout: 15_000,
});

export const request = axios.create({
  baseURL: "/api",
  timeout: 15_000,
});

let refreshingPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  if (refreshingPromise) return await refreshingPromise;

  const refreshToken = tokenStorage.getRefreshToken();
  if (!refreshToken) throw new Error("refresh token missing");

  refreshingPromise = authRequest
    .post<ApiResponse<RefreshTokenResponse>>("/auth/refresh", { refreshToken })
    .then((response) => {
      const tokens = response.data.data;
      tokenStorage.setTokens(tokens.accessToken, tokens.refreshToken);
      return tokens.accessToken;
    })
    .finally(() => {
      refreshingPromise = null;
    });

  return await refreshingPromise;
}

function dispatchError(content: string): void {
  window.dispatchEvent(
    new CustomEvent("vem:message", { detail: { type: "error", content } }),
  );
}

request.interceptors.request.use((config) => {
  const token = tokenStorage.getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

request.interceptors.response.use(
  undefined,
  async (error: AxiosError<ApiResponse<unknown>>) => {
    const originalConfig = error.config as RetryableRequestConfig | undefined;

    if (error.response?.status === 401) {
      const hasRefreshToken = Boolean(tokenStorage.getRefreshToken());
      if (hasRefreshToken && originalConfig && !originalConfig._retry) {
        originalConfig._retry = true;
        try {
          const nextAccessToken = await refreshAccessToken();
          originalConfig.headers = Object.assign({}, originalConfig.headers, {
            Authorization: `Bearer ${nextAccessToken}`,
          });
          return await request(originalConfig);
        } catch {
          tokenStorage.clear();
        }
      } else {
        tokenStorage.clear();
      }

      if (location.pathname !== "/login") {
        const redirect = encodeURIComponent(
          location.pathname + location.search,
        );
        location.assign(`/login?redirect=${redirect}`);
      }
    } else if (error.response?.status === 403) {
      window.dispatchEvent(
        new CustomEvent("vem:message", {
          detail: { type: "warning", content: "\u6ca1\u6709\u6743\u9650\u8bbf\u95ee\u8be5\u8d44\u6e90" },
        }),
      );
    } else {
      dispatchError(error.response?.data?.message ?? error.message);
    }
    return Promise.reject(error);
  },
);

async function unwrap<T>(
  responsePromise: Promise<AxiosResponse<ApiResponse<T>>>,
): Promise<T> {
  const response = await responsePromise;
  const body = response.data;
  if (body.code !== 0) {
    dispatchError(body.message || "\u8bf7\u6c42\u5931\u8d25");
    throw new Error(body.message || "\u8bf7\u6c42\u5931\u8d25");
  }
  return body.data;
}

export async function get<T>(
  url: string,
  config?: AxiosRequestConfig,
): Promise<T> {
  return await unwrap(request.get<ApiResponse<T>>(url, config));
}

export async function post<T, TBody = unknown>(
  url: string,
  body?: TBody,
  config?: AxiosRequestConfig,
): Promise<T> {
  return await unwrap(request.post<ApiResponse<T>>(url, body, config));
}

export async function patch<T, TBody = unknown>(
  url: string,
  body?: TBody,
  config?: AxiosRequestConfig,
): Promise<T> {
  return await unwrap(request.patch<ApiResponse<T>>(url, body, config));
}
