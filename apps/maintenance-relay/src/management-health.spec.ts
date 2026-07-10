import { describe, expect, it } from "vitest";

import { RelayManagementHealthServer } from "./management-health";

describe("relay management health", () => {
  it("binds only to loopback and reports explicitly insecure transport as degraded", async () => {
    const health = new RelayManagementHealthServer(
      {
        mode: "insecure-http",
        health: "degraded",
        reason: "Service API uses explicitly allowed insecure HTTP",
      },
      0,
    );
    await health.start();
    try {
      const response = await fetch(`${health.url}/healthz`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status: "degraded",
        transport: {
          mode: "insecure-http",
          health: "degraded",
          reason: "Service API uses explicitly allowed insecure HTTP",
        },
      });
      expect(health.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
    } finally {
      await health.stop();
    }
  });
});
