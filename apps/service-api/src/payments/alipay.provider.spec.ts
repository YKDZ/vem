import { ConflictException, UnauthorizedException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  AlipaySdkClientFactory,
  AlipaySdkLike,
} from "./alipay-sdk.client";
import type { PaymentProviderRuntimeConfig } from "./payment-provider.interface";

import { AlipayProvider } from "./alipay.provider";

function makeRuntimeConfig(
  overrides: Partial<PaymentProviderRuntimeConfig> = {},
): PaymentProviderRuntimeConfig {
  return {
    providerCode: "alipay",
    merchantNo: "2088123456789012",
    appId: "2021000123456789",
    publicConfigJson: {
      mode: "sandbox",
      gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
      keyType: "PKCS8",
      qrExpiresMinutes: 15,
      timeoutCompensationSeconds: 120,
      notifyUrl: "https://pay.example.com/api/payments/webhooks/alipay",
    },
    sensitiveConfigJson: {
      privateKeyPem:
        "-----BEGIN PRIVATE KEY-----\nMIIB\n-----END PRIVATE KEY-----",
      appCertPem: "-----BEGIN CERTIFICATE-----\nAPP\n-----END CERTIFICATE-----",
      alipayPublicCertPem:
        "-----BEGIN CERTIFICATE-----\nALIPAY\n-----END CERTIFICATE-----",
      alipayRootCertPem:
        "-----BEGIN CERTIFICATE-----\nROOT\n-----END CERTIFICATE-----",
    },
    ...overrides,
  };
}

function makeSdk(overrides: Partial<AlipaySdkLike> = {}) {
  const sdk: AlipaySdkLike = {
    curl: vi.fn(),
    checkNotifySignV2: vi.fn().mockReturnValue(true),
    ...overrides,
  };
  const factory: AlipaySdkClientFactory = {
    create: vi.fn().mockReturnValue(sdk),
  } as unknown as AlipaySdkClientFactory;
  return { sdk, factory };
}

describe("AlipayProvider", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes SDK in certificate mode with PKCS8 and sandbox endpoint", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.curl).mockResolvedValue({
      responseHttpStatus: 200,
      traceId: "trace-precreate",
      data: { qr_code: "https://qr.alipay.com/bax-sandbox" },
    });
    const provider = new AlipayProvider(factory);

    await provider.createPaymentIntent({
      config: makeRuntimeConfig(),
      paymentNo: "PAY202605060001",
      orderNo: "ORD202605060001",
      amountCents: 999,
      expiresAt: new Date("2026-05-06T12:15:00.000Z"),
    });

    expect(factory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "2021000123456789",
        privateKey: expect.stringContaining("BEGIN PRIVATE KEY"),
        keyType: "PKCS8",
        endpoint: "https://openapi-sandbox.dl.alipaydev.com",
        camelcase: false,
        appCertContent: expect.stringContaining("BEGIN CERTIFICATE"),
        alipayPublicCertContent: expect.stringContaining("BEGIN CERTIFICATE"),
        alipayRootCertContent: expect.stringContaining("BEGIN CERTIFICATE"),
      }),
    );
  });

  it("precreates an order-code QR and does not invent providerTradeNo", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.curl).mockResolvedValue({
      responseHttpStatus: 200,
      data: { qr_code: "https://qr.alipay.com/bax-sandbox" },
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.createPaymentIntent({
      config: makeRuntimeConfig(),
      paymentNo: "PAY202605060002",
      orderNo: "ORD202605060002",
      amountCents: 1234,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });

    expect(sdk.curl).toHaveBeenCalledWith(
      "POST",
      "/v3/alipay/trade/precreate",
      expect.objectContaining({
        body: expect.objectContaining({
          notify_url: "https://pay.example.com/api/payments/webhooks/alipay",
          out_trade_no: "PAY202605060002",
          total_amount: "12.34",
          subject: "VEM order ORD202605060002",
          product_code: "QR_CODE_OFFLINE",
          seller_id: "2088123456789012",
        }),
      }),
    );
    expect(result).toEqual({
      providerTradeNo: null,
      paymentUrl: "https://qr.alipay.com/bax-sandbox",
    });
  });

  it.each([
    ["WAIT_BUYER_PAY", "pending"],
    ["TRADE_SUCCESS", "succeeded"],
    ["TRADE_FINISHED", "succeeded"],
    ["TRADE_CLOSED", "canceled"],
  ] as const)(
    "maps query trade_status %s to %s",
    async (tradeStatus, status) => {
      const { sdk, factory } = makeSdk();
      vi.mocked(sdk.curl).mockResolvedValue({
        responseHttpStatus: 200,
        data: { trade_status: tradeStatus, trade_no: "2026050622000000001" },
      });
      const provider = new AlipayProvider(factory);

      const result = await provider.queryPayment({
        config: makeRuntimeConfig(),
        paymentNo: "PAY202605060003",
        providerTradeNo: null,
      });

      expect(sdk.curl).toHaveBeenCalledWith(
        "POST",
        "/v3/alipay/trade/query",
        expect.objectContaining({
          body: expect.objectContaining({ out_trade_no: "PAY202605060003" }),
        }),
      );
      expect(result.status).toBe(status);
      expect(result.providerTradeNo).toBe("2026050622000000001");
    },
  );

  it("closes unpaid order through alipay.trade.close v3 path", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.curl).mockResolvedValue({
      responseHttpStatus: 200,
      data: {},
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.cancelPayment({
      config: makeRuntimeConfig(),
      paymentNo: "PAY202605060004",
      providerTradeNo: null,
    });

    expect(sdk.curl).toHaveBeenCalledWith(
      "POST",
      "/v3/alipay/trade/close",
      expect.objectContaining({ body: { out_trade_no: "PAY202605060004" } }),
    );
    expect(result.status).toBe("canceled");
  });

  it.each([
    ["Y", "succeeded"],
    ["N", "processing"],
    [undefined, "processing"],
  ] as const)(
    "maps refund fund_change=%s to %s",
    async (fundChange, status) => {
      const { sdk, factory } = makeSdk();
      vi.mocked(sdk.curl).mockResolvedValue({
        responseHttpStatus: 200,
        data: { out_request_no: "RFD202605060001", fund_change: fundChange },
      });
      const provider = new AlipayProvider(factory);

      const result = await provider.refundPayment({
        config: makeRuntimeConfig(),
        paymentNo: "PAY202605060005",
        providerTradeNo: "2026050622000000002",
        refundNo: "RFD202605060001",
        amountCents: 1234,
        reason: "admin_refund",
      });

      expect(sdk.curl).toHaveBeenCalledWith(
        "POST",
        "/v3/alipay/trade/refund",
        expect.objectContaining({
          body: expect.objectContaining({
            out_trade_no: "PAY202605060005",
            trade_no: "2026050622000000002",
            out_request_no: "RFD202605060001",
            refund_amount: "12.34",
          }),
        }),
      );
      expect(result.status).toBe(status);
    },
  );

  it("detects refund webhook by refund_fee field and returns eventKind=refund", async () => {
    const { factory } = makeSdk({
      checkNotifySignV2: vi.fn().mockReturnValue(true),
    });
    const provider = new AlipayProvider(factory);
    const body = {
      notify_id: "refund-notify-001",
      app_id: "2021000123456789",
      out_trade_no: "PAY202605060007",
      trade_no: "2026050622000000004",
      out_biz_no: "RFD202605060001",
      refund_fee: "1.00",
      refund_status: "REFUND_SUCCESS",
    };
    const rawBodyText = new URLSearchParams(
      body as Record<string, string>,
    ).toString();

    const result = await provider.handleWebhook({
      headers: {},
      body,
      rawBodyText,
      candidateConfigs: [makeRuntimeConfig()],
    });

    expect(result.eventKind).toBe("refund");
    const refundResult =
      result as import("./payment-provider.interface").ProviderRefundWebhookResult;
    expect(refundResult.refundNo).toBe("RFD202605060001");
    expect(refundResult.refundStatus).toBe("succeeded");
    expect(refundResult.paymentNo).toBe("PAY202605060007");
  });

  it("detects refund webhook by out_biz_no field and maps REFUND_FAIL to failed", async () => {
    const { factory } = makeSdk({
      checkNotifySignV2: vi.fn().mockReturnValue(true),
    });
    const provider = new AlipayProvider(factory);
    const body = {
      notify_id: "refund-notify-002",
      out_trade_no: "PAY202605060008",
      trade_no: "2026050622000000005",
      out_biz_no: "RFD202605060002",
      refund_status: "REFUND_FAIL",
    };
    const rawBodyText = new URLSearchParams(
      body as Record<string, string>,
    ).toString();

    const result = await provider.handleWebhook({
      headers: {},
      body,
      rawBodyText,
      candidateConfigs: [makeRuntimeConfig()],
    });

    expect(result.eventKind).toBe("refund");
    const refundResult =
      result as import("./payment-provider.interface").ProviderRefundWebhookResult;
    expect(refundResult.refundStatus).toBe("failed");
  });

  it("uses checkNotifySignV2 for async notification verification", async () => {
    const { sdk, factory } = makeSdk({
      checkNotifySignV2: vi.fn().mockReturnValue(true),
    });
    const provider = new AlipayProvider(factory);
    const body = {
      notify_id: "notify-001",
      app_id: "2021000123456789",
      seller_id: "2088123456789012",
      out_trade_no: "PAY202605060006",
      trade_no: "2026050622000000003",
      total_amount: "9.99",
      trade_status: "TRADE_SUCCESS",
      sign_type: "RSA2",
      sign: "signed-by-alipay",
    };

    const result = await provider.handleWebhook({
      headers: {},
      body,
      rawBodyText: new URLSearchParams(body).toString(),
      candidateConfigs: [makeRuntimeConfig()],
    });

    expect(sdk.checkNotifySignV2).toHaveBeenCalledWith(body);
    expect(result).toMatchObject({
      providerEventId: "notify-001",
      paymentNo: "PAY202605060006",
      providerTradeNo: "2026050622000000003",
      paymentStatus: "succeeded",
      signatureValid: true,
    });
  });

  it("rejects async notification when checkNotifySignV2 returns false", async () => {
    const { factory } = makeSdk({
      checkNotifySignV2: vi.fn().mockReturnValue(false),
    });
    const provider = new AlipayProvider(factory);

    await expect(
      provider.handleWebhook({
        headers: {},
        body: {
          app_id: "2021000123456789",
          out_trade_no: "PAY202605060007",
          sign: "invalid",
        },
        rawBodyText: "app_id=2021000123456789&out_trade_no=PAY202605060007",
        candidateConfigs: [makeRuntimeConfig()],
      }),
    ).rejects.toThrow(UnauthorizedException);
  });

  it("fails fast when enabled runtime config misses certificate content", async () => {
    const { factory } = makeSdk();
    const provider = new AlipayProvider(factory);

    await expect(
      provider.createPaymentIntent({
        config: makeRuntimeConfig({
          sensitiveConfigJson: { privateKeyPem: "key" },
        }),
        paymentNo: "PAY202605060008",
        orderNo: "ORD202605060008",
        amountCents: 100,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      }),
    ).rejects.toThrow(ConflictException);
  });

  it.each([
    ["REFUND_SUCCESS", "succeeded"],
    ["REFUND_PROCESSING", "processing"],
    ["REFUND_FAIL", "failed"],
    [undefined, "processing"],
  ] as const)(
    "maps query refund_status=%s to %s",
    async (refundStatus, expected) => {
      const { sdk, factory } = makeSdk();
      vi.mocked(sdk.curl).mockResolvedValue({
        responseHttpStatus: 200,
        data: {
          out_request_no: "RFD202605060009",
          ...(refundStatus !== undefined && { refund_status: refundStatus }),
        },
      });
      const provider = new AlipayProvider(factory);
      const result = await provider.queryRefund({
        config: makeRuntimeConfig(),
        paymentNo: "PAY202605060009",
        providerTradeNo: "2026050622000000009",
        providerRefundNo: null,
        refundNo: "RFD202605060009",
        amountCents: 100,
      });
      expect(result.status).toBe(expected);
    },
  );
});
