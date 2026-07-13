import type {
  MaintenanceRelayDesiredState,
  MaintenanceRelayObservedState,
} from "@vem/shared";

import { describe, expect, it } from "vitest";

import {
  projectMaintenancePeerHealth,
  projectMaintenanceRelayHealth,
} from "./maintenance-relay-health";

const observed: MaintenanceRelayObservedState = {
  schemaVersion: "maintenance-relay-observed-state/v1",
  observedAt: "2026-07-10T12:00:00.000Z",
  desiredStateSchemaVersion: "maintenance-relay-desired-state/v1",
  appliedDesiredStateVersion: 7,
  attemptedDesiredStateVersion: null,
  appliedPeerIds: [],
  appliedAuthorizationIds: [],
  peerObservations: [],
  activeAuthorizationObservations: [],
  transport: { mode: "https", health: "healthy", reason: null },
  failure: null,
};

describe("maintenance relay health projection", () => {
  it("distinguishes unreported and stale relay observations without claiming health", () => {
    expect(
      projectMaintenanceRelayHealth(null, 7, new Date("2026-07-10T12:00:00Z")),
    ).toEqual({
      observation: "unreported",
      overall: "unknown",
      stale: false,
      observedAt: null,
    });
    expect(
      projectMaintenanceRelayHealth(
        observed,
        7,
        new Date("2026-07-10T12:00:30.001Z"),
      ),
    ).toEqual({
      observation: "stale",
      overall: "unknown",
      stale: true,
      observedAt: observed.observedAt,
    });
  });

  it("reports current health from transport, failure, and convergence facts", () => {
    expect(
      projectMaintenanceRelayHealth(
        observed,
        7,
        new Date("2026-07-10T12:00:05Z"),
      ),
    ).toMatchObject({ observation: "current", overall: "healthy" });

    for (const degraded of [
      {
        ...observed,
        transport: {
          mode: "insecure-http" as const,
          health: "degraded" as const,
          reason: "Service API uses explicitly allowed insecure HTTP",
        },
      },
      {
        ...observed,
        failure: { reasonCode: "firewall_apply_failed" as const },
      },
      { ...observed, appliedDesiredStateVersion: 6 },
      { ...observed, attemptedDesiredStateVersion: 7 },
    ]) {
      expect(
        projectMaintenanceRelayHealth(
          degraded,
          7,
          new Date("2026-07-10T12:00:05Z"),
        ),
      ).toMatchObject({ observation: "current", overall: "degraded" });
    }
  });

  it("derives peer health from both observation and handshake freshness", () => {
    const desired: MaintenanceRelayDesiredState = {
      schemaVersion: "maintenance-relay-desired-state/v1",
      desiredStateVersion: 7,
      generatedAt: "2026-07-10T12:00:00.000Z",
      peers: [
        {
          id: "550e8400-e29b-41d4-a716-446655440001",
          role: "maintainer",
          publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
          tunnelAddress: "10.91.2.10",
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440002",
          role: "machine",
          publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
          tunnelAddress: "10.91.16.10",
        },
      ],
      authorizations: [],
    };
    const current: MaintenanceRelayObservedState = {
      ...observed,
      appliedPeerIds: desired.peers.map((peer) => peer.id),
      peerObservations: [
        {
          peerId: desired.peers[0].id,
          latestHandshakeAt: "2026-07-10T11:58:00.000Z",
        },
        {
          peerId: desired.peers[1].id,
          latestHandshakeAt: "2026-07-10T11:55:00.000Z",
        },
      ],
    };

    expect(
      projectMaintenancePeerHealth(
        desired,
        current,
        new Date("2026-07-10T12:00:05.000Z"),
      ).map((peer) => peer.health),
    ).toEqual(["healthy", "stale"]);
    expect(
      projectMaintenancePeerHealth(
        desired,
        current,
        new Date("2026-07-10T12:00:31.000Z"),
      ).map((peer) => peer.health),
    ).toEqual(["unknown", "unknown"]);
    expect(
      projectMaintenancePeerHealth(
        desired,
        { ...current, peerObservations: [] },
        new Date("2026-07-10T12:00:05.000Z"),
      ).map((peer) => peer.health),
    ).toEqual(["unknown", "unknown"]);
  });
});
