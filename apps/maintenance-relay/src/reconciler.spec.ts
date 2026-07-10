import type {
  MaintenanceRelayDesiredState,
  MaintenanceRelayObservedState,
} from "@vem/shared/schemas/maintenance-access";

import { describe, expect, it } from "vitest";

import type { RelayJournal } from "./journal";

import { MaintenanceRelayReconciler } from "./reconciler";

const RUNNER_ID = "550e8400-e29b-41d4-a716-446655440001";
const MACHINE_ID = "550e8400-e29b-41d4-a716-446655440002";
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440003";

function desired(version: number): MaintenanceRelayDesiredState {
  return {
    schemaVersion: "maintenance-relay-desired-state/v1",
    desiredStateVersion: version,
    generatedAt: "2026-07-10T12:00:00.000Z",
    peers: [
      {
        id: RUNNER_ID,
        role: "runner",
        publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        tunnelAddress: "10.91.1.10",
      },
      {
        id: MACHINE_ID,
        role: "machine",
        publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
        tunnelAddress: "10.91.16.10",
      },
    ],
    authorizations: [
      {
        sessionId: SESSION_ID,
        sourcePeerId: RUNNER_ID,
        sourceTunnelAddress: "10.91.1.10",
        targetMachineId: MACHINE_ID,
        targetTunnelAddress: "10.91.16.10",
        protocol: "tcp",
        port: 22,
        expiresAt: "2026-07-10T12:30:00.000Z",
      },
    ],
  };
}

describe("MaintenanceRelayReconciler", () => {
  it("installs deny-all before reading persisted state", async () => {
    const events: string[] = [];
    const reconciler = new MaintenanceRelayReconciler({
      wireGuard: {
        syncPeers: async () => {
          events.push("wireguard");
        },
        observePeers: async () => [],
      },
      firewall: {
        syncState: async (peers, flows) => {
          events.push(`firewall:${peers.length}:${flows.length}`);
        },
      },
      journal: {
        load: async () => {
          events.push("journal:load");
          return undefined;
        },
        save: async () => undefined,
      },
    });

    await reconciler.initialize();

    expect(events).toEqual(["firewall:0:0", "journal:load"]);
  });

  it("persists the last successful state and restores it with local expiry after restart", async () => {
    let journal: RelayJournal | undefined;
    let now = new Date("2026-07-10T12:10:00.000Z");
    const store = {
      load: async () => journal,
      save: async (next: RelayJournal) => {
        journal = next;
      },
    };
    const first = new MaintenanceRelayReconciler({
      wireGuard: {
        syncPeers: async () => undefined,
        observePeers: async () => [],
      },
      firewall: { syncState: async () => undefined },
      journal: store,
      now: () => now,
    });

    await first.reconcile(desired(2));

    expect(journal).toMatchObject({
      appliedRevision: 2,
      canonicalPayloadHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      lastSuccessfulState: { desiredStateVersion: 2 },
    });

    now = new Date("2026-07-10T12:31:00.000Z");
    const restored: string[] = [];
    const second = new MaintenanceRelayReconciler({
      wireGuard: {
        syncPeers: async (peers) => {
          restored.push(`wireguard:${peers.length}`);
        },
        observePeers: async () => [],
      },
      firewall: {
        syncState: async (peers, flows) => {
          restored.push(`firewall:${peers.length}:${flows.length}`);
        },
      },
      journal: store,
      now: () => now,
    });

    await second.initialize();

    expect(restored).toEqual([
      "firewall:0:0",
      "wireguard:2",
      "firewall:2:0",
    ]);
    expect(second.currentObserved()).toMatchObject({
      appliedDesiredStateVersion: 2,
      appliedAuthorizationIds: [],
      attemptedDesiredStateVersion: null,
      failure: null,
    });
  });

  it("refreshes observations and expiry for the same hash but rejects different content at the same revision", async () => {
    let now = new Date("2026-07-10T12:10:00.000Z");
    let handshake: string | null = null;
    const firewallFlowCounts: number[] = [];
    const reconciler = new MaintenanceRelayReconciler({
      wireGuard: {
        syncPeers: async () => undefined,
        observePeers: async () => [
          { peerId: RUNNER_ID, latestHandshakeAt: handshake },
        ],
      },
      firewall: {
        syncState: async (_peers, flows) => {
          firewallFlowCounts.push(flows.length);
        },
      },
      now: () => now,
    });
    const state = desired(3);
    await reconciler.reconcile(state);

    now = new Date("2026-07-10T12:31:00.000Z");
    handshake = "2026-07-10T12:30:30.000Z";
    const refreshed = await reconciler.reconcile(state);

    expect(firewallFlowCounts).toEqual([0, 1, 0]);
    expect(refreshed).toMatchObject({
      appliedAuthorizationIds: [],
      peerObservations: [
        { peerId: RUNNER_ID, latestHandshakeAt: handshake },
        { peerId: MACHINE_ID, latestHandshakeAt: null },
      ],
    });

    await expect(
      reconciler.reconcile({
        ...state,
        generatedAt: "2026-07-10T12:00:01.000Z",
      }),
    ).rejects.toThrow("same desired state version has different payload hash");
  });

  it("advances the journal only after both backends succeed and preserves failure through expiry", async () => {
    let now = new Date("2026-07-10T12:10:00.000Z");
    let journal: RelayJournal | undefined;
    let failFirewall = false;
    const applyEvents: string[] = [];
    const reconciler = new MaintenanceRelayReconciler({
      wireGuard: {
        syncPeers: async () => {
          applyEvents.push("wireguard");
        },
        observePeers: async () => [],
      },
      firewall: {
        syncState: async () => {
          applyEvents.push("firewall");
          if (failFirewall) throw new Error("nft apply failed");
        },
      },
      journal: {
        load: async () => journal,
        save: async (next) => {
          journal = next;
        },
      },
      now: () => now,
    });
    await reconciler.reconcile(desired(1));
    expect(journal?.appliedRevision).toBe(1);

    failFirewall = true;
    applyEvents.length = 0;
    await expect(reconciler.reconcile(desired(2))).rejects.toThrow(
      "nft apply failed",
    );

    expect(applyEvents).toEqual(["wireguard", "firewall"]);
    expect(journal?.appliedRevision).toBe(1);
    expect(reconciler.currentObserved()).toMatchObject({
      appliedDesiredStateVersion: 1,
      appliedPeerIds: [RUNNER_ID, MACHINE_ID],
      attemptedDesiredStateVersion: 2,
      failure: "nft apply failed",
    });

    failFirewall = false;
    now = new Date("2026-07-10T12:31:00.000Z");
    await expect(reconciler.enforceLocalExpiry()).resolves.toMatchObject({
      appliedDesiredStateVersion: 1,
      appliedAuthorizationIds: [],
      attemptedDesiredStateVersion: 2,
      failure: "nft apply failed",
    });
  });

  it("reports the attempted revision when the first backend apply fails", async () => {
    const reconciler = new MaintenanceRelayReconciler({
      wireGuard: {
        syncPeers: async () => {
          throw new Error("wg syncconf failed");
        },
        observePeers: async () => [],
      },
      firewall: { syncState: async () => undefined },
      now: () => new Date("2026-07-10T12:10:00.000Z"),
    });

    await expect(reconciler.reconcile(desired(4))).rejects.toThrow(
      "wg syncconf failed",
    );
    expect(reconciler.currentObserved()).toMatchObject({
      appliedDesiredStateVersion: 0,
      appliedPeerIds: [],
      appliedAuthorizationIds: [],
      attemptedDesiredStateVersion: 4,
      failure: "wg syncconf failed",
    });
  });

  it("applies a versioned runner-to-machine SSH authorization and rejects a stale version", async () => {
    const appliedPeers: string[][] = [];
    const appliedFlows: Array<
      Array<{ source: string; target: string; port: number }>
    > = [];
    const reconciler = new MaintenanceRelayReconciler({
      wireGuard: {
        syncPeers: async (peers) => {
          appliedPeers.push(peers.map((peer) => peer.id));
        },
        observePeers: async () => [],
      },
      firewall: {
        syncState: async (_peers, flows) => {
          appliedFlows.push(
            flows.map((flow) => ({
              source: flow.sourceTunnelAddress,
              target: flow.targetTunnelAddress,
              port: flow.port,
            })),
          );
        },
      },
      now: () => new Date("2026-07-10T12:10:00.000Z"),
    });

    const observed = await reconciler.reconcile(desired(2));

    expect(appliedPeers).toEqual([[RUNNER_ID, MACHINE_ID]]);
    expect(appliedFlows).toEqual([
      [],
      [{ source: "10.91.1.10", target: "10.91.16.10", port: 22 }],
    ]);
    expect(observed).toMatchObject({
      appliedDesiredStateVersion: 2,
      appliedPeerIds: [RUNNER_ID, MACHINE_ID],
      appliedAuthorizationIds: [SESSION_ID],
    } satisfies Partial<MaintenanceRelayObservedState>);

    await expect(reconciler.reconcile(desired(1))).rejects.toThrow(
      "stale desired state version",
    );
  });
});
