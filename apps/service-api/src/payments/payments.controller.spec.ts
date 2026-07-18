import {
  paymentIncidentActionRequestSchema,
  paymentOperatorReasonSchema,
} from "@vem/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PaymentsService } from "./payments.service";

import { REQUIRED_PERMISSIONS_KEY } from "../access/permissions.decorator";
import { IS_PUBLIC_KEY } from "../auth/public.decorator";
import { PaymentChannelPolicyService } from "./payment-channel-policy.service";
import { PaymentsController } from "./payments.controller";

function makeRes() {
  return {
    type: vi.fn().mockReturnThis(),
  };
}

function makeController(paymentsService: Partial<PaymentsService>) {
  return new PaymentsController(
    paymentsService as unknown as PaymentsService,
    {} as unknown as PaymentChannelPolicyService,
  );
}

describe("PaymentsController", () => {
  describe("operator reason validation", () => {
    it("rejects whitespace-only manual reconcile reasons", () => {
      expect(() =>
        paymentOperatorReasonSchema.parse({ reason: "   " }),
      ).toThrow();
    });

    it("rejects whitespace-only refund query reasons", () => {
      expect(() =>
        paymentOperatorReasonSchema.parse({ reason: "\n\t" }),
      ).toThrow();
    });

    it("validates strict payment incident action bodies", () => {
      expect(
        paymentIncidentActionRequestSchema.parse({
          action: "query_payment",
          reason: "operator checks uncertain payment",
        }),
      ).toMatchObject({ action: "query_payment" });
      expect(() =>
        paymentIncidentActionRequestSchema.parse({
          action: "query_payment",
          reason: "operator checks uncertain payment",
          rawPayload: {},
        }),
      ).toThrow();
    });
  });

  describe("paymentIncidentAction", () => {
    it("passes payment id, admin id, and action to handlePaymentIncidentAction()", async () => {
      const result = {
        action: "mark_manual_handling" as const,
        status: "manual_handling",
        handled: true,
        message: "已标记人工处理",
        protectedDiagnostics: {},
      };
      const paymentsService = {
        handlePaymentIncidentAction: vi.fn().mockResolvedValue(result),
      };
      const controller = makeController(paymentsService);
      const admin = {
        id: "admin-001",
      } as import("../common/request-user").AuthenticatedAdmin;
      const body = {
        action: "mark_manual_handling" as const,
        reason: "provider result cannot be resolved automatically",
      };

      await expect(
        controller.paymentIncidentAction(
          admin,
          "550e8400-e29b-41d4-a716-446655440000",
          body,
        ),
      ).resolves.toBe(result);
      expect(paymentsService.handlePaymentIncidentAction).toHaveBeenCalledWith(
        "550e8400-e29b-41d4-a716-446655440000",
        "admin-001",
        body,
      );
    });
  });

  describe("listReconciliationAttempts", () => {
    it("forwards machine_status_poll trigger filters", async () => {
      const result = {
        items: [],
        page: 1,
        pageSize: 20,
        total: 0,
      };
      const paymentsService = {
        listReconciliationAttempts: vi.fn().mockResolvedValue(result),
      };
      const controller = makeController(paymentsService);

      await expect(
        controller.listReconciliationAttempts({
          page: 1,
          pageSize: 20,
          trigger: "machine_status_poll",
        }),
      ).resolves.toBe(result);
      expect(paymentsService.listReconciliationAttempts).toHaveBeenCalledWith({
        page: 1,
        pageSize: 20,
        trigger: "machine_status_poll",
      });
    });
  });

  describe("queryRefund", () => {
    it("passes refund id, admin id, and reason to manualReconcileRefund()", async () => {
      const result = {
        status: "succeeded" as const,
        reconciled: true,
      };
      const paymentsService = {
        manualReconcileRefund: vi.fn().mockResolvedValue(result),
      };
      const controller = makeController(paymentsService);
      const admin = {
        id: "admin-001",
      } as import("../common/request-user").AuthenticatedAdmin;

      await expect(
        controller.queryRefund(admin, "550e8400-e29b-41d4-a716-446655440000", {
          reason: "customer refund status check",
        }),
      ).resolves.toBe(result);
      expect(paymentsService.manualReconcileRefund).toHaveBeenCalledWith(
        "550e8400-e29b-41d4-a716-446655440000",
        "admin-001",
        "customer refund status check",
      );
    });
  });

  describe("manualReconcile", () => {
    it("passes payment id, admin id, and reason to manualReconcile()", async () => {
      const result = {
        status: "succeeded" as const,
        reconciled: true,
      };
      const paymentsService = {
        manualReconcile: vi.fn().mockResolvedValue(result),
      };
      const controller = makeController(paymentsService);
      const admin = {
        id: "admin-001",
      } as import("../common/request-user").AuthenticatedAdmin;

      await expect(
        controller.manualReconcile(
          admin,
          "550e8400-e29b-41d4-a716-446655440000",
          { reason: "customer sees paid but platform is pending" },
        ),
      ).resolves.toBe(result);
      expect(paymentsService.manualReconcile).toHaveBeenCalledWith(
        "550e8400-e29b-41d4-a716-446655440000",
        "admin-001",
        "customer sees paid but platform is pending",
      );
    });
  });

  describe("payment channel policy", () => {
    it("allows payment policy reads with payments.read while writes require payments.configure", () => {
      expect(
        Reflect.getMetadata(
          REQUIRED_PERMISSIONS_KEY,
          PaymentsController.prototype.getChannelPolicy,
        ),
      ).toEqual(["payments.read"]);
      expect(
        Reflect.getMetadata(
          REQUIRED_PERMISSIONS_KEY,
          PaymentsController.prototype.updateChannelPolicy,
        ),
      ).toEqual(["payments.configure"]);
    });

    it("reads and updates global payment channel policy through the policy service", async () => {
      const policy = {
        channels: [
          { channelKey: "qr_code:alipay" as const, enabled: true, rank: 1 },
          {
            channelKey: "payment_code:alipay" as const,
            enabled: true,
            rank: 2,
          },
          { channelKey: "qr_code:wechat_pay" as const, enabled: true, rank: 3 },
          {
            channelKey: "payment_code:wechat_pay" as const,
            enabled: false,
            rank: 4,
          },
        ],
        defaultChannelKey: "qr_code:alipay" as const,
        updatedAt: null,
        updatedByAdminUserId: null,
      };
      const paymentChannelPolicyService = {
        getPolicy: vi.fn().mockResolvedValue(policy),
        updatePolicy: vi.fn().mockResolvedValue(policy),
      };
      const controller = new PaymentsController(
        {} as unknown as PaymentsService,
        paymentChannelPolicyService as unknown as PaymentChannelPolicyService,
      );
      const admin = {
        id: "550e8400-e29b-41d4-a716-446655440010",
      } as import("../common/request-user").AuthenticatedAdmin;

      await expect(controller.getChannelPolicy()).resolves.toBe(policy);
      await expect(
        controller.updateChannelPolicy(admin, {
          channels: policy.channels,
          defaultChannelKey: policy.defaultChannelKey,
        }),
      ).resolves.toBe(policy);

      expect(paymentChannelPolicyService.getPolicy).toHaveBeenCalledOnce();
      expect(paymentChannelPolicyService.updatePolicy).toHaveBeenCalledWith(
        admin.id,
        {
          channels: policy.channels,
          defaultChannelKey: policy.defaultChannelKey,
        },
      );
    });
  });

  describe("handleWebhook", () => {
    let controller: PaymentsController;
    let paymentsService: Pick<PaymentsService, "handleProviderWebhook">;

    beforeEach(() => {
      paymentsService = {
        handleProviderWebhook: vi.fn(),
      };
      controller = makeController(paymentsService);
    });

    it("alipay handled → returns 'success' as plain text", async () => {
      vi.mocked(paymentsService.handleProviderWebhook).mockResolvedValueOnce({
        handled: true,
        duplicate: false,
      });
      const res = makeRes();
      const result = await controller.handleWebhook(
        "alipay",
        {},
        {},
        {
          rawBody: undefined,
          headers: {},
        } as unknown as import("express").Request & { rawBody?: Buffer },
        res as unknown as import("express").Response,
      );
      expect(res.type).toHaveBeenCalledWith("text/plain");
      expect(result).toBe("success");
    });

    it("alipay unhandled → returns 'fail' as plain text", async () => {
      vi.mocked(paymentsService.handleProviderWebhook).mockResolvedValueOnce({
        handled: false,
        reason: "payment_not_found",
      });
      const res = makeRes();
      const result = await controller.handleWebhook(
        "alipay",
        {},
        {},
        {
          rawBody: undefined,
          headers: {},
        } as unknown as import("express").Request & { rawBody?: Buffer },
        res as unknown as import("express").Response,
      );
      expect(res.type).toHaveBeenCalledWith("text/plain");
      expect(result).toBe("fail");
    });

    it("non-alipay provider → returns JSON result, no res.type call", async () => {
      const jsonResult = { handled: true, duplicate: false };
      vi.mocked(paymentsService.handleProviderWebhook).mockResolvedValueOnce(
        jsonResult,
      );
      const res = makeRes();
      const result = await controller.handleWebhook(
        "wechat",
        {},
        {},
        {
          rawBody: undefined,
          headers: {},
        } as unknown as import("express").Request & { rawBody?: Buffer },
        res as unknown as import("express").Response,
      );
      expect(res.type).not.toHaveBeenCalled();
      expect(result).toEqual(jsonResult);
    });
  });

  describe("completeMockPaymentFromProvider", () => {
    it("keeps test-provider checkout completion on the provider webhook boundary", async () => {
      const result = { handled: true, duplicate: false };
      const paymentsService = {
        completeMockPaymentFromProvider: vi.fn().mockResolvedValue(result),
      };
      const controller = makeController(paymentsService);

      await expect(
        controller.completeMockPaymentFromProvider("PAY-MOCK-001"),
      ).resolves.toBe(result);
      expect(
        paymentsService.completeMockPaymentFromProvider,
      ).toHaveBeenCalledWith("PAY-MOCK-001");
      expect(
        Reflect.getMetadata(
          IS_PUBLIC_KEY,
          PaymentsController.prototype.completeMockPaymentFromProvider,
        ),
      ).toBe(true);
    });
  });
});
