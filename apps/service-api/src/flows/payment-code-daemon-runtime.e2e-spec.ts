import type { INestApplication } from "@nestjs/common";

import { Test } from "@nestjs/testing";
import {
  DrizzleDB,
  eq,
  inArray,
  orders,
  paymentCodeAttempts,
  payments,
} from "@vem/db";
import { execFile as execFileCallback } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cleanupBusinessTables,
  getMachineAuthHeader,
  machineOrderBody,
  seedSingleSlotInventory,
  type ApiResponse,
  type CreatedOrderPayload,
} from "./flow-test-helpers";

const execFile = promisify(execFileCallback);
const databaseUrl = process.env.VEM_TEST_POSTGRES_URL;
const postgresDescribe = databaseUrl ? describe : describe.skip;

function configureRuntimeEnvironment(database: string): void {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: database,
    SERVICE_HOST: "127.0.0.1",
    JWT_SECRET: "payment-code-runtime-jwt-secret-0000000000000001",
    JWT_REFRESH_SECRET: "payment-code-runtime-refresh-secret-0000000001",
    MACHINE_JWT_SECRET: "payment-code-runtime-machine-jwt-secret-0000001",
    MACHINE_CREDENTIAL_ENCRYPTION_KEY:
      "payment-code-runtime-machine-credential-key-0000001",
    MQTT_URL: "mqtt://127.0.0.1:9",
    MACHINE_MQTT_URL: "mqtt://127.0.0.1:9",
    MACHINE_PROVISIONING_PROFILE: "testbed",
    MAINTENANCE_RELAY_PEER_ID: "550e8400-e29b-41d4-a716-446655440010",
    MAINTENANCE_RELAY_ENDPOINT: "127.0.0.1:51820",
    MAINTENANCE_RELAY_PUBLIC_KEY:
      "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI=",
    MAINTENANCE_RELAY_TUNNEL_ADDRESS: "10.91.0.1",
    PAYMENT_MOCK_ENABLED: "true",
    PAYMENT_WEBHOOK_BASE_URL: "http://127.0.0.1:3000/api/payments/webhooks",
    MACHINE_API_BASE_URL: "http://127.0.0.1:3000/api",
    BOOTSTRAP_ADMIN_PASSWORD: "payment-code-runtime-admin-password-0001",
  });
}

postgresDescribe("payment-code daemon runtime", { concurrent: false }, () => {
  let app: INestApplication;
  let db: DrizzleDB;
  let serviceBaseUrl = "";

  beforeAll(async () => {
    configureRuntimeEnvironment(databaseUrl!);
    const [{ AppModule }, { MqttService }, { MockPaymentProvider }] =
      await Promise.all([
        import("../app.module"),
        import("../mqtt/mqtt.service"),
        import("../payments/mock-payment.provider"),
      ]);
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.listen(0, "127.0.0.1");

    const address = app.getHttpServer().address();
    if (!address || typeof address === "string") {
      throw new Error("Service API did not bind a TCP port");
    }
    serviceBaseUrl = `http://127.0.0.1:${address.port}/api`;
    db = new DrizzleDB(databaseUrl!);
    await db.connect();
    await cleanupBusinessTables(db);

    const mqttService = app.get(MqttService);
    mqttService.publish = async () => undefined;
    const mockProvider = app.get(MockPaymentProvider);
    const chargePaymentCode = mockProvider.chargePaymentCode.bind(mockProvider);
    mockProvider.chargePaymentCode = async (input) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return await chargePaymentCode(input);
    };
  }, 60_000);

  afterAll(async () => {
    if (db) await db.disconnect();
    if (app) await app.close();
  });

  it("drives real serial_text runtime frames through the HTTP orchestrator and persisted provider attempts", async () => {
    const suffix = Date.now().toString(36);
    const seeded = await seedSingleSlotInventory(db, {
      machineCode: `M-PTY-RUNTIME-${suffix}`,
      onHandQty: 6,
      lowStockThreshold: 1,
      slotCode: "PTY1",
      layerNo: 1,
      cellNo: 1,
    });
    const api = request(app.getHttpServer());
    const machineAuth = await getMachineAuthHeader(
      api,
      seeded.machineCode,
      seeded.machineSecret,
    );
    const createOrder = async (): Promise<CreatedOrderPayload> => {
      const response = await api
        .post("/api/machine-orders")
        .set(machineAuth)
        .send({
          ...machineOrderBody(seeded, "payment_code"),
          paymentProviderCode: "mock",
        });
      expect(response.status).toBe(201);
      return (response.body as ApiResponse<CreatedOrderPayload>).data;
    };
    const [orderB, orderC, orderD] = await Promise.all([
      createOrder(),
      createOrder(),
      createOrder(),
    ]);

    await execFile(
      "cargo",
      [
        "test",
        "-p",
        "vending-daemon",
        "--test",
        "payment_code_service_api_runtime",
        "--",
        "--nocapture",
      ],
      {
        cwd: resolve(process.cwd(), "../.."),
        env: {
          ...process.env,
          VEM_PAYMENT_CODE_RUNTIME_API_BASE_URL: serviceBaseUrl,
          VEM_PAYMENT_CODE_RUNTIME_MACHINE_CODE: seeded.machineCode,
          VEM_PAYMENT_CODE_RUNTIME_MACHINE_SECRET: seeded.machineSecret,
          VEM_PAYMENT_CODE_RUNTIME_ORDER_B: orderB.orderNo,
          VEM_PAYMENT_CODE_RUNTIME_ORDER_C: orderC.orderNo,
          VEM_PAYMENT_CODE_RUNTIME_ORDER_D: orderD.orderNo,
        },
        timeout: 120_000,
      },
    );

    const persisted = await db.client
      .select({
        orderNo: orders.orderNo,
        orderStatus: orders.status,
        paymentStatus: payments.status,
        attemptId: paymentCodeAttempts.id,
        attemptStatus: paymentCodeAttempts.status,
      })
      .from(orders)
      .innerJoin(payments, eq(payments.id, orders.paymentId))
      .leftJoin(
        paymentCodeAttempts,
        eq(paymentCodeAttempts.paymentId, payments.id),
      )
      .where(
        inArray(orders.orderNo, [
          orderB.orderNo,
          orderC.orderNo,
          orderD.orderNo,
        ]),
      );
    const byOrder = new Map(persisted.map((row) => [row.orderNo, row]));

    expect(byOrder.get(orderB.orderNo)).toMatchObject({
      orderStatus: "pending_payment",
      paymentStatus: "pending",
      attemptId: null,
    });
    for (const order of [orderC, orderD]) {
      expect(byOrder.get(order.orderNo)).toMatchObject({
        orderStatus: "paid",
        paymentStatus: "succeeded",
        attemptStatus: "succeeded",
      });
    }
    expect(
      persisted.filter((row) => row.orderNo === orderC.orderNo),
    ).toHaveLength(1);
    expect(
      persisted.filter((row) => row.orderNo === orderD.orderNo),
    ).toHaveLength(1);
  }, 180_000);
});
