import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import {
  and,
  auditLogs,
  eq,
  isNull,
  machines,
  maintenanceAutomationExchanges,
  maintenancePeers,
  type DrizzleClient,
} from "@vem/db";
import {
  CI_MAINTENANCE_SESSION_TTL_MINUTES,
  createCiMaintenanceSessionCommandSchema,
  githubOidcAutomationExchangeRequestSchema,
  githubOidcAutomationExchangeResponseSchema,
} from "@vem/shared";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import {
  GithubActionsOidcValidationError,
  type GithubOidcTrustPolicy,
  type VerifiedGithubActionsIdentity,
} from "./github-actions-oidc";
import {
  GithubActionsOidcJwksProvider,
  validateGithubActionsOidcTokenWithProvider,
} from "./github-actions-oidc-jwks";
import { MaintenanceAccessService } from "./maintenance-access.service";

type AutomationTokenPayload = {
  actor: "github_actions_automation";
  exchangeId: string;
  runId: string;
  runAttempt: string;
  sourcePeerId: string;
  targetMachineId: string;
  sha: string;
};

type AutomationIdentity = AutomationTokenPayload & { tokenDigest: string };

const AUTOMATION_TOKEN_AUDIENCE = "vem-maintenance-automation";
const AUTOMATION_TOKEN_ISSUER = "vem-service-api";
export const AUTOMATION_TOKEN_TTL_MINUTES = 125;
export const GITHUB_OIDC_AUTOMATION_CLOCK = Symbol(
  "GITHUB_OIDC_AUTOMATION_CLOCK",
);
export type GithubOidcAutomationClock = { now: () => Date };
export const systemGithubOidcAutomationClock: GithubOidcAutomationClock = {
  now: () => new Date(),
};
const EXCHANGE_RATE_LIMIT = 30;
const EXCHANGE_RATE_WINDOW_MS = 60_000;

@Injectable()
export class GithubOidcAutomationService {
  private jwksProvider: GithubActionsOidcJwksProvider | undefined;
  private readonly exchangeRateWindows = new Map<
    string,
    { startedAt: number; attempts: number }
  >();
  private readonly rejectionAuditWindows = new Map<string, number>();

  constructor(
    @Inject(JwtService) private readonly jwtService: JwtService,
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(GITHUB_OIDC_AUTOMATION_CLOCK)
    private readonly clock: GithubOidcAutomationClock,
    private readonly maintenanceAccess: MaintenanceAccessService,
  ) {}

  async exchange(input: unknown, sourceKey = "unknown") {
    if (!this.consumeExchangeAttempt(sourceKey)) {
      return await this.reject(
        "rate_limited",
        sourceKey,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const parsed = githubOidcAutomationExchangeRequestSchema.safeParse(input);
    if (!parsed.success) return await this.reject("request", sourceKey);
    try {
      const policy = this.config.githubOidcTrustPolicy;
      const identity = await this.validateOidcToken(
        parsed.data.idToken,
        policy,
      );
      if (
        identity.runId !== parsed.data.runId ||
        identity.runAttempt !== parsed.data.runAttempt ||
        identity.sha !== parsed.data.sha
      ) {
        return await this.reject("run_binding", sourceKey);
      }
      const [target] = await this.db
        .select({ id: machines.id, code: machines.code })
        .from(machines)
        .where(eq(machines.id, parsed.data.targetMachineId));
      if (!target || !policy.targetMachineCodes.includes(target.code)) {
        return await this.reject("target_scope", sourceKey);
      }
      const [source] = await this.db
        .select({ id: maintenancePeers.id })
        .from(maintenancePeers)
        .where(
          and(
            eq(maintenancePeers.id, parsed.data.sourcePeerId),
            eq(maintenancePeers.role, "runner"),
            eq(maintenancePeers.status, "active"),
            isNull(maintenancePeers.revokedAt),
          ),
        );
      if (!source) return await this.reject("source_scope", sourceKey);

      const now = this.clock.now();
      const expiresAt = new Date(
        now.getTime() + AUTOMATION_TOKEN_TTL_MINUTES * 60_000,
      );
      const payload: Omit<AutomationTokenPayload, "exchangeId"> = {
        actor: "github_actions_automation",
        runId: identity.runId,
        runAttempt: identity.runAttempt,
        sourcePeerId: source.id,
        targetMachineId: target.id,
        sha: identity.sha,
      };
      const exchangeId = randomUUID();
      const issuedAtSeconds = Math.floor(now.getTime() / 1_000);
      const expiresAtSeconds = Math.floor(expiresAt.getTime() / 1_000);
      const accessToken = await this.jwtService.signAsync(
        {
          ...payload,
          exchangeId,
          iat: issuedAtSeconds,
          exp: expiresAtSeconds,
        },
        {
          algorithm: "HS256",
          audience: AUTOMATION_TOKEN_AUDIENCE,
          issuer: AUTOMATION_TOKEN_ISSUER,
          secret: this.config.maintenanceAutomationJwtSecret,
          jwtid: randomUUID(),
        },
      );
      await this.db.transaction(async (tx) => {
        await tx.insert(maintenanceAutomationExchanges).values({
          id: exchangeId,
          oidcIssuer: identity.issuer,
          oidcTokenId: identity.tokenId,
          githubRepositoryId: identity.repositoryId,
          githubClaimModel: identity.claimModel,
          githubWorkflowRef: identity.workflowRef,
          githubWorkflowSha: identity.workflowSha,
          githubRef: identity.ref,
          automationTokenDigest: digest(accessToken),
          githubRunId: identity.runId,
          githubRunAttempt: identity.runAttempt,
          githubSha: identity.sha,
          sourcePeerId: source.id,
          targetMachineId: target.id,
          reason: parsed.data.reason.trim(),
          expiresAt,
        });
        await tx.insert(auditLogs).values({
          action: "maintenanceAccess.automation.exchange",
          resourceType: "maintenance_automation_exchange",
          resourceId: exchangeId,
          afterJson: {
            issuer: identity.issuer,
            tokenId: identity.tokenId,
            repositoryId: identity.repositoryId,
            claimModel: identity.claimModel,
            workflowRef: identity.workflowRef,
            workflowSha: identity.workflowSha,
            ref: identity.ref,
            environment: identity.environment,
            runId: identity.runId,
            runAttempt: identity.runAttempt,
            sha: identity.sha,
            sourcePeerId: source.id,
            targetMachineId: target.id,
            expiresAt: expiresAt.toISOString(),
          },
        });
      });
      return githubOidcAutomationExchangeResponseSchema.parse({
        actor: {
          type: "github_actions",
          runId: identity.runId,
          runAttempt: identity.runAttempt,
        },
        accessToken,
        expiresAt: expiresAt.toISOString(),
        sessionTtlMinutes: CI_MAINTENANCE_SESSION_TTL_MINUTES,
      });
    } catch (error) {
      if (error instanceof GithubActionsOidcValidationError) {
        return await this.reject(error.reasonCode, sourceKey);
      }
      if (isUniqueViolation(error))
        return await this.reject("replay", sourceKey);
      return await this.reject("exchange_failed", sourceKey);
    }
  }

  async createOwnSession(authorization: string | undefined) {
    const identity = await this.requireIdentity(authorization);
    const [exchange] = await this.db
      .select({ reason: maintenanceAutomationExchanges.reason })
      .from(maintenanceAutomationExchanges)
      .where(eq(maintenanceAutomationExchanges.id, identity.exchangeId));
    if (!exchange)
      throw new UnauthorizedException("Invalid maintenance automation token");
    return await this.maintenanceAccess.createCiSessionFromAutomationExchange(
      createCiMaintenanceSessionCommandSchema.parse({
        sourcePeerId: identity.sourcePeerId,
        targetMachineId: identity.targetMachineId,
        automationActorId: `github-run:${identity.runId}:${identity.runAttempt}`,
        reason: exchange.reason,
      }),
      identity.exchangeId,
    );
  }

  async getOwnSession(authorization: string | undefined) {
    const identity = await this.requireIdentity(authorization);
    const [exchange] = await this.db
      .select({ sessionId: maintenanceAutomationExchanges.sessionId })
      .from(maintenanceAutomationExchanges)
      .where(eq(maintenanceAutomationExchanges.id, identity.exchangeId));
    if (!exchange?.sessionId)
      throw new NotFoundException("Automation session not found");
    const session = (
      await this.maintenanceAccess.listSessions({ kind: "ci" })
    ).find((candidate) => candidate.id === exchange.sessionId);
    if (!session) throw new NotFoundException("Automation session not found");
    return session;
  }

  async revokeOwnSession(authorization: string | undefined) {
    const identity = await this.requireIdentity(authorization);
    const [exchange] = await this.db
      .select({ sessionId: maintenanceAutomationExchanges.sessionId })
      .from(maintenanceAutomationExchanges)
      .where(eq(maintenanceAutomationExchanges.id, identity.exchangeId));
    if (!exchange?.sessionId)
      throw new NotFoundException("Automation session not found");
    return await this.maintenanceAccess.revokeSessionFromAutomationExchange(
      identity.exchangeId,
      exchange.sessionId,
    );
  }

  private async requireIdentity(
    authorization: string | undefined,
  ): Promise<AutomationIdentity> {
    const token = /^Bearer ([^\s]+)$/.exec(authorization ?? "")?.[1];
    if (!token)
      throw new UnauthorizedException("Missing maintenance automation token");
    try {
      const payload = await this.jwtService.verifyAsync<AutomationTokenPayload>(
        token,
        {
          algorithms: ["HS256"],
          audience: AUTOMATION_TOKEN_AUDIENCE,
          issuer: AUTOMATION_TOKEN_ISSUER,
          secret: this.config.maintenanceAutomationJwtSecret,
          clockTimestamp: Math.floor(this.clock.now().getTime() / 1_000),
        },
      );
      if (payload.actor !== "github_actions_automation")
        throw new Error("wrong actor");
      const tokenDigest = digest(token);
      const [exchange] = await this.db
        .select({
          automationTokenDigest:
            maintenanceAutomationExchanges.automationTokenDigest,
          expiresAt: maintenanceAutomationExchanges.expiresAt,
          revokedAt: maintenanceAutomationExchanges.revokedAt,
        })
        .from(maintenanceAutomationExchanges)
        .where(eq(maintenanceAutomationExchanges.id, payload.exchangeId));
      if (
        !exchange ||
        exchange.revokedAt ||
        exchange.expiresAt <= this.clock.now() ||
        !digestsEqual(tokenDigest, exchange.automationTokenDigest)
      ) {
        throw new Error("token not active");
      }
      return { ...payload, tokenDigest };
    } catch {
      throw new UnauthorizedException("Invalid maintenance automation token");
    }
  }

  private async validateOidcToken(
    token: string,
    policy: GithubOidcTrustPolicy,
  ): Promise<VerifiedGithubActionsIdentity> {
    this.jwksProvider ??= new GithubActionsOidcJwksProvider({
      staticJwks: this.config.githubOidcJwks,
    });
    return await validateGithubActionsOidcTokenWithProvider(token, {
      provider: this.jwksProvider,
      now: Math.floor(this.clock.now().getTime() / 1_000),
      policy,
    });
  }

  private async reject(
    reasonCode: string,
    sourceKey: string,
    status = HttpStatus.UNAUTHORIZED,
  ): Promise<never> {
    if (this.shouldAuditRejection(sourceKey, reasonCode)) {
      await this.db.insert(auditLogs).values({
        action: "maintenanceAccess.automation.exchange.reject",
        resourceType: "maintenance_automation_exchange",
        afterJson: { reasonCode },
      });
    }
    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      throw new HttpException(
        "GitHub OIDC automation exchange rate limit exceeded",
        status,
      );
    }
    throw new UnauthorizedException("GitHub OIDC automation exchange rejected");
  }

  private consumeExchangeAttempt(sourceKey: string): boolean {
    const now = this.clock.now().getTime();
    const current = this.exchangeRateWindows.get(sourceKey);
    if (
      !current ||
      now < current.startedAt ||
      now - current.startedAt >= EXCHANGE_RATE_WINDOW_MS
    ) {
      this.exchangeRateWindows.set(sourceKey, { startedAt: now, attempts: 1 });
      this.pruneRateLimitState(now);
      return true;
    }
    if (current.attempts >= EXCHANGE_RATE_LIMIT) return false;
    current.attempts += 1;
    return true;
  }

  private shouldAuditRejection(sourceKey: string, reasonCode: string): boolean {
    const now = this.clock.now().getTime();
    const key = `${sourceKey}\0${reasonCode}`;
    const lastAuditAt = this.rejectionAuditWindows.get(key);
    if (
      lastAuditAt !== undefined &&
      now >= lastAuditAt &&
      now - lastAuditAt < EXCHANGE_RATE_WINDOW_MS
    ) {
      return false;
    }
    this.rejectionAuditWindows.set(key, now);
    this.pruneRateLimitState(now);
    return true;
  }

  private pruneRateLimitState(now: number): void {
    if (
      this.exchangeRateWindows.size < 1_024 &&
      this.rejectionAuditWindows.size < 2_048
    ) {
      return;
    }
    for (const [key, window] of this.exchangeRateWindows) {
      if (now - window.startedAt >= EXCHANGE_RATE_WINDOW_MS) {
        this.exchangeRateWindows.delete(key);
      }
    }
    for (const [key, auditedAt] of this.rejectionAuditWindows) {
      if (now - auditedAt >= EXCHANGE_RATE_WINDOW_MS) {
        this.rejectionAuditWindows.delete(key);
      }
    }
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestsEqual(actual: string, expected: string): boolean {
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  );
}

function isUniqueViolation(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ("code" in current && current.code === "23505") return true;
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}
