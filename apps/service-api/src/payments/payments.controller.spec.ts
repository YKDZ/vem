import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PaymentsService } from "./payments.service";

import { PaymentsController } from "./payments.controller";

function makeRes() {
  return {
    type: vi.fn().mockReturnThis(),
  };
}

describe("PaymentsController", () => {
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
      const controller = new PaymentsController(
        paymentsService as unknown as PaymentsService,
      );

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

  describe("handleWebhook", () => {
    let controller: PaymentsController;
    let paymentsService: Pick<PaymentsService, "handleProviderWebhook">;

    beforeEach(() => {
      paymentsService = {
        handleProviderWebhook: vi.fn(),
      };
      controller = new PaymentsController(
        paymentsService as unknown as PaymentsService,
      );
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
});
