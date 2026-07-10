import type {
  MaintenancePeerHealth,
  MaintenanceRelayDesiredState,
  MaintenanceRelayHealth,
  MaintenanceRelayObservedState,
} from "@vem/shared";

const RELAY_OBSERVATION_STALE_AFTER_MS = 30_000;
const PEER_HANDSHAKE_STALE_AFTER_MS = 180_000;

function ageIsCurrent(
  now: Date,
  timestamp: string,
  maximumAgeMs: number,
): boolean {
  const age = now.getTime() - Date.parse(timestamp);
  return age >= 0 && age <= maximumAgeMs;
}

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

export function projectMaintenancePeerHealth(
  desiredState: MaintenanceRelayDesiredState,
  observedState: MaintenanceRelayObservedState | null,
  now: Date,
): MaintenancePeerHealth[] {
  const observationIsCurrent =
    observedState !== null &&
    ageIsCurrent(
      now,
      observedState.observedAt,
      RELAY_OBSERVATION_STALE_AFTER_MS,
    );
  const observations = new Map(
    observedState?.peerObservations.map((observation) => [
      observation.peerId,
      observation,
    ]) ?? [],
  );
  const appliedPeerIds = new Set(observedState?.appliedPeerIds ?? []);

  return desiredState.peers.map((peer) => {
    const relayApplied = appliedPeerIds.has(peer.id);
    const lastHandshakeAt =
      observations.get(peer.id)?.latestHandshakeAt ?? null;
    let health: MaintenancePeerHealth["health"] = "unknown";
    if (observationIsCurrent && relayApplied && lastHandshakeAt) {
      health = ageIsCurrent(now, lastHandshakeAt, PEER_HANDSHAKE_STALE_AFTER_MS)
        ? "healthy"
        : Date.parse(lastHandshakeAt) <= now.getTime()
          ? "stale"
          : "unknown";
    }
    return { peer, relayApplied, lastHandshakeAt, health };
  });
}
