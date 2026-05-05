import axios, {
  AxiosError,
  type AxiosInstance,
  type AxiosRequestConfig,
  type AxiosResponse,
} from "axios";

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

function normalizeBaseUrl(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "");
}

export function createMachineApiClient(baseURL: string): MachineApiClient {
  const request: AxiosInstance = axios.create({
    baseURL: normalizeBaseUrl(baseURL),
    timeout: 15_000,
  });

  request.interceptors.response.use(
    (response) => response,
    (error: AxiosError<ApiResponse<unknown>>) => {
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
