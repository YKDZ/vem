import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { createProductionTransactionTrace } from "./production-transaction-trace.mjs";

describe("production transaction trace", () => {
  it("records real boundary facts in payment -> F0 -> F1 -> F2 -> result order", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-production-trace-"));
    let nowMs = Date.parse("2026-07-18T04:00:00.000Z");
    const trace = createProductionTransactionTrace({
      stateRoot: root,
      sessionId: "session-1",
      now: () => new Date(nowMs).toISOString(),
    });
    try {
      trace.payment({
        orderId: "order-1",
        paymentId: "payment-1",
        commandId: "command-1",
        paymentNo: "payment-no-1",
      });
      for (const opcode of ["F0", "F1", "F2"]) {
        nowMs += 10;
        trace.controllerFrame({
          parsedOpcode: opcode,
          rawFrameHex: `55${opcode}`,
          direction: "controller-to-daemon",
          sequence: 1,
        });
      }
      nowMs += 10;
      trace.result({
        route: "#/result/success",
        result: {
          kind: "success",
          orderId: "order-1",
          paymentId: "payment-1",
          commandId: "command-1",
        },
      });
      assert.deepEqual(
        trace.validate().map((entry) => entry.type),
        ["payment", "F0", "F1", "F2", "result"],
      );
      assert.equal(trace.entries()[1].rawFrame.boundaryId, "f0:2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a successful UI surface before the F2 raw frame", () => {
    const root = mkdtempSync(join(tmpdir(), "vem-production-trace-"));
    const trace = createProductionTransactionTrace({
      stateRoot: root,
      sessionId: "session-1",
    });
    try {
      trace.payment({
        orderId: "order-1",
        paymentId: "payment-1",
        commandId: "command-1",
        paymentNo: "payment-no-1",
      });
      assert.throws(
        () =>
          trace.result({
            route: "#/result/success",
            result: {
              kind: "success",
              orderId: "order-1",
              paymentId: "payment-1",
              commandId: "command-1",
            },
          }),
        /rejects success before F2/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
