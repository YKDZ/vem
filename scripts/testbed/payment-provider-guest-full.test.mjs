import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildProviderFailureReport,
  parsePaymentProviderGuestArgs,
  sanitizeProviderEvidence,
  validateHostLocalSandboxFixture,
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

  it("proves only a non-paid QR creation, query, and closure", () => {
    assert.doesNotThrow(() =>
      validateUnattendedProviderAttempt({
        channel: "qr_code:alipay",
        order: {
          providerCode: "alipay",
          orderId: "order-1",
          paymentId: "payment-1",
          orderNo: "order-no-1",
        },
        credential: { present: true },
        query: {
          status: "pending",
          reconciliationState: "provider_trade_not_exist",
        },
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
          query: { status: "succeeded" },
          closure: {
            action: "close_or_reverse_uncertain_payment",
            status: "canceled",
            handled: true,
          },
          terminal: {
            paymentStatus: "succeeded",
            orderStatus: "fulfilled",
            paymentState: "paid",
            reservedInventory: false,
          },
        }),
      /must not claim a paid customer result/,
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
  });

  it("requires an installation-owned fixture for the VM-local Service API", () => {
    assert.equal(
      validateHostLocalSandboxFixture({
        schemaVersion: "vem-host-local-alipay-sandbox-fixture/v1",
        ownership: "host-local-installation",
        target: "local-service-api",
        providerConfig: { providerCode: "alipay" },
      }).providerConfig.providerCode,
      "alipay",
    );
    assert.throws(
      () =>
        validateHostLocalSandboxFixture({
          schemaVersion: "vem-host-local-alipay-sandbox-fixture/v1",
          ownership: "vps",
          target: "local-service-api",
          providerConfig: { providerCode: "alipay" },
        }),
      /installation-owned/,
    );
  });
});
