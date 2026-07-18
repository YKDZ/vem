export type MachineRuntimeTraceEntry = {
  type:
    | "journey_transition"
    | "audio_queued"
    | "audio_started"
    | "audio_terminal"
    | "audio_rejected";
  recordedAt: string;
  transitionId: string;
  requestId: string | null;
  outcome: "completed" | "failed" | "stopped" | null;
  message: string | null;
};

export type MachineRuntimeTrace = {
  record(
    entry: Omit<MachineRuntimeTraceEntry, "recordedAt"> & {
      recordedAt?: string;
    },
  ): void;
  entries(): readonly MachineRuntimeTraceEntry[];
};

const DEFAULT_TRACE_LIMIT = 256;

export function createMachineRuntimeTrace(
  limit = DEFAULT_TRACE_LIMIT,
): MachineRuntimeTrace {
  const entries: MachineRuntimeTraceEntry[] = [];

  return {
    record(entry) {
      entries.push({
        ...entry,
        recordedAt: entry.recordedAt ?? new Date().toISOString(),
      });
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    entries: () => [...entries],
  };
}
