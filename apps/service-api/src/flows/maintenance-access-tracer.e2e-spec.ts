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
  maintenanceSessions,
  sql,
} from "@vem/db";
import {
  adminRoleResponseSchema,
  adminUserResponseSchema,
  auditLogPageResponseSchema,
  maintenanceAccessOverviewResponseSchema,
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
    await db.client
      .update(maintenanceRelayControlState)
      .set({ desiredStateVersion: 0 })
      .where(eq(maintenanceRelayControlState.singletonKey, "default"));
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
    expect(changed.observedState.appliedDesiredStateVersion).toBe(
      changed.desiredState.desiredStateVersion,
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
    const session = await maintenanceAccess.createSession(actor.id, {
      sourcePeerId: sourcePeer.id,
      targetMachineId: machine.id,
      reason: "Verify source peer revocation",
      ttlMinutes: 30,
      protocol: "tcp",
      port: 22,
    });
    const before = await maintenanceAccess.getOverview();

    const revoked = await maintenanceAccess.revokePeer(actor.id, sourcePeer.id);
    const after = await maintenanceAccess.getOverview();

    expect(revoked.revokedSessionIds).toEqual([session.id]);
    expect(after.sessions).toEqual([]);
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
    const session = await maintenanceAccess.createSession(actor.id, {
      sourcePeerId: sourcePeer.id,
      targetMachineId: machine.id,
      reason: "Verify target peer revocation",
      ttlMinutes: 30,
      protocol: "tcp",
      port: 22,
    });

    const revoked = await maintenanceAccess.revokePeer(actor.id, targetPeer.id);
    const overview = await maintenanceAccess.getOverview();

    expect(revoked.revokedSessionIds).toEqual([session.id]);
    expect(overview.sessions).toEqual([]);
    expect(overview.desiredState.authorizations).toEqual([]);
    expect(overview.desiredState.peers).not.toContainEqual(
      expect.objectContaining({ id: targetPeer.id }),
    );
  });

  it("fails closed when an active session references a revoked source peer", async () => {
    const unique = Date.now().toString(36);
    const [actor] = await db.client
      .select({ id: adminUsers.id })
      .from(adminUsers)
      .where(eq(adminUsers.username, config.bootstrapAdminUsername));
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
    const session = await maintenanceAccess.createSession(actor.id, {
      sourcePeerId: sourcePeer.id,
      targetMachineId: machine.id,
      reason: "Verify fail-closed projection",
      ttlMinutes: 30,
      protocol: "tcp",
      port: 22,
    });
    const revokedAt = new Date();
    await db.client
      .update(maintenancePeers)
      .set({ status: "revoked", revokedAt, updatedAt: revokedAt })
      .where(eq(maintenancePeers.id, sourcePeer.id));

    const overview = await maintenanceAccess.getOverview();

    expect(overview.sessions).not.toContainEqual(
      expect.objectContaining({ id: session.id }),
    );
    expect(overview.desiredState.authorizations).not.toContainEqual(
      expect.objectContaining({ sessionId: session.id }),
    );
  });

  it("returns real 403 responses for an authenticated admin without maintenance permissions", async () => {
    const unique = randomUUID().slice(0, 8);
    const adminToken = await loginAndGetToken(api, config);
    const adminAuth = { Authorization: `Bearer ${adminToken}` };
    const roleResponse = await api
      .post("/api/roles")
      .set(adminAuth)
      .send({
        code: `maintenance_forbidden_${unique}`,
        name: `Maintenance forbidden ${unique}`,
        permissionCodes: [permissionCodeSchema.parse("products.read")],
      })
      .expect(201);
    const role = adminRoleResponseSchema.parse(
      (roleResponse.body as ApiResponse<unknown>).data,
    );
    const password = "LimitedPassword123!";
    const username = `maintenance-forbidden-${unique}`;
    const userResponse = await api
      .post("/api/admin-users")
      .set(adminAuth)
      .send({
        username,
        password,
        displayName: `Maintenance forbidden ${unique}`,
        roleIds: [role.id],
      })
      .expect(201);
    adminUserResponseSchema.parse(
      (userResponse.body as ApiResponse<unknown>).data,
    );
    const loginResponse = await api
      .post("/api/auth/login")
      .send({ username, password })
      .expect(200);
    const limitedToken = (
      loginResponse.body as ApiResponse<{ accessToken: string }>
    ).data.accessToken;
    const limitedAuth = { Authorization: `Bearer ${limitedToken}` };

    await api.get("/api/maintenance-access").set(limitedAuth).expect(403);
    await api
      .post("/api/maintenance-access/sessions")
      .set(limitedAuth)
      .send({
        sourcePeerId: randomUUID(),
        targetMachineId: randomUUID(),
        reason: "Must fail at permission gate",
        ttlMinutes: 30,
      })
      .expect(403);
  });

  it("creates one exact runner-to-Platform-Machine SSH session and projects only public relay facts", async () => {
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

    const createdResponse = await api
      .post("/api/maintenance-access/sessions")
      .set(auth)
      .send({
        sourcePeerId: sourcePeer.id,
        targetMachineId: machine.id,
        reason: "Investigate Windows runtime failure",
        ttlMinutes: 30,
      })
      .expect(201);
    const created = maintenanceSessionResponseSchema.parse(
      (createdResponse.body as ApiResponse<unknown>).data,
    );
    expect(created).toMatchObject({
      sourcePeer: { id: sourcePeer.id, role: "runner" },
      targetMachine: { id: machine.id, maintenancePeerId: machinePeer.id },
      protocol: "tcp",
      port: 22,
      status: "active",
    });

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
    expect(overview.observedState.appliedAuthorizationIds).toContain(
      created.id,
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
});
