import type { INestApplication } from "@nestjs/common";

import { Test } from "@nestjs/testing";
import {
  DrizzleDB,
  adminUsers,
  auditLogs,
  eq,
  machines,
  maintenancePeers,
  maintenanceRelayControlState,
  maintenanceRelayDesiredStateRevisions,
  maintenanceSessions,
  sql,
} from "@vem/db";
import {
  adminRoleResponseSchema,
  adminUserResponseSchema,
  auditLogResponseSchema,
  auditLogPageResponseSchema,
  maintenanceAccessOverviewResponseSchema,
  maintenanceRelayDesiredStateSchema,
  maintenanceSessionResponseSchema,
  permissionCodeSchema,
} from "@vem/shared";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { MaintenanceAccessService } from "../maintenance-access/maintenance-access.service";
import { parseMaintenanceAddressPools } from "../maintenance-access/maintenance-address-pools";
import { MqttService } from "../mqtt/mqtt.service";
import { loginAndGetToken, type ApiResponse } from "./flow-test-helpers";

function wireGuardPublicKey(_byte?: number): string {
  return randomBytes(32).toString("base64");
}

describe("maintenance-access tracer flow", { concurrent: false }, () => {
  let app: INestApplication;
  let config: AppConfigService;
  let db: DrizzleDB;
  let api: ReturnType<typeof request>;
  let maintenanceAccess: MaintenanceAccessService;
  let smallPoolMaintenanceAccess: MaintenanceAccessService;

  async function provisionAdminAuth(
    label: "read_only" | "writer",
    permissionCodes: ("maintenanceAccess.read" | "maintenanceAccess.write")[],
  ): Promise<{ Authorization: string }> {
    const unique = randomUUID().slice(0, 8);
    const bootstrapToken = await loginAndGetToken(api, config);
    const bootstrapAuth = { Authorization: `Bearer ${bootstrapToken}` };
    const role = adminRoleResponseSchema.parse(
      (
        await api
          .post("/api/roles")
          .set(bootstrapAuth)
          .send({
            code: `maintenance_${label}_${unique}`,
            name: `Maintenance ${label} ${unique}`,
            permissionCodes: permissionCodes.map((permissionCode) =>
              permissionCodeSchema.parse(permissionCode),
            ),
          })
          .expect(201)
      ).body.data,
    );
    const password = "MaintenancePassword123!";
    const username = `maintenance-${label}-${unique}`;
    adminUserResponseSchema.parse(
      (
        await api
          .post("/api/admin-users")
          .set(bootstrapAuth)
          .send({
            username,
            password,
            displayName: `Maintenance ${label} ${unique}`,
            roleIds: [role.id],
          })
          .expect(201)
      ).body.data,
    );
    const token = (
      (
        await api
          .post("/api/auth/login")
          .send({ username, password })
          .expect(200)
      ).body as ApiResponse<{ accessToken: string }>
    ).data.accessToken;

    return { Authorization: `Bearer ${token}` };
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MqttService)
      .useValue({
        bindVendingService: () => undefined,
        registerMachineMessageHandler: () => undefined,
        isConnected: () => false,
        publish: async () => undefined,
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
    config = app.get(AppConfigService);
    db = new DrizzleDB(config.databaseUrl);
    await db.connect();
    api = request(app.getHttpServer());
    maintenanceAccess = app.get(MaintenanceAccessService);
    smallPoolMaintenanceAccess = new MaintenanceAccessService(
      app.get(DRIZZLE_CLIENT),
      {
        maintenanceAddressPools: parseMaintenanceAddressPools({
          relay: "10.101.0.0/30",
          runner: "10.101.1.0/30",
          maintainer: "10.101.2.0/30",
          machine: "10.101.3.0/30",
        }),
      } as AppConfigService,
    );
  }, 60_000);

  afterAll(async () => {
    await db?.disconnect();
    await app?.close();
  });

  beforeEach(async () => {
    await db.client.delete(maintenanceSessions);
    await db.client.delete(maintenancePeers);
    await db.client.delete(maintenanceRelayDesiredStateRevisions);
    const resetAt = new Date();
    await db.client
      .update(maintenanceRelayControlState)
      .set({ desiredStateVersion: 0, observedState: null, updatedAt: resetAt })
      .where(eq(maintenanceRelayControlState.singletonKey, "default"));
    await db.client.insert(maintenanceRelayDesiredStateRevisions).values({
      revision: 0,
      desiredState: {
        schemaVersion: "maintenance-relay-desired-state/v1",
        desiredStateVersion: 0,
        generatedAt: resetAt.toISOString(),
        peers: [],
        authorizations: [],
      },
      createdAt: resetAt,
    });
  });

  it("rejects inconsistent maintenance peer lifecycle rows at the persistence boundary", async () => {
    await expect(
      db.client.insert(maintenancePeers).values({
        role: "runner",
        publicKey: wireGuardPublicKey(240),
        tunnelAddress: "10.91.3.240",
        status: "active",
        revokedAt: new Date(),
      }),
    ).rejects.toThrow();

    await expect(
      db.client.insert(maintenancePeers).values({
        role: "runner",
        publicKey: wireGuardPublicKey(241),
        tunnelAddress: "10.91.3.241",
        status: "revoked",
        revokedAt: null,
      }),
    ).rejects.toThrow();
  });

  it("initializes a durable desired-state version for the maintenance relay projection", async () => {
    const result = await db.client.execute(sql`
      SELECT desired_state_version
      FROM maintenance_relay_control_state
      WHERE singleton_key = 'default'
    `);

    expect(result.rows).toEqual([{ desired_state_version: "0" }]);
  });

  it("persists a monotonic desired-state version without incrementing on reads", async () => {
    const initial = await maintenanceAccess.getOverview();
    await maintenanceAccess.registerPeer({
      role: "runner",
      publicKey: wireGuardPublicKey(216),
    });

    const changed = await maintenanceAccess.getOverview();
    const reread = await smallPoolMaintenanceAccess.getOverview();

    expect(changed.desiredState.desiredStateVersion).toBe(
      initial.desiredState.desiredStateVersion + 1,
    );
    expect(reread.desiredState.desiredStateVersion).toBe(
      changed.desiredState.desiredStateVersion,
    );
    expect(changed.observedState.appliedDesiredStateVersion).toBe(0);
    expect(changed.observedState.failure).toBeNull();
    expect(changed.relayFailure).toBeNull();
    expect(changed.observedState.transport).toEqual({
      mode: "unknown",
      health: "unreported",
      reason: "relay transport has not been reported",
    });
    expect(changed.relayHealth).toEqual({
      observation: "unreported",
      overall: "unknown",
      stale: false,
      observedAt: null,
    });
  });

  it("projects an old relay report as stale with unknown overall health", async () => {
    const desired = await maintenanceAccess.getRelayDesiredState();
    const observedAt = new Date(Date.now() - 31_000).toISOString();
    await maintenanceAccess.reportRelayObservedState({
      schemaVersion: "maintenance-relay-observed-state/v1",
      observedAt,
      desiredStateSchemaVersion: desired.schemaVersion,
      appliedDesiredStateVersion: desired.desiredStateVersion,
      attemptedDesiredStateVersion: null,
      appliedPeerIds: [],
      appliedAuthorizationIds: [],
      peerObservations: [],
      activeAuthorizationObservations: [],
      transport: { mode: "https", health: "healthy", reason: null },
      failure: null,
    });

    expect((await maintenanceAccess.getOverview()).relayHealth).toEqual({
      observation: "stale",
      overall: "unknown",
      stale: true,
      observedAt,
    });
  });

  it("returns identical relay payload content for repeated reads of one revision", async () => {
    await maintenanceAccess.registerPeer({
      role: "runner",
      publicKey: wireGuardPublicKey(217),
    });

    const first = await maintenanceAccess.getRelayDesiredState();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await maintenanceAccess.getRelayDesiredState();

    expect(second).toEqual(first);
  });

  it("rejects observed-state time/revision rollback and IDs outside the applied revision", async () => {
    const peer = await maintenanceAccess.registerPeer({
      role: "runner",
      publicKey: wireGuardPublicKey(218),
    });
    const relayDesired = await maintenanceAccess.getRelayDesiredState();
    const observedAt = new Date(Date.now() + 1_000).toISOString();
    const observed = {
      schemaVersion: "maintenance-relay-observed-state/v1" as const,
      observedAt,
      desiredStateSchemaVersion: relayDesired.schemaVersion,
      appliedDesiredStateVersion: relayDesired.desiredStateVersion,
      attemptedDesiredStateVersion: null,
      appliedPeerIds: [peer.id],
      appliedAuthorizationIds: [],
      peerObservations: [{ peerId: peer.id, latestHandshakeAt: null }],
      activeAuthorizationObservations: [],
      transport: { mode: "https", health: "healthy", reason: null },
      failure: null,
    };
    await maintenanceAccess.reportRelayObservedState(observed);

    await expect(
      maintenanceAccess.reportRelayObservedState({
        ...observed,
        observedAt: new Date(Date.parse(observedAt) - 1).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      maintenanceAccess.reportRelayObservedState({
        ...observed,
        appliedDesiredStateVersion: 0,
        appliedPeerIds: [],
        peerObservations: [],
        observedAt: new Date(Date.parse(observedAt) + 1).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      maintenanceAccess.reportRelayObservedState({
        ...observed,
        appliedPeerIds: [randomUUID()],
        peerObservations: [{ peerId: randomUUID(), latestHandshakeAt: null }],
        observedAt: new Date(Date.parse(observedAt) + 2).toISOString(),
      }),
    ).rejects.toMatchObject({ status: 400 });

    const newer = {
      ...observed,
      observedAt: new Date(Date.parse(observedAt) + 3).toISOString(),
    };
    const newest = {
      ...observed,
      observedAt: new Date(Date.parse(observedAt) + 4).toISOString(),
    };
    await Promise.allSettled([
      maintenanceAccess.reportRelayObservedState(newest),
      maintenanceAccess.reportRelayObservedState(newer),
    ]);

    expect((await maintenanceAccess.getOverview()).observedState).toEqual(
      newest,
    );
  });

  it("returns 409 for a duplicate active machine peer instead of exhausting a small address pool", async () => {
    const unique = Date.now().toString(36);
    const [machine] = await db.client
      .insert(machines)
      .values({
        code: `VEM-MAINT-DUP-${unique}`,
        name: `Duplicate machine ${unique}`,
        status: "online",
      })
      .returning({ id: machines.id });

    await smallPoolMaintenanceAccess.registerPeer({
      role: "machine",
      publicKey: wireGuardPublicKey(210),
      machineId: machine.id,
    });

    await expect(
      smallPoolMaintenanceAccess.registerPeer({
        role: "machine",
        publicKey: wireGuardPublicKey(211),
        machineId: machine.id,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("allocates distinct addresses concurrently and bounds small-pool exhaustion", async () => {
    const [firstPeer, secondPeer] = await Promise.all([
      smallPoolMaintenanceAccess.registerPeer({
        role: "runner",
        publicKey: wireGuardPublicKey(212),
      }),
      smallPoolMaintenanceAccess.registerPeer({
        role: "runner",
        publicKey: wireGuardPublicKey(213),
      }),
    ]);

    expect(
      new Set([firstPeer.tunnelAddress, secondPeer.tunnelAddress]),
    ).toEqual(new Set(["10.101.1.1", "10.101.1.2"]));
    await expect(
      smallPoolMaintenanceAccess.registerPeer({
        role: "runner",
        publicKey: wireGuardPublicKey(214),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("returns 409 when a peer public key is registered twice", async () => {
    const publicKey = wireGuardPublicKey(215);
    await smallPoolMaintenanceAccess.registerPeer({
      role: "runner",
      publicKey,
    });

    await expect(
      smallPoolMaintenanceAccess.registerPeer({
        role: "maintainer",
        publicKey,
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("atomically revokes sessions and audits when their source peer is revoked", async () => {
    const unique = Date.now().toString(36);
    const [actor] = await db.client
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.username, config.bootstrapAdminUsername));
    const [machine] = await db.client
      .insert(machines)
      .values({
        code: `VEM-MAINT-SOURCE-${unique}`,
        name: `Source revoke ${unique}`,
        status: "online",
      })
      .returning({ id: machines.id });
    const sourcePeer = await maintenanceAccess.registerPeer({
      role: "runner",
      publicKey: wireGuardPublicKey(217),
    });
    await maintenanceAccess.registerPeer({
      role: "machine",
      publicKey: wireGuardPublicKey(218),
      machineId: machine.id,
    });
    const session = await maintenanceAccess.createCiSession({
      sourcePeerId: sourcePeer.id,
      targetMachineId: machine.id,
      automationActorId: "test:source-peer-revocation",
      reason: "Verify source peer revocation",
      protocol: "tcp",
      port: 22,
    });
    const before = await maintenanceAccess.getOverview();

    const revoked = await maintenanceAccess.revokePeer(actor.id, sourcePeer.id);
    const after = await maintenanceAccess.getOverview();

    expect(revoked.revokedSessionIds).toEqual([session.id]);
    expect(after.sessions).toContainEqual(
      expect.objectContaining({ id: session.id, status: "revoked" }),
    );
    expect(after.desiredState.authorizations).toEqual([]);
    expect(after.desiredState.desiredStateVersion).toBe(
      before.desiredState.desiredStateVersion + 1,
    );

    const persistedSessions = await db.client
      .select({ revokedAt: maintenanceSessions.revokedAt })
      .from(maintenanceSessions)
      .where(eq(maintenanceSessions.id, session.id));
    expect(persistedSessions[0]?.revokedAt).toBeInstanceOf(Date);
    const auditEntries = await db.client
      .select({ action: auditLogs.action, resourceId: auditLogs.resourceId })
      .from(auditLogs);
    expect(auditEntries).toContainEqual({
      action: "maintenanceAccess.session.revoke",
      resourceId: session.id,
    });
    expect(auditEntries).toContainEqual({
      action: "maintenanceAccess.peer.revoke",
      resourceId: sourcePeer.id,
    });
  });

  it("removes dependent authorization when its target machine peer is revoked", async () => {
    const unique = Date.now().toString(36);
    const [actor] = await db.client
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.username, config.bootstrapAdminUsername));
    const [machine] = await db.client
      .insert(machines)
      .values({
        code: `VEM-MAINT-TARGET-${unique}`,
        name: `Target revoke ${unique}`,
        status: "online",
      })
      .returning({ id: machines.id });
    const sourcePeer = await maintenanceAccess.registerPeer({
      role: "runner",
      publicKey: wireGuardPublicKey(219),
    });
    const targetPeer = await maintenanceAccess.registerPeer({
      role: "machine",
      publicKey: wireGuardPublicKey(220),
      machineId: machine.id,
    });
    const session = await maintenanceAccess.createCiSession({
      sourcePeerId: sourcePeer.id,
      targetMachineId: machine.id,
      automationActorId: "test:target-peer-revocation",
      reason: "Verify target peer revocation",
      protocol: "tcp",
      port: 22,
    });

    const revoked = await maintenanceAccess.revokePeer(actor.id, targetPeer.id);
    const overview = await maintenanceAccess.getOverview();

    expect(revoked.revokedSessionIds).toEqual([session.id]);
    expect(overview.sessions).toContainEqual(
      expect.objectContaining({ id: session.id, status: "revoked" }),
    );
    expect(overview.desiredState.authorizations).toEqual([]);
    expect(overview.desiredState.peers).not.toContainEqual(
      expect.objectContaining({ id: targetPeer.id }),
    );
  });

  it("keeps a published relay revision immutable after an out-of-band peer change", async () => {
    const unique = Date.now().toString(36);
    const [machine] = await db.client
      .insert(machines)
      .values({
        code: `VEM-MAINT-STALE-${unique}`,
        name: `Stale authorization ${unique}`,
        status: "online",
      })
      .returning({ id: machines.id });
    const sourcePeer = await maintenanceAccess.registerPeer({
      role: "runner",
      publicKey: wireGuardPublicKey(221),
    });
    await maintenanceAccess.registerPeer({
      role: "machine",
      publicKey: wireGuardPublicKey(222),
      machineId: machine.id,
    });
    const session = await maintenanceAccess.createCiSession({
      sourcePeerId: sourcePeer.id,
      targetMachineId: machine.id,
      automationActorId: "test:immutable-relay-revision",
      reason: "Verify fail-closed projection",
      protocol: "tcp",
      port: 22,
    });
    const published = await maintenanceAccess.getRelayDesiredState();
    const revokedAt = new Date();
    await db.client
      .update(maintenancePeers)
      .set({ status: "revoked", revokedAt, updatedAt: revokedAt })
      .where(eq(maintenancePeers.id, sourcePeer.id));

    const overview = await maintenanceAccess.getOverview();

    expect(overview.sessions).toContainEqual(
      expect.objectContaining({ id: session.id, status: "active" }),
    );
    expect(overview.desiredState).toEqual(published);
  });

  it("allows a read-only admin to list sessions but returns real 403 responses for create and revoke", async () => {
    const readOnlyAuth = await provisionAdminAuth("read_only", [
      "maintenanceAccess.read",
    ]);
    const listed = maintenanceSessionResponseSchema
      .array()
      .parse(
        (
          await api
            .get("/api/maintenance-access/sessions")
            .set(readOnlyAuth)
            .expect(200)
        ).body.data,
      );

    expect(listed).toEqual([]);
    await api
      .post("/api/maintenance-access/sessions")
      .set(readOnlyAuth)
      .send({
        sourcePeerId: randomUUID(),
        targetMachineId: randomUUID(),
        reason: "Must fail at permission gate",
        ttlMinutes: 30,
      })
      .expect(403);
    await api
      .post(`/api/maintenance-access/sessions/${randomUUID()}/revoke`)
      .set(readOnlyAuth)
      .expect(403);
  });

  it("creates one exact CI runner-to-Platform-Machine SSH session and projects only public relay facts", async () => {
    const unique = Date.now().toString(36);
    const token = await loginAndGetToken(api, config);
    const auth = { Authorization: `Bearer ${token}` };
    const [machine] = await db.client
      .insert(machines)
      .values({
        code: `VEM-MAINT-${unique}`,
        name: `Maintenance tracer ${unique}`,
        status: "online",
      })
      .returning({ id: machines.id });

    const [sourcePeer, secondSourcePeer] = await Promise.all([
      maintenanceAccess.registerPeer({
        role: "runner",
        publicKey: wireGuardPublicKey(1),
      }),
      maintenanceAccess.registerPeer({
        role: "runner",
        publicKey: wireGuardPublicKey(2),
      }),
    ]);
    expect(secondSourcePeer.id).not.toBe(sourcePeer.id);
    expect(secondSourcePeer.tunnelAddress).not.toBe(sourcePeer.tunnelAddress);
    const machinePeer = await maintenanceAccess.registerPeer({
      role: "machine",
      publicKey: wireGuardPublicKey(3),
      machineId: machine.id,
    });
    expect(sourcePeer.tunnelAddress).not.toBe(machinePeer.tunnelAddress);

    const created = maintenanceSessionResponseSchema.parse(
      await maintenanceAccess.createCiSession({
        sourcePeerId: sourcePeer.id,
        targetMachineId: machine.id,
        automationActorId: "test:runner-http-tracer",
        reason: "Investigate Windows runtime failure",
        protocol: "tcp",
        port: 22,
      }),
    );
    expect(created).toMatchObject({
      kind: "ci",
      actor: {
        type: "automation",
        automationActorId: "test:runner-http-tracer",
      },
      sourcePeer: { id: sourcePeer.id, role: "runner" },
      targetMachine: { id: machine.id, maintenancePeerId: machinePeer.id },
      protocol: "tcp",
      port: 22,
      status: "active",
    });
    expect(
      (Date.parse(created.expiresAt) - Date.parse(created.issuedAt)) / 60_000,
    ).toBe(150);

    const overviewResponse = await api
      .get("/api/maintenance-access")
      .set(auth)
      .expect(200);
    const overview = maintenanceAccessOverviewResponseSchema.parse(
      (overviewResponse.body as ApiResponse<unknown>).data,
    );
    expect(overview.sessions).toContainEqual(
      expect.objectContaining({ id: created.id, status: "active" }),
    );
    expect(overview.desiredState.authorizations).toContainEqual({
      sessionId: created.id,
      sourcePeerId: sourcePeer.id,
      sourceTunnelAddress: sourcePeer.tunnelAddress,
      targetMachineId: machine.id,
      targetTunnelAddress: machinePeer.tunnelAddress,
      protocol: "tcp",
      port: 22,
      expiresAt: created.expiresAt,
    });
    const credentialExchange = await api
      .post("/api/maintenance-relay/credential-exchange")
      .send({ credential: config.maintenanceRelayCredential })
      .expect(201);
    const relayToken = (
      credentialExchange.body as ApiResponse<{ accessToken: string }>
    ).data.accessToken;
    const relayAuth = { Authorization: `Bearer ${relayToken}` };
    const desiredResponse = await api
      .get("/api/maintenance-relay/desired-state")
      .set(relayAuth)
      .expect(200);
    const relayDesired = maintenanceRelayDesiredStateSchema.parse(
      (desiredResponse.body as ApiResponse<unknown>).data,
    );
    const reportedObserved = {
      schemaVersion: "maintenance-relay-observed-state/v1",
      observedAt: new Date().toISOString(),
      desiredStateSchemaVersion: relayDesired.schemaVersion,
      appliedDesiredStateVersion: relayDesired.desiredStateVersion,
      attemptedDesiredStateVersion: null,
      appliedPeerIds: relayDesired.peers.map((peer) => peer.id),
      appliedAuthorizationIds: relayDesired.authorizations.map(
        (authorization) => authorization.sessionId,
      ),
      peerObservations: relayDesired.peers.map((peer) => ({
        peerId: peer.id,
        latestHandshakeAt: null,
      })),
      activeAuthorizationObservations: relayDesired.authorizations.map(
        (authorization) => ({
          sessionId: authorization.sessionId,
          expiresAt: authorization.expiresAt,
        }),
      ),
      transport: {
        mode: "insecure-http",
        health: "degraded",
        reason: "Service API uses explicitly allowed insecure HTTP",
      },
      failure: null,
    };
    await api
      .post("/api/maintenance-relay/observed-state")
      .set(relayAuth)
      .send(reportedObserved)
      .expect(201);
    const refreshedOverview = maintenanceAccessOverviewResponseSchema.parse(
      (await api.get("/api/maintenance-access").set(auth).expect(200)).body
        .data,
    );
    expect(refreshedOverview.observedState.appliedAuthorizationIds).toContain(
      created.id,
    );
    expect(refreshedOverview.observedState.transport).toEqual(
      reportedObserved.transport,
    );
    expect(JSON.stringify(overview.desiredState)).not.toMatch(
      /privateKey|shell|iptables/i,
    );

    const auditResponse = await api
      .get("/api/audit-logs")
      .set(auth)
      .query({ resourceType: "maintenance_session", resourceId: created.id })
      .expect(200);
    const audit = auditLogPageResponseSchema.parse(
      (auditResponse.body as ApiResponse<unknown>).data,
    );
    expect(audit.items).toContainEqual(
      expect.objectContaining({
        action: "maintenanceAccess.session.create",
        resourceId: created.id,
      }),
    );
    expect(JSON.stringify(audit.items)).not.toMatch(/privateKey|private_key/i);

    await api
      .post("/api/maintenance-access/sessions")
      .set(auth)
      .send({
        sourcePeerId: sourcePeer.id,
        targetMachineId: machine.id,
        reason: "Attempt a broad policy",
        ttlMinutes: 30,
        port: 3389,
      })
      .expect(400);
  }, 60_000);

  it("runs the Admin human maintainer lifecycle through activation, revocation, filtering, and relay convergence", async () => {
    const unique = Date.now().toString(36);
    const auth = await provisionAdminAuth("writer", [
      "maintenanceAccess.read",
      "maintenanceAccess.write",
    ]);
    const [machine] = await db.client
      .insert(machines)
      .values({
        code: `VEM-HUMAN-${unique}`,
        name: `Human maintenance ${unique}`,
        status: "online",
      })
      .returning({ id: machines.id });
    const runner = await maintenanceAccess.registerPeer({
      role: "runner",
      publicKey: wireGuardPublicKey(),
    });
    const maintainer = await maintenanceAccess.registerPeer({
      role: "maintainer",
      publicKey: wireGuardPublicKey(),
    });
    const machinePeer = await maintenanceAccess.registerPeer({
      role: "machine",
      publicKey: wireGuardPublicKey(),
      machineId: machine.id,
    });

    await api
      .post("/api/maintenance-access/sessions")
      .set(auth)
      .send({
        sourcePeerId: runner.id,
        targetMachineId: machine.id,
        reason: "Runner must not be an Admin human source",
        ttlMinutes: 30,
      })
      .expect(404);

    const createdResponse = await api
      .post("/api/maintenance-access/sessions")
      .set(auth)
      .send({
        sourcePeerId: maintainer.id,
        targetMachineId: machine.id,
        reason: "Investigate Windows runtime failure",
        ttlMinutes: 30,
      })
      .expect(201);
    const created = maintenanceSessionResponseSchema.parse(
      (createdResponse.body as ApiResponse<unknown>).data,
    );
    expect(created).toMatchObject({
      sourcePeer: { id: maintainer.id, role: "maintainer" },
      targetMachine: { id: machine.id, maintenancePeerId: machinePeer.id },
      status: "active",
      relayConvergence: { state: "unknown" },
    });

    const relayToken = (
      (
        await api
          .post("/api/maintenance-relay/credential-exchange")
          .send({ credential: config.maintenanceRelayCredential })
          .expect(201)
      ).body as ApiResponse<{ accessToken: string }>
    ).data.accessToken;
    const relayAuth = { Authorization: `Bearer ${relayToken}` };
    const desired = maintenanceRelayDesiredStateSchema.parse(
      (
        await api
          .get("/api/maintenance-relay/desired-state")
          .set(relayAuth)
          .expect(200)
      ).body.data,
    );
    await api
      .post("/api/maintenance-relay/observed-state")
      .set(relayAuth)
      .send({
        schemaVersion: "maintenance-relay-observed-state/v1",
        observedAt: new Date().toISOString(),
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
            peer.id === maintainer.id ? new Date().toISOString() : null,
        })),
        activeAuthorizationObservations: desired.authorizations.map(
          (authorization) => ({
            sessionId: authorization.sessionId,
            expiresAt: authorization.expiresAt,
          }),
        ),
        transport: { mode: "https", health: "healthy", reason: null },
        failure: null,
      })
      .expect(201);

    const activated = maintenanceAccessOverviewResponseSchema.parse(
      (await api.get("/api/maintenance-access").set(auth).expect(200)).body
        .data,
    );
    expect(activated.peerHealth).toContainEqual(
      expect.objectContaining({
        peer: expect.objectContaining({ id: maintainer.id }),
        relayApplied: true,
        health: "healthy",
      }),
    );
    expect(activated.sessions).toContainEqual(
      expect.objectContaining({
        id: created.id,
        activatedAt: expect.any(String),
        relayConvergence: expect.objectContaining({ state: "applied" }),
      }),
    );

    await api
      .post(`/api/maintenance-access/sessions/${created.id}/revoke`)
      .set(auth)
      .expect(201);
    const afterRevoke = maintenanceAccessOverviewResponseSchema.parse(
      (await api.get("/api/maintenance-access").set(auth).expect(200)).body
        .data,
    );
    const revoked = afterRevoke.sessions.find(
      (session) => session.id === created.id,
    );
    expect(revoked).toMatchObject({
      status: "revoked",
      relayConvergence: { state: "pending" },
    });

    const removalDesired = maintenanceRelayDesiredStateSchema.parse(
      (
        await api
          .get("/api/maintenance-relay/desired-state")
          .set(relayAuth)
          .expect(200)
      ).body.data,
    );
    await api
      .post("/api/maintenance-relay/observed-state")
      .set(relayAuth)
      .send({
        schemaVersion: "maintenance-relay-observed-state/v1",
        observedAt: new Date(Date.now() + 1).toISOString(),
        desiredStateSchemaVersion: removalDesired.schemaVersion,
        appliedDesiredStateVersion: removalDesired.desiredStateVersion,
        attemptedDesiredStateVersion: null,
        appliedPeerIds: removalDesired.peers.map((peer) => peer.id),
        appliedAuthorizationIds: [],
        peerObservations: removalDesired.peers.map((peer) => ({
          peerId: peer.id,
          latestHandshakeAt: null,
        })),
        activeAuthorizationObservations: [],
        transport: {
          mode: "insecure-http",
          health: "degraded",
          reason: "Test transport exception",
        },
        failure: null,
      })
      .expect(201);
    const revokedList = maintenanceSessionResponseSchema
      .array()
      .parse(
        (
          await api
            .get("/api/maintenance-access/sessions")
            .set(auth)
            .query({ status: "revoked" })
            .expect(200)
        ).body.data,
      );
    expect(revokedList).toContainEqual(
      expect.objectContaining({
        id: created.id,
        relayConvergence: expect.objectContaining({ state: "removed" }),
      }),
    );

    const audit = auditLogResponseSchema
      .array()
      .parse(
        (
          await api
            .get("/api/maintenance-access/audit")
            .set(auth)
            .query({ sessionId: created.id })
            .expect(200)
        ).body.data,
      );
    expect(audit.map((item) => item.action)).toEqual(
      expect.arrayContaining([
        "maintenanceAccess.session.create",
        "maintenanceAccess.session.activate",
        "maintenanceAccess.session.revoke",
      ]),
    );
    expect(audit.map((item) => item.action)).not.toContain(
      "maintenanceAccess.session.certificate.linkage.pending",
    );
    expect(
      JSON.stringify({ created, activated, revokedList, audit }),
    ).not.toMatch(/privateKey|credential|accessToken|certificatePrivate/i);
  }, 60_000);
});
