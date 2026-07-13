import { describe, expect, it, vi } from "vitest";

import { QweatherConfigService } from "./qweather-config.service";

const environment = {
  qweatherApiHost: "account.qweatherapi.com",
  qweatherJwtKeyId: "env-key-id",
  qweatherJwtProjectId: "env-project-id",
  qweatherJwtPrivateKey: "env-private-key",
  qweatherJwtPrivateKeyPath: undefined,
  qweatherWeatherNowPath: "/v7/weather/now",
  qweatherSunPath: "/v7/astronomy/sun",
  qweatherTimeoutMs: 3000,
  paymentConfigEncryptionKey: "test-encryption-key",
};

function selectRows(rows: unknown[]) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => rows }),
      }),
    }),
  };
}

describe("QweatherConfigService", () => {
  it("在后台尚未保存时展示并使用部署环境配置", async () => {
    const service = new QweatherConfigService(
      selectRows([]) as never,
      environment as never,
      { record: vi.fn() } as never,
    );

    await expect(service.getAdminConfig()).resolves.toMatchObject({
      source: "environment",
      enabled: true,
      apiHost: "account.qweatherapi.com",
      privateKeyConfigured: true,
    });
    await expect(service.resolveRuntimeConfig()).resolves.toMatchObject({
      jwtPrivateKey: "env-private-key",
      jwtKeyId: "env-key-id",
    });
  });

  it("后台禁用后不会回退启用部署环境凭据", async () => {
    const service = new QweatherConfigService(
      selectRows([
        {
          id: "550e8400-e29b-41d4-a716-446655440000",
          providerCode: "qweather",
          enabled: false,
          apiHost: "account.qweatherapi.com",
          jwtKeyId: "db-key-id",
          jwtProjectId: "db-project-id",
          privateKeyEncryptedJson: null,
          weatherNowPath: "/v7/weather/now",
          sunPath: "/v7/astronomy/sun",
          timeoutMs: 2500,
          updatedByAdminUserId: null,
          createdAt: new Date("2026-07-13T00:00:00.000Z"),
          updatedAt: new Date("2026-07-13T00:00:00.000Z"),
        },
      ]) as never,
      environment as never,
      { record: vi.fn() } as never,
    );

    await expect(service.resolveRuntimeConfig()).resolves.toEqual({
      weatherNowPath: "/v7/weather/now",
      sunPath: "/v7/astronomy/sun",
      timeoutMs: 2500,
    });
  });
});
