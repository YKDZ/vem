import { describe, expect, it } from "vitest";

import {
  createMaintenanceSessionRequestSchema,
  maintenanceAccessOverviewResponseSchema,
  maintenanceRelayCredentialExchangeRequestSchema,
  maintenanceRelayCredentialExchangeResponseSchema,
  maintenanceRelayDesiredStateSchema,
  maintenanceRelayHealthSchema,
  maintenanceRelayObservedStateSchema,
  maintenanceRelayTransportSchema,
  registerMaintenancePeerRequestSchema,
} from "./maintenance-access";

const SOURCE_PEER_ID = "550e8400-e29b-41d4-a716-446655440001";
const TARGET_MACHINE_ID = "550e8400-e29b-41d4-a716-446655440002";
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440003";

describe("Maintenance Access shared contracts", () => {
  it("accepts a versioned runner-to-machine TCP 22 desired state without secrets", () => {
    const desiredState = {
      schemaVersion: "maintenance-relay-desired-state/v1",
      desiredStateVersion: 7,
      generatedAt: "2026-07-10T12:00:00.000Z",
      peers: [
        {
          id: SOURCE_PEER_ID,
          role: "runner",
          publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
          tunnelAddress: "10.91.1.10",
        },
        {
          id: "550e8400-e29b-41d4-a716-446655440004",
          role: "machine",
          publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
          tunnelAddress: "10.91.16.10",
        },
      ],
      authorizations: [
        {
          sessionId: SESSION_ID,
          sourcePeerId: SOURCE_PEER_ID,
          sourceTunnelAddress: "10.91.1.10",
          targetMachineId: TARGET_MACHINE_ID,
          targetTunnelAddress: "10.91.16.10",
          protocol: "tcp",
          port: 22,
          expiresAt: "2026-07-10T12:30:00.000Z",
        },
      ],
    };

    expect(maintenanceRelayDesiredStateSchema.parse(desiredState)).toEqual(
      desiredState,
    );
    expect(
      maintenanceRelayObservedStateSchema.parse({
        schemaVersion: "maintenance-relay-observed-state/v1",
        observedAt: "2026-07-10T12:00:01.000Z",
        desiredStateSchemaVersion: desiredState.schemaVersion,
        appliedDesiredStateVersion: desiredState.desiredStateVersion,
        attemptedDesiredStateVersion: null,
        appliedPeerIds: desiredState.peers.map((peer) => peer.id),
        appliedAuthorizationIds: [SESSION_ID],
        peerObservations: desiredState.peers.map((peer) => ({
          peerId: peer.id,
          latestHandshakeAt: null,
        })),
        activeAuthorizationObservations: [
          { sessionId: SESSION_ID, expiresAt: "2026-07-10T12:30:00.000Z" },
        ],
        transport: {
          mode: "https",
          health: "healthy",
          reason: null,
        },
        failure: null,
      }),
    ).toMatchObject({
      appliedDesiredStateVersion: 7,
      attemptedDesiredStateVersion: null,
      appliedAuthorizationIds: [SESSION_ID],
      transport: { mode: "https", health: "healthy" },
    });
  });

  it("keeps transport and relay observation health states internally consistent", () => {
    expect(
      maintenanceRelayTransportSchema.parse({
        mode: "https",
        health: "healthy",
        reason: null,
      }),
    ).toEqual({ mode: "https", health: "healthy", reason: null });
    expect(
      maintenanceRelayTransportSchema.parse({
        mode: "insecure-http",
        health: "degraded",
        reason: "Service API uses explicitly allowed insecure HTTP",
      }),
    ).toMatchObject({ mode: "insecure-http", health: "degraded" });
    expect(
      maintenanceRelayTransportSchema.parse({
        mode: "unknown",
        health: "unreported",
        reason: "relay transport has not been reported",
      }),
    ).toMatchObject({ mode: "unknown", health: "unreported" });

    for (const contradictory of [
      { mode: "https", health: "degraded", reason: "unexpected" },
      { mode: "insecure-http", health: "healthy", reason: null },
      { mode: "unknown", health: "healthy", reason: null },
    ]) {
      expect(() =>
        maintenanceRelayTransportSchema.parse(contradictory),
      ).toThrow();
    }

    expect(
      maintenanceRelayHealthSchema.parse({
        observation: "current",
        overall: "degraded",
        stale: false,
        observedAt: "2026-07-10T12:00:01.000Z",
      }),
    ).toMatchObject({ observation: "current", overall: "degraded" });
    expect(
      maintenanceRelayHealthSchema.parse({
        observation: "stale",
        overall: "unknown",
        stale: true,
        observedAt: "2026-07-10T12:00:01.000Z",
      }),
    ).toMatchObject({ observation: "stale", stale: true });
    expect(
      maintenanceRelayHealthSchema.parse({
        observation: "unreported",
        overall: "unknown",
        stale: false,
        observedAt: null,
      }),
    ).toMatchObject({ observation: "unreported", observedAt: null });
  });

  it("accepts only strict peer registration inputs with canonical 32-byte WireGuard public keys", () => {
    const publicKey = Buffer.alloc(32, 1).toString("base64");

    expect(
      registerMaintenancePeerRequestSchema.parse({
        role: "runner",
        publicKey,
      }),
    ).toEqual({ role: "runner", publicKey });
    expect(
      registerMaintenancePeerRequestSchema.parse({
        role: "machine",
        publicKey,
        machineId: TARGET_MACHINE_ID,
      }),
    ).toEqual({ role: "machine", publicKey, machineId: TARGET_MACHINE_ID });

    for (const invalid of [
      { role: "machine", publicKey },
      { role: "runner", publicKey, machineId: TARGET_MACHINE_ID },
      { role: "runner", publicKey: Buffer.alloc(31, 1).toString("base64") },
      { role: "runner", publicKey: `${publicKey.slice(0, 42)}F=` },
      { role: "runner", publicKey, privateKey: "must-not-cross-boundary" },
    ]) {
      expect(() =>
        registerMaintenancePeerRequestSchema.parse(invalid),
      ).toThrow();
    }
  });

  it("rejects broad, reversed, malformed, or secret-bearing maintenance facts", () => {
    expect(() =>
      createMaintenanceSessionRequestSchema.parse({
        sourcePeerId: SOURCE_PEER_ID,
        targetMachineId: TARGET_MACHINE_ID,
        reason: "Investigate Windows runtime failure",
        ttlMinutes: 30,
        protocol: "tcp",
        port: 3389,
      }),
    ).toThrow();
    expect(() =>
      maintenanceRelayDesiredStateSchema.parse({
        schemaVersion: "maintenance-relay-desired-state/v1",
        desiredStateVersion: 1,
        generatedAt: "2026-07-10T12:00:00.000Z",
        peers: [],
        authorizations: [],
        shell: "iptables -A FORWARD -j ACCEPT",
      }),
    ).toThrow();
    expect(() =>
      maintenanceRelayDesiredStateSchema.parse({
        schemaVersion: "maintenance-relay-desired-state/v1",
        desiredStateVersion: 1,
        generatedAt: "2026-07-10T12:00:00.000Z",
        peers: [
          {
            id: SOURCE_PEER_ID,
            role: "runner",
            publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
            tunnelAddress: "10.91.1.10",
            privateKey: "must-not-cross-the-boundary",
          },
        ],
        authorizations: [],
      }),
    ).toThrow();
  });

  it("exposes strict Admin create and overview contracts", () => {
    expect(
      createMaintenanceSessionRequestSchema.parse({
        sourcePeerId: SOURCE_PEER_ID,
        targetMachineId: TARGET_MACHINE_ID,
        reason: "Investigate Windows runtime failure",
        ttlMinutes: 30,
      }),
    ).toEqual({
      sourcePeerId: SOURCE_PEER_ID,
      targetMachineId: TARGET_MACHINE_ID,
      reason: "Investigate Windows runtime failure",
      ttlMinutes: 30,
      protocol: "tcp",
      port: 22,
    });
    expect(() =>
      createMaintenanceSessionRequestSchema.parse({
        sourcePeerId: SOURCE_PEER_ID,
        targetMachineId: TARGET_MACHINE_ID,
        reason: "Investigate Windows runtime failure",
        ttlMinutes: 15,
      }),
    ).toThrow();
    expect(() =>
      maintenanceAccessOverviewResponseSchema.parse({
        schemaVersion: "maintenance-access-overview/v1",
        sourcePeers: [],
        targetMachines: [],
        sessions: [],
        desiredState: {},
        observedState: {},
      }),
    ).toThrow();
  });

  it("limits credential exchange to the maintenance relay actor", () => {
    const credential = "r".repeat(32);
    expect(
      maintenanceRelayCredentialExchangeRequestSchema.parse({ credential }),
    ).toEqual({ credential });
    expect(
      maintenanceRelayCredentialExchangeResponseSchema.parse({
        actor: "maintenance_relay",
        accessToken: "opaque-short-lived-token",
        expiresAt: "2026-07-10T12:15:00.000Z",
      }),
    ).toMatchObject({ actor: "maintenance_relay" });
    expect(() =>
      maintenanceRelayCredentialExchangeResponseSchema.parse({
        actor: "admin",
        accessToken: "opaque-short-lived-token",
        expiresAt: "2026-07-10T12:15:00.000Z",
      }),
    ).toThrow();
  });
});
