import type { INestApplication } from "@nestjs/common";

import { Test } from "@nestjs/testing";
import { DrizzleDB } from "@vem/db";
import {
  adminMachineResponseSchema,
  adminMachineSlotResponseSchema,
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

describe("admin-machine-contract.e2e", { concurrent: false }, () => {
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

  it("creates a machine and slot through the real Admin API contract", async () => {
    const unique = Date.now().toString(36);
    const token = await loginAndGetToken(api, appConfig);

    const machineResponse = await api
      .post("/api/machines")
      .set("Authorization", `Bearer ${token}`)
      .send({
        code: `M-CONTRACT-${unique}`,
        name: `Contract Machine ${unique}`,
        locationLabel: "1F lobby",
        geoLocation: {
          latitude: 31.2304,
          longitude: 121.4737,
          timezone: "Asia/Shanghai",
        },
      });

    expect(machineResponse.status).toBe(201);
    const machineBody = machineResponse.body as ApiResponse<unknown>;
    expect(machineBody.code).toBe(0);
    expect(machineBody.data).not.toHaveProperty("geoLatitude");
    expect(machineBody.data).not.toHaveProperty("deletedAt");
    const machine = adminMachineResponseSchema.parse(machineBody.data);

    const invalidSlotResponse = await api
      .post(`/api/machines/${machine.id}/slots`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        layerNo: 1,
        cellNo: 1,
        slotCode: "A1",
        capacity: 10,
        status: "enabled",
        inventoryShortcut: true,
      });
    expect(invalidSlotResponse.status).toBe(400);

    const slotResponse = await api
      .post(`/api/machines/${machine.id}/slots`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        layerNo: 1,
        cellNo: 1,
        slotCode: "A1",
        capacity: 10,
        status: "enabled",
      });

    expect(slotResponse.status).toBe(201);
    const slotBody = slotResponse.body as ApiResponse<unknown>;
    expect(slotBody.code).toBe(0);
    const slot = adminMachineSlotResponseSchema.parse(slotBody.data);
    expect(slot.machineId).toBe(machine.id);
    expect(slot.slotCode).toBe("A1");
  });
});
