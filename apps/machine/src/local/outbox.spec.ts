import { describe, expect, it } from "vitest";

import type { StorageLike } from "./command-log";

import {
  enqueueOutboxEvent,
  flushOutboxEvents,
  listOutboxEvents,
} from "./outbox";

function memoryStorage(): StorageLike {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
}

describe("outbox", () => {
  it("dedupes events by id", () => {
    const storage = memoryStorage();
    enqueueOutboxEvent(
      { id: "ack:CMD1", kind: "command_ack", topic: "t", payload: {} },
      storage,
    );
    enqueueOutboxEvent(
      { id: "ack:CMD1", kind: "command_ack", topic: "t", payload: {} },
      storage,
    );
    expect(listOutboxEvents(storage)).toHaveLength(1);
  });

  it("removes sent event after successful flush", async () => {
    const storage = memoryStorage();
    enqueueOutboxEvent(
      { id: "result:CMD1", kind: "dispense_result", topic: "t", payload: {} },
      storage,
    );
    const result = await flushOutboxEvents(async () => undefined, storage);
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(listOutboxEvents(storage)).toHaveLength(0);
  });
});
