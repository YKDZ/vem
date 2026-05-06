import { describe, expect, it } from "vitest";

import type { StorageLike } from "./command-log";

import {
  enqueueOutboxEvent,
  flushOutboxEvents,
  listOutboxEvents,
  OutboxCapacityError,
  OUTBOX_MAX_EVENTS,
  OUTBOX_TTL_MS,
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

  it("removes expired events (older than TTL)", () => {
    const storage = memoryStorage();
    const oldMs = Date.now() - OUTBOX_TTL_MS - 1_000;
    // Manually write an event with old createdAtMs
    storage.setItem(
      "vem.machine.outbox.v1",
      JSON.stringify([
        {
          id: "old:1",
          kind: "heartbeat",
          topic: "t",
          payload: {},
          createdAtMs: oldMs,
          nextAttemptAtMs: oldMs,
          attemptCount: 0,
          lastError: null,
        },
      ]),
    );
    const events = listOutboxEvents(storage);
    expect(events).toHaveLength(0);
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
    storage.setItem("vem.machine.outbox.v1", "NOT_VALID_JSON{{");
    listOutboxEvents(storage);
    expect(removed).toBe(true);
    expect(listOutboxEvents(storage)).toHaveLength(0);
  });

  it("throws OutboxCapacityError when queue is full", () => {
    const storage = memoryStorage();
    const events = Array.from({ length: OUTBOX_MAX_EVENTS }, (_, i) => ({
      id: `heartbeat:${i}`,
      kind: "heartbeat" as const,
      topic: "t",
      payload: {},
      createdAtMs: Date.now(),
      nextAttemptAtMs: Date.now(),
      attemptCount: 0,
      lastError: null,
    }));
    storage.setItem("vem.machine.outbox.v1", JSON.stringify(events));
    expect(() =>
      enqueueOutboxEvent(
        { id: "new:event", kind: "heartbeat", topic: "t", payload: {} },
        storage,
      ),
    ).toThrow(OutboxCapacityError);
    // Original 500 events must remain intact
    expect(listOutboxEvents(storage)).toHaveLength(OUTBOX_MAX_EVENTS);
  });
});
