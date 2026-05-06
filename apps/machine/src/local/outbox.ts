import type { StorageLike } from "./command-log";

const OUTBOX_KEY = "vem.machine.outbox.v1";

export const OUTBOX_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const OUTBOX_MAX_EVENTS = 500;

export type OutboxEventKind = "command_ack" | "dispense_result" | "heartbeat";

export type OutboxEvent = {
  id: string;
  kind: OutboxEventKind;
  topic: string;
  payload: unknown;
  createdAtMs: number;
  nextAttemptAtMs: number;
  attemptCount: number;
  lastError: string | null;
};

type OutboxMaintenanceResult = {
  events: OutboxEvent[];
  removedExpired: number;
  corrupted: boolean;
};

export class OutboxCapacityError extends Error {
  constructor(max: number) {
    super(
      `Outbox queue full (${max}); fix connectivity before enqueueing more events`,
    );
    this.name = "OutboxCapacityError";
  }
}

function isOutboxEvents(v: unknown): v is OutboxEvent[] {
  return Array.isArray(v);
}

function writeAll(storage: StorageLike, events: OutboxEvent[]): void {
  storage.setItem(OUTBOX_KEY, JSON.stringify(events));
}

function readAndCompact(
  storage: StorageLike,
  nowMs = Date.now(),
): OutboxMaintenanceResult {
  const raw = storage.getItem(OUTBOX_KEY);
  if (!raw) return { events: [], removedExpired: 0, corrupted: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    storage.removeItem(OUTBOX_KEY);
    return { events: [], removedExpired: 0, corrupted: true };
  }

  if (!isOutboxEvents(parsed)) {
    storage.removeItem(OUTBOX_KEY);
    return { events: [], removedExpired: 0, corrupted: true };
  }

  const original = parsed;
  const fresh = original.filter(
    (event) => nowMs - event.createdAtMs <= OUTBOX_TTL_MS,
  );
  const removedExpired = original.length - fresh.length;
  if (removedExpired > 0) {
    writeAll(storage, fresh);
  }
  return { events: fresh, removedExpired, corrupted: false };
}

export function listOutboxEvents(
  storage: StorageLike = globalThis.localStorage,
): OutboxEvent[] {
  return readAndCompact(storage).events;
}

export function getOutboxStats(
  storage: StorageLike = globalThis.localStorage,
): { size: number; max: number; ttlMs: number; usageRatio: number } {
  const events = readAndCompact(storage).events;
  return {
    size: events.length,
    max: OUTBOX_MAX_EVENTS,
    ttlMs: OUTBOX_TTL_MS,
    usageRatio: events.length / OUTBOX_MAX_EVENTS,
  };
}

export function enqueueOutboxEvent(
  input: Pick<OutboxEvent, "kind" | "topic" | "payload"> & { id?: string },
  storage: StorageLike = globalThis.localStorage,
): OutboxEvent {
  const events = readAndCompact(storage).events;
  const existing = input.id
    ? events.find((event) => event.id === input.id)
    : null;
  if (existing) return existing;

  if (events.length >= OUTBOX_MAX_EVENTS) {
    throw new OutboxCapacityError(OUTBOX_MAX_EVENTS);
  }

  const createdAtMs = Date.now();
  const event: OutboxEvent = {
    id: input.id ?? `${input.kind}:${createdAtMs}:${crypto.randomUUID()}`,
    kind: input.kind,
    topic: input.topic,
    payload: input.payload,
    createdAtMs,
    nextAttemptAtMs: createdAtMs,
    attemptCount: 0,
    lastError: null,
  };
  events.push(event);
  writeAll(storage, events);
  return event;
}

export function removeOutboxEvent(
  id: string,
  storage: StorageLike = globalThis.localStorage,
): void {
  writeAll(
    storage,
    readAndCompact(storage).events.filter((event) => event.id !== id),
  );
}

export function markOutboxFailed(
  id: string,
  error: unknown,
  storage: StorageLike = globalThis.localStorage,
): void {
  const events = readAndCompact(storage).events.map((event) => {
    if (event.id !== id) return event;
    const attemptCount = event.attemptCount + 1;
    return {
      ...event,
      attemptCount,
      nextAttemptAtMs: Date.now() + Math.min(30_000, 1_000 * 2 ** attemptCount),
      lastError: error instanceof Error ? error.message : String(error),
    };
  });
  writeAll(storage, events);
}

export async function flushOutboxEvents(
  publish: (topic: string, payload: unknown, eventId: string) => Promise<void>,
  storage: StorageLike = globalThis.localStorage,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const nowMs = Date.now();

  const events = readAndCompact(storage, nowMs).events.filter(
    (e) => e.nextAttemptAtMs <= nowMs,
  );
  const settledResults = await Promise.allSettled(
    events.map(async (event) => {
      await publish(event.topic, event.payload, event.id);
      return event.id;
    }),
  );
  for (const [index, result] of settledResults.entries()) {
    if (result.status === "fulfilled") {
      removeOutboxEvent(result.value, storage);
      sent += 1;
    } else {
      markOutboxFailed(events[index].id, result.reason, storage);
      failed += 1;
    }
  }

  return { sent, failed };
}
