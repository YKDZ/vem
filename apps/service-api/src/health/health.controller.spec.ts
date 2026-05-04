import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HealthService } from "./health.service";

import { HealthController } from "./health.controller";

describe("HealthController", () => {
  let controller: HealthController;

  beforeEach(() => {
    const healthService: Pick<HealthService, "getHealth"> = {
      getHealth: vi.fn().mockResolvedValue({
        database: "ok",
        mqtt: "connected",
      }),
    };
    controller = new HealthController(healthService as HealthService);
  });

  it("returns aggregated health status", async () => {
    await expect(controller.getHealth()).resolves.toEqual({
      database: "ok",
      mqtt: "connected",
    });
  });
});
