import { describe, expect, it } from "vitest";

import {
  getCommandLogEntry,
  isCommandInActiveWindow,
  markCommandResult,
  markCommandStatus,
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
  slot: { layerNo: 1, cellNo: 1, slotCode: "A1" },
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
});
