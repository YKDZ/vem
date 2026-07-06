import type { INestApplication } from "@nestjs/common";
import type { MqttClient } from "mqtt";

import { Test } from "@nestjs/testing";
import {
  and,
  auditLogs,
  count,
  desc,
  eq,
  inventories,
  inventoryMovements,
  inventoryReservations,
  machineSlots,
  orderItems,
  orderRecoveryActions,
  orders,
  orderStatusEvents,
  refunds,
  sql,
  vendingCommands,
  DrizzleDB,
} from "@vem/db";
import {
  orderRecoveryActionResponseSchema,
  type InventoryMovementReason,
} from "@vem/shared";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { AppModule } from "../app.module";
import { AppConfigService } from "../config/app-config.service";
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
    await publishDispenseResult(ctx, {
      success: false,
      errorCode: "UNKNOWN",
      message: "dispense result unknown after daemon restart",
    });
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

  it("unknown result keeps reservation active, freezes the slot, and moves the command/order to manual handling", async () => {
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
    const [slot] = await db.client
      .select({ status: machineSlots.status })
      .from(machineSlots)
      .where(eq(machineSlots.id, ctx.seeded.slotId));
    const [event] = await db.client
      .select({ metadata: orderStatusEvents.metadata })
      .from(orderStatusEvents)
      .where(
        and(
          eq(orderStatusEvents.orderId, ctx.orderId),
          eq(orderStatusEvents.reason, "dispense_result_unknown"),
        ),
      );

    expect(reservation.status).toBe("active");
    expect(inventory).toEqual({ onHandQty: 2, reservedQty: 1 });
    expect(slot.status).toBe("faulted");
    expect(order).toEqual({
      status: "manual_handling",
      fulfillmentState: "manual_handling",
    });
    expect(event.metadata).toEqual(
      expect.objectContaining({
        commandNo: ctx.commandNo,
        requiresPhysicalOutcomeConfirmation: true,
        slotSalesState: "frozen",
      }),
    );
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

  it("admin recovery confirms dispensed with required note and audit trail", async () => {
    const ctx = await createPaidCommand("M-E2E-REC-ADMIN-YES");
    await markUnknown(ctx);

    const missingNote = await api
      .post(`/api/orders/${ctx.orderId}/recovery-actions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({ action: "confirm_dispensed", note: " " });
    expect(missingNote.status).toBe(400);

    const response = await api
      .post(`/api/orders/${ctx.orderId}/recovery-actions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        action: "confirm_dispensed",
        note: "operator verified pickup area was empty and customer received item",
      });
    expect(response.status).toBe(201);
    const recoveryResponse = orderRecoveryActionResponseSchema.parse(
      (response.body as ApiResponse<unknown>).data,
    );
    expect(recoveryResponse).toMatchObject({
      action: "confirm_dispensed",
      commandId: ctx.commandId,
      status: "succeeded",
    });
    expect(recoveryResponse.recoveryActionId).toBeTruthy();

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
    const [audit] = await db.client
      .select({
        action: auditLogs.action,
        resourceType: auditLogs.resourceType,
        resourceId: auditLogs.resourceId,
        afterJson: auditLogs.afterJson,
      })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, ctx.orderId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);

    expect(reservation.status).toBe("confirmed");
    expect(inventory).toEqual({ onHandQty: 1, reservedQty: 0 });
    expect(await movementCount(ctx.orderId, "purchase_confirmed")).toBe(1);
    expect(audit).toMatchObject({
      action: "orders.recovery.confirm_dispensed",
      resourceType: "order",
      resourceId: ctx.orderId,
    });
    expect(audit.afterJson).toEqual(
      expect.objectContaining({
        note: "operator verified pickup area was empty and customer received item",
        commandNo: ctx.commandNo,
      }),
    );
  }, 60_000);

  it("admin recovery confirms not dispensed, requests refund, audits, and rejects duplicates", async () => {
    const ctx = await createPaidCommand("M-E2E-REC-ADMIN-NO");
    await markUnknown(ctx);

    const response = await api
      .post(`/api/orders/${ctx.orderId}/recovery-actions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        action: "confirm_not_dispensed",
        note: "operator found product still in slot after customer report",
      });
    expect(response.status).toBe(201);
    const recoveryResponse = orderRecoveryActionResponseSchema.parse(
      (response.body as ApiResponse<unknown>).data,
    );
    expect(recoveryResponse).toMatchObject({
      action: "confirm_not_dispensed",
      commandId: ctx.commandId,
      status: "failed",
    });
    expect(recoveryResponse.recoveryActionId).toBeTruthy();

    const duplicate = await api
      .post(`/api/orders/${ctx.orderId}/recovery-actions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        action: "confirm_not_dispensed",
        note: "second operator repeated the same confirmation",
      });
    expect(duplicate.status).toBe(409);

    await eventually(async () => {
      const [reservation] = await db.client
        .select({ status: inventoryReservations.status })
        .from(inventoryReservations)
        .where(eq(inventoryReservations.orderId, ctx.orderId));
      expect(reservation.status).toBe("released");
    });

    const [refundCount] = await db.client
      .select({ total: count() })
      .from(refunds)
      .where(eq(refunds.orderId, ctx.orderId));
    const [audit] = await db.client
      .select({
        action: auditLogs.action,
        afterJson: auditLogs.afterJson,
      })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, ctx.orderId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);

    expect(Number(refundCount.total)).toBe(0);
    expect(await movementCount(ctx.orderId, "purchase_confirmed")).toBe(0);
    expect(await movementCount(ctx.orderId, "reservation_released")).toBe(1);
    expect(audit.action).toBe("orders.recovery.confirm_not_dispensed");
    expect(audit.afterJson).toEqual(
      expect.objectContaining({
        note: "operator found product still in slot after customer report",
        commandNo: ctx.commandNo,
      }),
    );

    const refundResponse = await api
      .post(`/api/orders/${ctx.orderId}/recovery-actions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        action: "request_refund",
        note: "operator requested refund after confirmed not dispensed",
      });
    expect(refundResponse.status).toBe(201);
    const parsedRefundResponse = orderRecoveryActionResponseSchema.parse(
      (refundResponse.body as ApiResponse<unknown>).data,
    );
    expect(parsedRefundResponse).toMatchObject({
      action: "request_refund",
      commandId: ctx.commandId,
      status: "refund_requested",
    });

    const duplicateRefund = await api
      .post(`/api/orders/${ctx.orderId}/recovery-actions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        action: "request_refund",
        note: "duplicate refund request",
      });
    expect(duplicateRefund.status).toBe(409);

    const [refundCountAfterRequest] = await db.client
      .select({ total: count() })
      .from(refunds)
      .where(eq(refunds.orderId, ctx.orderId));
    const [refundAudit] = await db.client
      .select({
        action: auditLogs.action,
        afterJson: auditLogs.afterJson,
      })
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, ctx.orderId))
      .orderBy(desc(auditLogs.createdAt))
      .limit(1);
    expect(Number(refundCountAfterRequest.total)).toBe(1);
    expect(refundAudit.action).toBe("orders.recovery.request_refund");
    expect(refundAudit.afterJson).toEqual(
      expect.objectContaining({
        note: "operator requested refund after confirmed not dispensed",
      }),
    );
  }, 60_000);

  it("admin recovery creates compensation dispense as a new command number", async () => {
    const ctx = await createPaidCommand("M-E2E-REC-ADMIN-COMP");
    await markUnknown(ctx);

    const confirmResponse = await api
      .post(`/api/orders/${ctx.orderId}/recovery-actions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        action: "confirm_not_dispensed",
        note: "operator confirmed product stayed in slot",
      });
    expect(confirmResponse.status).toBe(201);

    const commandPayloadPromise = waitForMqttMessage(
      mqttClient,
      `vem/machines/${ctx.seeded.machineCode}/commands/dispense`,
    );
    const compensationResponse = await api
      .post(`/api/orders/${ctx.orderId}/recovery-actions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        action: "compensation_dispense",
        note: "operator authorized one replacement dispense",
      });
    expect(compensationResponse.status).toBe(201);
    const recoveryResponse = orderRecoveryActionResponseSchema.parse(
      (compensationResponse.body as ApiResponse<unknown>).data,
    );
    expect(recoveryResponse).toMatchObject({
      action: "compensation_dispense",
      status: "pending",
    });
    expect(recoveryResponse.commandNo).toBeTruthy();

    const duplicateCompensation = await api
      .post(`/api/orders/${ctx.orderId}/recovery-actions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        action: "compensation_dispense",
        note: "duplicate replacement dispense",
      });
    expect(duplicateCompensation.status).toBe(409);

    const commandPayloadText = await commandPayloadPromise;
    const commandEnvelope = JSON.parse(commandPayloadText) as {
      payload: {
        commandNo: string;
        recovery?: { originalCommandNo?: string };
      };
    };
    expect(commandEnvelope.payload.commandNo).toBeTruthy();
    expect(commandEnvelope.payload.commandNo).not.toBe(ctx.commandNo);
    expect(commandEnvelope.payload.recovery?.originalCommandNo).toBe(
      ctx.commandNo,
    );

    const commandRows = await db.client
      .select({
        commandNo: vendingCommands.commandNo,
        commandKind: vendingCommands.commandKind,
        recoveryActionId: vendingCommands.recoveryActionId,
        payloadJson: vendingCommands.payloadJson,
      })
      .from(vendingCommands)
      .where(eq(vendingCommands.orderId, ctx.orderId))
      .orderBy(desc(vendingCommands.createdAt));
    expect(commandRows).toHaveLength(2);
    expect(commandRows[0]?.commandNo).not.toBe(ctx.commandNo);
    expect(commandRows[0]?.commandKind).toBe("compensation");
    expect(commandRows[0]?.recoveryActionId).toBeTruthy();
    expect(commandRows[1]?.commandKind).toBe("dispatch");
    expect(commandRows[0]?.payloadJson).toEqual(
      expect.objectContaining({
        recovery: expect.objectContaining({
          action: "compensation_dispense",
          originalCommandNo: ctx.commandNo,
        }),
      }),
    );
  }, 60_000);

  it("admin recovery rejects in-flight commands before physical confirmation", async () => {
    const ctx = await createPaidCommand("M-E2E-REC-INFLIGHT");

    const response = await api
      .post(`/api/orders/${ctx.orderId}/recovery-actions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        action: "confirm_not_dispensed",
        note: "operator tried before command timed out",
      });
    expect(response.status).toBe(409);

    const [actionCount] = await db.client
      .select({ total: count() })
      .from(orderRecoveryActions)
      .where(eq(orderRecoveryActions.orderId, ctx.orderId));
    expect(Number(actionCount.total)).toBe(0);
  }, 60_000);

  it("admin recovery enforces refund-vs-compensation under concurrent requests", async () => {
    const ctx = await createPaidCommand("M-E2E-REC-CONCURRENT");
    await markUnknown(ctx);

    const confirmResponse = await api
      .post(`/api/orders/${ctx.orderId}/recovery-actions`)
      .set("Authorization", `Bearer ${ctx.token}`)
      .send({
        action: "confirm_not_dispensed",
        note: "operator confirmed product stayed in slot",
      });
    expect(confirmResponse.status).toBe(201);

    const [refundResponse, compensationResponse] = await Promise.all([
      api
        .post(`/api/orders/${ctx.orderId}/recovery-actions`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          action: "request_refund",
          note: "operator chose refund",
        }),
      api
        .post(`/api/orders/${ctx.orderId}/recovery-actions`)
        .set("Authorization", `Bearer ${ctx.token}`)
        .send({
          action: "compensation_dispense",
          note: "operator chose compensation",
        }),
    ]);

    expect(
      [refundResponse.status, compensationResponse.status].sort(
        (left, right) => left - right,
      ),
    ).toEqual([201, 409]);
    const [remedyCount] = await db.client
      .select({ total: count() })
      .from(orderRecoveryActions)
      .where(
        and(
          eq(orderRecoveryActions.orderId, ctx.orderId),
          sql`${orderRecoveryActions.action} IN ('request_refund', 'compensation_dispense')`,
        ),
      );
    expect(Number(remedyCount.total)).toBe(1);
  }, 60_000);
});
