import { ConfigService } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { describe, expect, it, vi } from "vitest";

import { AppConfigService } from "./app-config.service";

const validPools = {
  MAINTENANCE_RELAY_ADDRESS_POOL: "10.91.0.0/24",
  MAINTENANCE_RUNNER_ADDRESS_POOL: "10.91.1.0/24",
  MAINTENANCE_MAINTAINER_ADDRESS_POOL: "10.91.3.0/24",
  MAINTENANCE_MACHINE_ADDRESS_POOL: "10.91.16.0/20",
};

function configServiceFor(values: Record<string, string>) {
  return {
    get: vi.fn((key: string) => values[key]),
  };
}

describe("ConfigModule maintenance address pools", () => {
  it("parses maintenance address pools once during provider startup and caches them", async () => {
    const configService = configServiceFor(validPools);
    const moduleRef = await Test.createTestingModule({
      providers: [
        AppConfigService,
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    const config = moduleRef.get(AppConfigService);
    expect(config.maintenanceAddressPools).toBe(config.maintenanceAddressPools);
    expect(configService.get).toHaveBeenCalledTimes(4);

    await moduleRef.close();
  });

  it("fails module startup before serving requests when maintenance pools overlap", async () => {
    const configService = configServiceFor({
      ...validPools,
      MAINTENANCE_RUNNER_ADDRESS_POOL: "10.91.0.0/25",
    });

    await expect(
      Test.createTestingModule({
        providers: [
          AppConfigService,
          { provide: ConfigService, useValue: configService },
        ],
      }).compile(),
    ).rejects.toThrow(
      "Maintenance address pools relay and runner must not overlap",
    );
  });
});
