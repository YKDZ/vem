import {
  DrizzleDB,
  inventories,
  machineSlots,
  machines,
  productVariants,
  products,
  sql,
} from "@vem/db";
import mqtt, { type MqttClient } from "mqtt";
import request from "supertest";
import { expect } from "vitest";

import { AppConfigService } from "../config/app-config.service";

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

export async function connectMqtt(url: string): Promise<MqttClient> {
  const client = mqtt.connect(url, { clientId: `vem-e2e-${Date.now()}` });
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
      vending_commands,
      refunds,
      payment_events,
      payments,
      order_items,
      order_status_events,
      inventory_reservations,
      inventory_movements,
      orders,
      inventories,
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
  },
): Promise<{
  machineId: string;
  machineCode: string;
  slotId: string;
  inventoryId: string;
}> {
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
      status: "online",
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
  return {
    machineId: machine.id,
    machineCode: machine.code,
    slotId: slot.id,
    inventoryId: inventory.id,
  };
}
