import type { MachineCommandStatus } from "@vem/shared";

import type { EnvironmentControlAction } from "./machine-contract-mappers";

export type EnvironmentCommandSnapshot = {
  commandNo?: string | null;
  status?: MachineCommandStatus | null;
  payloadJson?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
  lastError?: string | null;
};

export type EnvironmentCommandSource = {
  latestEnvironmentCommand?: EnvironmentCommandSnapshot | null;
};

export type EnvironmentCommandStateCallbacks = {
  setEnvironmentCommandStatus: (status: MachineCommandStatus | null) => void;
  setActionStatus?: (
    action: EnvironmentControlAction,
    status: MachineCommandStatus | null,
  ) => void;
  setActionPayload?: (
    action: EnvironmentControlAction,
    payload: Record<string, unknown> | null,
  ) => void;
  setActionResult?: (
    action: EnvironmentControlAction,
    result: Record<string, unknown> | null,
  ) => void;
  setActionError?: (
    action: EnvironmentControlAction,
    error: string | null,
  ) => void;
};

export function detectEnvironmentControlActionFromPayload(
  payload: Record<string, unknown> | null | undefined,
): EnvironmentControlAction | null {
  if (!payload || typeof payload !== "object") return null;
  if ("airConditionerOn" in payload) return "airConditionerOn";
  if ("targetTemperatureCelsius" in payload) return "targetTemperatureCelsius";
  if ("ventSpeed" in payload) return "ventSpeed";
  return null;
}

export function isEnvironmentCommandTerminalStatus(
  status: MachineCommandStatus | null | undefined,
): boolean {
  return status === "succeeded" || status === "failed" || status === "timeout";
}

export function syncEnvironmentCommandStateFromSnapshot(
  command: EnvironmentCommandSnapshot | null,
  callbacks: EnvironmentCommandStateCallbacks,
): void {
  if (!command) return;
  callbacks.setEnvironmentCommandStatus(command.status ?? null);
  const action = detectEnvironmentControlActionFromPayload(command.payloadJson);
  if (!action) return;
  const status = command.status ?? null;
  callbacks.setActionStatus?.(action, status);
  callbacks.setActionPayload?.(action, command.payloadJson ?? null);
  callbacks.setActionResult?.(action, command.resultJson ?? null);
  callbacks.setActionError?.(action, command.lastError ?? null);
}

type EnvironmentCommandPollerConfig = {
  commandNo: string;
  fetchMachine: () => Promise<EnvironmentCommandSource>;
  isActive: () => boolean;
  onCommand: (command: EnvironmentCommandSnapshot) => void;
  intervalMs?: number;
  maxAttempts?: number;
};

export type EnvironmentCommandPoller = {
  stop: () => void;
  promise: Promise<EnvironmentCommandSnapshot | null>;
};

const defaultPollIntervalMs = 500;
const defaultPollAttempts = 20;

export function startEnvironmentCommandPoller(
  config: EnvironmentCommandPollerConfig,
): EnvironmentCommandPoller {
  const stopSignal = new AbortController();
  const intervalMs = config.intervalMs ?? defaultPollIntervalMs;
  const maxAttempts = config.maxAttempts ?? defaultPollAttempts;
  const delay = async (): Promise<void> =>
    new Promise((resolve) => {
      if (stopSignal.signal.aborted) {
        resolve();
        return;
      }
      const finish = (): void => {
        clearTimeout(timer);
        stopSignal.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, intervalMs);
      stopSignal.signal.addEventListener("abort", finish, { once: true });
    });

  const poll = async (
    attempt = 0,
    latestMatched: EnvironmentCommandSnapshot | null = null,
  ): Promise<EnvironmentCommandSnapshot | null> => {
    if (!config.commandNo || stopSignal.signal.aborted || !config.isActive()) {
      return latestMatched;
    }
    const machine = await config.fetchMachine();
    const command = machine.latestEnvironmentCommand ?? null;
    const nextMatched =
      command?.commandNo === config.commandNo ? command : latestMatched;
    if (command?.commandNo === config.commandNo) {
      config.onCommand(command);
      if (isEnvironmentCommandTerminalStatus(command.status)) return command;
    }
    if (attempt + 1 >= maxAttempts || !config.isActive()) return nextMatched;
    await delay();
    return poll(attempt + 1, nextMatched);
  };

  const stop = (): void => {
    stopSignal.abort();
  };

  return { stop, promise: poll() };
}
