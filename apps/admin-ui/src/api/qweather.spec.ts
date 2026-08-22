import {
  adminGetQweatherConfigContract,
  adminUpdateQweatherConfigContract,
} from "@vem/shared";
import { describe, expect, it, vi } from "vitest";

import { callAdminEndpointContract } from "@/api/request";

import { getQweatherConfig, updateQweatherConfig } from "./qweather";

vi.mock("@/api/request", () => ({
  callAdminEndpointContract: vi.fn().mockResolvedValue({}),
}));

describe("和风天气后台接口", () => {
  it("使用完整共享端点契约读取和保存配置", async () => {
    await getQweatherConfig();
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminGetQweatherConfigContract,
      {},
    );

    const body = {
      enabled: true,
      apiHost: "abcxyz.qweatherapi.com",
      jwtKeyId: "key-id",
      jwtProjectId: "project-id",
      weatherNowPath: "/v7/weather/now",
      sunPath: "/v7/astronomy/sun",
      timeoutMs: 3000,
    };
    await updateQweatherConfig(body);
    expect(callAdminEndpointContract).toHaveBeenCalledWith(
      adminUpdateQweatherConfigContract,
      { body },
    );
  });
});
