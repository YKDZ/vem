import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  assertNoAttemptOrDuplicatePayment,
  combineCleanupError,
  parseScannerPaymentCodeGuestArgs,
  pnpObservationMatchesDaemonIdentity,
  pnpObservationMatchesLibvirtTopology,
  scannerFrameBytes,
  runCleanupStep,
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
    assert.match(source, /await scannerEventCapture\.opened/);
    assert.match(source, /stop-scanner-probe/);
    assert.match(source, /scannerQuietBoundary/);
    assert.match(source, /matchesStableGuestUsbIdentity/);
    assert.match(source, /movement\.quantity/);
    assert.doesNotMatch(source, /scannerEventId !==\s*attemptSnapshot\?\.paymentCodeAttempt\?\.scannerEventId/);
    assert.match(source, /\/v1\/serial-sessions\/.*\/wait-frame/);
  });

  it("correlates an independently observed Windows PnP location to libvirt USB topology", () => {
    const observation = {
      currentPort: "COM17",
      pnpDeviceId: "USB\\VID_1B36&PID_0001\\5&1234&0&2",
      locationPaths: ["PCIROOT(0)#PCI(0100)#USBROOT(0)#USB(3)#USB(2)"],
      locationInformation: "Port_#0002.Hub_#0003",
      address: 2,
    };
    assert.equal(
      pnpObservationMatchesLibvirtTopology(observation, {
        alias: "serial-scanner",
        targetPort: 1,
        usbBus: 0,
        usbPort: "3.2",
      }),
      true,
    );
    assert.equal(
      pnpObservationMatchesLibvirtTopology(observation, {
        alias: "serial-lower-controller",
        targetPort: 0,
        usbBus: 0,
        usbPort: "3.1",
      }),
      false,
    );
    assert.equal(
      pnpObservationMatchesDaemonIdentity(observation, {
        instanceId: "usb\\vid_1b36&pid_0001\\5&1234&0&2",
        containerId: null,
      }),
      true,
    );
    assert.equal(
      pnpObservationMatchesDaemonIdentity(observation, {
        instanceId: "USB\\VID_1B36&PID_0001\\OTHER",
        containerId: null,
      }),
      false,
    );
    assert.equal(
      pnpObservationMatchesDaemonIdentity(
        { ...observation, containerId: "{11111111-2222-3333-4444-555555555555}" },
        {
          instanceId: observation.pnpDeviceId,
          containerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        },
      ),
      false,
    );
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

  it("requires one paid transaction, completed command, and exactly one total post-F2 movement", () => {
    const sale = { orderId: "order-20", paymentId: "payment-20", orderNo: "ORDER-20" };
    const baseline = {
      raw: {
        payments: [{ id: sale.paymentId, orderId: sale.orderId, status: "created" }],
        inventories: [{ id: "inventory-20", onHandQty: 2 }],
      },
    };
    const post = {
      raw: {
        orders: [{ id: sale.orderId, orderNo: sale.orderNo, paymentState: "paid", status: "fulfilled", fulfillmentState: "dispensed" }],
        orderItems: [{ id: "order-item-20", orderId: sale.orderId, inventoryId: "inventory-20", slotId: "slot-20", quantity: 1, fulfillmentStatus: "dispensed" }],
        payments: [{ id: sale.paymentId, orderId: sale.orderId, status: "succeeded" }],
        paymentCodeAttempts: [{ paymentId: sale.paymentId, orderId: sale.orderId, status: "succeeded", isActive: false, source: "serial_text", scannerEventId: "scanner-event-20", attemptNo: 1, idempotencyKey: "scanner-attempt-20" }],
        commands: [{ id: "command-20", commandNo: "COMMAND-20", orderId: sale.orderId, orderItemId: "order-item-20", slotId: "slot-20", commandKind: "dispatch", status: "succeeded" }],
        movements: [{ orderNo: sale.orderNo, commandNo: "COMMAND-20", orderItemId: "order-item-20", inventoryId: "inventory-20", slotId: "slot-20", quantity: 1, movementType: "dispense_succeeded", status: "accepted" }],
        inventories: [{ id: "inventory-20", onHandQty: 1 }],
      },
    };
    const result = validateSuccessfulOutcome({
      baseline,
      post,
      renderedSale: sale,
      command: { vendingCommandId: "command-20", vendingCommandNo: "COMMAND-20" },
      attemptSnapshot: { paymentCodeAttempt: { scannerEventId: "scanner-event-20", attemptNo: 1, idempotencyKey: "scanner-attempt-20" } },
      scannerEvent: { type: "scanner_code", source: "serial_text", eventId: "scanner-event-20" },
      afterF2Ui: { route: "#/result/success", result: { kind: "success", orderId: sale.orderId, paymentId: sale.paymentId, commandId: "command-20" } },
    });
    assert.equal(result.finalPaymentCount, 1);
    assert.equal(result.command.status, "succeeded");
    assert.equal(result.inventory.deltaOnHandQty, -1);

    post.raw.movements.push({
      ...post.raw.movements[0],
      commandNo: "UNRELATED-COMMAND",
      movementType: "manual_adjustment",
    });
    assert.throws(
      () => validateSuccessfulOutcome({
        baseline,
        post,
        renderedSale: sale,
        command: { vendingCommandId: "command-20", vendingCommandNo: "COMMAND-20" },
        attemptSnapshot: { paymentCodeAttempt: { scannerEventId: "scanner-event-20", attemptNo: 1, idempotencyKey: "scanner-attempt-20" } },
        scannerEvent: { type: "scanner_code", source: "serial_text", eventId: "scanner-event-20" },
        afterF2Ui: { route: "#/result/success", result: { kind: "success", orderId: sale.orderId, paymentId: sale.paymentId, commandId: "command-20" } },
      }),
      /exactly one total movement for the order/,
    );
  });

  it("rejects a movement that does not carry the completed command number", () => {
    const sale = { orderId: "order-21", paymentId: "payment-21", orderNo: "ORDER-21" };
    const baseline = { raw: { inventories: [{ id: "inventory-21", onHandQty: 2 }] } };
    const post = {
      raw: {
        orders: [{ id: sale.orderId, orderNo: sale.orderNo, paymentState: "paid", status: "fulfilled", fulfillmentState: "dispensed" }],
        orderItems: [{ id: "order-item-21", orderId: sale.orderId, inventoryId: "inventory-21", slotId: "slot-21", quantity: 1, fulfillmentStatus: "dispensed" }],
        payments: [{ id: sale.paymentId, orderId: sale.orderId, status: "succeeded" }],
        paymentCodeAttempts: [{ paymentId: sale.paymentId, orderId: sale.orderId, status: "succeeded", isActive: false, source: "serial_text", scannerEventId: "scanner-event-21", attemptNo: 1, idempotencyKey: "scanner-attempt-21" }],
        commands: [{ id: "command-21", commandNo: "COMMAND-21", orderId: sale.orderId, orderItemId: "order-item-21", slotId: "slot-21", commandKind: "dispatch", status: "succeeded" }],
        movements: [{ orderNo: sale.orderNo, commandNo: "OTHER-COMMAND", orderItemId: "order-item-21", inventoryId: "inventory-21", slotId: "slot-21", quantity: 1, movementType: "dispense_succeeded", status: "accepted" }],
        inventories: [{ id: "inventory-21", onHandQty: 1 }],
      },
    };
    assert.throws(
      () => validateSuccessfulOutcome({
        baseline,
        post,
        renderedSale: sale,
        command: { vendingCommandId: "command-21", vendingCommandNo: "COMMAND-21" },
        attemptSnapshot: { paymentCodeAttempt: { scannerEventId: "scanner-event-21", attemptNo: 1, idempotencyKey: "scanner-attempt-21" } },
        scannerEvent: { type: "scanner_code", source: "serial_text", eventId: "scanner-event-21" },
        afterF2Ui: { route: "#/result/success", result: { kind: "success", orderId: sale.orderId, paymentId: sale.paymentId, commandId: "command-21" } },
      }),
      /command-bound movement/,
    );
  });

  it("preserves a string or Buffer frame with exactly one CRLF suffix", () => {
    const expected = Buffer.from("621234567890123456\r\n");
    assert.deepEqual(scannerFrameBytes("621234567890123456\r\n"), expected);
    assert.deepEqual(scannerFrameBytes(expected), expected);
    assert.throws(() => scannerFrameBytes("621234567890123456"));
    assert.throws(() => scannerFrameBytes("6212\r\n3456\r\n"));
  });

  it("fails closed when cleanup abort fails and preserves the primary error", async () => {
    const primary = new Error("main failed");
    let cleanup;
    await assert.rejects(async () => {
      await runCleanupStep("abort serial session", async () => {
        throw new Error("abort endpoint down");
      });
    });
    try {
      await runCleanupStep("abort serial session", async () => {
        throw new Error("abort endpoint down");
      });
    } catch (error) {
      cleanup = error;
    }
    const combined = combineCleanupError(primary, [cleanup]);
    assert.equal(combined instanceof AggregateError, true);
    assert.equal(combined.errors[0], primary);
    assert.match(combined.message, /main failed/);
    assert.match(combined.message, /abort serial session failed/);
  });

  it("contains fail-closed final abort cleanup", () => {
    const source = readFileSync(
      new URL("./scanner-payment-code-guest-full.mjs", import.meta.url),
      "utf8",
    );

    assert.match(source, /runCleanupStep\("abort serial session"/);
    assert.match(source, /serial session abort did not confirm inactive state/);
    assert.match(source, /combineCleanupError/);
    assert.match(source, /cleanup failed:/);
  });
});
