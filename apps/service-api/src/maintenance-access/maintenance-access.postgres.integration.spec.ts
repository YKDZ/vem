import {
  and,
  adminUsers,
  auditLogs,
  DrizzleDB,
  eq,
  machines,
  machineCommands,
  maintenancePeers,
  maintenanceSessions,
  sql,
} from "@vem/db";
import { mqttSignedEnvelopeSchema } from "@vem/shared";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AppConfigService } from "../config/app-config.service";

import { MachineCredentialService } from "../machine-auth/machine-credential.service";
import { MachinesService } from "../machines/machines.service";
import { MqttSignatureService } from "../mqtt/mqtt-signature.service";
import { MaintenanceAccessService } from "./maintenance-access.service";
import { parseMaintenanceAddressPools } from "./maintenance-address-pools";

const databaseUrl = process.env.VEM_TEST_POSTGRES_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

const config = {
  maintenanceAddressPools: parseMaintenanceAddressPools({
    relay: "10.91.0.0/24",
    runner: "10.91.1.0/24",
    maintainer: "10.91.3.0/24",
    machine: "10.91.16.0/20",
  }),
  machineCredentialEncryptionKey:
    "issue08-postgres-machine-credential-encryption-key",
  mqttSignatureToleranceSeconds: 300,
} as AppConfigService;

postgresDescribe("MaintenanceAccessService PostgreSQL lifecycle", () => {
  let database: DrizzleDB;
  let service: MaintenanceAccessService;
  let machinesService: MachinesService;
  let credentialService: MachineCredentialService;
  let signatureService: MqttSignatureService;
  const publish = vi.fn();

  beforeAll(async () => {
    database = new DrizzleDB(databaseUrl);
    await database.connect();
    service = new MaintenanceAccessService(database.client, config);
    credentialService = new MachineCredentialService(config);
    signatureService = new MqttSignatureService(
      database.client,
      config,
      credentialService,
    );
    machinesService = new MachinesService(
      database.client,
      credentialService,
      service,
      {} as never,
      { record: vi.fn() } as never,
      { publish, registerMachineMessageHandler: vi.fn() } as never,
      signatureService,
      config,
      {} as never,
    );
  });

  afterAll(async () => {
    await database?.disconnect();
  });

  it("promotes a verified reclaim atomically under the active-machine unique index", async () => {
    const machineId = "550e8400-e29b-41d4-a716-446655440801";
    const oldPeerId = "550e8400-e29b-41d4-a716-446655440802";
    const pendingPeerId = "550e8400-e29b-41d4-a716-446655440803";
    const sourcePeerId = "550e8400-e29b-41d4-a716-446655440804";
    const adminId = "550e8400-e29b-41d4-a716-446655440805";
    const createdAt = new Date();
    const handshakeAt = new Date(createdAt.getTime() + 5_000);

    await database.client.insert(machines).values({
      id: machineId,
      code: "PG-RECLAIM-801",
      name: "PostgreSQL reclaim promotion",
    });
    await database.client.insert(adminUsers).values({
      id: adminId,
      username: "issue08-promotion-admin",
      passwordHash: "not-used",
      displayName: "Issue08 promotion",
    });
    await database.client.insert(maintenancePeers).values([
      {
        id: oldPeerId,
        role: "machine",
        publicKey: "gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIA=",
        tunnelAddress: "10.91.16.201",
        machineId,
        status: "active",
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: pendingPeerId,
        role: "machine",
        publicKey: "hISEhISEhISEhISEhISEhISEhISEhISEhISEhISEhIQ=",
        tunnelAddress: "10.91.16.202",
        machineId,
        status: "pending_reclaim",
        reclaimExpiresAt: new Date(createdAt.getTime() + 300_000),
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: sourcePeerId,
        role: "maintainer",
        publicKey: "paWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaWlpaU=",
        tunnelAddress: "10.91.3.201",
        status: "active",
        createdAt,
        updatedAt: createdAt,
      },
    ]);

    await database.client.transaction(async (tx) => {
      await service.projectDesiredStateAfterPeerMutation(tx, createdAt);
    });
    const session = await service.createHumanSession(adminId, {
      sourcePeerId,
      targetMachineId: machineId,
      reason: "Verify reclaim promotion",
      ttlMinutes: 30,
      protocol: "tcp",
      port: 22,
    });
    const desired = await service.getRelayDesiredState();
    expect(desired.authorizations.map((item) => item.sessionId)).toContain(
      session.id,
    );

    await expect(
      service.reportRelayObservedState({
        schemaVersion: "maintenance-relay-observed-state/v1",
        observedAt: handshakeAt.toISOString(),
        desiredStateSchemaVersion: desired.schemaVersion,
        appliedDesiredStateVersion: desired.desiredStateVersion,
        attemptedDesiredStateVersion: null,
        appliedPeerIds: desired.peers.map((peer) => peer.id),
        appliedAuthorizationIds: desired.authorizations.map(
          (authorization) => authorization.sessionId,
        ),
        peerObservations: desired.peers.map((peer) => ({
          peerId: peer.id,
          latestHandshakeAt:
            peer.id === pendingPeerId ? handshakeAt.toISOString() : null,
        })),
        activeAuthorizationObservations: desired.authorizations.map(
          (authorization) => ({
            sessionId: authorization.sessionId,
            expiresAt: authorization.expiresAt,
          }),
        ),
        transport: { mode: "https", health: "healthy", reason: null },
        failure: null,
      }),
    ).resolves.toMatchObject({
      appliedDesiredStateVersion: desired.desiredStateVersion,
    });

    const peers = await database.client
      .select({
        id: maintenancePeers.id,
        status: maintenancePeers.status,
        revokedAt: maintenancePeers.revokedAt,
        handshakeVerifiedAt: maintenancePeers.handshakeVerifiedAt,
      })
      .from(maintenancePeers)
      .where(eq(maintenancePeers.machineId, machineId));
    expect(peers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: oldPeerId,
          status: "revoked",
          revokedAt: handshakeAt,
        }),
        expect.objectContaining({
          id: pendingPeerId,
          status: "active",
          handshakeVerifiedAt: handshakeAt,
        }),
      ]),
    );

    const projected = await service.getRelayDesiredState();
    expect(projected.peers.map((peer) => peer.id)).toContain(pendingPeerId);
    expect(projected.peers.map((peer) => peer.id)).not.toContain(oldPeerId);
    expect(
      projected.authorizations.map((item) => item.sessionId),
    ).not.toContain(session.id);
    expect(
      (
        await database.client
          .select({ revokedAt: maintenanceSessions.revokedAt })
          .from(maintenanceSessions)
          .where(eq(maintenanceSessions.id, session.id))
      )[0].revokedAt,
    ).toEqual(handshakeAt);
    const audits = await database.client
      .select({ action: auditLogs.action, resourceId: auditLogs.resourceId })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.resourceType, "maintenance_peer"),
          eq(auditLogs.resourceId, pendingPeerId),
        ),
      );
    expect(audits).toContainEqual({
      action: "machines.reclaim.handshake_verified",
      resourceId: pendingPeerId,
    });
    expect(
      await database.client
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, session.id)),
    ).toContainEqual({ action: "maintenanceAccess.session.revoke" });
  });

  it("rolls back the old active peer revocation when pending promotion fails", async () => {
    const machineId = "550e8400-e29b-41d4-a716-446655440851";
    const oldPeerId = "550e8400-e29b-41d4-a716-446655440852";
    const pendingPeerId = "550e8400-e29b-41d4-a716-446655440853";
    const createdAt = new Date();
    const handshakeAt = new Date(createdAt.getTime() + 5_000);
    await database.client.insert(machines).values({
      id: machineId,
      code: "PG-RECLAIM-851",
      name: "PostgreSQL reclaim rollback",
    });
    await database.client.insert(maintenancePeers).values([
      {
        id: oldPeerId,
        role: "machine",
        publicKey: "oaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaGhoaE=",
        tunnelAddress: "10.91.16.241",
        machineId,
        status: "active",
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: pendingPeerId,
        role: "machine",
        publicKey: "oqKioqKioqKioqKioqKioqKioqKioqKioqKioqKioqI=",
        tunnelAddress: "10.91.16.242",
        machineId,
        status: "pending_reclaim",
        reclaimExpiresAt: new Date(createdAt.getTime() + 300_000),
        createdAt,
        updatedAt: createdAt,
      },
    ]);
    await database.client.transaction(async (tx) => {
      await service.projectDesiredStateAfterPeerMutation(tx, createdAt);
    });
    const desired = await service.getRelayDesiredState();
    await database.client.execute(
      sql.raw(`ALTER TABLE maintenance_peers
        ADD CONSTRAINT issue08_reject_pending_promotion
        CHECK (id <> '${pendingPeerId}' OR status <> 'active')`),
    );

    try {
      await expect(
        service.reportRelayObservedState({
          schemaVersion: "maintenance-relay-observed-state/v1",
          observedAt: handshakeAt.toISOString(),
          desiredStateSchemaVersion: desired.schemaVersion,
          appliedDesiredStateVersion: desired.desiredStateVersion,
          attemptedDesiredStateVersion: null,
          appliedPeerIds: desired.peers.map((peer) => peer.id),
          appliedAuthorizationIds: [],
          peerObservations: desired.peers.map((peer) => ({
            peerId: peer.id,
            latestHandshakeAt:
              peer.id === pendingPeerId ? handshakeAt.toISOString() : null,
          })),
          activeAuthorizationObservations: [],
          transport: { mode: "https", health: "healthy", reason: null },
          failure: null,
        }),
      ).rejects.toThrow();

      const peers = await database.client
        .select({
          id: maintenancePeers.id,
          status: maintenancePeers.status,
          revokedAt: maintenancePeers.revokedAt,
        })
        .from(maintenancePeers)
        .where(eq(maintenancePeers.machineId, machineId));
      expect(peers).toEqual(
        expect.arrayContaining([
          { id: oldPeerId, status: "active", revokedAt: null },
          { id: pendingPeerId, status: "pending_reclaim", revokedAt: null },
        ]),
      );
      expect(
        await database.client
          .select({ action: auditLogs.action })
          .from(auditLogs)
          .where(eq(auditLogs.resourceId, pendingPeerId)),
      ).toEqual([]);
    } finally {
      await database.client.execute(
        sql.raw(
          "ALTER TABLE maintenance_peers DROP CONSTRAINT issue08_reject_pending_promotion",
        ),
      );
    }
  });

  it("enforces a non-null reclaim expiry and coherent pending lifecycle fields", async () => {
    const machineId = "550e8400-e29b-41d4-a716-446655440811";
    await database.client.insert(machines).values({
      id: machineId,
      code: "PG-RECLAIM-811",
      name: "PostgreSQL reclaim constraints",
    });

    await expect(
      database.client.insert(maintenancePeers).values({
        id: "550e8400-e29b-41d4-a716-446655440812",
        role: "machine",
        publicKey: "iYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYk=",
        tunnelAddress: "10.91.16.211",
        machineId,
        status: "pending_reclaim",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      database.client.insert(maintenancePeers).values({
        id: "550e8400-e29b-41d4-a716-446655440813",
        role: "machine",
        publicKey: "mZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZmZk=",
        tunnelAddress: "10.91.16.212",
        machineId,
        status: "active",
        reclaimExpiresAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      database.client.insert(maintenancePeers).values({
        id: "550e8400-e29b-41d4-a716-446655440814",
        role: "machine",
        publicKey: "np6enp6enp6enp6enp6enp6enp6enp6enp6enp6enp4=",
        tunnelAddress: "10.91.16.213",
        machineId,
        status: "reclaim_failed",
        reclaimExpiresAt: new Date(),
        reclaimFailedAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("times out only the pending reclaim and projects an auditable recovery state", async () => {
    const machineId = "550e8400-e29b-41d4-a716-446655440831";
    const activePeerId = "550e8400-e29b-41d4-a716-446655440832";
    const pendingPeerId = "550e8400-e29b-41d4-a716-446655440833";
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 60_000);
    await database.client.insert(machines).values({
      id: machineId,
      code: "PG-RECLAIM-831",
      name: "PostgreSQL reclaim timeout",
    });
    await database.client.insert(maintenancePeers).values([
      {
        id: activePeerId,
        role: "machine",
        publicKey: "jY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY0=",
        tunnelAddress: "10.91.16.221",
        machineId,
        status: "active",
      },
      {
        id: pendingPeerId,
        role: "machine",
        publicKey: "kpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpKSkpI=",
        tunnelAddress: "10.91.16.222",
        machineId,
        status: "pending_reclaim",
        reclaimExpiresAt: expiresAt,
      },
    ]);
    await database.client.transaction(async (tx) => {
      await service.projectDesiredStateAfterPeerMutation(tx, now);
    });
    expect(
      (await service.getRelayDesiredState()).peers.map((peer) => peer.id),
    ).toEqual(expect.arrayContaining([activePeerId, pendingPeerId]));

    await service.sweepPendingReclaims(new Date(expiresAt.getTime() + 1));

    const peers = await database.client
      .select({ id: maintenancePeers.id, status: maintenancePeers.status })
      .from(maintenancePeers)
      .where(eq(maintenancePeers.machineId, machineId));
    expect(peers).toEqual(
      expect.arrayContaining([
        { id: activePeerId, status: "active" },
        { id: pendingPeerId, status: "reclaim_failed" },
      ]),
    );
    const projectedIds = (await service.getRelayDesiredState()).peers.map(
      (peer) => peer.id,
    );
    expect(projectedIds).toContain(activePeerId);
    expect(projectedIds).not.toContain(pendingPeerId);
    expect(
      await database.client
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, pendingPeerId)),
    ).toContainEqual({ action: "machines.reclaim.handshake_timeout" });
  });

  it("keeps decommission cleanup delivery retryable until durable acknowledgement", async () => {
    const machineId = "550e8400-e29b-41d4-a716-446655440821";
    const adminId = "550e8400-e29b-41d4-a716-446655440822";
    const credentials = credentialService.createBundle();
    await database.client.insert(adminUsers).values({
      id: adminId,
      username: "issue08-pg-admin",
      passwordHash: "not-used",
      displayName: "Issue08 PostgreSQL",
    });
    await database.client.insert(machines).values({
      id: machineId,
      code: "PG-DECOM-821",
      name: "PostgreSQL decommission delivery",
      status: "online",
      secretHash: credentials.secretHash,
      mqttClientId: "vem-machine-PG-DECOM-821",
      mqttSigningSecretEncryptedJson:
        credentials.mqttSigningSecretEncryptedJson,
    });
    const peerId = "550e8400-e29b-41d4-a716-446655440823";
    const sourcePeerId = "550e8400-e29b-41d4-a716-446655440824";
    await database.client.insert(maintenancePeers).values([
      {
        id: peerId,
        role: "machine",
        publicKey: "l5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5eXl5c=",
        tunnelAddress: "10.91.16.231",
        machineId,
        status: "active",
      },
      {
        id: sourcePeerId,
        role: "maintainer",
        publicKey: "qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqo=",
        tunnelAddress: "10.91.3.231",
        status: "active",
      },
    ]);
    await database.client.transaction(async (tx) => {
      await service.projectDesiredStateAfterPeerMutation(tx, new Date());
    });
    const session = await service.createHumanSession(adminId, {
      sourcePeerId,
      targetMachineId: machineId,
      reason: "Verify atomic secure decommission",
      ttlMinutes: 30,
      protocol: "tcp",
      port: 22,
    });
    publish
      .mockRejectedValueOnce(new Error("broker unavailable"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cleanup acknowledgement interrupted"))
      .mockResolvedValueOnce(undefined);

    const first = await machinesService.secureDecommissionMachine(
      machineId,
      adminId,
    );

    expect(first).toMatchObject({
      decommissionCommandStatus: "pending",
      deliveryAttemptCount: 1,
      localTunnelRemoval: "delivery-pending",
    });
    const [revoked] = await database.client
      .select()
      .from(machines)
      .where(eq(machines.id, machineId));
    expect(revoked).toMatchObject({
      status: "disabled",
      secretHash: null,
    });
    expect(revoked.mqttSigningSecretEncryptedJson).not.toBeNull();
    expect(
      (
        await database.client
          .select({ status: maintenancePeers.status })
          .from(maintenancePeers)
          .where(eq(maintenancePeers.id, peerId))
      )[0].status,
    ).toBe("revoked");
    expect(
      await database.client
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, peerId)),
    ).toContainEqual({ action: "maintenanceAccess.peer.revoke" });
    expect(
      (
        await database.client
          .select({ revokedAt: maintenanceSessions.revokedAt })
          .from(maintenanceSessions)
          .where(eq(maintenanceSessions.id, session.id))
      )[0].revokedAt,
    ).not.toBeNull();
    expect(
      (await service.getRelayDesiredState()).authorizations.map(
        (authorization) => authorization.sessionId,
      ),
    ).not.toContain(session.id);
    expect(
      await database.client
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, session.id)),
    ).toContainEqual({ action: "maintenanceAccess.session.revoke" });
    await database.client
      .update(machineCommands)
      .set({ deliveryExpiresAt: new Date(Date.now() - 1) })
      .where(eq(machineCommands.id, first.decommissionCommandId));

    const retry = await machinesService.secureDecommissionMachine(
      machineId,
      adminId,
    );
    expect(retry.decommissionCommandId).toBe(first.decommissionCommandId);
    expect(retry).toMatchObject({
      decommissionCommandStatus: "sent",
      deliveryAttemptCount: 2,
    });
    const firstEnvelope = mqttSignedEnvelopeSchema.parse(
      publish.mock.calls.at(-2)?.[1],
    );
    const retriedEnvelope = mqttSignedEnvelopeSchema.parse(
      publish.mock.calls.at(-1)?.[1],
    );
    expect(retriedEnvelope).toMatchObject({
      messageId: firstEnvelope.messageId,
      payload: firstEnvelope.payload,
    });
    expect(retriedEnvelope.nonce).not.toBe(firstEnvelope.nonce);
    expect(retriedEnvelope.signature).not.toBe(firstEnvelope.signature);

    const commandNo = (
      await database.client
        .select({ commandNo: machineCommands.commandNo })
        .from(machineCommands)
        .where(eq(machineCommands.id, first.decommissionCommandId))
    )[0].commandNo;
    const failedCleanup =
      signatureService.signSecureDecommissionResultWithEncryptedCredential(
        "PG-DECOM-821",
        {
          commandNo,
          success: false,
          reportedAt: new Date().toISOString(),
          error: "WireGuard service removal failed",
        },
        credentials.mqttSigningSecretEncryptedJson,
      );
    await machinesService.handleMachineMessage(
      "vem/machines/PG-DECOM-821/events/secure-decommission-result",
      JSON.stringify(failedCleanup),
    );
    expect(
      (
        await database.client
          .select({ status: machineCommands.status })
          .from(machineCommands)
          .where(eq(machineCommands.id, first.decommissionCommandId))
      )[0].status,
    ).toBe("failed");
    expect(
      (
        await database.client
          .select({ credential: machines.mqttSigningSecretEncryptedJson })
          .from(machines)
          .where(eq(machines.id, machineId))
      )[0].credential,
    ).not.toBeNull();
    await machinesService.secureDecommissionMachine(machineId, adminId);

    const acknowledgement =
      signatureService.signSecureDecommissionResultWithEncryptedCredential(
        "PG-DECOM-821",
        {
          commandNo,
          success: true,
          reportedAt: new Date().toISOString(),
          error: null,
        },
        credentials.mqttSigningSecretEncryptedJson,
      );
    await machinesService.handleMachineMessage(
      "vem/machines/PG-DECOM-821/events/secure-decommission-result",
      JSON.stringify(acknowledgement),
    );

    expect(publish.mock.calls.at(-1)?.[0]).toBe(
      "vem/machines/PG-DECOM-821/commands/secure-decommission-ack",
    );
    expect(
      mqttSignedEnvelopeSchema.parse(publish.mock.calls.at(-1)?.[1]),
    ).toMatchObject({
      messageId: `secure-decommission-ack:${commandNo}`,
      payload: {
        commandNo,
        operation: "secure-decommission-ack",
      },
    });

    const [acknowledged] = await database.client
      .select({
        status: machineCommands.status,
        nextDeliveryAttemptAt: machineCommands.nextDeliveryAttemptAt,
      })
      .from(machineCommands)
      .where(eq(machineCommands.id, first.decommissionCommandId));
    expect(acknowledged.status).toBe("succeeded");
    expect(acknowledged.nextDeliveryAttemptAt).not.toBeNull();
    const [erased] = await database.client
      .select({
        mqttClientId: machines.mqttClientId,
        mqttSigningSecretEncryptedJson: machines.mqttSigningSecretEncryptedJson,
      })
      .from(machines)
      .where(eq(machines.id, machineId));
    expect(erased).toEqual({
      mqttClientId: null,
      mqttSigningSecretEncryptedJson: null,
    });
    expect(
      await database.client
        .select({ action: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, machineId)),
    ).toEqual(
      expect.arrayContaining([
        { action: "machines.secureDecommission" },
        { action: "machines.secureDecommission.localCleanupAcknowledged" },
      ]),
    );

    const restartedService = new MachinesService(
      database.client,
      credentialService,
      service,
      {} as never,
      { record: vi.fn() } as never,
      { publish, registerMachineMessageHandler: vi.fn() } as never,
      signatureService,
      config,
      {} as never,
    );
    const completedRetry = await restartedService.secureDecommissionMachine(
      machineId,
      adminId,
    );
    expect(completedRetry).toMatchObject({
      decommissionCommandId: first.decommissionCommandId,
      decommissionCommandStatus: "succeeded",
      localTunnelRemoval: "acknowledged",
    });
    expect(publish).toHaveBeenCalledTimes(5);
    expect(publish.mock.calls.at(-1)?.[0]).toBe(
      "vem/machines/PG-DECOM-821/commands/secure-decommission-ack",
    );
    expect(
      (
        await database.client
          .select({
            nextDeliveryAttemptAt: machineCommands.nextDeliveryAttemptAt,
          })
          .from(machineCommands)
          .where(eq(machineCommands.id, first.decommissionCommandId))
      )[0].nextDeliveryAttemptAt,
    ).toBeNull();
  });

  it("rolls back platform revocation when durable decommission command creation fails", async () => {
    const machineId = "550e8400-e29b-41d4-a716-446655440841";
    const credentials = credentialService.createBundle();
    await database.client.insert(machines).values({
      id: machineId,
      code: "PG-DECOM-841",
      name: "PostgreSQL decommission rollback",
      status: "online",
      secretHash: credentials.secretHash,
      mqttClientId: "vem-machine-PG-DECOM-841",
      mqttSigningSecretEncryptedJson:
        credentials.mqttSigningSecretEncryptedJson,
    });

    await expect(
      machinesService.secureDecommissionMachine(
        machineId,
        "550e8400-e29b-41d4-a716-446655440849",
      ),
    ).rejects.toMatchObject({ cause: { code: "23503" } });

    const [unchanged] = await database.client
      .select({
        status: machines.status,
        secretHash: machines.secretHash,
        credentialRevokedAt: machines.credentialRevokedAt,
      })
      .from(machines)
      .where(eq(machines.id, machineId));
    expect(unchanged).toEqual({
      status: "online",
      secretHash: credentials.secretHash,
      credentialRevokedAt: null,
    });
  });

  it("does not regress a completed cleanup when publish completion races the result", async () => {
    const machineId = "550e8400-e29b-41d4-a716-446655440861";
    const adminId = "550e8400-e29b-41d4-a716-446655440862";
    const credentials = credentialService.createBundle();
    await database.client.insert(adminUsers).values({
      id: adminId,
      username: "issue08-race-admin",
      passwordHash: "not-used",
      displayName: "Issue08 publish race",
    });
    await database.client.insert(machines).values({
      id: machineId,
      code: "PG-DECOM-861",
      name: "PostgreSQL decommission result race",
      status: "online",
      secretHash: credentials.secretHash,
      mqttClientId: "vem-machine-PG-DECOM-861",
      mqttSigningSecretEncryptedJson:
        credentials.mqttSigningSecretEncryptedJson,
    });

    publish.mockReset();
    let deliveredResult = false;
    publish.mockImplementation(async (topic: string, payload: unknown) => {
      if (topic.endsWith("/commands/secure-decommission") && !deliveredResult) {
        deliveredResult = true;
        const command = mqttSignedEnvelopeSchema.parse(payload);
        const commandNo = String(
          (command.payload as { commandNo?: unknown }).commandNo,
        );
        const result =
          signatureService.signSecureDecommissionResultWithEncryptedCredential(
            "PG-DECOM-861",
            {
              commandNo,
              success: true,
              reportedAt: new Date().toISOString(),
              error: null,
            },
            credentials.mqttSigningSecretEncryptedJson,
          );
        await machinesService.handleMachineMessage(
          "vem/machines/PG-DECOM-861/events/secure-decommission-result",
          JSON.stringify(result),
        );
        throw new Error(
          "publisher stopped after the broker accepted the command",
        );
      }
    });

    const result = await machinesService.secureDecommissionMachine(
      machineId,
      adminId,
    );

    expect(result).toMatchObject({
      decommissionCommandStatus: "succeeded",
      localTunnelRemoval: "acknowledged",
    });
    expect(publish.mock.calls.map(([topic]) => topic)).toEqual([
      "vem/machines/PG-DECOM-861/commands/secure-decommission",
      "vem/machines/PG-DECOM-861/commands/secure-decommission-ack",
    ]);
    const [persisted] = await database.client
      .select({
        status: machineCommands.status,
        nextDeliveryAttemptAt: machineCommands.nextDeliveryAttemptAt,
      })
      .from(machineCommands)
      .where(eq(machineCommands.id, result.decommissionCommandId));
    expect(persisted).toEqual({
      status: "succeeded",
      nextDeliveryAttemptAt: null,
    });
  });
});
