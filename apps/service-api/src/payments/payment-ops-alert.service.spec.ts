import type { PaymentOpsMetrics, PaymentOpsReadiness } from "@vem/shared";

import { describe, expect, it, vi } from "vitest";

import type { NotificationsService } from "../notifications/notifications.service";
import type { PaymentOpsService } from "./payment-ops.service";

import { PaymentOpsAlertService } from "./payment-ops-alert.service";

function makeReadiness(
  overrides: Partial<PaymentOpsReadiness> = {},
): PaymentOpsReadiness {
  return {
    status: "ready",
    checkedAt: new Date().toISOString(),
    environment: "development",
    providerEnvironment: {
      environment: "unavailable",
      readiness: "blocked",
      errorCategory: "provider_unconfigured",
    },
    checks: [],
    ...overrides,
  };
}

function makeMetrics(
  overrides: Partial<PaymentOpsMetrics> = {},
): PaymentOpsMetrics {
  return {
    measuredAt: "2026-05-06T15:30:00.000Z",
    windowMinutes: 60,
    paymentFailureRate: 0,
    paymentFailedCount: 0,
    paymentTotalCount: 10,
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
    ...overrides,
  };
}

function makeService() {
  const txFn = vi.fn();
  const db = {
    transaction: vi
      .fn()
      .mockImplementation(async (fn: (tx: object) => Promise<void>) => {
        await fn({});
      }),
  };

  const ops = {
    getReadiness: vi.fn(),
    getMetrics: vi.fn(),
  } as unknown as PaymentOpsService;

  const notificationsService = {
    createOperationalNotification: vi.fn().mockResolvedValue(undefined),
  } as unknown as NotificationsService;

  const service = new PaymentOpsAlertService(
    db as never,
    ops,
    notificationsService,
  );

  return { service, db, ops, notificationsService, txFn };
}

describe("PaymentOpsAlertService", () => {
  describe("scan", () => {
    it("writes payment_provider_unready notification for failed critical checks", async () => {
      const { service, ops, notificationsService } = makeService();
      vi.mocked(ops.getReadiness).mockResolvedValue(
        makeReadiness({
          status: "blocked",
          checks: [
            {
              code: "mock_provider_disabled",
              severity: "critical",
              passed: false,
              message: "Mock provider is enabled",
              evidence: {},
            },
          ],
        }),
      );
      vi.mocked(ops.getMetrics).mockResolvedValue(makeMetrics());

      await service.scan();

      expect(
        notificationsService.createOperationalNotification,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          type: "payment_provider_unready",
          dedupeKey: "payment_ops_check:mock_provider_disabled",
        }),
      );
    });

    it("writes payment_webhook_invalid when webhookSignatureInvalidCount > 0", async () => {
      const { service, ops, notificationsService } = makeService();
      vi.mocked(ops.getReadiness).mockResolvedValue(makeReadiness());
      vi.mocked(ops.getMetrics).mockResolvedValue(
        makeMetrics({ webhookSignatureInvalidCount: 3 }),
      );

      await service.scan();

      expect(
        notificationsService.createOperationalNotification,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: "payment_webhook_invalid" }),
      );
    });

    it("writes payment_reconciliation_failed when reconciliationErrorCount > 0", async () => {
      const { service, ops, notificationsService } = makeService();
      vi.mocked(ops.getReadiness).mockResolvedValue(makeReadiness());
      vi.mocked(ops.getMetrics).mockResolvedValue(
        makeMetrics({ reconciliationErrorCount: 2 }),
      );

      await service.scan();

      expect(
        notificationsService.createOperationalNotification,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: "payment_reconciliation_failed" }),
      );
    });

    it("writes payment_refund_failed when refundFailedCount > 0", async () => {
      const { service, ops, notificationsService } = makeService();
      vi.mocked(ops.getReadiness).mockResolvedValue(makeReadiness());
      vi.mocked(ops.getMetrics).mockResolvedValue(
        makeMetrics({ refundFailedCount: 1 }),
      );

      await service.scan();

      expect(
        notificationsService.createOperationalNotification,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: "payment_refund_failed" }),
      );
    });

    it("writes payment_certificate_expiring when certificateExpiringCount > 0", async () => {
      const { service, ops, notificationsService } = makeService();
      vi.mocked(ops.getReadiness).mockResolvedValue(makeReadiness());
      vi.mocked(ops.getMetrics).mockResolvedValue(
        makeMetrics({ certificateExpiringCount: 1 }),
      );

      await service.scan();

      expect(
        notificationsService.createOperationalNotification,
      ).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ type: "payment_certificate_expiring" }),
      );
    });

    it("does not write notifications when all metrics are zero and checks pass", async () => {
      const { service, ops, notificationsService } = makeService();
      vi.mocked(ops.getReadiness).mockResolvedValue(makeReadiness());
      vi.mocked(ops.getMetrics).mockResolvedValue(makeMetrics());

      await service.scan();

      expect(
        notificationsService.createOperationalNotification,
      ).not.toHaveBeenCalled();
    });
  });

  describe("PaymentOpsAlertService lifecycle", () => {
    it("clears timer on onApplicationShutdown", () => {
      const { service } = makeService();
      const clearIntervalSpy = vi.spyOn(global, "clearInterval");

      service.onModuleInit();
      service.onApplicationShutdown();

      expect(clearIntervalSpy).toHaveBeenCalledOnce();
      clearIntervalSpy.mockRestore();
    });
  });
});
