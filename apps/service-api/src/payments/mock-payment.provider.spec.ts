import { describe, expect, it } from "vitest";

import type { AppConfigService } from "../config/app-config.service";

import { MockPaymentProvider } from "./mock-payment.provider";

describe("MockPaymentProvider", () => {
  it("creates deterministic mock payment intent", async () => {
    const provider = new MockPaymentProvider({
      paymentWebhookBaseUrl: "http://localhost:3000/api/payments/webhooks",
    } as unknown as AppConfigService);

    const result = await provider.createPaymentIntent({
      paymentNo: "PAY20260504000001AAAA0001",
      orderNo: "ORD20260504000001AAAA0001",
      amountCents: 199,
      expiresAt: new Date("2026-05-04T00:15:00.000Z"),
    });

    expect(result.providerTradeNo).toBe("MOCK-PAY20260504000001AAAA0001");
    expect(result.paymentUrl).toContain(
      "/payments/mock/PAY20260504000001AAAA0001",
    );
  });
});
