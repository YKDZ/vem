import { describe, expect, it, vi } from "vitest";

import { patchContract, postContract } from "@/api/request";

import {
  manualReconcile,
  mockFail,
  mockSucceed,
  queryPaymentCodeAttempt,
  queryRefund,
  reversePaymentCodeAttempt,
  updatePaymentProvider,
  updatePaymentProviderConfig,
  upsertPaymentProviderConfig,
} from "./payments";

vi.mock("@/api/request", () => ({
  post: vi.fn().mockResolvedValue({}),
  postContract: vi.fn().mockResolvedValue({}),
  get: vi.fn(),
  patch: vi.fn(),
  patchContract: vi.fn().mockResolvedValue({}),
}));

describe("payments api operator actions", () => {
  it("sends a reason when manually reconciling a payment", async () => {
    await manualReconcile(
      "550e8400-e29b-41d4-a716-446655440000",
      "customer sees paid but platform is pending",
    );

    expect(postContract).toHaveBeenCalledWith(
      "/payments/550e8400-e29b-41d4-a716-446655440000/reconcile",
      expect.any(Object),
      expect.any(Object),
      { reason: "customer sees paid but platform is pending" },
    );
  });

  it("uses schema-bound helpers for mock payment incident actions", async () => {
    await mockSucceed("PAY-1");
    await mockFail("PAY-2");

    expect(postContract).toHaveBeenCalledWith(
      "/payments/mock/PAY-1/succeed",
      expect.any(Object),
      expect.any(Object),
      {},
    );
    expect(postContract).toHaveBeenCalledWith(
      "/payments/mock/PAY-2/fail",
      expect.any(Object),
      expect.any(Object),
      {},
    );
  });

  it("uses schema-bound helpers for provider and provider-config writes", async () => {
    await updatePaymentProvider("550e8400-e29b-41d4-a716-446655440010", {
      name: "Wechat Pay",
      status: "enabled",
      capabilities: { qrCode: true },
    });
    await updatePaymentProviderConfig("550e8400-e29b-41d4-a716-446655440011", {
      merchantNo: null,
      publicConfigJson: {
        qrExpiresMinutes: 10,
      },
    });
    await upsertPaymentProviderConfig({
      providerCode: "alipay",
      merchantNo: "mch-1",
      appId: "app-1",
      publicConfigJson: {
        mode: "sandbox",
        gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
        keyType: "PKCS8",
      },
      sensitiveConfigJson: {
        privateKeyPem: "-----BEGIN PRIVATE KEY-----\nkey",
      },
    });

    expect(patchContract).toHaveBeenCalledWith(
      "/payments/providers/550e8400-e29b-41d4-a716-446655440010",
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ name: "Wechat Pay" }),
    );
    expect(patchContract).toHaveBeenCalledWith(
      "/payments/provider-configs/550e8400-e29b-41d4-a716-446655440011",
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ merchantNo: null }),
    );
    expect(postContract).toHaveBeenCalledWith(
      "/payments/provider-configs",
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ providerCode: "alipay" }),
    );
  });

  it("rejects invalid provider config bodies through the schema-bound helper", async () => {
    vi.mocked(postContract).mockImplementation(
      async (_url, bodySchema, _responseSchema, body) => {
        (bodySchema as { parse(value: unknown): unknown }).parse(body);
        return {} as never;
      },
    );

    await expect(
      upsertPaymentProviderConfig({
        providerCode: "alipay",
        publicConfigJson: {
          gatewayUrl: "not-a-url",
        },
      } as never),
    ).rejects.toThrow();
  });

  it("sends a reason when querying a refund", async () => {
    await queryRefund(
      "550e8400-e29b-41d4-a716-446655440001",
      "customer requested refund status check",
    );

    expect(postContract).toHaveBeenCalledWith(
      "/payments/refunds/550e8400-e29b-41d4-a716-446655440001/query",
      expect.any(Object),
      expect.any(Object),
      { reason: "customer requested refund status check" },
    );
  });

  it("sends a reason when querying a payment-code attempt", async () => {
    await queryPaymentCodeAttempt(
      "550e8400-e29b-41d4-a716-446655440002",
      "customer app is still confirming",
    );

    expect(postContract).toHaveBeenCalledWith(
      "/payments/payment-code-attempts/550e8400-e29b-41d4-a716-446655440002/query",
      expect.any(Object),
      expect.any(Object),
      { reason: "customer app is still confirming" },
    );
  });

  it("uses shared operator action schemas for payment incident actions", async () => {
    await reversePaymentCodeAttempt(
      "550e8400-e29b-41d4-a716-446655440003",
      "customer cancelled while provider stayed confirming",
    );

    expect(postContract).toHaveBeenCalledWith(
      "/payments/payment-code-attempts/550e8400-e29b-41d4-a716-446655440003/reverse",
      expect.any(Object),
      expect.any(Object),
      {
        reason: "customer cancelled while provider stayed confirming",
      },
    );
  });
});
