import { describe, expect, it } from "vitest";

import {
  HARDWARE_ERROR_HANDLING,
  adminUserStatuses,
  canonicalJson,
  createMachineOrderSchema,
  hardwareErrorCodes,
  heartbeatPayloadSchema,
  machineAuthTokenRequestSchema,
  machineSlotStatuses,
  maintenanceWorkOrderStatuses,
  mqttSignedEnvelopeSchema,
  orderStatuses,
  paymentProviderStatuses,
  paymentProviderSensitiveConfigSchema,
  roleStatuses,
  upsertNotificationTargetSchema,
  upsertPaymentProviderConfigSchema,
} from "./index";

describe("shared API contract", () => {
  it("uses backend order status values", () => {
    expect(orderStatuses).toContain("pending_payment");
    expect(orderStatuses).toContain("fulfilled");
    expect(orderStatuses).not.toContain("pending");
    expect(orderStatuses).not.toContain("completed");
  });

  it("uses backend status enums for management forms", () => {
    expect(machineSlotStatuses).toEqual(["enabled", "disabled", "faulted"]);
    expect(paymentProviderStatuses).toEqual(["enabled", "disabled"]);
    expect(adminUserStatuses).toEqual(["active", "disabled"]);
    expect(roleStatuses).toEqual(["active", "disabled"]);
  });

  it("accepts structured machine heartbeat payload", () => {
    expect(
      heartbeatPayloadSchema.parse({
        machineCode: "M001",
        reportedAt: "2026-05-05T12:00:00.000Z",
        statusPayload: {
          appVersion: "0.1.0",
          network: "online",
          mqttConnected: true,
          hardwareStatus: "ok",
          localQueueSize: 0,
        },
      }).statusPayload.mqttConnected,
    ).toBe(true);
  });

  it("validates machine auth token request", () => {
    expect(
      machineAuthTokenRequestSchema.parse({
        machineCode: "M001",
        machineSecret: "local-machine-shared-secret-change-before-production",
      }).machineCode,
    ).toBe("M001");
  });

  describe("canonicalJson", () => {
    it("sorts object keys alphabetically", () => {
      expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    });

    it("handles nested objects", () => {
      expect(canonicalJson({ z: { b: 1, a: 2 }, a: true })).toBe(
        '{"a":true,"z":{"a":2,"b":1}}',
      );
    });

    it("handles arrays preserving order", () => {
      expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
    });

    it("handles null and primitives", () => {
      expect(canonicalJson(null)).toBe("null");
      expect(canonicalJson(true)).toBe("true");
      expect(canonicalJson(42)).toBe("42");
      expect(canonicalJson("hello")).toBe('"hello"');
    });
  });

  describe("mqttSignedEnvelopeSchema", () => {
    it("accepts a valid envelope", () => {
      const envelope = {
        messageId: "msg-001",
        machineCode: "M001",
        issuedAt: "2026-05-05T12:00:00.000Z",
        nonce: "nonce-1234567890abcdef",
        payload: { commandNo: "CMD1" },
        signature: "a".repeat(32),
      };
      expect(mqttSignedEnvelopeSchema.parse(envelope).machineCode).toBe("M001");
    });

    it("rejects envelope missing signature", () => {
      expect(() =>
        mqttSignedEnvelopeSchema.parse({
          messageId: "msg-001",
          machineCode: "M001",
          issuedAt: "2026-05-05T12:00:00.000Z",
          nonce: "nonce-1234567890abcdef",
          payload: {},
          // no signature
        }),
      ).toThrow();
    });
  });

  describe("paymentProviderSensitiveConfigSchema", () => {
    it("accepts scalar values (string, number, boolean, null)", () => {
      expect(() =>
        paymentProviderSensitiveConfigSchema.parse({
          apiKey: "secret",
          amount: 100,
          enabled: true,
          optional: null,
        }),
      ).not.toThrow();
    });

    it("rejects array values", () => {
      expect(() =>
        paymentProviderSensitiveConfigSchema.parse({ keys: ["a", "b"] }),
      ).toThrow();
    });

    it("rejects nested object values", () => {
      expect(() =>
        paymentProviderSensitiveConfigSchema.parse({
          nested: { foo: "bar" },
        }),
      ).toThrow();
    });
  });

  describe("upsertPaymentProviderConfigSchema", () => {
    it("accepts machineId: null (global config)", () => {
      expect(() =>
        upsertPaymentProviderConfigSchema.parse({
          providerCode: "wechat_pay",
          machineId: null,
          merchantNo: "MCH123",
        }),
      ).not.toThrow();
    });

    it("accepts machineId as a UUID string (machine-specific config)", () => {
      expect(() =>
        upsertPaymentProviderConfigSchema.parse({
          providerCode: "alipay",
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          status: "disabled",
        }),
      ).not.toThrow();
    });

    it("accepts wechat_pay direct merchant config with timing windows", () => {
      const TEST_PRIVATE_KEY_PEM = "dev-test-private-key-not-for-crypto-use";
      const TEST_PUBLIC_KEY_PEM = "dev-test-public-key-not-for-crypto-use";
      const result = upsertPaymentProviderConfigSchema.parse({
        providerCode: "wechat_pay",
        machineId: null,
        merchantNo: "1900000109",
        appId: "wx1234567890abcdef",
        publicConfigJson: {
          mode: "direct_merchant",
          certificateSerialNo: "MERCHANT_CERT_SERIAL",
          qrExpiresMinutes: 15,
          timeoutCompensationSeconds: 120,
        },
        sensitiveConfigJson: {
          apiV3Key: "0123456789abcdef0123456789abcdef",
          privateKeyPem: TEST_PRIVATE_KEY_PEM,
          platformPublicKeyPem: TEST_PUBLIC_KEY_PEM,
        },
      });
      expect(result.providerCode).toBe("wechat_pay");
    });

    it("accepts alipay certificate mode sandbox config", () => {
      const TEST_PRIVATE_KEY_PEM = "dev-test-alipay-private-key-not-for-crypto-use";
      const TEST_CERTIFICATE_PEM = [
        "-----BEGIN CERTIFICATE-----",
        "ZGV2LXRlc3QtY2VydGlmaWNhdGUtbm90LWZvci1jcnlwdG8tdXNl",
        "-----END CERTIFICATE-----",
      ].join("\n");
      const result = upsertPaymentProviderConfigSchema.parse({
        providerCode: "alipay",
        merchantNo: "2088721101045878",
        appId: "9021000163629927",
        publicConfigJson: {
          mode: "sandbox",
          gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
          keyType: "PKCS8",
          qrExpiresMinutes: 15,
          timeoutCompensationSeconds: 120,
        },
        sensitiveConfigJson: {
          privateKeyPem: TEST_PRIVATE_KEY_PEM,
          appCertPem: TEST_CERTIFICATE_PEM,
          alipayPublicCertPem: TEST_CERTIFICATE_PEM,
          alipayRootCertPem: TEST_CERTIFICATE_PEM,
        },
      });
      expect(result.providerCode).toBe("alipay");
    });

    it("accepts machine-level disabled override without secrets", () => {
      expect(() =>
        upsertPaymentProviderConfigSchema.parse({
          providerCode: "wechat_pay",
          machineId: "550e8400-e29b-41d4-a716-446655440000",
          status: "disabled",
        }),
      ).not.toThrow();
    });

    it("rejects timing windows outside the agreed phase-1 bounds", () => {
      expect(() =>
        upsertPaymentProviderConfigSchema.parse({
          providerCode: "alipay",
          publicConfigJson: {
            qrExpiresMinutes: 0,
            timeoutCompensationSeconds: 9999,
          },
        }),
      ).toThrow();
    });
  });

  describe("createMachineOrderSchema", () => {
    it("accepts paymentProviderCode alongside paymentMethod", () => {
      const result = createMachineOrderSchema.parse({
        machineCode: "M001",
        items: [{ inventoryId: "550e8400-e29b-41d4-a716-446655440000", quantity: 1 }],
        paymentMethod: "qr_code",
        paymentProviderCode: "wechat_pay",
      });
      expect(result.paymentProviderCode).toBe("wechat_pay");
      expect(result.paymentMethod).toBe("qr_code");
    });

    it("works without paymentProviderCode (optional)", () => {
      expect(() =>
        createMachineOrderSchema.parse({
          machineCode: "M001",
          items: [{ inventoryId: "550e8400-e29b-41d4-a716-446655440000", quantity: 1 }],
          paymentMethod: "qr_code",
        }),
      ).not.toThrow();
    });
  });

  describe("HARDWARE_ERROR_HANDLING defaults", () => {
    it("has a policy for every hardwareErrorCode", () => {
      for (const code of hardwareErrorCodes) {
        expect(HARDWARE_ERROR_HANDLING[code]).toBeDefined();
        expect(typeof HARDWARE_ERROR_HANDLING[code].restoreInventory).toBe(
          "boolean",
        );
      }
    });

    it("has a NULL_ERROR fallback policy with errorCode=null", () => {
      expect(HARDWARE_ERROR_HANDLING["NULL_ERROR"]).toBeDefined();
      expect(HARDWARE_ERROR_HANDLING["NULL_ERROR"].errorCode).toBeNull();
    });
  });

  describe("maintenanceWorkOrderStatuses", () => {
    it("contains exactly the 4 allowed status values", () => {
      expect(maintenanceWorkOrderStatuses).toEqual([
        "open",
        "in_progress",
        "resolved",
        "canceled",
      ]);
    });
  });

  describe("upsertNotificationTargetSchema", () => {
    it("accepts wechat target with valid webhookUrl", () => {
      expect(() =>
        upsertNotificationTargetSchema.parse({
          name: "WeChat Group",
          type: "wechat",
          configJson: { webhookUrl: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc" },
        }),
      ).not.toThrow();
    });

    it("rejects wechat target with invalid webhookUrl", () => {
      expect(() =>
        upsertNotificationTargetSchema.parse({
          name: "WeChat Group",
          type: "wechat",
          configJson: { webhookUrl: "not-a-url" },
        }),
      ).toThrow();
    });
  });
});
