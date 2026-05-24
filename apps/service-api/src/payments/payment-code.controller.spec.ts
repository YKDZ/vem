import { describe, expect, it, vi } from "vitest";

import { PaymentCodeController } from "./payment-code.controller";

describe("PaymentCodeController", () => {
  it("returns payment code attempts list without exposing authCodeHash fields", async () => {
    const attempts = {
      listAttempts: vi.fn().mockResolvedValue({
        items: [
          {
            id: "attempt-1",
            orderNo: "ORD001",
            paymentNo: "PAY001",
            providerCode: "alipay",
            attemptNo: 1,
            providerPaymentNo: "PCA001",
            status: "querying",
            authCodeMasked: "2876****4394",
            source: "tauri_scanner",
            failureCode: null,
            failureMessage: null,
            manualReason: null,
            submittedAt: null,
            lastCheckedAt: null,
            reversedAt: null,
            finishedAt: null,
            createdAt: new Date().toISOString(),
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      }),
    };
    const orchestrator = {
      manualQuery: vi.fn(),
      manualReverse: vi.fn(),
    };
    const controller = new PaymentCodeController(
      attempts as never,
      orchestrator as never,
    );

    const result = await controller.listAttempts({
      page: 1,
      pageSize: 20,
    });

    expect(JSON.stringify(result)).toContain("authCodeMasked");
    expect(JSON.stringify(result)).not.toContain("authCodeHash");
    expect(JSON.stringify(result)).not.toContain("28763443825664394");
  });

  it("passes manual reverse reason through to the orchestrator", async () => {
    const attempts = {
      listAttempts: vi.fn(),
    };
    const orchestrator = {
      manualQuery: vi.fn(),
      manualReverse: vi.fn().mockResolvedValue({ id: "attempt-1" }),
    };
    const controller = new PaymentCodeController(
      attempts as never,
      orchestrator as never,
    );

    await controller.reverseAttempt("550e8400-e29b-41d4-a716-446655440000", {
      reason: "admin_manual_reverse",
    });

    expect(orchestrator.manualReverse).toHaveBeenCalledWith(
      "550e8400-e29b-41d4-a716-446655440000",
      "admin_manual_reverse",
    );
  });
});
