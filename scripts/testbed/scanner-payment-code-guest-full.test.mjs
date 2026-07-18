import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  assertNoAttemptOrDuplicatePayment,
  parseScannerPaymentCodeGuestArgs,
  scannerFrameBytes,
  validateSuccessfulOutcome,
} from "./scanner-payment-code-guest-full.mjs";

describe("scanner payment-code guest full", () => {
  it("parses the dedicated full-mode guest contract", () => {
    const options = parseScannerPaymentCodeGuestArgs([
      "--mode",
      "full",
      "--guest-input",
      "C:\\ProgramData\\VEM\\testbed\\guest-input.json",
      "--handoff",
      "C:\\ProgramData\\VEM\\testbed\\installed-runtime-handoff.json",
      "--out",
      "C:\\ProgramData\\VEM\\testbed\\scanner-payment-code.json",
    ]);

    assert.equal(options.mode, "full");
    assert.equal(
      options.outPath,
      "C:\\ProgramData\\VEM\\testbed\\scanner-payment-code.json",
    );
  });

  it("contains malformed, timeout, and valid scanner byte paths bound to daemon scanner event ids", () => {
    const source = readFileSync(
      new URL("./scanner-payment-code-guest-full.mjs", import.meta.url),
      "utf8",
    );

    assert.match(source, /buildInstalledKioskSaleScenarioSteps\("vm-scanner-payment-code"\)/);
    assert.match(source, /MALFORMED_SCANNER_BYTES/);
    assert.match(source, /TIMEOUT_PARTIAL_SCANNER_BYTES/);
    assert.match(source, /scannerCodeBase64/);
    assert.match(source, /scannerEventId/);
    assert.match(source, /captureNextSerialScannerEvent/);
    assert.match(source, /baselineInventory\.onHandQty - finalInventory\.onHandQty !== 1/);
    assert.doesNotMatch(source, /scannerEventId !==\s*attemptSnapshot\?\.paymentCodeAttempt\?\.scannerEventId/);
    assert.match(source, /\/v1\/serial-sessions\/.*\/wait-frame/);
  });

  it("keeps malformed and timed-out raw bytes at platform attempt/payment delta 0", () => {
    const sale = { orderId: "order-20", paymentId: "payment-20", orderNo: "ORDER-20" };
    const baseline = {
      raw: { payments: [{ id: sale.paymentId, orderId: sale.orderId }], paymentCodeAttempts: [], movements: [] },
    };
    assert.doesNotThrow(() =>
      assertNoAttemptOrDuplicatePayment("malformed", baseline, baseline, sale),
    );
    assert.throws(
      () =>
        assertNoAttemptOrDuplicatePayment(
          "timeout",
          baseline,
          { raw: { ...baseline.raw, payments: [...baseline.raw.payments, { id: "duplicate", orderId: sale.orderId }] } },
          sale,
        ),
      /duplicated or replaced the payment row/,
    );
  });

  it("requires one serial-text scanner event, platform attempt, payment, and post-F2 movement", () => {
    const sale = { orderId: "order-20", paymentId: "payment-20", orderNo: "ORDER-20" };
    const baseline = {
      raw: {
        payments: [{ id: sale.paymentId, orderId: sale.orderId }],
        inventories: [{ id: "inventory-20", onHandQty: 2 }],
      },
    };
    const post = {
      raw: {
        payments: [{ id: sale.paymentId, orderId: sale.orderId }],
        paymentCodeAttempts: [{ paymentId: sale.paymentId, orderId: sale.orderId, status: "succeeded", isActive: false, source: "serial_text", scannerEventId: "scanner-event-20", attemptNo: 1, idempotencyKey: "scanner-attempt-20" }],
        movements: [{ orderNo: sale.orderNo, inventoryId: "inventory-20" }],
        inventories: [{ id: "inventory-20", onHandQty: 1 }],
      },
    };
    const result = validateSuccessfulOutcome({
      baseline,
      post,
      renderedSale: sale,
      command: { vendingCommandId: "command-20" },
      attemptSnapshot: { paymentCodeAttempt: { scannerEventId: "scanner-event-20", attemptNo: 1, idempotencyKey: "scanner-attempt-20" } },
      scannerEvent: { type: "scanner_code", source: "serial_text", eventId: "scanner-event-20" },
      afterF2Ui: { route: "#/result/success", result: { kind: "success", orderId: sale.orderId, paymentId: sale.paymentId, commandId: "command-20" } },
    });
    assert.equal(result.finalPaymentCount, 1);
  });

  it("preserves a string or Buffer frame with exactly one CRLF suffix", () => {
    const expected = Buffer.from("621234567890123456\r\n");
    assert.deepEqual(scannerFrameBytes("621234567890123456\r\n"), expected);
    assert.deepEqual(scannerFrameBytes(expected), expected);
    assert.throws(() => scannerFrameBytes("621234567890123456"));
    assert.throws(() => scannerFrameBytes("6212\r\n3456\r\n"));
  });
});
