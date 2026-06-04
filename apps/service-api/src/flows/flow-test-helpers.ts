import {
  DrizzleDB,
  inventories,
  machinePlanogramSlots,
  machinePlanogramVersions,
  machineSlots,
  machines,
  productVariants,
  products,
  sql,
} from "@vem/db";
import { mqttSigningInput } from "@vem/shared";
import mqtt, { type MqttClient } from "mqtt";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { expect } from "vitest";

import { AppConfigService } from "../config/app-config.service";
import {
  encryptCredentialSecret,
  generateMachineSecret,
  hashMachineSecret,
  hmacSha256Base64Url,
} from "../machine-auth/machine-credentials.util";

export type ApiResponse<T> = {
  code: number;
  message: string;
  data: T;
};

export type CreatedOrderPayload = {
  orderId: string;
  orderNo: string;
  paymentNo: string;
  paymentUrl: string;
  expiresAt: string;
  totalAmountCents: number;
};

export type SeededSingleSlotInventory = Awaited<
  ReturnType<typeof seedSingleSlotInventory>
>;

export function machineOrderBody(
  seeded: SeededSingleSlotInventory,
  paymentMethod: "mock" | "qr_code" | "payment_code" = "mock",
): {
  machineCode: string;
  items: Array<{
    inventoryId: string;
    quantity: number;
    planogramVersion: string;
    slotId: string;
    slotCode: string;
  }>;
  paymentMethod: "mock" | "qr_code" | "payment_code";
} {
  return {
    machineCode: seeded.machineCode,
    items: [
      {
        inventoryId: seeded.inventoryId,
        quantity: 1,
        planogramVersion: seeded.planogramVersion,
        slotId: seeded.slotId,
        slotCode: seeded.slotCode,
      },
    ],
    paymentMethod,
  };
}

export async function connectMqtt(
  url: string,
  opts?: { username?: string; password?: string },
): Promise<MqttClient> {
  const client = mqtt.connect(url, {
    clientId: `vem-e2e-${Date.now()}`,
    username: opts?.username,
    password: opts?.password,
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("MQTT connect timeout"));
    }, 10_000);
    client.once("connect", () => {
      clearTimeout(timeout);
      resolve();
    });
    client.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  return client;
}

export async function disconnectMqtt(client: MqttClient): Promise<void> {
  await new Promise<void>((resolve) =>
    client.end(true, {}, () => {
      resolve();
    }),
  );
}

export async function publishMqtt(
  client: MqttClient,
  topic: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function waitForMqttMessage(
  client: MqttClient,
  topic: string,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      client.removeListener("message", onMessage);
      reject(new Error(`MQTT message timeout: ${topic}`));
    }, 15_000);
    const onMessage = (messageTopic: string, payload: Buffer) => {
      if (messageTopic !== topic) return;
      clearTimeout(timeout);
      client.removeListener("message", onMessage);
      resolve(payload.toString("utf8"));
    };
    client.subscribe(topic, { qos: 1 }, (error) => {
      if (error) {
        clearTimeout(timeout);
        reject(error);
        return;
      }
      client.on("message", onMessage);
    });
  });
}

export async function loginAndGetToken(
  api: ReturnType<typeof request>,
  config: AppConfigService,
): Promise<string> {
  const response = await api.post("/api/auth/login").send({
    username: config.bootstrapAdminUsername,
    password: config.bootstrapAdminPassword,
  });
  const body = response.body as unknown as ApiResponse<{
    accessToken: string;
    refreshToken: string;
  }>;
  expect(body.code).toBe(0);
  return body.data.accessToken;
}

export async function pollOrderStatus(
  api: ReturnType<typeof request>,
  token: string,
  orderId: string,
  expectedStatus: string,
): Promise<{ status: string }> {
  const attempts = 30;

  const poll = async (index: number): Promise<{ status: string }> => {
    const response = await api
      .get(`/api/orders/${orderId}`)
      .set("Authorization", `Bearer ${token}`);
    const body = response.body as unknown as ApiResponse<{
      order: { status: string };
    }>;
    if (body.code === 0 && body.data.order.status === expectedStatus) {
      return { status: body.data.order.status };
    }
    if (index >= attempts - 1) {
      throw new Error(
        `Order ${orderId} did not reach status ${expectedStatus} (current: ${body.data?.order?.status ?? "unknown"})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    return await poll(index + 1);
  };

  return await poll(0);
}

export async function cleanupBusinessTables(db: DrizzleDB): Promise<void> {
  await db.client.execute(sql`
    TRUNCATE TABLE
      notification_deliveries,
      notifications,
      machine_heartbeats,
      machine_events,
      machine_commands,
      vending_commands,
      refunds,
      payment_events,
      payments,
      order_items,
      order_status_events,
      inventory_reservations,
      inventory_movements,
      machine_raw_stock_movements,
      orders,
      inventories,
      machine_planogram_slots,
      machine_planogram_versions,
      machine_slots,
      machines,
      product_variants,
      products
    RESTART IDENTITY CASCADE
  `);
}

export async function seedSingleSlotInventory(
  db: DrizzleDB,
  input: {
    machineCode: string;
    onHandQty: number;
    lowStockThreshold: number;
    slotCode: string;
    layerNo: number;
    cellNo: number;
    machineStatus?: "online" | "offline" | "maintenance" | "disabled";
  },
): Promise<{
  machineId: string;
  machineCode: string;
  slotId: string;
  slotCode: string;
  inventoryId: string;
  planogramVersion: string;
  machineSecret: string;
  mqttSigningSecret: string;
}> {
  const encKey =
    process.env.MACHINE_CREDENTIAL_ENCRYPTION_KEY ??
    "local-cred-enc-key-change-before-production!";

  const machineSecret = generateMachineSecret();
  const mqttSigningSecret = generateMachineSecret();
  const secretHash = hashMachineSecret(machineSecret);
  const mqttSigningSecretEncryptedJson = encryptCredentialSecret(
    mqttSigningSecret,
    encKey,
  );
  const now = new Date();

  const [product] = await db.client
    .insert(products)
    .values({
      name: `可乐-${input.machineCode}`,
      status: "active",
      sortOrder: 0,
    })
    .returning({ id: products.id });
  const [variant] = await db.client
    .insert(productVariants)
    .values({
      productId: product.id,
      sku: `SKU-${input.machineCode}`,
      size: "500ml",
      color: "black",
      priceCents: 599,
      status: "active",
    })
    .returning({ id: productVariants.id });
  const [machine] = await db.client
    .insert(machines)
    .values({
      code: input.machineCode,
      name: `机器-${input.machineCode}`,
      status: input.machineStatus ?? "online",
      secretHash,
      secretVersion: 1,
      secretRotatedAt: now,
      mqttSigningSecretEncryptedJson,
    })
    .returning({ id: machines.id, code: machines.code });
  const [slot] = await db.client
    .insert(machineSlots)
    .values({
      machineId: machine.id,
      layerNo: input.layerNo,
      cellNo: input.cellNo,
      slotCode: input.slotCode,
      capacity: 20,
      status: "enabled",
    })
    .returning({ id: machineSlots.id });
  const [inventory] = await db.client
    .insert(inventories)
    .values({
      machineId: machine.id,
      slotId: slot.id,
      variantId: variant.id,
      onHandQty: input.onHandQty,
      reservedQty: 0,
      lowStockThreshold: input.lowStockThreshold,
    })
    .returning({ id: inventories.id });
  const planogramVersion = `PLAN-${input.machineCode}`;
  const [version] = await db.client
    .insert(machinePlanogramVersions)
    .values({
      machineId: machine.id,
      planogramVersion,
      status: "active",
      acknowledgedAt: now,
      activeAt: now,
    })
    .returning({ id: machinePlanogramVersions.id });
  await db.client.insert(machinePlanogramSlots).values({
    machinePlanogramVersionId: version.id,
    slotId: slot.id,
    slotCode: input.slotCode,
    layerNo: input.layerNo,
    cellNo: input.cellNo,
    capacity: 20,
    parLevel: input.lowStockThreshold,
    inventoryId: inventory.id,
    variantId: variant.id,
    productId: product.id,
    productName: `可乐-${input.machineCode}`,
    productDescription: null,
    coverImageUrl: null,
    categoryId: null,
    categoryName: null,
    sku: `SKU-${input.machineCode}`,
    size: "500ml",
    color: "black",
    priceCents: 599,
    productSortOrder: 0,
    targetGender: null,
  });
  return {
    machineId: machine.id,
    machineCode: machine.code,
    slotId: slot.id,
    slotCode: input.slotCode,
    inventoryId: inventory.id,
    planogramVersion,
    machineSecret,
    mqttSigningSecret,
  };
}

export async function getMachineAuthHeader(
  api: ReturnType<typeof request>,
  machineCode: string,
  machineSecret?: string,
): Promise<Record<string, string>> {
  const secret =
    machineSecret ??
    process.env.MACHINE_SECRET ??
    "local-machine-shared-secret-change-before-production";
  const tokenResponse = await api.post("/api/machine-auth/token").send({
    machineCode,
    machineSecret: secret,
  });
  const accessToken = (
    tokenResponse.body as ApiResponse<{ accessToken: string }>
  ).data.accessToken;
  return { Authorization: `Bearer ${accessToken}` };
}

/**
 * Build a signed MQTT envelope for e2e tests using HMAC-SHA256.
 */
export function signMqttPayload(input: {
  machineCode: string;
  mqttSigningSecret: string;
  payload: Record<string, unknown>;
  messageId: string;
}): Record<string, unknown> {
  const issuedAt = new Date().toISOString();
  const nonce = randomUUID();
  const envelopeWithoutSignature = {
    messageId: input.messageId,
    machineCode: input.machineCode,
    issuedAt,
    nonce,
    payload: input.payload,
  };
  const signature = hmacSha256Base64Url(
    input.mqttSigningSecret,
    mqttSigningInput(envelopeWithoutSignature),
  );
  return { ...envelopeWithoutSignature, signature };
}
