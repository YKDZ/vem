import type { INestApplication } from "@nestjs/common";

import { Test } from "@nestjs/testing";
import { DrizzleDB } from "@vem/db";
import {
  adminRoleResponseSchema,
  adminUserResponseSchema,
  permissionCodeSchema,
} from "@vem/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AppConfigService } from "../config/app-config.service";
import { MqttService } from "../mqtt/mqtt.service";
import { loginAndGetToken, type ApiResponse } from "./flow-test-helpers";

describe("admin-access-management-contract.e2e", { concurrent: false }, () => {
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

  it("rejects high-risk identity writes for an insufficient-permission admin", async () => {
    const unique = Date.now().toString(36);
    const adminToken = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${adminToken}` };

    const roleResponse = await api
      .post("/api/roles")
      .set(auth)
      .send({
        code: `limited_identity_${unique}`,
        name: `Limited Identity ${unique}`,
        permissionCodes: [permissionCodeSchema.parse("products.read")],
      });
    expect(roleResponse.status).toBe(201);
    const role = adminRoleResponseSchema.parse(
      (roleResponse.body as ApiResponse<unknown>).data,
    );

    const password = "LimitedPassword123!";
    const userResponse = await api
      .post("/api/admin-users")
      .set(auth)
      .send({
        username: `limited-${unique}`,
        password,
        displayName: `Limited ${unique}`,
        roleIds: [role.id],
      });
    expect(userResponse.status).toBe(201);
    const user = adminUserResponseSchema.parse(
      (userResponse.body as ApiResponse<unknown>).data,
    );
    expect(user.roles).toEqual([role.id]);

    const limitedLoginResponse = await api.post("/api/auth/login").send({
      username: `limited-${unique}`,
      password,
    });
    expect(limitedLoginResponse.status).toBe(200);
    const limitedToken = (
      limitedLoginResponse.body as ApiResponse<{ accessToken: string }>
    ).data.accessToken;

    const forbiddenResponse = await api
      .post("/api/admin-users")
      .set("Authorization", `Bearer ${limitedToken}`)
      .send({
        username: `blocked-${unique}`,
        password: "BlockedPassword123!",
        displayName: "Blocked Identity Write",
      });

    expect(forbiddenResponse.status).toBe(403);
  });
});
