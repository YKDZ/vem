import {
  maintenanceRelayObservedStateSchema,
  type MaintenanceRelayDesiredState,
  type MaintenanceRelayObservedState,
} from "@vem/shared";

// Issue 01's relay boundary is deliberately deterministic; issue 02 owns real reconciliation.
export function observeMaintenanceRelayDesiredState(
  desiredState: MaintenanceRelayDesiredState,
): MaintenanceRelayObservedState {
  return maintenanceRelayObservedStateSchema.parse({
    schemaVersion: "maintenance-relay-observed-state/v1",
    observedAt: desiredState.generatedAt,
    desiredStateSchemaVersion: desiredState.schemaVersion,
    appliedDesiredStateVersion: desiredState.desiredStateVersion,
    appliedPeerIds: desiredState.peers.map((peer) => peer.id),
    appliedAuthorizationIds: desiredState.authorizations.map(
      (authorization) => authorization.sessionId,
    ),
  });
}
