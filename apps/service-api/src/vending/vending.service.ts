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
import { InventoryService } from "../inventory/inventory.service";
import { MachineStockMovementsService } from "../inventory/machine-stock-movements.service";
import { MaintenanceWorkOrdersService } from "../maintenance-work-orders/maintenance-work-orders.service";
import { MqttSignatureService } from "../mqtt/mqtt-signature.service";
import { MqttService } from "../mqtt/mqtt.service";
import { NotificationsService } from "../notifications/notifications.service";
import { projectOrderStatus } from "../orders/order-state-projection";
import { RefundsService } from "../refunds/refunds.service";

type PageQueryInput = z.infer<typeof pageQuerySchema>;

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    Reflect.get(error, "code") === "23505"
  );
}

@Injectable()
export class VendingService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(VendingService.name);
  private timeoutInterval?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly mqttService: MqttService,
    private readonly mqttSignatureService: MqttSignatureService,
    private readonly notificationsService: NotificationsService,
    private readonly inventoryService: InventoryService,
    private readonly machineStockMovementsService: MachineStockMovementsService,
    private readonly refundsService: RefundsService,
    private readonly maintenanceWorkOrdersService: MaintenanceWorkOrdersService,
  ) {}

  onModuleInit(): void {
    this.mqttService.bindVendingService(this);
    this.timeoutInterval = setInterval(() => {
      void this.markTimedOutCommands().catch((error: unknown) => {
        this.logger.warn(
          `markTimedOutCommands failed: ${error instanceof Error ? error.message : String(error)}`,
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

  async createAndDispatchCommands(orderId: string) {
    const [order] = await this.db
      .select({
        id: orders.id,
        orderNo: orders.orderNo,
        status: orders.status,
        machineId: orders.machineId,
        machineCode: machines.code,
      })
      .from(orders)
      .innerJoin(machines, eq(machines.id, orders.machineId))
      .where(eq(orders.id, orderId));
    if (!order) {
      throw new NotFoundException("Order not found");
    }

    const existingCommands = await this.db
      .select()
      .from(vendingCommands)
      .where(
        and(
          eq(vendingCommands.orderId, orderId),
          eq(vendingCommands.commandKind, "dispatch"),
        ),
      )
      .orderBy(vendingCommands.createdAt);
    if (existingCommands.length > 0) {
      return existingCommands;
    }

    const items = await this.db
      .select({
        orderItemId: orderItems.id,
        slotId: orderItems.slotId,
        quantity: orderItems.quantity,
        layerNo: machineSlots.layerNo,
        cellNo: machineSlots.cellNo,
        slotCode: machineSlots.slotCode,
      })
      .from(orderItems)
      .innerJoin(machineSlots, eq(machineSlots.id, orderItems.slotId))
      .where(eq(orderItems.orderId, orderId));
    if (items.length === 0) {
      return [];
    }

    try {
      const commandResults = await Promise.all(
        items.map(async (item) => {
          const commandNo = createBusinessNo("CMD");
          const payload = dispenseCommandPayloadSchema.parse({
            commandNo,
            orderNo: order.orderNo,
            slot: {
              layerNo: item.layerNo,
              cellNo: item.cellNo,
              slotCode: item.slotCode,
            },
            quantity: item.quantity,
            timeoutSeconds: 120,
          });

          const [created] = await this.db
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
            .returning();

          try {
            const envelope = await this.mqttSignatureService.signForMachine({
              machineCode: order.machineCode,
              payload,
              messageId: `command:${commandNo}`,
            });
            await this.mqttService.publish(
              `vem/machines/${order.machineCode}/commands/dispense`,
              envelope,
            );
            const [sent] = await this.db
              .update(vendingCommands)
              .set({
                status: "sent",
                sentAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(vendingCommands.id, created.id))
              .returning();
            return sent;
          } catch (error) {
            const [failed] = await this.db
              .update(vendingCommands)
              .set({
                status: "failed",
                lastError:
                  error instanceof Error ? error.message : String(error),
                updatedAt: new Date(),
              })
              .where(eq(vendingCommands.id, created.id))
              .returning();
            return failed;
          }
        }),
      );

      const hasFailure = commandResults.some(
        (command) => command?.status === "failed",
      );
      if (hasFailure) {
        const failedCommands = commandResults.filter(
          (command): command is NonNullable<typeof command> =>
            command?.status === "failed",
        );
        const sentLikeCommands = commandResults.filter(
          (command) =>
            command?.status === "sent" ||
            command?.status === "acknowledged" ||
            command?.status === "succeeded",
        );
        const allCommandsFailedBeforeDelivery = sentLikeCommands.length === 0;
        const refundDecision = await this.db.transaction(async (tx) => {
          const sentLineIds = sentLikeCommands
            .map((command) => command?.orderItemId)
            .filter((id): id is string => typeof id === "string");
          if (sentLineIds.length > 0) {
            await tx
              .update(orderItems)
              .set({ fulfillmentStatus: "dispensing" })
              .where(inArray(orderItems.id, sentLineIds));
          }

          let decision:
            | { kind: "none" }
            | {
                kind: "full";
                orderId: string;
                metadata: Record<string, unknown>;
              }
            | {
                kind: "partial";
                orderId: string;
                orderItemIds: string[];
                amountCents: number;
                metadata: Record<string, unknown>;
              } = { kind: "none" };

          // oxlint-disable no-await-in-loop -- each failed line mutates order-line state before the next refund decision is calculated
          for (const failedCommand of failedCommands) {
            await this.inventoryService.releaseAffectedReservationForDispenseFailure(
              tx,
              {
                orderId,
                orderItemId: failedCommand.orderItemId ?? null,
                slotId: failedCommand.slotId,
                errorCode: null,
                message: failedCommand.lastError ?? "MQTT dispatch failed",
              },
            );

            const metadata = {
              allCommandsFailedBeforeDelivery,
              failedCommandId: failedCommand.id,
              failedCommandNo: failedCommand.commandNo,
              releaseReason: "mqtt_dispatch_failed",
            };
            decision = await this.markOrderLinesFailedAndBuildRefundDecision(
              tx,
              {
                orderId,
                orderItemId: failedCommand.orderItemId ?? null,
                slotId: failedCommand.slotId,
                reason: "mqtt_dispatch_failed",
                metadata,
              },
            );

            await this.notificationsService.createDispenseFailedNotification(
              tx,
              {
                orderId,
                commandId: failedCommand.id,
                message: failedCommand.lastError ?? "MQTT dispatch failed",
              },
            );
          }
          // oxlint-enable no-await-in-loop

          return decision;
        });

        await this.requestRefundForFailedLines(refundDecision);
        return commandResults;
      }

      await this.db.transaction(async (tx) => {
        const commandLineIds = commandResults
          .map((command) => command?.orderItemId)
          .filter((id): id is string => typeof id === "string");
        if (commandLineIds.length > 0) {
          await tx
            .update(orderItems)
            .set({ fulfillmentStatus: "dispensing" })
            .where(inArray(orderItems.id, commandLineIds));
        }

        const [currentOrder] = await tx
          .select({ status: orders.status, paymentState: orders.paymentState })
          .from(orders)
          .where(eq(orders.id, orderId));
        if (!currentOrder || currentOrder.status === "dispensing") {
          return;
        }
        const projectedStatus = projectOrderStatus({
          paymentState: currentOrder.paymentState,
          fulfillmentState: "dispensing",
        });
        await tx
          .update(orders)
          .set({
            status: projectedStatus,
            fulfillmentState: "dispensing",
            updatedAt: new Date(),
          })
          .where(eq(orders.id, orderId));
        await tx.insert(orderStatusEvents).values({
          orderId,
          fromStatus: currentOrder.status,
          toStatus: projectedStatus,
          reason: "vending_command_sent",
        });
      });

      return commandResults;
    } catch (error) {
      if (isUniqueViolation(error)) {
        return await this.db
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
      throw error;
    }
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

  async retryCommand(id: string) {
    const [command] = await this.db
      .select({
        id: vendingCommands.id,
        commandNo: vendingCommands.commandNo,
        orderId: vendingCommands.orderId,
        machineId: vendingCommands.machineId,
        status: vendingCommands.status,
        retryCount: vendingCommands.retryCount,
        payloadJson: vendingCommands.payloadJson,
        machineCode: machines.code,
      })
      .from(vendingCommands)
      .innerJoin(machines, eq(machines.id, vendingCommands.machineId))
      .where(eq(vendingCommands.id, id));
    if (!command) {
      throw new NotFoundException("Vending command not found");
    }
    if (command.status !== "failed" && command.status !== "timeout") {
      throw new ConflictException(
        "Only failed or timeout command can be retried",
      );
    }
    if (command.retryCount >= 3) {
      throw new ConflictException("Retry limit reached");
    }

    const payload = dispenseCommandPayloadSchema.parse(command.payloadJson);
    const envelope = await this.mqttSignatureService.signForMachine({
      machineCode: command.machineCode,
      payload,
      messageId: `command:${command.commandNo}:retry:${command.retryCount + 1}`,
    });
    await this.mqttService.publish(
      `vem/machines/${command.machineCode}/commands/dispense`,
      envelope,
    );

    const [updated] = await this.db
      .update(vendingCommands)
      .set({
        status: "sent",
        sentAt: new Date(),
        retryCount: command.retryCount + 1,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(vendingCommands.id, command.id))
      .returning();

    await this.db.transaction(async (tx) => {
      const [currentOrder] = await tx
        .select({ status: orders.status, paymentState: orders.paymentState })
        .from(orders)
        .where(eq(orders.id, command.orderId));
      if (!currentOrder) {
        return;
      }
      if (currentOrder.status !== "dispensing") {
        const projectedStatus = projectOrderStatus({
          paymentState: currentOrder.paymentState,
          fulfillmentState: "dispensing",
        });
        await tx
          .update(orders)
          .set({
            status: projectedStatus,
            fulfillmentState: "dispensing",
            updatedAt: new Date(),
          })
          .where(eq(orders.id, command.orderId));
        await tx.insert(orderStatusEvents).values({
          orderId: command.orderId,
          fromStatus: currentOrder.status,
          toStatus: projectedStatus,
          reason: "vending_retry",
          metadata: { commandId: command.id },
        });
      }
    });

    return updated;
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
      return await this.resolveCommandAsDispensed(command, input.note);
    }

    const failureContext = await this.db.transaction(async (tx) => {
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
      await this.requestRefundForFailedLines(failureContext.refundDecision);
    }

    return { commandId: command.id, status: "failed" as const };
  }

  async createCompensationDispenseCommand(input: {
    orderId: string;
    recoveryActionId: string;
    originalCommandNo: string;
    note: string;
  }) {
    const [row] = await this.db
      .select({
        orderId: orders.id,
        orderNo: orders.orderNo,
        machineId: orders.machineId,
        machineCode: machines.code,
        orderStatus: orders.status,
        orderItemId: orderItems.id,
        slotId: orderItems.slotId,
        inventoryId: orderItems.inventoryId,
        quantity: orderItems.quantity,
        layerNo: machineSlots.layerNo,
        cellNo: machineSlots.cellNo,
        slotCode: machineSlots.slotCode,
      })
      .from(orders)
      .innerJoin(machines, eq(machines.id, orders.machineId))
      .innerJoin(orderItems, eq(orderItems.orderId, orders.id))
      .innerJoin(machineSlots, eq(machineSlots.id, orderItems.slotId))
      .where(eq(orders.id, input.orderId))
      .limit(1);
    if (!row) {
      throw new NotFoundException("Order item not found for compensation");
    }

    const commandNo = createBusinessNo("CMD");
    const basePayload = dispenseCommandPayloadSchema.parse({
      commandNo,
      orderNo: row.orderNo,
      slot: {
        layerNo: row.layerNo,
        cellNo: row.cellNo,
        slotCode: row.slotCode,
      },
      quantity: row.quantity,
      timeoutSeconds: 120,
    });
    const payload = {
      ...basePayload,
      recovery: {
        action: "compensation_dispense",
        originalCommandNo: input.originalCommandNo,
        note: input.note,
      },
    };

    const created = await this.db.transaction(async (tx) => {
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

      await tx
        .update(orders)
        .set({
          status: "dispensing",
          fulfillmentState: "dispensing",
          updatedAt: new Date(),
        })
        .where(eq(orders.id, row.orderId));

      await tx.insert(orderStatusEvents).values({
        orderId: row.orderId,
        fromStatus: row.orderStatus,
        toStatus: "dispensing",
        reason: "compensation_dispense_requested",
        metadata: {
          commandNo,
          originalCommandNo: input.originalCommandNo,
        },
      });

      return command;
    });

    try {
      const envelope = await this.mqttSignatureService.signForMachine({
        machineCode: row.machineCode,
        payload,
        messageId: `command:${commandNo}`,
      });
      await this.mqttService.publish(
        `vem/machines/${row.machineCode}/commands/dispense`,
        envelope,
      );
      const [sent] = await this.db
        .update(vendingCommands)
        .set({
          status: "sent",
          sentAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(vendingCommands.id, created.id))
        .returning();
      return sent;
    } catch (error) {
      const [failed] = await this.db
        .update(vendingCommands)
        .set({
          status: "failed",
          lastError: error instanceof Error ? error.message : String(error),
          updatedAt: new Date(),
        })
        .where(eq(vendingCommands.id, created.id))
        .returning();
      return failed;
    }
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
    note?: string,
    options: {
      movementId?: string;
      source?: string;
      occurredAt?: string;
    } = {},
  ) {
    if (command.status === "succeeded") {
      return { commandId: command.id, status: "succeeded" as const };
    }
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

    await this.db
      .update(vendingCommands)
      .set({
        status: "succeeded",
        resultAt: new Date(),
        lastError: note ?? null,
        updatedAt: new Date(),
      })
      .where(eq(vendingCommands.id, command.id));

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
      const inserted = await tx
        .insert(machineEvents)
        .values({
          machineId: machine.id,
          eventType: "dispense_result",
          payloadJson: payload,
          mqttTopic: topic,
          messageId,
        })
        .onConflictDoNothing()
        .returning({ id: machineEvents.id });
      if (inserted.length === 0) {
        return null;
      }

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
        return null;
      }

      if (payload.success) {
        if (command.status === "succeeded" || command.status === "failed") {
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

      if (command.status === "succeeded" || command.status === "failed") {
        return null;
      }

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

      await tx
        .update(vendingCommands)
        .set({
          status: "failed",
          resultAt: new Date(),
          lastError: payload.message,
          updatedAt: new Date(),
        })
        .where(eq(vendingCommands.id, command.id));

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
      await this.resolveCommandAsDispensed(
        resultContext.command,
        payload.message,
        {
          movementId: `mqtt-dispense:${payload.commandNo}`,
          source: "vending_command",
          occurredAt: payload.reportedAt,
        },
      );
      return;
    }

    if (resultContext?.kind === "failure") {
      await this.requestRefundForFailedLines(resultContext.refundDecision);
    }
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
  ): Promise<
    | { kind: "none" }
    | { kind: "full"; orderId: string; metadata: Record<string, unknown> }
    | {
        kind: "partial";
        orderId: string;
        orderItemIds: string[];
        amountCents: number;
        metadata: Record<string, unknown>;
      }
  > {
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

  private async requestRefundForFailedLines(
    decision:
      | { kind: "none" }
      | { kind: "full"; orderId: string; metadata: Record<string, unknown> }
      | {
          kind: "partial";
          orderId: string;
          orderItemIds: string[];
          amountCents: number;
          metadata: Record<string, unknown>;
        },
  ): Promise<void> {
    if (decision.kind === "full") {
      await this.refundsService.requestFullRefund({
        orderId: decision.orderId,
        reason: "auto_dispense_failed",
        metadata: decision.metadata,
      });
      return;
    }
    if (decision.kind === "partial") {
      await this.refundsService.requestPartialRefund({
        orderId: decision.orderId,
        orderItemIds: decision.orderItemIds,
        amountCents: decision.amountCents,
        reason: "auto_partial_dispense_failed",
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
