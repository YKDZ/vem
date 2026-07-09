import type { INestApplication } from "@nestjs/common";

import { Test } from "@nestjs/testing";
import { DrizzleDB } from "@vem/db";
import {
  adminMachineResponseSchema,
  paymentChannelPolicyResponseSchema,
  paymentProviderConfigSchema,
  paymentProviderSchema,
  supportedPaymentChannelKeys,
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

describe("admin-payment-contract.e2e", { concurrent: false }, () => {
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

  it("updates payment provider config through the real Admin API contract", async () => {
    const unique = Date.now().toString(36);
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };

    const providersResponse = await api
      .get("/api/payments/providers")
      .set(auth);
    expect(providersResponse.status).toBe(200);
    const providers = (
      (providersResponse.body as ApiResponse<unknown>).data as unknown[]
    ).map((provider) => paymentProviderSchema.parse(provider));
    const alipayProvider = providers.find(
      (provider) => provider.code === "alipay",
    );
    if (!alipayProvider) {
      throw new Error("alipay payment provider seed missing");
    }

    const providerPatchResponse = await api
      .patch(`/api/payments/providers/${alipayProvider.id}`)
      .set(auth)
      .send({ name: `Alipay Contract ${unique}` });
    expect(providerPatchResponse.status).toBe(200);
    const patchedProvider = paymentProviderSchema.parse(
      (providerPatchResponse.body as ApiResponse<unknown>).data,
    );
    expect(patchedProvider.name).toBe(`Alipay Contract ${unique}`);

    const machineResponse = await api
      .post("/api/machines")
      .set(auth)
      .send({
        code: `M-PAY-${unique}`,
        name: `Payment Contract Machine ${unique}`,
      });
    expect(machineResponse.status).toBe(201);
    const machine = adminMachineResponseSchema.parse(
      (machineResponse.body as ApiResponse<unknown>).data,
    );

    const invalidConfigResponse = await api
      .post("/api/payments/provider-configs")
      .set(auth)
      .send({
        providerCode: "alipay",
        machineId: machine.id,
        status: "disabled",
        publicConfigJson: {
          gatewayUrl: "not-a-url",
        },
      });
    expect(invalidConfigResponse.status).toBe(400);

    const configResponse = await api
      .post("/api/payments/provider-configs")
      .set(auth)
      .send({
        providerCode: "alipay",
        machineId: machine.id,
        merchantNo: `mch-${unique}`,
        appId: `app-${unique}`,
        status: "disabled",
        publicConfigJson: {
          mode: "sandbox",
          gatewayUrl: "https://openapi-sandbox.dl.alipaydev.com/gateway.do",
          keyType: "PKCS8",
          qrExpiresMinutes: 10,
        },
      });
    expect(configResponse.status).toBe(201);
    const config = paymentProviderConfigSchema.parse(
      (configResponse.body as ApiResponse<unknown>).data,
    );
    expect(config.providerCode).toBe("alipay");
    expect(config.machineId).toBe(machine.id);
    expect(config.publicConfigJson).toMatchObject({ qrExpiresMinutes: 10 });

    const patchResponse = await api
      .patch(`/api/payments/provider-configs/${config.id}`)
      .set(auth)
      .send({
        publicConfigJson: {
          timeoutCompensationSeconds: 60,
        },
      });
    expect(patchResponse.status).toBe(200);
    const patchedConfig = paymentProviderConfigSchema.parse(
      (patchResponse.body as ApiResponse<unknown>).data,
    );
    expect(patchedConfig.publicConfigJson).toMatchObject({
      qrExpiresMinutes: 10,
      timeoutCompensationSeconds: 60,
    });
  }, 60_000);

  it("reads and updates global payment channel policy through the real Admin API contract", async () => {
    const token = await loginAndGetToken(api, appConfig);
    const auth = { Authorization: `Bearer ${token}` };

    const initialResponse = await api.get("/api/payments/channel-policy").set(auth);
    expect(initialResponse.status).toBe(200);
    const initialPolicy = paymentChannelPolicyResponseSchema.parse(
      (initialResponse.body as ApiResponse<unknown>).data,
    );
    expect(initialPolicy.channels.map((channel) => channel.channelKey)).toEqual(
      supportedPaymentChannelKeys,
    );
    expect(initialPolicy.defaultChannelKey).toBe("qr_code:alipay");

    const nextPolicy = {
      channels: [
        { channelKey: "payment_code:wechat_pay", enabled: true, rank: 1 },
        { channelKey: "qr_code:wechat_pay", enabled: true, rank: 2 },
        { channelKey: "payment_code:alipay", enabled: false, rank: 3 },
        { channelKey: "qr_code:alipay", enabled: true, rank: 4 },
      ],
      defaultChannelKey: "payment_code:wechat_pay",
    };

    const updateResponse = await api
      .put("/api/payments/channel-policy")
      .set(auth)
      .send(nextPolicy);
    expect(updateResponse.status).toBe(200);
    const updatedPolicy = paymentChannelPolicyResponseSchema.parse(
      (updateResponse.body as ApiResponse<unknown>).data,
    );
    expect(updatedPolicy).toMatchObject(nextPolicy);

    const invalidResponse = await api
      .put("/api/payments/channel-policy")
      .set(auth)
      .send({
        channels: [
          { channelKey: "qr_code:alipay", enabled: true, rank: 1 },
          { channelKey: "qr_code:alipay", enabled: true, rank: 2 },
          { channelKey: "qr_code:wechat_pay", enabled: true, rank: 3 },
          { channelKey: "payment_code:wechat_pay", enabled: true, rank: 4 },
        ],
        defaultChannelKey: "qr_code:alipay",
      });
    expect(invalidResponse.status).toBe(400);

    const readBackResponse = await api
      .get("/api/payments/channel-policy")
      .set(auth);
    expect(readBackResponse.status).toBe(200);
    expect(
      paymentChannelPolicyResponseSchema.parse(
        (readBackResponse.body as ApiResponse<unknown>).data,
      ),
    ).toMatchObject(nextPolicy);
  }, 60_000);
});
