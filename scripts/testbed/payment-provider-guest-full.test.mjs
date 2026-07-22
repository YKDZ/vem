import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildProviderFailureReport,
  parsePaymentProviderGuestArgs,
  sanitizeProviderEvidence,
  validateInstallationOwnedAlipaySandboxFixture,
  validateUnattendedProviderAttempt,
} from "./payment-provider-guest-full.mjs";

describe("payment provider guest full", () => {
  it("parses the existing full-mode guest runner contract", () => {
    const options = parsePaymentProviderGuestArgs([
      "--mode",
      "full",
      "--guest-input",
      "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      "--handoff",
      "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
      "--out",
      "C:\\ProgramData\\VEM\\testbed\\payment-provider.json",
    ]);
    assert.equal(options.mode, "full");
    assert.equal(options.fixtureKey, null);
  });

  it("requires provider API identifiers and installed Machine UI evidence", () => {
    assert.doesNotThrow(() =>
      validateUnattendedProviderAttempt({
        channel: "qr_code:alipay",
        order: {
          providerCode: "alipay",
          orderId: "order-1",
          paymentId: "payment-1",
          orderNo: "order-no-1",
        },
        machine: {
          boundary: "installed_machine_ui_cdp",
          paymentMethod: "qr_code",
          providerCode: "alipay",
          surface: {
            orderId: "order-1",
            paymentId: "payment-1",
            orderNo: "order-no-1",
          },
        },
        credential: { paymentUrlSha256: "sha256:credential" },
        query: {
          reconciliationAttemptId: "reconciliation-1",
          providerCode: "alipay",
          status: "provider_trade_not_exist",
          providerPaymentStatus: "pending",
        },
        closure: {
          action: "close_or_reverse_uncertain_payment",
          status: "canceled",
          handled: true,
          providerConfigId: "provider-config-1",
        },
        terminal: {
          paymentStatus: "canceled",
          orderStatus: "canceled",
          paymentState: "canceled",
          reservedInventory: false,
        },
      }),
    );
    assert.throws(
      () =>
        validateUnattendedProviderAttempt({
          channel: "qr_code:alipay",
          order: {
            providerCode: "alipay",
            orderId: "order-1",
            paymentId: "payment-1",
            orderNo: "order-no-1",
          },
          credential: { present: true },
          machine: {
            boundary: "installed_machine_ui_cdp",
            paymentMethod: "qr_code",
            providerCode: "alipay",
            surface: {
              orderId: "order-1",
              paymentId: "payment-1",
              orderNo: "order-no-1",
            },
          },
          query: { reconciliationState: "provider_trade_not_exist" },
          closure: {
            action: "close_or_reverse_uncertain_payment",
            status: "canceled",
            handled: true,
          },
          terminal: {
            paymentStatus: "canceled",
            orderStatus: "canceled",
            paymentState: "canceled",
            reservedInventory: false,
          },
        }),
      /QR provider attempt did not prove/,
    );
  });

  it("limits diagnostics and redacts provider responses", () => {
    assert.deepEqual(
      sanitizeProviderEvidence({
        code: "40004",
        sub_code: "ACQ.TRADE_NOT_EXIST",
        privateKeyPem: "secret",
        auth_code: "28763443825664394",
        nested: {
          notifyUrl: "https://secret.example.test",
          trade_status: "WAIT_BUYER_PAY",
        },
      }),
      {
        code: "40004",
        sub_code: "ACQ.TRADE_NOT_EXIST",
        nested: { trade_status: "WAIT_BUYER_PAY" },
      },
    );
    const report = buildProviderFailureReport({
      runId: "RUN-1",
      stage: "query",
      error: new Error("provider unavailable"),
      diagnostics: [
        { channel: "qr_code:alipay" },
        { channel: "payment_code:alipay" },
        { channel: "extra" },
      ],
    });
    assert.equal(report.ok, false);
    assert.equal(report.diagnostics.length, 2);
    assert.throws(
      () =>
        buildProviderFailureReport({
          runId: "RUN-1",
          stage: "unclassified",
          error: new Error("provider unavailable"),
        }),
      /failure stage is invalid/,
    );
  });

  it("requires an installation-owned fixture and rejects guest secret transport", () => {
    assert.equal(
      validateInstallationOwnedAlipaySandboxFixture({
        schemaVersion: "vem-installation-alipay-sandbox-fixture/v1",
        ownership: "host-installation",
        target: "local-service-api",
        providerConfig: {
          providerCode: "alipay",
          appId: "9021000163629927",
          merchantNo: "2088721101045878",
          publicConfigJson: {
            mode: "sandbox",
            gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
            keyType: "PKCS1",
          },
          sensitiveConfigJson: { privateKeyPem: "not-in-repository" },
        },
      }).providerConfig.providerCode,
      "alipay",
    );
    assert.throws(
      () =>
        validateInstallationOwnedAlipaySandboxFixture({
          schemaVersion: "vem-installation-alipay-sandbox-fixture/v1",
          ownership: "guest",
          target: "local-service-api",
          providerConfig: { providerCode: "alipay" },
        }),
      /installation-owned/,
    );
  });
});
