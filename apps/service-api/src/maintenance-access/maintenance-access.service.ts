import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  and,
  asc,
  auditLogs,
  desc,
  eq,
  gt,
  isNull,
  machines,
  maintenancePeers,
  maintenanceRelayControlState,
  maintenanceSessions,
  or,
  sql,
  type DrizzleClient,
} from "@vem/db";
import {
  maintenanceAccessOverviewResponseSchema,
  maintenancePublicPeerSchema,
  maintenanceRelayDesiredStateSchema,
  maintenanceSessionResponseSchema,
  registerMaintenancePeerRequestSchema,
  type CreateMaintenanceSessionRequest,
  type MaintenancePeerRole,
  type MaintenancePublicPeer,
  type RegisterMaintenancePeerRequest,
  type MaintenanceSessionResponse,
  type MaintenanceTargetMachine,
} from "@vem/shared";

import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { allocateTunnelAddress } from "./maintenance-address-pools";
import { observeMaintenanceRelayDesiredState } from "./maintenance-relay-observation";

type TargetMachineRow = {
  id: string;
  code: string;
  name: string;
  maintenancePeerId: string;
  tunnelAddress: string;
};

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toPublicPeer(row: {
  id: string;
  role: MaintenancePeerRole;
  publicKey: string;
  tunnelAddress: string;
}): MaintenancePublicPeer {
  return maintenancePublicPeerSchema.parse({
    id: row.id,
    role: row.role,
    publicKey: row.publicKey,
    tunnelAddress: row.tunnelAddress,
  });
}

function toTargetMachine(row: TargetMachineRow): MaintenanceTargetMachine {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    maintenancePeerId: row.maintenancePeerId,
    tunnelAddress: row.tunnelAddress,
  };
}

function sessionStatus(
  session: {
    expiresAt: Date | string;
    revokedAt: Date | string | null;
  },
  now: Date,
): "active" | "expired" | "revoked" {
  if (session.revokedAt) return "revoked";
  return new Date(session.expiresAt).getTime() > now.getTime()
    ? "active"
    : "expired";
}

function postgresUniqueConstraint(error: unknown): string | undefined {
  let current = error;
  while (current && typeof current === "object") {
    const candidate = current as {
      code?: unknown;
      constraint?: unknown;
      cause?: unknown;
    };
    if (candidate.code === "23505") {
      return typeof candidate.constraint === "string"
        ? candidate.constraint
        : undefined;
    }
    current = candidate.cause;
  }
  return undefined;
}

@Injectable()
export class MaintenanceAccessService {
  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly config: AppConfigService,
  ) {}

  async registerPeer(input: RegisterMaintenancePeerRequest) {
    const parsed = registerMaintenancePeerRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException("Invalid maintenance peer registration");
    }
    const registration = parsed.data;
    const machineId =
      registration.role === "machine" ? registration.machineId : undefined;

    return await this.db.transaction(async (tx) => {
      if (machineId) {
        const [machine] = await tx
          .select({ id: machines.id })
          .from(machines)
          .where(and(eq(machines.id, machineId), isNull(machines.deletedAt)));
        if (!machine) throw new NotFoundException("Platform Machine not found");
      }

      const [existingPublicKey] = await tx
        .select({ id: maintenancePeers.id })
        .from(maintenancePeers)
        .where(eq(maintenancePeers.publicKey, registration.publicKey));
      if (existingPublicKey) {
        throw new ConflictException(
          "Maintenance peer public key already exists",
        );
      }
      if (machineId) {
        const [existingMachinePeer] = await tx
          .select({ id: maintenancePeers.id })
          .from(maintenancePeers)
          .where(
            and(
              eq(maintenancePeers.machineId, machineId),
              eq(maintenancePeers.role, "machine"),
              eq(maintenancePeers.status, "active"),
              isNull(maintenancePeers.revokedAt),
            ),
          );
        if (existingMachinePeer) {
          throw new ConflictException(
            "Platform Machine already has an active maintenance peer",
          );
        }
      }

      const usedRows = await tx
        .select({ tunnelAddress: maintenancePeers.tunnelAddress })
        .from(maintenancePeers);
      const usedAddresses = new Set(usedRows.map((row) => row.tunnelAddress));
      const pool = this.config.maintenanceAddressPools[registration.role];
      const usableAddressCount = pool.lastHost - pool.firstHost + 1;

      // oxlint-disable no-await-in-loop -- address conflicts must be retried sequentially within this bounded transaction
      for (let attempt = 0; attempt < usableAddressCount; attempt += 1) {
        let tunnelAddress: string;
        try {
          tunnelAddress = allocateTunnelAddress(pool, usedAddresses);
        } catch {
          throw new ConflictException(
            `Maintenance address pool ${pool.cidr} is exhausted`,
          );
        }

        try {
          const [created] = await tx
            .insert(maintenancePeers)
            .values({
              role: registration.role,
              publicKey: registration.publicKey,
              tunnelAddress,
              machineId,
              status: "active",
            })
            .onConflictDoNothing({ target: maintenancePeers.tunnelAddress })
            .returning();
          if (created) {
            await this.bumpDesiredStateVersion(tx);
            return created;
          }
        } catch (error) {
          const constraint = postgresUniqueConstraint(error);
          if (constraint === "maintenance_peers_public_key_unique") {
            throw new ConflictException(
              "Maintenance peer public key already exists",
            );
          }
          if (constraint === "maintenance_peers_active_machine_unique") {
            throw new ConflictException(
              "Platform Machine already has an active maintenance peer",
            );
          }
          throw error;
        }
        usedAddresses.add(tunnelAddress);
      }
      // oxlint-enable no-await-in-loop

      throw new ConflictException(
        `Maintenance address pool ${pool.cidr} is exhausted`,
      );
    });
  }

  async revokePeer(actorAdminUserId: string, peerId: string) {
    const revokedAt = new Date();
    return await this.db.transaction(async (tx) => {
      const [peer] = await tx
        .select({
          id: maintenancePeers.id,
          role: maintenancePeers.role,
          machineId: maintenancePeers.machineId,
          status: maintenancePeers.status,
          revokedAt: maintenancePeers.revokedAt,
        })
        .from(maintenancePeers)
        .where(eq(maintenancePeers.id, peerId))
        .for("update");
      if (!peer) {
        throw new NotFoundException("Maintenance peer not found");
      }
      if (peer.status !== "active" || peer.revokedAt) {
        throw new ConflictException("Maintenance peer is already revoked");
      }

      const dependentSession =
        peer.role === "machine" && peer.machineId
          ? or(
              eq(maintenanceSessions.sourcePeerId, peer.id),
              eq(maintenanceSessions.targetMachineId, peer.machineId),
            )
          : eq(maintenanceSessions.sourcePeerId, peer.id);
      const revokedSessions = await tx
        .update(maintenanceSessions)
        .set({ revokedAt })
        .where(and(isNull(maintenanceSessions.revokedAt), dependentSession))
        .returning({ id: maintenanceSessions.id });

      await tx
        .update(maintenancePeers)
        .set({
          status: "revoked",
          revokedAt,
          updatedAt: revokedAt,
        })
        .where(eq(maintenancePeers.id, peer.id));

      if (revokedSessions.length > 0) {
        await tx.insert(auditLogs).values(
          revokedSessions.map((session) => ({
            adminUserId: actorAdminUserId,
            action: "maintenanceAccess.session.revoke",
            resourceType: "maintenance_session",
            resourceId: session.id,
            afterJson: {
              revokedAt: revokedAt.toISOString(),
              revokedByPeerId: peer.id,
            },
          })),
        );
      }
      await tx.insert(auditLogs).values({
        adminUserId: actorAdminUserId,
        action: "maintenanceAccess.peer.revoke",
        resourceType: "maintenance_peer",
        resourceId: peer.id,
        beforeJson: {
          role: peer.role,
          machineId: peer.machineId,
          status: peer.status,
        },
        afterJson: {
          role: peer.role,
          machineId: peer.machineId,
          status: "revoked",
          revokedAt: revokedAt.toISOString(),
          revokedSessionIds: revokedSessions.map((session) => session.id),
        },
      });
      await this.bumpDesiredStateVersion(tx);

      return {
        peerId: peer.id,
        revokedAt: revokedAt.toISOString(),
        revokedSessionIds: revokedSessions.map((session) => session.id),
      };
    });
  }

  async getOverview() {
    const now = new Date();
    const [
      sourceRows,
      targetRows,
      activePeerRows,
      activeSessionRows,
      controlStateRows,
    ] = await Promise.all([
      this.db
        .select({
          id: maintenancePeers.id,
          role: maintenancePeers.role,
          publicKey: maintenancePeers.publicKey,
          tunnelAddress: maintenancePeers.tunnelAddress,
        })
        .from(maintenancePeers)
        .where(
          and(
            eq(maintenancePeers.role, "runner"),
            eq(maintenancePeers.status, "active"),
            isNull(maintenancePeers.revokedAt),
          ),
        )
        .orderBy(asc(maintenancePeers.tunnelAddress)),
      this.listTargetMachines(),
      this.db
        .select({
          id: maintenancePeers.id,
          role: maintenancePeers.role,
          publicKey: maintenancePeers.publicKey,
          tunnelAddress: maintenancePeers.tunnelAddress,
        })
        .from(maintenancePeers)
        .where(
          and(
            eq(maintenancePeers.status, "active"),
            isNull(maintenancePeers.revokedAt),
          ),
        )
        .orderBy(asc(maintenancePeers.tunnelAddress)),
      this.db
        .select()
        .from(maintenanceSessions)
        .where(
          and(
            isNull(maintenanceSessions.revokedAt),
            gt(maintenanceSessions.expiresAt, now),
          ),
        )
        .orderBy(desc(maintenanceSessions.issuedAt)),
      this.db
        .select({
          desiredStateVersion: maintenanceRelayControlState.desiredStateVersion,
        })
        .from(maintenanceRelayControlState)
        .where(eq(maintenanceRelayControlState.singletonKey, "default")),
    ]);

    const controlState = controlStateRows[0];
    if (!controlState) {
      throw new Error("Maintenance relay control state is not initialized");
    }

    const sourcePeers = sourceRows.map(toPublicPeer);
    const allPeers = activePeerRows.map(toPublicPeer);
    const targets = targetRows.map(toTargetMachine);
    const sourcePeerById = new Map(sourcePeers.map((peer) => [peer.id, peer]));
    const targetById = new Map(targets.map((target) => [target.id, target]));
    const sessions = activeSessionRows.flatMap((session) => {
      const sourcePeer = sourcePeerById.get(session.sourcePeerId);
      const targetMachine = targetById.get(session.targetMachineId);
      if (!sourcePeer || !targetMachine) {
        return [];
      }
      return [this.toSessionResponse(session, sourcePeer, targetMachine, now)];
    });
    const generatedAt = now.toISOString();
    const desiredState = maintenanceRelayDesiredStateSchema.parse({
      schemaVersion: "maintenance-relay-desired-state/v1",
      desiredStateVersion: controlState.desiredStateVersion,
      generatedAt,
      peers: allPeers,
      authorizations: sessions.map((session) => ({
        sessionId: session.id,
        sourcePeerId: session.sourcePeer.id,
        sourceTunnelAddress: session.sourcePeer.tunnelAddress,
        targetMachineId: session.targetMachine.id,
        targetTunnelAddress: session.targetMachine.tunnelAddress,
        protocol: session.protocol,
        port: session.port,
        expiresAt: session.expiresAt,
      })),
    });

    return maintenanceAccessOverviewResponseSchema.parse({
      schemaVersion: "maintenance-access-overview/v1",
      sourcePeers,
      targetMachines: targets,
      sessions,
      desiredState,
      observedState: observeMaintenanceRelayDesiredState(desiredState),
    });
  }

  async createSession(
    actorAdminUserId: string,
    input: CreateMaintenanceSessionRequest,
  ): Promise<MaintenanceSessionResponse> {
    if (input.protocol !== "tcp" || input.port !== 22) {
      throw new BadRequestException("Only runner-to-machine TCP 22 is allowed");
    }
    if (![30, 60, 120, 180].includes(input.ttlMinutes)) {
      throw new BadRequestException("Maintenance session TTL is not allowed");
    }
    const reason = input.reason.trim();
    if (reason.length < 3) {
      throw new BadRequestException("Maintenance session reason is required");
    }

    const issuedAt = new Date();
    const expiresAt = new Date(
      issuedAt.getTime() + input.ttlMinutes * 60 * 1000,
    );
    return await this.db.transaction(async (tx) => {
      const [source] = await tx
        .select({
          id: maintenancePeers.id,
          role: maintenancePeers.role,
          publicKey: maintenancePeers.publicKey,
          tunnelAddress: maintenancePeers.tunnelAddress,
        })
        .from(maintenancePeers)
        .where(
          and(
            eq(maintenancePeers.id, input.sourcePeerId),
            eq(maintenancePeers.role, "runner"),
            eq(maintenancePeers.status, "active"),
            isNull(maintenancePeers.revokedAt),
          ),
        )
        .for("update");
      if (!source) {
        throw new NotFoundException("Active runner maintenance peer not found");
      }

      const [target] = await this.getTargetMachine(tx, input.targetMachineId);
      if (!target) {
        throw new NotFoundException(
          "Platform Machine with active maintenance peer not found",
        );
      }
      const [lockedTargetPeer] = await tx
        .select({ id: maintenancePeers.id })
        .from(maintenancePeers)
        .where(
          and(
            eq(maintenancePeers.id, target.maintenancePeerId),
            eq(maintenancePeers.status, "active"),
            isNull(maintenancePeers.revokedAt),
          ),
        )
        .for("update");
      if (!lockedTargetPeer) {
        throw new NotFoundException(
          "Platform Machine with active maintenance peer not found",
        );
      }

      const [session] = await tx
        .insert(maintenanceSessions)
        .values({
          sourcePeerId: source.id,
          targetMachineId: target.id,
          issuedByAdminUserId: actorAdminUserId,
          protocol: input.protocol,
          port: input.port,
          reason,
          issuedAt,
          expiresAt,
        })
        .returning();
      await tx.insert(auditLogs).values({
        adminUserId: actorAdminUserId,
        action: "maintenanceAccess.session.create",
        resourceType: "maintenance_session",
        resourceId: session.id,
        afterJson: {
          sourcePeerId: source.id,
          targetMachineId: target.id,
          protocol: session.protocol,
          port: session.port,
          reason,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
      });
      await this.bumpDesiredStateVersion(tx);

      return this.toSessionResponse(
        session,
        toPublicPeer(source),
        toTargetMachine(target),
        issuedAt,
      );
    });
  }

  private async listTargetMachines(): Promise<TargetMachineRow[]> {
    return await this.getTargetMachine(this.db);
  }

  private async bumpDesiredStateVersion(
    executor: Pick<DrizzleClient, "update">,
  ): Promise<number> {
    const [state] = await executor
      .update(maintenanceRelayControlState)
      .set({
        desiredStateVersion: sql`${maintenanceRelayControlState.desiredStateVersion} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(maintenanceRelayControlState.singletonKey, "default"))
      .returning({
        desiredStateVersion: maintenanceRelayControlState.desiredStateVersion,
      });
    if (!state) {
      throw new Error("Maintenance relay control state is not initialized");
    }
    return state.desiredStateVersion;
  }

  private async getTargetMachine(
    executor: Pick<DrizzleClient, "select">,
    machineId?: string,
  ): Promise<TargetMachineRow[]> {
    return await executor
      .select({
        id: machines.id,
        code: machines.code,
        name: machines.name,
        maintenancePeerId: maintenancePeers.id,
        tunnelAddress: maintenancePeers.tunnelAddress,
      })
      .from(machines)
      .innerJoin(
        maintenancePeers,
        and(
          eq(maintenancePeers.machineId, machines.id),
          eq(maintenancePeers.role, "machine"),
          eq(maintenancePeers.status, "active"),
          isNull(maintenancePeers.revokedAt),
        ),
      )
      .where(
        and(
          isNull(machines.deletedAt),
          machineId ? eq(machines.id, machineId) : undefined,
        ),
      )
      .orderBy(asc(machines.code));
  }

  private toSessionResponse(
    session: typeof maintenanceSessions.$inferSelect,
    sourcePeer: MaintenancePublicPeer,
    targetMachine: MaintenanceTargetMachine,
    now: Date,
  ): MaintenanceSessionResponse {
    return maintenanceSessionResponseSchema.parse({
      id: session.id,
      sourcePeer,
      targetMachine,
      protocol: session.protocol,
      port: session.port,
      actorAdminUserId: session.issuedByAdminUserId,
      reason: session.reason,
      issuedAt: toIso(session.issuedAt),
      expiresAt: toIso(session.expiresAt),
      revokedAt: session.revokedAt ? toIso(session.revokedAt) : null,
      status: sessionStatus(session, now),
    });
  }
}
