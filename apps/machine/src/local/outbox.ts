import type { StorageLike } from "./command-log";

const OUTBOX_KEY = "vem.machine.outbox.v1";

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

function readAll(storage: StorageLike): OutboxEvent[] {
  const raw = storage.getItem(OUTBOX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as OutboxEvent[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(storage: StorageLike, events: OutboxEvent[]): void {
  storage.setItem(OUTBOX_KEY, JSON.stringify(events));
}

export function listOutboxEvents(
  storage: StorageLike = globalThis.localStorage,
): OutboxEvent[] {
  return readAll(storage);
}

export function enqueueOutboxEvent(
  input: Pick<OutboxEvent, "kind" | "topic" | "payload"> & { id?: string },
  storage: StorageLike = globalThis.localStorage,
): OutboxEvent {
  const events = readAll(storage);
  const existing = input.id
    ? events.find((event) => event.id === input.id)
    : null;
  if (existing) return existing;

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
    readAll(storage).filter((event) => event.id !== id),
  );
}

export function markOutboxFailed(
  id: string,
  error: unknown,
  storage: StorageLike = globalThis.localStorage,
): void {
  const events = readAll(storage).map((event) => {
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
  publish: (topic: string, payload: unknown) => Promise<void>,
  storage: StorageLike = globalThis.localStorage,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const nowMs = Date.now();

  for (const event of readAll(storage)) {
    if (event.nextAttemptAtMs > nowMs) continue;
    try {
      await publish(event.topic, event.payload);
      removeOutboxEvent(event.id, storage);
      sent += 1;
    } catch (error) {
      markOutboxFailed(event.id, error, storage);
      failed += 1;
    }
  }

  return { sent, failed };
}
