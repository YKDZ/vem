import { describe, expect, it } from "vitest";

import type { AppConfigService } from "../config/app-config.service";

import { MockPaymentProvider } from "./mock-payment.provider";

describe("MockPaymentProvider", () => {
  it("creates deterministic mock payment intent", async () => {
    const provider = new MockPaymentProvider({
      paymentWebhookBaseUrl: "http://localhost:3000/api/payments/webhooks",
      paymentMockEnabled: true,
      buildMockPaymentCompletionUrl: (paymentNo: string) =>
        `http://localhost:3000/api/payments/mock/${paymentNo}/complete`,
    } as unknown as AppConfigService);

    const result = await provider.createPaymentIntent({
      paymentNo: "PAY20260504000001AAAA0001",
      orderNo: "ORD20260504000001AAAA0001",
      amountCents: 199,
      expiresAt: new Date("2026-05-04T00:15:00.000Z"),
      config: {
        providerCode: "mock",
        merchantNo: null,
        appId: null,
        publicConfigJson: {},
        sensitiveConfigJson: {},
      },
    });

    expect(result.providerTradeNo).toBe("MOCK-PAY20260504000001AAAA0001");
    expect(result.paymentUrl).toBe(
      "http://localhost:3000/api/payments/mock/PAY20260504000001AAAA0001/complete",
    );
  });

  it("does not advertise an unfinishable intent when the test provider is disabled", async () => {
    const provider = new MockPaymentProvider({
      paymentWebhookBaseUrl: "http://localhost:3000/api/payments/webhooks",
      paymentMockEnabled: false,
      buildMockPaymentCompletionUrl: (paymentNo: string) =>
        `http://localhost:3000/api/payments/mock/${paymentNo}/complete`,
    } as unknown as AppConfigService);

    await expect(
      provider.createPaymentIntent({
        paymentNo: "PAY20260504000001AAAA0002",
        orderNo: "ORD20260504000001AAAA0002",
        amountCents: 199,
        expiresAt: new Date("2026-05-04T00:15:00.000Z"),
        config: {
          providerCode: "mock",
          merchantNo: null,
          appId: null,
          publicConfigJson: {},
          sensitiveConfigJson: {},
        },
      }),
    ).rejects.toThrow("mock payment provider is disabled");
  });

  it("reconciles a scanned payment code through the provider trade state", async () => {
    const provider = new MockPaymentProvider({
      paymentMockEnabled: true,
      paymentWebhookBaseUrl: "http://localhost:3000/api/payments/webhooks",
    } as unknown as AppConfigService);
    const config = {
      providerCode: "mock",
      merchantNo: null,
      appId: null,
      publicConfigJson: {},
      sensitiveConfigJson: {},
    };

    const charge = await provider.chargePaymentCode({
      paymentNo: "PAY-CODE-001",
      orderNo: "ORD-CODE-001",
      amountCents: 199,
      authCode: "28763443825664394",
      terminalId: null,
      storeId: null,
      clientIp: "127.0.0.1",
      config,
    });
    const query = await provider.queryPaymentCode({
      paymentNo: "PAY-CODE-001",
      providerTradeNo: charge.providerTradeNo,
      config,
    });
    const missing = await provider.queryPaymentCode({
      paymentNo: "PAY-CODE-MISSING",
      providerTradeNo: "MOCK-CODE-PAY-CODE-MISSING",
      config,
    });

    expect(charge.status).toBe("succeeded");
    expect(query).toMatchObject({
      status: "succeeded",
      providerTradeNo: charge.providerTradeNo,
    });
    expect(missing.status).toBe("unknown");
  });
});
