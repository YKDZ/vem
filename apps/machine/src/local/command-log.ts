import type {
  DispenseCommandPayload,
  DispenseResultPayload,
} from "@vem/shared";

const COMMAND_LOG_KEY = "vem.machine.commandLog.v1";

export const COMMAND_LOG_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const COMMAND_LOG_MAX_ENTRIES = 2_000;

export type CommandLogStatus =
  | "received"
  | "acknowledged"
  | "dispensing"
  | "succeeded"
  | "failed";

export type CommandLogEntry = {
  commandNo: string;
  orderNo: string;
  status: CommandLogStatus;
  command: DispenseCommandPayload;
  resultPayload: DispenseResultPayload | null;
  updatedAtMs: number;
};

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function isCommandLogRecord(v: unknown): v is Record<string, CommandLogEntry> {
  return typeof v === "object" && v !== null;
}

function writeAll(
  storage: StorageLike,
  entries: Record<string, CommandLogEntry>,
): void {
  storage.setItem(COMMAND_LOG_KEY, JSON.stringify(entries));
}

function readAndCompact(
  storage: StorageLike,
  nowMs = Date.now(),
): Record<string, CommandLogEntry> {
  const raw = storage.getItem(COMMAND_LOG_KEY);
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    storage.removeItem(COMMAND_LOG_KEY);
    return {};
  }
  if (!isCommandLogRecord(parsed)) {
    storage.removeItem(COMMAND_LOG_KEY);
    return {};
  }
  const freshEntries = Object.values(parsed)
    .filter((entry) => nowMs - entry.updatedAtMs <= COMMAND_LOG_TTL_MS)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)
    .slice(0, COMMAND_LOG_MAX_ENTRIES);
  const compacted = Object.fromEntries(
    freshEntries.map((entry) => [entry.commandNo, entry]),
  );
  if (freshEntries.length !== Object.keys(parsed).length) {
    writeAll(storage, compacted);
  }
  return compacted;
}

export function getCommandLogEntry(
  commandNo: string,
  storage: StorageLike = globalThis.localStorage,
): CommandLogEntry | null {
  return readAndCompact(storage)[commandNo] ?? null;
}

export function upsertCommandLogEntry(
  entry: CommandLogEntry,
  storage: StorageLike = globalThis.localStorage,
): void {
  const entries = readAndCompact(storage);
  entries[entry.commandNo] = entry;
  writeAll(storage, entries);
}

export function markCommandStatus(
  command: DispenseCommandPayload,
  status: CommandLogStatus,
  storage: StorageLike = globalThis.localStorage,
): CommandLogEntry {
  const existing = getCommandLogEntry(command.commandNo, storage);
  const entry: CommandLogEntry = {
    commandNo: command.commandNo,
    orderNo: command.orderNo,
    status,
    command,
    resultPayload: existing?.resultPayload ?? null,
    updatedAtMs: Date.now(),
  };
  upsertCommandLogEntry(entry, storage);
  return entry;
}

export function markCommandResult(
  command: DispenseCommandPayload,
  resultPayload: DispenseResultPayload,
  storage: StorageLike = globalThis.localStorage,
): CommandLogEntry {
  const entry: CommandLogEntry = {
    commandNo: command.commandNo,
    orderNo: command.orderNo,
    status: resultPayload.success ? "succeeded" : "failed",
    command,
    resultPayload,
    updatedAtMs: Date.now(),
  };
  upsertCommandLogEntry(entry, storage);
  return entry;
}

export function isCommandInActiveWindow(
  entry: CommandLogEntry,
  nowMs: number,
): boolean {
  return (
    entry.status === "dispensing" &&
    nowMs - entry.updatedAtMs <= (entry.command.timeoutSeconds + 5) * 1_000
  );
}
