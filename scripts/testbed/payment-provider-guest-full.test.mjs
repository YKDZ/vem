import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  UNATTENDED_ALIPAY_CUSTOMER_CODE,
  buildPaymentCodeSubmission,
  buildProviderFailureReport,
  classifyProviderFailureOutcome,
  collectPaymentProviderFailureEvidence,
  isCleanAuthoritativeTransaction,
  parsePaymentProviderGuestArgs,
  sanitizeProviderEvidence,
  validateInstallationOwnedAlipaySandboxFixture,
  validateUnattendedProviderAttempt,
} from "./payment-provider-guest-full.mjs";

describe("payment provider guest full", () => {
  it("dismisses terminal result UI before awaiting authoritative cleanup", () => {
    const source = readFileSync(
      new URL("./payment-provider-guest-full.mjs", import.meta.url),
      "utf8",
    );
    const dismissIndex = source.indexOf("routeBeforeCleanup");
    const daemonCancelIndex = source.indexOf(
      "daemonCancel = await cancelCurrentDaemonOrder",
    );
    const waitIndex = source.indexOf(
      'label: "authoritative order cleanup before diagnostics"',
    );
    assert.ok(dismissIndex > 0);
    assert.ok(daemonCancelIndex > dismissIndex);
    assert.ok(waitIndex > daemonCancelIndex);
  });

  it("cancels daemon-owned active transactions even when no payment surface rendered", () => {
    const source = readFileSync(
      new URL("./payment-provider-guest-full.mjs", import.meta.url),
      "utf8",
    );
    assert.ok(
      source.includes(
        'currentBeforeCleanup = await daemon(handoff, "/v1/transactions/current")',
      ),
    );
    assert.ok(source.includes("!isCleanAuthoritativeTransaction(currentBeforeCleanup)"));
    assert.ok(source.includes('"/v1/intents/cancel-order"'));
    assert.ok(source.includes("current transaction orderNo"));
  });

  it("returns the installed Machine UI to catalog after provider attempts", () => {
    const source = readFileSync(
      new URL("./payment-provider-guest-full.mjs", import.meta.url),
      "utf8",
    );
    const paymentCodeIndex = source.indexOf(
      "await paymentCodeAttempt({",
      source.indexOf("runPaymentProviderGuest"),
    );
    const finalCleanupIndex = source.indexOf(
      "await cleanAuthoritativeOrderBeforeDiagnostics(client, handoff, timeoutMs);",
      paymentCodeIndex,
    );
    const passIndex = source.indexOf('report.outcome = "passed"', paymentCodeIndex);
    assert.ok(paymentCodeIndex > 0);
    assert.ok(finalCleanupIndex > paymentCodeIndex);
    assert.ok(passIndex > finalCleanupIndex);
  });

  it("reports checkout diagnostics when a payment surface never appears", () => {
    const source = readFileSync(
      new URL("./payment-provider-guest-full.mjs", import.meta.url),
      "utf8",
    );
    assert.ok(source.includes("readPaymentFlowDiagnostic"));
    assert.ok(
      source.includes(
        "Alipay payment surface did not appear after submit attempts",
      ),
    );
    assert.ok(source.includes("submitMethod"));
    assert.ok(source.includes("customerMessages"));
  });

  it("treats a completed previous sale as clean provider diagnostics state", () => {
    assert.equal(isCleanAuthoritativeTransaction(null), true);
    assert.equal(isCleanAuthoritativeTransaction({ orderId: null }), true);
    assert.equal(
      isCleanAuthoritativeTransaction({
        orderId: "order-1",
        paymentStatus: "succeeded",
        orderStatus: "fulfilled",
      }),
      true,
    );
    assert.equal(
      isCleanAuthoritativeTransaction({
        orderId: "order-2",
        paymentStatus: "succeeded",
        orderStatus: "paid",
      }),
      false,
    );
    assert.equal(
      isCleanAuthoritativeTransaction({
        orderId: "order-3",
        paymentStatus: "canceled",
        orderStatus: "canceled",
      }),
      true,
    );
  });

  it("classifies only explicit cleaned Alipay boundary failures as provider unavailable", () => {
    assert.equal(
      classifyProviderFailureOutcome({
        stage: "creation",
        error: new Error("支付宝支付通道暂不可用，请稍后重试"),
        report: { cleanupBeforeDiagnostics: { transaction: null } },
      }),
      "provider_unavailable",
    );
    assert.equal(
      classifyProviderFailureOutcome({
        stage: "creation",
        error: new Error("支付宝支付通道暂不可用，请稍后重试"),
        report: { cleanupBeforeDiagnostics: { ok: false } },
      }),
      "failed",
    );
    assert.equal(
      classifyProviderFailureOutcome({
        stage: "creation",
        error: new Error("Machine UI contract mismatch"),
        report: { cleanupBeforeDiagnostics: { transaction: null } },
      }),
      "failed",
    );
  });

  it("submits the unattended Alipay customer code with real CRLF bytes", () => {
    const bytes = Buffer.from(UNATTENDED_ALIPAY_CUSTOMER_CODE, "utf8");
    assert.deepEqual([...bytes.subarray(-2)], [0x0d, 0x0a]);
    assert.equal(bytes.length, 20);
  });

  it("accepts a real WAIT_BUYER_PAY response when it is deterministically closed", () => {
    assert.doesNotThrow(() =>
      validateUnattendedProviderAttempt({
        channel: "payment_code:alipay",
        order: {
          providerCode: "alipay",
          orderId: "order-1",
          paymentId: "payment-1",
          orderNo: "order-no-1",
        },
        machine: {
          boundary: "installed_machine_ui_cdp",
          paymentMethod: "payment_code",
          providerCode: "alipay",
          surface: {
            orderId: "order-1",
            paymentId: "payment-1",
            orderNo: "order-no-1",
          },
          scannerPrompt: "请出示付款码",
        },
        submission: {
          status: "user_confirming",
          providerCode: "alipay",
          attemptId: "attempt-1",
          providerStatus: "WAIT_BUYER_PAY",
          failureCode: null,
        },
        cleanup: {
          action: "close_or_reverse_uncertain_payment",
          closure: { handled: true },
          providerConfigId: "provider-config-1",
          serialSession: { action: "abort", aborted: true },
        },
        terminal: {
          paymentStatus: "canceled",
          orderStatus: "canceled",
          paymentState: "canceled",
          reservedInventory: false,
        },
      }),
    );
  });

  it("accepts a known sandbox uncertainty only after deterministic closure", () => {
    const attempt = {
      channel: "payment_code:alipay",
      order: {
        providerCode: "alipay",
        orderId: "order-1",
        paymentId: "payment-1",
        orderNo: "order-no-1",
      },
      machine: {
        boundary: "installed_machine_ui_cdp",
        paymentMethod: "payment_code",
        providerCode: "alipay",
        surface: {
          orderId: "order-1",
          paymentId: "payment-1",
          orderNo: "order-no-1",
        },
        scannerPrompt: "请出示付款码",
      },
      submission: {
        status: "querying",
        providerCode: "alipay",
        attemptId: "attempt-1",
        providerStatus: "UNKNOWN",
        failureCode: "PAYMENT_CODE_QUERY_UNKNOWN",
      },
      cleanup: {
        action: "close_or_reverse_uncertain_payment",
        closure: { handled: true },
        providerConfigId: "provider-config-1",
        serialSession: { action: "abort", aborted: true },
      },
      terminal: {
        paymentStatus: "canceled",
        orderStatus: "canceled",
        paymentState: "canceled",
        reservedInventory: false,
      },
    };
    assert.doesNotThrow(() => validateUnattendedProviderAttempt(attempt));
    attempt.submission.failureCode = "UNEXPECTED";
    assert.throws(
      () => validateUnattendedProviderAttempt(attempt),
      /gateway handling and deterministic closure/,
    );
  });

  it("accepts a reversed payment-code attempt after deterministic closure", () => {
    assert.doesNotThrow(() =>
      validateUnattendedProviderAttempt({
        channel: "payment_code:alipay",
        order: {
          providerCode: "alipay",
          orderId: "order-1",
          paymentId: "payment-1",
          orderNo: "order-no-1",
        },
        machine: {
          boundary: "installed_machine_ui_cdp",
          paymentMethod: "payment_code",
          providerCode: "alipay",
          surface: {
            orderId: "order-1",
            paymentId: "payment-1",
            orderNo: "order-no-1",
          },
          scannerPrompt: "请出示付款码",
        },
        submission: {
          status: "reversed",
          providerCode: "alipay",
          attemptId: "attempt-1",
          providerStatus: "cancel",
          failureCode: "payment_code_reverse_confirmed",
        },
        cleanup: {
          action: "close_or_reverse_uncertain_payment",
          closure: { handled: true },
          providerConfigId: "provider-config-1",
          serialSession: { action: "abort", aborted: true },
        },
        terminal: {
          paymentStatus: "failed",
          orderStatus: "canceled",
          paymentState: "canceled",
          reservedInventory: false,
        },
      }),
    );
  });

  it("accepts a reversed payment-code attempt when the cleanup action only observes the terminal state", () => {
    assert.doesNotThrow(() =>
      validateUnattendedProviderAttempt({
        channel: "payment_code:alipay",
        order: {
          providerCode: "alipay",
          orderId: "order-1",
          paymentId: "payment-1",
          orderNo: "order-no-1",
        },
        machine: {
          boundary: "installed_machine_ui_cdp",
          paymentMethod: "payment_code",
          providerCode: "alipay",
          surface: {
            orderId: "order-1",
            paymentId: "payment-1",
            orderNo: "order-no-1",
          },
          scannerPrompt: "请出示付款码",
        },
        submission: {
          status: "reversed",
          providerCode: "alipay",
          attemptId: "attempt-1",
          providerStatus: "cancel",
          failureCode: "payment_code_reverse_confirmed",
        },
        cleanup: {
          action: "close_or_reverse_uncertain_payment",
          closure: { handled: false },
          providerConfigId: "provider-config-1",
          serialSession: { action: "abort", aborted: true },
        },
        terminal: {
          paymentStatus: "failed",
          orderStatus: "canceled",
          paymentState: "canceled",
          reservedInventory: false,
        },
      }),
    );
  });

  it("accepts a queued payment-code cleanup once the durable worker reaches a clean terminal state", () => {
    assert.doesNotThrow(() =>
      validateUnattendedProviderAttempt({
        channel: "payment_code:alipay",
        order: {
          providerCode: "alipay",
          orderId: "order-1",
          paymentId: "payment-1",
          orderNo: "order-no-1",
        },
        machine: {
          boundary: "installed_machine_ui_cdp",
          paymentMethod: "payment_code",
          providerCode: "alipay",
          surface: {
            orderId: "order-1",
            paymentId: "payment-1",
            orderNo: "order-no-1",
          },
          scannerPrompt: "请出示付款码",
        },
        submission: {
          status: "user_confirming",
          providerCode: "alipay",
          attemptId: "attempt-1",
          providerStatus: "WAIT_BUYER_PAY",
          failureCode: null,
        },
        cleanup: {
          action: "close_or_reverse_uncertain_payment",
          closure: { handled: false, status: "reversing" },
          providerConfigId: "provider-config-1",
          serialSession: { action: "abort", aborted: true },
        },
        terminal: {
          paymentStatus: "failed",
          orderStatus: "canceled",
          paymentState: "payment_failed",
          reservedInventory: false,
        },
      }),
    );
  });

  it("places the provider status at the payment-code submission contract path", () => {
    assert.deepEqual(
      buildPaymentCodeSubmission({
        id: "attempt-1",
        status: "failed",
        providerCode: "alipay",
        providerStatus: "FAILED",
        failureCode: "ACQ.INVALID_AUTH_CODE",
        failureMessage: "invalid customer code",
      }),
      {
        status: "failed",
        providerCode: "alipay",
        attemptId: "attempt-1",
        failureCode: "ACQ.INVALID_AUTH_CODE",
        providerStatus: "FAILED",
        evidence: {
          providerStatus: "FAILED",
          failureCode: "ACQ.INVALID_AUTH_CODE",
          failureMessage: "invalid customer code",
        },
      },
    );
  });

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
          status: "manual_handling",
          handled: true,
          providerConfigId: "provider-config-1",
        },
        terminal: {
          paymentStatus: "unknown",
          orderStatus: "manual_handling",
          paymentState: "manual_handling",
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

  it("preserves the authoritative provider failure when recovery evidence fails", async () => {
    const recovery = await collectPaymentProviderFailureEvidence({
      cleanAuthoritativeOrder: async () => {
        throw new Error("cleanup control plane unavailable");
      },
      diagnosticRetries: async () => {
        throw new Error("diagnostic UI unavailable");
      },
    });
    const failure = buildProviderFailureReport({
      runId: "RUN-1",
      stage: "query",
      error: new Error("authoritative provider query rejected"),
      diagnostics: recovery.diagnostics,
      report: {
        cleanupBeforeDiagnostics: recovery.cleanupBeforeDiagnostics,
        error: { message: "must not replace the original failure" },
      },
    });

    assert.equal(
      failure.error.message,
      "authoritative provider query rejected",
    );
    assert.match(
      failure.cleanupBeforeDiagnostics.error.message,
      /cleanup control plane/,
    );
    assert.match(
      failure.diagnostics[0].error.message,
      /diagnostic UI unavailable/,
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
