import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  aliasedTable,
  and,
  asc,
  auditLogs,
  desc,
  eq,
  getColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  machines,
  maintenanceAutomationExchanges,
  maintenancePeers,
  maintenanceRelayControlState,
  maintenanceRelayDesiredStateRevisions,
  maintenanceSessions,
  or,
  sql,
  type DrizzleClient,
  type DrizzleTransaction,
  type SQL,
} from "@vem/db";
import {
  CI_MAINTENANCE_SESSION_TTL_MINUTES,
  auditLogResponseSchema,
  createCiMaintenanceSessionCommandSchema,
  maintenanceAccessOverviewResponseSchema,
  maintenancePublicPeerSchema,
  maintenanceRelayDesiredStateSchema,
  maintenanceRelayFailureReasonCodeSchema,
  maintenanceRelayObservedStateSchema,
  maintenanceSessionResponseSchema,
  registerMaintenancePeerRequestSchema,
  type CreateCiMaintenanceSessionCommand,
  type CreateHumanMaintenanceSessionRequest,
  type MaintenanceAccessAuditListQuery,
  type MaintenanceFailureProjection,
  type MaintenancePeerRole,
  type MaintenancePublicPeer,
  type MaintenanceRelayDesiredState,
  type MaintenanceRelayFailureReasonCode,
  type MaintenanceRelayObservedState,
  type MaintenanceSessionAuthorization,
  type RegisterMaintenancePeerRequest,
  type MaintenanceSessionResponse,
  type MaintenanceSessionListQuery,
  type MaintenanceTargetMachine,
} from "@vem/shared";

import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { allocateTunnelAddress } from "./maintenance-address-pools";
import {
  projectMaintenancePeerHealth,
  projectMaintenanceRelayHealth,
} from "./maintenance-relay-health";

type TargetMachineRow = {
  id: string;
  code: string;
  name: string;
  maintenancePeerId: string;
  tunnelAddress: string;
};

const targetSessionPeers = aliasedTable(
  maintenancePeers,
  "maintenance_session_target_peer",
);

const FAILURE_SUMMARIES: Record<MaintenanceRelayFailureReasonCode, string> = {
  desired_state_rejected: "Relay rejected the desired maintenance state.",
  wireguard_apply_failed: "Relay could not apply WireGuard peer state.",
  firewall_apply_failed:
    "Relay could not apply the maintenance firewall policy.",
  journal_persist_failed: "Relay could not persist its applied-state journal.",
  peer_observation_failed: "Relay could not read current peer observations.",
  relay_internal_error: "Relay encountered an internal reconciliation error.",
};

function projectFailure(
  reasonCode: MaintenanceRelayFailureReasonCode | null,
): MaintenanceFailureProjection | null {
  return reasonCode
    ? { reasonCode, summary: FAILURE_SUMMARIES[reasonCode] }
    : null;
}

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
    expiredAt: Date | string | null;
    failedAt: Date | string | null;
    revokedAt: Date | string | null;
  },
  now: Date,
): "active" | "expired" | "failed" | "revoked" {
  if (session.revokedAt) return "revoked";
  if (session.failedAt) return "failed";
  if (session.expiredAt) return "expired";
  return new Date(session.expiresAt).getTime() > now.getTime()
    ? "active"
    : "expired";
}

function sessionStatusFilter(
  status: MaintenanceSessionListQuery["status"],
  now: Date,
): SQL | undefined {
  if (status === "active") {
    return and(
      isNull(maintenanceSessions.revokedAt),
      isNull(maintenanceSessions.failedAt),
      isNull(maintenanceSessions.expiredAt),
      gt(maintenanceSessions.expiresAt, now),
    );
  }
  if (status === "expired") {
    return and(
      isNull(maintenanceSessions.revokedAt),
      isNull(maintenanceSessions.failedAt),
      or(
        isNotNull(maintenanceSessions.expiredAt),
        lte(maintenanceSessions.expiresAt, now),
      ),
    );
  }
  if (status === "failed") return isNotNull(maintenanceSessions.failedAt);
  if (status === "revoked") return isNotNull(maintenanceSessions.revokedAt);
  return undefined;
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

function sameUniqueIds(actual: string[], expected: string[]): boolean {
  const actualIds = new Set(actual);
  const expectedIds = new Set(expected);
  return (
    actualIds.size === actual.length &&
    expectedIds.size === expected.length &&
    actualIds.size === expectedIds.size &&
    [...actualIds].every((id) => expectedIds.has(id))
  );
}

function sameAuthorization(
  left: MaintenanceSessionAuthorization,
  right: MaintenanceSessionAuthorization,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.sourcePeerId === right.sourcePeerId &&
    left.sourceTunnelAddress === right.sourceTunnelAddress &&
    left.targetMachineId === right.targetMachineId &&
    left.targetTunnelAddress === right.targetTunnelAddress &&
    left.protocol === right.protocol &&
    left.port === right.port &&
    left.expiresAt === right.expiresAt
  );
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
    return await this.db.transaction(
      async (tx) => {
        return await this.getOverviewSnapshot(tx, now);
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async getRelayDesiredState(): Promise<MaintenanceRelayDesiredState> {
    return await this.db.transaction(
      async (tx) => {
        return await this.getCurrentDesiredState(tx);
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async sweepExpiredSessions(now = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      await this.expireSessions(tx, now);
    });
  }

  async listSessions(query: MaintenanceSessionListQuery) {
    const now = new Date();
    return await this.db.transaction(
      async (tx) => {
        const controlState = await this.getRelayProjectionRow(tx);
        const observedState = this.parseReportedObservedState(
          controlState.observedState,
        );
        const rows = await this.getHistoricalSessionRows(tx, query, now);
        return rows.map((row) =>
          this.toSessionResponse(
            row.session,
            toPublicPeer(row.sourcePeer),
            toTargetMachine(row.targetMachine),
            now,
            controlState.desiredStateVersion,
            observedState,
          ),
        );
      },
      { isolationLevel: "repeatable read" },
    );
  }

  async listAudit(query: MaintenanceAccessAuditListQuery) {
    const filters: SQL[] = [
      sql`${auditLogs.action} LIKE 'maintenanceAccess.%'`,
      inArray(auditLogs.resourceType, [
        "maintenance_session",
        "maintenance_peer",
      ]),
    ];
    if (query.sessionId) {
      filters.push(eq(auditLogs.resourceType, "maintenance_session"));
      filters.push(eq(auditLogs.resourceId, query.sessionId));
    }
    const rows = await this.db
      .select({
        id: auditLogs.id,
        adminUserId: auditLogs.adminUserId,
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        beforeJson: auditLogs.beforeJson,
        afterJson: auditLogs.afterJson,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(and(...filters))
      .orderBy(desc(auditLogs.createdAt))
      .limit(query.limit);
    return auditLogResponseSchema.array().parse(
      rows.map((row) => ({
        ...row,
        resourceId: row.resourceId ?? null,
        beforeJson: row.beforeJson ?? null,
        afterJson: row.afterJson ?? null,
        createdAt: toIso(row.createdAt),
      })),
    );
  }

  private async getOverviewSnapshot(executor: DrizzleTransaction, now: Date) {
    const sourceRows = await executor
      .select({
        id: maintenancePeers.id,
        role: maintenancePeers.role,
        publicKey: maintenancePeers.publicKey,
        tunnelAddress: maintenancePeers.tunnelAddress,
      })
      .from(maintenancePeers)
      .where(
        and(
          eq(maintenancePeers.role, "maintainer"),
          eq(maintenancePeers.status, "active"),
          isNull(maintenancePeers.revokedAt),
        ),
      )
      .orderBy(asc(maintenancePeers.tunnelAddress));
    const targetRows = await this.getTargetMachine(executor);
    const sessionRows = await this.getHistoricalSessionRows(executor, {}, now);
    const controlState = await this.getRelayProjectionRow(executor);

    const sourcePeers = sourceRows.map(toPublicPeer);
    const targets = targetRows.map(toTargetMachine);
    const reportedObservedState = this.parseReportedObservedState(
      controlState.observedState,
    );
    const sessions = sessionRows.map((row) =>
      this.toSessionResponse(
        row.session,
        toPublicPeer(row.sourcePeer),
        toTargetMachine(row.targetMachine),
        now,
        controlState.desiredStateVersion,
        reportedObservedState,
      ),
    );
    const desiredState = maintenanceRelayDesiredStateSchema.parse(
      controlState.desiredState,
    );
    if (desiredState.desiredStateVersion !== controlState.desiredStateVersion) {
      throw new Error(
        "Maintenance relay desired-state revision is inconsistent",
      );
    }

    return maintenanceAccessOverviewResponseSchema.parse({
      schemaVersion: "maintenance-access-overview/v1",
      sourcePeers,
      targetMachines: targets,
      peerHealth: projectMaintenancePeerHealth(
        desiredState,
        reportedObservedState,
        now,
      ),
      sessions,
      desiredState,
      observedState:
        reportedObservedState ?? this.unreportedObservedState(desiredState),
      relayFailure: projectFailure(
        reportedObservedState?.failure?.reasonCode ?? null,
      ),
      relayHealth: projectMaintenanceRelayHealth(
        reportedObservedState,
        desiredState.desiredStateVersion,
        now,
      ),
    });
  }

  private async getRelayProjectionRow(executor: Pick<DrizzleClient, "select">) {
    const [controlState] = await executor
      .select({
        desiredStateVersion: maintenanceRelayControlState.desiredStateVersion,
        observedState: maintenanceRelayControlState.observedState,
        desiredState: maintenanceRelayDesiredStateRevisions.desiredState,
      })
      .from(maintenanceRelayControlState)
      .innerJoin(
        maintenanceRelayDesiredStateRevisions,
        eq(
          maintenanceRelayDesiredStateRevisions.revision,
          maintenanceRelayControlState.desiredStateVersion,
        ),
      )
      .where(eq(maintenanceRelayControlState.singletonKey, "default"));
    if (!controlState) {
      throw new Error("Maintenance relay control state is not initialized");
    }
    return controlState;
  }

  private async getHistoricalSessionRows(
    executor: Pick<DrizzleClient, "select">,
    query: MaintenanceSessionListQuery,
    now: Date,
  ) {
    return await executor
      .select({
        session: getColumns(maintenanceSessions),
        sourcePeer: {
          id: maintenancePeers.id,
          role: maintenancePeers.role,
          publicKey: maintenancePeers.publicKey,
          tunnelAddress: maintenancePeers.tunnelAddress,
        },
        targetMachine: {
          id: machines.id,
          code: machines.code,
          name: machines.name,
          maintenancePeerId: targetSessionPeers.id,
          tunnelAddress: targetSessionPeers.tunnelAddress,
        },
      })
      .from(maintenanceSessions)
      .innerJoin(
        maintenancePeers,
        eq(maintenancePeers.id, maintenanceSessions.sourcePeerId),
      )
      .innerJoin(
        targetSessionPeers,
        eq(targetSessionPeers.id, maintenanceSessions.targetPeerId),
      )
      .innerJoin(machines, eq(machines.id, maintenanceSessions.targetMachineId))
      .where(
        and(
          query.kind ? eq(maintenanceSessions.kind, query.kind) : undefined,
          sessionStatusFilter(query.status, now),
        ),
      )
      .orderBy(desc(maintenanceSessions.issuedAt));
  }

  async reportRelayObservedState(
    input: unknown,
  ): Promise<MaintenanceRelayObservedState> {
    const observed = maintenanceRelayObservedStateSchema.safeParse(input);
    if (!observed.success) {
      throw new BadRequestException("Invalid maintenance relay observed state");
    }
    return await this.db.transaction(
      async (tx) => {
        const [controlState] = await tx
          .select({
            desiredStateVersion:
              maintenanceRelayControlState.desiredStateVersion,
            observedState: maintenanceRelayControlState.observedState,
          })
          .from(maintenanceRelayControlState)
          .where(eq(maintenanceRelayControlState.singletonKey, "default"))
          .for("update");
        if (!controlState) {
          throw new Error("Maintenance relay control state is not initialized");
        }
        if (
          observed.data.appliedDesiredStateVersion >
            controlState.desiredStateVersion ||
          (observed.data.attemptedDesiredStateVersion !== null &&
            observed.data.attemptedDesiredStateVersion >
              controlState.desiredStateVersion)
        ) {
          throw new BadRequestException(
            "Observed state cannot be ahead of desired state",
          );
        }
        const previous = maintenanceRelayObservedStateSchema.safeParse(
          controlState.observedState,
        );
        if (
          previous.success &&
          (observed.data.appliedDesiredStateVersion <
            previous.data.appliedDesiredStateVersion ||
            Date.parse(observed.data.observedAt) <
              Date.parse(previous.data.observedAt))
        ) {
          throw new BadRequestException(
            "Observed state revision and observedAt must not move backwards",
          );
        }

        const [revision] = await tx
          .select({
            desiredState: maintenanceRelayDesiredStateRevisions.desiredState,
          })
          .from(maintenanceRelayDesiredStateRevisions)
          .where(
            eq(
              maintenanceRelayDesiredStateRevisions.revision,
              observed.data.appliedDesiredStateVersion,
            ),
          );
        if (!revision) {
          throw new BadRequestException(
            "Observed state references an unknown desired revision",
          );
        }
        const desiredState = maintenanceRelayDesiredStateSchema.parse(
          revision.desiredState,
        );
        this.validateObservedIds(observed.data, desiredState);

        const lifecycleChanged = await this.recordRelaySessionLifecycle(
          tx,
          observed.data,
          desiredState,
        );

        await tx
          .update(maintenanceRelayControlState)
          .set({ observedState: observed.data, updatedAt: new Date() })
          .where(eq(maintenanceRelayControlState.singletonKey, "default"));
        if (lifecycleChanged.length > 0) {
          const desiredStateVersion = await this.bumpDesiredStateVersion(tx);
          await tx
            .update(maintenanceSessions)
            .set({ desiredStateVersion })
            .where(inArray(maintenanceSessions.id, lifecycleChanged));
        }
        return observed.data;
      },
      { isolationLevel: "read committed" },
    );
  }

  async createHumanSession(
    actorAdminUserId: string,
    input: CreateHumanMaintenanceSessionRequest,
  ): Promise<MaintenanceSessionResponse> {
    return await this.createSessionForRole(input, {
      kind: "human",
      sourceRole: "maintainer",
      actorAdminUserId,
      automationActorId: null,
      ttlMinutes: input.ttlMinutes,
    });
  }

  async createCiSession(
    input: CreateCiMaintenanceSessionCommand,
  ): Promise<MaintenanceSessionResponse> {
    const parsed = createCiMaintenanceSessionCommandSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException("Invalid CI maintenance session command");
    }
    return await this.createSessionForRole(parsed.data, {
      kind: "ci",
      sourceRole: "runner",
      actorAdminUserId: null,
      automationActorId: parsed.data.automationActorId,
      ttlMinutes: CI_MAINTENANCE_SESSION_TTL_MINUTES,
    });
  }

  async createCiSessionFromAutomationExchange(
    input: CreateCiMaintenanceSessionCommand,
    automationExchangeId: string,
  ): Promise<MaintenanceSessionResponse> {
    const parsed = createCiMaintenanceSessionCommandSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException("Invalid CI maintenance session command");
    }
    return await this.createSessionForRole(parsed.data, {
      kind: "ci",
      sourceRole: "runner",
      actorAdminUserId: null,
      automationActorId: parsed.data.automationActorId,
      automationExchangeId,
      ttlMinutes: CI_MAINTENANCE_SESSION_TTL_MINUTES,
    });
  }

  private async createSessionForRole(
    input: Pick<
      CreateHumanMaintenanceSessionRequest,
      "sourcePeerId" | "targetMachineId" | "reason" | "protocol" | "port"
    >,
    actor: {
      kind: "human" | "ci";
      sourceRole: "maintainer" | "runner";
      actorAdminUserId: string | null;
      automationActorId: string | null;
      automationExchangeId?: string;
      ttlMinutes: number;
    },
  ): Promise<MaintenanceSessionResponse> {
    if (input.protocol !== "tcp" || input.port !== 22) {
      throw new BadRequestException("Only source-to-machine TCP 22 is allowed");
    }
    const reason = input.reason.trim();
    if (reason.length < 3) {
      throw new BadRequestException("Maintenance session reason is required");
    }

    const issuedAt = new Date();
    const expiresAt = new Date(
      issuedAt.getTime() + actor.ttlMinutes * 60 * 1000,
    );
    return await this.db.transaction(async (tx) => {
      let automationAttribution:
        | { exchangeId: string; runId: string; runAttempt: string }
        | undefined;
      if (actor.automationExchangeId) {
        const [exchange] = await tx
          .select({
            githubRunId: maintenanceAutomationExchanges.githubRunId,
            githubRunAttempt: maintenanceAutomationExchanges.githubRunAttempt,
            sourcePeerId: maintenanceAutomationExchanges.sourcePeerId,
            targetMachineId: maintenanceAutomationExchanges.targetMachineId,
            sessionId: maintenanceAutomationExchanges.sessionId,
            expiresAt: maintenanceAutomationExchanges.expiresAt,
            revokedAt: maintenanceAutomationExchanges.revokedAt,
          })
          .from(maintenanceAutomationExchanges)
          .where(
            eq(maintenanceAutomationExchanges.id, actor.automationExchangeId),
          )
          .for("update");
        if (
          !exchange ||
          exchange.sessionId ||
          exchange.revokedAt ||
          exchange.expiresAt <= issuedAt ||
          exchange.sourcePeerId !== input.sourcePeerId ||
          exchange.targetMachineId !== input.targetMachineId
        ) {
          throw new ConflictException(
            "Automation exchange cannot create a session",
          );
        }
        automationAttribution = {
          exchangeId: actor.automationExchangeId,
          runId: exchange.githubRunId,
          runAttempt: exchange.githubRunAttempt,
        };
      }
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
            eq(maintenancePeers.role, actor.sourceRole),
            eq(maintenancePeers.status, "active"),
            isNull(maintenancePeers.revokedAt),
          ),
        )
        .for("update");
      if (!source) {
        throw new NotFoundException(
          `Active ${actor.sourceRole} maintenance peer not found`,
        );
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

      let session!: typeof maintenanceSessions.$inferSelect;
      const desiredStateVersion = await this.bumpDesiredStateVersion(
        tx,
        async (revision) => {
          [session] = await tx
            .insert(maintenanceSessions)
            .values({
              kind: actor.kind,
              sourcePeerId: source.id,
              targetPeerId: target.maintenancePeerId,
              targetMachineId: target.id,
              issuedByAdminUserId: actor.actorAdminUserId,
              automationActorId: actor.automationActorId,
              protocol: input.protocol,
              port: input.port,
              reason,
              issuedAt,
              expiresAt,
              desiredStateVersion: revision,
            })
            .returning();
        },
        issuedAt,
      );
      if (actor.automationExchangeId) {
        await tx
          .update(maintenanceAutomationExchanges)
          .set({ sessionId: session.id })
          .where(
            eq(maintenanceAutomationExchanges.id, actor.automationExchangeId),
          );
      }
      await tx.insert(auditLogs).values({
        adminUserId: actor.actorAdminUserId,
        action: "maintenanceAccess.session.create",
        resourceType: "maintenance_session",
        resourceId: session.id,
        afterJson: {
          sourcePeerId: source.id,
          kind: actor.kind,
          actor:
            actor.kind === "human"
              ? { type: "admin", adminUserId: actor.actorAdminUserId }
              : automationAttribution
                ? {
                    type: "github_actions_automation",
                    exchangeId: automationAttribution.exchangeId,
                    runId: automationAttribution.runId,
                    runAttempt: automationAttribution.runAttempt,
                  }
                : {
                    type: "automation",
                    automationActorId: actor.automationActorId,
                  },
          sourceRole: actor.sourceRole,
          targetMachineId: target.id,
          protocol: session.protocol,
          port: session.port,
          reason,
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
        },
      });

      return this.toSessionResponse(
        session,
        toPublicPeer(source),
        toTargetMachine(target),
        issuedAt,
        desiredStateVersion,
        null,
      );
    });
  }

  async revokeSession(
    actorAdminUserId: string,
    sessionId: string,
  ): Promise<MaintenanceSessionResponse> {
    return await this.revokeSessionForActor(
      { type: "admin", adminUserId: actorAdminUserId },
      sessionId,
    );
  }

  async revokeSessionFromAutomationExchange(
    automationExchangeId: string,
    sessionId: string,
  ): Promise<MaintenanceSessionResponse> {
    return await this.revokeSessionForActor(
      { type: "github_actions_automation", exchangeId: automationExchangeId },
      sessionId,
    );
  }

  private async revokeSessionForActor(
    actor:
      | { type: "admin"; adminUserId: string }
      | { type: "github_actions_automation"; exchangeId: string },
    sessionId: string,
  ): Promise<MaintenanceSessionResponse> {
    const revokedAt = new Date();
    return await this.db.transaction(async (tx) => {
      let automationAttribution:
        | { exchangeId: string; runId: string; runAttempt: string }
        | undefined;
      if (actor.type === "github_actions_automation") {
        const [exchange] = await tx
          .select({
            sessionId: maintenanceAutomationExchanges.sessionId,
            githubRunId: maintenanceAutomationExchanges.githubRunId,
            githubRunAttempt: maintenanceAutomationExchanges.githubRunAttempt,
            revokedAt: maintenanceAutomationExchanges.revokedAt,
          })
          .from(maintenanceAutomationExchanges)
          .where(eq(maintenanceAutomationExchanges.id, actor.exchangeId))
          .for("update");
        if (
          !exchange ||
          exchange.sessionId !== sessionId ||
          exchange.revokedAt
        ) {
          throw new ConflictException(
            "Automation exchange cannot revoke this session",
          );
        }
        automationAttribution = {
          exchangeId: actor.exchangeId,
          runId: exchange.githubRunId,
          runAttempt: exchange.githubRunAttempt,
        };
      }
      const [session] = await tx
        .select()
        .from(maintenanceSessions)
        .where(eq(maintenanceSessions.id, sessionId))
        .for("update");
      if (!session)
        throw new NotFoundException("Maintenance session not found");
      if (sessionStatus(session, revokedAt) !== "active") {
        throw new ConflictException("Maintenance session is not active");
      }

      await tx
        .update(maintenanceSessions)
        .set({ revokedAt })
        .where(eq(maintenanceSessions.id, session.id));
      if (actor.type === "github_actions_automation") {
        await tx
          .update(maintenanceAutomationExchanges)
          .set({ revokedAt })
          .where(eq(maintenanceAutomationExchanges.id, actor.exchangeId));
      }
      await tx.insert(auditLogs).values({
        adminUserId: actor.type === "admin" ? actor.adminUserId : null,
        action: "maintenanceAccess.session.revoke",
        resourceType: "maintenance_session",
        resourceId: session.id,
        afterJson: {
          actor:
            actor.type === "admin"
              ? { type: "admin", adminUserId: actor.adminUserId }
              : {
                  type: "github_actions_automation",
                  exchangeId: automationAttribution?.exchangeId,
                  runId: automationAttribution?.runId,
                  runAttempt: automationAttribution?.runAttempt,
                },
          revokedAt: revokedAt.toISOString(),
        },
      });
      const desiredStateVersion = await this.bumpDesiredStateVersion(tx);
      await tx
        .update(maintenanceSessions)
        .set({ desiredStateVersion })
        .where(eq(maintenanceSessions.id, session.id));

      const [source] = await tx
        .select({
          id: maintenancePeers.id,
          role: maintenancePeers.role,
          publicKey: maintenancePeers.publicKey,
          tunnelAddress: maintenancePeers.tunnelAddress,
        })
        .from(maintenancePeers)
        .where(eq(maintenancePeers.id, session.sourcePeerId));
      const [target] = await this.getTargetMachine(tx, session.targetMachineId);
      if (!source || !target) {
        throw new Error(
          "Maintenance session references unavailable peer state",
        );
      }
      return this.toSessionResponse(
        { ...session, revokedAt, desiredStateVersion },
        toPublicPeer(source),
        toTargetMachine(target),
        revokedAt,
        desiredStateVersion,
        null,
      );
    });
  }

  private async bumpDesiredStateVersion(
    executor: DrizzleTransaction,
    beforeSnapshot?: (desiredStateVersion: number) => Promise<void>,
    updatedAt = new Date(),
  ): Promise<number> {
    const [state] = await executor
      .update(maintenanceRelayControlState)
      .set({
        desiredStateVersion: sql`${maintenanceRelayControlState.desiredStateVersion} + 1`,
        updatedAt,
      })
      .where(eq(maintenanceRelayControlState.singletonKey, "default"))
      .returning({
        desiredStateVersion: maintenanceRelayControlState.desiredStateVersion,
      });
    if (!state) {
      throw new Error("Maintenance relay control state is not initialized");
    }
    await beforeSnapshot?.(state.desiredStateVersion);
    const desiredState = await this.buildRelayDesiredState(
      executor,
      state.desiredStateVersion,
      updatedAt,
    );
    await executor.insert(maintenanceRelayDesiredStateRevisions).values({
      revision: state.desiredStateVersion,
      desiredState,
      createdAt: updatedAt,
    });
    return state.desiredStateVersion;
  }

  private async getCurrentDesiredState(
    executor: Pick<DrizzleClient, "select">,
  ): Promise<MaintenanceRelayDesiredState> {
    const [row] = await executor
      .select({
        desiredStateVersion: maintenanceRelayControlState.desiredStateVersion,
        desiredState: maintenanceRelayDesiredStateRevisions.desiredState,
      })
      .from(maintenanceRelayControlState)
      .innerJoin(
        maintenanceRelayDesiredStateRevisions,
        eq(
          maintenanceRelayDesiredStateRevisions.revision,
          maintenanceRelayControlState.desiredStateVersion,
        ),
      )
      .where(eq(maintenanceRelayControlState.singletonKey, "default"));
    if (!row) {
      throw new Error("Maintenance relay desired state is not initialized");
    }
    const desiredState = maintenanceRelayDesiredStateSchema.parse(
      row.desiredState,
    );
    if (desiredState.desiredStateVersion !== row.desiredStateVersion) {
      throw new Error(
        "Maintenance relay desired-state revision is inconsistent",
      );
    }
    return desiredState;
  }

  private async expireSessions(
    executor: DrizzleTransaction,
    now: Date,
  ): Promise<void> {
    const expired = await executor
      .update(maintenanceSessions)
      .set({ expiredAt: sql`${maintenanceSessions.expiresAt}` })
      .where(
        and(
          isNull(maintenanceSessions.revokedAt),
          isNull(maintenanceSessions.failedAt),
          isNull(maintenanceSessions.expiredAt),
          lte(maintenanceSessions.expiresAt, now),
        ),
      )
      .returning({
        id: maintenanceSessions.id,
        expiresAt: maintenanceSessions.expiresAt,
      });
    if (expired.length === 0) return;

    await executor.insert(auditLogs).values(
      expired.map((session) => ({
        adminUserId: null,
        action: "maintenanceAccess.session.expire",
        resourceType: "maintenance_session",
        resourceId: session.id,
        afterJson: {
          expiredAt: toIso(session.expiresAt),
          expiresAt: toIso(session.expiresAt),
        },
      })),
    );
    const desiredStateVersion = await this.bumpDesiredStateVersion(executor);
    await executor
      .update(maintenanceSessions)
      .set({ desiredStateVersion })
      .where(
        inArray(
          maintenanceSessions.id,
          expired.map((session) => session.id),
        ),
      );
  }

  private async recordRelaySessionLifecycle(
    executor: DrizzleTransaction,
    observed: MaintenanceRelayObservedState,
    appliedState: MaintenanceRelayDesiredState,
  ): Promise<string[]> {
    const observedAt = new Date(observed.observedAt);
    const changedIds: string[] = [];
    if (observed.appliedAuthorizationIds.length > 0) {
      const activated = await executor
        .update(maintenanceSessions)
        .set({ activatedAt: observedAt })
        .where(
          and(
            inArray(maintenanceSessions.id, observed.appliedAuthorizationIds),
            isNull(maintenanceSessions.activatedAt),
            isNull(maintenanceSessions.revokedAt),
            isNull(maintenanceSessions.failedAt),
            isNull(maintenanceSessions.expiredAt),
            gt(maintenanceSessions.expiresAt, observedAt),
          ),
        )
        .returning({ id: maintenanceSessions.id });
      if (activated.length > 0) {
        await executor.insert(auditLogs).values(
          activated.map((session) => ({
            adminUserId: null,
            action: "maintenanceAccess.session.activate",
            resourceType: "maintenance_session",
            resourceId: session.id,
            afterJson: {
              activatedAt: observed.observedAt,
              appliedDesiredStateVersion: observed.appliedDesiredStateVersion,
            },
          })),
        );
      }
    }

    if (
      observed.failure !== null &&
      observed.attemptedDesiredStateVersion !== null
    ) {
      const failure = observed.failure;
      const [attemptedRevision] = await executor
        .select({
          desiredState: maintenanceRelayDesiredStateRevisions.desiredState,
        })
        .from(maintenanceRelayDesiredStateRevisions)
        .where(
          eq(
            maintenanceRelayDesiredStateRevisions.revision,
            observed.attemptedDesiredStateVersion,
          ),
        );
      const attemptedState = attemptedRevision
        ? maintenanceRelayDesiredStateSchema.parse(
            attemptedRevision.desiredState,
          )
        : null;
      const appliedAuthorizationBySessionId = new Map(
        appliedState.authorizations.map((authorization) => [
          authorization.sessionId,
          authorization,
        ]),
      );
      const affectedSessionIds =
        attemptedState?.authorizations.flatMap((authorization) => {
          const applied = appliedAuthorizationBySessionId.get(
            authorization.sessionId,
          );
          return applied && sameAuthorization(applied, authorization)
            ? []
            : [authorization.sessionId];
        }) ?? [];
      if (affectedSessionIds.length > 0) {
        const failed = await executor
          .update(maintenanceSessions)
          .set({
            failedAt: observedAt,
            failureReasonCode: failure.reasonCode,
          })
          .where(
            and(
              inArray(maintenanceSessions.id, affectedSessionIds),
              isNull(maintenanceSessions.revokedAt),
              isNull(maintenanceSessions.failedAt),
              isNull(maintenanceSessions.expiredAt),
              gt(maintenanceSessions.expiresAt, observedAt),
            ),
          )
          .returning({ id: maintenanceSessions.id });
        if (failed.length > 0) {
          changedIds.push(...failed.map((session) => session.id));
          await executor.insert(auditLogs).values(
            failed.map((session) => ({
              adminUserId: null,
              action: "maintenanceAccess.session.fail",
              resourceType: "maintenance_session",
              resourceId: session.id,
              afterJson: {
                failedAt: observed.observedAt,
                attemptedDesiredStateVersion:
                  observed.attemptedDesiredStateVersion,
                reasonCode: failure.reasonCode,
                summary: FAILURE_SUMMARIES[failure.reasonCode],
              },
            })),
          );
        }
      }
    }
    return [...new Set(changedIds)];
  }

  private async buildRelayDesiredState(
    executor: DrizzleTransaction,
    desiredStateVersion: number,
    generatedAt: Date,
  ): Promise<MaintenanceRelayDesiredState> {
    const peerRows = await executor
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
      .orderBy(asc(maintenancePeers.tunnelAddress));
    const sessionRows = await executor
      .select()
      .from(maintenanceSessions)
      .where(
        and(
          isNull(maintenanceSessions.revokedAt),
          isNull(maintenanceSessions.failedAt),
          isNull(maintenanceSessions.expiredAt),
          gt(maintenanceSessions.expiresAt, generatedAt),
        ),
      )
      .orderBy(desc(maintenanceSessions.issuedAt));
    const targetRows = await this.getTargetMachine(executor);
    const peers = peerRows.map(toPublicPeer);
    const sourcePeerById = new Map(
      peers
        .filter((peer) => peer.role === "runner" || peer.role === "maintainer")
        .map((peer) => [peer.id, peer]),
    );
    const targetById = new Map(
      targetRows.map((target) => [target.id, toTargetMachine(target)]),
    );
    const authorizations = sessionRows.flatMap((session) => {
      const source = sourcePeerById.get(session.sourcePeerId);
      const target = targetById.get(session.targetMachineId);
      if (!source || !target) return [];
      return [
        {
          sessionId: session.id,
          sourcePeerId: source.id,
          sourceTunnelAddress: source.tunnelAddress,
          targetMachineId: target.id,
          targetTunnelAddress: target.tunnelAddress,
          protocol: session.protocol,
          port: session.port,
          expiresAt: toIso(session.expiresAt),
        },
      ];
    });
    return maintenanceRelayDesiredStateSchema.parse({
      schemaVersion: "maintenance-relay-desired-state/v1",
      desiredStateVersion,
      generatedAt: generatedAt.toISOString(),
      peers,
      authorizations,
    });
  }

  private parseReportedObservedState(
    value: unknown,
  ): MaintenanceRelayObservedState | null {
    if (value !== null && value !== undefined) {
      const parsed = maintenanceRelayObservedStateSchema.safeParse(value);
      if (parsed.success) return parsed.data;
    }
    return null;
  }

  private unreportedObservedState(
    desiredState: MaintenanceRelayDesiredState,
  ): MaintenanceRelayObservedState {
    return maintenanceRelayObservedStateSchema.parse({
      schemaVersion: "maintenance-relay-observed-state/v1",
      observedAt: desiredState.generatedAt,
      desiredStateSchemaVersion: desiredState.schemaVersion,
      appliedDesiredStateVersion: 0,
      attemptedDesiredStateVersion: null,
      appliedPeerIds: [],
      appliedAuthorizationIds: [],
      peerObservations: [],
      activeAuthorizationObservations: [],
      transport: {
        mode: "unknown",
        health: "unreported",
        reason: "relay transport has not been reported",
      },
      failure: null,
    });
  }

  private validateObservedIds(
    observed: MaintenanceRelayObservedState,
    desired: MaintenanceRelayDesiredState,
  ): void {
    const expectedPeerIds = desired.peers.map((peer) => peer.id);
    const expectedAuthorizations = desired.authorizations.filter(
      (authorization) =>
        Date.parse(authorization.expiresAt) > Date.parse(observed.observedAt),
    );
    const expectedAuthorizationIds = expectedAuthorizations.map(
      (authorization) => authorization.sessionId,
    );
    if (
      !sameUniqueIds(observed.appliedPeerIds, expectedPeerIds) ||
      !sameUniqueIds(
        observed.peerObservations.map((peer) => peer.peerId),
        expectedPeerIds,
      ) ||
      !sameUniqueIds(
        observed.appliedAuthorizationIds,
        expectedAuthorizationIds,
      ) ||
      !sameUniqueIds(
        observed.activeAuthorizationObservations.map(
          (authorization) => authorization.sessionId,
        ),
        expectedAuthorizationIds,
      )
    ) {
      throw new BadRequestException(
        "Observed IDs do not match the applied desired revision",
      );
    }
    const expectedExpiryBySessionId = new Map(
      expectedAuthorizations.map((authorization) => [
        authorization.sessionId,
        authorization.expiresAt,
      ]),
    );
    if (
      observed.activeAuthorizationObservations.some(
        (authorization) =>
          expectedExpiryBySessionId.get(authorization.sessionId) !==
          authorization.expiresAt,
      )
    ) {
      throw new BadRequestException(
        "Observed authorization expiry does not match desired state",
      );
    }
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
    currentDesiredStateVersion: number,
    observedState: MaintenanceRelayObservedState | null,
  ): MaintenanceSessionResponse {
    const actor =
      session.kind === "human" && session.issuedByAdminUserId
        ? {
            type: "admin" as const,
            adminUserId: session.issuedByAdminUserId,
          }
        : session.kind === "ci" && session.automationActorId
          ? {
              type: "automation" as const,
              automationActorId: session.automationActorId,
            }
          : null;
    if (!actor) throw new Error("Maintenance session actor is inconsistent");
    return maintenanceSessionResponseSchema.parse({
      id: session.id,
      kind: session.kind,
      actor,
      sourcePeer,
      targetMachine,
      protocol: session.protocol,
      port: session.port,
      reason: session.reason,
      issuedAt: toIso(session.issuedAt),
      expiresAt: toIso(session.expiresAt),
      activatedAt: session.activatedAt ? toIso(session.activatedAt) : null,
      expiredAt: session.expiredAt ? toIso(session.expiredAt) : null,
      failedAt: session.failedAt ? toIso(session.failedAt) : null,
      failure: projectFailure(
        session.failureReasonCode
          ? maintenanceRelayFailureReasonCodeSchema.parse(
              session.failureReasonCode,
            )
          : null,
      ),
      revokedAt: session.revokedAt ? toIso(session.revokedAt) : null,
      status: sessionStatus(session, now),
      relayConvergence: this.projectSessionRelayConvergence(
        session,
        currentDesiredStateVersion,
        observedState,
      ),
    });
  }

  private projectSessionRelayConvergence(
    session: typeof maintenanceSessions.$inferSelect,
    currentDesiredStateVersion: number,
    observedState: MaintenanceRelayObservedState | null,
  ) {
    const desiredStateVersion =
      session.desiredStateVersion ?? currentDesiredStateVersion;
    if (session.failedAt) {
      return {
        desiredStateVersion,
        appliedDesiredStateVersion:
          observedState?.appliedDesiredStateVersion ?? 0,
        state: "failed" as const,
      };
    }
    if (!observedState) {
      return {
        desiredStateVersion,
        appliedDesiredStateVersion: 0,
        state: "unknown" as const,
      };
    }
    if (observedState.appliedDesiredStateVersion < desiredStateVersion) {
      return {
        desiredStateVersion,
        appliedDesiredStateVersion: observedState.appliedDesiredStateVersion,
        state: "pending" as const,
      };
    }
    const terminal = Boolean(
      session.revokedAt || session.expiredAt || session.failedAt,
    );
    return {
      desiredStateVersion,
      appliedDesiredStateVersion: observedState.appliedDesiredStateVersion,
      state: terminal
        ? ("removed" as const)
        : observedState.appliedAuthorizationIds.includes(session.id)
          ? ("applied" as const)
          : ("pending" as const),
    };
  }
}
