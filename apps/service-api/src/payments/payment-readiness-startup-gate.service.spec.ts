import { describe, expect, it, vi } from "vitest";

import { PaymentReadinessStartupGateService } from "./payment-readiness-startup-gate.service";

describe("PaymentReadinessStartupGateService", () => {
  it("does nothing when readiness gate is not required", async () => {
    const ops = { getReadiness: vi.fn() };
    const service = new PaymentReadinessStartupGateService(
      { paymentProductionReadinessRequired: false } as never,
      ops as never,
    );
    await service.onModuleInit();
    expect(ops.getReadiness).not.toHaveBeenCalled();
  });

  it("does nothing when readiness is ready", async () => {
    const ops = {
      getReadiness: vi.fn().mockResolvedValue({
        status: "ready",
        checks: [],
      }),
    };
    const service = new PaymentReadinessStartupGateService(
      { paymentProductionReadinessRequired: true } as never,
      ops as never,
    );
    await service.onModuleInit();
    expect(ops.getReadiness).toHaveBeenCalled();
  });

  it("throws when required readiness is blocked", async () => {
    const service = new PaymentReadinessStartupGateService(
      { paymentProductionReadinessRequired: true } as never,
      {
        getReadiness: vi.fn().mockResolvedValue({
          status: "blocked",
          checks: [
            {
              code: "real_provider_config_present",
              severity: "critical",
              passed: false,
            },
          ],
        }),
      } as never,
    );
    await expect(service.onModuleInit()).rejects.toThrow(
      "Payment production readiness gate blocked startup: real_provider_config_present",
    );
  });
});
