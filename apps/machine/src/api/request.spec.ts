import type { AxiosResponse } from "axios";

import { AxiosHeaders } from "axios";
import { describe, expect, it } from "vitest";

import {
  ApiRequestError,
  type ApiResponse,
  unwrapApiResponse,
} from "./request";

function mockResponse<T>(data: ApiResponse<T>): AxiosResponse<ApiResponse<T>> {
  return {
    status: 200,
    statusText: "OK",
    headers: {},
    config: { headers: new AxiosHeaders() },
    data,
  };
}

describe("machine api response unwrap", () => {
  it("returns data when code is zero", () => {
    expect(
      unwrapApiResponse(
        mockResponse({ code: 0, message: "ok", data: { ready: true } }),
      ),
    ).toEqual({ ready: true });
  });

  it("throws ApiRequestError when business code is non-zero", () => {
    expect(() =>
      unwrapApiResponse(
        mockResponse({ code: 1001, message: "machine disabled", data: null }),
      ),
    ).toThrow(ApiRequestError);
  });
});
