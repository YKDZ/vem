import { describe, expect, it } from "vitest";

import {
  mapPaymentProviderConfigUpsertDtoToPatch,
  mapPaymentProviderConfigUpsertDtoToInsert,
  mapPaymentProviderConfigUpdateDtoToPatch,
  mapPaymentProviderDtoToPatch,
  mapManualPaymentReconciliationAttemptToInsert,
  mapMockPaymentEventToInsert,
} from "./payments.contract-mappers";

describe("payment contract mappers", () => {
  it("maps provider updates to supported database fields", () => {
    const patch = mapPaymentProviderDtoToPatch({
      name: "Wechat Pay",
      status: "enabled",
      capabilities: { qrCode: true },
    });

    expect(patch).toMatchObject({
      name: "Wechat Pay",
      status: "enabled",
      capabilities: { qrCode: true },
    });
    expect(patch).not.toHaveProperty("providerCode");
  });

  it("maps provider config partial updates without undefined database writes", () => {
    const patch = mapPaymentProviderConfigUpdateDtoToPatch(
      "admin-1",
      {
        merchantNo: null,
        publicConfigJson: { qrExpiresMinutes: 10 },
      },
      { publicConfigJson: { timeoutCompensationSeconds: 120 } },
    );

    expect(patch).toMatchObject({
      merchantNo: null,
      publicConfigJson: {
        timeoutCompensationSeconds: 120,
        qrExpiresMinutes: 10,
      },
      updatedByAdminUserId: "admin-1",
    });
    expect(patch).not.toHaveProperty("appId");
    expect(patch).not.toHaveProperty("providerCode");
  });

  it("maps provider config upserts with explicit secret payload boundary", () => {
    const insert = mapPaymentProviderConfigUpsertDtoToInsert(
      "provider-1",
      "admin-1",
      {
        providerCode: "alipay",
        merchantNo: "mch-1",
        appId: "app-1",
        publicConfigJson: {
          gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
          keyType: "PKCS8",
        },
        sensitiveConfigJson: {
          privateKeyPem: "-----BEGIN PRIVATE KEY-----\nkey",
        },
        status: "enabled",
      },
      { encrypted: { v: 1 } },
    );

    expect(insert).toMatchObject({
      providerId: "provider-1",
      machineId: null,
      merchantNo: "mch-1",
      appId: "app-1",
      publicConfigJson: {
        gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
        keyType: "PKCS8",
      },
      configEncryptedJson: { encrypted: { v: 1 } },
      status: "enabled",
      updatedByAdminUserId: "admin-1",
    });
    expect(insert).not.toHaveProperty("providerCode");
    expect(insert).not.toHaveProperty("sensitiveConfigJson");
  });

  it("preserves explicit null provider config upsert fields as clears", () => {
    const patch = mapPaymentProviderConfigUpsertDtoToPatch(
      "admin-1",
      {
        providerCode: "alipay",
        merchantNo: null,
        appId: null,
        status: "disabled",
      },
      { encrypted: { v: 1 } },
      {},
      {
        merchantNo: "old-merchant",
        appId: "old-app",
        status: "enabled",
      },
    );

    expect(patch).toMatchObject({
      merchantNo: null,
      appId: null,
      status: "disabled",
    });
  });

  it("maps payment incident action inserts to supported database fields", () => {
    const event = mapMockPaymentEventToInsert({
      paymentId: "payment-1",
      providerId: "provider-1",
      paymentNo: "PAY-1",
      event: "fail",
      rawPayloadJson: { paymentNo: "PAY-1", event: "fail" },
    });
    expect(event).toMatchObject({
      paymentId: "payment-1",
      providerId: "provider-1",
      eventType: "mock.payment.failed",
      providerEventId: "mock:fail:PAY-1",
      signatureValid: true,
    });
    expect(event).not.toHaveProperty("operatorReason");

    const attempt = mapManualPaymentReconciliationAttemptToInsert({
      paymentId: "payment-1",
      providerId: "provider-1",
      attemptNo: 2,
      startedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    expect(attempt).toMatchObject({
      paymentId: "payment-1",
      providerId: "provider-1",
      trigger: "manual",
      attemptNo: 2,
      status: "pending",
    });
    expect(attempt).not.toHaveProperty("reason");
  });
});
