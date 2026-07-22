import { describe, expect, it } from "vitest";

import {
  getCommandLogEntry,
  isCommandInActiveWindow,
  listCustomerErrorEvidence,
  markCommandResult,
  markCommandStatus,
  recordCustomerErrorEvidence,
  COMMAND_LOG_MAX_ENTRIES,
  COMMAND_LOG_TTL_MS,
  type StorageLike,
} from "./command-log";

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

const command = {
  commandNo: "CMD1",
  orderNo: "ORD1",
  slot: { rowNo: 1, cellNo: 1, slotDisplayLabel: "A1" },
  quantity: 1,
  timeoutSeconds: 2,
};

describe("command log", () => {
  it("persists command result for idempotent duplicate handling", () => {
    const storage = memoryStorage();
    markCommandStatus(command, "dispensing", storage);
    markCommandResult(
      command,
      {
        commandNo: "CMD1",
        success: true,
        errorCode: null,
        message: "ok",
        reportedAt: "2026-05-05T12:00:00.000Z",
      },
      storage,
    );

    expect(getCommandLogEntry("CMD1", storage)?.resultPayload?.success).toBe(
      true,
    );
  });

  it("detects active dispensing window", () => {
    const storage = memoryStorage();
    const entry = markCommandStatus(command, "dispensing", storage);
    expect(isCommandInActiveWindow(entry, entry.updatedAtMs + 1_000)).toBe(
      true,
    );
    expect(isCommandInActiveWindow(entry, entry.updatedAtMs + 8_000)).toBe(
      false,
    );
  });

  it("removes entries older than TTL", () => {
    const storage = memoryStorage();
    const oldMs = Date.now() - COMMAND_LOG_TTL_MS - 1_000;
    storage.setItem(
      "vem.machine.commandLog.v1",
      JSON.stringify({
        OLD1: {
          commandNo: "OLD1",
          orderNo: "ORD_OLD",
          status: "succeeded",
          command,
          resultPayload: null,
          updatedAtMs: oldMs,
        },
      }),
    );
    expect(getCommandLogEntry("OLD1", storage)).toBeNull();
  });

  it("calls removeItem on corrupted JSON", () => {
    const data = new Map<string, string>();
    let removed = false;
    const storage: StorageLike = {
      getItem: (key) => data.get(key) ?? null,
      setItem: (key, value) => data.set(key, value),
      removeItem: (key) => {
        data.delete(key);
        removed = true;
      },
    };
    storage.setItem("vem.machine.commandLog.v1", "NOT_VALID{{");
    getCommandLogEntry("X", storage);
    expect(removed).toBe(true);
  });

  it("retains at most COMMAND_LOG_MAX_ENTRIES newest entries", () => {
    const storage = memoryStorage();
    const nowMs = Date.now();
    const entries: Record<string, unknown> = {};
    for (let i = 0; i < COMMAND_LOG_MAX_ENTRIES + 10; i += 1) {
      const key = `CMD${i}`;
      entries[key] = {
        commandNo: key,
        orderNo: "ORD",
        status: "succeeded",
        command: { ...command, commandNo: key },
        resultPayload: null,
        updatedAtMs: nowMs + i,
      };
    }
    storage.setItem("vem.machine.commandLog.v1", JSON.stringify(entries));
    // Trigger compaction
    const anyKey = `CMD${COMMAND_LOG_MAX_ENTRIES + 5}`;
    getCommandLogEntry(anyKey, storage);
    const remaining = Object.keys(
      JSON.parse(storage.getItem("vem.machine.commandLog.v1") ?? "{}"),
    );
    expect(remaining.length).toBeLessThanOrEqual(COMMAND_LOG_MAX_ENTRIES);
  });

  it("persists customer-error technical evidence for Local Operations", () => {
    const storage = memoryStorage();
    recordCustomerErrorEvidence(
      {
        stage: "payment_creation",
        customerMessage: "支付订单创建失败，请稍后重试",
        technicalMessage: "HTTP 502 provider create timed out",
        operation: "checkout.create_order",
        checkoutAttemptIdempotencyKey: "checkout:attempt-7",
        orderId: "order-7",
        paymentId: "payment-7",
        orderNo: "ORD-7",
      },
      storage,
    );

    expect(listCustomerErrorEvidence(storage)).toEqual([
      expect.objectContaining({
        checkoutAttemptIdempotencyKey: "checkout:attempt-7",
        technicalMessage: "HTTP 502 provider create timed out",
        orderId: "order-7",
        paymentId: "payment-7",
      }),
    ]);
  });

  it("drops malformed customer-error evidence from local storage", () => {
    const storage = memoryStorage();
    storage.setItem(
      "vem.machine.commandLog.v1.customer-errors",
      JSON.stringify([
        {
          evidenceId: "customer-error:invalid",
          technicalMessage: "missing required evidence fields",
          recordedAtMs: Date.now(),
        },
      ]),
    );

    expect(listCustomerErrorEvidence(storage)).toEqual([]);
  });
});
