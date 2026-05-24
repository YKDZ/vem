import { describe, expect, it, vi } from "vitest";

import { PaymentOpsController } from "./payment-ops.controller";
import { PaymentOpsService } from "./payment-ops.service";

const makeService = () =>
  ({
    getReadiness: vi.fn(),
    getMetrics: vi.fn(),
    getMachinePreflight: vi.fn(),
  }) as unknown as PaymentOpsService;

const makeController = (service: PaymentOpsService) =>
  new PaymentOpsController(service);

describe("PaymentOpsController", () => {
  describe("getReadiness", () => {
    it("delegates to service.getReadiness() and returns result", async () => {
      const service = makeService();
      const expected = {
        status: "ready" as const,
        checkedAt: new Date().toISOString(),
        environment: "development" as const,
        checks: [],
      };
      vi.mocked(service.getReadiness).mockResolvedValue(expected);

      const controller = makeController(service);
      const result = await controller.getReadiness();

      expect(service.getReadiness).toHaveBeenCalledOnce();
      expect(result).toEqual(expected);
    });
  });

  describe("getMetrics", () => {
    it("passes windowMinutes from query to service.getMetrics()", async () => {
      const service = makeService();
      const expected = {
        measuredAt: new Date().toISOString(),
        windowMinutes: 30,
        paymentFailureRate: 0.2,
        paymentFailedCount: 1,
        paymentTotalCount: 5,
        webhookSignatureInvalidCount: 0,
        webhookBusinessInvalidCount: 0,
        reconciliationErrorCount: 0,
        refundFailedCount: 0,
        refundProcessingOverdueCount: 0,
        certificateExpiringCount: 0,
        paymentCodeUnknownCount: 0,
        paymentCodeReverseFailedCount: 0,
        paymentCodeDuplicateRejectedCount: 0,
        scannerOfflineMachineCount: 0,
      };
      vi.mocked(service.getMetrics).mockResolvedValue(expected);

      const controller = makeController(service);
      const result = await controller.getMetrics({ windowMinutes: 30 });

      expect(service.getMetrics).toHaveBeenCalledWith(30);
      expect(result).toEqual(expected);
    });

    it("passes undefined windowMinutes when query omitted", async () => {
      const service = makeService();
      vi.mocked(service.getMetrics).mockResolvedValue({
        measuredAt: new Date().toISOString(),
        windowMinutes: 60,
        paymentFailureRate: 0,
        paymentFailedCount: 0,
        paymentTotalCount: 0,
        webhookSignatureInvalidCount: 0,
        webhookBusinessInvalidCount: 0,
        reconciliationErrorCount: 0,
        refundFailedCount: 0,
        refundProcessingOverdueCount: 0,
        certificateExpiringCount: 0,
        paymentCodeUnknownCount: 0,
        paymentCodeReverseFailedCount: 0,
        paymentCodeDuplicateRejectedCount: 0,
        scannerOfflineMachineCount: 0,
      });

      const controller = makeController(service);
      await controller.getMetrics({});

      expect(service.getMetrics).toHaveBeenCalledWith(undefined);
    });
  });

  describe("getMachinePreflight", () => {
    it("passes machineId to service.getMachinePreflight() and returns result", async () => {
      const service = makeService();
      const machineId = "550e8400-e29b-41d4-a716-446655440000";
      const expected = {
        machineId,
        machineCode: "M-001",
        status: "blocked" as const,
        availableProviders: [],
        checks: [],
        checkedAt: new Date().toISOString(),
      };
      vi.mocked(service.getMachinePreflight).mockResolvedValue(expected);

      const controller = makeController(service);
      const result = await controller.getMachinePreflight(machineId);

      expect(service.getMachinePreflight).toHaveBeenCalledWith(machineId);
      expect(result).toEqual(expected);
    });
  });
});
