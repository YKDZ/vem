import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationShutdown,
  OnModuleInit,
  UnauthorizedException,
} from "@nestjs/common";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  inventories,
  isNull,
  machineClaimCodes,
  machinePlanogramSlots,
  machinePlanogramVersions,
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
  publishMachinePlanogramVersionSchema,
  updateMachineSchema,
  type CommandAckPayload,
  type EnvironmentControlResultPayload,
  type MachineEnvironmentControlRequest,
  type MachineClaimRequest,
  type GenerateMachineClaimCodeRequest,
  type MachinePaymentOption,
  type MachineProvisioningProfile,
  type MachinePlanogramSlot,
  type GenerateMachineClaimCodeResponse,
  type PublishMachinePlanogramVersion,
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
import { PaymentProviderConfigService } from "../payments/payment-provider-config.service";
import {
  digestMachineClaimCodeLookup,
  generateHumanMachineClaimCode,
  hashMachineClaimCodeVerifier,
  verifyMachineClaimCode,
} from "./machine-claim-code.util";

type PageQueryInput = z.infer<typeof pageQuerySchema>;
type CreateMachineInput = z.infer<typeof createMachineSchema>;
type UpdateMachineInput = z.infer<typeof updateMachineSchema>;
type CreateMachineSlotInput = z.infer<typeof createMachineSlotSchema>;

type PlanogramVersionRecord = typeof machinePlanogramVersions.$inferSelect;

type MachineIdentity = {
  id: string;
  code: string;
};

type MachineClaimCodeRecord = typeof machineClaimCodes.$inferSelect;
type MachineClaimCandidate = {
  id: string;
  machineId: string;
  verifierHash: string;
  purpose: MachineClaimCodeRecord["purpose"];
  state: MachineClaimCodeRecord["state"];
  failedAttemptCount: number;
  maxFailedAttempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  lockedAt: Date | null;
  machineCode: string;
  machineName: string;
  machineLocationText: string | null;
  machineStatus: MachineProvisioningProfile["machine"]["status"];
  machineMqttClientId: string | null;
  machineSecretVersion: number;
};
type ProductionPaymentOption = MachinePaymentOption & {
  providerCode: "wechat_pay" | "alipay";
  method: "qr_code" | "payment_code";
};

const MACHINE_CLAIM_CODE_MAX_FAILED_ATTEMPTS = 5;
const MACHINE_CLAIM_CODES_MACHINE_OPEN_UNIQUE =
  "machine_claim_codes_machine_open_unique";

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function resolveMachineClaimCodeState(
  claimCode: MachineClaimCodeRecord,
  now: Date,
): GenerateMachineClaimCodeResponse["state"] {
  if (
    claimCode.state === "pending" &&
    claimCode.expiresAt.getTime() <= now.getTime()
  ) {
    return "expired";
  }
  return claimCode.state;
}

function machineClaimCodeSnapshot(
  machine: MachineIdentity,
  claimCode: MachineClaimCodeRecord,
  now: Date,
) {
  return {
    id: claimCode.id,
    machineId: machine.id,
    machineCode: machine.code,
    purpose: claimCode.purpose,
    state: resolveMachineClaimCodeState(claimCode, now),
    expiresAt: toIso(claimCode.expiresAt),
    failedAttemptCount: claimCode.failedAttemptCount,
    maxFailedAttempts: claimCode.maxFailedAttempts,
    createdAt: toIso(claimCode.createdAt),
    consumedAt: claimCode.consumedAt ? toIso(claimCode.consumedAt) : null,
    revokedAt: claimCode.revokedAt ? toIso(claimCode.revokedAt) : null,
    lockedAt: claimCode.lockedAt ? toIso(claimCode.lockedAt) : null,
  };
}

function isMachineClaimCodeOpenUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const maybeError = error as { code?: unknown; constraint?: unknown };
  return (
    maybeError.code === "23505" &&
    maybeError.constraint === MACHINE_CLAIM_CODES_MACHINE_OPEN_UNIQUE
  );
}

function isProductionPaymentOption(
  option: MachinePaymentOption,
): option is ProductionPaymentOption {
  return option.providerCode !== "mock" && option.method !== "mock";
}

function planogramSlotValues(
  machinePlanogramVersionId: string,
  slot: MachinePlanogramSlot,
) {
  return {
    machinePlanogramVersionId,
    slotId: slot.slotId,
    slotCode: slot.slotCode,
    layerNo: slot.layerNo,
    cellNo: slot.cellNo,
    capacity: slot.capacity,
    parLevel: slot.parLevel,
    inventoryId: slot.inventoryId,
    variantId: slot.variantId,
    productId: slot.productId,
    productName: slot.productName,
    productDescription: slot.productDescription,
    coverImageUrl: slot.coverImageUrl,
    categoryId: slot.categoryId,
    categoryName: slot.categoryName,
    sku: slot.sku,
    size: slot.size,
    color: slot.color,
    priceCents: slot.priceCents,
    productSortOrder: slot.productSortOrder,
    targetGender: slot.targetGender ?? null,
  };
}

function planogramSlotSnapshot(
  row: typeof machinePlanogramSlots.$inferSelect,
): MachinePlanogramSlot {
  return {
    slotId: row.slotId,
    slotCode: row.slotCode,
    layerNo: row.layerNo,
    cellNo: row.cellNo,
    capacity: row.capacity,
    parLevel: row.parLevel,
    inventoryId: row.inventoryId,
    variantId: row.variantId,
    productId: row.productId,
    productName: row.productName,
    productDescription: row.productDescription,
    coverImageUrl: row.coverImageUrl,
    categoryId: row.categoryId,
    categoryName: row.categoryName,
    sku: row.sku,
    size: row.size,
    color: row.color,
    priceCents: row.priceCents,
    productSortOrder: row.productSortOrder,
    targetGender:
      row.targetGender === "male" || row.targetGender === "female"
        ? row.targetGender
        : null,
  };
}

function planogramVersionSnapshot(
  machine: MachineIdentity,
  version: PlanogramVersionRecord,
  slots: MachinePlanogramSlot[],
) {
  return {
    machineId: machine.id,
    machineCode: machine.code,
    planogramVersion: version.planogramVersion,
    status: version.status,
    publishedAt: toIso(version.publishedAt),
    acknowledgedAt: version.acknowledgedAt
      ? toIso(version.acknowledgedAt)
      : null,
    activeAt: version.activeAt ? toIso(version.activeAt) : null,
    slots,
  };
}

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
    private readonly paymentProviderConfigService: PaymentProviderConfigService,
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

  async publishMachinePlanogramVersion(
    machineId: string,
    input: PublishMachinePlanogramVersion,
    adminUserId: string,
  ) {
    const planogram = publishMachinePlanogramVersionSchema.parse(input);
    const [machine] = await this.db
      .select({ id: machines.id, code: machines.code })
      .from(machines)
      .where(and(eq(machines.id, machineId), isNull(machines.deletedAt)))
      .limit(1);

    if (!machine) {
      throw new NotFoundException("Machine not found");
    }

    const slotIds = [...new Set(planogram.slots.map((slot) => slot.slotId))];
    const ownedSlots = await this.db
      .select({ id: machineSlots.id })
      .from(machineSlots)
      .where(
        and(
          eq(machineSlots.machineId, machine.id),
          inArray(machineSlots.id, slotIds),
          isNull(machineSlots.deletedAt),
        ),
      );
    if (ownedSlots.length !== slotIds.length) {
      throw new BadRequestException(
        "Planogram slots must belong to the target machine",
      );
    }

    const created = await this.db.transaction(async (tx) => {
      const [version] = await tx
        .insert(machinePlanogramVersions)
        .values({
          machineId: machine.id,
          planogramVersion: planogram.planogramVersion,
          status: "published",
        })
        .returning();

      await tx
        .insert(machinePlanogramSlots)
        .values(
          planogram.slots.map((slot) => planogramSlotValues(version.id, slot)),
        )
        .returning({ id: machinePlanogramSlots.id });

      return version;
    });

    await this.auditService.record({
      adminUserId,
      action: "machines.planogram.publish",
      resourceType: "machine",
      resourceId: machine.id,
      afterJson: {
        planogramVersion: created.planogramVersion,
        slotCount: planogram.slots.length,
      },
    });

    return planogramVersionSnapshot(machine, created, planogram.slots);
  }

  async getMachinePlanogramVersions(machineId: string) {
    const [machine] = await this.db
      .select({ id: machines.id, code: machines.code })
      .from(machines)
      .where(and(eq(machines.id, machineId), isNull(machines.deletedAt)))
      .limit(1);

    if (!machine) {
      throw new NotFoundException("Machine not found");
    }

    const versions = await this.db
      .select()
      .from(machinePlanogramVersions)
      .where(eq(machinePlanogramVersions.machineId, machine.id))
      .orderBy(desc(machinePlanogramVersions.publishedAt));

    return {
      activePlanogramVersion:
        versions.find((version) => version.status === "active")
          ?.planogramVersion ?? null,
      items: versions.map((version) =>
        planogramVersionSnapshot(machine, version, []),
      ),
    };
  }

  async getPublishedPlanogramByMachineCode(code: string) {
    const [machine] = await this.db
      .select({ id: machines.id, code: machines.code })
      .from(machines)
      .where(and(eq(machines.code, code), isNull(machines.deletedAt)))
      .limit(1);

    if (!machine) {
      throw new NotFoundException("Machine not found");
    }

    const [version] = await this.db
      .select()
      .from(machinePlanogramVersions)
      .where(
        and(
          eq(machinePlanogramVersions.machineId, machine.id),
          eq(machinePlanogramVersions.status, "published"),
        ),
      )
      .orderBy(desc(machinePlanogramVersions.publishedAt))
      .limit(1);

    if (!version) {
      return null;
    }

    const slots = await this.db
      .select()
      .from(machinePlanogramSlots)
      .where(eq(machinePlanogramSlots.machinePlanogramVersionId, version.id))
      .orderBy(
        machinePlanogramSlots.productSortOrder,
        machinePlanogramSlots.layerNo,
        machinePlanogramSlots.cellNo,
      );

    return planogramVersionSnapshot(
      machine,
      version,
      slots.map(planogramSlotSnapshot),
    );
  }

  async acknowledgeMachinePlanogramVersion(
    machineCode: string,
    planogramVersion: string,
  ) {
    const [machine] = await this.db
      .select({ id: machines.id, code: machines.code })
      .from(machines)
      .where(and(eq(machines.code, machineCode), isNull(machines.deletedAt)))
      .limit(1);

    if (!machine) {
      throw new NotFoundException("Machine not found");
    }

    const now = new Date();
    const activated = await this.db.transaction(async (tx) => {
      const findTargetVersion = async () => {
        const [version] = await tx
          .select()
          .from(machinePlanogramVersions)
          .where(
            and(
              eq(machinePlanogramVersions.machineId, machine.id),
              eq(machinePlanogramVersions.planogramVersion, planogramVersion),
            ),
          )
          .limit(1);
        return version;
      };

      const targetVersion = await findTargetVersion();
      if (!targetVersion) {
        throw new NotFoundException("Machine planogram version not found");
      }
      if (targetVersion.status === "active") {
        return targetVersion;
      }
      if (targetVersion.status !== "published") {
        throw new NotFoundException("Machine planogram version not found");
      }

      await tx
        .update(machinePlanogramVersions)
        .set({ status: "retired", updatedAt: now })
        .where(
          and(
            eq(machinePlanogramVersions.machineId, machine.id),
            eq(machinePlanogramVersions.status, "active"),
          ),
        );

      const [version] = await tx
        .update(machinePlanogramVersions)
        .set({
          status: "active",
          acknowledgedAt: now,
          activeAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(machinePlanogramVersions.machineId, machine.id),
            eq(machinePlanogramVersions.id, targetVersion.id),
            eq(machinePlanogramVersions.status, "published"),
          ),
        )
        .returning();

      if (version) {
        return version;
      }

      const repeatedAck = await findTargetVersion();
      if (repeatedAck?.status === "active") {
        return repeatedAck;
      }

      throw new NotFoundException("Machine planogram version not found");
    });

    return planogramVersionSnapshot(machine, activated, []);
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

  async generateMachineClaimCode(
    machineId: string,
    adminUserId: string,
    input: GenerateMachineClaimCodeRequest = { purpose: "first_claim" },
  ): Promise<GenerateMachineClaimCodeResponse> {
    const [machine] = await this.db
      .select({
        id: machines.id,
        code: machines.code,
        secretHash: machines.secretHash,
        secretVersion: machines.secretVersion,
      })
      .from(machines)
      .where(and(eq(machines.id, machineId), isNull(machines.deletedAt)))
      .limit(1);

    if (!machine) {
      throw new NotFoundException("Machine not found");
    }
    if (
      input.purpose === "first_claim" &&
      (machine.secretHash || machine.secretVersion > 1)
    ) {
      throw new ConflictException(
        "Machine is already claimed; generate a reclaim code explicitly",
      );
    }

    const now = new Date();
    const openClaimCodes = await this.db
      .select({
        id: machineClaimCodes.id,
        state: machineClaimCodes.state,
        expiresAt: machineClaimCodes.expiresAt,
      })
      .from(machineClaimCodes)
      .where(
        and(
          eq(machineClaimCodes.machineId, machine.id),
          inArray(machineClaimCodes.state, ["pending", "locked"]),
        ),
      );
    const activeClaimCode = openClaimCodes.find(
      (claimCode) =>
        claimCode.state === "locked" ||
        claimCode.expiresAt.getTime() > now.getTime(),
    );
    if (activeClaimCode) {
      throw new ConflictException("Machine already has an active claim code");
    }
    const expiredPendingClaimCodeIds = openClaimCodes
      .filter(
        (claimCode) =>
          claimCode.state === "pending" &&
          claimCode.expiresAt.getTime() <= now.getTime(),
      )
      .map((claimCode) => claimCode.id);
    if (expiredPendingClaimCodeIds.length > 0) {
      await this.db
        .update(machineClaimCodes)
        .set({ state: "expired", updatedAt: now })
        .where(inArray(machineClaimCodes.id, expiredPendingClaimCodeIds));
    }

    const claimCode = generateHumanMachineClaimCode();
    const expiresAt = new Date(
      now.getTime() + this.config.machineClaimCodeTtlSeconds * 1_000,
    );
    let created: MachineClaimCodeRecord;
    try {
      [created] = await this.db
        .insert(machineClaimCodes)
        .values({
          machineId: machine.id,
          lookupDigest: digestMachineClaimCodeLookup(
            claimCode,
            this.config.machineClaimLookupHmacKey,
          ),
          verifierHash: hashMachineClaimCodeVerifier(claimCode),
          purpose: input.purpose,
          state: "pending",
          failedAttemptCount: 0,
          maxFailedAttempts: MACHINE_CLAIM_CODE_MAX_FAILED_ATTEMPTS,
          expiresAt,
          createdByAdminUserId: adminUserId,
        })
        .returning();
    } catch (error) {
      if (isMachineClaimCodeOpenUniqueViolation(error)) {
        throw new ConflictException("Machine already has an active claim code");
      }
      throw error;
    }

    const snapshot = machineClaimCodeSnapshot(machine, created, now);
    await this.auditService.record({
      adminUserId,
      action:
        input.purpose === "reclaim"
          ? "machines.claimCode.reclaim.generate"
          : "machines.claimCode.generate",
      resourceType: "machine",
      resourceId: machine.id,
      afterJson: {
        claimCodeId: created.id,
        machineCode: machine.code,
        purpose: snapshot.purpose,
        state: snapshot.state,
        expiresAt: snapshot.expiresAt,
      },
    });

    return {
      ...snapshot,
      claimCode,
    };
  }

  async claimMachine(
    input: MachineClaimRequest,
    now = new Date(),
  ): Promise<MachineProvisioningProfile> {
    const lookupDigest = digestMachineClaimCodeLookup(
      input.claimCode,
      this.config.machineClaimLookupHmacKey,
    );
    const [claimCode] = await this.db
      .select({
        id: machineClaimCodes.id,
        machineId: machineClaimCodes.machineId,
        verifierHash: machineClaimCodes.verifierHash,
        purpose: machineClaimCodes.purpose,
        state: machineClaimCodes.state,
        failedAttemptCount: machineClaimCodes.failedAttemptCount,
        maxFailedAttempts: machineClaimCodes.maxFailedAttempts,
        expiresAt: machineClaimCodes.expiresAt,
        consumedAt: machineClaimCodes.consumedAt,
        revokedAt: machineClaimCodes.revokedAt,
        lockedAt: machineClaimCodes.lockedAt,
        machineCode: machines.code,
        machineName: machines.name,
        machineLocationText: machines.locationText,
        machineStatus: machines.status,
        machineMqttClientId: machines.mqttClientId,
        machineSecretVersion: machines.secretVersion,
      })
      .from(machineClaimCodes)
      .innerJoin(machines, eq(machines.id, machineClaimCodes.machineId))
      .where(
        and(
          eq(machineClaimCodes.lookupDigest, lookupDigest),
          isNull(machines.deletedAt),
        ),
      )
      .limit(1);

    if (!claimCode) {
      // Truly unmatched guesses have no claim-code row to update. Return the
      // same public error without leaking whether any claim exists.
      throw this.invalidMachineClaimCode();
    }
    if (!verifyMachineClaimCode(input.claimCode, claimCode.verifierHash)) {
      await this.recordFailedMachineClaim(claimCode, now);
      throw this.invalidMachineClaimCode();
    }
    if (
      claimCode.state !== "pending" ||
      claimCode.expiresAt.getTime() <= now.getTime()
    ) {
      await this.recordFailedMachineClaim(claimCode, now);
      throw this.invalidMachineClaimCode();
    }

    const paymentCapability =
      await this.buildMachineProvisioningPaymentCapability(claimCode.machineId);
    const bundle = this.machineCredentialService.createBundle();
    const mqttClientId =
      claimCode.machineMqttClientId ?? `vem-machine-${claimCode.machineCode}`;

    const { consumed, rotated } = await this.db.transaction(async (tx) => {
      const [consumedClaimCode] = await tx
        .update(machineClaimCodes)
        .set({
          state: "consumed",
          consumedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(machineClaimCodes.id, claimCode.id),
            eq(machineClaimCodes.state, "pending"),
            gt(machineClaimCodes.expiresAt, now),
          ),
        )
        .returning({ id: machineClaimCodes.id });
      if (!consumedClaimCode) {
        throw this.invalidMachineClaimCode();
      }

      const [rotatedMachine] = await tx
        .update(machines)
        .set({
          secretHash: bundle.secretHash,
          secretVersion: sql`${machines.secretVersion} + 1`,
          secretRotatedAt: now,
          credentialRevokedAt: null,
          mqttClientId,
          mqttSigningSecretEncryptedJson:
            bundle.mqttSigningSecretEncryptedJson as Record<string, unknown>,
          updatedAt: now,
        })
        .where(
          and(eq(machines.id, claimCode.machineId), isNull(machines.deletedAt)),
        )
        .returning({
          id: machines.id,
          secretVersion: machines.secretVersion,
        });
      if (!rotatedMachine) {
        throw this.invalidMachineClaimCode();
      }
      return { consumed: consumedClaimCode, rotated: rotatedMachine };
    });

    await this.auditService.record({
      adminUserId: null,
      action:
        claimCode.purpose === "reclaim"
          ? "machines.claimCode.reclaim.consume"
          : "machines.claimCode.consume",
      resourceType: "machine",
      resourceId: claimCode.machineId,
      afterJson: {
        claimCodeId: consumed.id,
        machineCode: claimCode.machineCode,
        ...(claimCode.purpose === "reclaim"
          ? { purpose: claimCode.purpose }
          : {}),
        state: "consumed",
        secretVersion: rotated.secretVersion,
        claimedAt: toIso(now),
      },
    });

    return {
      machine: {
        id: claimCode.machineId,
        code: claimCode.machineCode,
        name: claimCode.machineName,
        status: claimCode.machineStatus,
        locationText: claimCode.machineLocationText,
      },
      credentials: {
        machineSecret: bundle.machineSecret,
        machineSecretVersion: rotated.secretVersion,
        mqttSigningSecret: bundle.mqttSigningSecret,
        mqttConnection: {
          url: this.config.mqttUrl,
          clientId: mqttClientId,
          ...(this.config.mqttUsername
            ? { username: this.config.mqttUsername }
            : {}),
          ...(this.config.mqttPassword
            ? { password: this.config.mqttPassword }
            : {}),
        },
      },
      runtimeEndpoints: {
        apiBasePath: "/api",
        machineAuthTokenPath: "/api/machine-auth/token",
        machineApiBasePath: `/api/machines/${claimCode.machineCode}`,
        mqttTopicPrefix: `vem/machines/${claimCode.machineCode}`,
      },
      hardwareProfile: {
        profile: "production",
        controller: {
          required: true,
          protocol: "vem-vending-controller",
        },
        paymentScanner: {
          required: true,
          supportsPaymentCode: true,
        },
        vision: {
          required: false,
          supportsRecommendations: true,
        },
      },
      paymentCapability: {
        profile: "production",
        options: paymentCapability.options,
        defaultOptionKey: paymentCapability.defaultOptionKey,
        defaultProviderCode: paymentCapability.defaultProviderCode,
        serverTime: paymentCapability.serverTime,
      },
      metadata: {
        profileVersion: 1,
        claimCodeId: consumed.id,
        claimedAt: toIso(now),
        serverTime: toIso(now),
      },
    };
  }

  private async buildMachineProvisioningPaymentCapability(machineId: string) {
    const paymentOptions =
      await this.paymentProviderConfigService.listMachinePaymentOptionsForMachine(
        machineId,
      );
    const productionPaymentOptions = paymentOptions.options.filter(
      isProductionPaymentOption,
    );
    const defaultProductionPaymentOption =
      productionPaymentOptions.find(
        (option) => option.optionKey === paymentOptions.defaultOptionKey,
      ) ?? productionPaymentOptions[0];
    return {
      options: productionPaymentOptions,
      defaultOptionKey: defaultProductionPaymentOption?.optionKey ?? null,
      defaultProviderCode: defaultProductionPaymentOption?.providerCode ?? null,
      serverTime: paymentOptions.serverTime,
    };
  }

  private async recordFailedMachineClaim(
    claimCode: MachineClaimCandidate,
    now: Date,
  ): Promise<void> {
    const expired = claimCode.expiresAt.getTime() <= now.getTime();
    const state =
      expired && claimCode.state === "pending"
        ? "expired"
        : claimCode.state === "pending"
          ? sql`case when ${machineClaimCodes.failedAttemptCount} + 1 >= ${machineClaimCodes.maxFailedAttempts} then 'locked'::machine_claim_code_state else ${machineClaimCodes.state} end`
          : claimCode.state;
    const lockedAt =
      claimCode.state === "pending" && !expired
        ? sql`case when ${machineClaimCodes.failedAttemptCount} + 1 >= ${machineClaimCodes.maxFailedAttempts} and ${machineClaimCodes.lockedAt} is null then ${now} else ${machineClaimCodes.lockedAt} end`
        : claimCode.lockedAt;

    await this.db
      .update(machineClaimCodes)
      .set({
        failedAttemptCount: sql`${machineClaimCodes.failedAttemptCount} + 1`,
        state,
        lockedAt,
        updatedAt: now,
      })
      .where(eq(machineClaimCodes.id, claimCode.id));
  }

  private invalidMachineClaimCode(): UnauthorizedException {
    return new UnauthorizedException("Invalid or expired machine claim code");
  }

  async listMachineClaimCodes(machineId: string, now = new Date()) {
    const [machine] = await this.db
      .select({ id: machines.id, code: machines.code })
      .from(machines)
      .where(and(eq(machines.id, machineId), isNull(machines.deletedAt)))
      .limit(1);

    if (!machine) {
      throw new NotFoundException("Machine not found");
    }

    const claimCodes = await this.db
      .select()
      .from(machineClaimCodes)
      .where(eq(machineClaimCodes.machineId, machine.id))
      .orderBy(desc(machineClaimCodes.createdAt));

    return {
      items: claimCodes.map((claimCode) =>
        machineClaimCodeSnapshot(machine, claimCode, now),
      ),
    };
  }

  async getMachineClaimCode(
    machineId: string,
    claimCodeId: string,
    now = new Date(),
  ) {
    const [machine] = await this.db
      .select({ id: machines.id, code: machines.code })
      .from(machines)
      .where(and(eq(machines.id, machineId), isNull(machines.deletedAt)))
      .limit(1);

    if (!machine) {
      throw new NotFoundException("Machine not found");
    }

    const [claimCode] = await this.db
      .select()
      .from(machineClaimCodes)
      .where(
        and(
          eq(machineClaimCodes.id, claimCodeId),
          eq(machineClaimCodes.machineId, machine.id),
        ),
      )
      .limit(1);

    if (!claimCode) {
      throw new NotFoundException("Machine claim code not found");
    }

    return machineClaimCodeSnapshot(machine, claimCode, now);
  }

  async revokeMachineClaimCode(
    machineId: string,
    claimCodeId: string,
    adminUserId: string,
    now = new Date(),
  ) {
    const [machine] = await this.db
      .select({ id: machines.id, code: machines.code })
      .from(machines)
      .where(and(eq(machines.id, machineId), isNull(machines.deletedAt)))
      .limit(1);

    if (!machine) {
      throw new NotFoundException("Machine not found");
    }

    const [current] = await this.db
      .select()
      .from(machineClaimCodes)
      .where(
        and(
          eq(machineClaimCodes.id, claimCodeId),
          eq(machineClaimCodes.machineId, machine.id),
        ),
      )
      .limit(1);

    if (!current) {
      throw new NotFoundException("Machine claim code not found");
    }
    if (
      current.state !== "pending" ||
      current.expiresAt.getTime() <= now.getTime()
    ) {
      throw new ConflictException("Only pending claim codes can be revoked");
    }

    const [revoked] = await this.db
      .update(machineClaimCodes)
      .set({
        state: "revoked",
        revokedAt: now,
        revokedByAdminUserId: adminUserId,
        updatedAt: now,
      })
      .where(
        and(
          eq(machineClaimCodes.id, current.id),
          eq(machineClaimCodes.state, "pending"),
        ),
      )
      .returning();

    if (!revoked) {
      throw new ConflictException("Only pending claim codes can be revoked");
    }

    const snapshot = machineClaimCodeSnapshot(machine, revoked, now);
    await this.auditService.record({
      adminUserId,
      action:
        current.purpose === "reclaim"
          ? "machines.claimCode.reclaim.revoke"
          : "machines.claimCode.revoke",
      resourceType: "machine",
      resourceId: machine.id,
      beforeJson: {
        claimCodeId: current.id,
        machineCode: machine.code,
        ...(current.purpose === "reclaim" ? { purpose: current.purpose } : {}),
        state: machineClaimCodeSnapshot(machine, current, now).state,
      },
      afterJson: {
        claimCodeId: revoked.id,
        machineCode: machine.code,
        ...(revoked.purpose === "reclaim" ? { purpose: revoked.purpose } : {}),
        state: snapshot.state,
      },
    });

    return snapshot;
  }

  async rotateMachineCredentials(id: string, adminUserId: string) {
    const [current] = await this.db
      .select({
        id: machines.id,
        code: machines.code,
      })
      .from(machines)
      .where(and(eq(machines.id, id), isNull(machines.deletedAt)));
    if (!current) {
      throw new NotFoundException("Machine not found");
    }

    const bundle = this.machineCredentialService.createBundle();
    const [updated] = await this.db
      .update(machines)
      .set({
        secretHash: bundle.secretHash,
        secretVersion: sql`${machines.secretVersion} + 1`,
        secretRotatedAt: new Date(),
        credentialRevokedAt: null,
        mqttSigningSecretEncryptedJson:
          bundle.mqttSigningSecretEncryptedJson as Record<string, unknown>,
        updatedAt: new Date(),
      })
      .where(eq(machines.id, current.id))
      .returning({
        id: machines.id,
        code: machines.code,
        secretVersion: machines.secretVersion,
      });

    await this.auditService.record({
      adminUserId,
      action: "machines.credentials.rotate",
      resourceType: "machine",
      resourceId: current.id,
      afterJson: {
        machineCode: current.code,
        secretVersion: updated.secretVersion,
      },
    });

    return {
      machineId: updated.id,
      machineCode: updated.code,
      secretVersion: updated.secretVersion,
      machineSecret: bundle.machineSecret,
      mqttSigningSecret: bundle.mqttSigningSecret,
    };
  }
}
