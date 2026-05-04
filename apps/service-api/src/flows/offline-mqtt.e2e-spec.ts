import type { INestApplication } from "@nestjs/common";

import { Test } from "@nestjs/testing";
import {
  count,
  desc,
  eq,
  notifications,
  orders,
  vendingCommands,
  DrizzleDB,
} from "@vem/db";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AppConfigService } from "../config/app-config.service";
import { MqttService } from "../mqtt/mqtt.service";
import {
  cleanupBusinessTables,
  seedSingleSlotInventory,
  type ApiResponse,
  type CreatedOrderPayload,
} from "./flow-test-helpers";

describe.sequential("offline-mqtt.e2e", () => {
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

  it("keeps paid order for manual handling when MQTT publish fails", async () => {
    const seeded = await seedSingleSlotInventory(db, {
      machineCode: "M-E2E-OFFLINE-001",
      onHandQty: 1,
      lowStockThreshold: 1,
      slotCode: "OFF1",
      layerNo: 1,
      cellNo: 1,
    });

    const createOrderResponse = await api.post("/api/machine-orders").send({
      machineCode: seeded.machineCode,
      items: [{ inventoryId: seeded.inventoryId, quantity: 1 }],
      paymentMethod: "mock",
    });
    const createdOrder =
      createOrderResponse.body as ApiResponse<CreatedOrderPayload>;

    const succeedResponse = await api.post(
      `/api/payments/mock/${createdOrder.data.paymentNo}/succeed`,
    );
    expect(succeedResponse.status).toBe(201);

    const [orderRow] = await db.client
      .select({ status: orders.status })
      .from(orders)
      .where(eq(orders.id, createdOrder.data.orderId));
    expect(orderRow.status).toBe("paid");

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

    const [notificationRow] = await db.client
      .select({ total: count() })
      .from(notifications)
      .where(eq(notifications.resourceId, createdOrder.data.orderId));
    expect(Number(notificationRow.total)).toBe(1);
  }, 60_000);
});
