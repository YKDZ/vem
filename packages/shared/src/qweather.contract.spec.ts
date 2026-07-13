import { describe, expect, it } from "vitest";

import {
  qweatherConfigResponseSchema,
  updateQweatherConfigSchema,
} from "./schemas/qweather";

describe("和风天气后台契约", () => {
  it("接受账户专属 Host 和 JWT 配置", () => {
    expect(
      updateQweatherConfigSchema.parse({
        enabled: true,
        apiHost: "abcxyz.qweatherapi.com",
        jwtKeyId: "key-id",
        jwtProjectId: "project-id",
        privateKey: "private-key",
        weatherNowPath: "/v7/weather/now",
        sunPath: "/v7/astronomy/sun",
        timeoutMs: 3000,
      }),
    ).toMatchObject({ apiHost: "abcxyz.qweatherapi.com" });
  });

  it("拒绝共享旧 Host", () => {
    expect(() =>
      updateQweatherConfigSchema.parse({
        enabled: true,
        apiHost: "api.qweather.com",
        jwtKeyId: "key-id",
        jwtProjectId: "project-id",
        weatherNowPath: "/v7/weather/now",
        sunPath: "/v7/astronomy/sun",
        timeoutMs: 3000,
      }),
    ).toThrow("必须填写账户专属 API Host");
  });

  it("响应不包含私钥正文", () => {
    const result = qweatherConfigResponseSchema.parse({
      source: "database",
      enabled: true,
      apiHost: "abcxyz.qweatherapi.com",
      jwtKeyId: "key-id",
      jwtProjectId: "project-id",
      privateKeyConfigured: true,
      weatherNowPath: "/v7/weather/now",
      sunPath: "/v7/astronomy/sun",
      timeoutMs: 3000,
      updatedAt: "2026-07-13T00:00:00.000Z",
    });
    expect(result).not.toHaveProperty("privateKey");
  });
});
