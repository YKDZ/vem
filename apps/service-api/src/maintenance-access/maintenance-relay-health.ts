import type {
  MaintenanceRelayHealth,
  MaintenanceRelayObservedState,
} from "@vem/shared";

const RELAY_OBSERVATION_STALE_AFTER_MS = 30_000;

export function projectMaintenanceRelayHealth(
  observedState: MaintenanceRelayObservedState | null,
  desiredStateVersion: number,
  now: Date,
): MaintenanceRelayHealth {
  if (!observedState) {
    return {
      observation: "unreported",
      overall: "unknown",
      stale: false,
      observedAt: null,
    };
  }

  if (
    now.getTime() - Date.parse(observedState.observedAt) >
    RELAY_OBSERVATION_STALE_AFTER_MS
  ) {
    return {
      observation: "stale",
      overall: "unknown",
      stale: true,
      observedAt: observedState.observedAt,
    };
  }

  const overall =
    observedState.transport.health === "unreported"
      ? "unknown"
      : observedState.transport.health === "degraded" ||
          observedState.failure !== null ||
          observedState.appliedDesiredStateVersion !== desiredStateVersion ||
          observedState.attemptedDesiredStateVersion !== null
        ? "degraded"
        : "healthy";
  return {
    observation: "current",
    overall,
    stale: false,
    observedAt: observedState.observedAt,
  };
}
