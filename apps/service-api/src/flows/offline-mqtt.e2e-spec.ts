import type { INestApplication } from "@nestjs/common";

import { Test } from "@nestjs/testing";
import {
  count,
  desc,
  eq,
  inventories,
  notifications,
  orders,
  refunds,
  vendingCommands,
  DrizzleDB,
} from "@vem/db";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AppConfigService } from "../config/app-config.service";
import { MqttService } from "../mqtt/mqtt.service";
import { VendingService } from "../vending/vending.service";
import {
  cleanupBusinessTables,
  getMachineAuthHeader,
  loginAndGetToken,
  seedSingleSlotInventory,
  type ApiResponse,
  type CreatedOrderPayload,
} from "./flow-test-helpers";

describe.sequential("offline-mqtt.e2e", () => {
  let app: INestApplication;
  let appConfig: AppConfigService;
  let db: DrizzleDB;
  let api: ReturnType<typeof request>;
  let vendingService: VendingService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(MqttService)
      .useValue({
        bindVendingService: () => undefined,
        isConnected: () => false,
        publish: async () => {
          throw new Error("MQTT offline in e2e");
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();

    appConfig = app.get(AppConfigService);
    vendingService = app.get(VendingService);
    db = new DrizzleDB(appConfig.databaseUrl);
    await db.connect();
    api = request(app.getHttpServer() as Parameters<typeof request>[0]);
  }, 60_000);

  afterAll(async () => {
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

  it("restores inventory and refunds when MQTT publish fails before delivery", async () => {
    const seeded = await seedSingleSlotInventory(db, {
      machineCode: "M-E2E-OFFLINE-001",
      onHandQty: 1,
      lowStockThreshold: 1,
      slotCode: "OFF1",
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
      .send({
        machineCode: seeded.machineCode,
        items: [{ inventoryId: seeded.inventoryId, quantity: 1 }],
        paymentMethod: "mock",
      });
    const createdOrder =
      createOrderResponse.body as ApiResponse<CreatedOrderPayload>;

    const succeedResponse = await api
      .post(`/api/payments/mock/${createdOrder.data.paymentNo}/succeed`)
      .set("Authorization", `Bearer ${await loginAndGetToken(api, appConfig)}`);
    expect(succeedResponse.status).toBe(201);

    const [orderRow] = await db.client
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, createdOrder.data.orderId));
    expect(orderRow.status).toBe("refunded");

    const [commandRow] = await db.client
      .select({
        status: vendingCommands.status,
        lastError: vendingCommands.lastError,
      })
      .from(vendingCommands)
      .where(eq(vendingCommands.orderId, createdOrder.data.orderId))
      .orderBy(desc(vendingCommands.createdAt));
    expect(commandRow.status).toBe("failed");
    expect(commandRow.lastError).toContain("MQTT offline in e2e");

    const [refundRow] = await db.client
      .select({ total: count() })
      .from(refunds)
      .where(eq(refunds.orderId, createdOrder.data.orderId));
    expect(Number(refundRow.total)).toBe(1);

    const [inventoryRow] = await db.client
      .select({ onHandQty: inventories.onHandQty })
      .from(inventories)
      .where(eq(inventories.id, seeded.inventoryId));
    expect(inventoryRow.onHandQty).toBe(1); // restored to original

    const [notificationRow] = await db.client
      .select({ total: count() })
      .from(notifications)
      .where(eq(notifications.resourceId, createdOrder.data.orderId));
    expect(Number(notificationRow.total)).toBe(1);
  }, 60_000);

  it("marks sent vending command timeout as manual handling without auto refund", async () => {
    const seeded = await seedSingleSlotInventory(db, {
      machineCode: "M-E2E-TIMEOUT-001",
      onHandQty: 1,
      lowStockThreshold: 1,
      slotCode: "TO1",
      layerNo: 1,
      cellNo: 1,
    });

    const machineAuthHeader2 = await getMachineAuthHeader(
      api,
      seeded.machineCode,
      seeded.machineSecret,
    );

    const createOrderResponse = await api
      .post("/api/machine-orders")
      .set(machineAuthHeader2)
      .send({
        machineCode: seeded.machineCode,
        items: [{ inventoryId: seeded.inventoryId, quantity: 1 }],
        paymentMethod: "mock",
      });
    const createdOrder =
      createOrderResponse.body as ApiResponse<CreatedOrderPayload>;
    expect(createOrderResponse.status).toBe(201);

    // Directly set up "sent" command state without going through payment success flow.
    // Going through payment success would cause MQTT-offline → auto-refund, which
    // would corrupt this test scenario (timeout should NOT create a refund).
    // This simulates: MQTT publish succeeded, command was sent, hardware timed out.
    await db.client
      .update(orders)
      .set({ status: "dispensing", updatedAt: new Date() })
      .where(eq(orders.id, createdOrder.data.orderId));

    await db.client.insert(vendingCommands).values({
      commandNo: "CMD-TIMEOUT-E2E",
      orderId: createdOrder.data.orderId,
      machineId: seeded.machineId,
      slotId: seeded.slotId,
      payloadJson: {
        commandNo: "CMD-TIMEOUT-E2E",
        orderNo: createdOrder.data.orderNo,
        slot: { layerNo: 1, cellNo: 1, slotCode: "TO1" },
        quantity: 1,
        timeoutSeconds: 1,
      },
      status: "sent",
      sentAt: new Date(Date.now() - 180_000),
    });

    const result = await vendingService.markTimedOutCommands(new Date());
    expect(result.processed).toBe(1);

    const [orderRow] = await db.client
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, createdOrder.data.orderId));
    expect(orderRow.status).toBe("manual_handling");

    // no auto refund for timeout
    const [refundCount] = await db.client
      .select({ total: count() })
      .from(refunds)
      .where(eq(refunds.orderId, createdOrder.data.orderId));
    expect(Number(refundCount.total)).toBe(0);

    // second call should not process the same command again
    const result2 = await vendingService.markTimedOutCommands(new Date());
    expect(result2.processed).toBe(0);
  }, 60_000);
});
