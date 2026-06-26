import type { INestApplication } from "@nestjs/common";
import type { InventoryMovementReason } from "@vem/shared";
import type { MqttClient } from "mqtt";

import { Test } from "@nestjs/testing";
import {
  and,
  count,
  eq,
  inventories,
  inventoryMovements,
  inventoryReservations,
  machineSlots,
  orderItems,
  orders,
  orderStatusEvents,
  refunds,
  vendingCommands,
  DrizzleDB,
} from "@vem/db";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AppConfigService } from "../config/app-config.service";
import { VendingService } from "../vending/vending.service";
import {
  cleanupBusinessTables,
  connectMqtt,
  disconnectMqtt,
  getMachineAuthHeader,
  loginAndGetToken,
  machineOrderBody,
  publishMqtt,
  seedSingleSlotInventory,
  signMqttPayload,
  waitForMqttMessage,
  type ApiResponse,
  type CreatedOrderPayload,
  type SeededSingleSlotInventory,
} from "./flow-test-helpers";

type PaidCommandContext = {
  seeded: SeededSingleSlotInventory;
  token: string;
  machineAuthHeader: Record<string, string>;
  orderId: string;
  orderNo: string;
  paymentNo: string;
  commandId: string;
  commandNo: string;
  orderItemId: string;
};

describe("fulfillment recovery e2e", { concurrent: false }, () => {
  let app: INestApplication;
  let appConfig: AppConfigService;
  let db: DrizzleDB;
  let mqttClient: MqttClient;
  let api: ReturnType<typeof request>;
  let vendingService: VendingService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();

    appConfig = app.get(AppConfigService);
    vendingService = app.get(VendingService);
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
    if (mqttClient) await disconnectMqtt(mqttClient);
    if (db) await db.disconnect();
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanupBusinessTables(db);
  });

  async function createPaidCommand(
    machineCode: string,
  ): Promise<PaidCommandContext> {
    const seeded = await seedSingleSlotInventory(db, {
      machineCode,
      onHandQty: 2,
      lowStockThreshold: 1,
      slotCode: "A1",
      layerNo: 1,
      cellNo: 1,
    });
    const token = await loginAndGetToken(api, appConfig);
    const machineAuthHeader = await getMachineAuthHeader(
      api,
      seeded.machineCode,
      seeded.machineSecret,
    );
    const commandPayloadPromise = waitForMqttMessage(
      mqttClient,
      `vem/machines/${seeded.machineCode}/commands/dispense`,
    );

    const createOrderResponse = await api
      .post("/api/machine-orders")
      .set(machineAuthHeader)
      .send(machineOrderBody(seeded));
    expect(createOrderResponse.status).toBe(201);
    const createdOrder =
      createOrderResponse.body as ApiResponse<CreatedOrderPayload>;

    const succeedResponse = await api
      .post(`/api/payments/mock/${createdOrder.data.paymentNo}/succeed`)
      .set("Authorization", `Bearer ${token}`);
    expect(succeedResponse.status).toBe(201);

    const commandPayloadText = await commandPayloadPromise;
    const commandEnvelope = JSON.parse(commandPayloadText) as {
      payload: { commandNo: string };
    };
    const commandNo = commandEnvelope.payload.commandNo;

    const [command] = await db.client
      .select({ id: vendingCommands.id })
      .from(vendingCommands)
      .where(eq(vendingCommands.commandNo, commandNo));
    const [orderItem] = await db.client
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(eq(orderItems.orderId, createdOrder.data.orderId));

    return {
      seeded,
      token,
      machineAuthHeader,
      orderId: createdOrder.data.orderId,
      orderNo: createdOrder.data.orderNo,
      paymentNo: createdOrder.data.paymentNo,
      commandId: command.id,
      commandNo,
      orderItemId: orderItem.id,
    };
  }

  async function publishDispenseResult(
    ctx: PaidCommandContext,
    payload: { success: boolean; errorCode: string | null; message: string },
  ) {
    await publishMqtt(
      mqttClient,
      `vem/machines/${ctx.seeded.machineCode}/events/dispense-result`,
      signMqttPayload({
        machineCode: ctx.seeded.machineCode,
        mqttSigningSecret: ctx.seeded.mqttSigningSecret,
        messageId: `result:${ctx.commandNo}:${payload.message}`,
        payload: {
          commandNo: ctx.commandNo,
          success: payload.success,
          errorCode: payload.errorCode,
          message: payload.message,
          reportedAt: new Date().toISOString(),
        },
      }),
    );
  }

  async function eventually(assertion: () => Promise<void>) {
    let lastError: unknown;
    // oxlint-disable no-await-in-loop -- bounded polling must run sequentially until assertion passes.
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        await assertion();
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError;
  }

  async function movementCount(
    orderId: string,
    reason: InventoryMovementReason,
  ): Promise<number> {
    const [row] = await db.client
      .select({ total: count() })
      .from(inventoryMovements)
      .where(
        and(
          eq(inventoryMovements.orderId, orderId),
          eq(inventoryMovements.reason, reason),
        ),
      );
    return Number(row.total);
  }

  async function markUnknown(ctx: PaidCommandContext) {
    const processed = await vendingService.markTimedOutCommands(
      new Date(Date.now() + 180_000),
    );
    expect(processed.processed).toBe(1);
    await eventually(async () => {
      const [command] = await db.client
        .select({ status: vendingCommands.status })
        .from(vendingCommands)
        .where(eq(vendingCommands.id, ctx.commandId));
      expect(command.status).toBe("result_unknown");
    });
  }

  it("confirmed no-drop failure releases the reservation, starts refund, and writes no stock decrement", async () => {
    const ctx = await createPaidCommand("M-E2E-REC-NODROP");

    await publishDispenseResult(ctx, {
      success: false,
      errorCode: "NO_DROP",
      message: "sensor saw no product drop",
    });

    await eventually(async () => {
      const [reservation] = await db.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, ctx.orderId));
      expect(reservation.status).toBe("released");
    });

    const [inventory] = await db.client
      .select({
        onHandQty: inventories.onHandQty,
        reservedQty: inventories.reservedQty,
      })
      .from(inventories)
      .where(eq(inventories.id, ctx.seeded.inventoryId));
    expect(inventory).toEqual({ onHandQty: 2, reservedQty: 0 });
    expect(await movementCount(ctx.orderId, "purchase_confirmed")).toBe(0);
    expect(await movementCount(ctx.orderId, "reservation_released")).toBe(1);

    const [refundCount] = await db.client
      .select({ total: count() })
      .from(refunds)
      .where(eq(refunds.orderId, ctx.orderId));
    expect(Number(refundCount.total)).toBe(1);
  }, 60_000);

  it("jammed confirmed failure faults the slot and records frozen slot sales state metadata", async () => {
    const ctx = await createPaidCommand("M-E2E-REC-JAMMED");

    await publishDispenseResult(ctx, {
      success: false,
      errorCode: "JAMMED",
      message: "coil jammed",
    });

    await eventually(async () => {
      const [slot] = await db.client
        .select({ status: machineSlots.status })
        .from(machineSlots)
        .where(eq(machineSlots.id, ctx.seeded.slotId));
      expect(slot.status).toBe("faulted");
    });
    const [event] = await db.client
      .select({ metadata: orderStatusEvents.metadata })
      .from(orderStatusEvents)
      .where(
        and(
          eq(orderStatusEvents.orderId, ctx.orderId),
          eq(orderStatusEvents.reason, "dispense_failed"),
        ),
      );
    expect(event.metadata).toEqual(
      expect.objectContaining({ slotSalesState: "frozen" }),
    );
    expect(await movementCount(ctx.orderId, "purchase_confirmed")).toBe(0);
  }, 60_000);

  it("unknown result keeps reservation active and moves the command/order to manual handling", async () => {
    const ctx = await createPaidCommand("M-E2E-REC-UNKNOWN");

    await markUnknown(ctx);

    const [reservation] = await db.client
      .select({ status: inventoryReservations.status })
      .from(inventoryReservations)
      .where(eq(inventoryReservations.orderId, ctx.orderId));
    const [inventory] = await db.client
      .select({
        onHandQty: inventories.onHandQty,
        reservedQty: inventories.reservedQty,
      })
      .from(inventories)
      .where(eq(inventories.id, ctx.seeded.inventoryId));
    const [order] = await db.client
      .select({
        status: orders.status,
        fulfillmentState: orders.fulfillmentState,
      })
      .from(orders)
      .where(eq(orders.id, ctx.orderId));

    expect(reservation.status).toBe("active");
    expect(inventory).toEqual({ onHandQty: 2, reservedQty: 1 });
    expect(order).toEqual({
      status: "manual_handling",
      fulfillmentState: "manual_handling",
    });
    expect(await movementCount(ctx.orderId, "purchase_confirmed")).toBe(0);
  }, 60_000);

  it("delayed MQTT dispense success after unknown confirms through the normal stock movement path", async () => {
    const ctx = await createPaidCommand("M-E2E-REC-DELAYED");
    await markUnknown(ctx);

    await publishDispenseResult(ctx, {
      success: true,
      errorCode: null,
      message: "delayed success after platform timeout",
    });

    await eventually(async () => {
      const [reservation] = await db.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, ctx.orderId));
      expect(reservation.status).toBe("confirmed");
    });

    const [inventory] = await db.client
      .select({
        onHandQty: inventories.onHandQty,
        reservedQty: inventories.reservedQty,
      })
      .from(inventories)
      .where(eq(inventories.id, ctx.seeded.inventoryId));
    const [command] = await db.client
      .select({ status: vendingCommands.status })
      .from(vendingCommands)
      .where(eq(vendingCommands.id, ctx.commandId));
    const [order] = await db.client
      .select({
        status: orders.status,
        fulfillmentState: orders.fulfillmentState,
      })
      .from(orders)
      .where(eq(orders.id, ctx.orderId));

    expect(inventory).toEqual({ onHandQty: 1, reservedQty: 0 });
    expect(command.status).toBe("succeeded");
    expect(order).toEqual({
      status: "fulfilled",
      fulfillmentState: "dispensed",
    });
    expect(await movementCount(ctx.orderId, "purchase_confirmed")).toBe(1);
  }, 60_000);

  it("stock movement replay after unknown is idempotent", async () => {
    const ctx = await createPaidCommand("M-E2E-REC-DELAYED-REPLAY");
    await markUnknown(ctx);

    const payload = {
      movementId: `delayed-dispense:${ctx.commandNo}`,
      planogramVersion: ctx.seeded.planogramVersion,
      slotId: ctx.seeded.slotId,
      movementType: "dispense_succeeded",
      quantity: 1,
      source: "vending_command",
      attributedTo: ctx.commandNo,
      orderContext: {
        orderNo: ctx.orderNo,
        orderItemId: ctx.orderItemId,
        vendingCommandNo: ctx.commandNo,
        inventoryId: ctx.seeded.inventoryId,
      },
      occurredAt: new Date().toISOString(),
    };

    const response = await api
      .post("/api/machine-stock-movements")
      .set(ctx.machineAuthHeader)
      .send(payload);
    expect(response.status).toBe(201);
    expect((response.body as ApiResponse<{ status: string }>).data.status).toBe(
      "accepted",
    );

    const duplicate = await api
      .post("/api/machine-stock-movements")
      .set(ctx.machineAuthHeader)
      .send(payload);
    expect(
      (duplicate.body as ApiResponse<{ status: string }>).data.status,
    ).toBe("already_accepted");

    const [reservation] = await db.client
      .select({ status: inventoryReservations.status })
      .from(inventoryReservations)
      .where(eq(inventoryReservations.orderId, ctx.orderId));
    const [command] = await db.client
      .select({ status: vendingCommands.status })
      .from(vendingCommands)
      .where(eq(vendingCommands.id, ctx.commandId));
    const [order] = await db.client
      .select({
        status: orders.status,
        fulfillmentState: orders.fulfillmentState,
      })
      .from(orders)
      .where(eq(orders.id, ctx.orderId));

    expect(reservation.status).toBe("confirmed");
    expect(command.status).toBe("succeeded");
    expect(order).toEqual({
      status: "fulfilled",
      fulfillmentState: "dispensed",
    });
    expect(await movementCount(ctx.orderId, "purchase_confirmed")).toBe(1);
  }, 60_000);

  it("manual not-dispensed resolution releases reservation and starts refund without stock decrement", async () => {
    const ctx = await createPaidCommand("M-E2E-REC-MANUAL-NO");
    await markUnknown(ctx);

    const response = await api
      .post(`/api/vending-commands/${ctx.commandId}/resolve`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        result: "not_dispensed",
        note: "operator found the item still in slot",
      });
    expect(response.status).toBe(201);

    await eventually(async () => {
      const [reservation] = await db.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, ctx.orderId));
      expect(reservation.status).toBe("released");
    });
    expect(await movementCount(ctx.orderId, "purchase_confirmed")).toBe(0);
    expect(await movementCount(ctx.orderId, "reservation_released")).toBe(1);
  }, 60_000);

  it("manual dispensed resolution confirms inventory and reservation through stock movement path", async () => {
    const ctx = await createPaidCommand("M-E2E-REC-MANUAL-YES");
    await markUnknown(ctx);

    const response = await api
      .post(`/api/vending-commands/${ctx.commandId}/resolve`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        result: "dispensed",
        note: "operator confirmed customer received item",
      });
    expect(response.status).toBe(201);

    const [reservation] = await db.client
      .select({ status: inventoryReservations.status })
      .from(inventoryReservations)
      .where(eq(inventoryReservations.orderId, ctx.orderId));
    const [inventory] = await db.client
      .select({
        onHandQty: inventories.onHandQty,
        reservedQty: inventories.reservedQty,
      })
      .from(inventories)
      .where(eq(inventories.id, ctx.seeded.inventoryId));
    const [order] = await db.client
      .select({
        status: orders.status,
        fulfillmentState: orders.fulfillmentState,
      })
      .from(orders)
      .where(eq(orders.id, ctx.orderId));

    expect(reservation.status).toBe("confirmed");
    expect(inventory).toEqual({ onHandQty: 1, reservedQty: 0 });
    expect(order).toEqual({
      status: "fulfilled",
      fulfillmentState: "dispensed",
    });
    expect(await movementCount(ctx.orderId, "purchase_confirmed")).toBe(1);
  }, 60_000);
});
