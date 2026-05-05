import type {
  DispenseCommandPayload,
  DispenseResultPayload,
} from "@vem/shared";

const COMMAND_LOG_KEY = "vem.machine.commandLog.v1";

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

function readAll(storage: StorageLike): Record<string, CommandLogEntry> {
  const raw = storage.getItem(COMMAND_LOG_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, CommandLogEntry>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function writeAll(
  storage: StorageLike,
  entries: Record<string, CommandLogEntry>,
): void {
  storage.setItem(COMMAND_LOG_KEY, JSON.stringify(entries));
}

export function getCommandLogEntry(
  commandNo: string,
  storage: StorageLike = globalThis.localStorage,
): CommandLogEntry | null {
  return readAll(storage)[commandNo] ?? null;
}

export function upsertCommandLogEntry(
  entry: CommandLogEntry,
  storage: StorageLike = globalThis.localStorage,
): void {
  const entries = readAll(storage);
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
