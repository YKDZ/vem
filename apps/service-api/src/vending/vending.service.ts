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
} from "@vem/db";
import {
  commandAckPayloadSchema,
  dispenseCommandPayloadSchema,
  dispenseResultPayloadSchema,
  heartbeatPayloadSchema,
  pageQuerySchema,
} from "@vem/shared";
import { z } from "zod";

import { createBusinessNo } from "../common/business-no.util";
import { getOffset, toPageResult } from "../common/pagination.util";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { InventoryService } from "../inventory/inventory.service";
import { MqttService } from "../mqtt/mqtt.service";
import { NotificationsService } from "../notifications/notifications.service";
import { RefundsService } from "../refunds/refunds.service";

type PageQueryInput = z.infer<typeof pageQuerySchema>;

@Injectable()
export class VendingService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(VendingService.name);
  private timeoutInterval?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly mqttService: MqttService,
    private readonly notificationsService: NotificationsService,
    private readonly inventoryService: InventoryService,
    private readonly refundsService: RefundsService,
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
            payloadJson: payload,
            status: "pending",
          })
          .returning();

        try {
          await this.mqttService.publish(
            `vem/machines/${order.machineCode}/commands/dispense`,
            payload,
          );
          const [sent] = await this.db
            .update(vendingCommands)
            .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
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
      }),
    );

    const hasFailure = commandResults.some(
      (command) => command?.status === "failed",
    );
    if (hasFailure) {
      await this.db.transaction(async (tx) => {
        const [currentOrder] = await tx
          .select({ status: orders.status })
          .from(orders)
          .where(eq(orders.id, orderId));
        if (!currentOrder) {
          return;
        }

        const failedCommand = commandResults.find(
          (command) => command?.status === "failed",
        );

        await tx.insert(orderStatusEvents).values({
          orderId,
          fromStatus: currentOrder.status,
          toStatus: currentOrder.status,
          reason: "mqtt_dispatch_failed",
          metadata: failedCommand
            ? {
                commandId: failedCommand.id,
                commandNo: failedCommand.commandNo,
              }
            : null,
        });

        if (failedCommand) {
          await this.notificationsService.createDispenseFailedNotification(tx, {
            orderId,
            commandId: failedCommand.id,
            message: failedCommand.lastError ?? "MQTT dispatch failed",
          });
        }
      });
      return commandResults;
    }

    await this.db.transaction(async (tx) => {
      const [currentOrder] = await tx
        .select({ status: orders.status })
        .from(orders)
        .where(eq(orders.id, orderId));
      if (!currentOrder || currentOrder.status === "dispensing") {
        return;
      }
      await tx
        .update(orders)
        .set({ status: "dispensing", updatedAt: new Date() })
        .where(eq(orders.id, orderId));
      await tx.insert(orderStatusEvents).values({
        orderId,
        fromStatus: currentOrder.status,
        toStatus: "dispensing",
        reason: "vending_command_sent",
      });
    });

    return commandResults;
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
    await this.mqttService.publish(
      `vem/machines/${command.machineCode}/commands/dispense`,
      payload,
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
        .select({ status: orders.status })
        .from(orders)
        .where(eq(orders.id, command.orderId));
      if (!currentOrder) {
        return;
      }
      if (currentOrder.status !== "dispensing") {
        await tx
          .update(orders)
          .set({ status: "dispensing", updatedAt: new Date() })
          .where(eq(orders.id, command.orderId));
        await tx.insert(orderStatusEvents).values({
          orderId: command.orderId,
          fromStatus: currentOrder.status,
          toStatus: "dispensing",
          reason: "vending_retry",
          metadata: { commandId: command.id },
        });
      }
    });

    return updated;
  }

  async markTimedOutCommands(now = new Date()): Promise<{ processed: number }> {
    const candidates = await this.db
      .select({
        id: vendingCommands.id,
        commandNo: vendingCommands.commandNo,
        orderId: vendingCommands.orderId,
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
          const [updated] = await tx
            .update(vendingCommands)
            .set({
              status: "timeout",
              resultAt: now,
              lastError: "vending command timeout",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(vendingCommands.id, command.id),
                inArray(vendingCommands.status, ["sent", "acknowledged"]),
              ),
            )
            .returning({ id: vendingCommands.id });
          if (!updated) return false;

          const [currentOrder] = await tx
            .select({ status: orders.status })
            .from(orders)
            .where(eq(orders.id, command.orderId));
          if (currentOrder && currentOrder.status !== "manual_handling") {
            await tx
              .update(orders)
              .set({ status: "manual_handling", updatedAt: new Date() })
              .where(eq(orders.id, command.orderId));
            await tx.insert(orderStatusEvents).values({
              orderId: command.orderId,
              fromStatus: currentOrder.status,
              toStatus: "manual_handling",
              reason: "vending_command_timeout",
              metadata: { commandNo: command.commandNo },
            });
          }

          await this.notificationsService.createDispenseFailedNotification(tx, {
            orderId: command.orderId,
            commandId: command.id,
            message: "vending command timeout",
          });
          return true;
        });
        return changed;
      }),
    );

    const processed = results.filter(Boolean).length;
    return { processed };
  }

  private async handleCommandAck(
    machineCode: string,
    commandNo: string,
    topic: string,
    payloadText: string,
  ): Promise<void> {
    const machine = await this.findMachineByCode(machineCode);
    if (!machine) {
      return;
    }

    const payload = commandAckPayloadSchema.parse(
      this.parsePayload(payloadText),
    );
    const messageId = payload.messageId ?? `ack:${commandNo}`;

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
    const machine = await this.findMachineByCode(machineCode);
    if (!machine) {
      return;
    }

    const payload = dispenseResultPayloadSchema.parse(
      this.parsePayload(payloadText),
    );
    const messageId = `result:${payload.commandNo}:${payload.reportedAt}`;

    const failureContext = await this.db.transaction(async (tx) => {
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
          orderId: vendingCommands.orderId,
          slotId: vendingCommands.slotId,
          status: vendingCommands.status,
        })
        .from(vendingCommands)
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
        if (
          command.status === "succeeded" ||
          command.status === "failed" ||
          command.status === "timeout"
        ) {
          return null;
        }
        await tx
          .update(vendingCommands)
          .set({
            status: "succeeded",
            resultAt: new Date(),
            lastError: null,
            updatedAt: new Date(),
          })
          .where(eq(vendingCommands.id, command.id));

        const [remainingRow] = await tx
          .select({ total: count() })
          .from(vendingCommands)
          .where(
            and(
              eq(vendingCommands.orderId, command.orderId),
              sql`${vendingCommands.status} <> 'succeeded'`,
            ),
          );
        if (Number(remainingRow.total) === 0) {
          const [currentOrder] = await tx
            .select({ status: orders.status })
            .from(orders)
            .where(eq(orders.id, command.orderId));
          if (currentOrder) {
            await tx
              .update(orders)
              .set({
                status: "fulfilled",
                dispensedAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(orders.id, command.orderId));
            await tx.insert(orderStatusEvents).values({
              orderId: command.orderId,
              fromStatus: currentOrder.status,
              toStatus: "fulfilled",
              reason: "dispense_succeeded",
            });
          }
        }
        return null;
      }

      if (
        command.status === "succeeded" ||
        command.status === "failed" ||
        command.status === "timeout"
      ) {
        return null;
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
        await this.inventoryService.compensateDispenseFailure(tx, {
          orderId: command.orderId,
          slotId: command.slotId,
          errorCode: payload.errorCode,
          message: payload.message,
        });

      const [currentOrder] = await tx
        .select({ status: orders.status })
        .from(orders)
        .where(eq(orders.id, command.orderId));
      if (currentOrder) {
        await tx
          .update(orders)
          .set({ status: "dispense_failed", updatedAt: new Date() })
          .where(eq(orders.id, command.orderId));
        await tx.insert(orderStatusEvents).values({
          orderId: command.orderId,
          fromStatus: currentOrder.status,
          toStatus: "dispense_failed",
          reason: "dispense_failed",
          metadata: {
            commandNo: payload.commandNo,
            errorCode: payload.errorCode,
            restoredQuantity: compensation.restoredQuantity,
            slotFaulted: compensation.slotFaulted,
          },
        });
      }

      await this.notificationsService.createDispenseFailedNotification(tx, {
        orderId: command.orderId,
        commandId: command.id,
        message: payload.message,
      });

      return {
        orderId: command.orderId,
        commandId: command.id,
        commandNo: payload.commandNo,
        errorCode: payload.errorCode,
        message: payload.message,
        compensation,
      };
    });

    if (failureContext) {
      await this.refundsService.requestFullRefund({
        orderId: failureContext.orderId,
        reason: "auto_dispense_failed",
        metadata: failureContext,
      });
    }
  }

  private async handleHeartbeat(
    machineCode: string,
    topic: string,
    payloadText: string,
  ): Promise<void> {
    const machine = await this.findMachineByCode(machineCode);
    if (!machine) {
      return;
    }

    const payload = heartbeatPayloadSchema.parse(
      this.parsePayload(payloadText),
    );
    const messageId = `heartbeat:${payload.reportedAt}`;
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
          lastSeenAt: reportedAt,
          updatedAt: new Date(),
        })
        .where(eq(machines.id, machine.id));

      await tx.insert(machineHeartbeats).values({
        machineId: machine.id,
        statusPayloadJson: payload.statusPayload,
        reportedAt,
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
