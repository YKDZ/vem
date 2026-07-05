import type { INestApplication } from "@nestjs/common";

import { Test } from "@nestjs/testing";
import { DrizzleDB } from "@vem/db";
import {
  adminInventoryResponseSchema,
  adminMachineResponseSchema,
  adminMachineSlotResponseSchema,
  adminProductResponseSchema,
  adminProductVariantResponseSchema,
} from "@vem/shared";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AppConfigService } from "../config/app-config.service";
import { MqttService } from "../mqtt/mqtt.service";
import {
  cleanupBusinessTables,
  loginAndGetToken,
  type ApiResponse,
} from "./flow-test-helpers";

describe("admin-inventory-contract.e2e", { concurrent: false }, () => {
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

  it("creates, refills, and adjusts inventory through the real Admin API contract", async () => {
    const unique = Date.now().toString(36);
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };

    const productResponse = await api
      .post("/api/products")
      .set(auth)
      .send({
        name: `Inventory Contract Product ${unique}`,
        status: "active",
        sortOrder: 0,
      });
    expect(productResponse.status).toBe(201);
    const product = adminProductResponseSchema.parse(
      (productResponse.body as ApiResponse<unknown>).data,
    );

    const variantResponse = await api
      .post("/api/product-variants")
      .set(auth)
      .send({
        productId: product.id,
        sku: `INV-CONTRACT-${unique}`,
        priceCents: 399,
        status: "active",
      });
    expect(variantResponse.status).toBe(201);
    const variant = adminProductVariantResponseSchema.parse(
      (variantResponse.body as ApiResponse<unknown>).data,
    );

    const machineResponse = await api
      .post("/api/machines")
      .set(auth)
      .send({
        code: `M-INV-${unique}`,
        name: `Inventory Contract Machine ${unique}`,
      });
    expect(machineResponse.status).toBe(201);
    const machine = adminMachineResponseSchema.parse(
      (machineResponse.body as ApiResponse<unknown>).data,
    );

    const slotResponse = await api
      .post(`/api/machines/${machine.id}/slots`)
      .set(auth)
      .send({
        layerNo: 1,
        cellNo: 1,
        slotCode: "A1",
        capacity: 10,
      });
    expect(slotResponse.status).toBe(201);
    const slot = adminMachineSlotResponseSchema.parse(
      (slotResponse.body as ApiResponse<unknown>).data,
    );

    const invalidInventoryResponse = await api
      .post("/api/inventories")
      .set(auth)
      .send({
        machineId: machine.id,
        slotId: slot.id,
        variantId: variant.id,
        onHandQty: 10,
        unsupportedColumn: true,
      });
    expect(invalidInventoryResponse.status).toBe(400);

    const createInventoryResponse = await api
      .post("/api/inventories")
      .set(auth)
      .send({
        machineId: machine.id,
        slotId: slot.id,
        variantId: variant.id,
        onHandQty: 10,
        lowStockThreshold: 2,
        note: "initial binding",
      });
    expect(createInventoryResponse.status).toBe(201);
    const inventory = adminInventoryResponseSchema.parse(
      (createInventoryResponse.body as ApiResponse<unknown>).data,
    );
    expect(inventory.onHandQty).toBe(10);
    expect(inventory.reservedQty).toBe(0);

    const refillResponse = await api
      .post("/api/inventories/refill")
      .set(auth)
      .send({ inventoryId: inventory.id, quantity: 5 });
    expect(refillResponse.status).toBe(201);
    const refilled = adminInventoryResponseSchema.parse(
      (refillResponse.body as ApiResponse<unknown>).data,
    );
    expect(refilled.onHandQty).toBe(15);

    const adjustResponse = await api
      .post("/api/inventories/adjust")
      .set(auth)
      .send({
        inventoryId: inventory.id,
        deltaQty: -3,
        note: "counted shelf",
      });
    expect(adjustResponse.status).toBe(201);
    const adjusted = adminInventoryResponseSchema.parse(
      (adjustResponse.body as ApiResponse<unknown>).data,
    );
    expect(adjusted.onHandQty).toBe(12);
  }, 60_000);
});
