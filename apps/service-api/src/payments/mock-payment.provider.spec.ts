import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AppConfigService } from "../config/app-config.service";
import type { MockPaymentCodeTradeStore } from "./mock-payment-code-trade.store";

import { MockPaymentProvider } from "./mock-payment.provider";
import { PaymentProviderRequestNotSentError } from "./payment-provider.interface";

function makeTradeStore() {
  let trade: Awaited<ReturnType<MockPaymentCodeTradeStore["find"]>> = null;
  return {
    acceptCharge: vi.fn(async (input) => {
      trade ??= {
        providerPaymentNo: input.providerPaymentNo,
        chargeIdempotencyKey: input.idempotencyKey,
        reversalIdempotencyKey: null,
        providerTradeNo: input.providerTradeNo,
        amountCents: input.amountCents,
        authCodeLength: input.authCodeLength,
        status: "succeeded",
        chargeAcceptedCount: 1,
        reversalAcceptedCount: 0,
        paidAt: new Date("2026-05-04T00:00:00.000Z"),
        reversedAt: null,
        createdAt: new Date("2026-05-04T00:00:00.000Z"),
        updatedAt: new Date("2026-05-04T00:00:00.000Z"),
      };
      return trade;
    }),
    find: vi.fn(async (paymentNo: string) =>
      trade?.providerPaymentNo === paymentNo ? trade : null,
    ),
    acceptReversal: vi.fn(async () => trade),
  } as unknown as MockPaymentCodeTradeStore;
}

describe("MockPaymentProvider", () => {
  it("creates deterministic mock payment intent", async () => {
    const provider = new MockPaymentProvider(
      {
        paymentWebhookBaseUrl: "http://localhost:3000/api/payments/webhooks",
        paymentMockEnabled: true,
        buildMockPaymentCompletionUrl: (paymentNo: string) =>
          `http://localhost:3000/api/payments/mock/${paymentNo}/complete`,
      } as unknown as AppConfigService,
      makeTradeStore(),
    );

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
    const provider = new MockPaymentProvider(
      {
        paymentWebhookBaseUrl: "http://localhost:3000/api/payments/webhooks",
        paymentMockEnabled: false,
        buildMockPaymentCompletionUrl: (paymentNo: string) =>
          `http://localhost:3000/api/payments/mock/${paymentNo}/complete`,
      } as unknown as AppConfigService,
      makeTradeStore(),
    );

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
    const provider = new MockPaymentProvider(
      {
        paymentMockEnabled: true,
        paymentMockProviderResponseDelayMs: 0,
        paymentWebhookBaseUrl: "http://localhost:3000/api/payments/webhooks",
      } as unknown as AppConfigService,
      makeTradeStore(),
    );
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

  it("holds mock createPaymentIntent at the explicit gate until the runner releases it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-mock-payment-gate-"));
    const gatePath = join(root, "create-gate.json");
    await writeFile(gatePath, `${JSON.stringify({ state: "hold" })}\n`, "utf8");
    const provider = new MockPaymentProvider(
      {
        paymentWebhookBaseUrl: "http://localhost:3000/api/payments/webhooks",
        paymentMockEnabled: true,
        paymentMockProviderCreateGatePath: gatePath,
        buildMockPaymentCompletionUrl: (paymentNo: string) =>
          `http://localhost:3000/api/payments/mock/${paymentNo}/complete`,
      } as unknown as AppConfigService,
      makeTradeStore(),
    );

    let resolved = false;
    const pending = provider
      .createPaymentIntent({
        paymentNo: "PAY20260504000001AAAA0003",
        orderNo: "ORD20260504000001AAAA0003",
        amountCents: 199,
        expiresAt: new Date("2026-05-04T00:15:00.000Z"),
        config: {
          providerCode: "mock",
          merchantNo: null,
          appId: null,
          publicConfigJson: {},
          sensitiveConfigJson: {},
        },
      })
      .then((value) => {
        resolved = true;
        return value;
      });

    await vi.waitFor(async () => {
      const marker = JSON.parse(
        await readFile(`${gatePath}.pending.json`, "utf8"),
      ) as { paymentNo?: string; state?: string };
      expect(marker).toMatchObject({
        paymentNo: "PAY20260504000001AAAA0003",
        state: "pending",
      });
    });
    expect(resolved).toBe(false);

    await writeFile(
      gatePath,
      `${JSON.stringify({
        state: "release",
        paymentNo: "PAY20260504000001AAAA0003",
      })}\n`,
      "utf8",
    );

    await expect(pending).resolves.toMatchObject({
      providerTradeNo: "MOCK-PAY20260504000001AAAA0003",
      paymentUrl:
        "http://localhost:3000/api/payments/mock/PAY20260504000001AAAA0003/complete",
    });
  });

  it("uses the gate-specific timeout before classifying the request as sent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-mock-payment-timeout-"));
    const gatePath = join(root, "create-gate.json");
    await writeFile(
      gatePath,
      `${JSON.stringify({ state: "hold", timeoutMs: 100 })}\n`,
      "utf8",
    );
    const provider = new MockPaymentProvider(
      {
        paymentMockEnabled: true,
        paymentMockProviderCreateGatePath: gatePath,
        buildMockPaymentCompletionUrl: (paymentNo: string) =>
          `http://localhost:3000/api/payments/mock/${paymentNo}/complete`,
      } as unknown as AppConfigService,
      makeTradeStore(),
    );

    await expect(
      provider.createPaymentIntent({
        paymentNo: "PAY20260504000001AAAA0005",
        orderNo: "ORD20260504000001AAAA0005",
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
    ).rejects.toBeInstanceOf(PaymentProviderRequestNotSentError);
  });

  it("fails closed when the configured mock create gate is missing", async () => {
    const provider = new MockPaymentProvider(
      {
        paymentWebhookBaseUrl: "http://localhost:3000/api/payments/webhooks",
        paymentMockEnabled: true,
        paymentMockProviderCreateGatePath: "/missing/mock-create-gate.json",
        buildMockPaymentCompletionUrl: (paymentNo: string) =>
          `http://localhost:3000/api/payments/mock/${paymentNo}/complete`,
      } as unknown as AppConfigService,
      makeTradeStore(),
    );

    await expect(
      provider.createPaymentIntent({
        paymentNo: "PAY20260504000001AAAA0004",
        orderNo: "ORD20260504000001AAAA0004",
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
    ).rejects.toThrow(/mock payment create gate is unreadable/);
  });

  it("injects a bounded testbed failure at the mock provider query boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "vem-mock-payment-query-fault-"));
    const faultPath = join(root, "query-fault.json");
    await writeFile(
      faultPath,
      `${JSON.stringify({ state: "fail", paymentNo: "PAY-QUERY-FAULT-001" })}\n`,
      "utf8",
    );
    const provider = new MockPaymentProvider(
      {
        paymentMockEnabled: true,
        paymentMockProviderQueryFaultPath: faultPath,
      } as unknown as AppConfigService,
      makeTradeStore(),
    );

    await expect(
      provider.queryPayment({
        paymentNo: "PAY-QUERY-FAULT-001",
        providerTradeNo: "MOCK-PAY-QUERY-FAULT-001",
        amountCents: 199,
        config: {
          providerCode: "mock",
          merchantNo: null,
          appId: null,
          publicConfigJson: {},
          sensitiveConfigJson: {},
        },
      }),
    ).rejects.toThrow(/mock payment query fault injected/);
  });
});
