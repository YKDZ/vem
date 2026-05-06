import {
  createCipheriv,
  createSign,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { WeChatPayProvider } from "./wechat-pay.provider";
import type { PaymentProviderRuntimeConfig } from "./payment-provider.interface";

// Generate a test RSA key pair once for all tests
let merchantPrivateKey: string;
let platformPrivateKey: string;
let platformPublicKey: string;
const TEST_CERT_SERIAL = "TEST_SERIAL_0001";
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

function makeConfig(): PaymentProviderRuntimeConfig {
  return {
    providerCode: "wechat_pay",
    merchantNo: "MCH001",
    appId: "wx-app-001",
    publicConfigJson: {
      certificateSerialNo: TEST_CERT_SERIAL,
      platformPublicKeyPem: platformPublicKey,
      notifyUrl: "https://example.com/webhook",
    },
    sensitiveConfigJson: {
      apiV3Key: TEST_API_V3_KEY,
      privateKeyPem: merchantPrivateKey,
    },
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
      "wechatpay-serial": TEST_CERT_SERIAL,
    },
    rawBodyText,
  };
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
      expect(result.paymentStatus).toBe("succeeded");
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

    it("throws UnauthorizedException when certificate serial does not match", async () => {
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
    it("calls WeChat API with correct path and returns providerTradeNo", async () => {
      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        json: async () =>
          ({
            code_url: "weixin://wxpay/bizpayurl?pr=xxx",
            prepay_id: "wx_prepay_001",
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

      expect(fetchSpy).toHaveBeenCalled();
      const [url] = fetchSpy.mock.calls[0] as [string, ...unknown[]];
      expect(url).toContain("/v3/pay/transactions/native");
      expect(result.paymentUrl).toBe("weixin://wxpay/bizpayurl?pr=xxx");
      vi.unstubAllGlobals();
    });
  });
});
