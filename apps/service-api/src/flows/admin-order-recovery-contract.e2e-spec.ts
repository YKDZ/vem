import type { INestApplication } from "@nestjs/common";

import { Test } from "@nestjs/testing";
import { DrizzleDB, eq, orders, vendingCommands } from "@vem/db";
import { orderRecoveryActionResponseSchema } from "@vem/shared";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AppConfigService } from "../config/app-config.service";
import { MqttService } from "../mqtt/mqtt.service";
import {
  cleanupBusinessTables,
  getMachineAuthHeader,
  loginAndGetToken,
  machineOrderBody,
  seedSingleSlotInventory,
  type ApiResponse,
  type CreatedOrderPayload,
} from "./flow-test-helpers";

describe("admin-order-recovery-contract.e2e", { concurrent: false }, () => {
  let app: INestApplication;
  let appConfig: AppConfigService;
  let db: DrizzleDB;
  let api: ReturnType<typeof request>;

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

    appConfig = app.get(AppConfigService);
    db = new DrizzleDB(appConfig.databaseUrl);
    await db.connect();

    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    api = request(httpServer);
  }, 120_000);

  afterAll(async () => {
    if (db) await db.disconnect();
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanupBusinessTables(db);
  });

  it("validates the real order recovery action endpoint response contract", async () => {
    const unique = Date.now().toString(36);
    const token = await loginAndGetToken(api, appConfig);
    const seeded = await seedSingleSlotInventory(db, {
      machineCode: `M-ORDER-REC-${unique}`,
      onHandQty: 2,
      lowStockThreshold: 1,
      slotCode: "A1",
      layerNo: 1,
      cellNo: 1,
    });
    const machineAuthHeader = await getMachineAuthHeader(
      api,
      seeded.machineCode,
      seeded.machineSecret,
    );

    const createOrderResponse = await api
      .post("/api/machine-orders")
      .set(machineAuthHeader)
      .send(machineOrderBody(seeded));
    expect(createOrderResponse.status).toBe(201);
    const createdOrder = (
      createOrderResponse.body as ApiResponse<CreatedOrderPayload>
    ).data;

    const paidResponse = await api
      .post(`/api/payments/mock/${createdOrder.paymentNo}/succeed`)
      .set("Authorization", `Bearer ${token}`)
      .send({});
    expect(paidResponse.status).toBe(201);

    const [command] = await db.client
      .select({
        id: vendingCommands.id,
        commandNo: vendingCommands.commandNo,
      })
      .from(vendingCommands)
      .where(eq(vendingCommands.orderId, createdOrder.orderId));
    if (!command) throw new Error("Expected paid order to create a command");

    await db.client
      .update(vendingCommands)
      .set({
        status: "result_unknown",
        resultAt: new Date(),
        lastError: "contract harness forced physical outcome review",
      })
      .where(eq(vendingCommands.id, command.id));
    await db.client
      .update(orders)
      .set({
        status: "manual_handling",
        fulfillmentState: "manual_handling",
        updatedAt: new Date(),
      })
      .where(eq(orders.id, createdOrder.orderId));

    const invalidResponse = await api
      .post(`/api/orders/${createdOrder.orderId}/recovery-actions`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        action: "confirm_dispensed",
        note: "operator confirmed product was taken",
        directDatabasePatch: true,
      });
    expect(invalidResponse.status).toBe(400);

    const response = await api
      .post(`/api/orders/${createdOrder.orderId}/recovery-actions`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        action: "confirm_dispensed",
        note: "operator confirmed product was taken",
      });
    expect(response.status).toBe(201);
    const recoveryResponse = orderRecoveryActionResponseSchema.parse(
      (response.body as ApiResponse<unknown>).data,
    );

    expect(recoveryResponse).toEqual({
      action: "confirm_dispensed",
      recoveryActionId: expect.any(String),
      commandId: command.id,
      status: "succeeded",
    });
    expect(recoveryResponse).not.toHaveProperty("note");
    expect(recoveryResponse).not.toHaveProperty("requestedByAdminUserId");
  }, 60_000);
});
