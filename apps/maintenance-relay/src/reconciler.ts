import {
  maintenanceRelayDesiredStateSchema,
  maintenanceRelayObservedStateSchema,
  type MaintenancePublicPeer,
  type MaintenanceRelayDesiredState,
  type MaintenanceRelayFailure,
  type MaintenanceRelayFailureReasonCode,
  type MaintenanceRelayObservedState,
  type MaintenanceRelayTransport,
  type MaintenanceSessionAuthorization,
} from "@vem/shared/schemas/maintenance-access";

import {
  createRelayJournal,
  hashDesiredState,
  type RelayJournalStore,
} from "./journal.js";

export type RelayWireGuardBackend = {
  syncPeers: (peers: MaintenancePublicPeer[]) => Promise<void>;
  observePeers: () => Promise<
    Array<{ peerId: string; latestHandshakeAt: string | null }>
  >;
};

export type RelayFirewallBackend = {
  syncState: (
    peers: MaintenancePublicPeer[],
    flows: MaintenanceSessionAuthorization[],
  ) => Promise<void>;
};

export type MaintenanceRelayReconcilerOptions = {
  wireGuard: RelayWireGuardBackend;
  firewall: RelayFirewallBackend;
  journal?: RelayJournalStore;
  now?: () => Date;
  transport?: MaintenanceRelayTransport;
};

const volatileJournal: RelayJournalStore = {
  load: async () => undefined,
  save: async () => undefined,
};

const defaultTransport: MaintenanceRelayTransport = {
  mode: "https",
  health: "healthy",
  reason: null,
};

export class MaintenanceRelayReconciler {
  private readonly now: () => Date;
  private appliedVersion = -1;
  private appliedHash: string | undefined;
  private desired: MaintenanceRelayDesiredState | undefined;
  private observed: MaintenanceRelayObservedState | undefined;
  private pendingFailure:
    | {
        attemptedDesiredStateVersion: number;
        failure: MaintenanceRelayFailure;
      }
    | undefined;
  private initialized = false;
  private readonly journal: RelayJournalStore;

  constructor(private readonly options: MaintenanceRelayReconcilerOptions) {
    this.now = options.now ?? (() => new Date());
    this.journal = options.journal ?? volatileJournal;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.options.firewall.syncState([], []);
    const journal = await this.journal.load();
    const restored = journal?.lastSuccessfulState;
    if (restored) {
      const activeAuthorizations = this.activeAuthorizations(restored);
      await this.options.wireGuard.syncPeers(restored.peers);
      await this.options.firewall.syncState(
        restored.peers,
        activeAuthorizations,
      );
      this.desired = restored;
      this.appliedVersion = restored.desiredStateVersion;
      this.appliedHash = journal.canonicalPayloadHash ?? undefined;
      this.observed = await this.buildObserved(
        restored,
        activeAuthorizations,
        null,
      );
    }
    this.initialized = true;
  }

  async reconcile(input: unknown): Promise<MaintenanceRelayObservedState> {
    await this.initialize();
    const desired = maintenanceRelayDesiredStateSchema.parse(input);
    this.validateDesiredState(desired);
    const desiredHash = hashDesiredState(desired);
    if (desired.desiredStateVersion < this.appliedVersion) {
      const error = new Error(
        `stale desired state version: ${desired.desiredStateVersion} < ${this.appliedVersion}`,
      );
      await this.recordFailure(
        "desired_state_rejected",
        desired.desiredStateVersion,
      );
      throw error;
    }
    if (desired.desiredStateVersion === this.appliedVersion && this.desired) {
      if (desiredHash !== this.appliedHash) {
        const error = new Error(
          "same desired state version has different payload hash",
        );
        await this.recordFailure(
          "desired_state_rejected",
          desired.desiredStateVersion,
        );
        throw error;
      }
      const activeAuthorizations = this.activeAuthorizations(this.desired);
      try {
        await this.options.firewall.syncState(
          this.desired.peers,
          activeAuthorizations,
        );
      } catch (error) {
        await this.recordFailure(
          "firewall_apply_failed",
          desired.desiredStateVersion,
        );
        throw error;
      }
      this.observed = await this.buildObserved(
        this.desired,
        activeAuthorizations,
        this.pendingFailure?.failure ?? null,
        this.pendingFailure?.attemptedDesiredStateVersion ?? null,
      );
      return this.observed;
    }

    const activeAuthorizations = this.activeAuthorizations(desired);
    try {
      await this.options.wireGuard.syncPeers(desired.peers);
    } catch (error) {
      await this.recordFailure(
        "wireguard_apply_failed",
        desired.desiredStateVersion,
      );
      throw error;
    }
    try {
      await this.options.firewall.syncState(
        desired.peers,
        activeAuthorizations,
      );
    } catch (error) {
      await this.recordFailure(
        "firewall_apply_failed",
        desired.desiredStateVersion,
      );
      throw error;
    }
    try {
      await this.journal.save(createRelayJournal(desired, this.now()));
    } catch (error) {
      await this.recordFailure(
        "journal_persist_failed",
        desired.desiredStateVersion,
      );
      throw error;
    }
    this.desired = desired;
    this.appliedVersion = desired.desiredStateVersion;
    this.appliedHash = desiredHash;
    this.pendingFailure = undefined;
    this.observed = await this.buildObserved(
      desired,
      activeAuthorizations,
      null,
    );
    return this.observed;
  }

  async enforceLocalExpiry(): Promise<
    MaintenanceRelayObservedState | undefined
  > {
    await this.initialize();
    if (!this.desired) return this.observed;
    const activeAuthorizations = this.activeAuthorizations(this.desired);
    try {
      await this.options.firewall.syncState(
        this.desired.peers,
        activeAuthorizations,
      );
    } catch (error) {
      if (!this.pendingFailure) {
        await this.recordFailure(
          "firewall_apply_failed",
          this.desired.desiredStateVersion,
        );
      }
      throw error;
    }
    this.observed = await this.buildObserved(
      this.desired,
      activeAuthorizations,
      this.pendingFailure?.failure ?? null,
      this.pendingFailure?.attemptedDesiredStateVersion ?? null,
    );
    return this.observed;
  }

  currentObserved(): MaintenanceRelayObservedState | undefined {
    return this.observed;
  }

  private async recordFailure(
    reasonCode: MaintenanceRelayFailureReasonCode,
    attemptedDesiredStateVersion: number,
  ): Promise<void> {
    this.pendingFailure = {
      attemptedDesiredStateVersion,
      failure: { reasonCode },
    };
    if (!this.desired) {
      this.observed = maintenanceRelayObservedStateSchema.parse({
        schemaVersion: "maintenance-relay-observed-state/v1",
        observedAt: this.now().toISOString(),
        desiredStateSchemaVersion: "maintenance-relay-desired-state/v1",
        appliedDesiredStateVersion: 0,
        attemptedDesiredStateVersion,
        appliedPeerIds: [],
        appliedAuthorizationIds: [],
        peerObservations: [],
        activeAuthorizationObservations: [],
        transport: this.options.transport ?? defaultTransport,
        failure: this.pendingFailure.failure,
      });
      return;
    }
    this.observed = await this.buildObserved(
      this.desired,
      this.activeAuthorizations(this.desired),
      this.pendingFailure.failure,
      attemptedDesiredStateVersion,
    );
  }

  private activeAuthorizations(
    desired: MaintenanceRelayDesiredState,
  ): MaintenanceSessionAuthorization[] {
    const now = this.now().getTime();
    return desired.authorizations.filter(
      (authorization) => Date.parse(authorization.expiresAt) > now,
    );
  }

  private async buildObserved(
    desired: MaintenanceRelayDesiredState,
    activeAuthorizations: MaintenanceSessionAuthorization[],
    failure: MaintenanceRelayFailure | null,
    attemptedDesiredStateVersion: number | null = failure
      ? desired.desiredStateVersion
      : null,
  ): Promise<MaintenanceRelayObservedState> {
    let observedFailure = failure;
    let observedAttemptedDesiredStateVersion = attemptedDesiredStateVersion;
    let observedPeers: Array<{
      peerId: string;
      latestHandshakeAt: string | null;
    }> = [];
    try {
      observedPeers = await this.options.wireGuard.observePeers();
    } catch {
      observedFailure ??= { reasonCode: "peer_observation_failed" };
      observedAttemptedDesiredStateVersion ??= desired.desiredStateVersion;
    }
    const handshakesByPeerId = new Map(
      observedPeers.map((peer) => [peer.peerId, peer.latestHandshakeAt]),
    );
    return maintenanceRelayObservedStateSchema.parse({
      schemaVersion: "maintenance-relay-observed-state/v1",
      observedAt: this.now().toISOString(),
      desiredStateSchemaVersion: desired.schemaVersion,
      appliedDesiredStateVersion: desired.desiredStateVersion,
      attemptedDesiredStateVersion: observedAttemptedDesiredStateVersion,
      appliedPeerIds: desired.peers.map((peer) => peer.id),
      appliedAuthorizationIds: activeAuthorizations.map(
        (authorization) => authorization.sessionId,
      ),
      peerObservations: desired.peers.map((peer) => ({
        peerId: peer.id,
        latestHandshakeAt: handshakesByPeerId.get(peer.id) ?? null,
      })),
      activeAuthorizationObservations: activeAuthorizations.map(
        (authorization) => ({
          sessionId: authorization.sessionId,
          expiresAt: authorization.expiresAt,
        }),
      ),
      transport: this.options.transport ?? defaultTransport,
      failure: observedFailure,
    });
  }

  private validateDesiredState(desired: MaintenanceRelayDesiredState): void {
    const peersById = new Map<string, MaintenancePublicPeer>();
    const addresses = new Set<string>();
    for (const peer of desired.peers) {
      if (peersById.has(peer.id) || addresses.has(peer.tunnelAddress)) {
        throw new Error("desired state contains duplicate peer identity");
      }
      peersById.set(peer.id, peer);
      addresses.add(peer.tunnelAddress);
    }
    for (const authorization of desired.authorizations) {
      const source = peersById.get(authorization.sourcePeerId);
      const target = desired.peers.find(
        (peer) => peer.tunnelAddress === authorization.targetTunnelAddress,
      );
      if (
        (source?.role !== "runner" && source?.role !== "maintainer") ||
        source.tunnelAddress !== authorization.sourceTunnelAddress ||
        target?.role !== "machine" ||
        authorization.protocol !== "tcp" ||
        authorization.port !== 22
      ) {
        throw new Error("unsupported maintenance authorization tuple");
      }
    }
  }
}
