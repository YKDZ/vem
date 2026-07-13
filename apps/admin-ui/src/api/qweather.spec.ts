import { describe, expect, it, vi } from "vitest";

import { getContract, putContract } from "@/api/request";

import { getQweatherConfig, updateQweatherConfig } from "./qweather";

vi.mock("@/api/request", () => ({
  getContract: vi.fn().mockResolvedValue({}),
  putContract: vi.fn().mockResolvedValue({}),
}));

describe("和风天气后台接口", () => {
  it("使用契约绑定的读取和保存接口", async () => {
    await getQweatherConfig();
    expect(getContract).toHaveBeenCalledWith(
      "/qweather-config",
      expect.any(Object),
      expect.any(Object),
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
    expect(putContract).toHaveBeenCalledWith(
      "/qweather-config",
      expect.any(Object),
      expect.any(Object),
      body,
    );
  });
});
