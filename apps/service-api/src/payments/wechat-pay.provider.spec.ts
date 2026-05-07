import {
  createCipheriv,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { PaymentProviderRuntimeConfig } from "./payment-provider.interface";

import { WeChatPayProvider } from "./wechat-pay.provider";

// Generate test RSA key pairs once for all tests
let merchantPrivateKey: string;
let platformPrivateKey: string;
let platformPublicKey: string;

/** Merchant certificate serial number (goes in Authorization header) */
const TEST_MERCHANT_CERT_SERIAL = "MERCHANT_SERIAL_0001";
/** Platform certificate serial number (goes in wechatpay-serial response header) */
const TEST_PLATFORM_CERT_SERIAL = "PLATFORM_SERIAL_0001";
const TEST_API_V3_KEY = "12345678901234567890123456789012"; // exactly 32 bytes

beforeAll(() => {
  const merchantPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  merchantPrivateKey = merchantPair.privateKey;

  const platformPair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  platformPrivateKey = platformPair.privateKey;
  platformPublicKey = platformPair.publicKey;
});

function makeConfig(
  overrides?: Partial<PaymentProviderRuntimeConfig>,
): PaymentProviderRuntimeConfig {
  return {
    id: "cfg-001",
    providerCode: "wechat_pay",
    merchantNo: "MCH001",
    appId: "wx-app-001",
    publicConfigJson: {
      merchantCertificateSerialNo: TEST_MERCHANT_CERT_SERIAL,
      platformCertificateSerialNo: TEST_PLATFORM_CERT_SERIAL,
      notifyUrl: "https://example.com/webhook",
    },
    sensitiveConfigJson: {
      apiV3Key: TEST_API_V3_KEY,
      privateKeyPem: merchantPrivateKey,
      platformPublicKeyPem: platformPublicKey,
    },
    ...overrides,
  };
}

function encryptWeChatBody(
  plaintext: string,
  apiV3Key: string,
): { ciphertext: string; nonce: string; associatedData: string } {
  const nonce = randomBytes(12).toString("hex").slice(0, 12);
  const associatedData = "transaction";
  const keyBuf = Buffer.from(apiV3Key, "utf8");
  const nonceBuf = Buffer.from(nonce, "utf8");
  const cipher = createCipheriv("aes-256-gcm", keyBuf, nonceBuf);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, authTag]).toString("base64"),
    nonce,
    associatedData,
  };
}

function createSignedWebhook(
  paymentData: Record<string, unknown>,
  apiV3Key: string,
): {
  headers: Record<string, string>;
  rawBodyText: string;
} {
  const { ciphertext, nonce, associatedData } = encryptWeChatBody(
    JSON.stringify(paymentData),
    apiV3Key,
  );

  const bodyObj = {
    id: "evt-test-001",
    event_type: "TRANSACTION.SUCCESS",
    resource: {
      algorithm: "AEAD_AES_256_GCM",
      ciphertext,
      nonce,
      associated_data: associatedData,
      original_type: "transaction",
    },
  };
  const rawBodyText = JSON.stringify(bodyObj);

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const webhookNonce = "testwebhooknonce01";
  const message = `${timestamp}\n${webhookNonce}\n${rawBodyText}\n`;

  const signature = createSign("RSA-SHA256")
    .update(message, "utf8")
    .sign(platformPrivateKey, "base64");

  return {
    headers: {
      "wechatpay-timestamp": timestamp,
      "wechatpay-nonce": webhookNonce,
      "wechatpay-signature": signature,
      "wechatpay-serial": TEST_PLATFORM_CERT_SERIAL,
    },
    rawBodyText,
  };
}

/** Creates a signed mock API response with Wechatpay-* response headers. */
function createSignedApiResponse(
  body: Record<string, unknown>,
  signingPrivateKey: string,
  serialOverride?: string,
): Response {
  const bodyText = JSON.stringify(body);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const respNonce = "respnonce0000001";
  const message = `${timestamp}\n${respNonce}\n${bodyText}\n`;
  const signature = createSign("RSA-SHA256")
    .update(message, "utf8")
    .sign(signingPrivateKey, "base64");

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "wechatpay-timestamp": timestamp,
    "wechatpay-nonce": respNonce,
    "wechatpay-signature": signature,
    "wechatpay-serial": serialOverride ?? TEST_PLATFORM_CERT_SERIAL,
  };

  return {
    ok: true,
    status: 200,
    text: async () => bodyText,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
  } as unknown as Response;
}

describe("WeChatPayProvider", () => {
  let provider: WeChatPayProvider;

  beforeAll(() => {
    provider = new WeChatPayProvider();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("handleWebhook", () => {
    it("accepts a valid signed webhook and returns payment result", async () => {
      const paymentData = {
        out_trade_no: "PAY2025001",
        trade_state: "SUCCESS",
        transaction_id: "TXN123",
        amount: { total: 100, payer_total: 100 },
      };
      const { headers, rawBodyText } = createSignedWebhook(
        paymentData,
        TEST_API_V3_KEY,
      );

      const result = await provider.handleWebhook({
        headers,
        rawBodyText,
        body: JSON.parse(rawBodyText) as Record<string, unknown>,
        candidateConfigs: [makeConfig()],
      });

      expect(result.paymentNo).toBe("PAY2025001");
      expect(
        (
          result as import("./payment-provider.interface").ProviderPaymentWebhookResult
        ).paymentStatus,
      ).toBe("succeeded");
      expect(result.signatureValid).toBe(true);
    });

    it("throws UnauthorizedException when rawBodyText is tampered (signature mismatch)", async () => {
      const paymentData = {
        out_trade_no: "PAY2025002",
        trade_state: "SUCCESS",
        transaction_id: "TXN124",
        amount: { total: 100, payer_total: 100 },
      };
      const { headers, rawBodyText } = createSignedWebhook(
        paymentData,
        TEST_API_V3_KEY,
      );

      // Tamper with the raw body (simulates amount tampering)
      const tampered = rawBodyText.replace("SUCCESS", "TAMPERED");

      await expect(
        provider.handleWebhook({
          headers,
          rawBodyText: tampered,
          body: JSON.parse(tampered) as Record<string, unknown>,
          candidateConfigs: [makeConfig()],
        }),
      ).rejects.toThrow(/signature invalid/i);
    });

    it("throws when certificate serial does not match platformCertificateSerialNo", async () => {
      const paymentData = {
        out_trade_no: "PAY2025003",
        trade_state: "SUCCESS",
        transaction_id: "TXN125",
        amount: { total: 100, payer_total: 100 },
      };
      const { rawBodyText } = createSignedWebhook(paymentData, TEST_API_V3_KEY);

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const webhookNonce = "testnonce0000001";
      const message = `${timestamp}\n${webhookNonce}\n${rawBodyText}\n`;
      const signature = createSign("RSA-SHA256")
        .update(message, "utf8")
        .sign(platformPrivateKey, "base64");

      await expect(
        provider.handleWebhook({
          headers: {
            "wechatpay-timestamp": timestamp,
            "wechatpay-nonce": webhookNonce,
            "wechatpay-signature": signature,
            "wechatpay-serial": "WRONG_SERIAL",
          },
          rawBodyText,
          body: JSON.parse(rawBodyText) as Record<string, unknown>,
          candidateConfigs: [makeConfig()],
        }),
      ).rejects.toThrow(/serial mismatch/i);
    });
  });

  describe("createPaymentIntent", () => {
    it("returns providerTradeNo: null (transaction_id only available after webhook/query)", async () => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          createSignedApiResponse(
            { code_url: "weixin://wxpay/bizpayurl?pr=xxx" },
            platformPrivateKey,
          ),
        );
      vi.stubGlobal("fetch", fetchSpy);

      const result = await provider.createPaymentIntent({
        config: makeConfig(),
        paymentNo: "PAY001",
        orderNo: "ORD001",
        amountCents: 999,
        expiresAt: new Date(Date.now() + 900_000),
      });

      expect(result.providerTradeNo).toBeNull();
      expect(result.paymentUrl).toBe("weixin://wxpay/bizpayurl?pr=xxx");
      vi.unstubAllGlobals();
    });

    it("Authorization serial_no uses merchantCertificateSerialNo not platformCertificateSerialNo", async () => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          createSignedApiResponse(
            { code_url: "weixin://wxpay/bizpayurl?pr=yyy" },
            platformPrivateKey,
          ),
        );
      vi.stubGlobal("fetch", fetchSpy);

      await provider.createPaymentIntent({
        config: makeConfig(),
        paymentNo: "PAY002",
        orderNo: "ORD002",
        amountCents: 100,
        expiresAt: new Date(Date.now() + 900_000),
      });

      const [, requestInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const authHeader = (requestInit.headers as Record<string, string>)[
        "Authorization"
      ];
      expect(authHeader).toContain(`serial_no="${TEST_MERCHANT_CERT_SERIAL}"`);
      expect(authHeader).not.toContain(TEST_PLATFORM_CERT_SERIAL);
      vi.unstubAllGlobals();
    });

    it("throws BadGatewayException when response serial does not match platformCertificateSerialNo", async () => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          createSignedApiResponse(
            { code_url: "weixin://wxpay/bizpayurl?pr=zzz" },
            platformPrivateKey,
            "WRONG_PLATFORM_SERIAL",
          ),
        );
      vi.stubGlobal("fetch", fetchSpy);

      await expect(
        provider.createPaymentIntent({
          config: makeConfig(),
          paymentNo: "PAY003",
          orderNo: "ORD003",
          amountCents: 100,
          expiresAt: new Date(Date.now() + 900_000),
        }),
      ).rejects.toThrow(/response serial mismatch/i);
      vi.unstubAllGlobals();
    });

    it("throws BadGatewayException when response signature is invalid", async () => {
      const wrongKey = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
      });
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          createSignedApiResponse(
            { code_url: "weixin://wxpay/bizpayurl?pr=bad" },
            wrongKey.privateKey,
          ),
        );
      vi.stubGlobal("fetch", fetchSpy);

      await expect(
        provider.createPaymentIntent({
          config: makeConfig(),
          paymentNo: "PAY004",
          orderNo: "ORD004",
          amountCents: 100,
          expiresAt: new Date(Date.now() + 900_000),
        }),
      ).rejects.toThrow(/response signature invalid/i);
      vi.unstubAllGlobals();
    });

    it("uses out_trade_no from paymentNo, not orderNo", async () => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          createSignedApiResponse(
            { code_url: "weixin://wxpay/bizpayurl?pr=xxx" },
            platformPrivateKey,
          ),
        );
      vi.stubGlobal("fetch", fetchSpy);

      await provider.createPaymentIntent({
        config: makeConfig(),
        paymentNo: "PAY_NO_001",
        orderNo: "ORD_NO_001",
        amountCents: 100,
        expiresAt: new Date(Date.now() + 900_000),
      });

      const [, requestInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const sentBody = JSON.parse(requestInit.body as string) as Record<
        string,
        unknown
      >;
      expect(sentBody["out_trade_no"]).toBe("PAY_NO_001");
      expect(sentBody["out_trade_no"]).not.toBe("ORD_NO_001");
      vi.unstubAllGlobals();
    });
  });

  describe("handleWebhook serial separation", () => {
    it("succeeds when wechatpay-serial matches platformCertificateSerialNo", async () => {
      const paymentData = {
        out_trade_no: "PAY_SERIAL_001",
        trade_state: "SUCCESS",
        transaction_id: "TXN_SERIAL_001",
        mchid: "MCH001",
        appid: "wx-app-001",
        amount: { total: 100, currency: "CNY" },
      };
      const { headers, rawBodyText } = createSignedWebhook(
        paymentData,
        TEST_API_V3_KEY,
      );

      const result = await provider.handleWebhook({
        headers,
        rawBodyText,
        body: JSON.parse(rawBodyText) as Record<string, unknown>,
        candidateConfigs: [makeConfig()],
      });

      expect(result.paymentNo).toBe("PAY_SERIAL_001");
      expect(result.matchedConfigId).toBe("cfg-001");
    });

    it("fails when wechatpay-serial equals merchantCertificateSerialNo instead of platformCertificateSerialNo", async () => {
      const paymentData = {
        out_trade_no: "PAY_SERIAL_002",
        trade_state: "SUCCESS",
        transaction_id: "TXN_SERIAL_002",
        amount: { total: 100, currency: "CNY" },
      };
      const { rawBodyText } = createSignedWebhook(paymentData, TEST_API_V3_KEY);
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const webhookNonce = "serlnonce0000001";
      const message = `${timestamp}\n${webhookNonce}\n${rawBodyText}\n`;
      const signature = createSign("RSA-SHA256")
        .update(message, "utf8")
        .sign(platformPrivateKey, "base64");

      // Use merchantCertificateSerialNo as wechatpay-serial -- should fail
      await expect(
        provider.handleWebhook({
          headers: {
            "wechatpay-timestamp": timestamp,
            "wechatpay-nonce": webhookNonce,
            "wechatpay-signature": signature,
            "wechatpay-serial": TEST_MERCHANT_CERT_SERIAL,
          },
          rawBodyText,
          body: JSON.parse(rawBodyText) as Record<string, unknown>,
          candidateConfigs: [makeConfig()],
        }),
      ).rejects.toThrow(/serial mismatch/i);
    });
  });

  describe("handleWebhook normalizedPayload", () => {
    it("returns normalizedPayload with business fields for service-layer validation", async () => {
      const paymentData = {
        out_trade_no: "PAY_NORM_001",
        trade_state: "SUCCESS",
        transaction_id: "TXN_NORM_001",
        mchid: "MCH001",
        appid: "wx-app-001",
        amount: { total: 500, currency: "CNY" },
        success_time: "2026-05-06T10:00:00+08:00",
      };
      const { headers, rawBodyText } = createSignedWebhook(
        paymentData,
        TEST_API_V3_KEY,
      );

      const result = await provider.handleWebhook({
        headers,
        rawBodyText,
        body: JSON.parse(rawBodyText) as Record<string, unknown>,
        candidateConfigs: [makeConfig()],
      });

      expect(result.normalizedPayload).toMatchObject({
        outTradeNo: "PAY_NORM_001",
        transactionId: "TXN_NORM_001",
        mchId: "MCH001",
        appId: "wx-app-001",
        tradeState: "SUCCESS",
        amountTotal: 500,
        amountCurrency: "CNY",
      });
    });

    it("providerTradeNo equals transaction_id from decrypted payload", async () => {
      const paymentData = {
        out_trade_no: "PAY_TXN_001",
        trade_state: "SUCCESS",
        transaction_id: "REAL_TXN_ID_12345",
        amount: { total: 100, currency: "CNY" },
      };
      const { headers, rawBodyText } = createSignedWebhook(
        paymentData,
        TEST_API_V3_KEY,
      );

      const result = await provider.handleWebhook({
        headers,
        rawBodyText,
        body: JSON.parse(rawBodyText) as Record<string, unknown>,
        candidateConfigs: [makeConfig()],
      });

      expect(
        (
          result as import("./payment-provider.interface").ProviderPaymentWebhookResult
        ).providerTradeNo,
      ).toBe("REAL_TXN_ID_12345");
    });
  });

  describe("queryPayment trade_state mapping", () => {
    async function queryWithTradeState(
      tradeState: string,
      transactionId?: string,
    ) {
      const responseBody: Record<string, unknown> = {
        trade_state: tradeState,
        out_trade_no: "PAY_QUERY_001",
      };
      if (transactionId) responseBody["transaction_id"] = transactionId;
      if (tradeState === "SUCCESS")
        responseBody["success_time"] = "2026-05-06T10:00:00+08:00";
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          createSignedApiResponse(responseBody, platformPrivateKey),
        );
      vi.stubGlobal("fetch", fetchSpy);
      const p = new WeChatPayProvider();
      try {
        return await p.queryPayment({
          config: makeConfig(),
          paymentNo: "PAY_QUERY_001",
          providerTradeNo: null,
        });
      } finally {
        vi.unstubAllGlobals();
      }
    }

    it("SUCCESS => succeeded with transaction_id and paidAt", async () => {
      const result = await queryWithTradeState("SUCCESS", "TXN_SUCC_001");
      expect(result.status).toBe("succeeded");
      expect(result.providerTradeNo).toBe("TXN_SUCC_001");
      expect(result.paidAt).toBeInstanceOf(Date);
    });

    it("USERPAYING => processing", async () => {
      expect((await queryWithTradeState("USERPAYING")).status).toBe(
        "processing",
      );
    });

    it("NOTPAY => pending", async () => {
      expect((await queryWithTradeState("NOTPAY")).status).toBe("pending");
    });

    it("CLOSED => canceled", async () => {
      expect((await queryWithTradeState("CLOSED")).status).toBe("canceled");
    });

    it("REVOKED => canceled", async () => {
      expect((await queryWithTradeState("REVOKED")).status).toBe("canceled");
    });

    it("PAYERROR => failed", async () => {
      expect((await queryWithTradeState("PAYERROR")).status).toBe("failed");
    });

    it("REFUND => succeeded", async () => {
      expect((await queryWithTradeState("REFUND", "TXN_REF_001")).status).toBe(
        "succeeded",
      );
    });

    it("unknown => pending", async () => {
      expect((await queryWithTradeState("UNKNOWN_STATE")).status).toBe(
        "pending",
      );
    });
  });

  describe("cancelPayment", () => {
    it("calls close endpoint with mchid and returns canceled", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
        text: async () => "",
        headers: { get: () => null },
      });
      vi.stubGlobal("fetch", fetchSpy);

      const result = await provider.cancelPayment({
        config: makeConfig(),
        paymentNo: "PAY_CLOSE_001",
        providerTradeNo: null,
      });

      const [url, requestInit] = fetchSpy.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain(
        "/v3/pay/transactions/out-trade-no/PAY_CLOSE_001/close",
      );
      const sentBody = JSON.parse(requestInit.body as string) as Record<
        string,
        unknown
      >;
      expect(sentBody["mchid"]).toBe("MCH001");
      expect(result.status).toBe("canceled");
      vi.unstubAllGlobals();
    });
  });

  describe("refundPayment", () => {
    it("calls /v3/refund/domestic/refunds with full-refund payload", async () => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          createSignedApiResponse(
            { refund_id: "RF_001", out_refund_no: "RFD001", status: "SUCCESS" },
            platformPrivateKey,
          ),
        );
      vi.stubGlobal("fetch", fetchSpy);

      const result = await provider.refundPayment({
        config: makeConfig(),
        refundNo: "RFD001",
        paymentNo: "PAY_REF_001",
        providerTradeNo: "TXN_REF_001",
        amountCents: 500,
        reason: "admin_refund",
      });

      const [url, requestInit] = fetchSpy.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(url).toContain("/v3/refund/domestic/refunds");
      const body = JSON.parse(requestInit.body as string) as Record<
        string,
        unknown
      >;
      const amount = body["amount"] as Record<string, unknown>;
      expect(amount["refund"]).toBe(500);
      expect(amount["total"]).toBe(500);
      expect(amount["currency"]).toBe("CNY");
      expect(result.status).toBe("succeeded");
      expect(result.providerRefundNo).toBe("RF_001");
      vi.unstubAllGlobals();
    });

    it("PROCESSING => processing status", async () => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          createSignedApiResponse(
            { refund_id: "RF_002", status: "PROCESSING" },
            platformPrivateKey,
          ),
        );
      vi.stubGlobal("fetch", fetchSpy);
      const result = await provider.refundPayment({
        config: makeConfig(),
        refundNo: "RFD002",
        paymentNo: "PAY_REF_002",
        providerTradeNo: null,
        amountCents: 100,
        reason: "admin_refund",
      });
      expect(result.status).toBe("processing");
      expect(result.refundedAt).toBeNull();
      vi.unstubAllGlobals();
    });

    it("ABNORMAL => failed status", async () => {
      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          createSignedApiResponse(
            { refund_id: "RF_003", status: "ABNORMAL" },
            platformPrivateKey,
          ),
        );
      vi.stubGlobal("fetch", fetchSpy);
      const result = await provider.refundPayment({
        config: makeConfig(),
        refundNo: "RFD003",
        paymentNo: "PAY_REF_003",
        providerTradeNo: null,
        amountCents: 100,
        reason: "admin_refund",
      });
      expect(result.status).toBe("failed");
      vi.unstubAllGlobals();
    });

    it("throws BadGatewayException on non-2xx without leaking credentials", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "internal error",
        headers: { get: () => null },
      });
      vi.stubGlobal("fetch", fetchSpy);
      await expect(
        provider.refundPayment({
          config: makeConfig(),
          refundNo: "RFD004",
          paymentNo: "PAY_REF_004",
          providerTradeNo: null,
          amountCents: 100,
          reason: "admin_refund",
        }),
      ).rejects.toThrow(/WeChat Pay request failed/i);
      vi.unstubAllGlobals();
    });
  });

  describe("parseWeChatPayConfig backward compat", () => {
    it("falls back to deprecated certificateSerialNo for merchant serial", async () => {
      const legacyConfig: PaymentProviderRuntimeConfig = {
        providerCode: "wechat_pay",
        merchantNo: "MCH_LEGACY",
        appId: "wx-legacy",
        publicConfigJson: {
          certificateSerialNo: "LEGACY_MERCHANT_SERIAL",
          platformCertificateSerialNo: TEST_PLATFORM_CERT_SERIAL,
          notifyUrl: "https://example.com/webhook",
        },
        sensitiveConfigJson: {
          apiV3Key: TEST_API_V3_KEY,
          privateKeyPem: merchantPrivateKey,
          platformPublicKeyPem: platformPublicKey,
        },
      };

      const fetchSpy = vi
        .fn()
        .mockResolvedValue(
          createSignedApiResponse(
            { code_url: "weixin://wxpay/bizpayurl?pr=legacy" },
            platformPrivateKey,
          ),
        );
      vi.stubGlobal("fetch", fetchSpy);

      await provider.createPaymentIntent({
        config: legacyConfig,
        paymentNo: "PAY_LEGACY",
        orderNo: "ORD_LEGACY",
        amountCents: 100,
        expiresAt: new Date(Date.now() + 900_000),
      });

      const [, requestInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const authHeader = (requestInit.headers as Record<string, string>)[
        "Authorization"
      ];
      expect(authHeader).toContain("LEGACY_MERCHANT_SERIAL");
      vi.unstubAllGlobals();
    });

    it("throws ConflictException when apiV3Key is not 32 bytes", async () => {
      const badConfig = makeConfig({
        sensitiveConfigJson: {
          apiV3Key: "tooshort",
          privateKeyPem: merchantPrivateKey,
          platformPublicKeyPem: platformPublicKey,
        },
      });

      await expect(
        provider.createPaymentIntent({
          config: badConfig,
          paymentNo: "PAY_BAD",
          orderNo: "ORD_BAD",
          amountCents: 100,
          expiresAt: new Date(Date.now() + 900_000),
        }),
      ).rejects.toThrow(/apiV3Key must be exactly 32 bytes/i);
    });
  });
});
