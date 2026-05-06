import { createSign, generateKeyPairSync } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { AlipayProvider } from "./alipay.provider";
import type { PaymentProviderRuntimeConfig } from "./payment-provider.interface";

let privateKey: string;
let publicKey: string;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

function makeConfig(): PaymentProviderRuntimeConfig {
  return {
    providerCode: "alipay",
    merchantNo: null,
    appId: "alipay-app-001",
    publicConfigJson: {
      alipayPublicKeyPem: publicKey,
      notifyUrl: "https://example.com/notify",
      gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
    },
    sensitiveConfigJson: {
      privateKeyPem: privateKey,
    },
  };
}

function signParams(
  params: Record<string, string>,
  key: string,
): string {
  const content = Object.keys(params)
    .filter((k) => k !== "sign" && k !== "sign_type")
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createSign("RSA-SHA256").update(content, "utf8").sign(key, "base64");
}

function makeWebhookBody(overrides: Partial<Record<string, string>> = {}): Record<string, string> {
  const base: Record<string, string> = {
    app_id: "alipay-app-001",
    out_trade_no: "PAY2025001",
    trade_no: "ALIPAY_TXN_001",
    trade_status: "TRADE_SUCCESS",
    total_amount: "9.99",
    notify_id: "notify-001",
    notify_time: "2025-05-05 12:00:00",
    gmt_create: "2025-05-05 11:00:00",
    ...overrides,
  };
  base["sign"] = signParams(base, privateKey);
  return base;
}

describe("AlipayProvider", () => {
  let provider: AlipayProvider;

  beforeAll(() => {
    provider = new AlipayProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("handleWebhook", () => {
    it("accepts a valid signed webhook and returns payment result", async () => {
      const body = makeWebhookBody();

      const result = await provider.handleWebhook({
        headers: {},
        rawBodyText: new URLSearchParams(body).toString(),
        body,
        candidateConfigs: [makeConfig()],
      });

      expect(result.paymentNo).toBe("PAY2025001");
      expect(result.paymentStatus).toBe("succeeded");
      expect(result.signatureValid).toBe(true);
    });

    it("throws UnauthorizedException when signature is invalid (tampered amount)", async () => {
      const body = makeWebhookBody({ total_amount: "999.99" });
      // Tamper with amount AFTER signing
      body["total_amount"] = "1.00";

      await expect(
        provider.handleWebhook({
          headers: {},
          rawBodyText: new URLSearchParams(body).toString(),
          body,
          candidateConfigs: [makeConfig()],
        }),
      ).rejects.toThrow(/signature invalid/i);
    });

    it("throws UnauthorizedException when signature is missing", async () => {
      const body = makeWebhookBody();
      const { sign: _sign, ...bodyNoSign } = body;

      await expect(
        provider.handleWebhook({
          headers: {},
          rawBodyText: new URLSearchParams(bodyNoSign).toString(),
          body: bodyNoSign,
          candidateConfigs: [makeConfig()],
        }),
      ).rejects.toThrow(/signature missing/i);
    });
  });

  describe("createPaymentIntent (precreate)", () => {
    it("calls Alipay gateway with method=alipay.trade.precreate and returns qr_code", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          ({
            alipay_trade_precreate_response: {
              code: "10000",
              msg: "Success",
              qr_code: "https://qr.alipay.com/bax123",
            },
          }),
      });
      vi.stubGlobal("fetch", fetchSpy);

      const result = await provider.createPaymentIntent({
        config: makeConfig(),
        paymentNo: "PAY001",
        orderNo: "ORD001",
        amountCents: 999,
        expiresAt: new Date(Date.now() + 900_000),
      });

      const calledBody = fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined;
      const formData = new URLSearchParams(calledBody?.body ?? "");
      expect(formData.get("method")).toBe("alipay.trade.precreate");
      expect(formData.get("sign_type")).toBe("RSA2");
      expect(formData.get("sign")).toBeTruthy();
      expect(result.paymentUrl).toBe("https://qr.alipay.com/bax123");
      vi.unstubAllGlobals();
    });
  });

  describe("queryPayment", () => {
    it("calls Alipay gateway with method=alipay.trade.query", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          ({
            alipay_trade_query_response: {
              code: "10000",
              trade_status: "TRADE_SUCCESS",
              trade_no: "TXN001",
            },
          }),
      });
      vi.stubGlobal("fetch", fetchSpy);

      const result = await provider.queryPayment({
        config: makeConfig(),
        paymentNo: "PAY001",
        providerTradeNo: null,
      });

      const calledBody = fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined;
      const formData = new URLSearchParams(calledBody?.body ?? "");
      expect(formData.get("method")).toBe("alipay.trade.query");
      expect(result.status).toBe("succeeded");
      vi.unstubAllGlobals();
    });
  });

  describe("cancelPayment", () => {
    it("calls Alipay gateway with method=alipay.trade.close", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          ({
            alipay_trade_close_response: {
              code: "10000",
              msg: "Success",
            },
          }),
      });
      vi.stubGlobal("fetch", fetchSpy);

      const result = await provider.cancelPayment({
        config: makeConfig(),
        paymentNo: "PAY001",
        providerTradeNo: null,
      });

      const calledBody = fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined;
      const formData = new URLSearchParams(calledBody?.body ?? "");
      expect(formData.get("method")).toBe("alipay.trade.close");
      expect(result.status).toBe("canceled");
      vi.unstubAllGlobals();
    });
  });

  describe("refundPayment", () => {
    it("calls Alipay gateway with method=alipay.trade.refund", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          ({
            alipay_trade_refund_response: {
              code: "10000",
              out_request_no: "REF001",
              fund_change: "Y",
            },
          }),
      });
      vi.stubGlobal("fetch", fetchSpy);

      const result = await provider.refundPayment({
        config: makeConfig(),
        paymentNo: "PAY001",
        refundNo: "REF001",
        amountCents: 500,
        reason: "customer request",
        providerTradeNo: null,
      });

      const calledBody = fetchSpy.mock.calls[0]?.[1] as { body?: string } | undefined;
      const formData = new URLSearchParams(calledBody?.body ?? "");
      expect(formData.get("method")).toBe("alipay.trade.refund");
      expect(result.providerRefundNo).toBe("REF001");
      vi.unstubAllGlobals();
    });
  });
});
