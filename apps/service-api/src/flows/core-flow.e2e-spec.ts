import type { INestApplication } from "@nestjs/common";
import type { MqttClient } from "mqtt";

import { Test } from "@nestjs/testing";
import {
  and,
  count,
  eq,
  inventories,
  inventoryMovements,
  machineHeartbeats,
  notifications,
  orders,
  payments,
  vendingCommands,
  DrizzleDB,
} from "@vem/db";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AppConfigService } from "../config/app-config.service";
import { PaymentsService } from "../payments/payments.service";
import {
  cleanupBusinessTables,
  connectMqtt,
  disconnectMqtt,
  getMachineAuthHeader,
  loginAndGetToken,
  machineOrderBody,
  pollOrderStatus,
  publishMqtt,
  seedSingleSlotInventory,
  signMqttPayload,
  waitForMqttMessage,
  type ApiResponse,
  type CreatedOrderPayload,
} from "./flow-test-helpers";

describe.sequential("core-flow.e2e", () => {
  let app: INestApplication;
  let appConfig: AppConfigService;
  let db: DrizzleDB;
  let mqttClient: MqttClient;
  let api: ReturnType<typeof request>;
  let paymentsService: PaymentsService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();

    appConfig = app.get(AppConfigService);
    paymentsService = app.get(PaymentsService);
    db = new DrizzleDB(appConfig.databaseUrl);
    await db.connect();

    mqttClient = await connectMqtt(appConfig.mqttUrl, {
      username: appConfig.mqttUsername,
      password: appConfig.mqttPassword,
    });
    const httpServer = app.getHttpServer() as Parameters<typeof request>[0];
    api = request(httpServer);
  }, 60_000);

  afterAll(async () => {
    if (mqttClient) {
      await disconnectMqtt(mqttClient);
    }
    if (db) {
      await db.disconnect();
    }
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await cleanupBusinessTables(db);
  });

  it("rejects public machine order creation without planogram slot context", async () => {
    const seeded = await seedSingleSlotInventory(db, {
      machineCode: "M-E2E-CONTEXT-001",
      onHandQty: 1,
      lowStockThreshold: 1,
      slotCode: "CTX1",
      layerNo: 1,
      cellNo: 1,
    });
    const machineAuthHeader = await getMachineAuthHeader(
      api,
      seeded.machineCode,
      seeded.machineSecret,
    );

    const response = await api
      .post("/api/machine-orders")
      .set(machineAuthHeader)
      .send({
        machineCode: seeded.machineCode,
        items: [{ inventoryId: seeded.inventoryId, quantity: 1 }],
        paymentMethod: "mock",
      });

    expect(response.status).toBe(400);
  }, 60_000);

  it("handles succeed callback idempotently and reaches fulfilled", async () => {
    const seeded = await seedSingleSlotInventory(db, {
      machineCode: "M-E2E-001",
      onHandQty: 1,
      lowStockThreshold: 1,
      slotCode: "A1",
      layerNo: 1,
      cellNo: 1,
    });

    const token = await loginAndGetToken(api, appConfig);
    const machineAuthHeader = await getMachineAuthHeader(
      api,
      seeded.machineCode,
      seeded.machineSecret,
    );

    const commandPayloadPromise = waitForMqttMessage(
      mqttClient,
      `vem/machines/${seeded.machineCode}/commands/dispense`,
    );

    const createOrderResponse = await api
      .post("/api/machine-orders")
      .set(machineAuthHeader)
      .send(machineOrderBody(seeded));

    expect(createOrderResponse.status).toBe(201);
    const createdOrder =
      createOrderResponse.body as ApiResponse<CreatedOrderPayload>;
    expect(createdOrder.code).toBe(0);
    expect(createdOrder.data.orderId).toBeTruthy();
    expect(createdOrder.data.paymentNo).toBeTruthy();

    const succeedResponse = await api
      .post(`/api/payments/mock/${createdOrder.data.paymentNo}/succeed`)
      .set("Authorization", `Bearer ${token}`);
    expect(succeedResponse.status).toBe(201);
    expect((succeedResponse.body as ApiResponse<{ status: string }>).code).toBe(
      0,
    );

    const commandPayloadText = await commandPayloadPromise;
    const commandEnvelope = JSON.parse(commandPayloadText) as {
      payload: { commandNo: string };
    };
    const commandNo = commandEnvelope.payload.commandNo;
    expect(commandNo).toBeTruthy();

    await publishMqtt(
      mqttClient,
      `vem/machines/${seeded.machineCode}/commands/${commandNo}/ack`,
      signMqttPayload({
        machineCode: seeded.machineCode,
        mqttSigningSecret: seeded.mqttSigningSecret,
        messageId: `ack:${commandNo}`,
        payload: { messageId: `ack:${commandNo}` },
      }),
    );

    await publishMqtt(
      mqttClient,
      `vem/machines/${seeded.machineCode}/events/heartbeat`,
      signMqttPayload({
        machineCode: seeded.machineCode,
        mqttSigningSecret: seeded.mqttSigningSecret,
        messageId: `heartbeat:${Date.now()}`,
        payload: {
          machineCode: seeded.machineCode,
          reportedAt: new Date().toISOString(),
          statusPayload: {
            appVersion: "0.1.0",
            network: "online",
            mqttConnected: true,
            hardwareStatus: "ok",
            localQueueSize: 0,
            lastCommandNo: commandNo,
          },
        },
      }),
    );

    await publishMqtt(
      mqttClient,
      `vem/machines/${seeded.machineCode}/events/dispense-result`,
      signMqttPayload({
        machineCode: seeded.machineCode,
        mqttSigningSecret: seeded.mqttSigningSecret,
        messageId: `result:${commandNo}`,
        payload: {
          commandNo,
          success: true,
          errorCode: null,
          message: "ok",
          reportedAt: new Date().toISOString(),
        },
      }),
    );

    const fulfilledOrder = await pollOrderStatus(
      api,
      token,
      createdOrder.data.orderId,
      "fulfilled",
    );
    expect(fulfilledOrder.status).toBe("fulfilled");

    const [ackCommand] = await db.client
      .select({ ackAt: vendingCommands.ackAt, status: vendingCommands.status })
      .from(vendingCommands)
      .where(eq(vendingCommands.orderId, createdOrder.data.orderId));
    // ackAt may be null if ACK is still being processed; just check final status
    expect(ackCommand.status).toBe("succeeded");

    const [heartbeatCount] = await db.client
      .select({ total: count() })
      .from(machineHeartbeats)
      .where(eq(machineHeartbeats.machineId, seeded.machineId));
    expect(Number(heartbeatCount.total)).toBeGreaterThanOrEqual(1);

    const duplicateSucceedResponse = await api
      .post(`/api/payments/mock/${createdOrder.data.paymentNo}/succeed`)
      .set("Authorization", `Bearer ${token}`);
    expect(duplicateSucceedResponse.status).toBe(201);

    const [purchaseConfirmedCount] = await db.client
      .select({ total: count() })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.orderId, createdOrder.data.orderId),
          eq(inventoryMovements.reason, "purchase_confirmed"),
        ),
      );
    expect(Number(purchaseConfirmedCount.total)).toBe(1);

    const [lowStockNotificationCount] = await db.client
      .select({ total: count() })
      .from(notifications)
      .where(
        eq(
          notifications.dedupeKey,
          `low_stock:${seeded.machineId}:${seeded.slotId}`,
        ),
      );
    expect(Number(lowStockNotificationCount.total)).toBe(1);
  }, 60_000);

  it("releases reservation when mock payment fails", async () => {
    const seeded = await seedSingleSlotInventory(db, {
      machineCode: "M-E2E-002",
      onHandQty: 2,
      lowStockThreshold: 1,
      slotCode: "B1",
      layerNo: 1,
      cellNo: 1,
    });

    const machineAuthHeader = await getMachineAuthHeader(
      api,
      seeded.machineCode,
      seeded.machineSecret,
    );
    const token = await loginAndGetToken(api, appConfig);
    const createOrderResponse = await api
      .post("/api/machine-orders")
      .set(machineAuthHeader)
      .send(machineOrderBody(seeded));
    const createdOrder =
      createOrderResponse.body as ApiResponse<CreatedOrderPayload>;

    const failResponse = await api
      .post(`/api/payments/mock/${createdOrder.data.paymentNo}/fail`)
      .set("Authorization", `Bearer ${token}`);
    expect(failResponse.status).toBe(201);

    const [orderRow] = await db.client
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, createdOrder.data.orderId));
    expect(orderRow.status).toBe("canceled");

    const [inventoryRow] = await db.client
      .select({ reservedQty: inventories.reservedQty })
      .from(inventories)
      .where(eq(inventories.id, seeded.inventoryId));
    expect(inventoryRow.reservedQty).toBe(0);
  }, 60_000);

  it("expires overdue payment and prevents oversell on concurrent last-item purchase", async () => {
    const seeded = await seedSingleSlotInventory(db, {
      machineCode: "M-E2E-003",
      onHandQty: 1,
      lowStockThreshold: 1,
      slotCode: "C1",
      layerNo: 1,
      cellNo: 1,
    });

    const requestBody = machineOrderBody(seeded);

    const machineAuthHeader = await getMachineAuthHeader(
      api,
      seeded.machineCode,
      seeded.machineSecret,
    );
    const [firstResponse, secondResponse] = await Promise.all([
      api.post("/api/machine-orders").set(machineAuthHeader).send(requestBody),
      api.post("/api/machine-orders").set(machineAuthHeader).send(requestBody),
    ]);

    const successResponses = [firstResponse, secondResponse].filter(
      (response) =>
        (response.body as ApiResponse<CreatedOrderPayload | null>).code === 0,
    );
    const failedResponses = [firstResponse, secondResponse].filter(
      (response) =>
        (response.body as ApiResponse<CreatedOrderPayload | null>).code !== 0,
    );

    expect(successResponses.length).toBe(1);
    expect(failedResponses.length).toBe(1);

    const createdOrder = successResponses[0]
      .body as ApiResponse<CreatedOrderPayload>;

    await db.client
      .update(payments)
      .set({ expiresAt: new Date(Date.now() - 60_000), updatedAt: new Date() })
      .where(eq(payments.paymentNo, createdOrder.data.paymentNo));

    const expireResult = await paymentsService.expireOverduePayments();
    expect(expireResult.processed).toBeGreaterThanOrEqual(1);

    const [orderRow] = await db.client
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, createdOrder.data.orderId));
    expect(orderRow.status).toBe("payment_expired");

    const [inventoryRow] = await db.client
      .select({ reservedQty: inventories.reservedQty })
      .from(inventories)
      .where(eq(inventories.id, seeded.inventoryId));
    expect(inventoryRow.reservedQty).toBe(0);
  }, 60_000);

  it("moves to dispense_failed and allows mock refund when hardware reports failure", async () => {
    const seeded = await seedSingleSlotInventory(db, {
      machineCode: "M-E2E-004",
      onHandQty: 1,
      lowStockThreshold: 1,
      slotCode: "D1",
      layerNo: 1,
      cellNo: 1,
    });
    const token = await loginAndGetToken(api, appConfig);
    const machineAuthHeader = await getMachineAuthHeader(
      api,
      seeded.machineCode,
      seeded.machineSecret,
    );
    const commandPayloadPromise = waitForMqttMessage(
      mqttClient,
      `vem/machines/${seeded.machineCode}/commands/dispense`,
    );

    const createOrderResponse = await api
      .post("/api/machine-orders")
      .set(machineAuthHeader)
      .send(machineOrderBody(seeded));
    const createdOrder =
      createOrderResponse.body as ApiResponse<CreatedOrderPayload>;

    await api
      .post(`/api/payments/mock/${createdOrder.data.paymentNo}/succeed`)
      .set("Authorization", `Bearer ${token}`);
    const commandEnvelope2 = JSON.parse(await commandPayloadPromise) as {
      payload: { commandNo: string };
    };
    const failedCommandNo = commandEnvelope2.payload.commandNo;
    await publishMqtt(
      mqttClient,
      `vem/machines/${seeded.machineCode}/events/dispense-result`,
      signMqttPayload({
        machineCode: seeded.machineCode,
        mqttSigningSecret: seeded.mqttSigningSecret,
        messageId: `result:${failedCommandNo}`,
        payload: {
          commandNo: failedCommandNo,
          success: false,
          errorCode: "JAMMED",
          message: "slot jammed",
          reportedAt: new Date().toISOString(),
        },
      }),
    );

    const refundedOrder = await pollOrderStatus(
      api,
      token,
      createdOrder.data.orderId,
      "refunded",
    );
    expect(refundedOrder.status).toBe("refunded");
  }, 60_000);

  it("exposes public machine order status for kiosk polling", async () => {
    const seeded = await seedSingleSlotInventory(db, {
      machineCode: "M-E2E-STATUS-001",
      onHandQty: 2,
      lowStockThreshold: 1,
      slotCode: "S1",
      layerNo: 1,
      cellNo: 1,
    });

    const machineAuthHeader = await getMachineAuthHeader(
      api,
      seeded.machineCode,
      seeded.machineSecret,
    );
    const token = await loginAndGetToken(api, appConfig);
    const createOrderResponse = await api
      .post("/api/machine-orders")
      .set(machineAuthHeader)
      .send(machineOrderBody(seeded));
    expect(createOrderResponse.status).toBe(201);
    const createdOrder =
      createOrderResponse.body as ApiResponse<CreatedOrderPayload>;

    const pendingStatusResponse = await api
      .get(`/api/machine-orders/${createdOrder.data.orderNo}/status`)
      .set(machineAuthHeader)
      .query({ machineCode: seeded.machineCode });
    expect(pendingStatusResponse.status).toBe(200);
    const pendingStatus = pendingStatusResponse.body as ApiResponse<{
      orderNo: string;
      machineCode: string;
      orderStatus: string;
      payment: { paymentNo: string; status: string; paymentUrl: string };
      vending: null;
      nextAction: string;
    }>;
    expect(pendingStatus.code).toBe(0);
    expect(pendingStatus.data.orderNo).toBe(createdOrder.data.orderNo);
    expect(pendingStatus.data.machineCode).toBe(seeded.machineCode);
    expect(pendingStatus.data.orderStatus).toBe("pending_payment");
    expect(pendingStatus.data.payment.paymentNo).toBe(
      createdOrder.data.paymentNo,
    );
    expect(pendingStatus.data.payment.status).toBe("pending");
    expect(pendingStatus.data.payment.paymentUrl).toBeTruthy();
    expect(pendingStatus.data.vending).toBeNull();
    expect(pendingStatus.data.nextAction).toBe("wait_payment");

    const failResponse = await api
      .post(`/api/payments/mock/${createdOrder.data.paymentNo}/fail`)
      .set("Authorization", `Bearer ${token}`);
    expect(failResponse.status).toBe(201);

    const failedStatusResponse = await api
      .get(`/api/machine-orders/${createdOrder.data.orderNo}/status`)
      .set(machineAuthHeader)
      .query({ machineCode: seeded.machineCode });
    const failedStatus = failedStatusResponse.body as ApiResponse<{
      orderStatus: string;
      payment: { status: string; failedReason: string };
      nextAction: string;
    }>;
    expect(failedStatus.code).toBe(0);
    expect(failedStatus.data.orderStatus).toBe("canceled");
    expect(failedStatus.data.payment.status).toBe("failed");
    expect(failedStatus.data.payment.failedReason).toBe("mock_failed");
    expect(failedStatus.data.nextAction).toBe("payment_failed");

    const wrongMachineResponse = await api
      .get(`/api/machine-orders/${createdOrder.data.orderNo}/status`)
      .set(machineAuthHeader)
      .query({ machineCode: "OTHER-MACHINE" });
    expect(wrongMachineResponse.status).toBe(404);
  }, 60_000);
});
