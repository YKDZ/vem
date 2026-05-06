import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";

import {
  clearMachineAuthToken,
  getMachineAuthToken,
} from "./machine-auth-session";

export type ApiResponse<T> = {
  code: number;
  message: string;
  data: T;
};

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly code?: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

export function unwrapApiResponse<T>(
  response: AxiosResponse<ApiResponse<T>>,
): T {
  const body = response.data;
  if (body.code !== 0) {
    throw new ApiRequestError(
      body.message || "请求失败",
      response.status,
      body.code,
    );
  }
  return body.data;
}

export type MachineApiClient = {
  get<T>(url: string, config?: AxiosRequestConfig): Promise<T>;
  post<T, TBody = unknown>(
    url: string,
    body?: TBody,
    config?: AxiosRequestConfig,
  ): Promise<T>;
};

export type MachineTokenRefresher = () => Promise<string | null>;
let machineTokenRefresher: MachineTokenRefresher | null = null;

export function setMachineTokenRefresher(
  refresher: MachineTokenRefresher | null,
): void {
  machineTokenRefresher = refresher;
}

export type MachineApiClientOptions = {
  skipAuthRetry?: boolean;
  adapter?: AxiosRequestConfig["adapter"];
};

function normalizeBaseUrl(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "");
}

export function createMachineApiClient(
  baseURL: string,
  options: MachineApiClientOptions = {},
): MachineApiClient {
  const request: AxiosInstance = axios.create({
    baseURL: normalizeBaseUrl(baseURL),
    timeout: 15_000,
    adapter: options.adapter,
  });

  request.interceptors.request.use((config) => {
    const token = getMachineAuthToken({ allowRefreshWindow: true });
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  });

  request.interceptors.response.use(
    (response) => response,
    async (error: AxiosError<ApiResponse<unknown>>) => {
      const originalConfig = error.config as
        | (AxiosRequestConfig & { _machineRetry?: boolean })
        | undefined;
      if (
        error.response?.status === 401 &&
        !options.skipAuthRetry &&
        !originalConfig?._machineRetry &&
        machineTokenRefresher
      ) {
        try {
          const token = await machineTokenRefresher();
          if (!token || !originalConfig) {
            clearMachineAuthToken();
            throw new ApiRequestError(
              "Machine token refresh returned empty",
              401,
            );
          }
          originalConfig._machineRetry = true;
          originalConfig.headers = Object.assign({}, originalConfig.headers, {
            Authorization: `Bearer ${token}`,
          });
          return await request.request(originalConfig);
        } catch (refreshError) {
          clearMachineAuthToken();
          throw new ApiRequestError(
            refreshError instanceof Error
              ? refreshError.message
              : "Machine token refresh failed",
            401,
          );
        }
      }
      const message = error.response?.data?.message ?? error.message;
      throw new ApiRequestError(
        message || "网络请求失败",
        error.response?.status,
        error.response?.data?.code,
      );
    },
  );

  return {
    async get<T>(url: string, config?: AxiosRequestConfig) {
      return unwrapApiResponse(await request.get<ApiResponse<T>>(url, config));
    },
    async post<T, TBody = unknown>(
      url: string,
      body?: TBody,
      config?: AxiosRequestConfig,
    ) {
      return unwrapApiResponse(
        await request.post<
          ApiResponse<T>,
          AxiosResponse<ApiResponse<T>>,
          TBody
        >(url, body, config),
      );
    },
  };
}
