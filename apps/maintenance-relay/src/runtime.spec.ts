import type {
  MaintenanceRelayDesiredState,
  MaintenanceRelayObservedState,
} from "@vem/shared/schemas/maintenance-access";

import { describe, expect, it } from "vitest";

import { MaintenanceRelayReconciler } from "./reconciler";
import { MaintenanceRelayRuntime } from "./runtime";

const desired: MaintenanceRelayDesiredState = {
  schemaVersion: "maintenance-relay-desired-state/v1",
  desiredStateVersion: 1,
  generatedAt: "2026-07-10T12:00:00.000Z",
  peers: [],
  authorizations: [],
};

describe("MaintenanceRelayRuntime", () => {
  it("reports the first failed apply against an empty last-success state", async () => {
    const reports: MaintenanceRelayObservedState[] = [];
    const reconciler = new MaintenanceRelayReconciler({
      wireGuard: {
        syncPeers: async () => {
          throw new Error("wg syncconf failed");
        },
        observePeers: async () => [],
      },
      firewall: { syncState: async () => undefined },
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    const runtime = new MaintenanceRelayRuntime(
      {
        exchangeCredential: async () => ({
          accessToken: "relay-token",
          expiresAt: "2026-07-10T13:00:00.000Z",
        }),
        fetchDesiredState: async () => desired,
        reportObservedState: async (_token, observed) => {
          reports.push(observed);
        },
      },
      reconciler,
      () => new Date("2026-07-10T12:00:00.000Z"),
    );

    await expect(runtime.poll()).rejects.toThrow("wg syncconf failed");
    expect(reports).toMatchObject([
      {
        appliedDesiredStateVersion: 0,
        attemptedDesiredStateVersion: 1,
        failure: { reasonCode: "wireguard_apply_failed" },
      },
    ]);
  });

  it("reports the attempted apply failure even when expiry enforcement also fails", async () => {
    let nextDesired = desired;
    let failFirewall = false;
    const reports: MaintenanceRelayObservedState[] = [];
    const reconciler = new MaintenanceRelayReconciler({
      wireGuard: {
        syncPeers: async () => undefined,
        observePeers: async () => [],
      },
      firewall: {
        syncState: async () => {
          if (failFirewall) throw new Error("nft apply failed");
        },
      },
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    const runtime = new MaintenanceRelayRuntime(
      {
        exchangeCredential: async () => ({
          accessToken: "relay-token",
          expiresAt: "2026-07-10T13:00:00.000Z",
        }),
        fetchDesiredState: async () => nextDesired,
        reportObservedState: async (_token, observed) => {
          reports.push(observed);
        },
      },
      reconciler,
      () => new Date("2026-07-10T12:00:00.000Z"),
    );
    await runtime.poll();
    reports.length = 0;
    nextDesired = { ...desired, desiredStateVersion: 2 };
    failFirewall = true;

    await expect(runtime.poll()).rejects.toThrow("nft apply failed");
    expect(reports).toMatchObject([
      {
        appliedDesiredStateVersion: 1,
        attemptedDesiredStateVersion: 2,
        failure: { reasonCode: "firewall_apply_failed" },
      },
    ]);
  });

  it("keeps reconciling local expiry after the control plane becomes unavailable", async () => {
    let now = new Date("2026-07-10T12:00:00.000Z");
    let available = true;
    const firewallStates: number[] = [];
    const reconciler = new MaintenanceRelayReconciler({
      wireGuard: {
        syncPeers: async () => undefined,
        observePeers: async () => [],
      },
      firewall: {
        syncState: async (_peers, flows) => {
          firewallStates.push(flows.length);
        },
      },
      now: () => now,
    });
    const runtime = new MaintenanceRelayRuntime(
      {
        exchangeCredential: async () => ({
          accessToken: "relay-token",
          expiresAt: "2026-07-10T13:00:00.000Z",
        }),
        fetchDesiredState: async () => {
          if (!available) throw new Error("service unavailable");
          return desired;
        },
        reportObservedState: async () => undefined,
      },
      reconciler,
      () => now,
    );

    await runtime.poll();
    available = false;
    now = new Date("2026-07-10T12:01:00.000Z");
    await expect(runtime.poll()).rejects.toThrow("service unavailable");

    expect(firewallStates).toEqual([0, 0, 0]);
  });
});
