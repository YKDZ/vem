import { describe, expect, it } from "vitest";

import {
  CI_MAINTENANCE_SESSION_TTL_MINUTES,
  createCiMaintenanceSessionCommandSchema,
  createHumanMaintenanceSessionRequestSchema,
  githubOidcAutomationExchangeRequestSchema,
  githubOidcAutomationExchangeResponseSchema,
  maintenanceAccessOverviewResponseSchema,
  maintenanceAccessAuditListQuerySchema,
  maintenancePeerHealthSchema,
  maintenanceSessionListQuerySchema,
  maintenanceSessionResponseSchema,
  maintenanceRelayCredentialExchangeRequestSchema,
  maintenanceRelayCredentialExchangeResponseSchema,
  maintenanceRelayDesiredStateSchema,
  maintenanceRelayHealthSchema,
  maintenanceRelayObservedStateSchema,
  maintenanceRelayTransportSchema,
  issueMaintenanceSshCertificateRequestSchema,
  maintenanceSshUserPublicKeySchema,
  registerMaintenancePeerRequestSchema,
} from "./maintenance-access";

const SOURCE_PEER_ID = "550e8400-e29b-41d4-a716-446655440001";
const TARGET_MACHINE_ID = "550e8400-e29b-41d4-a716-446655440002";
const SESSION_ID = "550e8400-e29b-41d4-a716-446655440003";

describe("Maintenance Access shared contracts", () => {
  it("accepts only a single Ed25519 user public key for certificate issuance", () => {
    const publicKey =
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH5k0JQb4ubKJw4kC9aSxX7IeH8w3OvEu4OR7ow7FJQ9";

    expect(maintenanceSshUserPublicKeySchema.parse(publicKey)).toBe(publicKey);
    expect(
      issueMaintenanceSshCertificateRequestSchema.parse({
        publicKey,
        requestId: "f13c3e59-0dc8-4cd5-b11d-42df07c8d778",
      }),
    ).toEqual({
      publicKey,
      requestId: "f13c3e59-0dc8-4cd5-b11d-42df07c8d778",
    });

    for (const unsafeKey of [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      `${publicKey} maintainer@example`,
      `${publicKey}\ncritical:source-address=0.0.0.0/0`,
      "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ==",
      "ssh-ed25519 not-base64",
    ]) {
      expect(() =>
        maintenanceSshUserPublicKeySchema.parse(unsafeKey),
      ).toThrow();
    }
  });

  it("accepts a bounded GitHub OIDC automation exchange without exposing credentials", () => {
    const request = githubOidcAutomationExchangeRequestSchema.parse({
      idToken: "header.payload.signature.header.payload",
      runId: "1234567890",
      runAttempt: "2",
      sha: "a".repeat(40),
      sourcePeerId: SOURCE_PEER_ID,
      targetMachineId: TARGET_MACHINE_ID,
      reason: "Run VM Runtime Acceptance",
    });
    const response = githubOidcAutomationExchangeResponseSchema.parse({
      actor: {
        type: "github_actions",
        runId: "1234567890",
        runAttempt: "2",
      },
      accessToken: "short-lived-automation-token",
      expiresAt: "2026-07-10T12:00:00.000Z",
      sessionTtlMinutes: 150,
    });

    expect(request).toMatchObject({
      runId: "1234567890",
      runAttempt: "2",
      sha: "a".repeat(40),
    });
    expect(response).toEqual({
      actor: {
        type: "github_actions",
        runId: "1234567890",
        runAttempt: "2",
      },
      accessToken: "short-lived-automation-token",
      expiresAt: "2026-07-10T12:00:00.000Z",
      sessionTtlMinutes: 150,
    });
  });

  it("separates default-30-minute human requests from fixed-150-minute CI commands", () => {
    expect(
      createHumanMaintenanceSessionRequestSchema.parse({
        sourcePeerId: SOURCE_PEER_ID,
        targetMachineId: TARGET_MACHINE_ID,
        reason: "Investigate Windows runtime failure",
      }),
    ).toMatchObject({ ttlMinutes: 30 });

    expect(CI_MAINTENANCE_SESSION_TTL_MINUTES).toBe(150);
    expect(
      createCiMaintenanceSessionCommandSchema.parse({
        sourcePeerId: SOURCE_PEER_ID,
        targetMachineId: TARGET_MACHINE_ID,
        automationActorId: "github-run:123456",
        reason: "Run VM Runtime Acceptance",
      }),
    ).not.toHaveProperty("ttlMinutes");
    expect(() =>
      createCiMaintenanceSessionCommandSchema.parse({
        sourcePeerId: SOURCE_PEER_ID,
        targetMachineId: TARGET_MACHINE_ID,
        automationActorId: "github-run:123456",
        reason: "Run VM Runtime Acceptance",
        ttlMinutes: 180,
      }),
    ).toThrow();
  });

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

  it("allows only reason codes across the relay failure boundary", () => {
    const base = {
      schemaVersion: "maintenance-relay-observed-state/v1",
      observedAt: "2026-07-10T12:00:01.000Z",
      desiredStateSchemaVersion: "maintenance-relay-desired-state/v1",
      appliedDesiredStateVersion: 6,
      attemptedDesiredStateVersion: 7,
      appliedPeerIds: [],
      appliedAuthorizationIds: [],
      peerObservations: [],
      activeAuthorizationObservations: [],
      transport: { mode: "https", health: "healthy", reason: null },
    } as const;

    expect(
      maintenanceRelayObservedStateSchema.parse({
        ...base,
        failure: { reasonCode: "firewall_apply_failed" },
      }).failure,
    ).toEqual({ reasonCode: "firewall_apply_failed" });
    for (const failure of [
      "nft failed: private-key=secret",
      { reasonCode: "unknown_failure" },
      {
        reasonCode: "firewall_apply_failed",
        summary: "stderr contained credential=secret",
      },
    ]) {
      expect(() =>
        maintenanceRelayObservedStateSchema.parse({ ...base, failure }),
      ).toThrow();
    }
  });

  it("exposes only healthy, stale, or unknown peer health", () => {
    const peerHealth = {
      peer: {
        id: SOURCE_PEER_ID,
        role: "maintainer",
        publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        tunnelAddress: "10.91.2.10",
      },
      relayApplied: true,
      lastHandshakeAt: "2026-07-10T11:55:00.000Z",
    } as const;

    expect(
      maintenancePeerHealthSchema.parse({ ...peerHealth, health: "stale" }),
    ).toMatchObject({ health: "stale" });
    expect(() =>
      maintenancePeerHealthSchema.parse({ ...peerHealth, health: "pending" }),
    ).toThrow();
  });

  it("keeps maintenance audit queries scoped and session lists kind-filterable", () => {
    expect(
      maintenanceAccessAuditListQuerySchema.parse({ sessionId: SESSION_ID }),
    ).toEqual({ sessionId: SESSION_ID, limit: 50 });
    expect(() =>
      maintenanceAccessAuditListQuerySchema.parse({
        resourceType: "payment",
        action: "payment.refund",
      }),
    ).toThrow();
    expect(maintenanceSessionListQuerySchema.parse({ kind: "ci" })).toEqual({
      kind: "ci",
    });
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
      createHumanMaintenanceSessionRequestSchema.parse({
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
      createHumanMaintenanceSessionRequestSchema.parse({
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
      createHumanMaintenanceSessionRequestSchema.parse({
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

    expect(
      maintenanceAccessOverviewResponseSchema.parse({
        schemaVersion: "maintenance-access-overview/v1",
        sourcePeers: [],
        targetMachines: [],
        peerHealth: [],
        sessions: [],
        desiredState: {
          schemaVersion: "maintenance-relay-desired-state/v1",
          desiredStateVersion: 0,
          generatedAt: "2026-07-10T12:00:00.000Z",
          peers: [],
          authorizations: [],
        },
        observedState: {
          schemaVersion: "maintenance-relay-observed-state/v1",
          observedAt: "2026-07-10T12:00:01.000Z",
          desiredStateSchemaVersion: "maintenance-relay-desired-state/v1",
          appliedDesiredStateVersion: 0,
          attemptedDesiredStateVersion: 1,
          appliedPeerIds: [],
          appliedAuthorizationIds: [],
          peerObservations: [],
          activeAuthorizationObservations: [],
          transport: { mode: "https", health: "healthy", reason: null },
          failure: { reasonCode: "firewall_apply_failed" },
        },
        relayFailure: {
          reasonCode: "firewall_apply_failed",
          summary: "Relay could not apply the maintenance firewall policy.",
        },
        relayHealth: {
          observation: "current",
          overall: "degraded",
          stale: false,
          observedAt: "2026-07-10T12:00:01.000Z",
        },
      }).relayFailure,
    ).toEqual({
      reasonCode: "firewall_apply_failed",
      summary: "Relay could not apply the maintenance firewall policy.",
    });
  });

  it("models human session lifecycle, relay convergence, and status filtering without certificate material", () => {
    const session = maintenanceSessionResponseSchema.parse({
      id: SESSION_ID,
      kind: "human",
      actor: {
        type: "admin",
        adminUserId: "550e8400-e29b-41d4-a716-446655440005",
      },
      sourcePeer: {
        id: SOURCE_PEER_ID,
        role: "maintainer",
        publicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
        tunnelAddress: "10.91.2.10",
      },
      relayPeer: {
        id: "550e8400-e29b-41d4-a716-446655440010",
        role: "relay",
        publicKey: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
        tunnelAddress: "10.91.0.1",
      },
      targetMachine: {
        id: TARGET_MACHINE_ID,
        code: "VEM-MAINT-01",
        name: "Maintenance machine",
        maintenancePeerId: "550e8400-e29b-41d4-a716-446655440004",
        tunnelAddress: "10.91.16.10",
      },
      protocol: "tcp",
      port: 22,
      reason: "Investigate Windows runtime failure",
      issuedAt: "2026-07-10T12:00:00.000Z",
      expiresAt: "2026-07-10T12:30:00.000Z",
      activatedAt: null,
      expiredAt: null,
      failedAt: null,
      failure: null,
      revokedAt: null,
      status: "active",
      relayConvergence: {
        desiredStateVersion: 7,
        appliedDesiredStateVersion: 6,
        state: "pending",
      },
    });

    expect(session.sourcePeer.role).toBe("maintainer");
    expect(session.actor).toEqual({
      type: "admin",
      adminUserId: "550e8400-e29b-41d4-a716-446655440005",
    });
    expect(
      maintenanceSessionListQuerySchema.parse({ status: "failed" }),
    ).toEqual({ status: "failed" });
    expect(() =>
      maintenanceSessionResponseSchema.parse({
        ...session,
        certificateLinkedAt: "2026-07-10T12:05:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      maintenanceSessionResponseSchema.parse({
        ...session,
        kind: "ci",
        actor: {
          type: "automation",
          automationActorId: "github-run:123456",
        },
        sourcePeer: { ...session.sourcePeer, role: "runner" },
      }),
    ).not.toThrow();
    expect(() =>
      maintenanceSessionResponseSchema.parse({
        ...session,
        actor: {
          type: "automation",
          automationActorId: "github-run:123456",
        },
      }),
    ).toThrow();
    expect(() =>
      maintenanceSessionResponseSchema.parse({
        ...session,
        certificatePrivateKey: "must-not-cross-boundary",
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
