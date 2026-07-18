export type MachineRuntimeNavigationTraceRecord = {
  type: "navigation";
  id: number;
  at: string;
  intentType:
    | "customer.navigate"
    | "customer.touch"
    | "customer.inactive"
    | "presence.departed"
    | "readiness.navigate"
    | "startup.navigate"
    | "operator.navigate"
    | "transaction.dismiss"
    | "browser.navigate"
    | "transaction.projection";
  decision: "accepted" | "rejected" | "delayed";
  reasonCode: string;
  fromRoute: string;
  requestedRoute: string | null;
  decidedRoute: string | null;
  finalRoute: string | null;
  targetRoute: string | null;
  sourceEventId: string | null;
  transactionOrderNo: string | null;
  transactionStage: string;
  readinessRevision: string | null;
  touchscreenSessionActive: boolean;
};

export type MachineRuntimeAudioTraceEntry = {
  type:
    | "journey_transition"
    | "audio_queued"
    | "audio_started"
    | "audio_terminal"
    | "audio_rejected";
  id: number;
  at: string;
  recordedAt: string;
  transitionId: string;
  requestId: string | null;
  terminalOutcomeId: string | null;
  outcome: "completed" | "failed" | "stopped" | null;
  message: string | null;
};

export type MachineRuntimeTransactionSurfaceTraceEntry = {
  type: "transaction_surface";
  id: number;
  at: string;
  recordedAt: string;
  route: string;
  stage: "payment" | "dispensing" | "result";
  orderId: string | null;
  paymentId: string | null;
  orderNo: string | null;
  commandId: string | null;
  resultKind: string | null;
  resultDisplayIntent: string | null;
};

export type MachineRuntimeTraceEntry =
  | MachineRuntimeNavigationTraceRecord
  | MachineRuntimeAudioTraceEntry
  | MachineRuntimeTransactionSurfaceTraceEntry;

type MachineRuntimeRecordedEntry =
  | MachineRuntimeAudioTraceEntry
  | MachineRuntimeTransactionSurfaceTraceEntry;

// Omit must distribute over this discriminated union. A plain Omit collapses
// the member-specific fields and makes valid trace records fail type checking.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

type MachineRuntimeRecordedEntryInput = DistributiveOmit<
  MachineRuntimeRecordedEntry,
  "id" | "at" | "recordedAt"
> & {
  recordedAt?: string;
};

export type MachineRuntimeTrace = {
  record(entry: MachineRuntimeRecordedEntryInput): void;
  recordNavigation(
    entry: Omit<MachineRuntimeNavigationTraceRecord, "id" | "at" | "type">,
  ): void;
  entries(): readonly MachineRuntimeTraceEntry[];
  navigationEntries(): readonly MachineRuntimeNavigationTraceRecord[];
};

const DEFAULT_TRACE_LIMIT = 256;

export function createMachineRuntimeTrace(
  limit = DEFAULT_TRACE_LIMIT,
): MachineRuntimeTrace {
  const entries: MachineRuntimeTraceEntry[] = [];
  let nextId = 1;

  function append(entry: MachineRuntimeTraceEntry): void {
    entries.push(Object.freeze(entry));
    if (entries.length > limit) entries.splice(0, entries.length - limit);
  }

  return {
    record(entry) {
      const recordedAt = entry.recordedAt ?? new Date().toISOString();
      append({
        ...entry,
        id: nextId,
        at: recordedAt,
        recordedAt,
      });
      nextId += 1;
    },
    recordNavigation(entry) {
      append({
        ...entry,
        type: "navigation",
        id: nextId,
        at: new Date().toISOString(),
      });
      nextId += 1;
    },
    entries: () =>
      Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
    navigationEntries: () =>
      Object.freeze(
        entries
          .filter(
            (entry): entry is MachineRuntimeNavigationTraceRecord =>
              entry.type === "navigation",
          )
          .map((entry) => Object.freeze({ ...entry })),
      ),
  };
}
