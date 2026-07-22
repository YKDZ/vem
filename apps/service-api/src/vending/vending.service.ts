import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
} from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  inArray,
  inventories,
  inventoryReservations,
  machineEvents,
  machineHeartbeats,
  machines,
  machineSlots,
  orderItems,
  orders,
  orderStatusEvents,
  sql,
  vendingCommands,
  type DrizzleClient,
  type DrizzleTransaction,
} from "@vem/db";
import {
  commandAckPayloadSchema,
  dispenseCommandPayloadSchema,
  dispenseResultPayloadSchema,
  heartbeatPayloadSchema,
  pageQuerySchema,
  type RawMachineStockMovement,
} from "@vem/shared";
import { z } from "zod";

import { createBusinessNo } from "../common/business-no.util";
import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import {
  lockInventoriesForVendingMutation,
  lockMachineForVendingMutation,
  lockOrderForVendingMutation,
} from "../database/machine-transaction-lock";
import { InventoryService } from "../inventory/inventory.service";
import { MachineStockMovementsService } from "../inventory/machine-stock-movements.service";
import { MaintenanceWorkOrdersService } from "../maintenance-work-orders/maintenance-work-orders.service";
import { MqttSignatureService } from "../mqtt/mqtt-signature.service";
import { MqttService } from "../mqtt/mqtt.service";
import { NotificationsService } from "../notifications/notifications.service";
import { projectOrderStatus } from "../orders/order-state-projection";
import { RefundsService } from "../refunds/refunds.service";

type PageQueryInput = z.infer<typeof pageQuerySchema>;
type FailedLineRefundDecision =
  | { kind: "none" }
  | { kind: "full"; orderId: string; metadata: Record<string, unknown> }
  | {
      kind: "partial";
      orderId: string;
      orderItemIds: string[];
      amountCents: number;
      metadata: Record<string, unknown>;
    };

@Injectable()
export class VendingService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(VendingService.name);
  private timeoutInterval?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    @Inject(MqttService)
    private readonly mqttService: MqttService,
    @Inject(MqttSignatureService)
    private readonly mqttSignatureService: MqttSignatureService,
    @Inject(NotificationsService)
    private readonly notificationsService: NotificationsService,
    @Inject(InventoryService)
    private readonly inventoryService: InventoryService,
    @Inject(MachineStockMovementsService)
    private readonly machineStockMovementsService: MachineStockMovementsService,
    @Inject(RefundsService)
    private readonly refundsService: RefundsService,
    @Inject(MaintenanceWorkOrdersService)
    private readonly maintenanceWorkOrdersService: MaintenanceWorkOrdersService,
  ) {}

  onModuleInit(): void {
    this.mqttService.bindVendingService(this);
    this.timeoutInterval = setInterval(() => {
      void (async () => {
        await this.dispatchPendingCommands();
        await this.markTimedOutCommands();
      })().catch((error: unknown) => {
        this.logger.warn(
          `vending command recovery failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, 60_000);
  }

  onApplicationShutdown(): void {
    if (this.timeoutInterval) {
      clearInterval(this.timeoutInterval);
      this.timeoutInterval = undefined;
    }
  }

  /**
   * Durable outbox creation. Payment code must call this with its own
   * transaction so the payment event, paid order and dispense command either
   * commit together or all roll back together.
   */
  async createPendingDispatchCommands(tx: DrizzleTransaction, orderId: string) {
    const [order] = await tx
      .select({
        id: orders.id,
        orderNo: orders.orderNo,
        machineId: orders.machineId,
      })
      .from(orders)
      .where(eq(orders.id, orderId));
    if (!order) throw new NotFoundException("Order not found");

    await lockMachineForVendingMutation(tx, order.machineId);
    await lockOrderForVendingMutation(tx, orderId);

    const existing = await tx
      .select()
      .from(vendingCommands)
      .where(
        and(
          eq(vendingCommands.orderId, orderId),
          eq(vendingCommands.commandKind, "dispatch"),
        ),
      )
      .orderBy(vendingCommands.createdAt);
    if (existing.length > 0) return existing;

    const items = await tx
      .select({
        orderItemId: orderItems.id,
        inventoryId: orderItems.inventoryId,
        slotId: orderItems.slotId,
        quantity: orderItems.quantity,
        rowNo: machineSlots.rowNo,
        cellNo: machineSlots.cellNo,
      })
      .from(orderItems)
      .innerJoin(machineSlots, eq(machineSlots.id, orderItems.slotId))
      .where(eq(orderItems.orderId, orderId));
    await lockInventoriesForVendingMutation(
      tx,
      items.map((item) => item.inventoryId),
    );

    const created = [];
    // oxlint-disable no-await-in-loop -- each insert observes the same transaction and unique slot constraint
    for (const item of items) {
      const commandNo = createBusinessNo("CMD");
      const payload = dispenseCommandPayloadSchema.parse({
        commandNo,
        orderNo: order.orderNo,
        slot: {
          rowNo: item.rowNo,
          cellNo: item.cellNo,
        },
        quantity: item.quantity,
        timeoutSeconds: 120,
      });
      const [command] = await tx
        .insert(vendingCommands)
        .values({
          commandNo,
          orderId,
          machineId: order.machineId,
          slotId: item.slotId,
          orderItemId: item.orderItemId,
          commandKind: "dispatch",
          payloadJson: payload,
          status: "pending",
        })
        .onConflictDoNothing()
        .returning();
      if (command) created.push(command);
    }
    // oxlint-enable no-await-in-loop

    if (created.length === items.length) return created;
    return await tx
      .select()
      .from(vendingCommands)
      .where(
        and(
          eq(vendingCommands.orderId, orderId),
          eq(vendingCommands.commandKind, "dispatch"),
        ),
      )
      .orderBy(vendingCommands.createdAt);
  }

  /** Publish already-durable commands. A process death before or during this
   * step leaves status=pending, and the periodic dispatcher or a duplicate
   * payment notification publishes the same commandNo again. */
  async dispatchPendingCommandsForOrder(orderId: string) {
    const pending = await this.db
      .select({
        id: vendingCommands.id,
        commandNo: vendingCommands.commandNo,
        payloadJson: vendingCommands.payloadJson,
        machineCode: machines.code,
      })
      .from(vendingCommands)
      .innerJoin(machines, eq(machines.id, vendingCommands.machineId))
      .where(
        and(
          eq(vendingCommands.orderId, orderId),
          eq(vendingCommands.status, "pending"),
        ),
      )
      .orderBy(vendingCommands.createdAt);

    return await Promise.all(
      pending.map(async (command) => {
        try {
          const payload = dispenseCommandPayloadSchema.parse(
            command.payloadJson,
          );
          const envelope = await this.mqttSignatureService.signForMachine({
            machineCode: command.machineCode,
            payload,
            messageId: `command:${command.commandNo}`,
          });
          await this.mqttService.publish(
            `vem/machines/${command.machineCode}/commands/dispense`,
            envelope,
          );
          return await this.markPendingCommandSent(command.id);
        } catch (error) {
          return await this.recordPendingCommandDispatchFailure(
            command.id,
            error,
          );
        }
      }),
    );
  }

  private async markPendingCommandSent(commandId: string) {
    return await this.db.transaction(async (tx) => {
      const [command] = await tx
        .select({
          id: vendingCommands.id,
          machineId: vendingCommands.machineId,
          orderId: vendingCommands.orderId,
        })
        .from(vendingCommands)
        .where(eq(vendingCommands.id, commandId));
      if (!command) return undefined;

      await lockMachineForVendingMutation(tx, command.machineId);
      await lockOrderForVendingMutation(tx, command.orderId);
      const [sent] = await tx
        .update(vendingCommands)
        .set({
          status: "sent",
          sentAt: new Date(),
          lastError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(vendingCommands.id, command.id),
            eq(vendingCommands.status, "pending"),
          ),
        )
        .returning();
      return sent;
    });
  }

  private async recordPendingCommandDispatchFailure(
    commandId: string,
    error: unknown,
  ) {
    return await this.db.transaction(async (tx) => {
      const [command] = await tx
        .select({
          id: vendingCommands.id,
          machineId: vendingCommands.machineId,
          orderId: vendingCommands.orderId,
        })
        .from(vendingCommands)
        .where(eq(vendingCommands.id, commandId));
      if (!command) return undefined;

      await lockMachineForVendingMutation(tx, command.machineId);
      await lockOrderForVendingMutation(tx, command.orderId);
      const [retryable] = await tx
        .update(vendingCommands)
        .set({
          retryCount: sql`${vendingCommands.retryCount} + 1`,
          lastError: error instanceof Error ? error.message : String(error),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(vendingCommands.id, command.id),
            eq(vendingCommands.status, "pending"),
          ),
        )
        .returning();
      return retryable;
    });
  }

  async dispatchPendingCommands(): Promise<{ processed: number }> {
    const ordersWithPendingCommands = await this.db
      .selectDistinct({ orderId: vendingCommands.orderId })
      .from(vendingCommands)
      .where(eq(vendingCommands.status, "pending"))
      .limit(50);
    const results = await Promise.all(
      ordersWithPendingCommands.map(
        async ({ orderId }) =>
          await this.dispatchPendingCommandsForOrder(orderId),
      ),
    );
    return { processed: results.flat().filter(Boolean).length };
  }

  async createAndDispatchCommands(orderId: string) {
    const commands = await this.db.transaction(
      async (tx) => await this.createPendingDispatchCommands(tx, orderId),
    );
    await this.dispatchPendingCommandsForOrder(orderId);
    return commands;
  }

  async handleMachineMessage(topic: string, payload: string): Promise<void> {
    const ackMatch = /^vem\/machines\/([^/]+)\/commands\/([^/]+)\/ack$/.exec(
      topic,
    );
    if (ackMatch) {
      await this.handleCommandAck(ackMatch[1], ackMatch[2], topic, payload);
      return;
    }

    const resultMatch =
      /^vem\/machines\/([^/]+)\/events\/dispense-result$/.exec(topic);
    if (resultMatch) {
      await this.handleDispenseResult(resultMatch[1], topic, payload);
      return;
    }

    const heartbeatMatch = /^vem\/machines\/([^/]+)\/events\/heartbeat$/.exec(
      topic,
    );
    if (heartbeatMatch) {
      await this.handleHeartbeat(heartbeatMatch[1], topic, payload);
    }
  }

  async listCommands(query: PageQueryInput) {
    const items = await this.db
      .select({
        id: vendingCommands.id,
        commandNo: vendingCommands.commandNo,
        orderId: vendingCommands.orderId,
        machineId: vendingCommands.machineId,
        machineCode: machines.code,
        slotId: vendingCommands.slotId,
        orderItemId: vendingCommands.orderItemId,
        status: vendingCommands.status,
        retryCount: vendingCommands.retryCount,
        sentAt: vendingCommands.sentAt,
        ackAt: vendingCommands.ackAt,
        resultAt: vendingCommands.resultAt,
        lastError: vendingCommands.lastError,
        createdAt: vendingCommands.createdAt,
      })
      .from(vendingCommands)
      .innerJoin(machines, eq(machines.id, vendingCommands.machineId))
      .orderBy(desc(vendingCommands.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(vendingCommands);

    return toPageResult(items, query, Number(totalRow.total));
  }

  async resolveCommand(
    id: string,
    input: {
      result: "dispensed" | "not_dispensed";
      note?: string;
      requestRefund?: boolean;
    },
  ) {
    const [command] = await this.db
      .select({
        id: vendingCommands.id,
        commandNo: vendingCommands.commandNo,
        orderId: vendingCommands.orderId,
        machineId: vendingCommands.machineId,
        machineCode: machines.code,
        slotId: vendingCommands.slotId,
        orderItemId: vendingCommands.orderItemId,
        status: vendingCommands.status,
        payloadJson: vendingCommands.payloadJson,
        orderNo: orders.orderNo,
      })
      .from(vendingCommands)
      .innerJoin(machines, eq(machines.id, vendingCommands.machineId))
      .innerJoin(orders, eq(orders.id, vendingCommands.orderId))
      .where(eq(vendingCommands.id, id));
    if (!command) {
      throw new NotFoundException("Vending command not found");
    }
    if (input.result === "dispensed") {
      return await this.resolveCommandAsDispensed(command);
    }

    const failureContext = await this.db.transaction(async (tx) => {
      await lockMachineForVendingMutation(tx, command.machineId);
      await lockOrderForVendingMutation(tx, command.orderId);
      const [updated] = await tx
        .update(vendingCommands)
        .set({
          status: "failed",
          resultAt: new Date(),
          lastError: input.note ?? "manual confirmation: not dispensed",
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(vendingCommands.id, command.id),
            inArray(vendingCommands.status, [
              "sent",
              "acknowledged",
              "result_unknown",
              "timeout",
            ]),
          ),
        )
        .returning({ id: vendingCommands.id });
      if (!updated && command.status === "failed") {
        return null;
      }
      if (!updated) {
        throw new ConflictException(
          `Command status ${command.status} cannot be resolved as not dispensed`,
        );
      }

      const compensation =
        await this.inventoryService.releaseAffectedReservationForDispenseFailure(
          tx,
          {
            orderId: command.orderId,
            orderItemId: command.orderItemId,
            slotId: command.slotId,
            errorCode: "NO_DROP",
            message: input.note ?? "manual confirmation: not dispensed",
          },
        );

      const refundDecision =
        await this.markOrderLinesFailedAndBuildRefundDecision(tx, {
          orderId: command.orderId,
          orderItemId: command.orderItemId,
          slotId: command.slotId,
          reason: "manual_dispense_not_dispensed",
          metadata: {
            commandNo: command.commandNo,
            releasedQuantity: compensation.releasedQuantity,
            slotSalesState: compensation.slotSalesState,
          },
        });
      if (input.requestRefund !== false) {
        await this.stageFailedLineRefund(tx, refundDecision);
      }

      await this.notificationsService.createDispenseFailedNotification(tx, {
        orderId: command.orderId,
        commandId: command.id,
        message: input.note ?? "manual confirmation: not dispensed",
      });

      return {
        orderId: command.orderId,
        commandId: command.id,
        commandNo: command.commandNo,
        errorCode: "NO_DROP" as const,
        message: input.note ?? "manual confirmation: not dispensed",
        compensation,
        refundDecision,
      };
    });

    if (failureContext && input.requestRefund !== false) {
      await this.refundsService.dispatchPendingRefunds();
    }

    return { commandId: command.id, status: "failed" as const };
  }

  async createCompensationDispenseCommand(input: {
    orderId: string;
    recoveryActionId: string;
    originalCommandNo: string;
    note: string;
  }) {
    const created = await this.db.transaction(async (tx) => {
      const [order] = await tx
        .select({
          id: orders.id,
          machineId: orders.machineId,
        })
        .from(orders)
        .where(eq(orders.id, input.orderId));
      if (!order) {
        throw new NotFoundException("Order not found for compensation");
      }
      await lockMachineForVendingMutation(tx, order.machineId);
      await lockOrderForVendingMutation(tx, order.id);

      // Re-read the original command only after the machine lock. This makes
      // its line and physical slot stable against planogram activation.
      const [row] = await tx
        .select({
          orderId: orders.id,
          orderNo: orders.orderNo,
          machineId: orders.machineId,
          machineCode: machines.code,
          orderItemId: vendingCommands.orderItemId,
          slotId: vendingCommands.slotId,
          inventoryId: orderItems.inventoryId,
          quantity: orderItems.quantity,
          rowNo: machineSlots.rowNo,
          cellNo: machineSlots.cellNo,
        })
        .from(vendingCommands)
        .innerJoin(orders, eq(orders.id, vendingCommands.orderId))
        .innerJoin(machines, eq(machines.id, vendingCommands.machineId))
        .innerJoin(orderItems, eq(orderItems.id, vendingCommands.orderItemId))
        .innerJoin(machineSlots, eq(machineSlots.id, vendingCommands.slotId))
        .where(
          and(
            eq(vendingCommands.orderId, input.orderId),
            eq(vendingCommands.commandNo, input.originalCommandNo),
          ),
        );
      if (!row) {
        throw new NotFoundException(
          "Original vending command item not found for compensation",
        );
      }
      await lockInventoriesForVendingMutation(tx, [row.inventoryId]);

      const commandNo = createBusinessNo("CMD");
      const payload = dispenseCommandPayloadSchema.parse({
        commandNo,
        orderNo: row.orderNo,
        slot: { rowNo: row.rowNo, cellNo: row.cellNo },
        quantity: row.quantity,
        timeoutSeconds: 120,
        recovery: {
          action: "compensation_dispense",
          originalCommandNo: input.originalCommandNo,
          note: input.note,
        },
      });
      const [inventory] = await tx
        .update(inventories)
        .set({
          reservedQty: sql`${inventories.reservedQty} + ${row.quantity}`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(inventories.id, row.inventoryId),
            sql`${inventories.onHandQty} - ${inventories.reservedQty} >= ${row.quantity}`,
          ),
        )
        .returning({ id: inventories.id });
      if (!inventory) {
        throw new ConflictException(
          "Insufficient inventory for compensation dispense",
        );
      }

      await tx.insert(inventoryReservations).values({
        inventoryId: row.inventoryId,
        orderId: row.orderId,
        orderItemId: row.orderItemId,
        quantity: row.quantity,
        status: "active",
        expiresAt: new Date(Date.now() + 15 * 60_000),
      });

      const [command] = await tx
        .insert(vendingCommands)
        .values({
          commandNo,
          orderId: row.orderId,
          machineId: row.machineId,
          slotId: row.slotId,
          orderItemId: row.orderItemId,
          commandKind: "compensation",
          recoveryActionId: input.recoveryActionId,
          payloadJson: payload,
          status: "pending",
        })
        .returning();
      return { command, machineCode: row.machineCode, payload };
    });
    await this.dispatchPendingCommandsForOrder(input.orderId);
    return created.command;
  }

  private async resolveCommandAsDispensed(
    command: {
      id: string;
      commandNo: string;
      orderId: string;
      machineId: string;
      machineCode: string;
      slotId: string;
      orderItemId: string | null;
      status: string;
      payloadJson: Record<string, unknown>;
      orderNo: string;
    },
    options: {
      movementId?: string;
      source?: string;
      occurredAt?: string;
    } = {},
  ) {
    if (command.status === "failed") {
      throw new ConflictException(
        "Failed command cannot be resolved as dispensed",
      );
    }

    const [item] = await this.db
      .select({
        id: orderItems.id,
        inventoryId: orderItems.inventoryId,
        quantity: orderItems.quantity,
        productSnapshot: orderItems.productSnapshot,
      })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.orderId, command.orderId),
          command.orderItemId
            ? eq(orderItems.id, command.orderItemId)
            : eq(orderItems.slotId, command.slotId),
        ),
      )
      .limit(1);
    if (!item) {
      throw new NotFoundException("Order item not found for vending command");
    }

    const snapshot = item.productSnapshot as Record<string, unknown>;
    const planogramVersion = snapshot.planogramVersion;
    if (typeof planogramVersion !== "string") {
      throw new ConflictException("Order item planogram snapshot is missing");
    }

    const movement: RawMachineStockMovement = {
      movementId: options.movementId ?? `manual-dispense:${command.commandNo}`,
      planogramVersion,
      slotId: command.slotId,
      movementType: "dispense_succeeded",
      quantity: item.quantity,
      source: options.source ?? "manual_confirmation",
      attributedTo: command.commandNo,
      orderContext: {
        orderNo: command.orderNo,
        orderItemId: item.id,
        vendingCommandNo: command.commandNo,
        inventoryId: item.inventoryId,
      },
      occurredAt: options.occurredAt ?? new Date().toISOString(),
    };

    const result = await this.machineStockMovementsService.receiveRawMovement(
      { id: command.machineId, code: command.machineCode, status: "online" },
      movement,
    );
    if (result.status !== "accepted" && result.status !== "already_accepted") {
      throw new ConflictException(
        `Manual dispense confirmation could not be accepted: ${result.status}`,
      );
    }

    return {
      commandId: command.id,
      status: "succeeded" as const,
      stockMovementStatus: result.status,
    };
  }

  async markTimedOutCommands(now = new Date()): Promise<{ processed: number }> {
    const candidates = await this.db
      .select({
        id: vendingCommands.id,
        commandNo: vendingCommands.commandNo,
        machineId: vendingCommands.machineId,
        orderId: vendingCommands.orderId,
        slotId: vendingCommands.slotId,
        payloadJson: vendingCommands.payloadJson,
        sentAt: vendingCommands.sentAt,
        ackAt: vendingCommands.ackAt,
      })
      .from(vendingCommands)
      .where(inArray(vendingCommands.status, ["sent", "acknowledged"]));

    const toProcess = candidates.filter((command) => {
      const payload = dispenseCommandPayloadSchema.parse(command.payloadJson);
      const baseAt = command.ackAt ?? command.sentAt;
      if (!baseAt) return false;
      const deadlineMs =
        baseAt.getTime() + (payload.timeoutSeconds + 10) * 1_000;
      return now.getTime() >= deadlineMs;
    });

    const results = await Promise.all(
      toProcess.map(async (command) => {
        const changed = await this.db.transaction(async (tx) => {
          return await this.markDispenseResultUnknown(tx, {
            command,
            message: "dispense result unknown after command timeout",
            resultAt: now,
            eligibleStatuses: ["sent", "acknowledged"],
          });
        });
        return changed;
      }),
    );

    const processed = results.filter(Boolean).length;
    return { processed };
  }

  private async markDispenseResultUnknown(
    tx: DrizzleTransaction,
    input: {
      command: {
        id: string;
        commandNo: string;
        machineId: string;
        orderId: string;
        slotId: string;
      };
      message: string;
      resultAt: Date;
      eligibleStatuses: Array<
        "pending" | "sent" | "acknowledged" | "result_unknown"
      >;
    },
  ): Promise<boolean> {
    await lockMachineForVendingMutation(tx, input.command.machineId);
    await lockOrderForVendingMutation(tx, input.command.orderId);
    const [updated] = await tx
      .update(vendingCommands)
      .set({
        status: "result_unknown",
        resultAt: input.resultAt,
        lastError: input.message,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(vendingCommands.id, input.command.id),
          inArray(vendingCommands.status, input.eligibleStatuses),
        ),
      )
      .returning({ id: vendingCommands.id });
    if (!updated) return false;

    const [currentOrder] = await tx
      .select({
        status: orders.status,
        paymentState: orders.paymentState,
      })
      .from(orders)
      .where(eq(orders.id, input.command.orderId));
    if (currentOrder && currentOrder.status !== "manual_handling") {
      const projectedStatus = projectOrderStatus({
        paymentState: currentOrder.paymentState,
        fulfillmentState: "manual_handling",
      });
      await tx
        .update(orders)
        .set({
          status: projectedStatus,
          fulfillmentState: "manual_handling",
          updatedAt: new Date(),
        })
        .where(eq(orders.id, input.command.orderId));
      await tx.insert(orderStatusEvents).values({
        orderId: input.command.orderId,
        fromStatus: currentOrder.status,
        toStatus: projectedStatus,
        reason: "dispense_result_unknown",
        metadata: {
          commandNo: input.command.commandNo,
          requiresPhysicalOutcomeConfirmation: true,
          slotSalesState: "frozen",
        },
      });
    }

    await tx
      .update(machineSlots)
      .set({ status: "faulted", updatedAt: new Date() })
      .where(eq(machineSlots.id, input.command.slotId));

    await this.notificationsService.createDispenseFailedNotification(tx, {
      orderId: input.command.orderId,
      commandId: input.command.id,
      message: input.message,
    });
    return true;
  }

  private async handleCommandAck(
    machineCode: string,
    commandNo: string,
    topic: string,
    payloadText: string,
  ): Promise<void> {
    let payload: z.infer<typeof commandAckPayloadSchema>;
    let messageId: string;
    try {
      const verified = await this.mqttSignatureService.verifyFromTopic({
        topicMachineCode: machineCode,
        rawPayload: this.parsePayload(payloadText),
        payloadSchema: commandAckPayloadSchema,
      });
      payload = verified.payload;
      messageId = verified.messageId;
    } catch {
      this.logger.warn(
        `handleCommandAck: invalid signed envelope from ${machineCode}`,
      );
      return;
    }

    const machine = await this.findMachineByCode(machineCode);
    if (!machine) return;

    await this.db.transaction(async (tx) => {
      await lockMachineForVendingMutation(tx, machine.id);
      const [command] = await tx
        .select({ orderId: vendingCommands.orderId })
        .from(vendingCommands)
        .where(
          and(
            eq(vendingCommands.commandNo, commandNo),
            eq(vendingCommands.machineId, machine.id),
          ),
        )
        .limit(1);
      if (command) {
        await lockOrderForVendingMutation(tx, command.orderId);
      }
      const inserted = await tx
        .insert(machineEvents)
        .values({
          machineId: machine.id,
          eventType: "command_ack",
          payloadJson: payload,
          mqttTopic: topic,
          messageId,
        })
        .onConflictDoNothing()
        .returning({ id: machineEvents.id });
      if (inserted.length === 0) {
        return;
      }

      await tx
        .update(vendingCommands)
        .set({
          status: "acknowledged",
          ackAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(vendingCommands.commandNo, commandNo),
            eq(vendingCommands.machineId, machine.id),
            inArray(vendingCommands.status, ["pending", "sent"]),
          ),
        );
    });
  }

  private async handleDispenseResult(
    machineCode: string,
    topic: string,
    payloadText: string,
  ): Promise<void> {
    let payload: z.infer<typeof dispenseResultPayloadSchema>;
    let messageId: string;
    try {
      const verified = await this.mqttSignatureService.verifyFromTopic({
        topicMachineCode: machineCode,
        rawPayload: this.parsePayload(payloadText),
        payloadSchema: dispenseResultPayloadSchema,
      });
      payload = verified.payload;
      messageId = verified.messageId;
    } catch {
      this.logger.warn(
        `handleDispenseResult: invalid signed envelope from ${machineCode}`,
      );
      return;
    }

    const machine = await this.findMachineByCode(machineCode);
    if (!machine) return;

    const resultContext = await this.db.transaction(async (tx) => {
      await lockMachineForVendingMutation(tx, machine.id);
      const [command] = await tx
        .select({
          id: vendingCommands.id,
          commandNo: vendingCommands.commandNo,
          orderId: vendingCommands.orderId,
          machineId: vendingCommands.machineId,
          slotId: vendingCommands.slotId,
          orderItemId: vendingCommands.orderItemId,
          status: vendingCommands.status,
          payloadJson: vendingCommands.payloadJson,
          orderNo: orders.orderNo,
        })
        .from(vendingCommands)
        .innerJoin(orders, eq(orders.id, vendingCommands.orderId))
        .where(
          and(
            eq(vendingCommands.commandNo, payload.commandNo),
            eq(vendingCommands.machineId, machine.id),
          ),
        );
      if (!command) {
        await this.insertDispenseResultInboxEvent(tx, {
          machineId: machine.id,
          payload,
          topic,
          messageId,
        });
        return null;
      }
      if (payload.success) {
        if (command.status === "failed") {
          await this.insertDispenseResultInboxEvent(tx, {
            machineId: machine.id,
            payload,
            topic,
            messageId,
          });
          return null;
        }
        return {
          kind: "success" as const,
          command: {
            ...command,
            machineCode: machine.code,
            payloadJson: command.payloadJson as Record<string, unknown>,
          },
        };
      }

      if (command.status === "succeeded") {
        await this.insertDispenseResultInboxEvent(tx, {
          machineId: machine.id,
          payload,
          topic,
          messageId,
        });
        return null;
      }
      if (command.status === "failed") {
        await this.insertDispenseResultInboxEvent(tx, {
          machineId: machine.id,
          payload,
          topic,
          messageId,
        });
        return { kind: "refund_recovery" as const };
      }

      await this.insertDispenseResultInboxEvent(tx, {
        machineId: machine.id,
        payload,
        topic,
        messageId,
      });

      if (payload.errorCode === "UNKNOWN") {
        const changed = await this.markDispenseResultUnknown(tx, {
          command,
          message: payload.message,
          resultAt: new Date(payload.reportedAt),
          eligibleStatuses: ["pending", "sent", "acknowledged"],
        });
        return changed
          ? {
              kind: "unknown" as const,
            }
          : null;
      }

      await lockOrderForVendingMutation(tx, command.orderId);
      const [updated] = await tx
        .update(vendingCommands)
        .set({
          status: "failed",
          resultAt: new Date(),
          lastError: payload.message,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(vendingCommands.id, command.id),
            inArray(vendingCommands.status, [
              "pending",
              "sent",
              "acknowledged",
              "result_unknown",
              "timeout",
            ]),
          ),
        )
        .returning({ id: vendingCommands.id });
      if (!updated) return null;

      const compensation =
        await this.inventoryService.releaseAffectedReservationForDispenseFailure(
          tx,
          {
            orderId: command.orderId,
            orderItemId: command.orderItemId,
            slotId: command.slotId,
            errorCode: payload.errorCode,
            message: payload.message,
          },
        );

      const refundDecision =
        await this.markOrderLinesFailedAndBuildRefundDecision(tx, {
          orderId: command.orderId,
          orderItemId: command.orderItemId,
          slotId: command.slotId,
          reason: "dispense_failed",
          metadata: {
            commandNo: payload.commandNo,
            errorCode: payload.errorCode,
            releasedQuantity: compensation.releasedQuantity,
            slotFaulted: compensation.slotFaulted,
            slotSalesState: compensation.slotSalesState,
          },
        });
      await this.stageFailedLineRefund(tx, refundDecision);

      await this.notificationsService.createDispenseFailedNotification(tx, {
        orderId: command.orderId,
        commandId: command.id,
        message: payload.message,
      });

      if (compensation.slotFaulted) {
        await this.maintenanceWorkOrdersService.createWorkOrder(tx, {
          machineId: machine.id,
          slotId: command.slotId,
          orderId: command.orderId,
          commandId: command.id,
          title: `出货失败：${payload.errorCode ?? "未知错误"}`,
          description: payload.message,
          priority: "high",
          dedupeKey: `dispense_failed:${command.id}`,
        });
      }

      return {
        kind: "failure" as const,
        orderId: command.orderId,
        commandId: command.id,
        commandNo: payload.commandNo,
        errorCode: payload.errorCode,
        message: payload.message,
        compensation,
        refundDecision,
      };
    });

    if (resultContext?.kind === "success") {
      const successResult = await this.resolveCommandAsDispensed(
        resultContext.command,
        {
          movementId: `mqtt-dispense:${payload.commandNo}`,
          source: "vending_command",
          occurredAt: payload.reportedAt,
        },
      );
      if (!("stockMovementStatus" in successResult)) {
        await this.refundsService.dispatchPendingRefunds();
      }
      // Success projection is itself idempotent (movementId + command CAS).
      // Persist the inbox receipt only after it commits, so a crash or
      // transient failure is resumed by the same messageId instead of being
      // permanently hidden behind the inbox unique key.
      await this.db
        .insert(machineEvents)
        .values({
          machineId: machine.id,
          eventType: "dispense_result",
          payloadJson: payload,
          mqttTopic: topic,
          messageId,
        })
        .onConflictDoNothing();
      return;
    }

    if (
      (resultContext?.kind === "failure" &&
        resultContext.refundDecision.kind !== "none") ||
      resultContext?.kind === "refund_recovery"
    ) {
      await this.refundsService.dispatchPendingRefunds();
    }
  }

  private async insertDispenseResultInboxEvent(
    tx: DrizzleTransaction,
    input: {
      machineId: string;
      payload: z.infer<typeof dispenseResultPayloadSchema>;
      topic: string;
      messageId: string;
    },
  ): Promise<void> {
    await tx
      .insert(machineEvents)
      .values({
        machineId: input.machineId,
        eventType: "dispense_result",
        payloadJson: input.payload,
        mqttTopic: input.topic,
        messageId: input.messageId,
      })
      .onConflictDoNothing();
  }

  private async markOrderLinesFailedAndBuildRefundDecision(
    tx: DrizzleTransaction,
    input: {
      orderId: string;
      orderItemId: string | null;
      slotId: string;
      reason: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<FailedLineRefundDecision> {
    const failedLines = await tx
      .select({ id: orderItems.id })
      .from(orderItems)
      .where(
        and(
          eq(orderItems.orderId, input.orderId),
          input.orderItemId
            ? eq(orderItems.id, input.orderItemId)
            : eq(orderItems.slotId, input.slotId),
        ),
      );
    const failedLineIds = failedLines.map((line) => line.id);
    if (failedLineIds.length === 0) return { kind: "none" };

    await tx
      .update(orderItems)
      .set({
        fulfillmentStatus: "dispense_failed",
        refundStatus: "pending",
        failedAt: new Date(),
        refundUpdatedAt: new Date(),
      })
      .where(inArray(orderItems.id, failedLineIds));

    await this.syncOrderFulfillmentStateFromLines(tx, {
      orderId: input.orderId,
      reason: input.reason,
      metadata: input.metadata,
    });

    const lines = await tx
      .select({
        id: orderItems.id,
        fulfillmentStatus: orderItems.fulfillmentStatus,
        quantity: orderItems.quantity,
        unitPriceCents: orderItems.unitPriceCents,
      })
      .from(orderItems)
      .where(eq(orderItems.orderId, input.orderId));
    const hasOpenLine = lines.some(
      (line) =>
        line.fulfillmentStatus === "pending" ||
        line.fulfillmentStatus === "dispensing",
    );
    if (hasOpenLine) return { kind: "none" };

    const failed = lines.filter(
      (line) => line.fulfillmentStatus === "dispense_failed",
    );
    const dispensed = lines.filter(
      (line) => line.fulfillmentStatus === "dispensed",
    );
    if (failed.length === lines.length) {
      return { kind: "full", orderId: input.orderId, metadata: input.metadata };
    }
    if (failed.length > 0 && dispensed.length > 0) {
      return {
        kind: "partial",
        orderId: input.orderId,
        orderItemIds: failed.map((line) => line.id),
        amountCents: failed.reduce(
          (sum, line) => sum + line.unitPriceCents * line.quantity,
          0,
        ),
        metadata: input.metadata,
      };
    }
    return { kind: "none" };
  }

  private async syncOrderFulfillmentStateFromLines(
    tx: DrizzleTransaction,
    input: {
      orderId: string;
      reason: string;
      metadata: Record<string, unknown>;
    },
  ): Promise<void> {
    const lines = await tx
      .select({ fulfillmentStatus: orderItems.fulfillmentStatus })
      .from(orderItems)
      .where(eq(orderItems.orderId, input.orderId));
    if (lines.length === 0) return;

    const dispensed = lines.filter(
      (line) => line.fulfillmentStatus === "dispensed",
    ).length;
    const failed = lines.filter(
      (line) => line.fulfillmentStatus === "dispense_failed",
    ).length;
    const manual = lines.some(
      (line) => line.fulfillmentStatus === "manual_handling",
    );
    const fulfillmentState = manual
      ? "manual_handling"
      : dispensed === lines.length
        ? "dispensed"
        : failed === lines.length
          ? "dispense_failed"
          : dispensed > 0 && failed > 0
            ? "partial_dispensed"
            : "dispensing";

    const [currentOrder] = await tx
      .select({
        status: orders.status,
        paymentState: orders.paymentState,
        fulfillmentState: orders.fulfillmentState,
      })
      .from(orders)
      .where(eq(orders.id, input.orderId));
    if (!currentOrder || currentOrder.fulfillmentState === fulfillmentState) {
      return;
    }

    const projectedStatus = projectOrderStatus({
      paymentState: currentOrder.paymentState,
      fulfillmentState,
    });
    await tx
      .update(orders)
      .set({
        status: projectedStatus,
        fulfillmentState,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, input.orderId));
    await tx.insert(orderStatusEvents).values({
      orderId: input.orderId,
      fromStatus: currentOrder.status,
      toStatus: projectedStatus,
      reason: input.reason,
      metadata: input.metadata,
    });
  }

  private async stageFailedLineRefund(
    tx: DrizzleTransaction,
    decision: FailedLineRefundDecision,
  ): Promise<void> {
    if (decision.kind === "full") {
      await this.refundsService.stageAutomaticFullRefund(tx, {
        orderId: decision.orderId,
        metadata: decision.metadata,
      });
      return;
    }
    if (decision.kind === "partial") {
      await this.refundsService.stageAutomaticPartialRefund(tx, {
        orderId: decision.orderId,
        orderItemIds: decision.orderItemIds,
        amountCents: decision.amountCents,
        metadata: decision.metadata,
      });
    }
  }

  private async handleHeartbeat(
    machineCode: string,
    topic: string,
    payloadText: string,
  ): Promise<void> {
    let payload: z.infer<typeof heartbeatPayloadSchema>;
    let messageId: string;
    try {
      const verified = await this.mqttSignatureService.verifyFromTopic({
        topicMachineCode: machineCode,
        rawPayload: this.parsePayload(payloadText),
        payloadSchema: heartbeatPayloadSchema,
      });
      payload = verified.payload;
      messageId = verified.messageId;
    } catch {
      this.logger.warn(
        `handleHeartbeat: invalid signed envelope from ${machineCode}`,
      );
      return;
    }

    const machine = await this.findMachineByCode(machineCode);
    if (!machine) return;

    const receivedAt = new Date();
    const reportedAt = new Date(payload.reportedAt);

    await this.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(machineEvents)
        .values({
          machineId: machine.id,
          eventType: "heartbeat",
          payloadJson: payload,
          mqttTopic: topic,
          messageId,
        })
        .onConflictDoNothing()
        .returning({ id: machineEvents.id });
      if (inserted.length === 0) {
        return;
      }

      await tx
        .update(machines)
        .set({
          status: "online",
          lastSeenAt: receivedAt,
          updatedAt: receivedAt,
        })
        .where(eq(machines.id, machine.id));

      await tx.insert(machineHeartbeats).values({
        machineId: machine.id,
        statusPayloadJson: payload.statusPayload,
        reportedAt,
      });

      await this.notificationsService.resolveMachineOfflineNotification(tx, {
        machineId: machine.id,
        machineCode: machine.code,
        recoveredAt: receivedAt,
        lastSeenAt: receivedAt,
      });
    });
  }

  private async findMachineByCode(code: string) {
    const [machine] = await this.db
      .select({ id: machines.id, code: machines.code })
      .from(machines)
      .where(eq(machines.code, code));
    return machine;
  }

  private parsePayload(payloadText: string): unknown {
    try {
      const parsed = JSON.parse(payloadText) as unknown;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }
}
