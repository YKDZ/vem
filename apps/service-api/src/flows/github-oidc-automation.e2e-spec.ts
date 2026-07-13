import type { INestApplication } from "@nestjs/common";

import { Test } from "@nestjs/testing";
import {
  DrizzleDB,
  auditLogs,
  eq,
  inArray,
  machines,
  maintenanceAutomationExchanges,
  maintenancePeers,
  maintenanceSessions,
  maintenanceSshCertificates,
  sql,
} from "@vem/db";
import { execFileSync } from "node:child_process";
import {
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
} from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { MqttService } from "../mqtt/mqtt.service";

import {
  GITHUB_OIDC_AUTOMATION_CLOCK,
  type GithubOidcAutomationClock,
} from "../maintenance-access/github-oidc-automation.service";
import { MaintenanceAccessService } from "../maintenance-access/maintenance-access.service";

const DATABASE_URL =
  process.env.DATABASE_URL ??
  "postgresql://vem:vem_password@127.0.0.1:5432/vem";
const TEST_SHA = "a".repeat(40);
const TEST_RUN_ID = "987654321";
const TEST_RUN_ATTEMPT = "3";
const TEST_MACHINE_CODE = "VEM-TESTBED-RUNTIME-ACCEPTANCE";
const TEST_SECOND_MACHINE_CODE = "VEM-TESTBED-RUNTIME-ACCEPTANCE-SECONDARY";

type ApiResponse<T> = { data: T };

describe(
  "GitHub OIDC maintenance automation HTTP flow",
  { concurrent: false },
  () => {
    let app: INestApplication;
    let api: ReturnType<typeof request>;
    let db: DrizzleDB;
    let maintenanceAccess: MaintenanceAccessService;
    let configDirectory: string;
    let policyPath: string;
    let privateJwk: JsonWebKey;
    let jwks: { keys: Record<string, unknown>[] };
    const testClockOrigin = Date.now();
    let testClockSequence = 0;
    let fakeNow = new Date(testClockOrigin);
    const allowedRunnerPeerIds = new Set<string>();
    const fakeClock: GithubOidcAutomationClock = { now: () => fakeNow };

    beforeAll(async () => {
      configDirectory = mkdtempSync(join(tmpdir(), "vem-oidc-e2e-"));
      policyPath = join(configDirectory, "policy.json");
      const jwksPath = join(configDirectory, "jwks.json");
      const secretPath = join(configDirectory, "automation-jwt-secret");
      const sshCaPath = join(configDirectory, "maintenance-ssh-ca");
      const sshTargetPolicyPath = join(
        configDirectory,
        "maintenance-ssh-target-policy.json",
      );
      const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
      privateJwk = keyPair.privateKey.export({ format: "jwk" });
      const publicJwk = keyPair.publicKey.export({ format: "jwk" });
      jwks = {
        keys: [
          {
            ...publicJwk,
            kid: "github-actions-live-shaped-e2e",
            use: "sig",
            alg: "RS256",
            x5c: ["live-shaped-test-certificate"],
            x5t: "live-shaped-test-thumbprint",
            "x5t#S256": "live-shaped-test-sha256-thumbprint",
          },
        ],
      };
      writeFileSync(
        policyPath,
        JSON.stringify({
          repositoryId: "123456789",
          workflowIdentity: {
            claimModel: "direct",
            workflowRef:
              "vem/vem/.github/workflows/vm-runtime-acceptance.yml@refs/heads/main",
            allowedWorkflowShas: [TEST_SHA],
          },
          refs: ["refs/heads/main"],
          events: ["workflow_dispatch"],
          environments: ["vem-maintenance-testbed"],
          requireRefProtected: true,
          allowedRunnerPeerIds: ["11111111-1111-4111-8111-111111111111"],
          targetMachineCodes: [TEST_MACHINE_CODE, TEST_SECOND_MACHINE_CODE],
        }),
        { mode: 0o400 },
      );
      execFileSync("/usr/bin/ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        sshCaPath,
      ]);
      chmodSync(sshCaPath, 0o400);
      const sshCaFingerprint = execFileSync(
        "/usr/bin/ssh-keygen",
        ["-lf", `${sshCaPath}.pub`, "-E", "sha256"],
        { encoding: "utf8" },
      ).match(/(SHA256:[A-Za-z0-9+/]+={0,2})/)?.[1];
      if (!sshCaFingerprint)
        throw new Error("Could not read automation test SSH CA fingerprint");
      writeFileSync(
        sshTargetPolicyPath,
        JSON.stringify({
          profile: "testbed",
          targetMachineCodes: [TEST_MACHINE_CODE, TEST_SECOND_MACHINE_CODE],
        }),
        { mode: 0o400 },
      );
      writeFileSync(jwksPath, JSON.stringify(jwks), { mode: 0o400 });
      writeFileSync(
        secretPath,
        "e2e-automation-jwt-secret-which-is-long-enough",
        {
          mode: 0o400,
        },
      );
      chmodSync(policyPath, 0o400);

      process.env.DATABASE_URL = DATABASE_URL;
      process.env.MAINTENANCE_GITHUB_OIDC_TRUST_POLICY_PATH = policyPath;
      process.env.MAINTENANCE_GITHUB_OIDC_JWKS_PATH = jwksPath;
      process.env.MAINTENANCE_AUTOMATION_JWT_SECRET_PATH = secretPath;
      process.env.MAINTENANCE_SSH_CA_PRIVATE_KEY_PATH = sshCaPath;
      process.env.MAINTENANCE_SSH_CA_PUBLIC_KEY_FINGERPRINT = sshCaFingerprint;
      process.env.MAINTENANCE_SSH_PROFILE = "testbed";
      process.env.MAINTENANCE_SSH_TARGET_POLICY_PATH = sshTargetPolicyPath;

      const [{ AppModule }, { MqttService }] = await Promise.all([
        import("../app.module"),
        import("../mqtt/mqtt.service"),
      ]);
      const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(MqttService)
        .useValue({
          bindVendingService: () => undefined,
          registerMachineMessageHandler: () => undefined,
          isConnected: () => false,
          publish: async () => undefined,
        } satisfies Partial<MqttService>)
        .overrideProvider(GITHUB_OIDC_AUTOMATION_CLOCK)
        .useValue(fakeClock)
        .compile();
      app = moduleRef.createNestApplication();
      app.setGlobalPrefix("api");
      await app.init();
      api = request(app.getHttpServer());
      db = new DrizzleDB(DATABASE_URL);
      await db.connect();
      maintenanceAccess = app.get(MaintenanceAccessService);
    }, 60_000);

    afterAll(async () => {
      await db?.disconnect();
      await app?.close();
      rmSync(configDirectory, { recursive: true, force: true });
      delete process.env.MAINTENANCE_SSH_CA_PRIVATE_KEY_PATH;
      delete process.env.MAINTENANCE_SSH_CA_PUBLIC_KEY_FINGERPRINT;
      delete process.env.MAINTENANCE_SSH_PROFILE;
      delete process.env.MAINTENANCE_SSH_TARGET_POLICY_PATH;
    });

    beforeEach(async () => {
      fakeNow = new Date(testClockOrigin + testClockSequence * 61_000);
      testClockSequence += 1;
      allowedRunnerPeerIds.clear();
      await db.client
        .delete(auditLogs)
        .where(
          inArray(auditLogs.action, [
            "maintenanceAccess.automation.exchange",
            "maintenanceAccess.automation.exchange.reject",
            "maintenanceAccess.session.create",
            "maintenanceAccess.session.revoke",
            "maintenanceAccess.sshCertificate.issue",
          ]),
        );
      await db.client.delete(maintenanceSshCertificates);
      await db.client.delete(maintenanceAutomationExchanges);
      await db.client.delete(maintenanceSessions);
      await db.client.delete(maintenancePeers);
      await db.client
        .delete(machines)
        .where(
          inArray(machines.code, [TEST_MACHINE_CODE, TEST_SECOND_MACHINE_CODE]),
        );
    });

    it("exchanges a signed direct-workflow assertion for a 125-minute automation identity", async () => {
      const scope = await provisionMaintenanceScope();
      const issuedAt = fakeNow;
      const exchange = await exchangeAutomationIdentity(scope, { issuedAt });

      expect(exchange.accessToken).toEqual(expect.any(String));
      expect(
        Math.round(
          (Date.parse(exchange.expiresAt) - issuedAt.getTime()) / 60_000,
        ),
      ).toBe(125);
      const persisted = await db.client
        .select()
        .from(maintenanceAutomationExchanges);
      const persistedAudit = await db.client
        .select({ afterJson: auditLogs.afterJson })
        .from(auditLogs)
        .where(eq(auditLogs.action, "maintenanceAccess.automation.exchange"));
      expect(JSON.stringify({ persisted, persistedAudit })).not.toContain(
        exchange.accessToken,
      );
      expect(persisted[0]?.automationTokenDigest).toMatch(/^[0-9a-f]{64}$/);
    });

    it("rolls back the exchange when its success audit cannot be persisted", async () => {
      const scope = await provisionMaintenanceScope();
      await db.client.execute(sql`
      CREATE OR REPLACE FUNCTION issue05_fail_exchange_audit()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.action = 'maintenanceAccess.automation.exchange' THEN
          RAISE EXCEPTION 'forced exchange audit failure';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
      await db.client.execute(sql`
      DROP TRIGGER IF EXISTS issue05_fail_exchange_audit_trigger ON audit_logs
    `);
      await db.client.execute(sql`
      CREATE TRIGGER issue05_fail_exchange_audit_trigger
      BEFORE INSERT ON audit_logs
      FOR EACH ROW EXECUTE FUNCTION issue05_fail_exchange_audit()
    `);
      try {
        await api
          .post("/api/maintenance-automation/exchange")
          .send({
            idToken: signedOidcToken({ issuedAt: fakeNow }),
            runId: TEST_RUN_ID,
            runAttempt: TEST_RUN_ATTEMPT,
            sha: TEST_SHA,
            sourcePeerId: scope.sourcePeerId,
            targetMachineId: scope.targetMachineId,
            reason: "Run VM Runtime Acceptance",
          })
          .expect(401);
      } finally {
        await db.client.execute(sql`
        DROP TRIGGER IF EXISTS issue05_fail_exchange_audit_trigger ON audit_logs
      `);
        await db.client.execute(sql`
        DROP FUNCTION IF EXISTS issue05_fail_exchange_audit()
      `);
      }

      expect(
        await db.client.select().from(maintenanceAutomationExchanges),
      ).toEqual([]);
      const exchangeAudits = await db.client
        .select({ action: auditLogs.action, afterJson: auditLogs.afterJson })
        .from(auditLogs)
        .where(
          inArray(auditLogs.action, [
            "maintenanceAccess.automation.exchange",
            "maintenanceAccess.automation.exchange.reject",
          ]),
        );
      expect(exchangeAudits).toEqual([
        {
          action: "maintenanceAccess.automation.exchange.reject",
          afterJson: { reasonCode: "exchange_failed" },
        },
      ]);
    });

    it("rejects an active runner peer that is outside the deployment trust policy", async () => {
      const scope = await provisionMaintenanceScope();
      const untrustedRunner = await maintenanceAccess.registerPeer({
        role: "runner",
        publicKey: randomBytes(32).toString("base64"),
      });

      await api
        .post("/api/maintenance-automation/exchange")
        .send({
          idToken: signedOidcToken({ issuedAt: fakeNow }),
          runId: TEST_RUN_ID,
          runAttempt: TEST_RUN_ATTEMPT,
          sha: TEST_SHA,
          sourcePeerId: untrustedRunner.id,
          targetMachineId: scope.targetMachineId,
          reason: "Cross-runner policy attempt",
        })
        .expect(401);
      const [audit] = await db.client
        .select({ afterJson: auditLogs.afterJson })
        .from(auditLogs)
        .where(
          eq(auditLogs.action, "maintenanceAccess.automation.exchange.reject"),
        );
      expect(audit?.afterJson).toEqual({ reasonCode: "source_scope" });
    });

    it("creates, verifies, and revokes only its own fixed 150-minute CI session over HTTP", async () => {
      const scope = await provisionMaintenanceScope();
      const exchange = await exchangeAutomationIdentity(scope);
      const authorization = { Authorization: `Bearer ${exchange.accessToken}` };

      const created = (
        await api
          .post("/api/maintenance-automation/session")
          .set(authorization)
          .expect(201)
      ).body.data as {
        id: string;
        issuedAt: string;
        expiresAt: string;
        status: string;
        targetMachine: { id: string };
      };
      expect(created.status).toBe("active");
      expect(created.targetMachine.id).toBe(scope.targetMachineId);
      expect(
        (Date.parse(created.expiresAt) - Date.parse(created.issuedAt)) / 60_000,
      ).toBe(150);

      const verified = (
        await api
          .get("/api/maintenance-automation/session")
          .set(authorization)
          .expect(200)
      ).body.data as { id: string; status: string };
      expect(verified).toMatchObject({ id: created.id, status: "active" });

      const revoked = (
        await api
          .post("/api/maintenance-automation/session/revoke")
          .set(authorization)
          .expect(201)
      ).body.data as { id: string; status: string };
      expect(revoked).toMatchObject({ id: created.id, status: "revoked" });

      const [persistedExchange] = await db.client
        .select({ id: maintenanceAutomationExchanges.id })
        .from(maintenanceAutomationExchanges);
      const sessionAudits = await db.client
        .select({
          action: auditLogs.action,
          adminUserId: auditLogs.adminUserId,
          afterJson: auditLogs.afterJson,
        })
        .from(auditLogs)
        .where(eq(auditLogs.resourceId, created.id));
      expect(sessionAudits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "maintenanceAccess.session.create",
            adminUserId: null,
            afterJson: expect.objectContaining({
              actor: {
                type: "github_actions_automation",
                exchangeId: persistedExchange?.id,
                runId: TEST_RUN_ID,
                runAttempt: TEST_RUN_ATTEMPT,
              },
            }),
          }),
          expect.objectContaining({
            action: "maintenanceAccess.session.revoke",
            adminUserId: null,
            afterJson: expect.objectContaining({
              actor: {
                type: "github_actions_automation",
                exchangeId: persistedExchange?.id,
                runId: TEST_RUN_ID,
                runAttempt: TEST_RUN_ATTEMPT,
              },
            }),
          }),
        ]),
      );
      expect(JSON.stringify(sessionAudits)).not.toContain(exchange.accessToken);
    });

    it("issues an audited SSH certificate through its own automation session", async () => {
      const scope = await provisionMaintenanceScope();
      const exchange = await exchangeAutomationIdentity(scope);
      const authorization = { Authorization: `Bearer ${exchange.accessToken}` };
      const session = (
        await api
          .post("/api/maintenance-automation/session")
          .set(authorization)
          .expect(201)
      ).body.data as { id: string; sourcePeer: { tunnelAddress: string } };
      const userKeyPath = join(
        configDirectory,
        `automation-user-${randomBytes(6).toString("hex")}`,
      );
      execFileSync("/usr/bin/ssh-keygen", [
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        userKeyPath,
      ]);
      const publicKey = readFileSync(`${userKeyPath}.pub`, "utf8")
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .join(" ");

      const certificate = (
        await api
          .post("/api/maintenance-automation/session/ssh-certificate")
          .set(authorization)
          .send({ publicKey, requestId: randomUUID() })
          .expect(201)
      ).body.data as {
        certificate: string;
        principal: string;
        sourceAddress: string;
        serial: number;
      };
      expect(certificate).toMatchObject({
        principal: "YKDZ",
        sourceAddress: session.sourcePeer.tunnelAddress,
        serial: expect.any(Number),
      });
      expect(certificate.certificate.split(/\s+/)).toHaveLength(2);
      const [audit] = await db.client
        .select({ afterJson: auditLogs.afterJson })
        .from(auditLogs)
        .where(eq(auditLogs.action, "maintenanceAccess.sshCertificate.issue"));
      expect(audit?.afterJson).toMatchObject({
        actor: {
          type: "github_actions_automation",
          runId: TEST_RUN_ID,
          runAttempt: TEST_RUN_ATTEMPT,
        },
      });
      expect(JSON.stringify(audit)).not.toContain(certificate.certificate);
    });

    it("atomically rejects concurrent issuer+jti replay even when raw JWT bytes and runs differ", async () => {
      const scope = await provisionMaintenanceScope(TEST_MACHINE_CODE);
      const issuedAt = fakeNow;
      const sharedTokenId = `shared-jti-${randomBytes(8).toString("hex")}`;
      const requestBody = (runId: string, workflow: string) => ({
        idToken: signedOidcToken({
          issuedAt,
          jti: sharedTokenId,
          runId,
          workflow,
        }),
        runId,
        runAttempt: TEST_RUN_ATTEMPT,
        sha: TEST_SHA,
        sourcePeerId: scope.sourcePeerId,
        targetMachineId: scope.targetMachineId,
        reason: "Run VM Runtime Acceptance",
      });
      const firstRequest = requestBody(TEST_RUN_ID, "VM Runtime Acceptance");
      const secondRequest = requestBody(
        "987654322",
        "Renamed VM Runtime Acceptance",
      );

      const responses = await Promise.all([
        api.post("/api/maintenance-automation/exchange").send(firstRequest),
        api.post("/api/maintenance-automation/exchange").send(secondRequest),
      ]);

      expect(
        responses
          .map((response) => response.status)
          .sort((left, right) => left - right),
      ).toEqual([201, 401]);
      expect(
        await db.client.select().from(maintenanceAutomationExchanges),
      ).toHaveLength(1);
      const audits = await db.client
        .select({ action: auditLogs.action, afterJson: auditLogs.afterJson })
        .from(auditLogs)
        .where(
          inArray(auditLogs.action, [
            "maintenanceAccess.automation.exchange",
            "maintenanceAccess.automation.exchange.reject",
          ]),
        );
      expect(audits).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "maintenanceAccess.automation.exchange.reject",
            afterJson: { reasonCode: "replay" },
          }),
        ]),
      );
      expect(JSON.stringify(audits)).not.toContain(firstRequest.idToken);
      expect(JSON.stringify(audits)).not.toContain(secondRequest.idToken);
    });

    it("rejects exchanging one run attempt for a second target even with a fresh jti", async () => {
      const firstScope = await provisionMaintenanceScope(TEST_MACHINE_CODE);
      const secondScope = await provisionMaintenanceScope(
        TEST_SECOND_MACHINE_CODE,
      );
      await exchangeAutomationIdentity(firstScope);

      await api
        .post("/api/maintenance-automation/exchange")
        .send({
          idToken: signedOidcToken({
            issuedAt: fakeNow,
            jti: `fresh-jti-${randomBytes(8).toString("hex")}`,
          }),
          runId: TEST_RUN_ID,
          runAttempt: TEST_RUN_ATTEMPT,
          sha: TEST_SHA,
          sourcePeerId: secondScope.sourcePeerId,
          targetMachineId: secondScope.targetMachineId,
          reason: "Try another target",
        })
        .expect(401);

      const [exchange] = await db.client
        .select({
          targetMachineId: maintenanceAutomationExchanges.targetMachineId,
        })
        .from(maintenanceAutomationExchanges);
      expect(exchange?.targetMachineId).toBe(firstScope.targetMachineId);
    });

    it("does not let another valid run token inspect or revoke a cross-target session", async () => {
      const firstScope = await provisionMaintenanceScope(TEST_MACHINE_CODE);
      const secondScope = await provisionMaintenanceScope(
        TEST_SECOND_MACHINE_CODE,
      );
      const first = await exchangeAutomationIdentity(firstScope);
      const second = await exchangeAutomationIdentity(secondScope, {
        runId: "987654322",
      });
      const firstAuthorization = {
        Authorization: `Bearer ${first.accessToken}`,
      };
      const secondAuthorization = {
        Authorization: `Bearer ${second.accessToken}`,
      };
      const created = (
        await api
          .post("/api/maintenance-automation/session")
          .set(firstAuthorization)
          .expect(201)
      ).body.data as { id: string };

      await api
        .get("/api/maintenance-automation/session")
        .set(secondAuthorization)
        .expect(404);
      await api
        .post("/api/maintenance-automation/session/revoke")
        .set(secondAuthorization)
        .expect(404);
      const stillActive = (
        await api
          .get("/api/maintenance-automation/session")
          .set(firstAuthorization)
          .expect(200)
      ).body.data as { id: string; status: string };
      expect(stillActive).toMatchObject({ id: created.id, status: "active" });
    });

    it("enforces the 125-minute automation token boundary with a fake clock", async () => {
      const issuedAt = fakeNow;
      const scope = await provisionMaintenanceScope();
      const exchange = await exchangeAutomationIdentity(scope, {
        issuedAt,
      });
      const authorization = { Authorization: `Bearer ${exchange.accessToken}` };

      fakeNow = new Date(issuedAt.getTime() + 124 * 60_000 + 59_000);
      await api
        .get("/api/maintenance-automation/session")
        .set(authorization)
        .expect(404);

      fakeNow = new Date(issuedAt.getTime() + 125 * 60_000);
      await api
        .get("/api/maintenance-automation/session")
        .set(authorization)
        .expect(401);
    });

    it("rate limits exchange attempts in process and deduplicates rejection audit writes", async () => {
      const windowStart = fakeNow;
      const statuses = await Array.from({ length: 31 }).reduce<
        Promise<number[]>
      >(async (pendingStatuses) => {
        const resolvedStatuses = await pendingStatuses;
        const response = await api
          .post("/api/maintenance-automation/exchange")
          .send({});
        resolvedStatuses.push(response.status);
        return resolvedStatuses;
      }, Promise.resolve([]));

      expect(statuses.slice(0, 30)).toEqual(
        Array.from({ length: 30 }, () => 401),
      );
      expect(statuses[30]).toBe(429);
      const rejectionAudits = await db.client
        .select({ afterJson: auditLogs.afterJson })
        .from(auditLogs)
        .where(
          eq(auditLogs.action, "maintenanceAccess.automation.exchange.reject"),
        );
      expect(rejectionAudits).toEqual([
        { afterJson: { reasonCode: "request" } },
        { afterJson: { reasonCode: "rate_limited" } },
      ]);

      fakeNow = new Date(windowStart.getTime() + 60_000);
      await api
        .post("/api/maintenance-automation/exchange")
        .send({})
        .expect(401);
    });

    async function exchangeAutomationIdentity(
      scope: { sourcePeerId: string; targetMachineId: string },
      options: { issuedAt?: Date; runId?: string; runAttempt?: string } = {},
    ) {
      const issuedAt = options.issuedAt ?? fakeNow;
      const runId = options.runId ?? TEST_RUN_ID;
      const runAttempt = options.runAttempt ?? TEST_RUN_ATTEMPT;
      const response = await api
        .post("/api/maintenance-automation/exchange")
        .send({
          idToken: signedOidcToken({ issuedAt, runId, runAttempt }),
          runId,
          runAttempt,
          sha: TEST_SHA,
          sourcePeerId: scope.sourcePeerId,
          targetMachineId: scope.targetMachineId,
          reason: "Run VM Runtime Acceptance",
        })
        .expect(201);
      return (
        response.body as ApiResponse<{
          accessToken: string;
          expiresAt: string;
        }>
      ).data;
    }

    async function provisionMaintenanceScope(machineCode = TEST_MACHINE_CODE) {
      const [machine] = await db.client
        .insert(machines)
        .values({
          code: machineCode,
          name: "OIDC automation e2e target",
          status: "online",
        })
        .returning({ id: machines.id });
      const source = await maintenanceAccess.registerPeer({
        role: "runner",
        publicKey: randomBytes(32).toString("base64"),
      });
      allowedRunnerPeerIds.add(source.id);
      writeAllowedRunnerPolicy();
      await maintenanceAccess.registerPeer({
        role: "machine",
        machineId: machine.id,
        publicKey: randomBytes(32).toString("base64"),
      });
      return { sourcePeerId: source.id, targetMachineId: machine.id };
    }

    function writeAllowedRunnerPolicy(): void {
      chmodSync(policyPath, 0o600);
      writeFileSync(
        policyPath,
        JSON.stringify({
          repositoryId: "123456789",
          workflowIdentity: {
            claimModel: "direct",
            workflowRef:
              "vem/vem/.github/workflows/vm-runtime-acceptance.yml@refs/heads/main",
            allowedWorkflowShas: [TEST_SHA],
          },
          refs: ["refs/heads/main"],
          events: ["workflow_dispatch"],
          environments: ["vem-maintenance-testbed"],
          requireRefProtected: true,
          allowedRunnerPeerIds: [...allowedRunnerPeerIds],
          targetMachineCodes: [TEST_MACHINE_CODE, TEST_SECOND_MACHINE_CODE],
        }),
      );
      chmodSync(policyPath, 0o400);
    }

    function signedOidcToken({
      issuedAt,
      runId = TEST_RUN_ID,
      runAttempt = TEST_RUN_ATTEMPT,
      jti,
      workflow = "VM Runtime Acceptance",
    }: {
      issuedAt: Date;
      runId?: string;
      runAttempt?: string;
      jti?: string;
      workflow?: string;
    }): string {
      const now = Math.floor(issuedAt.getTime() / 1_000);
      const header = encode({
        alg: "RS256",
        kid: jwks.keys[0]?.kid,
        typ: "JWT",
      });
      const payload = encode({
        iss: "https://token.actions.githubusercontent.com",
        aud: "vem-maintenance",
        repository_id: "123456789",
        workflow,
        workflow_ref:
          "vem/vem/.github/workflows/vm-runtime-acceptance.yml@refs/heads/main",
        workflow_sha: TEST_SHA,
        ref: "refs/heads/main",
        ref_protected: true,
        event_name: "workflow_dispatch",
        sha: TEST_SHA,
        run_id: runId,
        run_attempt: runAttempt,
        environment: "vem-maintenance-testbed",
        jti: jti ?? `e2e-${runId}-${runAttempt}-${issuedAt.getTime()}`,
        iat: now - 1,
        nbf: now - 1,
        exp: now + 299,
      });
      const signingInput = `${header}.${payload}`;
      const signature = sign(
        "RSA-SHA256",
        Buffer.from(signingInput),
        createPrivateKey({ key: privateJwk, format: "jwk" }),
      ).toString("base64url");
      return `${signingInput}.${signature}`;
    }
  },
);

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
