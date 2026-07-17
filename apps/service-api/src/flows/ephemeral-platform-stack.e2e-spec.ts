import type { INestApplication } from "@nestjs/common";

import { Test } from "@nestjs/testing";
import { and, auditLogs, DrizzleDB, eq, inArray } from "@vem/db";
import {
  machineProvisioningProfileSchema,
  machineProvisioningProfileSnapshotSchema,
} from "@vem/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ApiResponse } from "./flow-test-helpers";

import { AppConfigService } from "../config/app-config.service";
import {
  DrizzleEphemeralPlatformStackRepository,
  prepareEphemeralPlatformStack,
} from "../testbed/prepare-ephemeral-platform-stack.cli";
import { loginAndGetToken } from "./flow-test-helpers";

describe(
  "ephemeral platform stack acceptance setup",
  { concurrent: false },
  () => {
    let app: INestApplication;
    let appConfig: AppConfigService;
    let db: DrizzleDB;
    let api: ReturnType<typeof request>;
    const claimEnvironment = {
      MACHINE_PROVISIONING_PROFILE: "testbed",
    } as const;
    const previousEnvironment = Object.fromEntries(
      Object.keys(claimEnvironment).map((key) => [key, process.env[key]]),
    );

    beforeAll(async () => {
      Object.assign(process.env, claimEnvironment);
      const { AppModule } = await import("../app.module");
      const moduleRef = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();

      app = moduleRef.createNestApplication();
      app.setGlobalPrefix("api");
      await app.init();

      appConfig = app.get(AppConfigService);
      db = new DrizzleDB(appConfig.databaseUrl);
      await db.connect();
      const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
      api = request(httpServer);
    }, 120_000);

    afterAll(async () => {
      if (db) {
        await db.disconnect();
      }
      if (app) {
        await app.close();
      }
      for (const [key, value] of Object.entries(previousEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }, 120_000);

    it("concurrent identical claims replay the PostgreSQL winner without duplicating identity", async () => {
      const repository = new DrizzleEphemeralPlatformStackRepository(
        db.client,
        {
          machineClaimLookupHmacKey: appConfig.machineClaimLookupHmacKey,
          claimCodeTtlSeconds: appConfig.machineClaimCodeTtlSeconds,
        },
      );
      const prepared = await prepareEphemeralPlatformStack(repository, {
        runId: "issue-07-concurrent-claim",
        machineCodePrefix: "VEM-TESTBED-CLAIM",
        databaseUrl: appConfig.databaseUrl,
        apiBaseUrl: "http://127.0.0.1:3000/api",
        mqttUrl: appConfig.mqttUrl,
        allowMockPayment: true,
        runtimePaymentMockEnabled: appConfig.paymentMockEnabled,
        reset: true,
        now: new Date(),
      });
      const claimPayload = {
        claimCode: prepared.testbedMachine.claim.claimCode,
      };

      const responses = await Promise.all([
        api.post("/api/machines/claim").send(claimPayload),
        api.post("/api/machines/claim").send(claimPayload),
      ]);

      expect(responses.map((response) => response.status)).toEqual([201, 201]);
      const first = machineProvisioningProfileSchema.parse(
        (responses[0].body as ApiResponse<unknown>).data,
      );
      expect(responses[1].body.data).toEqual(first);

      const claimAudits = await db.client
        .select({ action: auditLogs.action, afterJson: auditLogs.afterJson })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.resourceId, first.machine.id),
            inArray(auditLogs.action, [
              "machines.claimCode.consume",
              "machines.claimCode.replay",
            ]),
          ),
        );
      expect(
        claimAudits
          .filter(
            ({ afterJson }) =>
              afterJson?.claimCodeId ===
              prepared.testbedMachine.claim.claimCodeId,
          )
          .map(({ action }) => action)
          .sort(),
      ).toEqual(["machines.claimCode.consume", "machines.claimCode.replay"]);
    });

    it("resets run data and exercises provisioning, planogram, stock, and payment paths", async () => {
      const repository = new DrizzleEphemeralPlatformStackRepository(
        db.client,
        {
          machineClaimLookupHmacKey: appConfig.machineClaimLookupHmacKey,
          claimCodeTtlSeconds: appConfig.machineClaimCodeTtlSeconds,
        },
      );
      const firstPreparedAt = new Date();
      const secondPreparedAt = new Date(firstPreparedAt.getTime() + 1_000);

      const first = await prepareEphemeralPlatformStack(repository, {
        runId: "issue-179-e2e",
        machineCodePrefix: "VEM-TESTBED-ACCEPT",
        databaseUrl: appConfig.databaseUrl,
        apiBaseUrl: "http://127.0.0.1:3000/api",
        mqttUrl: appConfig.mqttUrl,
        allowMockPayment: true,
        runtimePaymentMockEnabled: appConfig.paymentMockEnabled,
        reset: true,
        now: firstPreparedAt,
      });
      const second = await prepareEphemeralPlatformStack(repository, {
        runId: "issue-179-e2e",
        machineCodePrefix: "VEM-TESTBED-ACCEPT",
        databaseUrl: appConfig.databaseUrl,
        apiBaseUrl: "http://127.0.0.1:3000/api",
        mqttUrl: appConfig.mqttUrl,
        allowMockPayment: true,
        runtimePaymentMockEnabled: appConfig.paymentMockEnabled,
        reset: true,
        now: secondPreparedAt,
      });

      expect(second.testbedMachine.id).toBe(first.testbedMachine.id);
      expect(second.testbedMachine.created).toBe(false);
      expect(second.testbedMachine.claim.claimCodeId).not.toBe(
        first.testbedMachine.claim.claimCodeId,
      );
      expect(second.seededData.planogram).toEqual({
        planogramVersion: "TESTBED-ISSUE-179-E2E",
        status: "published",
        slotCount: 2,
      });
      expect(second.seededData.paymentReadiness).toEqual({
        ready: true,
        mockProviderStatus: "enabled",
        serviceRequiresPaymentMockEnabled: true,
        runtimePaymentMockEnabled: true,
        mockPaymentAcknowledged: true,
      });

      const retiredClaimResponse = await api.post("/api/machines/claim").send({
        claimCode: second.testbedMachine.claim.claimCode,
        maintenancePublicKey: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=",
      });
      expect(retiredClaimResponse.status).toBe(400);
      const claimResponse = await api.post("/api/machines/claim").send({
        claimCode: second.testbedMachine.claim.claimCode,
      });
      expect(claimResponse.status).toBe(201);
      const claimedEnvelope = claimResponse.body as ApiResponse<unknown>;
      const claimed = machineProvisioningProfileSchema.parse(
        claimedEnvelope.data,
      );
      expect(claimedEnvelope.code).toBe(0);
      expect(claimed.machine.code).toBe(second.testbedMachine.code);
      expect(claimed.hardwareSlotTopology).toEqual({
        identity: second.hardwareSlotTopology.identity,
        version: second.hardwareSlotTopology.version,
      });
      expect(claimed.credentials.mqttConnection.url).toBe(appConfig.mqttUrl);
      const claimAudits = await db.client
        .select({ action: auditLogs.action, afterJson: auditLogs.afterJson })
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.resourceId, claimed.machine.id),
            inArray(auditLogs.action, [
              "machines.claimCode.consume",
              "machines.claimCode.replay",
            ]),
          ),
        );
      expect(
        claimAudits
          .filter(
            ({ afterJson }) =>
              afterJson?.claimCodeId ===
              second.testbedMachine.claim.claimCodeId,
          )
          .map(({ action }) => action),
      ).toEqual(["machines.claimCode.consume"]);

      const tokenResponse = await api.post("/api/machine-auth/token").send({
        machineCode: second.testbedMachine.code,
        machineSecret: claimed.credentials.machineSecret,
      });
      expect(tokenResponse.status).toBe(201);
      const tokenBody = tokenResponse.body as ApiResponse<{
        accessToken: string;
      }>;
      expect(tokenBody.code).toBe(0);
      const auth = { Authorization: `Bearer ${tokenBody.data.accessToken}` };
      const refreshResponse = await api
        .get(`/api/machines/${second.testbedMachine.code}/provisioning-profile`)
        .set(auth);
      expect(refreshResponse.status).toBe(200);
      const refreshed = machineProvisioningProfileSnapshotSchema.parse(
        (refreshResponse.body as ApiResponse<unknown>).data,
      );
      expect(refreshed.metadata.profileRevision).toBeGreaterThan(
        claimed.metadata.profileRevision,
      );
      expect(refreshed).not.toHaveProperty("credentials");

      const adminToken = await loginAndGetToken(api, appConfig);
      const renamedMachine = `${second.testbedMachine.code} refreshed`;
      const updateResponse = await api
        .patch(`/api/machines/${second.testbedMachine.id}`)
        .set({ Authorization: `Bearer ${adminToken}` })
        .send({ name: renamedMachine });
      expect(updateResponse.status).toBe(200);

      const updatedRefreshResponse = await api
        .get(`/api/machines/${second.testbedMachine.code}/provisioning-profile`)
        .set(auth);
      expect(updatedRefreshResponse.status).toBe(200);
      const updatedProfile = machineProvisioningProfileSnapshotSchema.parse(
        (updatedRefreshResponse.body as ApiResponse<unknown>).data,
      );
      expect(updatedProfile.machine.name).toBe(renamedMachine);
      expect(updatedProfile.metadata.profileRevision).toBeGreaterThan(
        refreshed.metadata.profileRevision,
      );

      const publishedResponse = await api
        .get(
          `/api/machines/${second.testbedMachine.code}/planogram-versions/published`,
        )
        .set(auth);
      expect(publishedResponse.status).toBe(200);
      const published = publishedResponse.body as ApiResponse<{
        planogramVersion: string;
        status: string;
        slots: Array<{
          slotId: string;
          slotCode: string;
          inventoryId: string;
          sku: string;
        }>;
      }>;
      expect(published.data.planogramVersion).toBe(
        second.seededData.planogram.planogramVersion,
      );
      expect(published.data.status).toBe("published");
      expect(published.data.slots.map((slot) => slot.slotCode)).toEqual([
        "A1",
        "A2",
      ]);
      expect(published.data.slots.map((slot) => slot.sku)).toEqual(
        second.seededData.products.map((product) => product.sku),
      );

      const ackResponse = await api
        .post(
          `/api/machines/${second.testbedMachine.code}/planogram-versions/${second.seededData.planogram.planogramVersion}/ack`,
        )
        .set(auth);
      expect(ackResponse.status).toBe(201);
      const acked = ackResponse.body as ApiResponse<{ status: string }>;
      expect(acked.data.status).toBe("active");

      const stockResponse = await api
        .get(`/api/machines/${second.testbedMachine.code}/stock-snapshot`)
        .set(auth);
      expect(stockResponse.status).toBe(200);
      const stock = stockResponse.body as ApiResponse<{
        planogramVersion: string;
        slots: Array<{
          slotCode: string;
          inventoryId: string;
          onHandQty: number;
          availableQty: number;
          slotSalesState: string;
        }>;
      }>;
      expect(stock.data.planogramVersion).toBe(
        second.seededData.planogram.planogramVersion,
      );
      expect(
        stock.data.slots.map((slot) => ({
          slotCode: slot.slotCode,
          onHandQty: slot.onHandQty,
          availableQty: slot.availableQty,
          slotSalesState: slot.slotSalesState,
        })),
      ).toEqual([
        {
          slotCode: "A1",
          onHandQty: 3,
          availableQty: 3,
          slotSalesState: "sale_ready",
        },
        {
          slotCode: "A2",
          onHandQty: 3,
          availableQty: 3,
          slotSalesState: "sale_ready",
        },
      ]);

      const paymentOptionsResponse = await api
        .get("/api/machine-orders/payment-options")
        .set(auth);
      expect(paymentOptionsResponse.status).toBe(200);
      const paymentOptions = paymentOptionsResponse.body as ApiResponse<{
        options: Array<{ providerCode: string; method: string }>;
      }>;
      expect(paymentOptions.data.options).toContainEqual(
        expect.objectContaining({ providerCode: "mock", method: "mock" }),
      );

      const saleSlot = published.data.slots[0];
      expect(saleSlot).toBeDefined();
      if (!saleSlot) {
        throw new Error("Generated planogram did not include saleable slots");
      }
      const createOrderResponse = await api
        .post("/api/machine-orders")
        .set(auth)
        .send({
          machineCode: second.testbedMachine.code,
          items: [
            {
              inventoryId: saleSlot.inventoryId,
              quantity: 1,
              planogramVersion: published.data.planogramVersion,
              slotId: saleSlot.slotId,
              slotCode: saleSlot.slotCode,
            },
          ],
          paymentMethod: "mock",
          paymentProviderCode: "mock",
        });
      expect(createOrderResponse.status).toBe(201);
      const createdOrder = createOrderResponse.body as ApiResponse<{
        orderNo: string;
        paymentNo: string;
        totalAmountCents: number;
        paymentProviderCode: string;
      }>;
      expect(createdOrder.code).toBe(0);
      expect(createdOrder.data.paymentNo).toBeTruthy();
      expect(createdOrder.data.paymentProviderCode).toBe("mock");
      expect(createdOrder.data.totalAmountCents).toBe(
        second.seededData.products[0].priceCents,
      );

      const mockSucceedResponse = await api
        .post(
          `/api/machine-orders/${createdOrder.data.orderNo}/mock-payment/succeed`,
        )
        .set(auth);
      expect(mockSucceedResponse.status).toBe(201);
      const mockSucceeded = mockSucceedResponse.body as ApiResponse<{
        status: string;
      }>;
      expect(mockSucceeded.data.status).toBe("succeeded");
    }, 60_000);
  },
);
