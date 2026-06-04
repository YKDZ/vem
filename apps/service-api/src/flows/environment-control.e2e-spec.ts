import type { INestApplication } from "@nestjs/common";
import type { MqttClient } from "mqtt";

import { Test } from "@nestjs/testing";
import {
  count,
  eq,
  inventoryMovements,
  machineCommands,
  machineEvents,
  machineHeartbeats,
  orders,
  vendingCommands,
  DrizzleDB,
} from "@vem/db";
import { mqttSigningInput } from "@vem/shared";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AppConfigService } from "../config/app-config.service";
import { hmacSha256Base64Url } from "../machine-auth/machine-credentials.util";
import {
  cleanupBusinessTables,
  connectMqtt,
  disconnectMqtt,
  loginAndGetToken,
  publishMqtt,
  seedSingleSlotInventory,
  signMqttPayload,
  waitForMqttMessage,
  type ApiResponse,
} from "./flow-test-helpers";

type MachineCommandPayload = {
  id: string;
  machineId: string;
  commandNo: string;
  type: string;
  status: string;
};

type MachinePayload = {
  id: string;
  code: string;
  latestEnvironment: {
    temperatureCelsius: number | null;
    humidityRh: number | null;
    sensorStatus: string;
    airConditionerOn?: boolean;
    targetTemperatureCelsius?: number | null;
  } | null;
};

async function pollMachineCommandStatus(
  db: DrizzleDB,
  commandNo: string,
  expectedStatus: string,
): Promise<{ status: string; resultJson: unknown; lastError: string | null }> {
  const poll = async (
    index: number,
  ): Promise<{
    status: string;
    resultJson: unknown;
    lastError: string | null;
  }> => {
    const [command] = await db.client
      .select({
        status: machineCommands.status,
        resultJson: machineCommands.resultJson,
        lastError: machineCommands.lastError,
      })
      .from(machineCommands)
      .where(eq(machineCommands.commandNo, commandNo));
    if (command?.status === expectedStatus) {
      return command;
    }
    if (index >= 29) {
      throw new Error(
        `Machine command ${commandNo} did not reach ${expectedStatus} (current: ${command?.status ?? "missing"})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    return await poll(index + 1);
  };

  return await poll(0);
}

describe.sequential("environment-control.e2e", () => {
  let app: INestApplication;
  let appConfig: AppConfigService;
  let db: DrizzleDB;
  let mqttClient: MqttClient;
  let api: ReturnType<typeof request>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();

    appConfig = app.get(AppConfigService);
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

  it("drives environment control from Admin API through signed MQTT ACK/result and later heartbeat state", async () => {
    const seeded = await seedSingleSlotInventory(db, {
      machineCode: "M-ENV-E2E-001",
      onHandQty: 2,
      lowStockThreshold: 1,
      slotCode: "A1",
      layerNo: 1,
      cellNo: 1,
    });
    const token = await loginAndGetToken(api, appConfig);

    const commandPayloadPromise = waitForMqttMessage(
      mqttClient,
      `vem/machines/${seeded.machineCode}/commands/environment-control`,
    );

    const commandResponse = await api
      .post(`/api/machines/${seeded.machineId}/commands/environment-control`)
      .set("Authorization", `Bearer ${token}`)
      .send({ airConditionerOn: true, targetTemperatureCelsius: 23 });

    expect(commandResponse.status).toBe(201);
    const createdCommand =
      commandResponse.body as ApiResponse<MachineCommandPayload>;
    expect(createdCommand.code).toBe(0);
    expect(createdCommand.data.type).toBe("environment-control");
    expect(createdCommand.data.status).toBe("sent");

    const commandPayloadText = await commandPayloadPromise;
    const commandEnvelope = JSON.parse(commandPayloadText) as {
      messageId: string;
      machineCode: string;
      issuedAt: string;
      nonce: string;
      signature: string;
      payload: {
        commandNo: string;
        airConditionerOn: boolean;
        targetTemperatureCelsius: number;
        timeoutSeconds: number;
      };
    };
    expect(commandEnvelope.payload).toMatchObject({
      commandNo: createdCommand.data.commandNo,
      airConditionerOn: true,
      targetTemperatureCelsius: 23,
    });
    expect(commandEnvelope.signature).toBe(
      hmacSha256Base64Url(
        seeded.mqttSigningSecret,
        mqttSigningInput({
          messageId: commandEnvelope.messageId,
          machineCode: commandEnvelope.machineCode,
          issuedAt: commandEnvelope.issuedAt,
          nonce: commandEnvelope.nonce,
          payload: commandEnvelope.payload,
        }),
      ),
    );

    await publishMqtt(
      mqttClient,
      `vem/machines/${seeded.machineCode}/commands/${createdCommand.data.commandNo}/ack`,
      signMqttPayload({
        machineCode: seeded.machineCode,
        mqttSigningSecret: seeded.mqttSigningSecret,
        messageId: `ack:${createdCommand.data.commandNo}`,
        payload: { messageId: `ack:${createdCommand.data.commandNo}` },
      }),
    );
    await pollMachineCommandStatus(
      db,
      createdCommand.data.commandNo,
      "acknowledged",
    );

    await publishMqtt(
      mqttClient,
      `vem/machines/${seeded.machineCode}/events/environment-control-result`,
      signMqttPayload({
        machineCode: seeded.machineCode,
        mqttSigningSecret: seeded.mqttSigningSecret,
        messageId: `environment-control-result:${createdCommand.data.commandNo}`,
        payload: {
          commandNo: createdCommand.data.commandNo,
          success: true,
          reportedAt: new Date().toISOString(),
          airConditionerOn: true,
          targetTemperatureCelsius: 23,
        },
      }),
    );
    const succeededCommand = await pollMachineCommandStatus(
      db,
      createdCommand.data.commandNo,
      "succeeded",
    );
    expect(succeededCommand.resultJson).toMatchObject({
      commandNo: createdCommand.data.commandNo,
      success: true,
    });

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
            lastCommandNo: createdCommand.data.commandNo,
            environment: {
              temperatureCelsius: 22.8,
              humidityRh: 47,
              sampledAt: new Date().toISOString(),
              sensorStatus: "ok",
              airConditionerOn: true,
              targetTemperatureCelsius: 23,
            },
          },
        },
      }),
    );
    const [heartbeatCount] = await db.client
      .select({ total: count() })
      .from(machineHeartbeats)
      .where(eq(machineHeartbeats.machineId, seeded.machineId));
    expect(Number(heartbeatCount.total)).toBeGreaterThanOrEqual(1);

    const machineResponse = await api
      .get(`/api/machines/${seeded.machineId}`)
      .set("Authorization", `Bearer ${token}`);
    expect(machineResponse.status).toBe(200);
    const machine = machineResponse.body as ApiResponse<MachinePayload>;
    expect(machine.data.latestEnvironment).toMatchObject({
      temperatureCelsius: 22.8,
      humidityRh: 47,
      sensorStatus: "ok",
      airConditionerOn: true,
      targetTemperatureCelsius: 23,
    });

    const [environmentResultEventCount] = await db.client
      .select({ total: count() })
      .from(machineEvents)
      .where(eq(machineEvents.eventType, "environment_control_result"));
    expect(Number(environmentResultEventCount.total)).toBe(1);

    const sideEffectCounts = await Promise.all(
      [orders, vendingCommands, inventoryMovements].map(async (table) => {
        const [row] = await db.client.select({ total: count() }).from(table);
        return Number(row.total);
      }),
    );
    expect(sideEffectCounts).toEqual([0, 0, 0]);
  }, 60_000);
});
