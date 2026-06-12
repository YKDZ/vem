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
      orderCodeReadinessCheckEnabled: false,
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
    exec: vi.fn(),
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
    vi.mocked(sdk.exec).mockResolvedValueOnce({
      code: "10000",
      out_trade_no: "PAY202605060001",
      qr_code: "https://qr.alipay.com/bax-sandbox",
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
        gateway: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
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
    vi.mocked(sdk.exec).mockResolvedValueOnce({
      code: "10000",
      out_trade_no: "PAY202605060002",
      qr_code: "https://qr.alipay.com/bax-sandbox",
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.createPaymentIntent({
      config: makeRuntimeConfig(),
      paymentNo: "PAY202605060002",
      orderNo: "ORD202605060002",
      amountCents: 1234,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });

    expect(sdk.exec).toHaveBeenNthCalledWith(
      1,
      "alipay.trade.precreate",
      expect.objectContaining({
        notify_url: "https://pay.example.com/api/payments/webhooks/alipay",
        bizContent: expect.objectContaining({
          out_trade_no: "PAY202605060002",
          total_amount: "12.34",
          subject: "VEM order ORD202605060002",
          product_code: "QR_CODE_OFFLINE",
          seller_id: "2088123456789012",
        }),
      }),
    );
    expect(sdk.exec).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      providerTradeNo: null,
      paymentUrl: "https://qr.alipay.com/bax-sandbox",
      initialStatus: "pending",
    });
  });

  it("does not reject an order-code QR before delayed query can observe it", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockResolvedValueOnce({
      code: "10000",
      out_trade_no: "PAY202605060098",
      qr_code: "https://qr.alipay.com/bax-sandbox",
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.createPaymentIntent({
      config: makeRuntimeConfig(),
      paymentNo: "PAY202605060098",
      orderNo: "ORD202605060098",
      amountCents: 100,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });

    expect(result.paymentUrl).toBe("https://qr.alipay.com/bax-sandbox");
    expect(sdk.exec).toHaveBeenCalledTimes(1);
  });

  it("waits for sandbox order-code QR to become queryable before display", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec)
      .mockResolvedValueOnce({
        code: "10000",
        out_trade_no: "PAY202605060120",
        qr_code: "https://qr.alipay.com/bax-sandbox",
      })
      .mockResolvedValueOnce({
        code: "40004",
        msg: "Business Failed",
        sub_code: "ACQ.TRADE_NOT_EXIST",
        sub_msg: "交易不存在",
      })
      .mockResolvedValueOnce({
        code: "10000",
        out_trade_no: "PAY202605060120",
        trade_status: "WAIT_BUYER_PAY",
        trade_no: "2026050622000000120",
      });
    const provider = new AlipayProvider(factory);

    const result = await provider.createPaymentIntent({
      config: makeRuntimeConfig({
        publicConfigJson: {
          ...makeRuntimeConfig().publicConfigJson,
          orderCodeReadinessCheckEnabled: true,
          orderCodeReadinessPollIntervalMs: 1,
          orderCodeReadinessTimeoutMs: 50,
        },
      }),
      paymentNo: "PAY202605060120",
      orderNo: "ORD202605060120",
      amountCents: 100,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });

    expect(result.paymentUrl).toBe("https://qr.alipay.com/bax-sandbox");
    expect(sdk.exec).toHaveBeenNthCalledWith(
      2,
      "alipay.trade.query",
      expect.objectContaining({
        bizContent: { out_trade_no: "PAY202605060120" },
      }),
    );
    expect(sdk.exec).toHaveBeenCalledTimes(3);
  });

  it("rejects precreate business failures before displaying a QR", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockResolvedValueOnce({
      code: "40004",
      msg: "Business Failed",
      sub_code: "ACQ.APPLY_PC_MERCHANT_CODE_ERROR",
      sub_msg: "申请二维码失败",
    });
    const provider = new AlipayProvider(factory);

    await expect(
      provider.createPaymentIntent({
        config: makeRuntimeConfig(),
        paymentNo: "PAY202605060121",
        orderNo: "ORD202605060121",
        amountCents: 100,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      }),
    ).rejects.toThrow("Alipay alipay.trade.precreate failed");
  });

  it("marks order-code QR processing when readiness probe does not observe the trade yet", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec)
      .mockResolvedValueOnce({
        code: "10000",
        out_trade_no: "PAY202605060122",
        qr_code: "https://qr.alipay.com/bax-sandbox",
      })
      .mockResolvedValue({
        code: "40004",
        msg: "Business Failed",
        sub_code: "ACQ.TRADE_NOT_EXIST",
        sub_msg: "交易不存在",
      });
    const provider = new AlipayProvider(factory);

    const result = await provider.createPaymentIntent({
      config: makeRuntimeConfig({
        publicConfigJson: {
          ...makeRuntimeConfig().publicConfigJson,
          orderCodeReadinessCheckEnabled: true,
          orderCodeReadinessPollIntervalMs: 1,
          orderCodeReadinessTimeoutMs: 1,
        },
      }),
      paymentNo: "PAY202605060122",
      orderNo: "ORD202605060122",
      amountCents: 100,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });

    expect(result.paymentUrl).toBe("https://qr.alipay.com/bax-sandbox");
    expect(result.initialStatus).toBe("processing");
    expect(sdk.exec).not.toHaveBeenCalledWith(
      "alipay.trade.cancel",
      expect.anything(),
    );
  });

  it("fails transient order-code precreate failures without canceling an unknown provider trade", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockRejectedValueOnce(
      new Error("HTTP 请求错误, status: 504"),
    );
    const provider = new AlipayProvider(factory);

    await expect(
      provider.createPaymentIntent({
        config: makeRuntimeConfig(),
        paymentNo: "PAY202605060099",
        orderNo: "ORD202605060099",
        amountCents: 100,
        expiresAt: new Date(Date.now() + 15 * 60_000),
      }),
    ).rejects.toThrow("支付宝支付通道暂不可用，请稍后重试");

    expect(sdk.exec).toHaveBeenNthCalledWith(
      1,
      "alipay.trade.precreate",
      expect.any(Object),
    );
    expect(sdk.exec).not.toHaveBeenCalledWith(
      "alipay.trade.cancel",
      expect.anything(),
    );
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
      vi.mocked(sdk.exec).mockResolvedValue({
        trade_status: tradeStatus,
        trade_no: "2026050622000000001",
      });
      const provider = new AlipayProvider(factory);

      const result = await provider.queryPayment({
        config: makeRuntimeConfig(),
        paymentNo: "PAY202605060003",
        providerTradeNo: null,
      });

      expect(sdk.exec).toHaveBeenCalledWith(
        "alipay.trade.query",
        expect.objectContaining({
          bizContent: expect.objectContaining({
            out_trade_no: "PAY202605060003",
          }),
        }),
      );
      expect(result.status).toBe(status);
      expect(result.providerTradeNo).toBe("2026050622000000001");
    },
  );

  it("keeps order-code TRADE_NOT_EXIST query result indeterminate", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockResolvedValue({
      code: "40004",
      msg: "Business Failed",
      sub_code: "ACQ.TRADE_NOT_EXIST",
      sub_msg: "交易不存在",
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.queryPayment({
      config: makeRuntimeConfig(),
      paymentNo: "PAY202605060404",
      providerTradeNo: null,
    });

    expect(result.status).toBe("processing");
    expect(result.failedReason).toBe("ACQ.TRADE_NOT_EXIST");
  });

  it("maps terminal order-code query business errors to failed", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockResolvedValue({
      code: "40004",
      msg: "Business Failed",
      sub_code: "ACQ.INVALID_PARAMETER",
      sub_msg: "参数无效",
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.queryPayment({
      config: makeRuntimeConfig(),
      paymentNo: "PAY202605060405",
      providerTradeNo: null,
    });

    expect(result.status).toBe("failed");
    expect(result.failedReason).toBe("ACQ.INVALID_PARAMETER");
  });

  it("maps TRADE_CLOSED queryPaymentCode result to reversed", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockResolvedValue({
      code: "10000",
      trade_status: "TRADE_CLOSED",
      trade_no: "2026050622000000099",
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.queryPaymentCode({
      config: makeRuntimeConfig(),
      paymentNo: "PCA202605240099",
      providerTradeNo: null,
    });

    expect(sdk.exec).toHaveBeenCalledWith(
      "alipay.trade.query",
      expect.objectContaining({
        bizContent: expect.objectContaining({
          out_trade_no: "PCA202605240099",
        }),
      }),
    );
    expect(result.status).toBe("reversed");
    expect(result.providerTradeNo).toBe("2026050622000000099");
    expect(result.providerStatus).toBe("TRADE_CLOSED");
  });

  it("maps payment_code query TRADE_SUCCESS to succeeded through classic gateway", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockResolvedValue({
      code: "10000",
      trade_status: "TRADE_SUCCESS",
      trade_no: "2026050622000000100",
      send_pay_date: "2026-05-24 10:00:00",
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.queryPaymentCode({
      config: makeRuntimeConfig(),
      paymentNo: "PCA202605240100",
      providerTradeNo: null,
    });

    expect(sdk.exec).toHaveBeenCalledWith(
      "alipay.trade.query",
      expect.objectContaining({
        bizContent: expect.objectContaining({
          out_trade_no: "PCA202605240100",
        }),
      }),
    );
    expect(result.status).toBe("succeeded");
    expect(result.providerTradeNo).toBe("2026050622000000100");
    expect(result.paidAt).toBeInstanceOf(Date);
  });

  it("cancels unpaid QR order through alipay.trade.cancel", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockResolvedValue({
      code: "10000",
      action: "close",
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.cancelPayment({
      config: makeRuntimeConfig(),
      paymentNo: "PAY202605060004",
      providerTradeNo: null,
    });

    expect(sdk.exec).toHaveBeenCalledWith(
      "alipay.trade.cancel",
      expect.objectContaining({
        bizContent: { out_trade_no: "PAY202605060004" },
      }),
    );
    expect(result.status).toBe("canceled");
  });

  it("charges payment_code through alipay.trade.pay with bar_code scene", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockResolvedValue({
      code: "10000",
      trade_no: "2026050622000000010",
      gmt_payment: "2026-05-24 10:00:00",
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.chargePaymentCode({
      config: makeRuntimeConfig(),
      paymentNo: "PCA202605240001",
      orderNo: "ORD202605240001",
      amountCents: 1234,
      authCode: "28763443825664394",
      terminalId: "TERM-001",
      storeId: "STORE-001",
      clientIp: "127.0.0.1",
    });

    expect(sdk.exec).toHaveBeenCalledWith(
      "alipay.trade.pay",
      expect.objectContaining({
        bizContent: expect.objectContaining({
          out_trade_no: "PCA202605240001",
          auth_code: "28763443825664394",
          scene: "bar_code",
          product_code: "FACE_TO_FACE_PAYMENT",
          store_id: "STORE-001",
          terminal_id: "TERM-001",
        }),
      }),
    );
    expect(result.status).toBe("succeeded");
    expect(result.providerTradeNo).toBe("2026050622000000010");
  });

  it("maps code=10003 to user_confirming for payment_code", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockResolvedValue({
      code: "10003",
      sub_code: "ACQ.CONTINUE_TRANS",
      sub_msg: "等待用户付款",
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.chargePaymentCode({
      config: makeRuntimeConfig(),
      paymentNo: "PCA202605240002",
      orderNo: "ORD202605240002",
      amountCents: 500,
      authCode: "28763443825664394",
      terminalId: null,
      storeId: null,
      clientIp: "127.0.0.1",
    });

    expect(result.status).toBe("user_confirming");
    expect(result.failureMessage).toBe("等待用户付款");
  });

  it("maps code=20000 to unknown for payment_code", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockResolvedValue({
      code: "20000",
      sub_msg: "服务暂不可用",
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.chargePaymentCode({
      config: makeRuntimeConfig(),
      paymentNo: "PCA202605240003",
      orderNo: "ORD202605240003",
      amountCents: 500,
      authCode: "28763443825664394",
      terminalId: null,
      storeId: null,
      clientIp: "127.0.0.1",
    });

    expect(result.status).toBe("unknown");
  });

  it("maps payment_code charge timeout to unknown instead of throwing", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockRejectedValue(
      new Error("HttpClient Request error: Request timeout for 5000 ms"),
    );
    const provider = new AlipayProvider(factory);

    const result = await provider.chargePaymentCode({
      config: makeRuntimeConfig(),
      paymentNo: "PCA202605240088",
      orderNo: "ORD202605240088",
      amountCents: 500,
      authCode: "28763443825664394",
      terminalId: null,
      storeId: null,
      clientIp: "127.0.0.1",
    });

    expect(result.status).toBe("unknown");
    expect(result.failureCode).toBe("ALIPAY_REQUEST_UNKNOWN");
    expect(result.failureMessage).toContain("timeout");
  });

  it("maps payment_code query 504 to unknown", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockRejectedValue({
      responseHttpStatus: 504,
      message: "HTTP 请求错误, status: 504",
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.queryPaymentCode({
      config: makeRuntimeConfig(),
      paymentNo: "PCA202605240089",
      providerTradeNo: null,
    });

    expect(result.status).toBe("unknown");
    expect(result.failureCode).toBe("ALIPAY_QUERY_UNKNOWN");
  });

  it("reverses payment_code through alipay.trade.cancel and maps retry_flag=Y to processing", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockResolvedValue({
      code: "10000",
      retry_flag: "Y",
      action: "cancel",
    });
    const provider = new AlipayProvider(factory);

    const result = await provider.reversePaymentCode({
      config: makeRuntimeConfig(),
      paymentNo: "PCA202605240004",
      providerTradeNo: "2026050622000000011",
    });

    expect(sdk.exec).toHaveBeenCalledWith(
      "alipay.trade.cancel",
      expect.objectContaining({
        bizContent: expect.objectContaining({
          out_trade_no: "PCA202605240004",
          trade_no: "2026050622000000011",
        }),
      }),
    );
    expect(result.status).toBe("processing");
    expect(result.recall).toBe(true);
  });

  it("maps payment_code reverse timeout to unknown instead of throwing", async () => {
    const { sdk, factory } = makeSdk();
    vi.mocked(sdk.exec).mockRejectedValue(
      new Error("HttpClient Request error: Request timeout for 5000 ms"),
    );
    const provider = new AlipayProvider(factory);

    const result = await provider.reversePaymentCode({
      config: makeRuntimeConfig(),
      paymentNo: "PCA202605240090",
      providerTradeNo: "2026050622000000090",
    });

    expect(result.status).toBe("unknown");
    expect(result.recall).toBe(true);
    expect(result.failureCode).toBe("ALIPAY_REVERSE_UNKNOWN");
    expect(result.failureMessage).toContain("timeout");
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
