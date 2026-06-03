import {
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
  isNull,
  machineSlots,
  machineCommands,
  machineEvents,
  machineHeartbeats,
  machines,
  productCategories,
  productVariants,
  products,
  sql,
  type DrizzleClient,
} from "@vem/db";
import {
  commandAckPayloadSchema,
  environmentControlResultPayloadSchema,
  createMachineSchema,
  createMachineSlotSchema,
  pageQuerySchema,
  machineEnvironmentControlRequestSchema,
  updateMachineSchema,
  type CommandAckPayload,
  type EnvironmentControlResultPayload,
  type MachineEnvironmentControlRequest,
} from "@vem/shared";
import { z } from "zod";

import { AuditService } from "../audit/audit.service";
import { createBusinessNo } from "../common/business-no.util";
import { getOffset, toPageResult } from "../common/pagination.util";
import { AppConfigService } from "../config/app-config.service";
import { DRIZZLE_CLIENT } from "../database/database.constants";
import { MachineCredentialService } from "../machine-auth/machine-credential.service";
import { MqttSignatureService } from "../mqtt/mqtt-signature.service";
import { MqttService } from "../mqtt/mqtt.service";

type PageQueryInput = z.infer<typeof pageQuerySchema>;
type CreateMachineInput = z.infer<typeof createMachineSchema>;
type UpdateMachineInput = z.infer<typeof updateMachineSchema>;
type CreateMachineSlotInput = z.infer<typeof createMachineSlotSchema>;

function parseLatestEnvironment(statusPayload: unknown) {
  if (
    typeof statusPayload !== "object" ||
    statusPayload === null ||
    !("environment" in statusPayload)
  ) {
    return null;
  }

  const environment = Reflect.get(statusPayload, "environment");
  if (typeof environment !== "object" || environment === null) {
    return null;
  }

  const sensorStatus = Reflect.get(environment, "sensorStatus");
  return sensorStatus === "ok" ||
    sensorStatus === "faulted" ||
    sensorStatus === "unknown"
    ? environment
    : null;
}

@Injectable()
export class MachinesService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MachinesService.name);
  private timeoutInterval?: NodeJS.Timeout;

  constructor(
    @Inject(DRIZZLE_CLIENT) private readonly db: DrizzleClient,
    private readonly machineCredentialService: MachineCredentialService,
    private readonly auditService: AuditService,
    private readonly mqttService: MqttService,
    private readonly mqttSignatureService: MqttSignatureService,
    private readonly config: AppConfigService,
  ) {}

  onModuleInit(): void {
    this.mqttService.registerMachineMessageHandler(async (topic, payload) => {
      await this.handleMachineMessage(topic, payload);
    });
    this.timeoutInterval = setInterval(() => {
      void this.markTimedOutMachineCommands().catch((error: unknown) => {
        this.logger.warn(
          `markTimedOutMachineCommands failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
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

  async listMachines(query: PageQueryInput) {
    const items = await this.db
      .select()
      .from(machines)
      .where(isNull(machines.deletedAt))
      .orderBy(desc(machines.createdAt))
      .limit(query.pageSize)
      .offset(getOffset(query));
    const [totalRow] = await this.db
      .select({ total: count() })
      .from(machines)
      .where(isNull(machines.deletedAt));

    const enrichedItems = await Promise.all(
      items.map(async (machine) => ({
        ...machine,
        latestEnvironment: await this.getLatestEnvironment(machine.id),
        latestEnvironmentCommand: await this.getLatestEnvironmentCommand(
          machine.id,
        ),
      })),
    );

    return toPageResult(enrichedItems, query, Number(totalRow.total));
  }

  async createMachine(input: CreateMachineInput) {
    const [created] = await this.db
      .insert(machines)
      .values({
        code: input.code,
        name: input.name,
        locationText: input.locationText ?? null,
        status: input.status,
        mqttClientId: input.mqttClientId ?? null,
      })
      .returning();
    return created;
  }

  async updateMachine(id: string, input: UpdateMachineInput) {
    const [updated] = await this.db
      .update(machines)
      .set({
        code: input.code,
        name: input.name,
        locationText: input.locationText,
        status: input.status,
        mqttClientId: input.mqttClientId,
        updatedAt: new Date(),
      })
      .where(and(eq(machines.id, id), isNull(machines.deletedAt)))
      .returning();

    if (!updated) {
      throw new NotFoundException("Machine not found");
    }
    return updated;
  }

  async getMachine(id: string) {
    const [machine] = await this.db
      .select()
      .from(machines)
      .where(and(eq(machines.id, id), isNull(machines.deletedAt)))
      .limit(1);

    if (!machine) {
      throw new NotFoundException("Machine not found");
    }

    return {
      ...machine,
      latestEnvironment: await this.getLatestEnvironment(id),
      latestEnvironmentCommand: await this.getLatestEnvironmentCommand(id),
    };
  }

  private async getLatestEnvironment(machineId: string) {
    const [latestHeartbeat] = await this.db
      .select({ statusPayloadJson: machineHeartbeats.statusPayloadJson })
      .from(machineHeartbeats)
      .where(eq(machineHeartbeats.machineId, machineId))
      .orderBy(desc(machineHeartbeats.reportedAt))
      .limit(1);

    return parseLatestEnvironment(latestHeartbeat?.statusPayloadJson);
  }

  private async getLatestEnvironmentCommand(machineId: string) {
    const [latestCommand] = await this.db
      .select()
      .from(machineCommands)
      .where(
        and(
          eq(machineCommands.machineId, machineId),
          eq(machineCommands.type, "environment-control"),
        ),
      )
      .orderBy(desc(machineCommands.createdAt))
      .limit(1);

    return latestCommand ?? null;
  }

  async commandEnvironment(
    machineId: string,
    input: MachineEnvironmentControlRequest,
    adminUserId: string,
  ) {
    const commandInput = machineEnvironmentControlRequestSchema.parse(input);
    const [machine] = await this.db
      .select({ id: machines.id, code: machines.code })
      .from(machines)
      .where(and(eq(machines.id, machineId), isNull(machines.deletedAt)))
      .limit(1);

    if (!machine) {
      throw new NotFoundException("Machine not found");
    }

    const commandNo = createBusinessNo("MCMD");
    const timeoutSeconds = this.config.machineCommandTimeoutSeconds;
    const payload = {
      commandNo,
      ...(commandInput.airConditionerOn === undefined
        ? {}
        : { airConditionerOn: commandInput.airConditionerOn }),
      ...(commandInput.targetTemperatureCelsius === undefined
        ? {}
        : {
            targetTemperatureCelsius: commandInput.targetTemperatureCelsius,
          }),
      timeoutSeconds,
    };
    const now = new Date();
    const timeoutAt = new Date(now.getTime() + timeoutSeconds * 1_000);

    const [created] = await this.db
      .insert(machineCommands)
      .values({
        commandNo,
        machineId: machine.id,
        type: "environment-control",
        status: "pending",
        payloadJson: payload,
        timeoutAt,
        requestedByAdminUserId: adminUserId,
      })
      .returning();

    try {
      const envelope = await this.mqttSignatureService.signForMachine({
        machineCode: machine.code,
        payload: created.payloadJson,
        messageId: `command:${created.commandNo}`,
      });
      await this.mqttService.publish(
        `vem/machines/${machine.code}/commands/environment-control`,
        envelope,
      );
      const [sent] = await this.db
        .update(machineCommands)
        .set({
          status: "sent",
          sentAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(machineCommands.id, created.id))
        .returning();

      await this.auditService.record({
        adminUserId,
        action: "machines.environmentControl.command",
        resourceType: "machine",
        resourceId: machine.id,
        afterJson: {
          commandId: created.id,
          commandNo: created.commandNo,
          payload: created.payloadJson,
        },
      });
      return sent;
    } catch (error) {
      const [failed] = await this.db
        .update(machineCommands)
        .set({
          status: "failed",
          lastError: error instanceof Error ? error.message : String(error),
          updatedAt: new Date(),
        })
        .where(eq(machineCommands.id, created.id))
        .returning();
      return failed;
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
      /^vem\/machines\/([^/]+)\/events\/environment-control-result$/.exec(
        topic,
      );
    if (resultMatch) {
      await this.handleEnvironmentControlResult(resultMatch[1], topic, payload);
      return;
    }
  }

  async markTimedOutMachineCommands(
    now = new Date(),
  ): Promise<{ processed: number }> {
    const candidates = await this.db
      .select({
        id: machineCommands.id,
        commandNo: machineCommands.commandNo,
        timeoutAt: machineCommands.timeoutAt,
      })
      .from(machineCommands)
      .where(
        and(
          eq(machineCommands.type, "environment-control"),
          inArray(machineCommands.status, ["sent", "acknowledged"]),
        ),
      );

    const overdue = candidates.filter(
      (command) =>
        command.timeoutAt && command.timeoutAt.getTime() <= now.getTime(),
    );

    const results = await Promise.all(
      overdue.map(async (command) => {
        const [updated] = await this.db
          .update(machineCommands)
          .set({
            status: "timeout",
            resultAt: now,
            lastError: "machine command timeout",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(machineCommands.id, command.id),
              inArray(machineCommands.status, ["sent", "acknowledged"]),
            ),
          )
          .returning({ id: machineCommands.id });
        return Boolean(updated);
      }),
    );

    return { processed: results.filter(Boolean).length };
  }

  async listSlots(machineId: string) {
    return await this.db
      .select()
      .from(machineSlots)
      .where(
        and(
          eq(machineSlots.machineId, machineId),
          isNull(machineSlots.deletedAt),
        ),
      )
      .orderBy(machineSlots.layerNo, machineSlots.cellNo);
  }

  async createSlot(machineId: string, input: CreateMachineSlotInput) {
    const [created] = await this.db
      .insert(machineSlots)
      .values({
        machineId,
        layerNo: input.layerNo,
        cellNo: input.cellNo,
        slotCode: input.slotCode,
        capacity: input.capacity,
        status: input.status,
      })
      .returning();
    return created;
  }

  async getCatalogByMachineCode(code: string) {
    return await this.db
      .select({
        machineCode: machines.code,
        slotId: machineSlots.id,
        slotCode: machineSlots.slotCode,
        layerNo: machineSlots.layerNo,
        cellNo: machineSlots.cellNo,
        inventoryId: inventories.id,
        variantId: productVariants.id,
        productId: products.id,
        productName: products.name,
        productDescription: products.description,
        coverImageUrl: products.coverImageUrl,
        categoryId: products.categoryId,
        categoryName: productCategories.name,
        sku: productVariants.sku,
        size: productVariants.size,
        color: productVariants.color,
        priceCents: productVariants.priceCents,
        availableQty: sql<number>`${inventories.onHandQty} - ${inventories.reservedQty}`,
        productSortOrder: products.sortOrder,
        targetGender: productVariants.targetGender,
      })
      .from(machines)
      .innerJoin(
        machineSlots,
        and(
          eq(machineSlots.machineId, machines.id),
          isNull(machineSlots.deletedAt),
          eq(machineSlots.status, "enabled"),
        ),
      )
      .innerJoin(inventories, eq(inventories.slotId, machineSlots.id))
      .innerJoin(
        productVariants,
        and(
          eq(productVariants.id, inventories.variantId),
          isNull(productVariants.deletedAt),
          eq(productVariants.status, "active"),
        ),
      )
      .innerJoin(
        products,
        and(
          eq(products.id, productVariants.productId),
          isNull(products.deletedAt),
          eq(products.status, "active"),
        ),
      )
      .leftJoin(
        productCategories,
        eq(productCategories.id, products.categoryId),
      )
      .where(
        and(
          eq(machines.code, code),
          isNull(machines.deletedAt),
          inArray(machines.status, ["online", "maintenance"]),
          sql`${inventories.onHandQty} - ${inventories.reservedQty} > 0`,
        ),
      )
      .orderBy(products.sortOrder, machineSlots.layerNo, machineSlots.cellNo);
  }

  private async handleEnvironmentControlResult(
    machineCode: string,
    topic: string,
    payloadText: string,
  ): Promise<void> {
    let verified: {
      machineId: string;
      machineCode: string;
      messageId: string;
      payload: EnvironmentControlResultPayload;
    };
    try {
      verified = await this.mqttSignatureService.verifyFromTopic({
        topicMachineCode: machineCode,
        rawPayload: this.parsePayload(payloadText),
        payloadSchema: environmentControlResultPayloadSchema,
      });
    } catch {
      this.logger.warn(
        `handleEnvironmentControlResult: invalid signed envelope from ${machineCode}`,
      );
      return;
    }

    await this.db.transaction(async (tx) => {
      await tx
        .insert(machineEvents)
        .values({
          machineId: verified.machineId,
          eventType: "environment_control_result",
          payloadJson: { ...verified.payload },
          mqttTopic: topic,
          messageId: verified.messageId,
        })
        .onConflictDoNothing()
        .returning({ id: machineEvents.id });

      await tx
        .update(machineCommands)
        .set({
          status: verified.payload.success ? "succeeded" : "failed",
          resultJson: { ...verified.payload },
          resultAt: new Date(verified.payload.reportedAt),
          lastError: verified.payload.success
            ? null
            : (verified.payload.message ??
              verified.payload.errorCode ??
              "environment control failed"),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(machineCommands.commandNo, verified.payload.commandNo),
            eq(machineCommands.machineId, verified.machineId),
            eq(machineCommands.type, "environment-control"),
            inArray(machineCommands.status, [
              "pending",
              "sent",
              "acknowledged",
            ]),
          ),
        );
    });
  }

  private async handleCommandAck(
    machineCode: string,
    commandNo: string,
    topic: string,
    payloadText: string,
  ): Promise<void> {
    let verified: {
      machineId: string;
      machineCode: string;
      messageId: string;
      payload: CommandAckPayload;
    };
    try {
      verified = await this.mqttSignatureService.verifyFromTopic({
        topicMachineCode: machineCode,
        rawPayload: this.parsePayload(payloadText),
        payloadSchema: commandAckPayloadSchema,
      });
    } catch {
      this.logger.warn(
        `handleMachineCommandAck: invalid signed envelope from ${machineCode}`,
      );
      return;
    }

    await this.db.transaction(async (tx) => {
      await tx
        .insert(machineEvents)
        .values({
          machineId: verified.machineId,
          eventType: "command_ack",
          payloadJson: { ...verified.payload },
          mqttTopic: topic,
          messageId: verified.messageId,
        })
        .onConflictDoNothing()
        .returning({ id: machineEvents.id });

      await tx
        .update(machineCommands)
        .set({
          status: "acknowledged",
          ackAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(machineCommands.commandNo, commandNo),
            eq(machineCommands.machineId, verified.machineId),
            eq(machineCommands.type, "environment-control"),
            inArray(machineCommands.status, ["pending", "sent"]),
          ),
        );
    });
  }

  private parsePayload(payloadText: string): unknown {
    try {
      const parsed = JSON.parse(payloadText) as unknown;
      return typeof parsed === "object" && parsed !== null ? parsed : {};
    } catch {
      return {};
    }
  }

  async rotateMachineCredentials(id: string, adminUserId: string) {
    const [current] = await this.db
      .select({
        id: machines.id,
        code: machines.code,
        secretVersion: machines.secretVersion,
      })
      .from(machines)
      .where(and(eq(machines.id, id), isNull(machines.deletedAt)));
    if (!current) {
      throw new NotFoundException("Machine not found");
    }

    const bundle = this.machineCredentialService.createBundle();
    const nextVersion = current.secretVersion + 1;
    const [updated] = await this.db
      .update(machines)
      .set({
        secretHash: bundle.secretHash,
        secretVersion: nextVersion,
        secretRotatedAt: new Date(),
        credentialRevokedAt: null,
        mqttSigningSecretEncryptedJson:
          bundle.mqttSigningSecretEncryptedJson as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(machines.id, current.id))
      .returning({ id: machines.id, code: machines.code });

    await this.auditService.record({
      adminUserId,
      action: "machines.credentials.rotate",
      resourceType: "machine",
      resourceId: current.id,
      afterJson: { machineCode: current.code, secretVersion: nextVersion },
    });

    return {
      machineId: updated.id,
      machineCode: updated.code,
      secretVersion: nextVersion,
      machineSecret: bundle.machineSecret,
      mqttSigningSecret: bundle.mqttSigningSecret,
    };
  }
}
